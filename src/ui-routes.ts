import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { Hono } from 'hono';
import { OWNERS, addNote, getTask, type Clock } from './board.ts';
import type { WebhookConfig } from './config.ts';

// The action board UI's server side, ported from the original local board's dev-server routes (/__ab/*):
// the live board feed, the webhook forwarder, the conversation record, delivery log, priority and "Not relevant".
// The board document is written by bin/ab.mjs into SQLite; tasks waiting on a person and open cards are merged in
// as decision cards, and answers to those go straight back to the task as notes.

type Json = Record<string, any>;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AB_BIN = join(ROOT, 'bin', 'ab.mjs');
const MAX_BODY = 64 * 1024;
const MAX_LOG_BODY = 8 * 1024;
const MAX_AB_BODY = 1024;
export const NOT_RELEVANT_REASON = 'not relevant';
export const WEBHOOK_EVENTS = new Set(['decision.answered', 'item.message', 'decision.clarify', 'decision.not_relevant', 'review.answer']);
const PRIORITY_LEVELS = new Set(['high', 'medium', 'low']);
// ab exit codes: 2 bad input, 4 answered, 5 unknown id. Anything else, or a timeout, is 502.
const AB_EXIT_STATUS: Record<number, number> = { 2: 400, 4: 409, 5: 404 };
const CLEAR_EXIT_STATUS: Record<number, number> = { 2: 400, 5: 404 };

export type UiOptions = {
  dbPath?: string;
  webhook?: WebhookConfig | null;
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
  distDir?: string;
  repliesDir?: string;
  assistantName?: string;
  timeZone?: string;
  /** Override the ab runner (tests). */
  runAb?: (args: string[], stdin?: string) => Promise<{ code: number | null }>;
};

const EMPTY_BOARD = () => ({ updated_at: new Date(0).toISOString(), decisions: [] as Json[], glance: { waiting: [], tickets: [], others: [], mine: [] } });
const EMPTY_PROJECT = () => ({ title: '', updated_at: new Date(0).toISOString(), parent: { id: '', url: '' }, milestones: [] });

function doc(db: DatabaseSync, key: 'board' | 'project'): Json | null {
  const row = db.prepare('SELECT json FROM ui_doc WHERE key = ?').get(key) as { json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.json);
  } catch {
    return null;
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isId = (v: unknown): v is string => isStr(v) && v.length > 0;
const isStrOrList = (v: unknown) => isStr(v) || (Array.isArray(v) && v.every(isStr));

/** Task questions and open cards, as decision cards. Ids: task:<task>:<note>, card:<card>. */
export function derivedDecisions(db: DatabaseSync): Json[] {
  const state = new Map((db.prepare('SELECT decision_id, priority, cleared_at, answered_at FROM ui_derived_state').all() as Json[]).map((r) => [r.decision_id, r]));
  const out: Json[] = [];
  const questions = db.prepare(`SELECT n.*, t.title, t.state, t.ticket, t.pr FROM notes_latest n JOIN tasks t ON t.id = n.task_id
    WHERE n.kind = 'question' AND t.state NOT IN ('merged','done')
      AND NOT EXISTS (SELECT 1 FROM notes a WHERE a.task_id = n.task_id AND a.author = 'human' AND a.id > n.id)
    ORDER BY n.id`).all() as Json[];
  for (const n of questions) {
    const id = `task:${n.task_id}:${n.id}`;
    const s = state.get(id);
    if (s?.cleared_at || s?.answered_at) continue;
    const owner = OWNERS[n.state as keyof typeof OWNERS] ?? n.author;
    out.push({
      id, title: String(n.title).slice(0, 60), card_ref: null,
      context: `${n.author} asked this on task ${n.task_id}${n.ticket ? ` (${n.ticket})` : ''}. The task is in ${n.state}.`,
      question: n.body, what_happens_after: `Your answer is added to task ${n.task_id} as a note and wakes ${owner}.`,
      options: [], tier: 'decision', group: `task:${n.task_id}`,
      priority: s?.priority ?? (n.state === 'waiting_human' ? 'high' : 'medium'),
      created_at: n.created_at, updated_at: n.created_at,
    });
  }
  const cards = db.prepare(`SELECT c.*, t.title, t.state FROM cards c JOIN tasks t ON t.id = c.task_id WHERE c.resolved_at IS NULL ORDER BY c.id`).all() as Json[];
  for (const c of cards) {
    const id = `card:${c.id}`;
    const s = state.get(id);
    if (s?.cleared_at || s?.answered_at) continue;
    let facts: string;
    try {
      facts = Object.entries(JSON.parse(c.body)).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('\n');
    } catch {
      facts = String(c.body);
    }
    out.push({
      id, title: `${String(c.kind).replace(/_/g, ' ')}: ${c.title}`.slice(0, 60), card_ref: null,
      context: `The board raised a ${String(c.kind).replace(/_/g, ' ')} card on task ${c.task_id}, which is in ${c.state}.`,
      question: `What should happen next on task ${c.task_id}?`, details: facts ? facts.split('\n') : undefined,
      what_happens_after: `Your answer is added to task ${c.task_id} as a note and the card is closed.`,
      options: [], tier: 'blocking', group: `task:${c.task_id}`,
      priority: s?.priority ?? 'high', created_at: c.created_at, updated_at: c.created_at,
    });
  }
  return out;
}

/** The id `ab ask` gives the ask a webhook payload becomes (see askOf in bin/ab.mjs); null for events that are not asks. */
export function askIdOf(p: Json): string | null {
  if (p.event === 'item.message') return isId(p.message_id) ? p.message_id : null;
  if (!isId(p.decision_id)) return null;
  if (p.event === 'decision.answered') return `${p.decision_id}:answer`;
  if (p.event === 'decision.clarify') return `${p.decision_id}:clarify:${p.clicked_at}`;
  if (p.event === 'decision.not_relevant') return `${p.decision_id}:not-relevant`;
  return null;
}

/** Each ask with its check state: read (the assistant ran ab answer/reply/read on the item after it), delivered (webhook 2xx), else sent. */
function asksWithStatus(db: DatabaseSync, asks: Json[]): Json[] {
  const delivered = new Set((db.prepare('SELECT ask_id FROM ui_ask_delivered').all() as Json[]).map((r) => r.ask_id));
  const read = new Map((db.prepare('SELECT item_key, read_at FROM ui_item_read').all() as Json[]).map((r) => [r.item_key, r.read_at]));
  return asks.map((a) => ({ ...a, status: (read.get(a.item_key) ?? '') >= a.at ? 'read' : delivered.has(a.id) ? 'delivered' : 'sent' }));
}

/** The board the UI renders: the ab-written document plus derived task decisions and the project tab. */
export function boardFeed(db: DatabaseSync): Json {
  const b: Json = doc(db, 'board') ?? EMPTY_BOARD();
  return { ...b, ...(Array.isArray(b.asks) ? { asks: asksWithStatus(db, b.asks) } : {}), decisions: [...(Array.isArray(b.decisions) ? b.decisions : []), ...derivedDecisions(db)], project: doc(db, 'project') ?? EMPTY_PROJECT() };
}

/** The delivery log line: only known fields in a fixed order, so a URL, auth value or message text is never stored. */
export function deliveryLogEntry(body: unknown): Json | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Json;
  const outcome = (b.http === null || Number.isInteger(b.http)) && (b.via === null || b.via === 'direct' || b.via === 'fallback') &&
    Number.isInteger(b.attempt) && b.attempt >= 0 && ['delivered', 'failed', 'retrying'].includes(b.status) && isStr(b.at);
  if (!outcome) return null;
  const { http, via, attempt, status, at } = b;
  if (b.event === 'item.message') {
    if (!isId(b.message_id) || !isId(b.item_id) || !isId(b.item_section)) return null;
    return { event: 'item.message', message_id: b.message_id, item_id: b.item_id, item_section: b.item_section, http, via, attempt, status, at };
  }
  if (b.event === 'decision.clarify' || b.event === 'decision.not_relevant' || b.event === 'review.answer') {
    if (!isId(b.decision_id)) return null;
    return { event: b.event, decision_id: b.decision_id, http, via, attempt, status, at };
  }
  if (b.event !== undefined && b.event !== 'decision.answered') return null;
  if (!isId(b.decision_id) || !isStrOrList(b.answer) || !isStrOrList(b.answer_label)) return null;
  return { event: 'decision.answered', decision_id: b.decision_id, answer: b.answer, answer_label: b.answer_label, http, via, attempt, status, at };
}

/** The text a person typed or picked, from any board payload. */
export function payloadText(p: Json): string {
  if (p.event === 'decision.answered') return isStr(p.custom_text) ? p.custom_text : Array.isArray(p.answer_label) ? p.answer_label.join(', ') : String(p.answer_label ?? '');
  if (p.event === 'decision.clarify') return 'Please explain this better.';
  if (p.event === 'decision.not_relevant') return 'Not relevant anymore.';
  return String(p.text ?? '');
}

function derivedTarget(db: DatabaseSync, id: unknown): { task: string; card?: number } | null {
  if (!isStr(id)) return null;
  let m = /^task:(.+):(\d+)$/.exec(id);
  if (m && getTask(db, m[1])) return { task: m[1] };
  m = /^card:(\d+)$/.exec(id);
  if (m) {
    const c = db.prepare('SELECT task_id FROM cards WHERE id = ?').get(Number(m[1])) as { task_id: string } | undefined;
    if (c) return { task: c.task_id, card: Number(m[1]) };
  }
  return null;
}

function markDerived(db: DatabaseSync, id: string, col: 'cleared_at' | 'answered_at' | 'priority', value: string) {
  db.prepare(`INSERT INTO ui_derived_state (decision_id, ${col}) VALUES (?, ?) ON CONFLICT(decision_id) DO UPDATE SET ${col} = excluded.${col}`).run(id, value);
}

export function mountUi(app: Hono, db: DatabaseSync, clock: Clock, o: UiOptions = {}) {
  const fetchImpl = o.fetchImpl ?? (fetch as unknown as NonNullable<UiOptions['fetchImpl']>);
  const distDir = o.distDir ?? join(ROOT, 'ui', 'dist');
  const repliesDir = o.repliesDir ?? (o.dbPath ? join(resolve(o.dbPath, '..'), 'replies') : null);
  const runAb = o.runAb ?? ((args: string[], stdin?: string) => new Promise<{ code: number | null }>((done) => {
    if (!o.dbPath) return done({ code: null });
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_BOARD_DB: o.dbPath, AB_NO_SERVER: '1' };
    delete env.AB_FILE;
    delete env.AB_URL;
    const child = execFile(process.execPath, [AB_BIN, ...args], { env, timeout: 15000 }, (err) => {
      if (!err) return done({ code: 0 });
      done({ code: typeof err.code === 'number' && !err.killed ? err.code : null });
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  }));
  const recordAsk = (body: string) => runAb(['ask', '-'], body).then((r) => r.code === 0);

  const jsonOnly = (ct: string | undefined) => String(ct ?? '').startsWith('application/json');
  async function body(req: Request, limit: number): Promise<string | null> {
    const text = await req.text();
    return Buffer.byteLength(text) > limit ? null : text;
  }

  app.get('/__ab/board', (c) => c.json({ ...boardFeed(db), webhook_configured: Boolean(o.webhook) }, 200, { 'Cache-Control': 'no-store' }));

  app.get('/__ab/config', (c) => c.json({ assistantName: o.assistantName ?? 'your assistant', timeZone: o.timeZone ?? 'America/New_York', webhookConfigured: Boolean(o.webhook) }));

  // Forwards a board payload to the wake webhook with the server-side URL and auth. Replies only {status}.
  app.post('/__ab/webhook', async (c) => {
    const reply = (code: number, status: number | null) => c.json({ status }, code as 200);
    if (!jsonOnly(c.req.header('Content-Type'))) return reply(415, null);
    const raw = await body(c.req.raw, MAX_BODY);
    if (raw === null) return reply(400, null);
    let p: Json;
    try {
      p = JSON.parse(raw);
      if (!p || typeof p !== 'object' || !WEBHOOK_EVENTS.has(String(p.event ?? ''))) return reply(400, null);
    } catch {
      return reply(400, null);
    }
    const msgId = p.event === 'item.message' && isId(p.message_id) ? p.message_id : null;
    if (msgId && db.prepare('SELECT 1 FROM ui_delivered WHERE message_id = ?').get(msgId)) return reply(200, 200);

    // Task questions and cards are answered on the board itself: the answer becomes a note that wakes the owner.
    const target = derivedTarget(db, p.decision_id);
    let local = false;
    if (target && (p.event === 'decision.answered' || p.event === 'decision.clarify' || p.event === 'decision.not_relevant')) {
      const text = payloadText(p);
      if (text.trim()) addNote(db, { task: target.task, author: 'human', kind: p.event === 'decision.answered' ? 'answer' : 'info', body: text }, clock);
      if (p.event === 'decision.answered') markDerived(db, p.decision_id, 'answered_at', clock.now().toISOString());
      if (target.card && p.event !== 'decision.clarify') db.prepare('UPDATE cards SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(clock.now().toISOString(), target.card);
      local = true;
    }

    if (!o.webhook) {
      if (local) {
        void recordAsk(raw);
        return reply(200, 200);
      }
      return reply(503, null);
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (o.webhook.auth) headers.Authorization = o.webhook.auth;
    let status: number | null = null;
    try {
      const up = await fetchImpl(o.webhook.url, { method: 'POST', headers, body: raw, signal: AbortSignal.timeout(15000) });
      status = up.status;
      if (up.ok) {
        const askId = askIdOf(p);
        if (askId) db.prepare('INSERT OR IGNORE INTO ui_ask_delivered (ask_id, delivered_at) VALUES (?, ?)').run(askId, clock.now().toISOString());
        if (msgId) db.prepare('INSERT OR IGNORE INTO ui_delivered (message_id) VALUES (?)').run(msgId);
        void recordAsk(raw);
      }
    } catch {
      status = null;
    }
    if (local && (status === null || status >= 400)) {
      void recordAsk(raw);
      return reply(200, 200); // the board already took it; the assistant copy failed
    }
    return status === null ? reply(502, null) : reply(200, status);
  });

  app.post('/__ab/ask', async (c) => {
    if (!jsonOnly(c.req.header('Content-Type'))) return c.body(null, 415);
    const raw = await body(c.req.raw, MAX_BODY);
    if (raw === null) return c.body(null, 400);
    try {
      JSON.parse(raw);
    } catch {
      return c.body(null, 400);
    }
    return c.body(null, (await recordAsk(raw)) ? 204 : 400);
  });

  app.post('/__ab/delivery-log', async (c) => {
    if (!jsonOnly(c.req.header('Content-Type'))) return c.body(null, 415);
    const raw = await body(c.req.raw, MAX_LOG_BODY);
    if (raw === null) return c.body(null, 400);
    let entry: Json | null;
    try {
      entry = deliveryLogEntry(JSON.parse(raw));
    } catch {
      return c.body(null, 400);
    }
    if (!entry) return c.body(null, 400);
    db.prepare('INSERT INTO ui_delivery_log (json) VALUES (?)').run(JSON.stringify(entry));
    return c.body(null, 204);
  });

  async function abRoute(c: any, parse: (b: Json) => { args: string[]; ok: Json } | null, exits: Record<number, number>, derived: (id: string, b: Json) => Json | null) {
    const fail = (code: number) => c.json({ ok: false }, code);
    if (!jsonOnly(c.req.header('Content-Type'))) return fail(415);
    const raw = await body(c.req.raw, MAX_AB_BODY);
    if (raw === null) return fail(400);
    let b: Json;
    try {
      b = JSON.parse(raw);
    } catch {
      return fail(400);
    }
    if (!b || typeof b !== 'object' || Array.isArray(b) || !isId(b.id)) return fail(400);
    const cmd = parse(b);
    if (!cmd) return fail(400);
    if (derivedTarget(db, b.id)) {
      const ok = derived(b.id, b);
      return ok ? c.json(ok, 200) : fail(400);
    }
    const r = await runAb(cmd.args);
    if (r.code === 0) return c.json(cmd.ok, 200);
    return fail((r.code !== null && exits[r.code]) || 502);
  }

  app.post('/__ab/priority', (c) => abRoute(c,
    (b) => (isStr(b.priority) && PRIORITY_LEVELS.has(b.priority) ? { args: ['priority', b.id, b.priority], ok: { ok: true, priority: b.priority } } : null),
    AB_EXIT_STATUS,
    (id, b) => (markDerived(db, id, 'priority', b.priority), { ok: true, priority: b.priority }),
  ));

  app.post('/__ab/clear', (c) => abRoute(c,
    (b) => ({ args: ['clear', b.id, '--reason', NOT_RELEVANT_REASON], ok: { ok: true } }),
    CLEAR_EXIT_STATUS,
    (id) => {
      markDerived(db, id, 'cleared_at', clock.now().toISOString());
      const t = derivedTarget(db, id);
      if (t?.card) db.prepare('UPDATE cards SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL').run(clock.now().toISOString(), t.card);
      return { ok: true };
    },
  ));

  // Images attached to bot replies (ab reply --image / --svg).
  app.get('/replies/:name', (c) => {
    const name = c.req.param('name');
    if (!repliesDir || !/^[\w.-]+$/.test(name)) return c.notFound();
    const file = normalize(join(repliesDir, name));
    if (!file.startsWith(normalize(repliesDir) + sep) || !existsSync(file)) return c.notFound();
    const type: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
    return c.body(readFileSync(file), 200, { 'Content-Type': type[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
  });

  // The built UI (npm run build). index.html gets the display settings injected; never the webhook URL or auth.
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.json': 'application/json' };
  const indexHtml = () => {
    const file = join(distDir, 'index.html');
    if (!existsSync(file)) return null;
    const cfg = JSON.stringify({ assistantName: o.assistantName ?? 'your assistant', timeZone: o.timeZone ?? 'America/New_York', webhookConfigured: Boolean(o.webhook) }).replace(/</g, '\\u003c');
    return readFileSync(file, 'utf8').replace('</head>', `<script>window.__AB_CONFIG__=${cfg}</script></head>`);
  };
  app.get('/', (c) => {
    const html = indexHtml();
    return html ? c.html(html, 200, { 'Cache-Control': 'no-cache' }) : c.text('UI not built. Run: npm run build', 503);
  });
  app.get('/*', (c, next) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname);
    if (rel.startsWith('/api/') || rel.startsWith('/__ab/') || rel.startsWith('/webhooks/')) return next();
    const file = normalize(join(distDir, rel));
    if (!file.startsWith(normalize(distDir) + sep) || !existsSync(file)) return next();
    const immutable = rel.startsWith('/assets/');
    return c.body(readFileSync(file), 200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
  });
}
