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
  return db;
}
