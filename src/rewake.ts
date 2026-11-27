import type { DatabaseSync } from 'node:sqlite';
import { askTarget } from './context.ts';
import { hydrateRows } from './review-rows.ts';
import { deliverToBot, type DeliverOpts } from './deliver.ts';
import type { BoardBot } from '../ui/src/raisedBy.ts';

// Backstop for answers that get no reply. When Eric answers or notes something on the board (a card, a thread, a
// Reviews-tab draft) and the bot it went to writes nothing on that item for REWAKE_AFTER_MS, the server wakes that
// bot once more through its own webhook with his words, and leaves Eric a one-way notification saying so.
// - One re-wake per answer, ever: the outcome is stored per ask id in ask_rewakes, so restarts never repeat one.
// - A bot write tied to the item after his answer counts as handled: a reply, a review-status or a rewritten draft,
//   a raise, clear, supersede or answer on the card (or a follow-up card in the same group), a notify linking it.
// - Nothing fires on a closed item (card gone, cleared or superseded; draft comment posted, skipped or done).
// - Never fires from Friday 1 PM to Saturday 9 PM ET; a deadline in that window waits until it ends.
// - Only answers given after the backstop first ran count, so turning it on does not wake bots for old answers.

type Json = Record<string, any>;

export const REWAKE_AFTER_MS = 30 * 60_000;
export const REWAKE_TICK_MS = 60_000;
export const MAX_SEND_ATTEMPTS = 3;
const TEXT_CLIP = 600;
const ZONE = 'America/New_York';

export type RewakePayload = {
  event: 'ask.rewake';
  to_bot: BoardBot;
  item_key: string;
  item: string;
  link: string | null;
  asks: { id: string; at: string; text: string }[];
  instruction: string;
  read_more: string;
};

export type RewakeSend = (payload: RewakePayload) => Promise<boolean>;

/** Friday 1 PM ET through Saturday 9 PM ET. */
export function inShabbos(d: Date): boolean {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
  const h = Number(parts.hour);
  return (parts.weekday === 'Fri' && h >= 13) || (parts.weekday === 'Sat' && h < 21);
}

const clip = (s: unknown, n = TEXT_CLIP) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
};

function boardDoc(db: DatabaseSync): Json {
  const row = db.prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string } | undefined;
  try {
    return row ? hydrateRows(JSON.parse(row.json)) : {};
  } catch {
    return {};
  }
}

/** "rows-backend#1994" from an item key, a GitHub PR link or a card's ref. */
function prOf(...xs: unknown[]): string | null {
  for (const x of xs) {
    if (typeof x !== 'string') continue;
    const k = /^(?:pr|mypr):([\w.-]+)\/(\d+)$/.exec(x);
    if (k) return `${k[1]}#${k[2]}`;
    const u = /github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/.exec(x);
    if (u) return `${u[1]}#${u[2]}`;
  }
  return null;
}

type Item = { key: string; card?: Json; pr: string | null };

function itemOf(b: Json, a: Json): Item {
  const key = String(a.item_key);
  const card = key.startsWith('decision:') ? (b.decisions ?? []).find((d: Json) => d?.id === key.slice('decision:'.length)) : undefined;
  return { key, card, pr: prOf(key, a.link, card?.card_ref) };
}

/** Closed: the card is gone, cleared or superseded; a draft comment he answered is posted, skipped or the draft is done. */
function isClosed(db: DatabaseSync, b: Json, a: Json, it: Item): boolean {
  if (it.key.startsWith('decision:')) {
    const id = it.key.slice('decision:'.length);
    if (!it.card || it.card.superseded_by) return true;
    const t = db.prepare('SELECT json FROM ui_tombstones WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(id) as { json: string } | undefined;
    if (t && !JSON.parse(t.json).restored) return true;
    const ref = typeof a.ref === 'string' ? a.ref : '';
    const n = ref.startsWith(`${id}:`) ? ref.slice(id.length + 1) : '';
    if (n && Array.isArray(it.card.post_comments)) {
      const f = it.card.post_comments.find((c: Json, i: number) => String(c?.n ?? i + 1) === n);
      if (f && (f.status === 'posted' || f.status === 'skipped')) return true;
    }
    return false;
  }
  const m = typeof a.ref === 'string' ? /^([\w.-]+)#(\d+):(.+)$/.exec(a.ref) : null;
  if (a.kind === 'review' && m) {
    const d = (b.reviews ?? []).find((r: Json) => r?.repo === m[1] && r?.pr === Number(m[2]));
    if (!d || d.done) return true;
    const c = (d.comments ?? []).find((x: Json) => x?.id === m[3]);
    if (c && (c.status === 'posted' || c.status === 'skipped')) return true;
  }
  return false;
}

/** Any bot write tied to the item after `after` (ISO). */
function handledAfter(db: DatabaseSync, b: Json, a: Json, it: Item, bot: BoardBot, after: string): boolean {
  if ((b.details?.[it.key]?.thread ?? []).some((t: Json) => t?.from === 'bot' && typeof t.at === 'string' && t.at > after)) return true;
  const m = typeof a.ref === 'string' ? /^([\w.-]+)#(\d+):(.+)$/.exec(a.ref) : null;
  if (m) {
    const d = (b.reviews ?? []).find((r: Json) => r?.repo === m[1] && r?.pr === Number(m[2]));
    const c = d?.comments?.find((x: Json) => x?.id === m[3]);
    if (typeof c?.revision_at === 'string' && c.revision_at > after) return true;
  }
  const cardId = it.key.startsWith('decision:') ? it.key.slice('decision:'.length) : null;
  const group = typeof it.card?.group === 'string' && it.card.group.trim() ? it.card.group : null;
  const decisions: Json[] = b.decisions ?? [];
  const sameGroup = (id: unknown) => !!group && decisions.some((d) => d?.id === id && d.group === group);
  const rows = db.prepare("SELECT json FROM ui_log WHERE json_extract(json, '$.at') > ? ORDER BY id").all(after) as { json: string }[];
  for (const r of rows) {
    let e: Json;
    try {
      e = JSON.parse(r.json);
    } catch {
      continue;
    }
    switch (e.op) {
      case 'reply':
      case 'ticket':
      case 'plan':
        if (e.key === it.key) return true;
        break;
      case 'review-status':
        if (it.pr && e.pr === it.pr) return true;
        break;
      case 'reviews':
        if (it.pr && Array.isArray(e.prs) && e.prs.includes(it.pr)) return true;
        break;
      case 'answer':
        if (!e.healed && cardId && e.id === cardId) return true;
        break;
      case 'raise':
      case 'assistant':
      case 'slack-draft':
      case 'clear':
      case 'priority':
      case 'supersede':
        if (cardId && (e.id === cardId || e.by === cardId)) return true;
        if (e.op === 'raise' && e.id !== cardId && sameGroup(e.id)) return true;
        break;
    }
  }
  if (a.link) {
    const n = db.prepare('SELECT 1 FROM ui_notifications WHERE bot = ? AND link = ? AND created_at > ? LIMIT 1').get(bot, a.link, after);
    if (n) return true;
  }
  return false;
}

/** Answers that wait for a bot: everything he sends except "Not relevant anymore", which closes the card. */
const counts = (a: Json) => typeof a?.id === 'string' && typeof a.at === 'string' && typeof a.item_key === 'string' && !a.id.endsWith(':not-relevant') && !a.item_key.startsWith('decision:task:') && !a.id.startsWith('local-');

function since(db: DatabaseSync, now: Date): string {
  const row = db.prepare("SELECT value FROM ask_rewake_meta WHERE key = 'since'").get() as { value: string } | undefined;
  if (row) return row.value;
  const at = now.toISOString();
  db.prepare("INSERT OR IGNORE INTO ask_rewake_meta (key, value) VALUES ('since', ?)").run(at);
  return (db.prepare("SELECT value FROM ask_rewake_meta WHERE key = 'since'").get() as { value: string }).value;
}

const final = (db: DatabaseSync, id: string, bot: string, key: string, state: string, at: string) =>
  db.prepare('INSERT INTO ask_rewakes (ask_id, bot, item_key, state, attempts, updated_at) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT(ask_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at').run(id, bot, key, state, at);

const notify = (db: DatabaseSync, text: string, link: string | null, at: string) =>
  Number(db.prepare('INSERT INTO ui_notifications (bot, text, link, created_at) VALUES (?, ?, ?, ?)').run('Grok Bot', clip(text, 800), link, at).lastInsertRowid);

export function rewakePayload(bot: BoardBot, item: string, key: string, link: string | null, asks: Json[]): RewakePayload {
  return {
    event: 'ask.rewake',
    to_bot: bot,
    item_key: key,
    item,
    link,
    asks: asks.map((a) => ({ id: a.id, at: a.at, text: clip(a.text) })),
    instruction: `Reminder: Eric answered you on the board ${Math.round(REWAKE_AFTER_MS / 60_000)}+ minutes ago and nothing from you is on this item since. Act on his words, then reply on the item (ab reply) or update it. This is the only reminder.`,
    read_more: `ab context --bot ${bot}`,
  };
}

/** One pass. Returns the ask ids re-woken now. Safe to run any number of times and after restarts. */
export async function runRewakes(db: DatabaseSync, now: Date, send: RewakeSend): Promise<string[]> {
  const at = now.toISOString();
  const start = since(db, now);
  const b = boardDoc(db);
  const cards: Json[] = b.decisions ?? [];
  const done = new Map((db.prepare('SELECT ask_id, state, attempts FROM ask_rewakes').all() as Json[]).map((r) => [r.ask_id, r]));

  // A re-woken item: once the bot writes on it, the notification has done its job.
  for (const r of db.prepare("SELECT ask_id, bot, woken_at, notification_id FROM ask_rewakes WHERE state = 'woken'").all() as Json[]) {
    const a = (b.asks ?? []).find((x: Json) => x?.id === r.ask_id);
    if (!a || handledAfter(db, b, a, itemOf(b, a), r.bot, r.woken_at)) {
      if (r.notification_id != null) db.prepare('UPDATE ui_notifications SET cleared_at = ? WHERE id = ? AND cleared_at IS NULL').run(at, r.notification_id);
      db.prepare("UPDATE ask_rewakes SET state = 'woken-answered', updated_at = ? WHERE ask_id = ?").run(at, r.ask_id);
    }
  }

  const due = new Map<string, { bot: BoardBot; it: Item; asks: Json[] }>();
  for (const a of (b.asks ?? []) as Json[]) {
    if (!counts(a) || a.at < start) continue;
    const prev = done.get(a.id);
    if (prev && prev.state !== 'retry') continue;
    if (now.getTime() - Date.parse(a.at) < REWAKE_AFTER_MS) continue;
    const bot: BoardBot = askTarget(a, cards, b.details) ?? 'Grok Bot';
    const it = itemOf(b, a);
    if (handledAfter(db, b, a, it, bot, a.at)) { final(db, a.id, bot, it.key, 'handled', at); continue; }
    if (isClosed(db, b, a, it)) { final(db, a.id, bot, it.key, 'closed', at); continue; }
    if (inShabbos(now)) continue;
    const k = `${bot}\u0000${it.key}`;
    const g = due.get(k) ?? { bot, it, asks: [] };
    g.asks.push(a);
    due.set(k, g);
  }

  const woken: string[] = [];
  for (const { bot, it, asks } of due.values()) {
    const first = asks[0];
    const label = clip(first.label || it.key, 120);
    const link = typeof first.link === 'string' ? first.link : typeof it.card?.card_ref === 'string' ? it.card.card_ref : null;
    let ok = false;
    try {
      ok = await send(rewakePayload(bot, label, it.key, link, asks));
    } catch {
      ok = false;
    }
    if (ok) {
      const words = clip(asks.map((a) => a.text).join(' / '), 200);
      const noteId = notify(db, `Re-woke ${bot} on ${label}: no reply ${Math.round(REWAKE_AFTER_MS / 60_000)} minutes after you said "${words}". Nothing needed from you. (This action was performed via scheduled script, not a bot.)`, link, at);
      for (const a of asks) {
        db.prepare("INSERT INTO ask_rewakes (ask_id, bot, item_key, state, attempts, woken_at, notification_id, updated_at) VALUES (?, ?, ?, 'woken', ?, ?, ?, ?) ON CONFLICT(ask_id) DO UPDATE SET state = 'woken', attempts = excluded.attempts, woken_at = excluded.woken_at, notification_id = excluded.notification_id, updated_at = excluded.updated_at")
          .run(a.id, bot, it.key, (done.get(a.id)?.attempts ?? 0) + 1, at, noteId, at);
        woken.push(a.id);
      }
      continue;
    }
    const attempts = Math.max(...asks.map((a) => done.get(a.id)?.attempts ?? 0)) + 1;
    const state = attempts >= MAX_SEND_ATTEMPTS ? 'failed' : 'retry';
    const noteId = state === 'failed' ? notify(db, `Could not re-wake ${bot} on ${label}: its webhook did not accept the reminder after ${attempts} tries. Nothing needed from you. (This action was performed via scheduled script, not a bot.)`, link, at) : null;
    for (const a of asks) {
      db.prepare('INSERT INTO ask_rewakes (ask_id, bot, item_key, state, attempts, notification_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ask_id) DO UPDATE SET state = excluded.state, attempts = excluded.attempts, notification_id = excluded.notification_id, updated_at = excluded.updated_at')
        .run(a.id, bot, it.key, state, attempts, noteId, at);
    }
  }
  return woken;
}

/** Sends through the bot's own webhook; Grok Bot uses its board webhook. Never logs a URL or secret. */
export function makeRewakeSend(db: DatabaseSync, opts: DeliverOpts = {}): RewakeSend {
  return async (p) => (await deliverToBot(db, p, { ...opts, allowDefaultFor: 'Grok Bot' })) === 'delivered';
}

/** Runs every REWAKE_TICK_MS inside the server; overlapping runs are skipped. Returns a stop function. */
export function startRewakeTimer(db: DatabaseSync, send: RewakeSend, now: () => Date = () => new Date(), everyMs = REWAKE_TICK_MS): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runRewakes(db, now(), send);
    } catch (e) {
      console.error(`rewake pass failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    } finally {
      running = false;
    }
  };
  const t = setInterval(tick, everyMs);
  t.unref?.();
  void tick();
  return () => clearInterval(t);
}
