import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.ts';
import { buildContext, slimPayload, clip } from '../src/context.ts';

const NOW = new Date('2026-11-26T20:00:00.000Z'); // 3:00 PM ET
const card = (id: string, extra: object = {}) => ({ id, title: `Card ${id}`, context: 'ctx '.repeat(50), question: 'What now?', options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'No' }], priority: 'medium', created_at: '2026-11-26T17:00:00.000Z', ...extra });
const msg = (n: number) => ({ at: `2026-11-26T18:${String(n).padStart(2, '0')}:00.000Z`, from: 'bot', text: `bot message ${n} ${'x'.repeat(400)}` });
const board = () => ({
  decisions: [
    card('planner-a', { raised_by: 'Planner' }),
    card('planner-closed', { raised_by: 'Planner', answer: { answer: 'a', answer_label: 'Yes', answered_at: '2026-11-26T18:00:00.000Z' } }),
    card('qa-a', { raised_by: 'QA' }),
  ],
  details: { 'decision:planner-a': { thread: Array.from({ length: 8 }, (_, i) => msg(i + 1)) } },
  asks: [
    { id: 'k1', at: '2026-11-26T19:00:00.000Z', item_key: 'decision:planner-a', kind: 'note', text: 'Eric note on the open card' },
    { id: 'k2', at: '2026-11-26T18:00:00.000Z', item_key: 'decision:planner-closed', label: 'Closed one', kind: 'answer', text: 'Yes' },
    { id: 'k3', at: '2026-11-26T18:30:00.000Z', item_key: 'decision:qa-a', kind: 'note', text: 'for QA only' },
    { id: 'k4', at: '2026-11-26T17:30:00.000Z', item_key: 'ticket:ROWS-1', kind: 'note', text: 'picked planner', to_bot: 'Planner' },
  ],
});
const opts = { bot: 'Planner' as const, now: NOW, isOpen: (d: any) => !d.answer };

test('compact view: only this bot\'s open cards, threads cut to the last 5 with a marker, long text clipped', () => {
  const r = buildContext(board(), opts);
  assert.equal(r.open, 1);
  assert.match(r.text, /planner-a/);
  assert.doesNotMatch(r.text, /planner-closed \[/);
  assert.doesNotMatch(r.text, /qa-a/);
  assert.match(r.text, /\(\+4 earlier, see --full\)/); // 8 bot messages + 1 note = 9; 5 shown
  assert.match(r.text, /bot message 8/);
  assert.doesNotMatch(r.text, /bot message 2 /);
  assert.doesNotMatch(r.text, /x{300}/);
  assert.match(r.text, /Eric: Eric note on the open card/);
  assert.match(r.text, /3:00 PM ET/);
});

test('Eric\'s messages: answers to closed cards and messages picked for this bot show; other bots\' do not', () => {
  const t = buildContext(board(), opts).text;
  assert.match(t, /on decision:planner-closed "Closed one" \[answer\]: Yes/);
  assert.match(t, /on ticket:ROWS-1 .*picked planner/);
  assert.doesNotMatch(t, /for QA only/);
});

test('unread messages are marked NEW and listed before read ones', () => {
  const t = buildContext(board(), { ...opts, isRead: (a) => a.id !== 'k4' }).text;
  assert.match(t, /• NEW .*picked planner/);
  assert.ok(t.indexOf('picked planner') < t.indexOf('Closed one'));
});

test('--full: every card incl. closed, whole threads, unclipped text', () => {
  const r = buildContext(board(), { ...opts, full: true });
  assert.match(r.text, /planner-closed \[medium, closed\]/);
  assert.doesNotMatch(r.text, /see --full\)/);
  assert.match(r.text, /bot message 1 x{400}/);
  assert.match(r.text, /Context: ctx ctx/);
  assert.ok(r.text.length > buildContext(board(), opts).text.length * 2);
});

test('--last and --clip change the cut', () => {
  const t = buildContext(board(), { ...opts, last: 2, clip: 40 }).text;
  assert.match(t, /\(\+7 earlier/);
  assert.equal(clip('a'.repeat(50), 10).length, 10);
});

test('webhook payloads keep the answer and the card, drop the rest, and point to ab context', () => {
  const full = { event: 'decision.answered', decision_id: 'd1', card_ref: null, question: 'Q?', answer: 'custom', answer_label: 'My words', custom_text: 'My words ' + 'y'.repeat(2000), answered_by: 'app', answered_at: 't', to_bot: 'QA', junk: 'z'.repeat(5000) };
  const s = slimPayload(full, 'QA');
  assert.equal(s.junk, undefined);
  assert.equal(s.answered_by, undefined);
  assert.equal(s.custom_text, full.custom_text); // Eric's words are never clipped
  assert.equal(s.read_more, 'ab context --bot QA');
  const clarify = slimPayload({ event: 'decision.clarify', decision_id: 'd', question: 'Q', context: 'c'.repeat(800), clicked_at: 't' }, 'Planner');
  assert.equal(clarify.context, undefined);
  assert.deepEqual(slimPayload({ event: 'other', a: 1 }, null), { event: 'other', a: 1 });
});

const ab = (dbPath: string, ...args: string[]) =>
  execFileSync(process.execPath, ['bin/ab.mjs', ...args], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_FILE: '', AGENT_BOARD_TIMEZONE: 'America/New_York' }, encoding: 'utf8' });

test('ab context reads the database, marks the shown messages read, and --no-mark leaves them', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-ctx-')), 'board.db');
  const db = open(dbPath);
  db.prepare('INSERT INTO ui_doc (key, json, updated_at) VALUES (?, ?, ?)').run('board', JSON.stringify(board()), 'now');
  const reads = () => db.prepare('SELECT item_key FROM ui_item_read ORDER BY item_key').all().map((r: any) => r.item_key);
  assert.match(ab(dbPath, 'context', '--bot', 'Planner', '--no-mark'), /OPEN CARDS \(1\)/);
  assert.deepEqual(reads(), []);
  const first = ab(dbPath, 'context', '--bot', 'Planner');
  assert.match(first, /NEW .*picked planner/);
  assert.deepEqual(reads(), ['decision:planner-a', 'decision:planner-closed', 'ticket:ROWS-1']);
  assert.doesNotMatch(ab(dbPath, 'context', '--bot', 'Planner', '--no-mark'), /NEW/);
  assert.match(ab(dbPath, 'context', '--bot', 'Planner', '--full'), /planner-closed \[medium, closed\]/);
  assert.throws(() => ab(dbPath, 'context', '--bot', 'Nobody'));
});

test('ab open is one compact line by default and the old pretty view with --full', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-open-')), 'board.db');
  open(dbPath).prepare('INSERT INTO ui_doc (key, json, updated_at) VALUES (?, ?, ?)').run('board', JSON.stringify({ ...board(), glance: { waiting: [], tickets: [], others: [] }, updated_at: 'x' }), 'now');
  const compact = ab(dbPath, 'open');
  assert.equal(compact.trim().split('\n').length, 1);
  assert.deepEqual(JSON.parse(compact).open_on_board, ['planner-a', 'qa-a']);
  const pretty = ab(dbPath, 'open', '--full');
  assert.ok(pretty.split('\n').length > 5);
  assert.ok(pretty.length > compact.length);
});
