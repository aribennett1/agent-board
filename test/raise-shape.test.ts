import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.ts';

const ab = (dbPath: string, ...args: string[]) => {
  try {
    return { code: 0, out: JSON.parse(execFileSync(process.execPath, ['bin/ab.mjs', ...args], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_FILE: '' }, encoding: 'utf8' })), stderr: '' };
  } catch (err: any) {
    return { code: typeof err.status === 'number' ? err.status : 1, out: null, stderr: String(err.stderr ?? '') };
  }
};

const fresh = () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-shape-')), 'board.db');
  open(dbPath).close();
  return dbPath;
};

const valid = (extra: Record<string, unknown> = {}) => ({
  id: 'planner-shape-ok',
  title: 'Checkout image compression',
  context: 'The checkout page is slow because it loads every product image at full size before the page can be used.',
  question: 'Should we compress the images?',
  what_happens_after: 'The assistant starts compressing them.',
  options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'Hold' }],
  priority: 'medium',
  group: 'ROWS-5207',
  card_ref: 'https://linear.app/rows/issue/ROWS-5207/checkout-images',
  ...extra,
});

const boardIds = (dbPath: string) => {
  const row = open(dbPath).prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json?: string } | undefined;
  if (!row?.json) return [];
  return (JSON.parse(row.json).decisions as { id: string }[]).map((d) => d.id);
};

test('a complete raise with --bot writes the card', () => {
  const db = fresh();
  const r = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid()));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(boardIds(db), ['planner-shape-ok']);
});

test('raised_by in the JSON is accepted without --bot', () => {
  const db = fresh();
  const r = ab(db, 'raise', JSON.stringify(valid({ raised_by: 'QA', id: 'qa-shape-json' })));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(boardIds(db), ['qa-shape-json']);
});

test('svg is optional; a raise without it still succeeds', () => {
  const db = fresh();
  const card = valid({ id: 'planner-no-svg' });
  assert.equal('svg' in card, false);
  const r = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(card));
  assert.equal(r.code, 0, r.stderr);
});

test('a free-text card (allowCustom and no options) is allowed', () => {
  const db = fresh();
  const r = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid({ id: 'planner-freetext', options: [], allowCustom: true })));
  assert.equal(r.code, 0, r.stderr);
});

test('a PR group with a matching GitHub card_ref is allowed', () => {
  const db = fresh();
  const r = ab(db, 'raise', '--bot', 'Engineer', JSON.stringify(valid({
    id: 'engineer-pr-shape',
    group: 'rows-backend#2019',
    card_ref: 'https://github.com/ROWSHR/rows-backend/pull/2019',
  })));
  assert.equal(r.code, 0, r.stderr);
});

test('raise without --bot or raised_by exits 2 and leaves the board untouched', () => {
  const db = fresh();
  const r = ab(db, 'raise', JSON.stringify(valid()));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--bot/);
  assert.deepEqual(boardIds(db), []);
});

test('an unknown --bot name is refused and the board is untouched', () => {
  const db = fresh();
  const r = ab(db, 'raise', '--bot', 'ops', JSON.stringify(valid()));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--bot must be/);
  assert.deepEqual(boardIds(db), []);
});

test('id prefix must match the raising bot', () => {
  const db = fresh();
  const r = ab(db, 'raise', '--bot', 'QA', JSON.stringify(valid({ id: 'planner-wrong-prefix' })));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /id must start with qa-/);
  assert.deepEqual(boardIds(db), []);
});

test('what_happens_after is required, non-empty, and at least 4 plain words', () => {
  const db = fresh();
  for (const after of [undefined, '', '   ', 'Go.']) {
    const card = valid({ id: 'planner-after' });
    if (after === undefined) delete (card as any).what_happens_after;
    else (card as any).what_happens_after = after;
    const r = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(card));
    assert.equal(r.code, 2, String(after));
    assert.match(r.stderr, /what_happens_after/);
    assert.deepEqual(boardIds(db), []);
  }
});

test('options need at least two unique ids and none may be preselected', () => {
  const db = fresh();
  const one = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid({ id: 'planner-one-opt', options: [{ id: 'a', label: 'Yes' }] })));
  assert.equal(one.code, 2);
  assert.match(one.stderr, /at least two options/);
  const dup = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid({ id: 'planner-dup-opt', options: [{ id: 'a', label: 'Yes' }, { id: 'a', label: 'Hold' }] })));
  assert.equal(dup.code, 2);
  assert.match(dup.stderr, /unique id/);
  const pre = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid({ id: 'planner-pre', options: [{ id: 'a', label: 'Yes', selected: true }, { id: 'b', label: 'Hold' }] })));
  assert.equal(pre.code, 2);
  assert.match(pre.stderr, /preselected/);
  assert.deepEqual(boardIds(db), []);
});

test('group is required and must be a ticket key or a PR', () => {
  const db = fresh();
  for (const group of [undefined, '', 'dev-merge', 'PR #2019', 'pr:rows-backend/2019']) {
    const card = valid({ id: 'planner-group' });
    if (group === undefined) delete (card as any).group;
    else (card as any).group = group;
    const r = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(card));
    assert.equal(r.code, 2, String(group));
    assert.match(r.stderr, /group is required|group must be/);
    assert.deepEqual(boardIds(db), []);
  }
});

test('card_ref must be a Linear or GitHub URL that matches group', () => {
  const db = fresh();
  const missing = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid({ id: 'planner-nolink', card_ref: undefined })));
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /card_ref/);
  const wrongTicket = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid({ id: 'planner-wrong-ticket', card_ref: 'https://linear.app/rows/issue/ROWS-1/x' })));
  assert.equal(wrongTicket.code, 2);
  assert.match(wrongTicket.stderr, /must match group/);
  const notLinear = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid({ id: 'planner-not-linear', card_ref: 'https://github.com/ROWSHR/rows-backend/pull/1' })));
  assert.equal(notLinear.code, 2);
  assert.match(notLinear.stderr, /Linear URL/);
  const badPr = ab(db, 'raise', '--bot', 'Engineer', JSON.stringify(valid({
    id: 'engineer-bad-pr', group: 'rows-backend#2019', card_ref: 'https://github.com/ROWSHR/other/pull/2019',
  })));
  assert.equal(badPr.code, 2);
  assert.match(badPr.stderr, /repo must match group/);
  const wrongNum = ab(db, 'raise', '--bot', 'Engineer', JSON.stringify(valid({
    id: 'engineer-wrong-num', group: '#2019', card_ref: 'https://github.com/ROWSHR/rows-backend/pull/12',
  })));
  assert.equal(wrongNum.code, 2);
  assert.match(wrongNum.stderr, /PR number must match/);
  assert.deepEqual(boardIds(db), []);
});

test('priority is required and must be high, medium or low', () => {
  const db = fresh();
  const missing = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(((c) => { delete (c as any).priority; return c; })(valid({ id: 'planner-noprio' }))));
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /priority is required/);
  const bad = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid({ id: 'planner-badprio', priority: 'urgent' })));
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /priority/);
  assert.deepEqual(boardIds(db), []);
});

test('unknown fields are rejected and the board is untouched', () => {
  const db = fresh();
  const r = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid({ id: 'planner-unknown', mystery: true })));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown field/);
  assert.deepEqual(boardIds(db), []);
});

test('a re-raise without --bot keeps the stored author, but still has to pass the other checks', () => {
  const db = fresh();
  assert.equal(ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid())).code, 0);
  const ok = ab(db, 'raise', JSON.stringify(valid({ context: 'The checkout page is still slow because full-size images load before the page can be used.' })));
  assert.equal(ok.code, 0, ok.stderr);
  const row = JSON.parse((open(db).prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string }).json);
  assert.equal(row.decisions[0].raised_by, 'Planner');
  const badGroup = ab(db, 'raise', JSON.stringify(valid({ question: 'Should we compress the images now?', group: 'dev-merge' })));
  assert.equal(badGroup.code, 2);
  assert.match(badGroup.stderr, /group is required|group must be/);
  const noPrio = ab(db, 'raise', JSON.stringify(((c) => { delete (c as any).priority; return c; })(valid({ question: 'Compress the images today?' }))));
  assert.equal(noPrio.code, 2);
  assert.match(noPrio.stderr, /priority is required/);
  assert.equal(JSON.parse((open(db).prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string }).json).decisions[0].question, 'Should we compress the images?');
});
