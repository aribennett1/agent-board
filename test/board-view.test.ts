import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.ts';
import { liveView, doneView } from '../src/board-view.ts';
import { env } from './helpers.ts';

// The live board sends only what Eric can see without opening Show done; done topics, PR descriptions and old
// versions come on demand. ?view=all stays the whole board for bin/ab.mjs.

const card = (id: string, extra: object = {}) => ({ id, title: id, context: 'ctx', question: `Q ${id}?`, what_happens_after: 'then', options: [{ id: 'a', label: 'A' }], created_at: '2026-11-26T09:00:00Z', ...extra });
const answered = (id: string, extra: object = {}) => card(id, { answer: { option_id: 'a', answer_label: 'A', answered_at: '2026-11-26T09:05:00Z' }, ...extra });
const pr = (n: number, extra: object = {}) => ({ repo: 'rows-backend', number: n, title: `PR ${n}`, link: `https://github.com/ROWSHR/rows-backend/pull/${n}`, author: 'sam', who: 'you', state: 'ready', ci: 'passing', body: `Long description ${n}`, unresolved: [{ author: 'sam', path: 'a.php', body: 'fix', url: 'u' }], unresolved_count: 1, ...extra });

const BOARD = {
  updated_at: '2026-11-26T10:00:00Z',
  decisions: [
    card('qa-open'),
    answered('qa-finished'),
    answered('planner-finished'),
    card('qa-gone', { superseded_by: 'qa-open' }),
  ],
  asks: [{ id: 'qa-finished:answer', at: '2026-11-26T09:05:00Z', item_key: 'decision:qa-finished', label: 'qa-finished', kind: 'answer', text: 'A' }],
  details: {
    'decision:qa-finished': { thread: [{ at: '2026-11-26T09:06:00Z', text: 'Done, thanks.' }] },
    'decision:qa-gone': { summary: 'old' },
    'ticket:ROWS-9': { plan: 'a plan nothing shows' },
  },
  reviews: [{ repo: 'rows-backend', pr: 7, comments: [] }, { repo: 'rows-backend', pr: 99, comments: [] }],
  glance: { waiting: [], tickets: [], others: [pr(7)], mine: [] },
};

function setup() {
  const e = env();
  const app = createApp(e.db, e.clock, { ui: { webhook: null, distDir: '/nonexistent', runAb: async () => ({ code: 0 }) } });
  const put = (doc: any) => {
    e.db.prepare('INSERT OR REPLACE INTO ui_doc (key, json, updated_at) VALUES (?, ?, ?)').run('board', JSON.stringify(doc), 'now');
    // My PRs and Others' PRs come from the server's own feed, not the board document.
    e.db.prepare('INSERT OR REPLACE INTO ui_feed (key, json, updated_at) VALUES (?, ?, ?)').run('feed', JSON.stringify({ tickets: [], mine: doc.glance.mine, others: doc.glance.others, github: { ok: true }, linear: { ok: true, configured: false } }), 'now');
  };
  const get = async (path: string) => (await app.request(path)).json() as Promise<any>;
  return { ...e, app, put, get };
}

test('the live board leaves out done topics, cards nothing shows, orphan details and reviews for PRs that left the tabs', () => {
  const v = liveView(BOARD);
  assert.deepEqual(v.decisions.map((d: any) => d.id), ['qa-open']);
  assert.deepEqual(v.asks, []);
  assert.deepEqual(Object.keys(v.details), []);
  assert.deepEqual(v.reviews.map((r: any) => r.pr), [7]);
  assert.deepEqual(v.done_summary, { total: 2, by_bot: { QA: 1, Planner: 1 } });
});

test('an answered card still being handled stays on the live board (In progress)', () => {
  const b = { ...BOARD, details: {}, asks: [{ id: 'qa-finished:answer', at: '2026-11-26T09:05:00Z', item_key: 'decision:qa-finished', label: 'qa-finished', kind: 'answer', text: 'A' }] };
  const v = liveView(b);
  assert.ok(v.decisions.some((d: any) => d.id === 'qa-finished'), 'his answer has no bot reply yet');
  assert.equal(v.asks.length, 1);
});

test('a PR row on the tabs is never hidden, even when its topic is done', () => {
  const b = { ...BOARD, asks: [{ id: 'n1', at: '2026-11-26T09:00:00Z', item_key: 'pr:rows-backend/7', label: 'PR 7', kind: 'note', text: 'ok' }], details: { 'pr:rows-backend/7': { thread: [{ at: '2026-11-26T09:01:00Z', text: 'Noted.' }] } } };
  const v = liveView(b);
  assert.equal(v.asks.length, 1);
  assert.ok(v.details['pr:rows-backend/7']);
});

test('an open card keeps the answer of an earlier card with the same question when that card is left out', () => {
  const b = { ...BOARD, decisions: [answered('qa-first', { question: 'Ship it?' }), card('qa-again', { question: 'Ship it?' })], asks: [], details: {} };
  const v = liveView(b);
  assert.deepEqual(v.decisions.map((d: any) => d.id), ['qa-again']);
  assert.equal(v.decisions[0].already_decided.answer, 'A');
});

test('done pages per bot carry everything their topics render, newest first', () => {
  const qa = doneView(BOARD, { bot: 'QA' });
  assert.deepEqual(qa.topics, ['decision:qa-finished']);
  assert.deepEqual(qa.decisions.map((d: any) => d.id), ['qa-finished']);
  assert.equal(qa.asks.length, 1);
  assert.ok(qa.details['decision:qa-finished']);
  const all = doneView(BOARD, { limit: 1 });
  assert.equal(all.total, 2);
  assert.equal(all.has_more, true);
  assert.equal(doneView(BOARD, { offset: 1, limit: 1 }).has_more, false);
});

test('GET /__ab/board is the live board; ?view=all is the whole one; /__ab/board/done pages the rest', async () => {
  const e = setup();
  e.put(BOARD);
  const live = await e.get('/__ab/board');
  assert.deepEqual(live.decisions.map((d: any) => d.id), ['qa-open']);
  assert.match(live.rev, /^[a-f0-9]{40}$/);
  const all = await e.get('/__ab/board?view=all');
  assert.equal(all.decisions.length, 4);
  assert.equal(all.glance.others[0].body, 'Long description 7');
  assert.equal(all.rev, undefined);
  const done = await e.get('/__ab/board/done?bot=Planner&offset=0&limit=5');
  assert.deepEqual(done.topics, ['decision:planner-finished']);
});

test('PR rows come without description and comments; /__ab/pr-detail sends them when a row opens', async () => {
  const e = setup();
  e.put(BOARD);
  const row = (await e.get('/__ab/board')).glance.others[0];
  assert.equal(row.body, undefined);
  assert.equal(row.unresolved, undefined);
  assert.equal(row.unresolved_count, 1);
  assert.equal(row.detail_deferred, true);
  const d = await e.get(`/__ab/pr-detail?link=${encodeURIComponent(row.link)}`);
  assert.equal(d.body, 'Long description 7');
  assert.equal(d.unresolved[0].body, 'fix');
  assert.equal((await e.app.request('/__ab/pr-detail?link=nope')).status, 404);
});

test('?since=<rev> sends only what changed, an empty change when nothing did, and the whole board for an unknown rev', async () => {
  const e = setup();
  e.put(BOARD);
  const first = await e.get('/__ab/board');
  const same = await e.get(`/__ab/board?since=${first.rev}`);
  assert.equal(same.delta, true);
  assert.deepEqual(same.set, {});
  assert.deepEqual(same.drop, []);
  e.put({ ...BOARD, decisions: [card('qa-open', { title: 'renamed' }), ...BOARD.decisions.slice(1), card('qa-new')] });
  const d = await e.get(`/__ab/board?since=${first.rev}`);
  assert.equal(d.delta, true);
  assert.equal(d.since, first.rev);
  assert.notEqual(d.version, first.rev);
  assert.deepEqual(Object.keys(d.set).sort(), ['decisions\u0001qa-new', 'decisions\u0001qa-open']);
  assert.deepEqual(d.order.decisions, ['qa-open', 'qa-new']);
  const unknown = await e.get('/__ab/board?since=deadbeef');
  assert.equal(unknown.delta, undefined);
  assert.equal(unknown.decisions.length, 2);
});
