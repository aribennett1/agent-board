import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.ts';
import { isSlackDraft, slackDraftError, SLACK_PREFIX } from '../src/slack-draft.ts';
import { slimPayload } from '../src/context.ts';
import { payloadText } from '../src/ui-routes.ts';

const PREFIX = SLACK_PREFIX;
const TEXT = PREFIX + '\n\nThe review of [ROWS-5207](https://linear.app/rows/issue/ROWS-5207) is done.';

test('slackDraftError requires the attribution line, channel id, and a readable name', () => {
  const slack = { channel_id: 'C01234567', channel: '#qa', text: TEXT };
  assert.equal(slackDraftError({ kind: 'slack_draft', slack }), null);
  assert.equal(isSlackDraft({ kind: 'slack_draft', slack }), true);
  assert.match(slackDraftError({ kind: 'slack_draft', slack: { ...slack, text: 'Hello Slack' } }) ?? '', /must start with/);
  assert.match(slackDraftError({ kind: 'slack_draft', slack: { ...slack, channel_id: 'qa' } }) ?? '', /channel_id/);
  assert.match(slackDraftError({ kind: 'slack_draft' }) ?? '', /need a slack object/);
  assert.match(slackDraftError({ kind: 'other' }) ?? '', /kind must be slack_draft/);
});

const ab = (dbPath: string, ...args: string[]) => {
  try {
    return { code: 0, out: JSON.parse(execFileSync(process.execPath, ['bin/ab.mjs', ...args], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_FILE: '' }, encoding: 'utf8' })), stderr: '' };
  } catch (err: any) {
    return { code: typeof err.status === 'number' ? err.status : 1, out: null, stderr: String(err.stderr ?? '') };
  }
};

const fresh = () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-slack-')), 'board.db');
  open(dbPath).close();
  return dbPath;
};

const flags = [
  '--bot', 'QA', '--id', 'qa-slack-rows-5207',
  '--channel-id', 'C01234567', '--channel', '#qa-reviews',
  '--text', TEXT,
  '--why', 'QA finished the review and wants to post the result in the thread.',
  '--group', 'ROWS-5207', '--card-ref', 'https://linear.app/rows/issue/ROWS-5207/checkout-images',
  '--thread', '1732650000.123456',
  '--thread-link', 'https://rows.slack.com/archives/C01234567/p1732650000123456',
];

test('ab slack-draft writes a live card with the slack preview fields', () => {
  const db = fresh();
  const r = ab(db, 'slack-draft', ...flags);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.card.kind, 'slack_draft');
  assert.equal(r.out.card.slack.channel, '#qa-reviews');
  assert.equal(r.out.card.slack.channel_id, 'C01234567');
  assert.equal(r.out.card.slack.text, TEXT);
  assert.equal(r.out.card.slack.thread_ts, '1732650000.123456');
  const row = JSON.parse((open(db).prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string }).json);
  const d = row.decisions[0];
  assert.equal(d.kind, 'slack_draft');
  assert.equal(d.raised_by, 'QA');
  assert.equal(d.slack.permalink, 'https://rows.slack.com/archives/C01234567/p1732650000123456');
  assert.match(d.question, /#qa-reviews/);
  assert.equal(d.options.length, 0);
});

test('ab slack-draft refuses text without the standing prefix and a missing why', () => {
  const db = fresh();
  const noPrefix = flags.map((x) => (x === TEXT ? 'Hello from QA' : x));
  const a = ab(db, 'slack-draft', ...noPrefix);
  assert.equal(a.code, 2);
  assert.match(a.stderr, /must start with/);
  const args = flags.filter((x, i) => x !== '--why' && flags[i - 1] !== '--why');
  const b = ab(db, 'slack-draft', ...args);
  assert.equal(b.code, 2);
  assert.match(b.stderr, /usage: ab slack-draft/);
  const row = open(db).prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json?: string } | undefined;
  assert.ok(!row?.json || JSON.parse(row.json).decisions.length === 0);
});

test('ab raise accepts kind slack_draft with a slack object', () => {
  const db = fresh();
  const r = ab(db, 'raise', '--bot', 'QA', JSON.stringify({
    id: 'qa-slack-json',
    kind: 'slack_draft',
    title: 'Slack message to #qa-reviews',
    context: 'QA finished the review and wants to post the result in the thread.',
    question: 'Send this message to #qa-reviews?',
    what_happens_after: 'If you send, QA posts this exact text to Slack once.',
    priority: 'medium',
    group: 'ROWS-5207',
    card_ref: 'https://linear.app/rows/issue/ROWS-5207/checkout-images',
    slack: { channel_id: 'C01234567', channel: '#qa-reviews', text: TEXT },
  }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.card.kind, 'slack_draft');
});

test('ab answer --action send stores the final text; decline stores the decline', () => {
  const db = fresh();
  assert.equal(ab(db, 'slack-draft', ...flags).code, 0);
  const sent = ab(db, 'answer', 'qa-slack-rows-5207', '--action', 'send', '--text', TEXT + '\nEdited by Eric.', '--by', 'app');
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(sent.out.answer.action, 'send');
  assert.equal(sent.out.answer.text, TEXT + '\nEdited by Eric.');
  const db2 = fresh();
  assert.equal(ab(db2, 'slack-draft', ...flags).code, 0);
  const declined = ab(db2, 'answer', 'qa-slack-rows-5207', '--action', 'decline', '--by', 'app');
  assert.equal(declined.code, 0, declined.stderr);
  assert.equal(declined.out.answer.action, 'decline');
  assert.equal(declined.out.answer.answer, 'decline');
});

test('slimPayload keeps action and the unclipped Slack text; payloadText uses it', () => {
  const text = PREFIX + '\n\n' + 'x'.repeat(2000);
  const full = { event: 'decision.answered', decision_id: 'qa-slack-rows-5207', card_ref: 'https://linear.app/rows/issue/ROWS-5207', question: 'Send?', answer: 'send', answer_label: 'Send to Slack', action: 'send', text, answered_by: 'app', answered_at: 't', to_bot: 'QA', junk: 'z' };
  const s = slimPayload(full, 'QA');
  assert.equal(s.action, 'send');
  assert.equal(s.text, text);
  assert.equal(s.junk, undefined);
  assert.equal(s.answered_by, undefined);
  assert.equal(payloadText(full), text);
  assert.equal(payloadText({ event: 'decision.answered', action: 'decline', answer: 'decline', answer_label: "Don't send" }), "Don't send");
});
