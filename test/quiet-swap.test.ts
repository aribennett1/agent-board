import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.ts';
import { applyQuietSwap, quietSwapBody, quietSwapText } from '../src/quiet-swap.ts';
import { slimPayload } from '../src/context.ts';

const LONG = [
  '`EmployeePosition` has an observer, so this `update()` runs its side effects, and the other `$secondaryPosition` changes in this file use `updateQuietly()` (lines 261, 1233, 1246). What do you think about `updateQuietly()` here too?',
  '',
  '```suggestion',
  "        $secondaryPosition->updateQuietly(['company_position_id' => CompanyPosition::factory()->createQuietly([",
  '```',
].join('\n');
const TRIMMED = ['`updateQuietly()`', '', '```suggestion', "        $secondaryPosition->updateQuietly(['company_position_id' => CompanyPosition::factory()->createQuietly([", '```'].join('\n');

test('a long quiet-swap body is cut to the method name and the suggestion block', () => {
  assert.equal(quietSwapBody(LONG), TRIMMED);
  assert.equal(quietSwapBody(TRIMMED), TRIMMED);
});

test('the method comes from the swapped call, not the first Quietly in the suggestion', () => {
  const body = 'This `save()` fires the observer; `saveQuietly()` skips it.\n\n```suggestion\n$a->createQuietly([]);\n$b->saveQuietly();\n```';
  assert.match(quietSwapBody(body)!, /^`saveQuietly\(\)`\n\n```suggestion/);
});

test('a short body with no suggestion block becomes just the method', () => {
  assert.equal(quietSwapBody('Use `deleteQuietly()` here, the observer would send an email.'), '`deleteQuietly()`');
});

test('applyQuietSwap also shortens the title', () => {
  const c = { title: 'A test uses `update()` on `EmployeePosition`, which has an observer', body: LONG };
  assert.equal(applyQuietSwap(c), true);
  assert.equal(c.title, 'Use `updateQuietly()`');
  assert.equal(c.body, TRIMMED);
});

test('comments that are not quiet swaps stay unchanged', () => {
  const plain = 'This guard misses the pending case. What do you think about checking it once in the service?\n\n```suggestion\n$x->update([]);\n```';
  const existing = 'The code here calls `saveQuietly()` already; what about the lock?\n\n```suggestion\n$row->lockForUpdate()->first();\n```';
  const manyBlocks = 'Use `saveQuietly()`.\n\n```suggestion\n$a->saveQuietly();\n```\n\nand\n\n```suggestion\n$b->saveQuietly();\n```';
  const longNoBlock = `Use \`saveQuietly()\` ${'x'.repeat(800)}`;
  for (const body of [plain, existing, manyBlocks, longNoBlock]) {
    assert.equal(quietSwapBody(body), null);
    assert.equal(quietSwapText(body), body);
    const c = { title: 'Keep me', body };
    assert.equal(applyQuietSwap(c), false);
    assert.deepEqual(c, { title: 'Keep me', body });
  }
});

test('the review.answer payload sent to the bot carries the trimmed body', () => {
  const sent = slimPayload({ event: 'review.answer', decision_id: 'd1', body: LONG, path: 'a.php', ignored: 1 }, 'QA');
  assert.equal(sent.body, TRIMMED);
  const other = slimPayload({ event: 'review.answer', decision_id: 'd1', body: 'Keep this.' }, 'QA');
  assert.equal(other.body, 'Keep this.');
});

const abRun = (dbPath: string, input: string, ...args: string[]) =>
  execFileSync(process.execPath, ['bin/ab.mjs', ...args], { input, env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_FILE: '' }, encoding: 'utf8' });

test('ab reviews stores a quiet-swap comment trimmed and leaves the others alone', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-quiet-')), 'board.db');
  open(dbPath).close();
  const review = {
    repo: 'app', pr: 7, verdict: '1 low', comments: [
      { id: 'c1', severity: 'low', title: 'A test uses `update()` on `EmployeePosition`', path: 'tests/a.php', line: 833, body: LONG, status: 'pending' },
      { id: 'c2', severity: 'low', title: 'Keep the title', path: 'app/b.php', line: 4, body: 'This misses a null check. What do you think about guarding it?', status: 'pending' },
    ],
  };
  abRun(dbPath, JSON.stringify([review]), 'reviews', '-');
  const row = open(dbPath).prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string };
  const [c1, c2] = JSON.parse(row.json).reviews[0].comments;
  assert.equal(c1.body, TRIMMED);
  assert.equal(c1.title, 'Use `updateQuietly()`');
  assert.equal(c2.body, review.comments[1].body);
  assert.equal(c2.title, 'Keep the title');
});
