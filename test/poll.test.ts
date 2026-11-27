import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNote, addTask } from '../src/board.ts';
import { boardVersion } from '../src/version.ts';
import { createApp } from '../src/server.ts';
import { env } from './helpers.ts';
const VERSION_RE = /^[a-f0-9]{64}$/;

function setup(state = 'waiting_human') {
  const e = env();
  addTask(e.db, { id: 'T1', title: 'Ship it', state }, e.clock);
  const app = createApp(e.db, e.clock);
  return { ...e, app };
}

test('GET /api/version returns a 64-char hash that stays put until content changes', async () => {
  const e = setup();
  const r1 = await e.app.request('/api/version');
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('cache-control'), 'no-store');
  const a = await r1.json();
  assert.match(a.version, VERSION_RE);
  assert.equal(a.version, boardVersion(e.db));
  assert.equal((await (await e.app.request('/api/version')).json()).version, a.version);
  addNote(e.db, { task: 'T1', author: 'human', kind: 'answer', body: 'go' }, e.clock);
  const b = (await (await e.app.request('/api/version')).json()).version;
  assert.match(b, VERSION_RE);
  assert.notEqual(b, a.version);
});

test('uiBuild names the main script from dist/index.html, or null when the UI is not built', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { uiBuild } = await import('../src/ui-routes.ts');
  const dir = mkdtempSync(join(tmpdir(), 'ab-dist-'));
  assert.equal(uiBuild(dir), null);
  writeFileSync(join(dir, 'index.html'), '<script type="module" crossorigin src="/assets/index-AbC_12.js"></script>');
  assert.equal(uiBuild(dir), '/assets/index-AbC_12.js');
});
