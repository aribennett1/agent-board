import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addTask } from '../src/board.ts';
import { createApp } from '../src/server.ts';
import { makeNotify, type Fetch, type Payload } from '../src/webhook.ts';
import { env } from './helpers.ts';

const URL_SECRET = 'https://hooks.example.test/wake-s3cr3t-path';
const AUTH_SECRET = 'Bearer s3cr3t-token';

function setup() {
  const e = env();
  addTask(e.db, { id: 'T1', title: 'Ship it', state: 'waiting_human' }, e.clock);
  const calls: { url: string; headers: Record<string, string>; body: Payload }[] = [];
  let status = 200;
  const fetchImpl: Fetch = async (url, init) => (calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }), { ok: status < 400, status });
  const notify = makeNotify({ url: URL_SECRET, auth: AUTH_SECRET }, fetchImpl);
  const app = createApp(e.db, e.clock, { notify, assistantName: 'Helper' });
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Host: 'board.test', ...headers } });
  return { ...e, app, calls, post, failWith: (s: number) => void (status = s) };
}

test('every text field sends: an answer is stored and wakes the assistant through the webhook with the auth header', async () => {
  const e = setup();
  const r = await e.post('/api/tasks/T1/answer', { body: 'go with B' });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).webhook, 'sent');
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0].url, URL_SECRET);
  assert.equal(e.calls[0].headers.Authorization, AUTH_SECRET);
  assert.deepEqual([e.calls[0].body.event, e.calls[0].body.task_id, e.calls[0].body.text], ['task.answered', 'T1', 'go with B']);
});

test('a free-text message to the assistant reaches the webhook; failures and a disabled webhook are reported', async () => {
  const e = setup();
  const ok = await e.post('/api/tasks/T1/message', { text: 'explain this better' });
  assert.deepEqual(await ok.json(), { ok: true, webhook: 'sent' });
  assert.equal(e.calls[0].body.event, 'task.message');

  e.failWith(500);
  const bad = await e.post('/api/tasks/T1/message', { text: 'again' });
  assert.equal(bad.status, 502);
  assert.equal((await bad.json()).webhook, 'failed');

  const off = createApp(e.db, e.clock);
  const r = await off.request('/api/tasks/T1/message', { method: 'POST', body: JSON.stringify({ text: 'x' }) });
  assert.equal(r.status, 503);
  const a = await off.request('/api/tasks/T1/answer', { method: 'POST', body: JSON.stringify({ body: 'x' }) });
  assert.equal((await a.json()).webhook, 'disabled');
});

test('empty, oversized or unknown-task input is rejected and nothing is sent', async () => {
  const e = setup();
  assert.equal((await e.post('/api/tasks/T1/message', { text: '  ' })).status, 400);
  assert.equal((await e.post('/api/tasks/T1/message', { text: 'x'.repeat(20_001) })).status, 400);
  assert.equal((await e.post('/api/tasks/nope/message', { text: 'x' })).status, 404);
  assert.equal(e.calls.length, 0);
});

test('a network error from the webhook never throws and never leaks the URL or auth value', async () => {
  const notify = makeNotify({ url: URL_SECRET, auth: AUTH_SECRET }, async () => { throw new Error(`boom ${URL_SECRET}`); });
  assert.equal(await notify({ event: 'task.message', task_id: 'T1', text: 'x', sent_at: 'now' }), 'failed');
  const e = setup();
  const bodies = [
    await (await e.app.request('/api/config')).text(), await (await e.app.request('/api/tasks')).text(),
    await (await e.post('/api/tasks/T1/answer', { body: 'x' })).text(),
  ];
  for (const b of bodies) assert.doesNotMatch(b, /s3cr3t/);
});

test('a cross-site browser write is refused', async () => {
  const e = setup();
  const r = await e.post('/api/tasks/T1/answer', { body: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(e.calls.length, 0);
  const same = await e.post('/api/tasks/T1/answer', { body: 'y' }, { Origin: 'http://board.test' });
  assert.equal(same.status, 201);
});
