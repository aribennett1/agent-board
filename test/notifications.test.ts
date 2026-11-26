import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { boardVersion } from '../src/version.ts';
import { env } from './helpers.ts';

const HOOK = { url: 'https://hooks.example.test/path', auth: 'Bearer x' };

function setup() {
  const e = env();
  const up: unknown[] = [];
  const app = createApp(e.db, e.clock, {
    ui: { webhook: HOOK, fetchImpl: async () => (up.push(1), { ok: true, status: 200 }), runAb: async () => ({ code: 0 }) },
  });
  const feed = async () => (await app.request('/__ab/board')).json();
  const clear = (body: object) => app.request('/__ab/notifications/clear', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Host: 'board.test' } });
  const insert = (bot: string, text: string, extra: object = {}) =>
    e.db.prepare('INSERT INTO ui_notifications (bot, text, next_update, link, created_at) VALUES (?, ?, ?, ?, ?)').run(
      bot, text, (extra as { next_update?: string }).next_update ?? null, (extra as { link?: string }).link ?? null, (extra as { created_at?: string }).created_at ?? '2026-11-26T17:00:00.000Z',
    );
  return { ...e, app, up, feed, clear, insert };
}

const ab = (dbPath: string, ...args: string[]) => {
  try {
    return { code: 0, out: JSON.parse(execFileSync(process.execPath, ['bin/ab.mjs', ...args], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_FILE: '' }, encoding: 'utf8' })) };
  } catch (err: any) {
    return { code: typeof err.status === 'number' ? err.status : 1, out: null, stderr: String(err.stderr ?? '') };
  }
};

const raiseCard = (id: string, extra: object = {}) => ({
  id, title: 'Checkout image compression',
  context: 'The checkout page is slow because it loads every product image at full size before the page can be used.',
  question: 'Should we compress the images?', what_happens_after: 'The assistant starts compressing them.',
  options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'Hold' }],
  priority: 'medium',
  group: 'ROWS-5207',
  card_ref: 'https://linear.app/rows/issue/ROWS-5207/checkout-images',
  ...extra,
});

test('ab notify stores a short note and the board serves it newest first, never as a decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-notify-'));
  const dbPath = join(dir, 'board.db');
  open(dbPath).close();
  const a = ab(dbPath, 'notify', '--bot', 'Planner', '--text', 'Starting the plan now.', '--next', '1:15 PM ET');
  assert.equal(a.code, 0);
  assert.equal(a.out.bot, 'Planner');
  assert.equal(a.out.next_update, '1:15 PM ET');
  const b = ab(dbPath, 'notify', '--bot', 'QA', '--text', 'Approved PR #12 at `abc1234`.', '--link', 'https://example.test/12');
  assert.equal(b.code, 0);
  const db = open(dbPath);
  const app = createApp(db, env().clock, { ui: { webhook: HOOK, fetchImpl: async () => ({ ok: true, status: 200 }) } });
  const feed = await (await app.request('/__ab/board')).json();
  assert.equal(feed.notifications.length, 2);
  assert.equal(feed.notifications[0].bot, 'QA');
  assert.equal(feed.notifications[1].bot, 'Planner');
  assert.ok(feed.decisions.every((d: { id: string }) => !String(d.id).includes('notify')));
});

test('ab notify rejects a bad bot, blank text, a non-http link, and file-mode storage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-notify-bad-'));
  const dbPath = join(dir, 'board.db');
  open(dbPath).close();
  assert.equal(ab(dbPath, 'notify', '--bot', 'ops', '--text', 'hi').code, 2);
  assert.equal(ab(dbPath, 'notify', '--bot', 'Planner', '--text', '   ').code, 2);
  assert.equal(ab(dbPath, 'notify', '--bot', 'Engineer', '--text', 'hi', '--link', 'javascript:alert(1)').code, 2);
  const file = join(dir, 'board.ts');
  writeFileSync(file, '/* BOARD-JSON-START */{"updated_at":"x","decisions":[],"glance":{"waiting":[],"tickets":[]}}/* BOARD-JSON-END */');
  try {
    execFileSync(process.execPath, ['bin/ab.mjs', 'notify', '--bot', 'Planner', '--text', 'hi'], { env: { ...process.env, AB_FILE: file, AB_NO_SERVER: '1' }, encoding: 'utf8', stdio: 'pipe' });
    assert.fail('expected exit 2');
  } catch (err: any) {
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /unset AB_FILE/);
  }
});

test('clearing a notification hides it from the feed, never calls the wake webhook, and dismiss-all clears the rest', async () => {
  const e = setup();
  const before = boardVersion(e.db, true);
  e.insert('Planner', 'Starting now.');
  const mid = boardVersion(e.db, true);
  assert.notEqual(mid, before);
  assert.equal(((await (await e.app.request('/api/version')).json()) as { version: string }).version, mid);
  const feed = await e.feed();
  assert.equal(feed.notifications.length, 1);
  assert.equal((await e.clear({ id: feed.notifications[0].id })).status, 200);
  assert.deepEqual(e.up, []);
  assert.equal((await e.feed()).notifications.length, 0);
  assert.notEqual(boardVersion(e.db, true), mid);
  e.insert('QA', 'Approved the pull request.', { created_at: '2026-11-26T17:01:00.000Z' });
  e.insert('Engineer', 'Starting the build.', { created_at: '2026-11-26T17:02:00.000Z' });
  assert.equal((await e.feed()).notifications.length, 2);
  assert.equal((await e.clear({ all: true })).status, 200);
  assert.equal((await e.feed()).notifications.length, 0);
  assert.equal((await e.clear({ id: 0 })).status, 400);
  assert.equal((await e.clear({})).status, 400);
  assert.equal((await e.app.request('/__ab/notifications/clear', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain', Host: 'board.test' } })).status, 415);
  assert.deepEqual(e.up, []);
});

test('open() renames a leftover read_at column and adds cleared_at when the table has neither', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-notify-mig-'));
  const dbPath = join(dir, 'board.db');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TABLE ui_notifications (id INTEGER PRIMARY KEY, bot TEXT NOT NULL, text TEXT NOT NULL, next_update TEXT, link TEXT, created_at TEXT, read_at TEXT)`);
  raw.prepare('INSERT INTO ui_notifications (bot, text, read_at) VALUES (?, ?, ?)').run('Planner', 'old note', '2026-11-26T17:00:00.000Z');
  raw.close();
  const db = open(dbPath);
  const cols = (db.prepare('PRAGMA table_info(ui_notifications)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('cleared_at'));
  assert.ok(!cols.includes('read_at'));
  assert.equal((db.prepare('SELECT cleared_at FROM ui_notifications').get() as { cleared_at: string }).cleared_at, '2026-11-26T17:00:00.000Z');
  db.close();
});

test('ab raise --bot stores raised_by and a re-raise keeps it; a bad name is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-raise-bot-'));
  const dbPath = join(dir, 'board.db');
  open(dbPath).close();
  const payload = JSON.stringify(raiseCard('planner-compress-images'));
  const bad = ab(dbPath, 'raise', '--bot', 'ops', payload);
  assert.equal(bad.code, 2);
  const ok = ab(dbPath, 'raise', '--bot', 'Planner', payload);
  assert.equal(ok.code, 0, String(ok.stderr ?? ''));
  const db = open(dbPath);
  const row = JSON.parse((db.prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string }).json);
  assert.equal(row.decisions[0].raised_by, 'Planner');
  const again = ab(dbPath, 'raise', JSON.stringify(raiseCard('planner-compress-images', { context: 'The checkout page is still slow because full-size images load before the page can be used.' })));
  assert.equal(again.code, 0, String(again.stderr ?? ''));
  const row2 = JSON.parse((open(dbPath).prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string }).json);
  assert.equal(row2.decisions[0].raised_by, 'Planner');
});
