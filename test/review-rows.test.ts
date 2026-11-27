import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { backfillAnswers, hydrateRows, markAnswered, storeRows } from '../src/review-rows.ts';
import { env } from './helpers.ts';

const PATH = 'tests/Feature/Controllers/Api/Employees/EmployeeCompanyTerminationControllerTest.php';
const BODY = '`updateQuietly()`\n\n```suggestion\n        $secondaryPosition->updateQuietly([\n```';
const BODY2 = '`updateQuietly()`\n\n```suggestion\n        $replacementTermination->updateQuietly([]);\n```';
const URL = 'https://github.com/ROWSHR/rows-backend/pull/1994#discussion_r1';

// The #1994 shape before the fix: the Reviews-tab row (old head, line 833, pending) and QA's card (new head, 849, posted).
function board() {
  return {
    updated_at: 'x', asks: [],
    glance: { waiting: [], tickets: [], others: [], mine: [] },
    reviews: [{ repo: 'rows-backend', pr: 1994, verdict: '1 low to post; head da7e3d1cc', comments: [
      { id: 'c1', severity: 'medium', path: 'app/Services/EmployeeService.php', line: 459, body: 'What do you think about x?', status: 'posted' },
      { id: 'c3', severity: 'low', title: 'Use `updateQuietly()`', path: PATH, line: 833, context: 'Old story.', body: BODY, status: 'pending' },
    ] }],
    decisions: [{
      id: 'qa-1994-quiet-update', title: 'Quiet updates', group: '#1994', sha: '125a6ad13', card_ref: 'https://github.com/ROWSHR/rows-backend/pull/1994',
      question: 'Which updateQuietly() comments should be posted inline on #1994?', options: [],
      post_comments: [
        { label: '#1 c3', n: 1, path: PATH, line: 849, severity: 'low', context: 'New story.', body: BODY, status: 'posted', posted_url: URL },
        { label: '#2 c4', n: 2, path: PATH, line: 902, severity: 'low', context: 'New story.', body: BODY2, pending_bot: { at: '2026-11-27T19:15:30.218Z', note: 'still relevant?' } },
      ],
    }],
  } as Record<string, any>;
}
const row = (b: any, id: string) => b.reviews[0].comments.find((c: any) => c.id === id);
const card = (b: any) => b.decisions[0];

test('migration: the card finding and the Reviews-tab draft become one row; the card keeps only a reference', () => {
  const b = board();
  assert.deepEqual(storeRows(b), ['rows-backend#1994:c3', 'rows-backend#1994:c4']);
  assert.deepEqual(card(b).post_comments, [{ label: '#1 c3', n: 1, review: 'c3' }, { label: '#2 c4', n: 2, review: 'c4' }]);
  assert.equal(b.reviews[0].comments.length, 3, 'c4 is added once, nothing duplicated');
  assert.deepEqual({ ...row(b, 'c3') }, { id: 'c3', severity: 'low', title: 'Use `updateQuietly()`', path: PATH, line: 849, context: 'New story.', body: BODY, status: 'posted', url: URL, head: '125a6ad13' });
  assert.equal(row(b, 'c4').pending_bot.note, 'still relevant?');
  assert.equal(row(b, 'c4').head, '125a6ad13');
  // Idempotent.
  const again = JSON.stringify(b);
  hydrateRows(b); storeRows(b);
  assert.equal(JSON.stringify(b), again);
});

test('both views read the same row: a change on the row shows on the card, a change on the card lands on the row', () => {
  const b = board();
  storeRows(b);
  hydrateRows(b);
  const f = card(b).post_comments[1];
  assert.equal(f.body, row(b, 'c4').body);
  assert.equal(f.line, 902);
  // The bot marks the card finding skipped (ab review-status rows-backend#1994 2 skipped): the Reviews tab row closes.
  f.status = 'skipped'; f.note = 'Alex already switched it'; delete f.pending_bot;
  storeRows(b);
  assert.equal(row(b, 'c4').status, 'skipped');
  assert.equal(row(b, 'c4').note, 'Alex already switched it');
  assert.equal(row(b, 'c4').pending_bot, undefined);
  // A Reviews-tab write (row) shows on the card after the next read.
  row(b, 'c4').status = 'posted'; row(b, 'c4').url = URL;
  hydrateRows(b);
  assert.equal(card(b).post_comments[1].status, 'posted');
  assert.equal(card(b).post_comments[1].posted_url, URL);
});

test('Post on the card closes the Reviews-tab comment, and Skip on the Reviews tab closes the card finding', () => {
  const b = board();
  b.decisions[0].post_comments[0].status = undefined; delete b.decisions[0].post_comments[0].posted_url;
  storeRows(b); hydrateRows(b);
  assert.ok(markAnswered(b, { event: 'review.answer', card_id: 'qa-1994-quiet-update', finding: 1, comment_id: '1', action: 'post', answered_at: '2026-11-27T18:11:02.552Z' }));
  storeRows(b);
  assert.deepEqual(row(b, 'c3').answered, { at: '2026-11-27T18:11:02.552Z', action: 'post' });
  hydrateRows(b);
  assert.ok(markAnswered(b, { event: 'review.answer', repo: 'rows-backend', pr: 1994, comment_id: 'c4', action: 'skip', answered_at: '2026-11-27T18:12:00.000Z' }));
  storeRows(b); hydrateRows(b);
  assert.deepEqual(card(b).post_comments[1].answered, { at: '2026-11-27T18:12:00.000Z', action: 'skip' });
  assert.equal(card(b).post_comments[1].pending_bot, undefined);
});

test('a re-raise on a new head updates the existing row (line, head, context, body) instead of adding a copy', () => {
  const b = board();
  storeRows(b); hydrateRows(b);
  // QA re-raises a new card id after another push; c4 moved to line 910 and has a new body.
  b.decisions.push({ id: 'qa-1994-quiet-update-2', title: 'Quiet updates again', group: '#1994', sha: '853481ca5', card_ref: 'https://github.com/ROWSHR/rows-backend/pull/1994', question: 'Post?', options: [],
    post_comments: [{ label: '#1', n: 1, path: PATH, line: 910, severity: 'low', context: 'Re-checked at 853481ca5.', body: BODY2 + '\n' }] });
  storeRows(b);
  assert.equal(b.reviews[0].comments.length, 3);
  assert.deepEqual(b.decisions[1].post_comments, [{ label: '#1', n: 1, review: 'c4' }]);
  assert.equal(row(b, 'c4').line, 910);
  assert.equal(row(b, 'c4').head, '853481ca5');
  assert.equal(row(b, 'c4').context, 'Re-checked at 853481ca5.');
  // A posted row stays posted when a re-raise sends it as pending.
  hydrateRows(b);
  b.decisions.push({ id: 'qa-1994-3', title: 'x', group: '#1994', card_ref: 'https://github.com/ROWSHR/rows-backend/pull/1994', question: 'Post?', options: [], post_comments: [{ label: '#1 c3', n: 1, path: PATH, line: 850, body: BODY }] });
  storeRows(b);
  assert.equal(row(b, 'c3').status, 'posted');
  assert.equal(row(b, 'c3').line, 850);
});

test('a card on a PR with no drafted review keeps its findings inline (it is the only copy)', () => {
  const b = board();
  b.reviews = [];
  storeRows(b);
  assert.equal(card(b).post_comments[0].body, BODY);
  assert.equal(card(b).post_comments[0].review, undefined);
});

test('the board API serves the card finding and the Reviews-tab comment from the one stored row', async () => {
  const e = env();
  const b = board();
  storeRows(b);
  e.db.prepare("INSERT INTO ui_doc (key, json, updated_at) VALUES ('board', ?, 'now')").run(JSON.stringify(b));
  const app = createApp(e.db, e.clock, { ui: { webhook: { url: 'https://hooks.example.test/x', auth: 'Bearer x' }, fetchImpl: async () => ({ ok: true, status: 200 }), runAb: async () => ({ code: 0 }) } });
  const got = await (await app.request('/__ab/board?view=all')).json();
  const f = got.decisions.find((d: any) => d.id === 'qa-1994-quiet-update').post_comments[0];
  const r = got.reviews[0].comments.find((c: any) => c.id === 'c3');
  assert.equal(f.review, 'c3');
  assert.equal(f.status, r.status);
  assert.equal(f.posted_url, r.url);
  assert.equal(f.line, r.line);
  assert.equal(f.body, r.body);
});

test('ab: answering Post on the card closes the Reviews-tab comment, and review-status on either writes the one row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-rows-'));
  const dbPath = join(dir, 'board.db');
  const db0 = open(dbPath);
  const b = board();
  b.decisions[0].post_comments[0].status = 'pending'; delete b.decisions[0].post_comments[0].posted_url;
  db0.prepare("INSERT INTO ui_doc (key, json, updated_at) VALUES ('board', ?, 'now')").run(JSON.stringify(b));
  db0.close();
  const abEnv = { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_NO_GH: '1', AB_FILE: '' };
  const ab = (args: string[], input?: unknown) => execFileSync(process.execPath, ['bin/ab.mjs', ...args], { env: abEnv, encoding: 'utf8', ...(input ? { input: JSON.stringify(input) } : {}) });
  const stored = () => { const db = open(dbPath); const j = JSON.parse((db.prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string }).json); db.close(); return j; };
  ab(['ask', '-'], { event: 'review.answer', decision_id: 'qa-1994-quiet-update', card_id: 'qa-1994-quiet-update', finding: 1, repo: 'rows-backend', pr: 1994, comment_id: '1', action: 'post', path: PATH, line: 849, answered_at: '2026-11-27T18:11:02.552Z' });
  let s = stored();
  assert.deepEqual(s.decisions[0].post_comments[0], { label: '#1 c3', n: 1, review: 'c3' });
  assert.equal(s.reviews[0].comments.filter((c: any) => c.id === 'c3').length, 1);
  assert.equal(row(s, 'c3').answered.action, 'post');
  ab(['review-status', 'rows-backend#1994', '1', 'posted', '--url', URL]);
  s = stored();
  assert.equal(row(s, 'c3').status, 'posted');
  assert.equal(row(s, 'c3').url, URL);
  // The Reviews-tab id writes the same row; the card shows it.
  ab(['review-status', 'rows-backend#1994', 'c4', 'skipped', '--note', 'Alex already switched it']);
  s = stored();
  assert.equal(row(s, 'c4').status, 'skipped');
  assert.equal(hydrateRows(s).decisions[0].post_comments[1].status, 'skipped');
});

test('backfill: a Post he tapped on the card before rows kept answers closes the row on both views; a later note wins', () => {
  const b = board();
  b.decisions[0].post_comments[0].status = undefined; delete b.decisions[0].post_comments[0].posted_url;
  b.asks = [
    { id: 'qa-1994-quiet-update:1:post:2026-11-27T18:11:02.552Z', at: '2026-11-27T18:11:02.552Z', kind: 'review', ref: 'qa-1994-quiet-update:1', text: 'Finding #1 (x:849): Post' },
    { id: 'review:rows-backend#1994:c4:post:2026-11-27T18:00:00.000Z', at: '2026-11-27T18:00:00.000Z', kind: 'review', ref: 'rows-backend#1994:c4', text: 'Post to GitHub: c4' },
    { id: 'qa-1994-quiet-update:2:note:2026-11-27T19:15:30.218Z', at: '2026-11-27T19:15:30.218Z', kind: 'review', ref: 'qa-1994-quiet-update:2', text: 'Finding #2 (x:902): still relevant?' },
  ];
  storeRows(b); hydrateRows(b);
  assert.deepEqual(backfillAnswers(b), ['rows-backend#1994:c3']);
  storeRows(b);
  assert.equal(row(b, 'c3').answered.action, 'post');
  assert.equal(row(b, 'c4').answered, undefined);
  hydrateRows(b);
  assert.deepEqual(backfillAnswers(b), [], 'safe to rerun');
});
