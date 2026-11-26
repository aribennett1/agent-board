import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNote, addTask, ingest, runWake, setState } from '../src/board.ts';
import { env } from './helpers.ts';

test('1. human answer on a building task wakes engineer exactly once', () => {
  const e = env();
  addTask(e.db, { id: 'T1', title: 't', state: 'building' }, e.clock);
  addNote(e.db, { task: 'T1', author: 'human', kind: 'answer', body: 'use option B' }, e.clock);
  assert.deepEqual(e.settle(), ['engineer']);
  assert.deepEqual(e.settle(), []);
  assert.equal(e.sent.length, 1);
  assert.equal(e.sent[0].reason, 'human:note:answer');
});

test('2. state handoffs wake the next owner', () => {
  const e = env();
  addTask(e.db, { id: 'T1', title: 't', state: 'building' }, e.clock);
  setState(e.db, { task: 'T1', by: 'engineer', to: 'qa_review' }, e.clock);
  assert.deepEqual(e.settle(), ['qa']);
  addNote(e.db, { task: 'T1', author: 'qa', kind: 'review_changes', body: 'fix null check' }, e.clock);
  setState(e.db, { task: 'T1', by: 'qa', to: 'building' }, e.clock);
  assert.deepEqual(e.settle(), ['engineer']);
  assert.equal(e.wakes()[0].outcome, 'real_work');
});

test('5. debounce: 3 events within 30s → nothing before 30s, one wake after', () => {
  const e = env();
  addTask(e.db, { id: 'T1', title: 't', state: 'building' }, e.clock);
  for (let i = 0; i < 3; i++) {
    addNote(e.db, { task: 'T1', author: 'human', kind: 'answer', body: `answer ${i}` }, e.clock);
    e.advance(10_000);
  }
  e.advance(10_000); // newest event is 20s old
  assert.deepEqual(runWake(e.db, e.run), []);
  e.advance(11_000);
  assert.equal(runWake(e.db, e.run).length, 1);
  assert.equal(JSON.parse(e.wakes()[0].event_ids).length, 3);
  assert.deepEqual(e.settle(), []);
});

test('6. duplicate event dropped; event absorbed by an open wake', () => {
  const e = env();
  addTask(e.db, { id: 'T1', title: 't', state: 'building', pr: 7 }, e.clock);
  const ev = { task_id: 'T1', source: 'github', type: 'review_comment', dedup_key: 'github:abc' };
  assert.equal(ingest(e.db, ev, e.clock), true);
  assert.equal(ingest(e.db, ev, e.clock), false);
  assert.equal((e.db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n, 1);
  assert.deepEqual(e.settle(), ['engineer']);
  addNote(e.db, { task: 'T1', author: 'human', kind: 'answer', body: 'also this' }, e.clock);
  assert.deepEqual(e.settle(), []); // engineer's wake is still open
  assert.equal((e.db.prepare('SELECT count(*) AS n FROM events WHERE processed_at IS NULL').get() as { n: number }).n, 0);
});

test('7. no self-wake', () => {
  const e = env();
  addTask(e.db, { id: 'T1', title: 't', state: 'qa_review' }, e.clock);
  setState(e.db, { task: 'T1', by: 'engineer', to: 'building' }, e.clock);
  addNote(e.db, { task: 'T1', author: 'engineer', kind: 'info', body: 'pulling back to fix' }, e.clock);
  assert.deepEqual(e.settle(), []);
  addNote(e.db, { task: 'T1', author: 'engineer', kind: 'info', body: 'fyi' }, e.clock);
  assert.deepEqual(e.settle(), []);
});

function round(e: ReturnType<typeof env>, side: 'engineer' | 'planner', review: string, back: string) {
  setState(e.db, { task: 'T1', by: side, to: review }, e.clock);
  assert.deepEqual(e.settle(), ['qa']);
  addNote(e.db, { task: 'T1', author: 'qa', kind: 'review_changes', body: `changes in ${back}` }, e.clock);
  setState(e.db, { task: 'T1', by: 'qa', to: back }, e.clock);
}

test('12. hop limit engineer↔QA: 2 rounds per push, then a card for the human', () => {
  const e = env();
  addTask(e.db, { id: 'T1', title: 't', state: 'building', pr: 1 }, e.clock);
  addNote(e.db, { task: 'T1', author: 'engineer', kind: 'work', body: 'first diff' }, e.clock);
  round(e, 'engineer', 'qa_review', 'building');
  assert.deepEqual(e.settle(), ['engineer']);
  round(e, 'engineer', 'qa_review', 'building');
  assert.deepEqual(e.settle(), []);
  assert.equal(e.task('T1').state, 'waiting_human');
  const [card] = e.cards('hop_limit');
  assert.deepEqual(JSON.parse(card.body), { cycle: 1, rounds: 2, qa: 'changes in building', engineer: 'first diff' });
  assert.deepEqual(e.settle(), []); // the script's move to waiting_human wakes nobody
});

test('12. hop limit resets on a new push', () => {
  const e = env();
  addTask(e.db, { id: 'T1', title: 't', state: 'building', pr: 1 }, e.clock);
  round(e, 'engineer', 'qa_review', 'building');
  assert.deepEqual(e.settle(), ['engineer']);
  ingest(e.db, { task_id: 'T1', source: 'github', type: 'synchronize', dedup_key: 'push-2' }, e.clock);
  assert.equal(e.task('T1').cycle, 2);
  round(e, 'engineer', 'qa_review', 'building');
  assert.deepEqual(e.settle(), ['engineer']);
  assert.equal(e.cards().length, 0);
});

test('12. hop limit planner↔QA: 2 rounds per plan', () => {
  const e = env();
  addTask(e.db, { id: 'T1', title: 't', state: 'planning' }, e.clock);
  round(e, 'planner', 'plan_review', 'planning');
  assert.deepEqual(e.settle(), ['planner']);
  round(e, 'planner', 'plan_review', 'planning');
  assert.deepEqual(e.settle(), []);
  assert.equal(e.task('T1').state, 'waiting_human');
  assert.equal(e.cards('hop_limit').length, 1);
  assert.ok('planner' in JSON.parse(e.cards('hop_limit')[0].body));
});

test('12. The human overrides the cap after a hop-limit card', () => {
  const e = env();
  addTask(e.db, { id: 'T1', title: 't', state: 'building' }, e.clock);
  round(e, 'engineer', 'qa_review', 'building');
  e.settle();
  round(e, 'engineer', 'qa_review', 'building');
  e.settle();
  setState(e.db, { task: 'T1', by: 'human', to: 'building' }, e.clock);
  assert.deepEqual(e.settle(), ['engineer']);
});
