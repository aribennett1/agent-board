import { isBoardBot, raisedByOf, type BoardBot } from '../ui/src/raisedBy.ts';

// The compact, bot-facing view of the board: `ab context --bot <name>`. Pure functions over the board document, so
// they are tested without a server. The UI never uses this; it still gets the whole board.

type Json = Record<string, any>;

export const DEFAULTS = { last: 5, clip: 240, asks: 8, askDays: 3 } as const;

export type ContextOptions = {
  bot: BoardBot;
  now: Date;
  timeZone?: string;
  /** Complete view: every card, whole threads, unclipped text, every ask. */
  full?: boolean;
  last?: number;
  clip?: number;
  asks?: number;
  /** The caller's own open test (ab.mjs `isOpen`), so this file never drifts from it. */
  isOpen: (d: Json) => boolean;
  /** Ask ids already read by a bot (ab read / reply / answer ran on the item after the ask). */
  isRead?: (ask: Json) => boolean;
};

export function clip(text: unknown, max: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** "3:02 PM" for today, "Nov 25 3:02 PM" otherwise, in the board's zone. */
export function stamp(iso: unknown, now: Date, timeZone = 'America/New_York'): string {
  const t = new Date(String(iso ?? ''));
  if (Number.isNaN(t.getTime())) return '?';
  const day = (d: Date) => d.toLocaleDateString('en-US', { timeZone });
  const time = t.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' });
  return day(t) === day(now) ? time : `${t.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric' })} ${time}`;
}

const keyOfCard = (id: string) => `decision:${id}`;

/** Who an ask from the person was meant for: the bot they picked, else the card's author, else QA for review answers. */
export function askTarget(a: Json, cards: Json[], details: Json | undefined): BoardBot | undefined {
  if (isBoardBot(a.to_bot)) return a.to_bot;
  const id = typeof a.item_key === 'string' && a.item_key.startsWith('decision:') ? a.item_key.slice('decision:'.length) : undefined;
  const card = id ? cards.find((d) => d.id === id) : undefined;
  if (card) return raisedByOf(card, details);
  if (a.kind === 'review') return 'QA';
  return undefined;
}

type Line = { at: string; who: string; text: string; fresh?: boolean };

function threadLines(board: Json, key: string, opts: { clip: number; full: boolean; isRead?: (ask: Json) => boolean }): Line[] {
  const lines: Line[] = [];
  for (const t of board.details?.[key]?.thread ?? []) {
    const q = t.question;
    const parts = [t.text ? String(t.text) : '', q && !q.superseded_by ? `ASKS: ${q.text} [${(q.options ?? []).map((o: Json) => `${o.id}=${o.label}`).join(' | ')}]` : ''].filter(Boolean);
    if (parts.length) lines.push({ at: String(t.at ?? ''), who: 'bot', text: opts.full ? parts.join(' ') : clip(parts.join(' '), opts.clip) });
  }
  for (const a of board.asks ?? []) {
    if (a.item_key === key) lines.push({ at: String(a.at ?? ''), who: 'Eric', text: opts.full ? String(a.text ?? '') : clip(a.text, opts.clip), fresh: !!opts.isRead && !opts.isRead(a) });
  }
  return lines.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
}

function renderThread(lines: Line[], o: ContextOptions, last: number): string[] {
  if (!lines.length) return [];
  const shown = o.full ? lines : lines.slice(-last);
  const out = shown.map((l) => `    ${stamp(l.at, o.now, o.timeZone)} ${l.fresh ? 'NEW ' : ''}${l.who}: ${l.text}`);
  if (shown.length < lines.length) out.unshift(`    (+${lines.length - shown.length} earlier, see --full)`);
  return out;
}

export type BotContext = { text: string; open: number; asks: number; /** Item keys whose messages from Eric this view showed. */ read_keys: string[] };

export function buildContext(board: Json, o: ContextOptions): BotContext {
  const last = o.last ?? DEFAULTS.last;
  const clipN = o.clip ?? DEFAULTS.clip;
  const maxAsks = o.asks ?? DEFAULTS.asks;
  const cards: Json[] = Array.isArray(board.decisions) ? board.decisions : [];
  const asks: Json[] = Array.isArray(board.asks) ? board.asks : [];
  const mine = cards.filter((d) => raisedByOf(d, board.details) === o.bot);
  const open = mine.filter((d) => o.isOpen(d));
  const shown = o.full ? mine : open;
  const text = (s: unknown, n = clipN) => (o.full ? String(s ?? '') : clip(s, n));
  const out: string[] = [`ab context for ${o.bot} (${stamp(o.now.toISOString(), o.now, o.timeZone)} ET${o.full ? ', full' : ''}). This is your only record of conversations with Eric.`];

  out.push('', `OPEN CARDS (${open.length})${o.full ? ` + ${mine.length - open.length} closed` : ''}`);
  if (!shown.length) out.push('  none');
  const cardKeys = new Set(shown.map((d) => keyOfCard(d.id)));
  for (const d of shown) {
    const closed = !o.isOpen(d);
    out.push(`• ${d.id} [${d.priority ?? 'medium'}${d.tier ? ' ' + d.tier : ''}${closed ? ', closed' : ''}] ${text(d.title, 80)}${d.group ? ` (${d.group})` : ''} raised ${stamp(d.created_at, o.now, o.timeZone)}`);
    if (o.full && d.context) out.push(`    Context: ${d.context}`);
    out.push(`    Q: ${text(d.question)}`);
    if (Array.isArray(d.options) && d.options.length) out.push(`    Options: ${d.options.map((x: Json) => `${x.id}=${x.label}`).join(' | ')}`);
    if (d.answer) out.push(`    Answer: ${text(d.answer.custom_text ?? (Array.isArray(d.answer.answer_label) ? d.answer.answer_label.join(', ') : d.answer.answer_label))} (${stamp(d.answer.answered_at, o.now, o.timeZone)})`);
    out.push(...renderThread(threadLines(board, keyOfCard(d.id), { clip: clipN, full: !!o.full, isRead: o.isRead }), o, last));
  }

  // Eric's messages to this bot that are not on one of its open cards: answers to closed cards, notes on tickets and PRs.
  const cutoff = o.now.getTime() - DEFAULTS.askDays * 86_400_000;
  const mineAsks = asks
    .filter((a) => !cardKeys.has(String(a.item_key)) && askTarget(a, cards, board.details) === o.bot)
    .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  const unread = mineAsks.filter((a) => o.isRead && !o.isRead(a));
  const readRecent = mineAsks.filter((a) => !unread.includes(a) && (o.full || new Date(a.at).getTime() >= cutoff));
  const picked = o.full ? mineAsks : [...unread, ...readRecent.slice(0, Math.max(0, maxAsks - unread.length))];
  out.push('', `ERIC'S LATEST MESSAGES TO YOU (${picked.length}${picked.length < mineAsks.length ? ` of ${mineAsks.length}, see --full` : ''})`);
  if (!picked.length) out.push('  none');
  for (const a of picked) {
    const isNew = unread.includes(a);
    out.push(`• ${isNew ? 'NEW ' : ''}${stamp(a.at, o.now, o.timeZone)} on ${a.item_key}${a.label && a.label !== a.item_key ? ` "${clip(a.label, 60)}"` : ''} [${a.kind}]: ${text(a.text, 400)}`);
    const th = threadLines(board, String(a.item_key), { clip: clipN, full: !!o.full, isRead: o.isRead }).filter((l) => !(l.who === 'Eric' && l.at === a.at));
    if (isNew || o.full) out.push(...renderThread(th, o, 2));
  }
  return { text: out.join('\n'), open: open.length, asks: picked.length, read_keys: [...new Set([...cardKeys, ...picked.map((a) => String(a.item_key))])] };
}

// What a bot's wake webhook carries: the answer and the card it is about, never a whole thread. The bot reads the rest
// with `ab context --bot <name>`. Unknown events and fields pass through untouched in shape, only clipped.
const KEEP: Record<string, string[]> = {
  'decision.answered': ['event', 'decision_id', 'card_ref', 'question', 'answer', 'answer_label', 'custom_text', 'action', 'text', 'answered_at', 'to_bot'],
  'item.message': ['event', 'message_id', 'item_id', 'item_section', 'item_title', 'item_link', 'text', 'sent_at', 'to_bot'],
  'decision.clarify': ['event', 'decision_id', 'question', 'clicked_at', 'to_bot'],
  'decision.not_relevant': ['event', 'decision_id', 'question', 'cleared_at', 'to_bot'],
  'review.answer': ['event', 'decision_id', 'card_id', 'finding', 'repo', 'pr', 'pr_link', 'comment_id', 'action', 'text', 'edited', 'severity', 'path', 'line', 'body', 'answered_at', 'to_bot'],
};
const PAYLOAD_CLIP = 600;

export function slimPayload(p: Json, bot: BoardBot | null): Json {
  const keep = KEEP[String(p.event)];
  if (!keep) return p;
  const out: Json = {};
  for (const k of keep) {
    if (p[k] === undefined) continue;
    out[k] = typeof p[k] === 'string' && k !== 'text' && k !== 'custom_text' && k !== 'body' ? clip(p[k], PAYLOAD_CLIP) : p[k];
  }
  if (bot) out.read_more = `ab context --bot ${bot}`;
  return out;
}
