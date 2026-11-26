import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNote, addTask } from '../src/board.ts';
import { boardVersion } from '../src/version.ts';
import { createApp } from '../src/server.ts';
import { env } from './helpers.ts';
import { VERSION_RE, startBoard, versionInfo, withScroll } from '../public/poll.js';
import { applyBadge, BASE_ICON, BASE_TITLE, NEEDS_ICON, NEEDS_TITLE, needsHuman } from '../public/badge.js';
import { renderList } from '../public/render.js';

function setup(state = 'waiting_human') {
  const e = env();
  addTask(e.db, { id: 'T1', title: 'Ship it', state }, e.clock);
  const app = createApp(e.db, e.clock);
  return { ...e, app };
}

test('GET /api/version returns a 64-char hash that stays put until content changes', async () => {
  const e = setup();
  const r1 = await e.app.request('/api/version');
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('cache-control'), 'no-store');
  const a = await r1.json();
  assert.match(a.version, VERSION_RE);
  assert.equal(a.version, boardVersion(e.db));
  assert.equal((await (await e.app.request('/api/version')).json()).version, a.version);
  addNote(e.db, { task: 'T1', author: 'human', kind: 'answer', body: 'go' }, e.clock);
  const b = (await (await e.app.request('/api/version')).json()).version;
  assert.match(b, VERSION_RE);
  assert.notEqual(b, a.version);
});

test('versionInfo uses cache:no-store and a check timestamp, and rejects a bad hash', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = 'a'.repeat(64);
  const fetchImpl = async (url: string, init: RequestInit) => (calls.push({ url, init }), { ok: true, json: async () => ({ version: ok }) });
  const info = await versionInfo(fetchImpl as never, '/api/version');
  assert.equal(info.version, ok);
  assert.match(calls[0].url, /\/api\/version\?check=\d+$/);
  assert.equal(calls[0].init.cache, 'no-store');
  assert.ok(calls[0].init.signal);

  const bad = async () => ({ ok: true, json: async () => ({ version: 'not-a-hash' }) });
  await assert.rejects(() => versionInfo(bad as never), /Invalid board version/);
  const fail = async () => ({ ok: false, json: async () => ({}) });
  await assert.rejects(() => versionInfo(fail as never), /Version check failed/);
});

function fakeDoc() {
  const listeners: Record<string, () => void> = {};
  return {
    hidden: false,
    addEventListener(type: string, fn: () => void) { listeners[type] = fn; },
    removeEventListener(type: string, fn: () => void) { if (listeners[type] === fn) delete listeners[type]; },
    dispatchEvent(e: { type: string }) { listeners[e.type]?.(); },
    has: (type: string) => Boolean(listeners[type]),
  };
}

function fakeTimers() {
  let id = 0;
  const timers = new Map<number, () => void>();
  return {
    setInterval(fn: () => void) { const i = ++id; timers.set(i, fn); return i; },
    clearInterval(i: number) { timers.delete(i); },
    tick() { for (const fn of [...timers.values()]) fn(); },
    count: () => timers.size,
  };
}

function flush() {
  return new Promise((r) => setImmediate(r));
}

async function settle() {
  for (let i = 0; i < 8; i++) await flush();
}

type BoardData = { tasks: { owner: string; state: string; open_cards: number }[] };

function harness(version: string) {
  let current = version;
  let checks = 0;
  let loads = 0;
  let applies = 0;
  let idle = true;
  const applied: BoardData[] = [];
  const waits: Array<() => void> = [];
  const doc = fakeDoc();
  const timers = fakeTimers();
  const fetchImpl = async (url: string) => {
    if (!String(url).includes('/api/version')) throw new Error(`unexpected ${url}`);
    checks++;
    return { ok: true, json: async () => ({ version: current }) };
  };
  const board = startBoard({
    fetchImpl: fetchImpl as never,
    document: doc as never,
    setIntervalFn: timers.setInterval as never,
    clearIntervalFn: timers.clearInterval as never,
    isIdle: () => idle,
    wait: () => new Promise<void>((r) => waits.push(r)),
    load: async () => (loads++, { tasks: [{ owner: 'human', state: 'waiting_human', open_cards: 0 }] }),
    apply: (data: BoardData) => {
      applies++;
      applied.push(data);
      const link = { href: BASE_ICON };
      applyBadge(needsHuman(data.tasks), { title: BASE_TITLE, querySelector: () => link } as unknown as Document);
    },
  });
  return {
    board, doc, timers,
    get checks() { return checks; },
    get loads() { return loads; },
    get applies() { return applies; },
    get applied() { return applied; },
    get waits() { return waits; },
    setVersion: (v: string) => void (current = v),
    setIdle: (v: boolean) => void (idle = v),
    release: () => { for (const r of waits.splice(0)) r(); },
  };
}

test('same version avoids reload; timer and visibility trigger checks', async () => {
  const h = harness('a'.repeat(64));
  await h.board.start();
  assert.equal(h.checks, 1);
  assert.equal(h.loads, 1);
  assert.equal(h.applies, 1);

  h.timers.tick();
  await settle();
  assert.equal(h.checks, 2);
  assert.equal(h.loads, 1);
  assert.equal(h.applies, 1);

  await new Promise((r) => {
    const id = setInterval(() => { if (!h.board.state.busy) { clearInterval(id); r(null); } }, 1);
  });

  h.doc.hidden = true;
  h.doc.dispatchEvent({ type: 'visibilitychange' });
  await settle();
  assert.equal(h.checks, 2);

  h.doc.hidden = false;
  h.doc.dispatchEvent({ type: 'visibilitychange' });
  await settle();
  assert.equal(h.checks, 3);
  assert.equal(h.loads, 1);

  h.board.destroy();
  h.timers.tick();
  await settle();
  assert.equal(h.checks, 3);
  assert.equal(h.timers.count(), 0);
  assert.equal(h.doc.has('visibilitychange'), false);
});

test('a new hash fetches data, swaps only then, and updates the red-dot badge from the same poll', async () => {
  const h = harness('a'.repeat(64));
  await h.board.start();
  const link = { href: BASE_ICON };
  const doc = { title: BASE_TITLE, querySelector: () => link } as unknown as Document;
  applyBadge(needsHuman(h.applied[0].tasks), doc);
  assert.deepEqual([doc.title, link.href], [NEEDS_TITLE, NEEDS_ICON]);

  h.setVersion('b'.repeat(64));
  h.timers.tick();
  await settle();
  assert.equal(h.checks, 2);
  assert.equal(h.loads, 2);
  assert.equal(h.applies, 2);
  assert.equal(h.board.state.version, 'b'.repeat(64));
});

test('a busy flag keeps checks from overlapping', async () => {
  let release!: (v: { ok: boolean; json: () => Promise<{ version: string }> }) => void;
  let checks = 0;
  const doc = fakeDoc();
  const board = startBoard({
    document: doc as never,
    setIntervalFn: (() => 1) as never,
    clearIntervalFn: (() => undefined) as never,
    fetchImpl: (async () => (checks++, new Promise((r) => { release = r; }))) as never,
    load: async () => ({ tasks: [] }),
    apply: () => undefined,
  });
  const first = board.checkVersion();
  await settle();
  const second = board.checkVersion();
  await second;
  assert.equal(checks, 1);
  release({ ok: true, json: async () => ({ version: 'a'.repeat(64) }) });
  await first;
  assert.equal(checks, 1);
  board.destroy();
});

test('checks wait for idle: a draft or a live mic blocks the swap, then it applies once idle', async () => {
  const h = harness('a'.repeat(64));
  await h.board.start();
  h.setIdle(false);
  h.setVersion('b'.repeat(64));
  const pending = h.board.checkVersion();
  await settle();
  assert.equal(h.loads, 1);
  assert.equal(h.applies, 1);
  h.setIdle(true);
  h.release();
  await pending;
  assert.equal(h.loads, 2);
  assert.equal(h.applies, 2);
});

test('failed version check leaves the current view alone', async () => {
  const h = harness('a'.repeat(64));
  await h.board.start();
  h.setVersion('nope');
  h.timers.tick();
  await settle();
  assert.equal(h.loads, 1);
  assert.equal(h.applies, 1);
  assert.equal(h.board.state.version, 'a'.repeat(64));
});

test('withScroll restores the window and overflow regions after a swap', () => {
  const region = { scrollTop: 80 };
  const root = {
    scrollY: 40,
    scrolledTo: -1,
    scrollTo(_x: number, y: number) { this.scrolledTo = y; },
    querySelectorAll: () => [region],
  };
  region.scrollTop = 99;
  withScroll(root as never, () => { region.scrollTop = 0; root.scrollY = 0; });
  assert.equal(root.scrolledTo, 40);
  assert.equal(region.scrollTop, 99);
});

test('renderList updates only a changed row and leaves the others in place', () => {
  const el = (tag: string) => {
    const n: any = { tag, textContent: '', className: '', dataset: {}, children: [] as any[], listeners: [] as any[] };
    n.querySelectorAll = (sel: string) => (sel === 'button.task' ? n.children.filter((c: any) => String(c.className).includes('task')) : []);
    n.replaceChildren = (...kids: any[]) => { n.children = kids; };
    n.insertBefore = (node: any, at: any) => {
      const i = at ? n.children.indexOf(at) : n.children.length;
      const from = n.children.indexOf(node);
      if (from >= 0) n.children.splice(from, 1);
      n.children.splice(i < 0 ? n.children.length : i, 0, node);
    };
    n.addEventListener = (t: string, f: () => void) => n.listeners.push([t, f]);
    n.remove = () => { const i = n.parent?.children.indexOf(n); if (i >= 0) n.parent.children.splice(i, 1); };
    Object.defineProperty(n, 'parent', { value: undefined, writable: true });
    return n;
  };
  const list = el('section');
  const origInsert = list.insertBefore;
  list.insertBefore = (node: any, at: any) => { node.parent = list; origInsert(node, at); };

  const tasks = [
    { id: 'A', title: 'One', state: 'building', owner: 'engineer', open_cards: 0 },
    { id: 'B', title: 'Two', state: 'waiting_human', owner: 'human', open_cards: 0 },
  ];
  renderList(tasks, list, () => undefined, undefined, el);
  const first = list.children[0];
  const second = list.children[1];
  assert.equal(first.textContent, 'One (building)');
  assert.match(second.className, /needs/);

  renderList([
    { ...tasks[0], title: 'One', state: 'qa_review', owner: 'qa', open_cards: 0 },
    tasks[1],
  ], list, () => undefined, undefined, el);
  assert.equal(list.children[0], first);
  assert.equal(list.children[1], second);
  assert.equal(first.textContent, 'One (qa_review)');
  assert.equal(second.textContent, 'Two (waiting_human)');
});
