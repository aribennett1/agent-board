import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** SHA-256 of everything the UI shows (tasks, notes, cards, the board document, project and derived card state). Stable until that content changes. */
export function boardVersion(db: DatabaseSync): string {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const notes = db.prepare('SELECT id, task_id, author, kind, body, supersedes_id FROM notes ORDER BY id').all();
  const cards = db.prepare('SELECT id, task_id, kind, body, resolved_at FROM cards ORDER BY id').all();
  const ui = db.prepare('SELECT key, json FROM ui_doc ORDER BY key').all();
  const derived = db.prepare('SELECT * FROM ui_derived_state ORDER BY decision_id').all();
  return createHash('sha256').update(JSON.stringify({ tasks, notes, cards, ui, derived })).digest('hex');
}
