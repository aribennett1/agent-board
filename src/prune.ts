import type { DatabaseSync } from 'node:sqlite';

// Daily prune: moves old closed cards, their asks and details, old log rows and cleared notifications into archive_*
// tables in the same database. Nothing is deleted for good, and a second run finds nothing left to move.
// ab prune takes the same lock every other ab write takes, and passes the board write in as writeBoard.

type Json = Record<string, any>;

export type PruneOptions = {
  now: Date;
  /** Closed or answered cards older than this many days. */
  cardDays?: number;
  /** Eric's notes on tickets and PRs (not on a card) older than this many days. */
  askDays?: number;
  /** ui_log and ui_delivery_log rows. */
  logDays?: number;
  /** Cleared notifications. */
  notificationDays?: number;
  isOpen: (d: Json) => boolean;
};

export const PRUNE_DEFAULTS = { cardDays: 14, askDays: 30, logDays: 14, notificationDays: 3 } as const;

export type PrunePlan = {
  cards: Json[];
  details: Record<string, Json>;
  asks: Json[];
  logIds: number[];
  deliveryLogIds: number[];
  notificationIds: number[];
};

export type PruneCounts = { cards: number; details: number; asks: number; log: number; delivery_log: number; notifications: number };

const MS_DAY = 86_400_000;
const olderThan = (iso: unknown, days: number, now: Date) => {
  const t = Date.parse(String(iso ?? ''));
  return Number.isFinite(t) && t < now.getTime() - days * MS_DAY;
};

export function countsOf(p: PrunePlan): PruneCounts {
  return { cards: p.cards.length, details: Object.keys(p.details).length, asks: p.asks.length, log: p.logIds.length, delivery_log: p.deliveryLogIds.length, notifications: p.notificationIds.length };
}

/** What would move. Pure with respect to `board`; reads the log and notification ids from `db`. */
export function planPrune(db: DatabaseSync, board: Json, o: PruneOptions): PrunePlan {
  const cardDays = o.cardDays ?? PRUNE_DEFAULTS.cardDays;
  const askDays = o.askDays ?? PRUNE_DEFAULTS.askDays;
  const logDays = o.logDays ?? PRUNE_DEFAULTS.logDays;
  const notificationDays = o.notificationDays ?? PRUNE_DEFAULTS.notificationDays;
  const cards: Json[] = Array.isArray(board.decisions) ? board.decisions : [];
  const asks: Json[] = Array.isArray(board.asks) ? board.asks : [];

  const old = cards.filter((d) => !o.isOpen(d) && olderThan(d.answer?.answered_at ?? d.updated_at ?? d.created_at, cardDays, o.now));
  const gone = new Set(old.map((d) => String(d.id)));
  const keep = cards.filter((d) => !gone.has(String(d.id)));
  const keepsAsk = (a: Json) => keep.some((d) => a.item_key === `decision:${d.id}` || (typeof a.ref === 'string' && a.ref.startsWith(`${d.id}:`)));
  const ofGone = (a: Json) => [...gone].some((id) => a.item_key === `decision:${id}` || (typeof a.ref === 'string' && a.ref.startsWith(`${id}:`)));
  const moveAsks = asks.filter((a) => !keepsAsk(a) && (ofGone(a) || (!a.reply_to && !String(a.item_key).startsWith('decision:') && olderThan(a.at, askDays, o.now))));
  const details: Record<string, Json> = {};
  for (const id of gone) if (board.details?.[`decision:${id}`]) details[`decision:${id}`] = board.details[`decision:${id}`];

  const cut = (days: number) => new Date(o.now.getTime() - days * MS_DAY).toISOString();
  const logIds = (db.prepare(`SELECT id FROM ui_log WHERE json_extract(json, '$.at') < ?`).all(cut(logDays)) as { id: number }[]).map((r) => r.id);
  const deliveryLogIds = (db.prepare('SELECT id FROM ui_delivery_log WHERE created_at < ?').all(cut(logDays)) as { id: number }[]).map((r) => r.id);
  const notificationIds = (db.prepare('SELECT id FROM ui_notifications WHERE cleared_at IS NOT NULL AND cleared_at < ?').all(cut(notificationDays)) as { id: number }[]).map((r) => r.id);
  return { cards: old, details, asks: moveAsks, logIds, deliveryLogIds, notificationIds };
}

/** The board document without what the plan moves. */
export function boardAfter(board: Json, plan: PrunePlan): Json {
  const gone = new Set(plan.cards.map((d) => String(d.id)));
  const askIds = new Set(plan.asks.map((a) => a.id));
  const details = { ...(board.details ?? {}) };
  for (const k of Object.keys(plan.details)) delete details[k];
  return {
    ...board,
    decisions: (board.decisions ?? []).filter((d: Json) => !gone.has(String(d.id))),
    asks: (board.asks ?? []).filter((a: Json) => !askIds.has(a.id)),
    details,
  };
}

const chunk = <T,>(xs: T[], n = 500) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** Copies everything in the plan into the archive tables, removes it from the live ones and writes the shortened board document (writeBoard), all in one transaction. */
export function applyPrune(db: DatabaseSync, plan: PrunePlan, now: Date, writeBoard: () => void): void {
  const at = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const card = db.prepare('INSERT OR IGNORE INTO archive_cards (card_id, json, details_json, answered_at, archived_at) VALUES (?, ?, ?, ?, ?)');
    for (const d of plan.cards) card.run(String(d.id), JSON.stringify(d), plan.details[`decision:${d.id}`] ? JSON.stringify(plan.details[`decision:${d.id}`]) : null, d.answer?.answered_at ?? null, at);
    const ask = db.prepare('INSERT OR IGNORE INTO archive_asks (ask_id, item_key, at, json, archived_at) VALUES (?, ?, ?, ?, ?)');
    for (const a of plan.asks) ask.run(String(a.id), String(a.item_key ?? ''), String(a.at ?? ''), JSON.stringify(a), at);
    for (const ids of chunk(plan.logIds)) {
      const q = ids.map(() => '?').join(',');
      db.prepare(`INSERT OR IGNORE INTO archive_ui_log (id, json, archived_at) SELECT id, json, ? FROM ui_log WHERE id IN (${q})`).run(at, ...ids);
      db.prepare(`DELETE FROM ui_log WHERE id IN (${q})`).run(...ids);
    }
    for (const ids of chunk(plan.deliveryLogIds)) {
      const q = ids.map(() => '?').join(',');
      db.prepare(`INSERT OR IGNORE INTO archive_ui_delivery_log (id, json, created_at, archived_at) SELECT id, json, created_at, ? FROM ui_delivery_log WHERE id IN (${q})`).run(at, ...ids);
      db.prepare(`DELETE FROM ui_delivery_log WHERE id IN (${q})`).run(...ids);
    }
    for (const ids of chunk(plan.notificationIds)) {
      const q = ids.map(() => '?').join(',');
      db.prepare(`INSERT OR IGNORE INTO archive_ui_notifications (id, bot, text, next_update, link, created_at, cleared_at, archived_at) SELECT id, bot, text, next_update, link, created_at, cleared_at, ? FROM ui_notifications WHERE id IN (${q})`).run(at, ...ids);
      db.prepare(`DELETE FROM ui_notifications WHERE id IN (${q})`).run(...ids);
    }
    writeBoard();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
