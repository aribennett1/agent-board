import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.ts';
import { bareRefs, ticketLinkError, cardTicketLinkError } from '../src/ticket-links.ts';

test('bare ticket and PR refs are flagged; markdown links and raw URLs are not', () => {
  assert.deepEqual(bareRefs('Look at ROWS-1234 today').map((r) => r.key), ['ROWS-1234']);
  assert.deepEqual(bareRefs('See #2019').map((r) => r.key), ['2019']);
  assert.deepEqual(bareRefs('See PR 2019 please').map((r) => r.key), ['2019']);
  assert.deepEqual(bareRefs('rows-backend#2019 is ready').map((r) => r.key), ['2019']);
  assert.equal(bareRefs('See [ROWS-1234](https://linear.app/rows/issue/ROWS-1234)').length, 0);
  assert.equal(bareRefs('See [ROWS-1234](https://linear.app/rows/issue/ROWS-1234/checkout)').length, 0);
  assert.equal(bareRefs('See https://linear.app/rows/issue/ROWS-1234').length, 0);
  assert.equal(bareRefs('See [#2019](https://github.com/ROWSHR/rows-backend/pull/2019)').length, 0);
  assert.equal(bareRefs('See [PR 2019](https://github.com/ROWSHR/rows-backend/pull/2019)').length, 0);
  assert.equal(bareRefs('Finding #1 is small').length, 0);
  assert.equal(bareRefs('comment #2 on the file').length, 0);
  assert.equal(bareRefs('Exact comment text for #1.').length, 0);
  assert.deepEqual(bareRefs('ops review of #9997').map((r) => r.key), ['9997']);
  assert.equal(bareRefs('ISO-8601 is a date format').length, 0);
  assert.equal(ticketLinkError('Please review ROWS-1234'), 'link tickets as [ROWS-1234](https://linear.app/rows/issue/ROWS-1234)');
  assert.match(ticketLinkError('Open #2019', 'context') ?? '', /context: link PRs as \[#2019]\(https:\/\/github.com\/ROWSHR\/<repo>\/pull\/2019\)/);
});

test('a card with a linked ticket passes; a bare ticket in context fails', () => {
  const ok = {
    title: 'Checkout images',
    context: 'Compress images on [ROWS-5207](https://linear.app/rows/issue/ROWS-5207).',
    question: 'Compress the images?',
    group: 'ROWS-5207',
    card_ref: 'https://linear.app/rows/issue/ROWS-5207/checkout-images',
  };
  assert.equal(cardTicketLinkError(ok), null);
  // The card already links its own ticket via card_ref, so naming it in the body is fine.
  assert.equal(cardTicketLinkError({ ...ok, context: 'Compress images on ROWS-5207.' }), null);
  const other = { ...ok, context: 'This also depends on ROWS-1111 being done first.' };
  assert.match(cardTicketLinkError(other) ?? '', /context: link tickets as \[ROWS-1111]/);
  const slack = { ...ok, slack: { text: 'This is Eric\'s bot posting on his behalf.\n\nROWS-5207 is done.' } };
  assert.match(cardTicketLinkError(slack) ?? '', /slack.text: link tickets as \[ROWS-5207]/);
});

const ab = (dbPath: string, ...args: string[]) => {
  try {
    return { code: 0, out: JSON.parse(execFileSync(process.execPath, ['bin/ab.mjs', ...args], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_FILE: '' }, encoding: 'utf8' })), stderr: '' };
  } catch (err: any) {
    return { code: typeof err.status === 'number' ? err.status : 1, out: null, stderr: String(err.stderr ?? '') };
  }
};

const fresh = () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-links-')), 'board.db');
  open(dbPath).close();
  return dbPath;
};

const valid = (extra: Record<string, unknown> = {}) => ({
  id: 'planner-links-ok',
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

test('ab raise rejects a bare ticket in context and leaves the board untouched', () => {
  const db = fresh();
  const r = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid({ context: 'The checkout page is slow, and it also depends on ROWS-1111 being done first.' })));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /link tickets as \[ROWS-1111]\(https:\/\/linear\.app\/rows\/issue\/ROWS-1111\)/);
  const row = open(db).prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json?: string } | undefined;
  assert.ok(!row?.json || JSON.parse(row.json).decisions.length === 0);
});

test('ab raise accepts a ticket mentioned as a markdown link', () => {
  const db = fresh();
  const r = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid({
    context: 'The checkout page is slow on [ROWS-5207](https://linear.app/rows/issue/ROWS-5207) because images load at full size.',
  })));
  assert.equal(r.code, 0, r.stderr);
});

test('ab notify rejects a bare PR and accepts a linked one', () => {
  const db = fresh();
  const bad = ab(db, 'notify', '--bot', 'QA', '--text', 'Approved PR #12 at `abc1234`.');
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /link PRs as \[#12]\(https:\/\/github.com\/ROWSHR\/<repo>\/pull\/12\)/);
  const ok = ab(db, 'notify', '--bot', 'QA', '--text', 'Approved [PR #12](https://github.com/ROWSHR/rows-backend/pull/12) at `abc1234`.');
  assert.equal(ok.code, 0, ok.stderr);
});

test('ab lint does not flag an already-stored card with a bare ticket', () => {
  const db = fresh();
  const conn = open(db);
  conn.prepare("INSERT INTO ui_doc (key, json, updated_at) VALUES (?, ?, ?)").run(
    'board',
    JSON.stringify({
      updated_at: '2026-11-26T00:00:00.000Z',
      decisions: [valid({ id: 'planner-old', context: 'This old card mentions ROWS-5207 without a link on purpose.', created_at: '2026-11-20T00:00:00.000Z' })],
      glance: { waiting: [], tickets: [], others: [], mine: [] },
    }),
    'now',
  );
  conn.close();
  const r = ab(db, 'lint');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.failing ?? [], []);
});
