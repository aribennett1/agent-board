import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addNote, addTask, checkin, runFailedWakes, runLiveness, runTick, runWake } from '../src/board.ts';
import { open } from '../src/db.ts';
import { env } from './helpers.ts';

const MIN = 60_000;

function woken() {
  const e = env();
  addTask(e.db, { id: 'T1', title: 't', state: 'building' }, e.clock);
  addNote(e.db, { task: 'T1', author: 'human', kind: 'answer', body: 'go' }, e.clock);
  assert.deepEqual(e.settle(), ['engineer']);
  return e;
}

test('8. missed check-in → one re-wake, then a no_checkin card, never a third wake', () => {
  const e = woken();
  e.advance(2 * MIN);
  const [re] = runLiveness(e.db, e.run);
  assert.equal(re.rewake_of, e.sent[0].id);
  assert.equal(re.reason, 'no_checkin');
  e.advance(2 * MIN);
  assert.deepEqual(runLiveness(e.db, e.run), []);
  assert.equal(e.cards('no_checkin').length, 1);
  e.advance(60 * MIN);
  assert.deepEqual(runLiveness(e.db, e.run), []);
  assert.equal(e.cards().length, 1);
  assert.equal(e.sent.length, 2);
});

test('8. checkin sets checkin_at on the latest open wake and writes a started note', () => {
  const e = woken();
  e.advance(MIN);
  assert.equal(checkin(e.db, 'T1', 'engineer', e.clock), e.sent[0].id);
  assert.equal(e.wakes()[0].checkin_at, new Date(e.clock.now()).toISOString());
  assert.ok(e.db.prepare(`SELECT 1 FROM notes WHERE kind = 'started' AND author = 'engineer'`).get());
  e.advance(5 * MIN);
  assert.deepEqual(runLiveness(e.db, e.run), []); // checked in, not stuck yet
});

test('8. checkin CLI against a tmp DB file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-board-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'board.db');
  const db = open(file);
  let now = Date.now();
  const clock = { now: () => new Date(now) };
  addTask(db, { id: 'T1', title: 't', state: 'building' }, clock);
  addNote(db, { task: 'T1', author: 'human', kind: 'answer', body: 'go' }, clock);
  now += 31_000;
  assert.equal(runWake(db, { ...clock, send: () => true }).length, 1);
  db.close();
  const out = execFileSync(process.execPath, ['bin/board.ts', 'checkin', 'T1', '--bot', 'engineer'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, AGENT_BOARD_DB: file }, encoding: 'utf8',
  });
  assert.match(out, /checked in to wake #1/);
  const db2 = open(file);
  t.after(() => db2.close());
  assert.ok((db2.prepare('SELECT checkin_at FROM wakes WHERE id = 1').get() as { checkin_at: string | null }).checkin_at);
});

test('9. stuck after check-in → one re-wake, then a stuck card', () => {
  const e = woken();
  checkin(e.db, 'T1', 'engineer', e.clock);
  e.advance(20 * MIN);
  const [re] = runLiveness(e.db, e.run);
  assert.equal(re.reason, 'stuck');
  assert.equal(e.wakes()[0].outcome, 'nothing');
  checkin(e.db, 'T1', 'engineer', e.clock);
  e.advance(20 * MIN);
  assert.deepEqual(runLiveness(e.db, e.run), []);
  assert.equal(e.cards('stuck').length, 1);
  assert.equal(e.sent.length, 2);
});

test('9. a note after check-in closes the wake with its outcome', () => {
  const e = woken();
  checkin(e.db, 'T1', 'engineer', e.clock);
  assert.equal(e.wakes()[0].done_at, null);
  e.advance(5 * MIN);
  addNote(e.db, { task: 'T1', author: 'engineer', kind: 'work', body: 'done' }, e.clock);
  assert.equal(e.wakes()[0].outcome, 'real_work');
  assert.ok(e.wakes()[0].done_at);

  addNote(e.db, { task: 'T1', author: 'human', kind: 'answer', body: 'one more' }, e.clock);
  assert.deepEqual(e.settle(), ['engineer']);
  checkin(e.db, 'T1', 'engineer', e.clock);
  addNote(e.db, { task: 'T1', author: 'engineer', kind: 'pass_through', body: 'forwarded' }, e.clock);
  assert.equal(e.wakes()[1].outcome, 'pass_through');
});

test('10. send failure → one wake_failed card', () => {
  const e = env();
  e.failSends();
  addTask(e.db, { id: 'T1', title: 't', state: 'building' }, e.clock);
  addNote(e.db, { task: 'T1', author: 'human', kind: 'answer', body: 'go' }, e.clock);
  e.settle();
  assert.equal(e.wakes()[0].send_ok, 0);
  runFailedWakes(e.db, e.clock);
  runFailedWakes(e.db, e.clock);
  assert.equal(e.cards('wake_failed').length, 1);
  e.advance(10 * MIN);
  assert.deepEqual(runLiveness(e.db, e.run), []); // a failed send is not re-woken by liveness
});

test('15. hourly tick runs wake + liveness + failed wakes and is idempotent', () => {
  const e = env();
  e.failSends((w) => w.task_id === 'T2');
  addTask(e.db, { id: 'T1', title: 't', state: 'building' }, e.clock);
  addTask(e.db, { id: 'T2', title: 't', state: 'qa_review' }, e.clock);
  addNote(e.db, { task: 'T1', author: 'human', kind: 'answer', body: 'go' }, e.clock);
  addNote(e.db, { task: 'T2', author: 'human', kind: 'answer', body: 'go' }, e.clock);
  e.advance(31_000);
  assert.deepEqual(runTick(e.db, e.run), { wakes: 2, rewakes: 0, cards: 1, mismatches: 0 });
  assert.deepEqual(runTick(e.db, e.run), { wakes: 0, rewakes: 0, cards: 0, mismatches: 0 });
  e.advance(3 * MIN);
  assert.deepEqual(runTick(e.db, e.run), { wakes: 0, rewakes: 1, cards: 0, mismatches: 0 });
  assert.deepEqual(runTick(e.db, e.run), { wakes: 0, rewakes: 0, cards: 0, mismatches: 0 });
  assert.equal(e.sent.length, 3);
});
