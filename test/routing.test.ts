import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.ts';
import { parseEnv } from '../src/routing.ts';
import { env } from './helpers.ts';

const DEFAULT_HOOK = { url: 'https://grok.example.test/default-secret-path', auth: 'Bearer grok-secret' };
const envText = (extra: Record<string, string>) => Object.entries(extra).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
const BOTS = {
  AB_WEBHOOK_URL_PLANNER: 'https://planner.example.test/p-secret', AB_WEBHOOK_SECRET_PLANNER: 'Bearer planner-secret',
  AB_WEBHOOK_URL_QA: 'https://qa.example.test/q-secret', AB_WEBHOOK_SECRET_QA: 'Bearer qa-secret',
  AB_WEBHOOK_URL_EGGBOT: 'https://egg.example.test/e-secret', AB_WEBHOOK_SECRET_EGGBOT: 'Bearer egg-secret',
};

function setup(vars: Record<string, string>) {
  const e = env();
  const envFile = join(mkdtempSync(join(tmpdir(), 'ab-env-')), '.env');
  writeFileSync(envFile, envText(vars));
  const up: { url: string; auth?: string; body: any }[] = [];
  const app = createApp(e.db, e.clock, {
    ui: { webhook: DEFAULT_HOOK, envFile, timeZone: 'UTC', runAb: async () => ({ code: 0 }), fetchImpl: async (url, init) => (up.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }), { ok: true, status: 200 }) },
  });
  const post = (body: unknown) => app.request('/__ab/webhook', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Host: 'board.test' } });
  const put = (doc: unknown) => e.db.prepare('INSERT OR REPLACE INTO ui_doc (key, json, updated_at) VALUES (?, ?, ?)').run('board', JSON.stringify(doc), 'now');
  return { ...e, app, up, post, put, envFile };
}
const card = (id: string, extra: object = {}) => ({ id, title: id, context: 'c', question: 'q?', what_happens_after: 'w', options: [], ...extra });
const answer = (id: string, extra: object = {}) => ({ event: 'decision.answered', decision_id: id, answer: 'a', answer_label: 'A', ...extra });

test('parseEnv reads KEY=VALUE lines, quotes and export, and skips comments', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nexport B="two"\n  C = \'3\'\nnot a line\n'), { A: '1', B: 'two', C: '3' });
});

test('an answer goes to the webhook of the bot that raised the card, never to Grok Bot', async () => {
  const e = setup(BOTS);
  e.put({ decisions: [card('d1', { raised_by: 'Planner' }), card('qa-check-1'), card('e1', { agent: 'dr eggbot' })], glance: { waiting: [], tickets: [] } });
  assert.equal((await e.post(answer('d1'))).status, 200);
  assert.equal((await e.post(answer('qa-check-1'))).status, 200);
  assert.equal((await e.post(answer('e1'))).status, 200);
  assert.deepEqual(e.up.map((u) => [u.url, u.auth]), [
    [BOTS.AB_WEBHOOK_URL_PLANNER, BOTS.AB_WEBHOOK_SECRET_PLANNER],
    [BOTS.AB_WEBHOOK_URL_QA, BOTS.AB_WEBHOOK_SECRET_QA],
    [BOTS.AB_WEBHOOK_URL_EGGBOT, BOTS.AB_WEBHOOK_SECRET_EGGBOT],
  ]);
  assert.equal(e.up[0].body.decision_id, 'd1');
});

test('a card the Planner filed a ticket or plan on routes to the Planner', async () => {
  const e = setup(BOTS);
  e.put({ decisions: [card('rows-1-intake', { group: 'ROWS-1' })], details: { 'ticket:ROWS-1': { plan: '# plan' } }, glance: { waiting: [], tickets: [] } });
  await e.post(answer('rows-1-intake'));
  assert.equal(e.up[0].url, BOTS.AB_WEBHOOK_URL_PLANNER);
});

test('unknown author, or a bot with no key yet, falls back to the Grok Bot webhook', async () => {
  const e = setup({ AB_WEBHOOK_URL_PLANNER: BOTS.AB_WEBHOOK_URL_PLANNER });
  e.put({ decisions: [card('mystery'), card('engineer-x')], glance: { waiting: [], tickets: [] } });
  await e.post(answer('mystery'));
  await e.post(answer('engineer-x'));
  assert.deepEqual(e.up.map((u) => u.url), [DEFAULT_HOOK.url, DEFAULT_HOOK.url]);
  assert.equal(e.up[0].auth, DEFAULT_HOOK.auth);
});

test('a bot added to .env after the server started is used with no restart', async () => {
  const e = setup({});
  e.put({ decisions: [card('qa-late')], glance: { waiting: [], tickets: [] } });
  await e.post(answer('qa-late'));
  assert.equal(e.up[0].url, DEFAULT_HOOK.url);
  writeFileSync(e.envFile, envText(BOTS));
  utimesSync(e.envFile, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  await e.post(answer('qa-late', { answered_at: 'later' }));
  assert.equal(e.up[1].url, BOTS.AB_WEBHOOK_URL_QA);
});

test('to_bot in the payload picks the recipient over the card author', async () => {
  const e = setup(BOTS);
  e.put({ decisions: [card('d1', { raised_by: 'Planner' })], glance: { waiting: [], tickets: [] } });
  await e.post(answer('d1', { to_bot: 'QA' }));
  await e.post({ event: 'item.message', message_id: 'm1', item_id: 'd1', item_section: 'decision', text: 'hi', to_bot: 'dr eggbot' });
  await e.post({ event: 'item.message', message_id: 'm2', item_id: 'd1', item_section: 'decision', text: 'hi' });
  assert.deepEqual(e.up.map((u) => u.url), [BOTS.AB_WEBHOOK_URL_QA, BOTS.AB_WEBHOOK_URL_EGGBOT, BOTS.AB_WEBHOOK_URL_PLANNER]);
  assert.equal(e.up[0].body.to_bot, 'QA');
  // an unknown to_bot is ignored and the author still wins
  await e.post(answer('d1', { to_bot: 'Nobody', answered_at: 'x' }));
  assert.equal(e.up[3].url, BOTS.AB_WEBHOOK_URL_PLANNER);
});

test('picking Grok Bot, or any bot with no key, uses the default webhook; the reply never shows a URL or secret', async () => {
  const e = setup({});
  e.put({ decisions: [card('d1')], glance: { waiting: [], tickets: [] } });
  const r = await e.post(answer('d1', { to_bot: 'Grok Bot' }));
  assert.equal(e.up[0].url, DEFAULT_HOOK.url);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { status: 200 });
  for (const secret of [DEFAULT_HOOK.url, DEFAULT_HOOK.auth, ...Object.values(BOTS)]) assert.ok(!text.includes(secret));
});

test('a failing bot webhook is reported and does not fall back to Grok Bot', async () => {
  const e = env();
  const envFile = join(mkdtempSync(join(tmpdir(), 'ab-env-')), '.env');
  writeFileSync(envFile, envText(BOTS));
  const urls: string[] = [];
  const app = createApp(e.db, e.clock, { ui: { webhook: DEFAULT_HOOK, envFile, runAb: async () => ({ code: 0 }), fetchImpl: async (url) => (urls.push(url), { ok: false, status: 500 }) } });
  const r = await app.request('/__ab/webhook', { method: 'POST', body: JSON.stringify(answer('qa-x')), headers: { 'Content-Type': 'application/json', Host: 'board.test' } });
  assert.deepEqual(await r.json(), { status: 500 });
  assert.deepEqual(urls, [BOTS.AB_WEBHOOK_URL_QA]);
});
