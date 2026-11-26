import { open } from '../src/db.ts';
import { BATCH_MS, runWake, type Sender, type Wake } from '../src/board.ts';

export const T0 = Date.parse('2026-11-26T10:00:00.000Z');

/** Fresh in-memory DB, fake clock, recording sender. Nothing is ever sent. */
export function env(start = T0) {
  const db = open(':memory:');
  let t = start;
  const sent: Wake[] = [];
  let sendOk: (w: Wake) => boolean = () => true;
  const send: Sender = (w) => (sent.push(w), sendOk(w));
  const clock = { now: () => new Date(t) };
  const e = {
    db, clock, sent,
    run: { ...clock, send },
    advance: (ms: number) => void (t += ms),
    failSends: (when: (w: Wake) => boolean = () => true) => void (sendOk = (w) => !when(w)),
    /** let the batch window pass, then run the wake step */
    settle: () => (e.advance(BATCH_MS + 1000), runWake(db, e.run).map((w) => w.bot)),
    cards: (kind?: string) => db.prepare('SELECT * FROM cards WHERE kind LIKE ? ORDER BY id').all(kind ?? '%') as { kind: string; body: string; task_id: string }[],
    task: (id: string) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as { state: string; cycle: number },
    wakes: () => db.prepare('SELECT * FROM wakes ORDER BY id').all() as Record<string, any>[],
  };
  return e;
}
