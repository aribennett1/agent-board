import type { DatabaseSync } from 'node:sqlite';
import { AUTHORS, BOTS, type Bot } from './db.ts';

export const OWNERS = {
  planning: 'planner',
  plan_review: 'qa',
  building: 'engineer',
  qa_review: 'qa',
  waiting_human: null, // The human's turn: never wakes a bot
  merged: null,
  done: null,
} as const satisfies Record<string, Bot | null>;
export type State = keyof typeof OWNERS;

// Review ping-pong states → the side QA trades rounds with (hop limit).
const PAIR: Partial<Record<State, Bot>> = { planning: 'planner', plan_review: 'planner', building: 'engineer', qa_review: 'engineer' };

export const BATCH_MS = 30_000;
export const CHECKIN_MS = 2 * 60_000;
export const STUCK_MS = 20 * 60_000;
export const HOP_ROUNDS = 2;

export type Clock = { now: () => Date };
export type Wake = { id: number; task_id: string; bot: Bot; reason: string; cycle: number; rewake_of: number | null };
export type Sender = (wake: Wake) => boolean;
type Run = Clock & { send: Sender };

// Shadow mode: this build never calls a bot, it only logs who it would wake.
export const printSender: Sender = (w) => {
  console.log(`wake ${w.bot} on ${w.task_id} (${w.reason})${w.rewake_of ? ` re-wake of #${w.rewake_of}` : ''}`);
  return true;
};

type Task = { id: string; title: string; ticket: string | null; pr: number | null; state: State; cycle: number };
type Event = { id: number; task_id: string; source: string; type: string; payload: string };
type WakeRow = Wake & { checkin_at: string | null; done_at: string | null };
type Outcome = 'real_work' | 'pass_through' | 'nothing';

const OUTCOME: Record<string, Outcome | undefined> = {
  work: 'real_work', review_pass: 'real_work', review_changes: 'real_work', answer: 'real_work', question: 'real_work',
  pass_through: 'pass_through', info: 'pass_through',
};

const iso = (c: Clock) => c.now().toISOString();
const ago = (c: Clock, ms: number) => new Date(c.now().getTime() - ms).toISOString();
const sourceOf = (author: string) => (author === 'human' || author === 'script' ? author : 'bot');

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getTask(db: DatabaseSync, id: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
}

function mustTask(db: DatabaseSync, id: string): Task {
  const t = getTask(db, id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
}

function mustState(s: string): asserts s is State {
  if (!Object.hasOwn(OWNERS, s)) throw new Error(`unknown state ${s}`);
}

export function addTask(db: DatabaseSync, t: { id: string; title: string; ticket?: string; pr?: number; state?: string }, c: Clock): void {
  const state = t.state ?? 'planning';
  mustState(state);
  const now = iso(c);
  db.prepare('INSERT INTO tasks (id, title, ticket, pr, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(t.id, t.title, t.ticket ?? null, t.pr ?? null, state, now, now);
}

/** Intake for every event; returns false when the dedup_key was already seen. */
export function ingest(
  db: DatabaseSync,
  e: { task_id: string; source: string; type: string; dedup_key: string; payload?: Record<string, unknown> },
  c: Clock,
): boolean {
  return tx(db, () => {
    const task = mustTask(db, e.task_id);
    const payload: Record<string, unknown> = { ...e.payload, cycle: task.cycle };
    const r = db.prepare('INSERT OR IGNORE INTO events (task_id, source, type, dedup_key, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(e.task_id, e.source, e.type, e.dedup_key, JSON.stringify(payload), iso(c));
    if (r.changes === 0) return false;
    // A normal push is a new diff: new cycle, fresh review rounds. Merge-only keeps the pass.
    if (e.source === 'github' && e.type === 'synchronize' && payload.merge_only !== true) {
      db.prepare('UPDATE tasks SET cycle = cycle + 1, updated_at = ? WHERE id = ?').run(iso(c), e.task_id);
    }
    return true;
  });
}

function closeWake(db: DatabaseSync, task: string, bot: string, outcome: Outcome, now: string): void {
  db.prepare(`UPDATE wakes SET done_at = ?, outcome = ? WHERE id =
    (SELECT id FROM wakes WHERE task_id = ? AND bot = ? AND done_at IS NULL ORDER BY id DESC LIMIT 1)`)
    .run(now, outcome, task, bot);
}

export function addNote(
  db: DatabaseSync,
  n: { task: string; author: string; kind: string; body: string; supersedes?: number },
  c: Clock,
): number {
  if (!n.body.trim()) throw new Error('empty note');
  return tx(db, () => {
    mustTask(db, n.task);
    const now = iso(c);
    const r = db.prepare(`INSERT INTO notes (task_id, author, kind, body, supersedes_id, cycle, created_at)
      VALUES (?, ?, ?, ?, ?, (SELECT cycle FROM tasks WHERE id = ?), ?)`)
      .run(n.task, n.author, n.kind, n.body, n.supersedes ?? null, n.task, now);
    const id = Number(r.lastInsertRowid);
    ingest(db, { task_id: n.task, source: sourceOf(n.author), type: `note:${n.kind}`, dedup_key: `note:${id}`, payload: { by: n.author, note_id: id } }, c);
    const outcome = OUTCOME[n.kind];
    if (outcome) closeWake(db, n.task, n.author, outcome, now);
    return id;
  });
}

export function setState(db: DatabaseSync, s: { task: string; by: string; to: string; newCycle?: boolean }, c: Clock): void {
  mustState(s.to);
  tx(db, () => {
    const t = mustTask(db, s.task);
    if (t.state === s.to) throw new Error(`${s.task} is already ${s.to}`);
    const now = iso(c);
    const cycle = t.cycle + (s.newCycle ? 1 : 0);
    db.prepare('UPDATE tasks SET state = ?, cycle = ?, updated_at = ? WHERE id = ?').run(s.to, cycle, now, s.task);
    const r = db.prepare('INSERT INTO state_changes (task_id, from_state, to_state, by, cycle, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.task, t.state, s.to, s.by, cycle, now);
    ingest(db, { task_id: s.task, source: sourceOf(s.by), type: `state:${s.to}`, dedup_key: `state:${r.lastInsertRowid}`, payload: { by: s.by, from: t.state, to: s.to } }, c);
    closeWake(db, s.task, s.by, 'real_work', now);
  });
}

/** First thing a bot runs on wake. Returns the wake it checked in to, if any. */
export function checkin(db: DatabaseSync, task: string, bot: string, c: Clock): number | null {
  if (!(BOTS as readonly string[]).includes(bot)) throw new Error(`not a bot: ${bot}`);
  return tx(db, () => {
    addNote(db, { task, author: bot, kind: 'started', body: 'checked in' }, c);
    const w = db.prepare('SELECT id FROM wakes WHERE task_id = ? AND bot = ? AND done_at IS NULL ORDER BY id DESC LIMIT 1').get(task, bot) as { id: number } | undefined;
    if (!w) return null;
    db.prepare('UPDATE wakes SET checkin_at = ? WHERE id = ?').run(iso(c), w.id);
    return w.id;
  });
}

function raiseCard(db: DatabaseSync, task: string, kind: string, body: object, wakeId: number | null, now: string): void {
  db.prepare('INSERT INTO cards (task_id, kind, body, wake_id, created_at) VALUES (?, ?, ?, ?, ?)').run(task, kind, JSON.stringify(body), wakeId, now);
  console.log(`card ${kind} on ${task}: ${JSON.stringify(body)}`);
}

function isRealWork(db: DatabaseSync, e: Event): boolean {
  const p = JSON.parse(e.payload);
  if (e.type.startsWith('state:')) return OWNERS[p.to as State] != null;
  if (e.source === 'human') return e.type === 'note:answer';
  if (e.source === 'bot') return p.by === 'qa' && (e.type === 'note:review_pass' || e.type === 'note:review_changes');
  if (e.source !== 'github') return false; // linear status → drift only
  if (e.type === 'review_comment' || e.type === 'bugbot_comment') return true;
  if (e.type !== 'check_failed') return false; // e.g. synchronize only syncs status
  const before = db.prepare(`SELECT 1 FROM events WHERE task_id = ? AND source = 'github' AND type = 'check_failed' AND id < ?
    AND payload ->> '$.check' IS ? AND payload ->> '$.cycle' = ?`).get(e.task_id, e.id, p.check ?? null, p.cycle);
  // shortcut: the rerun itself (gh run rerun) is not wired in this build; wire it when leaving shadow mode
  if (!before) console.log(`rerun CI ${p.check ?? ''} on ${e.task_id} (script, no wake)`);
  return !!before;
}

function planWake(db: DatabaseSync, taskId: string, c: Clock): Wake | null {
  const now = iso(c);
  const task = mustTask(db, taskId);
  const events = db.prepare('SELECT * FROM events WHERE task_id = ? AND processed_at IS NULL ORDER BY id').all(taskId) as Event[];
  db.prepare('UPDATE events SET processed_at = ? WHERE task_id = ? AND processed_at IS NULL').run(now, taskId);

  const real = events.filter((e) => isRealWork(db, e));
  const bot = OWNERS[task.state];
  if (!real.length || !bot) return null;
  const authors = new Set(events.map((e) => JSON.parse(e.payload).by));
  if (authors.size === 1 && authors.has(bot)) return null; // no self-wake
  if (db.prepare('SELECT 1 FROM wakes WHERE task_id = ? AND bot = ? AND done_at IS NULL AND send_ok = 1').get(taskId, bot)) return null; // absorbed

  const side = PAIR[task.state];
  // The human's own input overrides the cap; otherwise stop the ping-pong after HOP_ROUNDS.
  if (side && !events.some((e) => e.source === 'human')) {
    const r = db.prepare(`SELECT count(*) FILTER (WHERE kind = 'review_changes') AS changes, count(*) FILTER (WHERE kind = 'review_pass') AS passes
      FROM notes WHERE task_id = ? AND author = 'qa' AND cycle = ?`).get(taskId, task.cycle) as { changes: number; passes: number };
    if (r.changes >= HOP_ROUNDS && r.passes === 0) {
      const latest = (author: string, kind: string) =>
        (db.prepare(`SELECT body FROM notes_latest WHERE task_id = ? AND author = ? AND kind LIKE ? AND kind != 'started' ORDER BY id DESC LIMIT 1`)
          .get(taskId, author, kind) as { body: string } | undefined)?.body ?? null;
      raiseCard(db, taskId, 'hop_limit', { cycle: task.cycle, rounds: r.changes, qa: latest('qa', 'review_changes'), [side]: latest(side, '%') }, null, now);
      setState(db, { task: taskId, by: 'script', to: 'waiting_human' }, c);
      return null;
    }
  }

  const reason = [...new Set(real.map((e) => `${e.source}:${e.type}`))].join(',');
  const r = db.prepare('INSERT INTO wakes (task_id, bot, reason, event_ids, cycle, sent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(taskId, bot, reason, JSON.stringify(events.map((e) => e.id)), task.cycle, now, now);
  return { id: Number(r.lastInsertRowid), task_id: taskId, bot, reason, cycle: task.cycle, rewake_of: null };
}

export function deliver(db: DatabaseSync, w: Wake, send: Sender): void {
  let ok = false;
  try {
    ok = send(w);
  } catch (e) {
    console.error(`send failed for wake #${w.id}:`, e);
  }
  db.prepare('UPDATE wakes SET send_ok = ? WHERE id = ?').run(ok ? 1 : 0, w.id);
}

/** The save/event script: one wake per task per settled batch, owner only, real work only. */
export function runWake(db: DatabaseSync, c: Run): Wake[] {
  const due = db.prepare('SELECT task_id FROM events WHERE processed_at IS NULL GROUP BY task_id HAVING max(created_at) <= ?')
    .all(ago(c, BATCH_MS)) as { task_id: string }[];
  const woken: Wake[] = [];
  for (const { task_id } of due) {
    const w = tx(db, () => planWake(db, task_id, c));
    if (!w) continue;
    deliver(db, w, c.send);
    woken.push(w);
  }
  return woken;
}

const giveUp = (db: DatabaseSync, id: number, now: string) =>
  db.prepare(`UPDATE wakes SET done_at = coalesce(done_at, ?), outcome = coalesce(outcome, 'nothing') WHERE id = ?`).run(now, id);

/** Missed check-in (2 min) or stuck after check-in (20 min): one re-wake, then a card. */
export function runLiveness(db: DatabaseSync, c: Run): Wake[] {
  const late = db.prepare(`SELECT * FROM wakes WHERE done_at IS NULL AND send_ok = 1
    AND ((checkin_at IS NULL AND sent_at <= ?) OR checkin_at <= ?) ORDER BY id`).all(ago(c, CHECKIN_MS), ago(c, STUCK_MS)) as WakeRow[];
  const rewakes: Wake[] = [];
  for (const w of late) {
    const problem = w.checkin_at ? 'stuck' : 'no_checkin';
    const rewake = tx(db, () => {
      const now = iso(c);
      giveUp(db, w.id, now);
      if (w.rewake_of !== null) {
        // the re-wake failed too: card kind is the original problem
        raiseCard(db, w.task_id, w.reason, { bot: w.bot, wake: w.rewake_of, rewake: w.id, last: problem }, w.id, now);
        return null;
      }
      const r = db.prepare('INSERT INTO wakes (task_id, bot, reason, cycle, rewake_of, sent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(w.task_id, w.bot, problem, w.cycle, w.id, now, now);
      return { id: Number(r.lastInsertRowid), task_id: w.task_id, bot: w.bot, reason: problem, cycle: w.cycle, rewake_of: w.id };
    });
    if (!rewake) continue;
    deliver(db, rewake, c.send);
    rewakes.push(rewake);
  }
  return rewakes;
}

/** A wake whose send failed gets one card. */
export function runFailedWakes(db: DatabaseSync, c: Clock): void {
  const failed = db.prepare('SELECT * FROM wakes w WHERE send_ok = 0 AND NOT EXISTS (SELECT 1 FROM cards WHERE wake_id = w.id)').all() as WakeRow[];
  for (const w of failed) {
    tx(db, () => {
      const now = iso(c);
      giveUp(db, w.id, now);
      raiseCard(db, w.task_id, 'wake_failed', { bot: w.bot, wake: w.id, reason: w.reason }, w.id, now);
    });
  }
}

export type DriftRow = { task: string; linear: { status: string; labels?: string[] }; github: { state: string; checks?: unknown } };

// Expected [Linear status, PR state] per task state; null = anything goes.
const EXPECT: Record<State, [string[], string[]] | null> = {
  planning: [['Todo', 'In Progress'], ['none']],
  plan_review: [['Todo', 'In Progress'], ['none']],
  building: [['In Progress'], ['none', 'draft']],
  qa_review: [['In Review', 'In Progress'], ['draft', 'open', 'approved']],
  waiting_human: null,
  merged: [['Done'], ['merged']],
  done: [['Done'], ['merged']],
};

/** Compare DB state with Linear + GitHub; returns the number of mismatches. */
export function runDrift(db: DatabaseSync, rows: DriftRow[], c: Clock): number {
  let mismatches = 0;
  for (const row of rows) {
    if (typeof row?.task !== 'string' || typeof row.linear?.status !== 'string' || typeof row.github?.state !== 'string') {
      throw new Error(`bad drift row: ${JSON.stringify(row)}`);
    }
    const task = getTask(db, row.task);
    if (!task) {
      console.warn(`drift: unknown task ${row.task}, skipped`);
      continue;
    }
    const exp = EXPECT[task.state];
    const mismatch = !!exp && (!exp[0].includes(row.linear.status) || !exp[1].includes(row.github.state));
    tx(db, () => {
      const now = iso(c);
      db.prepare('INSERT INTO drift_checks (task_id, db_state, linear, github, mismatch, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(task.id, task.state, JSON.stringify(row.linear), JSON.stringify(row.github), mismatch ? 1 : 0, now);
      if (!mismatch) return;
      mismatches++;
      const body = { db_state: task.state, linear: row.linear.status, github: row.github.state };
      const seen = db.prepare(`SELECT 1 FROM cards WHERE task_id = ? AND kind = 'drift' AND body = ?`).get(task.id, JSON.stringify(body));
      if (!seen) raiseCard(db, task.id, 'drift', body, null, now);
    });
  }
  return mismatches;
}

/** Hourly backstop. Safe to run repeatedly. */
export function runTick(db: DatabaseSync, c: Run, drift?: DriftRow[]) {
  const cards = () => (db.prepare('SELECT count(*) AS n FROM cards').get() as { n: number }).n;
  const before = cards();
  const wakes = runWake(db, c);
  const rewakes = runLiveness(db, c);
  runFailedWakes(db, c);
  const mismatches = drift ? runDrift(db, drift, c) : 0;
  return { wakes: wakes.length, rewakes: rewakes.length, cards: cards() - before, mismatches };
}

export const isAuthor = (s: string | undefined): s is string => (AUTHORS as readonly string[]).includes(s ?? '');
