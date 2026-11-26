import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNote, addTask, checkin, ingest, runDrift, runLiveness, setState } from '../src/board.ts';
import { weeklyReport } from '../src/report.ts';
import { T0, env } from './helpers.ts';

test('11. drift: mismatch → one card with all three values; match → none', () => {
  const e = env();
  addTask(e.db, { id: 'T1', title: 't', state: 'building' }, e.clock);
  const bad = { task: 'T1', linear: { status: 'Done', labels: [] }, github: { state: 'merged' } };
  assert.equal(runDrift(e.db, [bad], e.clock), 1);
  assert.deepEqual(JSON.parse(e.cards('drift')[0].body), { db_state: 'building', linear: 'Done', github: 'merged' });
  assert.equal(runDrift(e.db, [{ task: 'T1', linear: { status: 'In Progress' }, github: { state: 'draft' } }], e.clock), 0);
  runDrift(e.db, [bad], e.clock);
  assert.equal(e.cards('drift').length, 1);
  assert.equal((e.db.prepare('SELECT count(*) AS n FROM drift_checks').get() as { n: number }).n, 3);
  assert.throws(() => runDrift(e.db, [{ task: 'T1' } as never], e.clock), /bad drift row/);
});

test('13. notes are append-only; only the author may supersede', () => {
  const e = env();
  addTask(e.db, { id: 'T1', title: 't', state: 'building' }, e.clock);
  const n1 = addNote(e.db, { task: 'T1', author: 'engineer', kind: 'work', body: 'v1' }, e.clock);
  assert.throws(() => e.db.prepare(`UPDATE notes SET body = 'x' WHERE id = ?`).run(n1), /append-only/);
  assert.throws(() => e.db.prepare('DELETE FROM notes WHERE id = ?').run(n1), /append-only/);
  assert.throws(() => addNote(e.db, { task: 'T1', author: 'qa', kind: 'work', body: 'hijack', supersedes: n1 }, e.clock), /wrong author/);
  const n2 = addNote(e.db, { task: 'T1', author: 'engineer', kind: 'work', body: 'v2', supersedes: n1 }, e.clock);
  assert.deepEqual(e.db.prepare(`SELECT id, body FROM notes_latest WHERE task_id = 'T1'`).all().map((r) => ({ ...r })), [{ id: n2, body: 'v2' }]);
  assert.equal((e.db.prepare('SELECT body FROM notes WHERE id = ?').get(n1) as { body: string }).body, 'v1');
  assert.throws(() => addNote(e.db, { task: 'T1', author: 'mallory', kind: 'work', body: 'x' }, e.clock), /CHECK/);
});

test('14. weekly report: sections, hop-limit hits, top 3 traced to bot/trigger/task', () => {
  const e = env();
  const HOUR = 3600_000;
  addTask(e.db, { id: 'T1', title: 'login', ticket: 'PROJ-1', state: 'building' }, e.clock);
  addTask(e.db, { id: 'T2', title: 'export', ticket: 'PROJ-2', state: 'qa_review' }, e.clock);
  // T1: two review rounds → hop limit
  for (let i = 0; i < 2; i++) {
    e.advance(HOUR);
    setState(e.db, { task: 'T1', by: 'engineer', to: 'qa_review' }, e.clock);
    e.settle();
    checkin(e.db, 'T1', 'qa', e.clock);
    e.advance(15 * 60_000);
    addNote(e.db, { task: 'T1', author: 'qa', kind: 'review_changes', body: `round ${i}` }, e.clock);
    setState(e.db, { task: 'T1', by: 'qa', to: 'building' }, e.clock);
    e.settle();
    checkin(e.db, 'T1', 'engineer', e.clock);
  }
  // T2: QA never checks in → re-wake; then passes and merges
  addNote(e.db, { task: 'T2', author: 'human', kind: 'answer', body: 'ship it' }, e.clock);
  e.settle();
  e.advance(3 * 60_000);
  runLiveness(e.db, e.run);
  checkin(e.db, 'T2', 'qa', e.clock);
  addNote(e.db, { task: 'T2', author: 'qa', kind: 'review_pass', body: 'ok' }, e.clock);
  setState(e.db, { task: 'T2', by: 'human', to: 'merged' }, e.clock);
  ingest(e.db, { task_id: 'T2', source: 'linear', type: 'Issue:update', dedup_key: 'l1' }, e.clock);
  runDrift(e.db, [{ task: 'T2', linear: { status: 'In Progress' }, github: { state: 'merged' } }], e.clock);

  const md = weeklyReport(e.db, { since: new Date(T0 - 1).toISOString(), now: e.clock.now() });
  for (const h of ['## Time sinks', '### Wait time by state', '### Ticket to merge', '### Slowest wakes', '## Cost sinks',
    '### Wakes per task', '### Estimated tokens per bot', '### Outcome mix', '### Review rounds per task', '## Drift', '## Top 3 to optimize next']) {
    assert.ok(md.includes(h), `missing ${h}`);
  }
  assert.match(md, /Hop-limit hits: 1/);
  assert.match(md, /Re-wakes: 1/);
  assert.match(md, /Mismatches: 1 of 1 checks/);
  assert.match(md, /\| T2 \| PROJ-2 \|/);
  const top = md.split('## Top 3 to optimize next')[1].trim().split('\n');
  assert.equal(top.length, 3);
  for (const line of top) assert.match(line, /^\d\. .+: bot \S+, trigger \S+, task T\d$/);
});
