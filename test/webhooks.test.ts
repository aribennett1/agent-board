import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { addNote, addTask, setState } from '../src/board.ts';
import { createApp } from '../src/server.ts';
import { env } from './helpers.ts';

function setup(state = 'building') {
  const e = env();
  addTask(e.db, { id: 'T1', title: 't', state, pr: 42, ticket: 'PROJ-1' }, e.clock);
  const app = createApp(e.db, e.clock);
  const gh = (event: string, delivery: string, body: object, headers: Record<string, string> = {}) =>
    app.request('/webhooks/github', { method: 'POST', body: JSON.stringify(body), headers: { 'X-GitHub-Event': event, 'X-GitHub-Delivery': delivery, ...headers } });
  const failed = (delivery: string) => gh('check_run', delivery, { action: 'completed', check_run: { name: 'test', conclusion: 'failure', pull_requests: [{ number: 42 }] } });
  const push = (delivery: string, merge_only?: boolean) => gh('pull_request', delivery, { action: 'synchronize', number: 42, merge_only });
  return { ...e, app, gh, failed, push };
}

test('3. github review comment wakes the owner; same delivery twice → one event, one wake', async () => {
  const e = setup();
  const comment = { pull_request: { number: 42 }, comment: { user: { login: 'human' }, body: 'nit' } };
  const r1 = await e.gh('pull_request_review_comment', 'd1', comment);
  const r2 = await e.gh('pull_request_review_comment', 'd1', comment);
  assert.deepEqual(await r1.json(), { ok: true, duplicate: false });
  assert.deepEqual(await r2.json(), { ok: true, duplicate: true });
  assert.deepEqual(e.settle(), ['engineer']);
  assert.equal(e.sent[0].reason, 'github:review_comment');
});

test('3. bugbot comment wakes the owner', async () => {
  const e = setup();
  await e.gh('issue_comment', 'd1', { issue: { number: 42, pull_request: {} }, comment: { user: { login: 'cursor[bot]' } } });
  assert.deepEqual(e.settle(), ['engineer']);
  assert.equal(e.sent[0].reason, 'github:bugbot_comment');
});

test('3. first check failure is a script rerun, second in the same cycle wakes engineer', async () => {
  const e = setup();
  await e.failed('c1');
  assert.deepEqual(e.settle(), []);
  await e.failed('c2');
  assert.deepEqual(e.settle(), ['engineer']);
});

test('3. a new push resets the check-failure count', async () => {
  const e = setup();
  await e.failed('c1');
  e.settle();
  await e.push('p1');
  await e.failed('c2');
  assert.deepEqual(e.settle(), []);
});

test('3. merge-only push after a pass keeps the pass; a normal push bumps the cycle', async () => {
  const e = setup('qa_review');
  addNote(e.db, { task: 'T1', author: 'qa', kind: 'review_pass', body: 'lgtm' }, e.clock);
  setState(e.db, { task: 'T1', by: 'qa', to: 'waiting_human' }, e.clock);
  e.settle();
  await e.push('p1', true);
  assert.deepEqual(e.settle(), []);
  assert.equal(e.task('T1').cycle, 1);
  const pass = e.db.prepare(`SELECT 1 FROM notes WHERE task_id = 'T1' AND kind = 'review_pass' AND cycle = 1`).get();
  assert.ok(pass);
  await e.push('p2');
  assert.equal(e.task('T1').cycle, 2);
  assert.deepEqual(e.settle(), []); // a push alone only syncs status
});

test('3. unknown PR is ignored; missing delivery id or bad JSON is refused', async () => {
  const e = setup();
  assert.equal((await e.gh('pull_request_review_comment', 'd1', { pull_request: { number: 999 } })).status, 202);
  const bad = await e.app.request('/webhooks/github', { method: 'POST', body: '{', headers: { 'X-GitHub-Event': 'x', 'X-GitHub-Delivery': 'd' } });
  assert.equal(bad.status, 400);
  const noId = await e.app.request('/webhooks/github', { method: 'POST', body: '{}', headers: { 'X-GitHub-Event': 'x' } });
  assert.equal(noId.status, 400);
});

test('3. X-Hub-Signature-256 is checked when GITHUB_WEBHOOK_SECRET is set', async (t) => {
  process.env.GITHUB_WEBHOOK_SECRET = 's3cret';
  t.after(() => delete process.env.GITHUB_WEBHOOK_SECRET);
  const e = setup();
  const body = { pull_request: { number: 42 } };
  const sig = 'sha256=' + createHmac('sha256', 's3cret').update(JSON.stringify(body)).digest('hex');
  assert.equal((await e.gh('pull_request_review_comment', 'd1', body, { 'X-Hub-Signature-256': 'sha256=00' })).status, 401);
  assert.equal((await e.gh('pull_request_review_comment', 'd2', body)).status, 401);
  assert.equal((await e.gh('pull_request_review_comment', 'd3', body, { 'X-Hub-Signature-256': sig })).status, 200);
});

test('4. linear webhook is recorded for drift but wakes nobody', async () => {
  const e = setup();
  const body = { type: 'Issue', action: 'update', data: { identifier: 'PROJ-1', state: { name: 'In Review' }, labels: [{ name: 'bug' }] } };
  const r = await e.app.request('/webhooks/linear', { method: 'POST', body: JSON.stringify(body), headers: { 'Linear-Delivery': 'l1' } });
  assert.equal(r.status, 200);
  const ev = e.db.prepare(`SELECT * FROM events WHERE source = 'linear'`).get() as { type: string; payload: string };
  assert.equal(ev.type, 'Issue:update');
  assert.equal(JSON.parse(ev.payload).status, 'In Review');
  assert.deepEqual(e.settle(), []);
});

test('board API: task list, thread with latest view, human answer wakes owner', async () => {
  const e = setup();
  const n = addNote(e.db, { task: 'T1', author: 'engineer', kind: 'question', body: 'A or B?' }, e.clock);
  addNote(e.db, { task: 'T1', author: 'engineer', kind: 'question', body: 'A or B? (B is faster)', supersedes: n }, e.clock);
  const list = (await (await e.app.request('/api/tasks')).json()) as { id: string; owner: string }[];
  assert.deepEqual(list.map((t) => [t.id, t.owner]), [['T1', 'engineer']]);
  const one = (await (await e.app.request('/api/tasks/T1')).json()) as { notes: unknown[]; latest: { body: string }[] };
  assert.equal(one.notes.length, 2);
  assert.deepEqual(one.latest.map((x) => x.body), ['A or B? (B is faster)']);
  assert.equal((await e.app.request('/api/tasks/NOPE')).status, 404);
  const post = (body: unknown) => e.app.request('/api/tasks/T1/answer', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post({ body: '' })).status, 400);
  assert.equal((await post({ body: 'B' })).status, 201);
  assert.deepEqual(e.settle(), ['engineer']);
});
