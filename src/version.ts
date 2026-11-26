import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** SHA-256 of the board content the UI shows (tasks, notes, cards). Stable until that content changes. */
export function boardVersion(db: DatabaseSync): string {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const notes = db.prepare('SELECT id, task_id, author, kind, body, supersedes_id FROM notes ORDER BY id').all();
  const cards = db.prepare('SELECT id, task_id, kind, body, resolved_at FROM cards ORDER BY id').all();
  return createHash('sha256').update(JSON.stringify({ tasks, notes, cards })).digest('hex');
}
