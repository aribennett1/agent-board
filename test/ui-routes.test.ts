import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { addTask, addNote } from '../src/board.ts';
import { open } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { boardVersion } from '../src/version.ts';
import { deliveryLogEntry, payloadText, WEBHOOK_EVENTS } from '../src/ui-routes.ts';
import { env } from './helpers.ts';

const HOOK = { url: 'https://hooks.example.test/s3cr3t-path', auth: 'Bearer s3cr3t-token' };

function setup(opts: { webhook?: boolean; status?: number } = {}) {
  const e = env();
  const up: { url: string; headers: Record<string, string>; body: any }[] = [];
  const ab: string[][] = [];
  const dist = mkdtempSync(join(tmpdir(), 'ab-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>Board</title></head><body></body></html>');
  writeFileSync(join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(dist, 'favicon-needs.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><circle fill="#e11d48"/></svg>');
  const app = createApp(e.db, e.clock, {
    ui: {
      webhook: opts.webhook === false ? null : HOOK, distDir: dist, assistantName: 'Helper', timeZone: 'UTC',
      fetchImpl: async (url, init) => (up.push({ url, headers: init.headers, body: JSON.parse(init.body) }), { ok: (opts.status ?? 200) < 400, status: opts.status ?? 200 }),
      runAb: async (args) => (ab.push(args), { code: 0 }),
    },
  });
  const post = (path: string, body: unknown, ct = 'application/json') => app.request(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': ct, Host: 'board.test' } });
  const put = (key: 'board' | 'project', doc: unknown) => e.db.prepare('INSERT OR REPLACE INTO ui_doc (key, json, updated_at) VALUES (?, ?, ?)').run(key, JSON.stringify(doc), 'now');
  return { ...e, app, up, ab, post, put };
}

const card = (id: string, extra: object = {}) => ({ id, title: id.replace(/-/g, ' '), context: 'ctx', question: `Q ${id}?`, what_happens_after: 'then', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], created_at: '2026-11-26T09:00:00Z', ...extra });

test('decision cards with options, priority, glance sections and the project tab come from the board feed', async () => {
  const e = setup();
  e.put('board', { updated_at: 'x', decisions: [card('d1', { priority: 'high' })], glance: { waiting: [{ title: 'PR 1', who: 'Sam' }], tickets: [], others: [], mine: [] }, details: { 'ticket:PROJ-1': { summary: 's' } } });
  e.put('project', { title: 'Relaunch', updated_at: 'x', parent: { id: 'PROJ-1', url: '' }, milestones: [] });
  const feed = await (await e.app.request('/__ab/board')).json();
  assert.equal(feed.decisions[0].options.length, 2);
  assert.equal(feed.decisions[0].priority, 'high');
  assert.equal(feed.glance.waiting[0].title, 'PR 1');
  assert.ok(feed.details['ticket:PROJ-1']);
  assert.equal(feed.project.title, 'Relaunch');
  assert.equal((await e.app.request('/__ab/board')).headers.get('cache-control'), 'no-store');
});

test('an empty board still serves a valid feed', async () => {
  const feed = await (await setup().app.request('/__ab/board')).json();
  assert.deepEqual(feed.decisions, []);
  assert.deepEqual(Object.keys(feed.glance).sort(), ['mine', 'others', 'tickets', 'waiting']);
});

test('tasks waiting on a person and open cards show up as decision cards', async () => {
  const e = setup();
  addTask(e.db, { id: 'T1', title: 'Ship it', state: 'waiting_human' }, e.clock);
  addNote(e.db, { task: 'T1', author: 'planner', kind: 'question', body: 'Which database?' }, e.clock);
  const feed = await (await e.app.request('/__ab/board')).json();
  const d = feed.decisions.find((x: any) => x.id.startsWith('task:T1:'));
  assert.equal(d.question, 'Which database?');
  assert.equal(d.priority, 'high');
});

test('the version hash covers the board document, so the 10-second poll sees UI-only changes', async () => {
  const e = setup();
  const a = boardVersion(e.db);
  e.put('board', { updated_at: 'x', decisions: [card('d1')], glance: {} });
  const b = boardVersion(e.db);
  assert.notEqual(a, b);
  assert.equal(boardVersion(e.db), b);
  e.put('project', { title: 'P', updated_at: 'x', parent: { id: '', url: '' }, milestones: [] });
  assert.notEqual(boardVersion(e.db), b);
});

test('decision.answered is forwarded with the server-side URL and auth, and the reply holds neither', async () => {
  const e = setup();
  const payload = { event: 'decision.answered', decision_id: 'd1', answer: 'a', answer_label: 'A', answered_at: 'now' };
  const r = await e.post('/__ab/webhook', payload);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { status: 200 });
  assert.equal(e.up.length, 1);
  assert.equal(e.up[0].url, HOOK.url);
  assert.equal(e.up[0].headers.Authorization, HOOK.auth);
  assert.deepEqual(e.up[0].body, payload);
  assert.doesNotMatch(text, /s3cr3t/);
  for (const path of ['/', '/__ab/config', '/__ab/board']) assert.doesNotMatch(await (await e.app.request(path)).text(), /s3cr3t/, path);
});

test('every webhook event keeps the local board names: answered, message, clarify, not relevant, review answer', async () => {
  assert.deepEqual([...WEBHOOK_EVENTS].sort(), ['decision.answered', 'decision.clarify', 'decision.not_relevant', 'item.message', 'review.answer']);
  const e = setup();
  for (const event of WEBHOOK_EVENTS) assert.equal((await e.post('/__ab/webhook', { event, decision_id: 'd', text: 'hi', message_id: `m-${event}`, item_id: 'i', item_section: 'tickets' })).status, 200);
  assert.deepEqual(e.up.map((u) => u.body.event).sort(), [...WEBHOOK_EVENTS].sort());
});

test('free text from a card, a thread reply or a review field reaches the webhook unchanged', async () => {
  const e = setup();
  await e.post('/__ab/webhook', { event: 'decision.answered', decision_id: 'd1', answer: 'custom', answer_label: 'custom', custom_text: 'do it my way' });
  await e.post('/__ab/webhook', { event: 'item.message', message_id: 'm1', item_id: 'ticket:PROJ-1', item_section: 'tickets', text: 'a thread reply' });
  await e.post('/__ab/webhook', { event: 'review.answer', decision_id: 'r1', text: 'soften this' });
  assert.deepEqual(e.up.map((u) => payloadText(u.body)), ['do it my way', 'a thread reply', 'soften this']);
});

test('a retried item.message is never sent twice', async () => {
  const e = setup();
  const m = { event: 'item.message', message_id: 'm1', item_id: 'i', item_section: 'tickets', text: 'hi' };
  await e.post('/__ab/webhook', m);
  assert.deepEqual(await (await e.post('/__ab/webhook', m)).json(), { status: 200 });
  assert.equal(e.up.length, 1);
});

test('webhook failures: bad input 400, wrong type 415, unknown event 400, no webhook 503, receiver down 502, receiver error passed on', async () => {
  const e = setup();
  assert.equal((await e.post('/__ab/webhook', 'nope')).status, 400);
  assert.equal((await e.post('/__ab/webhook', { event: 'x.y' })).status, 400);
  assert.equal((await e.post('/__ab/webhook', '{}', 'text/plain')).status, 415);
  assert.equal(e.up.length, 0);
  const off = setup({ webhook: false });
  assert.equal((await off.post('/__ab/webhook', { event: 'decision.clarify', decision_id: 'd1' })).status, 503);
  const bad = setup({ status: 500 });
  assert.deepEqual(await (await bad.post('/__ab/webhook', { event: 'decision.clarify', decision_id: 'd1' })).json(), { status: 500 });
});

test('answering a task question on the board adds a human note that wakes the owner and removes the card', async () => {
  const e = setup({ webhook: false });
  addTask(e.db, { id: 'T1', title: 'Ship it', state: 'waiting_human' }, e.clock);
  addNote(e.db, { task: 'T1', author: 'planner', kind: 'question', body: 'Which database?' }, e.clock);
  const id = (await (await e.app.request('/__ab/board')).json()).decisions.find((x: any) => x.id.startsWith('task:T1:')).id;
  const r = await e.post('/__ab/webhook', { event: 'decision.answered', decision_id: id, answer: 'pg', answer_label: 'Postgres' });
  assert.equal(r.status, 200);
  const notes = e.db.prepare("SELECT author, kind, body FROM notes WHERE task_id = 'T1' AND author = 'human'").all();
  assert.deepEqual(notes.map((n) => ({ ...n })), [{ author: 'human', kind: 'answer', body: 'Postgres' }]);
  assert.equal((await (await e.app.request('/__ab/board')).json()).decisions.length, 0);
});

test('"Not relevant anymore" and priority: board-derived cards are handled in SQLite, ab cards go through ab', async () => {
  const e = setup();
  addTask(e.db, { id: 'T1', title: 'Ship it', state: 'waiting_human' }, e.clock);
  addNote(e.db, { task: 'T1', author: 'planner', kind: 'question', body: 'Which?' }, e.clock);
  const id = (await (await e.app.request('/__ab/board')).json()).decisions[0].id;
  assert.equal((await e.post('/__ab/priority', { id, priority: 'low' })).status, 200);
  assert.equal((await (await e.app.request('/__ab/board')).json()).decisions[0].priority, 'low');
  assert.equal((await e.post('/__ab/clear', { id })).status, 200);
  assert.equal((await (await e.app.request('/__ab/board')).json()).decisions.length, 0);
  assert.deepEqual(e.ab, []);
  assert.equal((await e.post('/__ab/priority', { id: 'plain', priority: 'high' })).status, 200);
  assert.equal((await e.post('/__ab/clear', { id: 'plain' })).status, 200);
  assert.deepEqual(e.ab, [['priority', 'plain', 'high'], ['clear', 'plain', '--reason', 'not relevant']]);
  assert.equal((await e.post('/__ab/priority', { id: 'plain', priority: 'urgent' })).status, 400);
  assert.equal((await e.post('/__ab/clear', {})).status, 400);
});

test('the delivery log keeps only known fields: no URL, auth value or message text', async () => {
  const e = setup();
  const ok = { event: 'item.message', message_id: 'm1', item_id: 'i', item_section: 'tickets', http: 200, via: 'fallback', attempt: 1, status: 'delivered', at: 'now', text: 'secret words', url: HOOK.url };
  assert.equal((await e.post('/__ab/delivery-log', ok)).status, 204);
  const row = (e.db.prepare('SELECT json FROM ui_delivery_log').get() as { json: string }).json;
  assert.doesNotMatch(row, /secret words|s3cr3t/);
  assert.equal((await e.post('/__ab/delivery-log', { ...ok, status: 'weird' })).status, 400);
  assert.equal(deliveryLogEntry('x'), null);
});

test('config and the built page: assistant name and time zone are injected, the red-dot favicons are served', async () => {
  const e = setup();
  assert.deepEqual(await (await e.app.request('/__ab/config')).json(), { assistantName: 'Helper', timeZone: 'UTC', webhookConfigured: true });
  const html = await (await e.app.request('/')).text();
  assert.match(html, /__AB_CONFIG__=\{"assistantName":"Helper"/);
  assert.match(await (await e.app.request('/favicon-needs.svg')).text(), /#e11d48/);
  assert.equal((await e.app.request('/../etc/passwd')).status, 404);
});

test('a cross-site write to the board routes is refused', async () => {
  const e = setup();
  const r = await e.app.request('/__ab/webhook', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Host: 'board.test', Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.equal(e.up.length, 0);
});

test('ab CLI: raise writes a decision card with options and a diagram into SQLite, the feed serves it, clear and restore round-trip', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-cli-'));
  const dbPath = join(dir, 'board.db');
  open(dbPath).close();
  const run = (...args: string[]) => execFileSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'ab.mjs'), ...args], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_NO_GH: '1' }, encoding: 'utf8' });
  run('raise', '--bot', 'Planner', JSON.stringify(card('planner-card-one', {
    context: 'The checkout page is slow because it loads every product image at full size before the page can be used.',
    question: 'Should we compress the images?', what_happens_after: 'The assistant starts compressing them.',
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    priority: 'medium',
    group: 'ROWS-5207',
    card_ref: 'https://linear.app/rows/issue/ROWS-5207/checkout-images',
  })));
  const db = open(dbPath);
  const e = env();
  const app = createApp(db, e.clock);
  const feed = await (await app.request('/__ab/board')).json();
  assert.equal(feed.decisions[0].id, 'planner-card-one');
  assert.match(feed.decisions[0].svg, /<svg/);
  run('clear', 'planner-card-one', '--reason', 'not relevant');
  assert.equal((await (await app.request('/__ab/board')).json()).decisions.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ui_tombstones').get()?.n, 1);
  run('restore', 'planner-card-one');
  assert.equal((await (await app.request('/__ab/board')).json()).decisions.length, 1);
});
