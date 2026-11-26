import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
  const read = (body: object) => app.request('/__ab/notifications/read', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Host: 'board.test' } });
  const insert = (bot: string, text: string, extra: object = {}) =>
    e.db.prepare('INSERT INTO ui_notifications (bot, text, next_update, link, created_at) VALUES (?, ?, ?, ?, ?)').run(
      bot, text, (extra as { next_update?: string }).next_update ?? null, (extra as { link?: string }).link ?? null, (extra as { created_at?: string }).created_at ?? '2026-11-26T17:00:00.000Z',
    );
  return { ...e, app, up, feed, read, insert };
}

const ab = (dbPath: string, ...args: string[]) => {
  try {
    return { code: 0, out: JSON.parse(execFileSync(process.execPath, ['bin/ab.mjs', ...args], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_FILE: '' }, encoding: 'utf8' })) };
  } catch (err: any) {
    return { code: typeof err.status === 'number' ? err.status : 1, out: null, stderr: String(err.stderr ?? '') };
  }
};

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
  assert.equal(b.out.link, 'https://example.test/12');
  const e = env();
  // Re-open the file the CLI wrote.
  e.db.close?.();
  const db = open(dbPath);
  const app = createApp(db, e.clock, { ui: { webhook: HOOK, fetchImpl: async () => ({ ok: true, status: 200 }) } });
  const feed = await (await app.request('/__ab/board')).json();
  assert.equal(feed.notifications.length, 2);
  assert.equal(feed.notifications[0].bot, 'QA');
  assert.equal(feed.notifications[1].bot, 'Planner');
  assert.equal(feed.notifications[1].next_update, '1:15 PM ET');
  assert.ok(feed.decisions.every((d: { id: string }) => !String(d.id).includes('notify')));
  assert.ok(!(feed.asks ?? []).some((x: { text: string }) => /Starting the plan/.test(x.text)));
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

test('marking a notification read never calls the wake webhook, and the version hash follows inserts and reads', async () => {
  const e = setup();
  const before = boardVersion(e.db, true);
  e.insert('Planner', 'Starting now.');
  const mid = boardVersion(e.db, true);
  assert.notEqual(mid, before);
  assert.equal(((await (await e.app.request('/api/version')).json()) as { version: string }).version, mid);
  const feed = await e.feed();
  assert.equal(feed.notifications[0].read_at, null);
  assert.equal((await e.read({ ids: [feed.notifications[0].id] })).status, 200);
  assert.deepEqual(e.up, []);
  const after = await e.feed();
  assert.ok(after.notifications[0].read_at);
  assert.notEqual(boardVersion(e.db, true), mid);
  // already-read stays, mark-all covers the rest, bad bodies are refused
  e.insert('QA', 'Approved the pull request.', { created_at: '2026-11-26T17:01:00.000Z' });
  assert.equal((await e.read({ all: true })).status, 200);
  assert.ok((await e.feed()).notifications.every((n: { read_at: string | null }) => n.read_at));
  assert.equal((await e.read({ ids: [] })).status, 400);
  assert.equal((await e.read({ ids: ['x'] })).status, 400);
  assert.equal((await e.app.request('/__ab/notifications/read', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain', Host: 'board.test' } })).status, 415);
  assert.deepEqual(e.up, []);
});
