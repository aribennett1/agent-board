import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** SHA-256 of everything the UI shows (tasks, notes, cards, the board document, project, derived card state, message receipts, notifications and whether the wake webhook is on). Stable until that content changes. */
export function boardVersion(db: DatabaseSync, webhookConfigured = false): string {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
  const notes = db.prepare('SELECT id, task_id, author, kind, body, supersedes_id FROM notes ORDER BY id').all();
  const cards = db.prepare('SELECT id, task_id, kind, body, resolved_at FROM cards ORDER BY id').all();
  const ui = db.prepare('SELECT key, json FROM ui_doc ORDER BY key').all();
  const derived = db.prepare('SELECT * FROM ui_derived_state ORDER BY decision_id').all();
  const receipts = [db.prepare('SELECT * FROM ui_ask_delivered ORDER BY ask_id').all(), db.prepare('SELECT * FROM ui_item_read ORDER BY item_key').all()];
  const feed = db.prepare('SELECT key, json FROM ui_feed ORDER BY key').all();
  const notifications = db.prepare('SELECT * FROM ui_notifications ORDER BY id').all();
  return createHash('sha256').update(JSON.stringify({ tasks, notes, cards, ui, derived, receipts, notifications, feed, webhookConfigured })).digest('hex');
}
