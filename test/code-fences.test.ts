import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.ts';
import { applyCodeFences, cardCodeFenceError, fenceBareCode, unfencedCodeError } from '../src/code-fences.ts';

test('fenceBareCode wraps a language-tagged snippet and leaves real fences and prose alone', () => {
  const bare = 'php $code = DeductionPayCode::query()->lockForUpdate()->findOrFail($id); if ($code->amount === null) { throw ValidationException::withMessages(["amount" => "required"]); }';
  const fenced = fenceBareCode(bare);
  assert.match(fenced, /^```php\n/);
  assert.match(fenced, /lockForUpdate\(\)->findOrFail\(\$id\);/);
  assert.ok(fenced.endsWith('\n```'));
  assert.ok(!fenced.startsWith('```php\nphp '));

  const already = '```php\n$code = 1;\n```';
  assert.equal(fenceBareCode(already), already);

  const prose = 'The save locks the pay code and reads it again.';
  assert.equal(fenceBareCode(prose), prose);

  const inlineMention = 'Use lockForUpdate on the row, then re-check amount and payee.';
  assert.equal(fenceBareCode(inlineMention), inlineMention);
});

test('fenceBareCode wraps a list item that starts with a language tag', () => {
  const text = 'Today the check is loose.\n- php $code = DeductionPayCode::query()->lockForUpdate()->findOrFail($id);\n- Then we save.';
  const out = fenceBareCode(text);
  assert.match(out, /```php\n\s+\$code = DeductionPayCode::query\(\)->lockForUpdate/);
  assert.match(out, /Then we save/);
});

test('unfencedCodeError rejects a bare multi-line dump and accepts fences and prose', () => {
  const dump = '$code = DeductionPayCode::query()->lockForUpdate()->findOrFail($id);\nif (($validated["amount"] ?? $code->amount) === null) {\n    throw ValidationException::withMessages(["amount" => "required"]);\n}';
  assert.equal(unfencedCodeError(dump, 'details[1].items[1]'), 'details[1].items[1]: put code in a fenced ```php block');
  assert.equal(unfencedCodeError('```php\n' + dump + '\n```'), null);
  assert.equal(unfencedCodeError('The first read is kept on the request. That is the earlier copy.'), null);
});

test('applyCodeFences rewrites a details item and cardCodeFenceError then passes', () => {
  const d = {
    title: 'Locked re-read',
    context: 'Validation reads the pay code once, with no lock.',
    details: [
      { label: 'The small change for #3', items: ['php $code = DeductionPayCode::query()->lockForUpdate()->findOrFail($id); if ($code->amount === null) { throw new Exception("empty"); }'] },
    ],
  };
  applyCodeFences(d);
  const item = (d.details[0] as { items: string[] }).items[0];
  assert.match(item, /^```php\n\$code = DeductionPayCode/);
  assert.equal(cardCodeFenceError(d), null);
});

const ab = (dbPath: string, ...args: string[]) => {
  try {
    return { code: 0, out: JSON.parse(execFileSync(process.execPath, ['bin/ab.mjs', ...args], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_FILE: '' }, encoding: 'utf8' })), stderr: '' };
  } catch (err: any) {
    return { code: typeof err.status === 'number' ? err.status : 1, out: null, stderr: String(err.stderr ?? '') };
  }
};

const fresh = () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-fences-')), 'board.db');
  open(dbPath).close();
  return dbPath;
};

const valid = (extra: Record<string, unknown> = {}) => ({
  id: 'planner-fences-ok',
  title: 'Locked re-read on the pay code',
  context: 'Validation reads the pay code once, with no lock, then the save locks it and reads it again.',
  question: 'Should we re-check amount and payee after the locked read?',
  what_happens_after: 'The assistant makes the change and raises a push card.',
  options: [{ id: 'a', label: 'Yes' }, { id: 'b', label: 'Hold' }],
  priority: 'medium',
  group: 'ROWS-5207',
  card_ref: 'https://linear.app/rows/issue/ROWS-5207/checkout-images',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
  ...extra,
});

test('ab raise wraps a language-tagged details item and stores the fence', () => {
  const db = fresh();
  const r = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid({
    details: [
      { label: 'The small change', items: ['php $code = DeductionPayCode::query()->lockForUpdate()->findOrFail($id); if ($code->amount === null) { throw new Exception("empty"); }'] },
    ],
  })));
  assert.equal(r.code, 0, r.stderr);
  const row = open(db).prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string };
  const card = JSON.parse(row.json).decisions[0];
  assert.match(card.details[0].items[0], /^```php\n\$code = DeductionPayCode/);
});

test('ab raise rejects a bare multi-line code dump with a clear fence error', () => {
  const db = fresh();
  const dump = '$code = DeductionPayCode::query()->lockForUpdate()->findOrFail($id);\nif ($code->amount === null) {\n    throw new Exception("empty");\n}';
  const r = ab(db, 'raise', '--bot', 'Planner', JSON.stringify(valid({
    details: [{ label: 'The small change', items: [dump] }],
  })));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /put code in a fenced ```php block/);
  const row = open(db).prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json?: string } | undefined;
  assert.ok(!row?.json || JSON.parse(row.json).decisions.length === 0);
});
