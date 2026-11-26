import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { answerOfPayload, settleDecision } from '../src/answered.ts';
import { env } from './helpers.ts';

const ab = (dbPath: string, ...args: string[]) => {
  try {
    return { code: 0, out: JSON.parse(execFileSync(process.execPath, ['bin/ab.mjs', ...args], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_FILE: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })), stderr: '' };
  } catch (err: any) {
    return { code: typeof err.status === 'number' ? err.status : 1, out: null, stderr: String(err.stderr ?? '') };
  }
};
const card = (id: string, extra: object = {}) => ({
  id, title: 'Checkout image compression',
  context: 'The checkout page is slow because it loads every product image at full size before the page can be used.',
  question: 'Should we compress the images?', what_happens_after: 'The assistant starts compressing them.',
  options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'Hold' }], priority: 'medium', group: 'ROWS-5207',
  card_ref: 'https://linear.app/rows/issue/ROWS-5207/checkout-images', ...extra,
});
const boardOf = (dbPath: string) => JSON.parse((open(dbPath).prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string }).json);
const answerPayload = (id: string, extra: object = {}) => ({ event: 'decision.answered', decision_id: id, answer: 'a', answer_label: 'Yes', answered_by: 'app', answered_at: new Date(Date.now() + 5000).toISOString(), ...extra });
const fresh = () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-answered-')), 'board.db');
  open(dbPath).close();
  return dbPath;
};

test('the stored answer matches what ab answer stores for each kind of pick', () => {
  const at = '2026-11-26T10:00:00.000Z';
  assert.deepEqual(answerOfPayload({ answer: 'a', answer_label: 'Yes', answered_at: at }), { answer: 'a', answer_label: 'Yes', answered_by: 'app', answered_at: at });
  assert.deepEqual(answerOfPayload({ answer: ['a', 'b'], answer_label: ['Yes', 'Hold'], answered_at: at })?.answer_label, ['Yes', 'Hold']);
  assert.deepEqual(answerOfPayload({ answer: 'custom', answer_label: 'custom', custom_text: ' my way ', answered_at: at }), { answer: 'custom', answer_label: 'my way', answered_by: 'app', answered_at: at, custom_text: 'my way' });
  assert.equal(answerOfPayload({ action: 'send', text: ' hi ', answered_at: at })?.text, 'hi');
  assert.equal(answerOfPayload({ action: 'send', text: '  ' }), null);
  assert.equal(answerOfPayload({ action: 'decline', answered_at: at })?.answer, 'decline');
  assert.equal(answerOfPayload({}), null);
});

test('settleDecision closes an unanswered card once, and not for an answer older than the latest revision', () => {
  const p = { event: 'decision.answered', answer: 'a', answer_label: 'Yes', answered_at: '2026-11-26T10:00:00.000Z' };
  const d: Record<string, any> = { id: 'd', created_at: '2026-11-26T09:00:00Z', updated_at: '2026-11-26T09:30:00Z' };
  assert.equal(settleDecision(d, p), true);
  assert.equal(d.answer.answer, 'a');
  assert.equal(settleDecision(d, { ...p, answer: 'b' }), false);
  assert.equal(d.answer.answer, 'a');
  const revised: Record<string, any> = { id: 'r', created_at: '2026-11-26T09:00:00Z', updated_at: '2026-11-26T11:00:00Z' };
  assert.equal(settleDecision(revised, p), false);
  assert.equal(revised.answer, undefined);
  assert.equal(settleDecision(undefined, p), false);
  assert.equal(settleDecision({ id: 'x' }, { ...p, event: 'decision.clarify' }), false);
});

test('answering a card stores the answer on it, so it is answered after any reload and a re-raise is refused', () => {
  const db = fresh();
  assert.equal(ab(db, 'raise', '--bot', 'Planner', JSON.stringify(card('planner-compress'))).code, 0);
  assert.equal(boardOf(db).decisions[0].answer, undefined);
  const r = ab(db, 'ask', JSON.stringify(answerPayload('planner-compress')));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.out.settled, true);
  const d = boardOf(db).decisions[0];
  assert.equal(d.answer.answer, 'a');
  assert.equal(d.answer.answered_by, 'app');
  const again = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(card('planner-compress', { context: 'The checkout page is still slow because full-size images load before the page can be used.' })));
  assert.equal(again.code, 4, again.stderr);
  assert.match(again.stderr, /already answered/);
  assert.equal(boardOf(db).decisions[0].answer.answer, 'a');
});

test('a browser re-sending an answer the board has but the card lacks heals the card; an older answer than the card does not', () => {
  const db = fresh();
  assert.equal(ab(db, 'raise', '--bot', 'Planner', JSON.stringify(card('planner-heal'))).code, 0);
  const p = answerPayload('planner-heal');
  const board = boardOf(db);
  board.asks = [{ id: 'planner-heal:answer', at: p.answered_at, item_key: 'decision:planner-heal', label: 'x', kind: 'answer', text: 'Yes' }];
  open(db).prepare("UPDATE ui_doc SET json = ? WHERE key = 'board'").run(JSON.stringify(board));
  const r = ab(db, 'ask', JSON.stringify(p));
  assert.equal(r.out.duplicate, true);
  assert.equal(r.out.settled, true);
  assert.equal(boardOf(db).decisions[0].answer.answer, 'a');

  const db2 = fresh();
  assert.equal(ab(db2, 'raise', '--bot', 'Planner', JSON.stringify(card('planner-old'))).code, 0);
  const old = ab(db2, 'ask', JSON.stringify(answerPayload('planner-old', { answered_at: '2020-01-01T00:00:00.000Z' })));
  assert.equal(old.out.settled, false);
  assert.equal(boardOf(db2).decisions[0].answer, undefined);
});

test('the webhook route keeps the answer even when the wake webhook is down', async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-answered-')), 'board.db');
  const db = open(dbPath);
  const e = env();
  for (const [name, fetchImpl] of [['500', async () => ({ ok: false, status: 500 })], ['throws', async () => { throw new Error('down'); }]] as const) {
    const id = `planner-down-${name}`;
    assert.equal(ab(dbPath, 'raise', '--bot', 'Planner', JSON.stringify(card(id))).code, 0);
    const app = createApp(db, e.clock, { ui: { dbPath, webhook: { url: 'https://hooks.example.test/p', auth: 'Bearer x' }, fetchImpl: fetchImpl as any } });
    const res = await app.request('/__ab/webhook', { method: 'POST', body: JSON.stringify(answerPayload(id)), headers: { 'Content-Type': 'application/json', Host: 'board.test' } });
    assert.ok(res.status < 600);
    const feed = await (await app.request('/__ab/board')).json();
    const d = feed.decisions.find((x: any) => x.id === id);
    assert.equal(d.answer.answer, 'a', `${name}: card answered on the server`);
    assert.ok(feed.asks.some((a: any) => a.id === `${id}:answer`), `${name}: ask recorded`);
  }
});

test('an answered and archived card cannot be raised again under the same id', () => {
  const db = fresh();
  assert.equal(ab(db, 'raise', '--bot', 'Planner', JSON.stringify(card('planner-arch'))).code, 0);
  open(db).prepare('INSERT INTO archive_cards (card_id, json, answered_at, archived_at) VALUES (?, ?, ?, ?)').run('planner-gone', '{}', 'x', 'y');
  const r = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(card('planner-gone')));
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /archived/);
});

test('heal-answers closes cards that have his answer ask but no stored answer, from any of the three answer shapes', () => {
  const db = fresh();
  assert.equal(ab(db, 'raise', '--bot', 'Planner', JSON.stringify(card('planner-pick'))).code, 0);
  assert.equal(ab(db, 'raise', '--bot', 'Planner', JSON.stringify(card('planner-free'))).code, 0);
  assert.equal(ab(db, 'raise', '--bot', 'Planner', JSON.stringify(card('planner-none'))).code, 0);
  assert.equal(ab(db, 'raise', '--bot', 'Planner', JSON.stringify(card('planner-later'))).code, 0);
  const board = boardOf(db);
  const at = new Date(Date.now() + 5000).toISOString();
  const ask = (id: string, kind: string, text: string, when = at) => ({ id: `${id}:answer`, at: when, item_key: `decision:${id}`, label: id, kind, text });
  board.asks = [ask('planner-pick', 'answer', 'Hold'), ask('planner-free', 'custom', 'Please rewrite this'), ask('planner-later', 'answer', 'Yes', '2020-01-01T00:00:00.000Z')];
  open(db).prepare("UPDATE ui_doc SET json = ? WHERE key = 'board'").run(JSON.stringify(board));
  const r = ab(db, 'heal-answers');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.out.healed.sort(), ['planner-free', 'planner-pick']);
  const by = Object.fromEntries(boardOf(db).decisions.map((d: any) => [d.id, d.answer]));
  assert.equal(by['planner-pick'].answer, 'b');
  assert.equal(by['planner-free'].custom_text, 'Please rewrite this');
  assert.equal(by['planner-none'], undefined);
  assert.equal(by['planner-later'], undefined);
  assert.deepEqual(ab(db, 'heal-answers').out.healed, []);
});
