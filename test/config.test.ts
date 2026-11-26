import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadServerConfig, loadWebhookConfig, resolveAuthor } from '../src/config.ts';

test('defaults apply when the env is empty', () => {
  assert.deepEqual(loadServerConfig({}), { dbPath: './agent-board.db', port: 8787, githubWebhookSecret: null, webhook: null });
});

test('PORT must be an integer from 1 to 65535', () => {
  for (const bad of ['abc', '0', '70000', '80.5', '-1', '8o']) {
    assert.throws(() => loadServerConfig({ PORT: bad }), (e: Error) => e instanceof ConfigError && /PORT must be an integer/.test(e.message) && e.message.includes(bad));
  }
  assert.equal(loadServerConfig({ PORT: '3000' }).port, 3000);
});

test('an empty AGENT_BOARD_DB or an empty GITHUB_WEBHOOK_SECRET fails clearly', () => {
  assert.throws(() => loadServerConfig({ AGENT_BOARD_DB: '  ' }), /AGENT_BOARD_DB must not be empty/);
  assert.throws(() => loadServerConfig({ GITHUB_WEBHOOK_SECRET: '' }), /GITHUB_WEBHOOK_SECRET is set but empty/);
  assert.equal(loadServerConfig({ GITHUB_WEBHOOK_SECRET: 's' }).githubWebhookSecret, 's');
});

test('wake webhook: unset is disabled, a bad URL or lone auth fails, a good pair loads', () => {
  assert.equal(loadWebhookConfig({}), null);
  assert.equal(loadWebhookConfig({ AGENT_BOARD_WEBHOOK_URL: '   ' }), null);
  assert.throws(() => loadWebhookConfig({ AGENT_BOARD_WEBHOOK_URL: 'not a url' }), /not a valid URL/);
  assert.throws(() => loadWebhookConfig({ AGENT_BOARD_WEBHOOK_URL: 'ftp://x.test/h' }), /http or https/);
  assert.throws(() => loadWebhookConfig({ AGENT_BOARD_WEBHOOK_AUTH: 'Bearer x' }), /AUTH is set but AGENT_BOARD_WEBHOOK_URL is not/);
  assert.deepEqual(loadWebhookConfig({ AGENT_BOARD_WEBHOOK_URL: 'https://hooks.example.test/wake', AGENT_BOARD_WEBHOOK_AUTH: 'Bearer abc' }), { url: 'https://hooks.example.test/wake', auth: 'Bearer abc' });
});

test('a webhook config error never echoes the URL or auth value', () => {
  try {
    loadWebhookConfig({ AGENT_BOARD_WEBHOOK_URL: 'ftp://user:topsecret@x.test/h', AGENT_BOARD_WEBHOOK_AUTH: 'Bearer topsecret' });
    assert.fail('should throw');
  } catch (e) {
    assert.doesNotMatch((e as Error).message, /topsecret|x\.test/);
  }
});

test('CLI identity: --bot beats AGENT_BOT; missing or unknown fails with the allowed list', () => {
  assert.equal(resolveAuthor('qa', { AGENT_BOT: 'planner' }), 'qa');
  assert.equal(resolveAuthor(undefined, { AGENT_BOT: 'planner' }), 'planner');
  assert.throws(() => resolveAuthor(undefined, {}), /--bot or AGENT_BOT is required/);
  assert.throws(() => resolveAuthor('mallory', {}), /must be one of planner, engineer, qa, ops, chief, human, script, got "mallory"/);
});
