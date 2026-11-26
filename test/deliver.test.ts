import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from '../src/db.ts';
import { deliveryLogEntry, deliverToBot } from '../src/deliver.ts';
import { attentionPayload, ENGINEER_INSTRUCTION, makeEngineerAttentionWake } from '../src/attention.ts';

const ENGINEER_URL = 'https://engineer.example.test/e-secret-path';
const ENGINEER_AUTH = 'Bearer engineer-secret';
const GROK_URL = 'https://grok.example.test/default-secret-path';
const GROK_AUTH = 'Bearer grok-secret';
const SECRETS = [ENGINEER_URL, ENGINEER_AUTH, GROK_URL, GROK_AUTH];

function envFile(vars: Record<string, string>) {
  const path = join(mkdtempSync(join(tmpdir(), 'ab-env-')), '.env');
  writeFileSync(path, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  return path;
}

const payload = attentionPayload({ number: 2014, link: 'https://github.com/ROWSHR/rows-backend/pull/2014' }, ['failing checks (test)']);

test('deliveryLogEntry keeps only known fields for a pr.attention wake: no URL, auth, instruction or reasons', () => {
  const entry = deliveryLogEntry({
    event: 'pr.attention', pr: 2014, http: 200, via: 'direct', attempt: 1, status: 'delivered', at: 'now',
    link: payload.link, instruction: ENGINEER_INSTRUCTION, reasons: payload.reasons, url: ENGINEER_URL, auth: ENGINEER_AUTH,
  });
  assert.deepEqual(entry, { event: 'pr.attention', pr: 2014, http: 200, via: 'direct', attempt: 1, status: 'delivered', at: 'now' });
  assert.equal(deliveryLogEntry({ event: 'pr.attention', pr: 0, http: 200, via: 'direct', attempt: 1, status: 'delivered', at: 'now' }), null);
});

test('deliverToBot posts a slim payload to Engineer\'s webhook and logs the outcome without secrets', async () => {
  const db = open(':memory:');
  const up: { url: string; auth?: string; body: any }[] = [];
  const result = await deliverToBot(db, payload, {
    envFile: envFile({ AB_WEBHOOK_URL_ENGINEER: ENGINEER_URL, AB_WEBHOOK_SECRET_ENGINEER: ENGINEER_AUTH, AGENT_BOARD_WEBHOOK_URL: GROK_URL, AGENT_BOARD_WEBHOOK_AUTH: GROK_AUTH }),
    fetchImpl: async (url, init) => (up.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }), { ok: true, status: 200 }),
    now: () => new Date('2026-11-26T21:00:00Z'),
  });
  assert.equal(result, 'delivered');
  assert.equal(up.length, 1);
  assert.equal(up[0].url, ENGINEER_URL);
  assert.equal(up[0].auth, ENGINEER_AUTH);
  assert.equal(up[0].body.pr, 2014);
  assert.equal(up[0].body.link, payload.link);
  assert.deepEqual(up[0].body.reasons, ['failing checks (test)']);
  assert.equal(up[0].body.instruction, ENGINEER_INSTRUCTION);
  assert.equal(up[0].body.read_more, 'ab context --bot Engineer');
  assert.equal(up[0].body.to_bot, 'Engineer');
  const row = (db.prepare('SELECT json FROM ui_delivery_log').get() as { json: string }).json;
  assert.deepEqual(JSON.parse(row), { event: 'pr.attention', pr: 2014, http: 200, via: 'direct', attempt: 1, status: 'delivered', at: '2026-11-26T21:00:00.000Z' });
  for (const secret of SECRETS) assert.ok(!row.includes(secret), row);
});

test('deliverToBot does not fall back to Grok Bot when Engineer has no hook, and a failed fetch is logged without secrets', async () => {
  const db = open(':memory:');
  const up: string[] = [];
  const none = await deliverToBot(db, payload, {
    envFile: envFile({ AGENT_BOARD_WEBHOOK_URL: GROK_URL, AGENT_BOARD_WEBHOOK_AUTH: GROK_AUTH }),
    fetchImpl: async (url) => (up.push(url), { ok: true, status: 200 }),
    now: () => new Date('2026-11-26T21:00:00Z'),
  });
  assert.equal(none, 'failed');
  assert.deepEqual(up, []);
  const failed = await deliverToBot(db, payload, {
    envFile: envFile({ AB_WEBHOOK_URL_ENGINEER: ENGINEER_URL, AB_WEBHOOK_SECRET_ENGINEER: ENGINEER_AUTH }),
    fetchImpl: async () => { throw new Error(`boom ${ENGINEER_URL} ${ENGINEER_AUTH}`); },
    now: () => new Date('2026-11-26T21:01:00Z'),
  });
  assert.equal(failed, 'failed');
  const rows = (db.prepare('SELECT json FROM ui_delivery_log ORDER BY id').all() as { json: string }[]).map((r) => r.json);
  assert.deepEqual(JSON.parse(rows[0]), { event: 'pr.attention', pr: 2014, http: null, via: null, attempt: 1, status: 'failed', at: '2026-11-26T21:00:00.000Z' });
  assert.deepEqual(JSON.parse(rows[1]), { event: 'pr.attention', pr: 2014, http: null, via: 'direct', attempt: 1, status: 'failed', at: '2026-11-26T21:01:00.000Z' });
  for (const row of rows) for (const secret of SECRETS) assert.ok(!row.includes(secret), row);
});

test('makeEngineerAttentionWake throws when the webhook does not accept the wake, so the next tick can retry', async () => {
  const db = open(':memory:');
  const wake = makeEngineerAttentionWake(db, {
    envFile: envFile({ AB_WEBHOOK_URL_ENGINEER: ENGINEER_URL, AB_WEBHOOK_SECRET_ENGINEER: ENGINEER_AUTH }),
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(() => wake(payload), /engineer webhook did not accept the wake/);
  const row = (db.prepare('SELECT json FROM ui_delivery_log').get() as { json: string }).json;
  assert.equal(JSON.parse(row).status, 'failed');
  assert.equal(JSON.parse(row).http, 500);
  for (const secret of SECRETS) assert.ok(!row.includes(secret), row);
});
