import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.ts';
import { contextInBodyError, missingContext, postableBody, recoverBoardContext, splitAtAsk, splitBoardContext, splitContext } from '../src/comment-context.ts';
import { slimPayload } from '../src/context.ts';

// The #2004 draft Eric posted with the whole story on Nov 27 2026 (shortened code, same shape).
const ASK = "What do you think about making the job's constructor arguments `public readonly` promoted properties? That way we could drop the reflection.\n\n```suggestion\nBus::assertDispatched(SendEmailJob::class, fn ($job) => $job->subject === 'Retry Subject');\n```";
const STORY = "**What this PR adds.** [ROWS-5945](https://linear.app/rows/issue/ROWS-5945) lets a recruiter retry an email that failed to send.\n\n**Where this test comes in.** This test reads protected properties by reflection:\n\n```php\n$read = fn (string $p) => (new \\ReflectionProperty($job, $p))->getValue($job);\n```\n\n**The gap.** The pre-push check fails any `ReflectionProperty` on an `App\\` class.\n\n```text\njob (protected props)  --reflection-->  test\n```";
const FULL = `${STORY}\n\n${ASK}\n`;

const ab = (dbPath: string, ...args: string[]) => {
  try {
    return { code: 0, out: JSON.parse(execFileSync(process.execPath, ['bin/ab.mjs', ...args], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_NO_GH: '1', AB_FILE: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })), stderr: '' };
  } catch (err: any) {
    return { code: typeof err.status === 'number' ? err.status : 1, out: null, stderr: String(err.stderr ?? '') };
  }
};
const fresh = () => { const p = join(mkdtempSync(join(tmpdir(), 'ab-ctx-')), 'board.db'); open(p).close(); return p; };
const boardOf = (dbPath: string) => JSON.parse((open(dbPath).prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string }).json);
const review = (c: object) => JSON.stringify([{ repo: 'rows-backend', pr: 2004, verdict: 'One finding.', comments: [{ id: 'c1', severity: 'medium', path: 'tests/A.php', line: 10, status: 'pending', context: 'Story for Eric.', ...c }] }]);
const card = (c: object) => JSON.stringify({
  id: 'qa-review-2004', title: 'Review of the email retry PR',
  context: 'QA found one thing to post on the pull request about how the retry test reads the queued job.',
  question: 'Which of these comments should be posted?', what_happens_after: 'The ones you post go to GitHub.',
  options: [], group: 'rows-backend#2004', card_ref: 'https://github.com/ROWSHR/rows-backend/pull/2004', priority: 'medium',
  post_comments: [{ n: 1, label: '#1 reflection in tests', path: 'tests/A.php', line: 10, severity: 'medium', context: 'Story for Eric.', ...c }],
});

test('the #2004 body splits into the story and the ask; the ask is what gets posted', () => {
  const s = splitContext(FULL)!;
  assert.ok(s.context.startsWith('**What this PR adds.**'));
  assert.ok(s.context.includes('**The gap.**') && s.context.includes('```text'));
  assert.equal(s.body, ASK);
  assert.equal(postableBody(FULL), ASK);
  assert.equal(contextInBodyError(s.body), null);
});

test('context labels are refused in a body, bold or plain, and at any paragraph', () => {
  for (const body of [FULL, 'What this PR adds: a retry.\n\nWhat do you think?', 'Where this guard comes in. It runs first.\n\nWhat do you think?', 'Short note.\n\n**The gap:** none.', '### How retry works\n\nIt flips the status.', '**The feature today.** Employees pick plans.']) {
    assert.match(contextInBodyError(body) ?? '', /context/, body);
  }
});

test('a clean ask passes, including "the gap" in a sentence and labels inside code fences', () => {
  assert.equal(contextInBodyError(ASK), null);
  assert.equal(contextInBodyError('The gap between the two queries is small. What do you think about one query?'), null);
  assert.equal(contextInBodyError('What do you think about this?\n\n```text\n**The gap.** inside a fence\n```'), null);
  assert.equal(contextInBodyError('Today this returns 422. What do you think about 409?'), null);
});

test('a story under a plain lead-in, an "**The ask**" label and a "Can you" ask still split cleanly', () => {
  const s = splitContext('Some context first.\n\n**The gap**\nNothing stops it.\n\n**The ask**\nCan you please ask AI to try the testing skill?\n')!;
  assert.equal(s.body, 'Can you please ask AI to try the testing skill?');
  assert.equal(s.context, 'Some context first.\n\n**The gap**\nNothing stops it.');
  assert.match(contextInBodyError('**The question**\nWhat do you think about 409?') ?? '', /The question/);
});

test('no split when there is no ask, no leading story, or a story after the ask', () => {
  assert.equal(splitContext('**The gap.** Nothing stops it.'), null);
  assert.equal(splitContext(ASK), null);
  assert.equal(splitContext('**The gap.** x\n\nWhat do you think?\n\n**The gap.** again'), null);
  assert.equal(postableBody('**The gap.** Nothing stops it.'), '**The gap.** Nothing stops it.');
});

test('a review.answer webhook carries only the postable body', () => {
  const out = slimPayload({ event: 'review.answer', decision_id: 'review:rows-backend#2004:c1', repo: 'rows-backend', pr: 2004, comment_id: 'c1', action: 'post', body: FULL, answered_at: '2026-11-27T14:00:00Z' }, 'QA');
  assert.equal(out.body, ASK);
});

test('splitBoardContext moves open drafts only and is safe to rerun', () => {
  const b = {
    reviews: [{ repo: 'rows-backend', pr: 2004, comments: [{ id: 'c1', status: 'pending', body: FULL }, { id: 'c2', status: 'posted', body: FULL }] }],
    decisions: [{ id: 'qa-x', post_comments: [{ n: 1, body: FULL, context: 'Earlier note.' }, { n: 2, status: 'skipped', body: FULL }] }],
  };
  assert.deepEqual(splitBoardContext(b), ['review:rows-backend#2004:c1', 'qa-x:1']);
  assert.equal(b.reviews[0].comments[0].body, ASK);
  assert.equal(b.reviews[0].comments[1].body, FULL);
  assert.ok((b.decisions[0].post_comments[0] as any).context.startsWith('Earlier note.\n\n**What this PR adds.**'));
  assert.equal(b.decisions[0].post_comments[1].body, FULL);
  assert.deepEqual(splitBoardContext(b), []);
});

test('ab reviews refuses a pending body with the story and stores context separately when split', () => {
  const db = fresh();
  const bad = ab(db, 'reviews', review({ body: FULL }), '--no-gh');
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /What this PR adds[\s\S]*"context" field/);
  const s = splitContext(FULL)!;
  const ok = ab(db, 'reviews', review({ body: s.body, context: s.context }), '--no-gh');
  assert.equal(ok.code, 0, ok.stderr);
  const c = boardOf(db).reviews[0].comments[0];
  assert.equal(c.body, ASK);
  assert.equal(c.context, s.context);
  // An already-posted comment keeps whatever text went out.
  assert.equal(ab(db, 'reviews', review({ body: FULL, status: 'posted' }), '--no-gh').code, 0);
});

test('ab raise refuses post_comments whose body carries the story; context per finding is accepted', () => {
  const db = fresh();
  const bad = ab(db, 'raise', '--bot', 'QA', card({ body: FULL }));
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /post_comments\[0\]\.body opens a context section/);
  const s = splitContext(FULL)!;
  const ok = ab(db, 'raise', '--bot', 'QA', card({ body: s.body, context: s.context }));
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(boardOf(db).decisions[0].post_comments[0].context, s.context);
});

test('ab review-status refuses a --body with the story and sets --context', () => {
  const db = fresh();
  assert.equal(ab(db, 'reviews', review({ body: ASK }), '--no-gh').code, 0);
  const bad = ab(db, 'review-status', 'rows-backend#2004', 'c1', '--body', FULL);
  assert.equal(bad.code, 2);
  const ok = ab(db, 'review-status', 'rows-backend#2004', 'c1', '--context', 'What the PR adds, for Eric.');
  assert.equal(ok.code, 0, ok.stderr);
  const c = boardOf(db).reviews[0].comments[0];
  assert.equal(c.context, 'What the PR adds, for Eric.');
  assert.equal(c.body, ASK);
});

test('ab split-context migrates stored drafts that predate the rule', () => {
  const db = fresh();
  assert.equal(ab(db, 'reviews', review({ body: ASK }), '--no-gh').code, 0);
  const conn = open(db);
  const b = JSON.parse((conn.prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string }).json);
  b.reviews[0].comments[0].body = FULL;
  conn.prepare("UPDATE ui_doc SET json = ? WHERE key = 'board'").run(JSON.stringify(b));
  conn.close();
  const dry = ab(db, 'split-context', '--dry-run');
  assert.deepEqual(dry.out.moved, ['review:rows-backend#2004:c1']);
  assert.equal(boardOf(db).reviews[0].comments[0].body, FULL);
  assert.deepEqual(ab(db, 'split-context').out.moved, ['review:rows-backend#2004:c1']);
  assert.equal(boardOf(db).reviews[0].comments[0].body, ASK);
  assert.deepEqual(ab(db, 'split-context').out.moved, []);
});

test('an unposted draft with no context is refused by ab reviews and ab raise; posted ones are left alone', () => {
  const db = fresh();
  const r = ab(db, 'reviews', review({ body: ASK, context: '  ' }), '--no-gh');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /needs a non-empty "context"/);
  assert.equal(ab(db, 'reviews', review({ body: ASK, context: undefined, status: 'posted' }), '--no-gh').code, 0);
  const c = ab(db, 'raise', '--bot', 'QA', card({ body: ASK, context: undefined }));
  assert.equal(c.code, 2);
  assert.match(c.stderr, /post_comments\[0\] needs a non-empty "context"/);
});

test('a plain observation in front of the ask becomes context only when there is no context yet', () => {
  const s = splitAtAsk('The guard is skipped on a stale read.\n\nWhat do you think about refreshing first?')!;
  assert.deepEqual(s, { context: 'The guard is skipped on a stale read.', body: 'What do you think about refreshing first?' });
  assert.equal(splitAtAsk('What do you think about refreshing first?'), null);
  assert.equal(splitAtAsk('`updateQuietly()`\n\n```suggestion\n$a->updateQuietly();\n```'), null);
  const kept = { context: 'Already here.', body: 'Observation.\n\nWhat do you think?' };
  assert.deepEqual(splitBoardContext({ reviews: [{ repo: 'r', pr: 1, comments: [kept] }] }), []);
  const bare = { body: 'Observation.\n\nWhat do you think?' };
  assert.deepEqual(splitBoardContext({ reviews: [{ repo: 'r', pr: 1, comments: [bare] }] }), ['review:r#1:0']);
  assert.equal((bare as any).context, 'Observation.');
});

test('recoverBoardContext fills from the backup, then the card, then the card finding for the same comment', () => {
  const now = {
    reviews: [{ repo: 'rows-backend', pr: 2004, comments: [{ id: 'c1', status: 'pending', body: ASK }] }, { repo: 'rows-backend', pr: 1994, comments: [{ id: 'c3', status: 'pending', body: '`updateQuietly()`' }, { id: 'c9', status: 'pending', body: 'x' }] }],
    decisions: [{ id: 'qa-1994-quiet', context: 'Card story.', card_ref: 'https://github.com/ROWSHR/rows-backend/pull/1994', post_comments: [{ n: 1, label: '#1 c3', body: '`updateQuietly()`' }] }],
  };
  const earlier = { reviews: [{ repo: 'rows-backend', pr: 2004, comments: [{ id: 'c1', body: FULL }] }] };
  const got = recoverBoardContext(now, earlier);
  assert.deepEqual(got, [
    { id: 'qa-1994-quiet:1', from: 'card' },
    { id: 'review:rows-backend#2004:c1', from: 'backup' },
    { id: 'review:rows-backend#1994:c3', from: 'card qa-1994-quiet' },
  ]);
  assert.ok((now.reviews[0].comments[0] as any).context.startsWith('**What this PR adds.**'));
  assert.equal((now.reviews[1].comments[0] as any).context, 'Card story.');
  assert.deepEqual(missingContext(now), ['review:rows-backend#1994:c9']);
  assert.deepEqual(recoverBoardContext(now, earlier), []);
});
