import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.ts';
import { carryPendingBot, findingNumber, markNotePending } from '../src/finding-notes.ts';

const ab = (dbPath: string, ...args: string[]) => {
  try {
    return { code: 0, out: JSON.parse(execFileSync(process.execPath, ['bin/ab.mjs', ...args], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_FILE: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })), stderr: '' };
  } catch (err: any) {
    return { code: typeof err.status === 'number' ? err.status : 1, out: null, stderr: String(err.stderr ?? '') };
  }
};
const boardOf = (dbPath: string) => JSON.parse((open(dbPath).prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string }).json);
const card = (comments: object[] = [
  { n: 1, label: '#1 reflection in tests', path: 'tests/A.php', line: 10, severity: 'low', body: 'Use the public method.' },
  { n: 2, label: '#2 naming', path: 'tests/B.php', line: 20, severity: 'low', body: 'Rename it.' },
]) => ({
  id: 'qa-review-1986', title: 'Review of PR 1986',
  context: 'QA found two things to post on the pull request about the logging handler and its tests.',
  question: 'Which of these comments should be posted?', what_happens_after: 'The ones you post go to GitHub.',
  options: [], group: 'rows-backend#1986', card_ref: 'https://github.com/ROWSHR/rows-backend/pull/1986', priority: 'medium',
  post_comments: comments,
});
const fresh = () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-notes-')), 'board.db'); open(dbPath).close();
  assert.equal(ab(dbPath, 'raise', '--bot', 'QA', JSON.stringify(card())).code, 0);
  return dbPath;
};
let tick = 0;
const later = () => new Date(Date.now() - 20_000 + (tick += 100)).toISOString();
const note = (n: number, text: string, at = later()) => ({ event: 'review.answer', decision_id: `qa-review-1986:${n}`, card_id: 'qa-review-1986', repo: 'rows-backend', pr: 1986, comment_id: String(n), finding: n, action: 'note', text, path: 'tests/A.php', line: 10, answered_at: at });
const finding = (db: string, n: number) => boardOf(db).decisions[0].post_comments.find((c: any) => c.n === n);

test('findingNumber uses n, then #N in the label, then the position', () => {
  assert.equal(findingNumber({ n: 4 }, 0), 4);
  assert.equal(findingNumber({ label: '#7 thing' }, 0), 7);
  assert.equal(findingNumber({ label: 'thing' }, 2), 3);
});

test('a note on a finding is stored and parks the finding with the bot; the other finding is untouched', () => {
  const db = fresh();
  const r = ab(db, 'ask', JSON.stringify(note(1, 'soften this')));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(finding(db, 1).pending_bot.note, 'soften this');
  assert.equal(finding(db, 2).pending_bot, undefined);
  assert.equal(boardOf(db).asks.length, 1);
});

test('a browser re-sending the same note changes nothing, and a note on a posted or skipped finding is ignored', () => {
  const db = fresh();
  const p = note(1, 'soften this');
  ab(db, 'ask', JSON.stringify(p));
  const again = ab(db, 'ask', JSON.stringify(p));
  assert.equal(again.out.duplicate, true);
  assert.equal(finding(db, 1).pending_bot.at, new Date(p.answered_at).toISOString());
  assert.equal(ab(db, 'review-status', 'rows-backend#1986', '1', 'skipped').code, 0);
  assert.equal(finding(db, 1).pending_bot, undefined);
  ab(db, 'ask', JSON.stringify(note(1, 'another note')));
  assert.equal(finding(db, 1).pending_bot, undefined);
});

test('the bot rewriting the text clears the pending state and a re-sent old note does not park it again', () => {
  const db = fresh();
  const p = note(1, 'soften this');
  ab(db, 'ask', JSON.stringify(p));
  assert.ok(finding(db, 1).pending_bot);
  const r = ab(db, 'review-status', 'rows-backend#1986', '1', '--body', 'Maybe use the public method.');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(finding(db, 1).pending_bot, undefined);
  assert.equal(finding(db, 1).body, 'Maybe use the public method.');
  ab(db, 'ask', JSON.stringify(p));
  assert.equal(finding(db, 1).pending_bot, undefined);
});

test('the bot answering a question about the finding, or handing it back as pending, clears the pending state', () => {
  const db = fresh();
  ab(db, 'ask', JSON.stringify(note(1, 'why is this low?')));
  assert.equal(ab(db, 'review-status', 'rows-backend#1986', '1', '--answer-to-question', 'It only affects tests.').code, 0);
  assert.equal(finding(db, 1).pending_bot, undefined);
  ab(db, 'ask', JSON.stringify(note(2, 'leave this one for now')));
  assert.ok(finding(db, 2).pending_bot);
  assert.equal(ab(db, 'review-status', 'rows-backend#1986', '2', 'pending').code, 0);
  assert.equal(finding(db, 2).pending_bot, undefined);
});

test('re-raising the card: an unchanged finding keeps the pending note, a rewritten one clears it', () => {
  const db = fresh();
  ab(db, 'ask', JSON.stringify(note(1, 'soften this')));
  ab(db, 'ask', JSON.stringify(note(2, 'say it differently')));
  const same = ab(db, 'raise', '--bot', 'QA', JSON.stringify(card([
    { n: 1, label: '#1 reflection in tests', path: 'tests/A.php', line: 10, severity: 'low', body: 'Use the public method.' },
    { n: 2, label: '#2 naming', path: 'tests/B.php', line: 20, severity: 'low', body: 'Rename it to something clearer.' },
  ])));
  assert.equal(same.code, 0, same.stderr);
  assert.equal(finding(db, 1).pending_bot.note, 'soften this');
  assert.equal(finding(db, 2).pending_bot, undefined);
  assert.ok(finding(db, 2).revision_at);
  assert.equal(finding(db, 1).revision_at, undefined);
});

test('a bot cannot set pending_bot itself through a raise', () => {
  const db = fresh();
  const r = ab(db, 'raise', '--bot', 'QA', JSON.stringify(card([{ n: 1, label: '#1 x', path: 'tests/A.php', line: 10, severity: 'low', body: 'Use the public method.', pending_bot: { at: 'x', note: 'fake' } }])));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(finding(db, 1).pending_bot, undefined);
});

test('notes on a drafted review comment park it, and a rewritten comment from ab reviews clears it', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-notes-')), 'board.db'); open(dbPath).close();
  const draft = (body: string) => JSON.stringify([{ repo: 'rows-backend', pr: 1990, verdict: 'one low to post', comments: [{ id: 'c1', severity: 'low', path: 'app/A.php', line: 5, body, status: 'pending' }] }]);
  assert.equal(ab(dbPath, 'reviews', draft('Original text.'), '--no-gh').code, 0);
  const p = { event: 'review.answer', decision_id: 'review:rows-backend#1990:c1', repo: 'rows-backend', pr: 1990, comment_id: 'c1', action: 'note', text: 'shorter please', answered_at: later() };
  ab(dbPath, 'ask', JSON.stringify(p));
  const c = () => boardOf(dbPath).reviews[0].comments[0];
  assert.equal(c().pending_bot.note, 'shorter please');
  assert.equal(ab(dbPath, 'reviews', draft('Original text.'), '--no-gh').code, 0);
  assert.ok(c().pending_bot, 'unchanged comment keeps it');
  assert.equal(ab(dbPath, 'reviews', draft('Shorter text.'), '--no-gh').code, 0);
  assert.equal(c().pending_bot, undefined);
  ab(dbPath, 'ask', JSON.stringify(p));
  assert.equal(c().pending_bot, undefined, 'the old note is not re-applied after the rewrite');
});

test('markNotePending ignores payloads that are not a note with words, and the per-PR box', () => {
  const board = { decisions: [{ id: 'd', post_comments: [{ n: 1, body: 'x' }] }], reviews: [] };
  const base = { event: 'review.answer', card_id: 'd', finding: 1, comment_id: '1', action: 'note', text: 'hi', answered_at: new Date().toISOString() };
  assert.equal(markNotePending(board, { ...base, text: '  ' }), false);
  assert.equal(markNotePending(board, { ...base, action: 'post' }), false);
  assert.equal(markNotePending(board, { ...base, card_id: 'nope' }), false);
  assert.equal(markNotePending(board, { event: 'review.answer', repo: 'r', pr: 1, comment_id: 'pr', action: 'note', text: 'hi', answered_at: base.answered_at }), false);
  assert.equal(markNotePending(board, base), true);
});

test('carryPendingBot carries only when the body is unchanged', () => {
  const prev = [{ n: 1, body: 'a', pending_bot: { at: 't', note: 'n' } }];
  const keep: Record<string, any>[] = [{ n: 1, body: 'a' }];
  carryPendingBot(prev, keep, (c) => c.n);
  assert.deepEqual(keep[0].pending_bot, { at: 't', note: 'n' });
  const changed: Record<string, any>[] = [{ n: 1, body: 'b' }];
  carryPendingBot(prev, changed, (c) => c.n, new Date(), true);
  assert.equal(changed[0].pending_bot, undefined);
  assert.ok(changed[0].revision_at);
});

test('ab reply rejects empty text and text that starts with --, and still accepts real text and a status-only reply', () => {
  const db = fresh();
  for (const bad of ['', '   ', '--text', '--text hello']) {
    const r = ab(db, 'reply', 'ticket:ROWS-1', bad);
    assert.equal(r.code, 2, `${JSON.stringify(bad)}: ${r.stderr}`);
    assert.match(r.stderr, /must not be empty or start with/);
  }
  const mistyped = ab(db, 'reply', 'ticket:ROWS-1', '--text', 'hello');
  assert.equal(mistyped.code, 2, mistyped.stderr);
  assert.equal(ab(db, 'reply', 'ticket:ROWS-1', 'on it').code, 0);
  assert.equal(ab(db, 'reply', 'ticket:ROWS-1', '--status', 'working').code, 0);
});

test('heal-answers parks open findings whose last word from him is a note, and leaves tapped or revised ones alone', () => {
  const db = fresh();
  const board = boardOf(db);
  const at = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const ask = (n: number, action: string, text: string, when: string) => ({ id: `qa-review-1986:${n}:${action}:${when}`, at: when, item_key: 'decision:qa-review-1986', label: 'x', kind: 'review', text, ref: `qa-review-1986:${n}` });
  board.asks = [ask(1, 'note', 'Finding #1 (tests/A.php:10): soften this', at(1)), ask(2, 'note', 'Finding #2 (tests/B.php:20): hmm', at(1)), ask(2, 'skip', "Finding #2 (tests/B.php:20): Don't post", at(2))];
  open(db).prepare("UPDATE ui_doc SET json = ? WHERE key = 'board'").run(JSON.stringify(board));
  const r = ab(db, 'heal-answers');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.parked, ['qa-review-1986:1']);
  assert.equal(finding(db, 1).pending_bot.note, 'soften this');
  assert.equal(finding(db, 2).pending_bot, undefined);
  assert.deepEqual(ab(db, 'heal-answers').out.parked, []);
});

test('heal-answers does not park a drafted comment the bot already answered on that PR after his note (rows-backend#1994 c3)', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-notes-')), 'board.db'); open(dbPath).close();
  const draft = JSON.stringify([{ repo: 'rows-backend', pr: 1994, verdict: 'v', comments: [
    { id: 'c3', severity: 'low', path: 'tests/T.php', line: 833, body: '`updateQuietly()`', status: 'pending' },
    { id: 'c4', severity: 'low', path: 'tests/U.php', line: 9, body: 'Other.', status: 'pending' },
  ] }]);
  assert.equal(ab(dbPath, 'reviews', draft, '--no-gh').code, 0);
  const board = boardOf(dbPath);
  const at = (s: number) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  const ask = (id: string, when: string) => ({ id: `review:rows-backend#1994:${id}:note:${when}`, at: when, item_key: 'pr:rows-backend/1994', label: 'x', kind: 'review', text: `Note on ${id} (x): we only say updateQuietly()`, ref: `rows-backend#1994:${id}` });
  board.asks = [ask('c3', at(1)), ask('c4', at(5))];
  board.details = { 'pr:rows-backend/1994': { thread: [{ at: at(3), from: 'bot', text: 'c3 is trimmed. Hit Post when ready.' }] } };
  open(dbPath).prepare("UPDATE ui_doc SET json = ? WHERE key = 'board'").run(JSON.stringify(board));
  const r = ab(dbPath, 'heal-answers');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.parked, ['rows-backend#1994:c4'], 'only the note with no bot reply after it parks');
  const cs = boardOf(dbPath).reviews[0].comments;
  assert.equal(cs[0].pending_bot, undefined);
  assert.ok(cs[1].pending_bot);
});

test('ab review-status --body on a drafted review comment rewrites it and clears his parked note', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-notes-')), 'board.db'); open(dbPath).close();
  const draft = JSON.stringify([{ repo: 'rows-backend', pr: 1990, verdict: 'v', comments: [{ id: 'c1', severity: 'low', path: 'app/A.php', line: 5, body: 'Long text.', status: 'pending' }] }]);
  assert.equal(ab(dbPath, 'reviews', draft, '--no-gh').code, 0);
  const p = { event: 'review.answer', decision_id: 'review:rows-backend#1990:c1', repo: 'rows-backend', pr: 1990, comment_id: 'c1', action: 'note', text: 'shorter please', answered_at: later() };
  ab(dbPath, 'ask', JSON.stringify(p));
  const c = () => boardOf(dbPath).reviews[0].comments[0];
  assert.ok(c().pending_bot);
  const r = ab(dbPath, 'review-status', 'rows-backend#1990', 'c1', '--body', 'Short.');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(c().body, 'Short.');
  assert.equal(c().pending_bot, undefined);
  assert.ok(c().revision_at);
  assert.deepEqual(ab(dbPath, 'heal-answers').out.parked, [], 'the stamped rewrite keeps heal from parking it again');
});

test('carryPendingBot stamps every rewrite fresh and keeps the stamp on an unchanged body', () => {
  const prev = [{ n: 1, body: 'a', revision_at: '2026-01-01T00:00:00.000Z' }];
  const copied: Record<string, any>[] = [{ n: 1, body: 'b', revision_at: '2026-01-01T00:00:00.000Z' }];
  carryPendingBot(prev, copied, (c) => c.n, new Date('2026-11-27T12:00:00Z'), true);
  assert.equal(copied[0].revision_at, '2026-11-27T12:00:00.000Z');
  const same: Record<string, any>[] = [{ n: 1, body: 'a' }];
  carryPendingBot(prev, same, (c) => c.n, new Date(), true);
  assert.equal(same[0].revision_at, '2026-01-01T00:00:00.000Z');
});
