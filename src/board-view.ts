import { createHash } from 'node:crypto';
import { buildTopics, choiceText, diffBoard, fingerprint, flattenBoard, needsYou, prPath, sameSha, slug, staleContext } from './ui-modules.ts';

// What GET /__ab/board sends by default: only what Eric can see without opening "Show done". Done topics (the same
// test the Home tab uses, by running its own topics.ts), cards that no topic shows, details nothing points at and
// drafted reviews for PRs that left the PR tabs stay in the database. GET /__ab/board/done pages through the done
// topics when he opens "Show done". ?view=all is the whole board, unchanged (bin/ab.mjs reads that one).

type Json = Record<string, any>;
type Topic = { key: string; keys: string[]; group: 'you' | 'progress' | 'done'; at: string; startedAt: string; raisedBy?: string };

export const UNKNOWN_BOT = 'Unknown';
const arr = (v: unknown): Json[] => (Array.isArray(v) ? v : []);

/** The keys the PR and ticket tabs give their rows (App.tsx: detailKey(kind, id)). Those items are never hidden. */
function glanceKeys(b: Json): Set<string> {
  const g = b.glance ?? {};
  return new Set([
    ...arr(g.tickets).map((t) => `ticket:${t.id}`),
    ...arr(g.mine).map((m) => `mypr:${m.repo}/${m.number}`),
    ...arr(g.waiting).map((w) => `waiting:${slug(String(w.title ?? ''))}`),
    ...arr(g.others).map((o) => `pr:${prPath(o.link) ?? slug(String(o.title ?? ''))}`),
  ]);
}

/** Home's item index (App.tsx itemIndex): only the keys matter for which topics merge. */
function labelsOf(b: Json, glance: Set<string>): Record<string, { label: string }> {
  const out: Record<string, { label: string }> = {};
  for (const k of [...glance, ...arr(b.decisions).map((d) => `decision:${d.id}`), ...Object.keys(b.details ?? {}), ...arr(b.asks).map((a) => String(a.item_key))]) out[k] = { label: k };
  return out;
}

type Split = { topics: Topic[]; hidden: Topic[]; hiddenKeys: Set<string>; openIds: Set<string> };

/** Which topics are done and safe to leave out: not on a PR or ticket row, no open card, no live card grouped under them. */
export function splitBoard(b: Json): Split {
  const decisions = arr(b.decisions);
  const openIds = new Set((needsYou(decisions, {}, staleContext(b)) as Json[]).map((d) => String(d.id)));
  const glance = glanceKeys(b);
  const topics = buildTopics({ ...b, decisions, asks: arr(b.asks), details: b.details ?? {} }, labelsOf(b, glance), (d: Json) => openIds.has(String(d.id))) as Topic[];
  const isOpenKey = (k: string) => k.startsWith('decision:') && openIds.has(k.slice('decision:'.length));
  let hidden = topics.filter((t) => t.group === 'done' && !t.keys.some((k) => glance.has(k) || isOpenKey(k)));
  // A card that stays can name a hidden item as its group (raisedBy reads that item's details): keep that topic too.
  for (;;) {
    const keys = new Set(hidden.flatMap((t) => t.keys));
    const groups = new Set(decisions.filter((d) => !keys.has(`decision:${d.id}`)).map((d) => String(d.group ?? '')));
    const next = hidden.filter((t) => !t.keys.some((k) => groups.has(k)));
    if (next.length === hidden.length) break;
    hidden = next;
  }
  return { topics, hidden, hiddenKeys: new Set(hidden.flatMap((t) => [t.key, ...t.keys])), openIds };
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** topics.ts finds an earlier answered card with the same question; when that card is left out, carry its answer on the open card. */
function withAlreadyDecided(d: Json, all: Json[], kept: Set<string>): Json {
  if (d.already_decided) return d;
  const prior = all.find((p) => p.id !== d.id && p.answer &&
    ((p.group && d.group && p.group === d.group) || (!d.group && !p.group)) &&
    (norm(p.question) === norm(d.question) || (p.title && d.title && norm(p.title) === norm(d.title))) &&
    (!d.sha || !p.sha || sameSha(d.sha, p.sha)));
  if (!prior || kept.has(String(prior.id))) return d;
  return { ...d, already_decided: { answer: choiceText(prior.answer), source: prior.title ?? 'earlier card', at: prior.answer.answered_at } };
}

/** The default board: open and in-progress topics, PR and ticket rows, uncleared notifications. */
export function liveView(b: Json): Json {
  const { topics, hidden, hiddenKeys, openIds } = splitBoard(b);
  const glance = glanceKeys(b);
  // A topic's own key can be an item it merged into (ticket:PROJ-n); the card shows that item's details.
  const shown = new Set(topics.flatMap((t) => [t.key, ...t.keys]).filter((k) => !hiddenKeys.has(k)));
  const all = arr(b.decisions);
  // A card stays when a topic shows it or it is open; cards no topic shows (superseded, stale) are not rendered anywhere.
  const decisions = all.filter((d) => shown.has(`decision:${d.id}`) || openIds.has(String(d.id)));
  const kept = new Set(decisions.map((d) => String(d.id)));
  const groups = new Set(decisions.flatMap((d) => [d.group, d.card_ref].filter(Boolean).map(String)));
  const details: Json = {};
  for (const [k, v] of Object.entries((b.details ?? {}) as Json)) {
    if (hiddenKeys.has(k)) continue;
    if (shown.has(k) || glance.has(k) || groups.has(k) || (k.startsWith('decision:') && kept.has(k.slice('decision:'.length)))) details[k] = v;
  }
  const g = b.glance ?? {};
  const prs = new Set([...arr(g.others).map((o) => prPath(o.link)), ...arr(g.mine).map((m) => `${m.repo}/${m.number}`)].filter(Boolean));
  const feedKnown = arr(g.others).length + arr(g.mine).length > 0;
  const byBot: Record<string, number> = {};
  for (const t of hidden) byBot[t.raisedBy ?? UNKNOWN_BOT] = (byBot[t.raisedBy ?? UNKNOWN_BOT] ?? 0) + 1;
  // A PR row's description and open review comments show only when the row is opened: /__ab/pr-detail sends them then.
  const slim = (rows: unknown) => (Array.isArray(rows) ? rows.map(({ body, unresolved, ...row }: Json) => (body || (Array.isArray(unresolved) && unresolved.length) ? { ...row, detail_deferred: true } : row)) : rows);
  return {
    ...b,
    glance: { ...g, ...(Array.isArray(g.others) ? { others: slim(g.others) } : {}), ...(Array.isArray(g.mine) ? { mine: slim(g.mine) } : {}) },
    decisions: decisions.map((d) => (openIds.has(String(d.id)) ? withAlreadyDecided(d, all, kept) : d)),
    ...(Array.isArray(b.asks) ? { asks: b.asks.filter((a: Json) => !hiddenKeys.has(String(a.item_key))) } : {}),
    ...(b.details ? { details } : {}),
    ...(Array.isArray(b.reviews) ? { reviews: feedKnown ? b.reviews.filter((r: Json) => prs.has(`${r.repo}/${r.pr}`)) : b.reviews } : {}),
    done_summary: { total: hidden.length, by_bot: byBot },
  };
}

/** One page of the done topics left out of the default board, newest activity first, with everything they need to render. */
export function doneView(b: Json, o: { bot?: string; offset?: number; limit?: number } = {}): Json {
  const { hidden } = splitBoard(b);
  const list = hidden.filter((t) => !o.bot || (t.raisedBy ?? UNKNOWN_BOT) === o.bot).sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.key < y.key ? -1 : 1));
  const offset = Math.max(0, o.offset ?? 0);
  const limit = Math.min(200, Math.max(1, o.limit ?? 20));
  const page = list.slice(offset, offset + limit);
  const keys = new Set(page.flatMap((t) => [t.key, ...t.keys]));
  return {
    total: list.length, offset, limit, has_more: offset + page.length < list.length,
    topics: page.map((t) => t.key),
    decisions: arr(b.decisions).filter((d) => keys.has(`decision:${d.id}`)),
    asks: arr(b.asks).filter((a) => keys.has(String(a.item_key))),
    details: Object.fromEntries(Object.entries((b.details ?? {}) as Json).filter(([k]) => keys.has(k))),
  };
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** Remembers the last few boards it sent (as hashes only) so ?since=<rev> can answer with just the change. */
export function boardDeltas(keep = 32) {
  const sent = new Map<string, ReturnType<typeof fingerprint>>();
  return (view: Json, since?: string | null): Json => {
    const probe = flattenBoard(view, '');
    const print = fingerprint(probe, sha1);
    const rev = sha1([...print.order].concat([...print.parts]).map(([k, h]) => `${k}=${h}`).join('\n'));
    const flat = { ...probe, version: rev };
    sent.delete(rev);
    sent.set(rev, print);
    while (sent.size > keep) sent.delete(sent.keys().next().value!);
    const prev = since ? sent.get(since) : undefined;
    if (since && prev && since !== rev) return { ...diffBoard(prev, since, flat, print), rev };
    if (since && since === rev) return { delta: true, since, version: rev, order: {}, set: {}, drop: [], rev };
    return { ...view, rev };
  };
}

/** The description and open review comments of one PR row, by its link. */
export function prDetail(b: Json, link: string): Json | null {
  const g = b.glance ?? {};
  const row = [...arr(g.others), ...arr(g.mine)].find((p) => p.link === link);
  return row ? { link, body: row.body ?? '', unresolved: Array.isArray(row.unresolved) ? row.unresolved : [] } : null;
}
