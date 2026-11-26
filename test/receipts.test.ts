import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { boardVersion } from '../src/version.ts';
import { env } from './helpers.ts';

const HOOK = { url: 'https://hooks.example.test/path', auth: 'Bearer x' };
const ASK = { id: 'm1', at: '2026-11-26T10:00:00.000Z', item_key: 'ticket:PROJ-1', label: 'PROJ-1', kind: 'note', text: 'hello' };

function setup(status = 200) {
  const e = env();
  const app = createApp(e.db, e.clock, {
    ui: { webhook: HOOK, fetchImpl: async () => ({ ok: status < 400, status }), runAb: async () => ({ code: 0 }) },
  });
  const asks = (list: object[]) => e.db.prepare('INSERT OR REPLACE INTO ui_doc (key, json, updated_at) VALUES (?, ?, ?)').run('board', JSON.stringify({ updated_at: 'x', decisions: [], glance: { waiting: [], tickets: [] }, asks: list }), 'now');
  const feed = async () => (await app.request('/__ab/board')).json();
  const send = (p: object) => app.request('/__ab/webhook', { method: 'POST', body: JSON.stringify(p), headers: { 'Content-Type': 'application/json', Host: 'board.test' } });
  return { ...e, app, asks, feed, send };
}
const msg = { event: 'item.message', message_id: 'm1', item_id: 'PROJ-1', item_section: 'tickets', text: 'hello', sent_at: ASK.at };

test('check states: sent until the webhook answers 2xx, delivered after, read once the assistant has seen the item', async () => {
  const e = setup();
  e.asks([ASK]);
  assert.equal((await e.feed()).asks[0].status, 'sent');
  await e.send(msg);
  assert.equal((await e.feed()).asks[0].status, 'delivered');
  e.db.prepare('INSERT INTO ui_item_read (item_key, read_at) VALUES (?, ?)').run('ticket:PROJ-1', '2026-11-26T10:00:05.000Z');
  assert.equal((await e.feed()).asks[0].status, 'read');
  e.asks([ASK, { ...ASK, id: 'm2', at: '2026-11-26T10:01:00.000Z' }]);
  assert.deepEqual((await e.feed()).asks.map((a: any) => a.status), ['read', 'sent']);
});

test('a webhook failure leaves the message at sent', async () => {
  const e = setup(500);
  e.asks([ASK]);
  await e.send(msg);
  assert.equal((await e.feed()).asks[0].status, 'sent');
});

test('answers and clarify clicks get delivered receipts under the ids ab ask gives them', async () => {
  const e = setup();
  const ans = { id: 'd1:answer', at: ASK.at, item_key: 'decision:d1', label: 'D1', kind: 'answer', text: 'A' };
  e.asks([ans]);
  await e.send({ event: 'decision.answered', decision_id: 'd1', answer: 'a', answer_label: 'A', answered_at: ASK.at });
  assert.equal((await e.feed()).asks[0].status, 'delivered');
});

test('receipts and the webhook flag change the version hash, so the 10-second refresh picks them up', async () => {
  const e = setup();
  const a = boardVersion(e.db);
  e.db.prepare('INSERT INTO ui_ask_delivered (ask_id, delivered_at) VALUES (?, ?)').run('m1', 'now');
  const b = boardVersion(e.db);
  assert.notEqual(a, b);
  e.db.prepare('INSERT INTO ui_item_read (item_key, read_at) VALUES (?, ?)').run('ticket:PROJ-1', 'now');
  assert.notEqual(boardVersion(e.db), b);
  assert.notEqual(boardVersion(e.db, true), boardVersion(e.db, false));
  assert.equal(((await (await e.app.request('/api/version')).json()) as any).version, boardVersion(e.db, true));
});

test('the board payload says whether the webhook is on', async () => {
  const e = setup();
  assert.equal((await e.feed()).webhook_configured, true);
  const off = createApp(e.db, e.clock, { ui: { webhook: null } });
  assert.equal(((await (await off.request('/__ab/board')).json()) as any).webhook_configured, false);
});

test('ab read, ab reply and ab answer record read_at; no AI involved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-read-'));
  const dbPath = join(dir, 'board.db');
  open(dbPath).close();
  const ab = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['bin/ab.mjs', ...args], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_FILE: '' }, encoding: 'utf8' }));
  const read = (key: string) => (open(dbPath).prepare('SELECT read_at FROM ui_item_read WHERE item_key = ?').get(key) as { read_at: string } | undefined)?.read_at;
  assert.equal(ab('read', 'task:T1:4').key, 'decision:task:T1:4');
  assert.ok(read('decision:task:T1:4'));
  assert.equal(ab('read', 'PROJ-7').key, 'ticket:PROJ-7');
  assert.ok(read('ticket:PROJ-7'));
  ab('reply', 'ticket:PROJ-8', 'on it');
  assert.ok(read('ticket:PROJ-8'));
  assert.throws(() => ab('answer', 'nope', 'a', '--by', 'app'), /no decision nope/);
  assert.ok(read('decision:nope'));
});
