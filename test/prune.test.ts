import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { env } from './helpers.ts';

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const card = (id: string, extra: object = {}) => ({ id, title: id, context: 'c', question: 'q?', options: [], raised_by: 'Planner', created_at: ago(40), ...extra });
const answered = (days: number) => ({ answer: { answer: 'a', answer_label: 'A', answered_at: ago(days) } });

const doc = () => ({
  updated_at: 'x',
  decisions: [card('old-answered', answered(20)), card('new-answered', answered(2)), card('old-open'), card('old-review', { post_comments: [{ n: 1 }] })],
  details: { 'decision:old-answered': { thread: [{ at: ago(21), from: 'bot', text: 'hi' }] }, 'ticket:ROWS-1': { plan: '# keep' } },
  asks: [
    { id: 'a1', at: ago(20), item_key: 'decision:old-answered', kind: 'answer', text: 'yes' },
    { id: 'a2', at: ago(2), item_key: 'decision:new-answered', kind: 'answer', text: 'ok' },
    { id: 'a3', at: ago(40), item_key: 'ticket:ROWS-1', kind: 'note', text: 'old note' },
    { id: 'a4', at: ago(40), item_key: 'ticket:ROWS-1', kind: 'answer', reply_to: 'q1', text: 'answered a thread question' },
    { id: 'a5', at: ago(5), item_key: 'ticket:ROWS-1', kind: 'note', text: 'recent note' },
  ],
});

function setup() {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-prune-')), 'board.db');
  const db = open(dbPath);
  db.prepare('INSERT INTO ui_doc (key, json, updated_at) VALUES (?, ?, ?)').run('board', JSON.stringify(doc()), 'now');
  const log = db.prepare('INSERT INTO ui_log (json) VALUES (?)');
  log.run(JSON.stringify({ at: ago(30), op: 'raise' }));
  log.run(JSON.stringify({ at: ago(1), op: 'raise' }));
  const dl = db.prepare('INSERT INTO ui_delivery_log (json, created_at) VALUES (?, ?)');
  dl.run('{}', ago(30));
  dl.run('{}', ago(1));
  const n = db.prepare('INSERT INTO ui_notifications (bot, text, created_at, cleared_at) VALUES (?, ?, ?, ?)');
  n.run('QA', 'old cleared', ago(10), ago(9));
  n.run('QA', 'just cleared', ago(1), ago(0.1));
  n.run('QA', 'never cleared', ago(10), null);
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['bin/ab.mjs', 'prune', ...args], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_FILE: '' }, encoding: 'utf8' }));
  const count = (t: string) => (db.prepare(`SELECT count(*) c FROM ${t}`).get() as any).c as number;
  const board = () => JSON.parse((db.prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as any).json);
  return { db, dbPath, run, count, board };
}

test('dry run reports what would move and changes nothing', () => {
  const e = setup();
  const r = e.run('--dry-run');
  assert.deepEqual(r.moved, { cards: 1, details: 1, asks: 2, log: 1, delivery_log: 1, notifications: 1 });
  assert.equal(r.dry_run, true);
  assert.equal(e.board().decisions.length, 4);
  assert.equal(e.count('archive_cards'), 0);
  assert.equal(e.count('ui_log'), 2);
  assert.equal(e.count('ui_notifications'), 3);
});

test('a real run moves old closed cards, their asks and details, old logs and cleared notifications into archive tables', () => {
  const e = setup();
  e.run();
  const b = e.board();
  assert.deepEqual(b.decisions.map((d: any) => d.id), ['new-answered', 'old-open', 'old-review']);
  assert.deepEqual(b.asks.map((a: any) => a.id), ['a2', 'a4', 'a5']); // a3: old note moved; a4 has reply_to so stays
  assert.deepEqual(Object.keys(b.details), ['ticket:ROWS-1']);
  assert.equal(e.count('archive_cards'), 1);
  assert.equal(e.count('archive_asks'), 2); // a1 and a3
  assert.equal(e.count('ui_log'), 2); // the recent row and the prune's own entry
  assert.equal(e.count('archive_ui_log'), 1);
  assert.equal(e.count('ui_delivery_log'), 1);
  assert.equal(e.count('archive_ui_delivery_log'), 1);
  assert.deepEqual(e.db.prepare('SELECT text FROM ui_notifications ORDER BY id').all().map((r: any) => r.text), ['just cleared', 'never cleared']);
  assert.equal(e.count('archive_ui_notifications'), 1);
  const archived = e.db.prepare('SELECT * FROM archive_cards').get() as any;
  assert.equal(archived.card_id, 'old-answered');
  assert.equal(JSON.parse(archived.details_json).thread[0].text, 'hi');
});

test('running again moves nothing', () => {
  const e = setup();
  e.run();
  const before = e.count('archive_cards') + e.count('archive_asks') + e.count('archive_ui_log');
  const r = e.run();
  assert.deepEqual(r.moved, { cards: 0, details: 0, asks: 0, log: 0, delivery_log: 0, notifications: 0 });
  assert.equal(e.count('archive_cards') + e.count('archive_asks') + e.count('archive_ui_log'), before);
});

test('open cards are never moved, however old, and --card-days changes the age', () => {
  const e = setup();
  e.run('--card-days', '1');
  const ids = e.board().decisions.map((d: any) => d.id);
  assert.ok(ids.includes('old-open'));
  assert.ok(!ids.includes('new-answered'));
});

test('the archive is readable over GET /__ab/archive', async () => {
  const e = setup();
  e.run();
  const app = createApp(e.db, env().clock, { ui: { runAb: async () => ({ code: 0 }) } });
  const r = await (await app.request('/__ab/archive?item_key=decision:old-answered')).json();
  assert.deepEqual(r.cards.map((c: any) => c.id), ['old-answered']);
  assert.equal(r.cards[0].details.thread[0].text, 'hi');
  assert.deepEqual(r.asks.map((a: any) => a.id), ['a1']);
});
