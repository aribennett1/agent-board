import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export const BOTS = ['planner', 'engineer', 'qa', 'ops', 'chief'] as const;
export const AUTHORS = [...BOTS, 'human', 'script'] as const;
export type Bot = (typeof BOTS)[number];
export type Author = (typeof AUTHORS)[number];

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

export function open(path: string): DatabaseSync {
  // timeout: concurrent bot CLIs queue on the write lock instead of failing
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(schema);
  migrateNotifications(db);
  return db;
}

/** Existing DBs may have no notifications table column, or the old read_at name. */
export function migrateNotifications(db: DatabaseSync) {
  const cols = (db.prepare('PRAGMA table_info(ui_notifications)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.length) return;
  if (cols.includes('read_at') && !cols.includes('cleared_at')) db.exec('ALTER TABLE ui_notifications RENAME COLUMN read_at TO cleared_at');
  else if (!cols.includes('cleared_at')) db.exec('ALTER TABLE ui_notifications ADD COLUMN cleared_at TEXT');
}
