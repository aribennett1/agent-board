import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open } from '../src/db.ts';
import { attentionOf, attentionPayload, watchAttention, ENGINEER_INSTRUCTION, GRACE_MS, type AttentionPayload } from '../src/attention.ts';

const pr = (number: number, extra: Record<string, any> = {}) => ({
  repo_full: 'ROWSHR/rows-backend', number, title: `PR ${number}`, link: `https://github.com/ROWSHR/rows-backend/pull/${number}`,
  state: 'ready', ci: 'passing', checks: { failing: [] }, unresolved: [], ...extra,
});
const failing = (n: number) => pr(n, { state: 'draft', ci: 'failing', checks: { failing: ['test'] } });
const T0 = new Date('2026-11-26T20:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);
const setBoard = (db: ReturnType<typeof open>, decisions: any[]) =>
  db.prepare("INSERT INTO ui_doc (key, json, updated_at) VALUES ('board', ?, 'x') ON CONFLICT(key) DO UPDATE SET json = excluded.json").run(JSON.stringify({ decisions }));
const notes = (db: ReturnType<typeof open>) => db.prepare('SELECT * FROM ui_notifications ORDER BY id').all() as Record<string, any>[];
const recorder = () => {
  const sent: AttentionPayload[] = [];
  const wake = async (p: AttentionPayload) => { sent.push(p); };
  return { sent, wake };
};

test('a PR that is fine, or only has bot threads, needs nothing', () => {
  assert.equal(attentionOf(pr(1)).sig, '');
  assert.equal(attentionOf(pr(1, { unresolved: [{ author: 'cursor' }, { author: 'claude' }, { author: 'x[bot]' }] })).sig, '');
});

test('changes requested, failing checks and a person\'s open thread each count, with plain reasons and a thread count for the wake', () => {
  const a = attentionOf(pr(1, { state: 'changes requested', ci: 'failing', checks: { failing: ['test'] }, unresolved: [{ author: 'alex' }, { author: 'alex' }, { author: 'cursor' }] }));
  assert.deepEqual(a.reasons, ['changes requested', 'failing checks (test)', 'open threads from alex']);
  assert.deepEqual(a.wakeReasons, ['changes requested', 'failing checks (test)', '1 open human thread']);
});

test('nothing is written until the PR has stayed uncovered for the grace period, then one notification links the PR', async () => {
  const db = open(':memory:');
  setBoard(db, []);
  assert.deepEqual(await watchAttention(db, [failing(2014)], T0), []);
  assert.deepEqual(await watchAttention(db, [failing(2014)], later(GRACE_MS - 1000)), []);
  assert.equal(notes(db).length, 0);
  assert.deepEqual(await watchAttention(db, [failing(2014)], later(GRACE_MS)), [2014]);
  assert.deepEqual(await watchAttention(db, [failing(2014)], later(GRACE_MS * 3)), []);
  const [n] = notes(db);
  assert.equal(notes(db).length, 1);
  assert.equal(n.bot, 'Grok Bot');
  assert.equal(n.link, 'https://github.com/ROWSHR/rows-backend/pull/2014');
  assert.match(n.text, /PR #2014/);
  assert.match(n.text, /failing checks \(test\)/);
});

test('an open card that names the PR covers it; a card for the same ticket but not the PR does not', async () => {
  const db = open(':memory:');
  const { sent, wake } = recorder();
  setBoard(db, [{ id: 'engineer-ticket-card', group: 'ROWS-6037', title: 'Ending a reapplied suspension', question: 'Should a manager end it?' }]);
  await watchAttention(db, [failing(2076)], T0, wake);
  assert.deepEqual(await watchAttention(db, [failing(2076)], later(GRACE_MS), wake), [2076]);
  assert.equal(sent.length, 1);
  for (const d of [{ id: 'a', group: 'PR #3001' }, { id: 'b', card_ref: 'https://github.com/ROWSHR/rows-backend/pull/3002' }, { id: 'c', group: 'pr:rows-backend/3003' }, { id: 'd', question: 'Push to #3004?' }]) {
    setBoard(db, [d]);
    const n = Number(/(\d{4})/.exec(JSON.stringify(d))![1]);
    const r = recorder();
    await watchAttention(db, [failing(n)], T0, r.wake);
    assert.deepEqual(await watchAttention(db, [failing(n)], later(GRACE_MS), r.wake), [], `${JSON.stringify(d)} should cover #${n}`);
    assert.equal(r.sent.length, 0, `${JSON.stringify(d)} should not wake Engineer`);
  }
  setBoard(db, [{ id: 'e', group: 'PR #30010' }]);
  const r = recorder();
  await watchAttention(db, [failing(3001)], T0, r.wake);
  assert.deepEqual(await watchAttention(db, [failing(3001)], later(GRACE_MS), r.wake), [3001], '#30010 must not cover #3001');
  assert.equal(r.sent.length, 1);
});

test('an answered card does not cover the PR', async () => {
  const db = open(':memory:');
  setBoard(db, [{ id: 'x', group: 'PR #2014', answer: { answer: 'ok' } }]);
  await watchAttention(db, [failing(2014)], T0);
  assert.deepEqual(await watchAttention(db, [failing(2014)], later(GRACE_MS)), [2014]);
});

test('the notification clears itself when a card appears, when the work is done, and when the PR closes', async () => {
  const db = open(':memory:');
  setBoard(db, []);
  const run = (mine: any[], t: number) => watchAttention(db, mine, later(t));
  await run([failing(1), failing(2), failing(3)], 0);
  await run([failing(1), failing(2), failing(3)], GRACE_MS);
  assert.equal(notes(db).filter((n) => !n.cleared_at).length, 3);
  setBoard(db, [{ id: 'c', group: 'PR #1' }]);
  await run([failing(1), pr(2), failing(3)], GRACE_MS + 1000);
  const open_ = notes(db).filter((n) => !n.cleared_at);
  assert.equal(open_.length, 1);
  assert.match(open_[0].text, /PR #3/);
  await run([failing(1), pr(2)], GRACE_MS + 2000);
  assert.equal(notes(db).filter((n) => !n.cleared_at).length, 0);
  assert.equal((db.prepare('SELECT count(*) c FROM pr_attention').get() as any).c, 0);
});

test('a PR whose reasons change is announced again after the grace period', async () => {
  const db = open(':memory:');
  setBoard(db, []);
  const { sent, wake } = recorder();
  await watchAttention(db, [failing(9)], T0, wake);
  await watchAttention(db, [failing(9)], later(GRACE_MS), wake);
  const worse = pr(9, { state: 'changes requested', ci: 'failing', checks: { failing: ['test'] } });
  assert.deepEqual(await watchAttention(db, [worse], later(GRACE_MS + 1000), wake), []);
  assert.deepEqual(await watchAttention(db, [worse], later(GRACE_MS * 2 + 1000), wake), [9]);
  const all = notes(db);
  assert.equal(all.length, 2);
  assert.ok(all[0].cleared_at && !all[1].cleared_at);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].reasons, ['failing checks (test)']);
  assert.deepEqual(sent[1].reasons, ['changes requested', 'failing checks (test)']);
});

test('after the grace period Engineer is woken once with a compact payload, and not again until the reasons change', async () => {
  const db = open(':memory:');
  setBoard(db, []);
  const { sent, wake } = recorder();
  const item = pr(1758, { state: 'changes requested', unresolved: [{ author: 'alex' }, { author: 'pat' }, { author: 'cursor' }] });
  await watchAttention(db, [item], T0, wake);
  assert.equal(sent.length, 0);
  assert.deepEqual(await watchAttention(db, [item], later(GRACE_MS), wake), [1758]);
  assert.deepEqual(await watchAttention(db, [item], later(GRACE_MS * 3), wake), []);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], attentionPayload(item, ['changes requested', '2 open human threads']));
  assert.equal(sent[0].read_more, 'ab context --bot Engineer');
  assert.equal(sent[0].instruction, ENGINEER_INSTRUCTION);
  assert.equal(sent[0].link, 'https://github.com/ROWSHR/rows-backend/pull/1758');
  assert.equal(sent[0].to_bot, 'Engineer');
});

test('a failed wake is retried on the next tick without a second notification', async () => {
  const db = open(':memory:');
  setBoard(db, []);
  const sent: AttentionPayload[] = [];
  let fail = true;
  const wake = async (p: AttentionPayload) => {
    if (fail) throw new Error('engineer webhook did not accept the wake');
    sent.push(p);
  };
  await watchAttention(db, [failing(2014)], T0, wake);
  assert.deepEqual(await watchAttention(db, [failing(2014)], later(GRACE_MS), wake), [2014]);
  assert.equal(sent.length, 0);
  assert.equal(notes(db).length, 1);
  fail = false;
  assert.deepEqual(await watchAttention(db, [failing(2014)], later(GRACE_MS + 1000), wake), []);
  assert.equal(sent.length, 1);
  assert.equal(notes(db).length, 1);
});
