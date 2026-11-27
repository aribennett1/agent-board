import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/db.ts';
import { inShabbos, makeRewakeSend, REWAKE_AFTER_MS, runRewakes, type RewakePayload } from '../src/rewake.ts';

type Json = Record<string, any>;
const T0 = Date.parse('2026-11-26T10:00:00.000Z'); // Thursday 5 AM ET
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

function setup(board: Json, sendOk = true) {
  const db = open(':memory:');
  db.prepare("INSERT INTO ask_rewake_meta (key, value) VALUES ('since', ?)").run(iso(T0 - 60 * MIN));
  const put = (b: Json) => db.prepare("INSERT OR REPLACE INTO ui_doc (key, json, updated_at) VALUES ('board', ?, 'now')").run(JSON.stringify(b));
  put(board);
  const sent: RewakePayload[] = [];
  let ok = sendOk;
  const send = async (p: RewakePayload) => (sent.push(p), ok);
  const log = (e: Json) => db.prepare('INSERT INTO ui_log (json) VALUES (?)').run(JSON.stringify(e));
  const notes = () => db.prepare('SELECT * FROM ui_notifications ORDER BY id').all() as Json[];
  const run = (ms: number) => runRewakes(db, new Date(ms), send);
  return { db, put, sent, send, log, notes, run, setOk: (v: boolean) => void (ok = v) };
}

const card = (id: string, extra: Json = {}) => ({ id, title: id, question: 'Push it?', options: [], ...extra });
const answer = (id: string, at: number, extra: Json = {}) => ({ id: `${id}:answer`, at: iso(at), item_key: `decision:${id}`, label: 'Push the cap fix', kind: 'answer', text: 'Push 7d4f3f241', to_bot: 'Engineer', ...extra });
const draftNote = (at: number) => ({ id: `review:rows-backend#1994:c3:note:${iso(at)}`, at: iso(at), item_key: 'pr:rows-backend/1994', label: 'rows-backend #1994', link: 'https://github.com/ROWSHR/rows-backend/pull/1994', kind: 'review', text: 'Note on c3: Nope, we only say updateQuietly(), remember?', ref: 'rows-backend#1994:c3' });
const draft = (status = 'pending') => ({ repo: 'rows-backend', pr: 1994, verdict: 'v', comments: [{ id: 'c3', severity: 'low', path: 'a.php', line: 1, body: 'x', status }] });

test('no bot write 30 minutes after his answer: that bot is re-woken once, he gets one notification, and a restart never repeats it', async () => {
  const e = setup({ decisions: [card('engineer-pr-1838-push')], asks: [answer('engineer-pr-1838-push', T0)] });
  assert.deepEqual(await e.run(T0 + REWAKE_AFTER_MS - MIN), []);
  assert.equal(e.sent.length, 0);
  assert.deepEqual(await e.run(T0 + REWAKE_AFTER_MS + MIN), ['engineer-pr-1838-push:answer']);
  assert.equal(e.sent.length, 1);
  const p = e.sent[0];
  assert.equal(p.event, 'ask.rewake');
  assert.equal(p.to_bot, 'Engineer');
  assert.equal(p.item_key, 'decision:engineer-pr-1838-push');
  assert.deepEqual(p.asks.map((a) => a.text), ['Push 7d4f3f241']);
  assert.match(p.instruction, /only reminder/);
  const n = e.notes();
  assert.equal(n.length, 1);
  assert.match(n[0].text, /^Re-woke Engineer on Push the cap fix: .*"Push 7d4f3f241"\. Nothing needed from you\.$/);
  await e.run(T0 + 3 * REWAKE_AFTER_MS);
  const again = await runRewakes(open(':memory:'), new Date(T0), e.send); // an unrelated board does nothing
  assert.deepEqual(again, []);
  await runRewakes(e.db, new Date(T0 + 10 * REWAKE_AFTER_MS), e.send);
  assert.equal(e.sent.length, 1, 'one re-wake per answer, ever');
  assert.equal(e.notes().length, 1);
});

test('a reply, a review-status, a rewritten draft, a clear or a follow-up card in the same group counts as handled', async () => {
  const cases: [string, (e: ReturnType<typeof setup>) => void][] = [
    ['thread reply', (e) => e.put({ decisions: [card('c1')], asks: [answer('c1', T0)], details: { 'decision:c1': { thread: [{ at: iso(T0 + MIN), from: 'bot', text: 'Pushed.' }] } } })],
    ['ab clear', (e) => e.log({ at: iso(T0 + MIN), op: 'clear', id: 'c1' })],
    ['follow-up card', (e) => {
      e.put({ decisions: [card('c1', { group: 'PR 1838' }), card('c1-2', { group: 'PR 1838' })], asks: [answer('c1', T0)] });
      e.log({ at: iso(T0 + MIN), op: 'raise', id: 'c1-2', live: true });
    }],
    ['notify linking it', (e) => {
      e.put({ decisions: [card('c1')], asks: [answer('c1', T0, { link: 'https://github.com/ROWSHR/rows-backend/pull/1838' })] });
      e.db.prepare('INSERT INTO ui_notifications (bot, text, link, created_at) VALUES (?, ?, ?, ?)').run('Engineer', 'Pushed', 'https://github.com/ROWSHR/rows-backend/pull/1838', iso(T0 + MIN));
    }],
  ];
  for (const [name, act] of cases) {
    const e = setup({ decisions: [card('c1')], asks: [answer('c1', T0)] });
    act(e);
    assert.deepEqual(await e.run(T0 + REWAKE_AFTER_MS + MIN), [], name);
    assert.equal(e.sent.length, 0, name);
    assert.equal(e.notes().filter((n) => n.bot === 'Grok Bot').length, 0, name);
  }
  // A Reviews-tab draft note goes to QA, and review-status or a rewrite on that PR handles it.
  for (const act of [
    (e: ReturnType<typeof setup>) => e.log({ at: iso(T0 + MIN), op: 'review-status', pr: 'rows-backend#1994', comment: 'c3' }),
    (e: ReturnType<typeof setup>) => e.log({ at: iso(T0 + MIN), op: 'reviews', count: 1, prs: ['rows-backend#1994'], replace: false, live: true }),
    (e: ReturnType<typeof setup>) => e.put({ decisions: [], reviews: [{ ...draft(), comments: [{ ...draft().comments[0], revision_at: iso(T0 + MIN) }] }], asks: [draftNote(T0)] }),
  ]) {
    const e = setup({ decisions: [], reviews: [draft()], asks: [draftNote(T0)] });
    act(e);
    assert.deepEqual(await e.run(T0 + REWAKE_AFTER_MS + MIN), []);
  }
  const e = setup({ decisions: [], reviews: [draft()], asks: [draftNote(T0)] });
  e.log({ at: iso(T0 - MIN), op: 'review-status', pr: 'rows-backend#1994', comment: 'c3' }); // before his note: does not count
  e.log({ at: iso(T0 + MIN), op: 'reply', key: 'pr:rows-backend/1986' }); // another PR: does not count
  await e.run(T0 + REWAKE_AFTER_MS + MIN);
  assert.deepEqual(e.sent.map((p) => [p.to_bot, p.item_key]), [['QA', 'pr:rows-backend/1994']]);
});

test('a closed item is never re-woken: card gone or superseded, draft comment posted or skipped', async () => {
  for (const board of [
    { decisions: [], asks: [answer('c1', T0)] },
    { decisions: [card('c1', { superseded_by: 'c2' })], asks: [answer('c1', T0)] },
    { decisions: [], reviews: [draft('posted')], asks: [draftNote(T0)] },
    { decisions: [], reviews: [draft('skipped')], asks: [draftNote(T0)] },
  ]) {
    const e = setup(board);
    assert.deepEqual(await e.run(T0 + REWAKE_AFTER_MS + MIN), []);
    assert.equal(e.sent.length, 0);
  }
});

test('several answers on one item from him make one re-wake that carries all his words', async () => {
  const e = setup({ decisions: [], reviews: [draft()], asks: [draftNote(T0), { ...draftNote(T0 + MIN), id: 'review:rows-backend#1994:c3:note:2', text: 'Note on c3: and keep the suggestion' }] });
  await e.run(T0 + REWAKE_AFTER_MS + 2 * MIN);
  assert.equal(e.sent.length, 1);
  assert.equal(e.sent[0].asks.length, 2);
  assert.equal(e.notes().length, 1);
});

test('Shabbos: nothing fires Friday 1 PM to Saturday 9 PM ET; a deadline inside waits until it ends', async () => {
  assert.equal(inShabbos(new Date('2026-11-27T17:59:00Z')), false); // Fri 12:59 PM ET
  assert.equal(inShabbos(new Date('2026-11-27T18:00:00Z')), true); // Fri 1 PM ET
  assert.equal(inShabbos(new Date('2026-11-29T01:59:00Z')), true); // Sat 8:59 PM ET
  assert.equal(inShabbos(new Date('2026-11-29T02:00:00Z')), false); // Sat 9 PM ET
  const fri = Date.parse('2026-11-27T17:45:00Z'); // Fri 12:45 PM ET
  const e = setup({ decisions: [card('c1')], asks: [answer('c1', fri)] });
  await e.run(fri + REWAKE_AFTER_MS);
  await e.run(Date.parse('2026-11-28T18:00:00Z'));
  assert.equal(e.sent.length, 0);
  await e.run(Date.parse('2026-11-29T02:01:00Z'));
  assert.equal(e.sent.length, 1);
});

test('answers from before the backstop first ran, Not relevant clicks and task cards never count', async () => {
  const e = setup({ decisions: [card('c1'), card('c2')], asks: [answer('c1', T0 - 2 * 60 * MIN), { ...answer('c2', T0), id: 'c2:not-relevant', kind: 'click' }] });
  assert.deepEqual(await e.run(T0 + 5 * REWAKE_AFTER_MS), []);
  const fresh = open(':memory:');
  fresh.prepare("INSERT INTO ui_doc (key, json, updated_at) VALUES ('board', ?, 'now')").run(JSON.stringify({ decisions: [card('c1')], asks: [answer('c1', T0)] }));
  assert.deepEqual(await runRewakes(fresh, new Date(T0 + 5 * REWAKE_AFTER_MS), e.send), [], 'the first pass sets the start; older answers are skipped');
});

test('a refused webhook is retried on the next passes, then gives up with one notification; no second re-wake after success', async () => {
  const e = setup({ decisions: [card('c1')], asks: [answer('c1', T0)] }, false);
  for (let i = 1; i <= 5; i++) await e.run(T0 + REWAKE_AFTER_MS + i * MIN);
  assert.equal(e.sent.length, 3);
  const n = e.notes();
  assert.equal(n.length, 1);
  assert.match(n[0].text, /^Could not re-wake Engineer/);
  const f = setup({ decisions: [card('c1')], asks: [answer('c1', T0)] }, false);
  await f.run(T0 + REWAKE_AFTER_MS + MIN);
  f.setOk(true);
  await f.run(T0 + REWAKE_AFTER_MS + 2 * MIN);
  await f.run(T0 + REWAKE_AFTER_MS + 3 * MIN);
  assert.equal(f.sent.length, 2);
  assert.equal(f.notes().length, 1);
});

test('once the re-woken bot writes on the item, the notification clears itself', async () => {
  const e = setup({ decisions: [card('c1')], asks: [answer('c1', T0)] });
  await e.run(T0 + REWAKE_AFTER_MS + MIN);
  assert.equal(e.notes()[0].cleared_at, null);
  e.log({ at: iso(T0 + REWAKE_AFTER_MS + 2 * MIN), op: 'reply', key: 'decision:c1' });
  await e.run(T0 + REWAKE_AFTER_MS + 3 * MIN);
  assert.ok(e.notes()[0].cleared_at);
  assert.equal(e.sent.length, 1);
});

test('the re-wake goes to the bot\'s own webhook (Grok Bot to its board webhook), and the delivery log holds no URL or secret', async () => {
  const db = open(':memory:');
  const envFile = join(mkdtempSync(join(tmpdir(), 'ab-env-')), '.env');
  writeFileSync(envFile, 'AB_WEBHOOK_URL_QA=https://qa.example.test/q-secret\nAB_WEBHOOK_SECRET_QA=Bearer qa-secret\nAGENT_BOARD_WEBHOOK_URL=https://grok.example.test/g-secret\nAGENT_BOARD_WEBHOOK_AUTH=Bearer grok-secret\n');
  const up: Json[] = [];
  const send = makeRewakeSend(db, { envFile, fetchImpl: (async (url: string, init: Json) => (up.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }), { ok: true, status: 200 })) as any });
  const p = (bot: any) => ({ event: 'ask.rewake' as const, to_bot: bot, item_key: 'pr:rows-backend/1994', item: 'x', link: null, asks: [], instruction: 'i', read_more: 'r' });
  assert.equal(await send(p('QA')), true);
  assert.equal(await send(p('Grok Bot')), true);
  assert.deepEqual(up.map((u) => [u.url, u.auth]), [['https://qa.example.test/q-secret', 'Bearer qa-secret'], ['https://grok.example.test/g-secret', 'Bearer grok-secret']]);
  assert.equal(await send(p('Planner')), false, 'a bot with no hook gets nothing, never Grok Bot');
  assert.equal(up.length, 2);
  const logged = (db.prepare('SELECT json FROM ui_delivery_log').all() as Json[]).map((r) => r.json).join('\n');
  assert.doesNotMatch(logged, /secret|example\.test/);
  assert.match(logged, /"event":"ask.rewake","item_key":"pr:rows-backend\/1994"/);
});
