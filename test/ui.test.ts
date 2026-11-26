import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { addTask } from '../src/board.ts';
import { createApp } from '../src/server.ts';
import { makeNotify, type Fetch, type Payload } from '../src/webhook.ts';
import { env } from './helpers.ts';
import { NEEDS_ICON, BASE_ICON, NEEDS_TITLE, BASE_TITLE, applyBadge, needsHuman } from '../public/badge.js';
import { attachMic, insertAt } from '../public/mic.js';

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

test('the board page serves the favicon link, the stylesheet and every script it imports', async () => {
  const { app } = setup();
  const html = await (await app.request('/')).text();
  assert.match(html, /<link rel="icon"[^>]*href="\/favicon\.svg"/);
  for (const path of ['/app.js', '/mic.js', '/badge.js', '/poll.js', '/render.js', '/styles.css', '/favicon.svg', '/favicon-needs.svg']) {
    const r = await app.request(path);
    assert.equal(r.status, 200, path);
  }
  assert.match((await app.request('/favicon-needs.svg')).headers.get('content-type')!, /image\/svg\+xml/);
  assert.match(await (await app.request('/favicon-needs.svg')).text(), /#e11d48/);
});

test('red dot: the badge shows while a task waits for the human and clears when none does', () => {
  assert.equal(needsHuman([]), false);
  assert.equal(needsHuman([{ owner: 'engineer', state: 'building', open_cards: 0 }]), false);
  assert.equal(needsHuman([{ owner: 'human', state: 'waiting_human', open_cards: 0 }]), true);
  assert.equal(needsHuman([{ owner: 'human', state: 'done', open_cards: 0 }]), false);
  assert.equal(needsHuman([{ owner: 'engineer', state: 'building', open_cards: 1 }]), true);
  const link = { href: BASE_ICON };
  const doc = { title: BASE_TITLE, querySelector: () => link } as unknown as Document;
  applyBadge(true, doc);
  assert.deepEqual([doc.title, link.href], [NEEDS_TITLE, NEEDS_ICON]);
  applyBadge(false, doc);
  assert.deepEqual([doc.title, link.href], [BASE_TITLE, BASE_ICON]);
});

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
    await (await e.app.request('/')).text(), await (await e.app.request('/app.js')).text(),
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

test('microphone: text is inserted at the cursor with sensible spacing', () => {
  assert.deepEqual(insertAt('hello world', 'big', 6, 6), { value: 'hello big world', caret: 9 });
  assert.deepEqual(insertAt('', ' hi ', 0, 0), { value: 'hi', caret: 2 });
  assert.deepEqual(insertAt('abc', 'x', 3, 3), { value: 'abc x', caret: 5 });
  assert.deepEqual(insertAt('a XX b', 'y', 2, 4), { value: 'a y b', caret: 3 });
});

type Listener = (e?: unknown) => void;
function fakeDom() {
  const mk = () => {
    const l: Record<string, Listener> = {};
    const cls = new Set<string>();
    return {
      className: '', innerHTML: '', title: '', type: '', attrs: {} as Record<string, string>, l,
      classList: { toggle: (c: string, on: boolean) => void (on ? cls.add(c) : cls.delete(c)), has: (c: string) => cls.has(c) },
      setAttribute(k: string, v: string) { this.attrs[k] = v; },
      addEventListener: (t: string, f: Listener) => void (l[t] = f),
    };
  };
  const after: ReturnType<typeof mk>[] = [];
  const doc = { createElement: mk, activeElement: null as unknown };
  const field = { ownerDocument: doc, value: '', selectionStart: 0, selectionEnd: 0, after: (n: ReturnType<typeof mk>) => void after.push(n), setSelectionRange(a: number, b: number) { this.selectionStart = a; this.selectionEnd = b; }, dispatchEvent: () => true };
  return { doc, field, after };
}

test('microphone: unsupported browsers get a hint and no button', () => {
  const { field, after } = fakeDom();
  assert.equal(attachMic(field as never, { Event } as never), null);
  assert.equal(after.length, 1);
  assert.match(after[0].title, /isn't supported/);
});

test('microphone: click starts listening (red), results fill the field without sending, click again stops', () => {
  const { field, after, doc } = fakeDom();
  let rec: any;
  class FakeRec {
    continuous = false; interimResults = false; lang = ''; started = false; stopped = false;
    onresult: ((e: unknown) => void) | null = null; onend: (() => void) | null = null; onerror: (() => void) | null = null;
    constructor() { rec = this; }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() {}
  }
  const btn = attachMic(field as never, { webkitSpeechRecognition: FakeRec, Event } as never) as any;
  assert.ok(btn);
  assert.equal(after[0], btn);
  btn.l.click();
  assert.ok(rec.started && rec.continuous && rec.interimResults);
  assert.ok(btn.classList.has('listening'));
  assert.equal(btn.attrs['aria-pressed'], 'true');

  field.value = 'please ';
  field.selectionStart = field.selectionEnd = 7;
  doc.activeElement = field;
  const result = (text: string, isFinal: boolean) => ({ resultIndex: 0, results: [Object.assign([{ transcript: text }], { isFinal })] });
  rec.onresult(result('ship', false));
  assert.equal(field.value, 'please ship');
  rec.onresult(result('ship it', true));
  assert.equal(field.value, 'please ship it');
  rec.onresult(result('now', true));
  assert.equal(field.value, 'please ship it now');

  btn.l.click();
  assert.ok(rec.stopped);
  assert.ok(!btn.classList.has('listening'));
  assert.equal(btn.attrs['aria-pressed'], 'false');
});
