import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/db.ts';
import { carryDeclined, declinedOf, matchesDeclined, suggestionOf } from '../src/declined.ts';

const PATH = 'app/Http/Resources/PositionsAndPay/PayrollDetailsOptionsResource.php';
const BODY = 'The ticket wants Auto Pay to default by pay type.\n\n```suggestion\n$data[\'auto_pay_default\'] = $isSalaried;\n```';
const skipped = { id: 'c1', severity: 'high', title: 'The Hourly = No / Salaried = Yes default is not built', path: PATH, line: 141, body: BODY, status: 'skipped', note: "Eric turned this down earlier: don't denormalize fields the frontend can derive" };
const fresh = (over: Record<string, unknown> = {}): Record<string, any> => ({ id: 'c7', severity: 'high', path: PATH, line: 141, title: 'Something else', body: 'Different words entirely about naming.', status: 'pending', ...over });

test('a new finding with the same title on the same file is filed as skipped with his earlier note', () => {
  const known = declinedOf({ comments: [skipped] });
  const r = carryDeclined(known, [fresh({ line: 300, title: 'the hourly = no / salaried = yes default is NOT built' })]);
  assert.equal(r.carried, 1);
  assert.equal(r.comments[0].status, 'skipped');
  assert.equal(r.comments[0].note, skipped.note);
});

test('the same suggestion text matches even when the title and line differ', () => {
  const known = declinedOf({ comments: [skipped] });
  const r = carryDeclined(known, [fresh({ line: 12, body: 'Reworded.\n\n```suggestion\n  $data[ "auto_pay_default" ]  =  $isSalaried;\n```'.replace(/"/g, "'") })]);
  assert.equal(r.comments[0].status, 'skipped');
});

test('a nearby line matches only when the body says about the same thing', () => {
  const known = declinedOf({ comments: [skipped] });
  const same = fresh({ line: 143, body: 'The ticket wants Auto Pay to default by pay type, not built yet.' });
  assert.equal(matchesDeclined(same, known[0]), true);
  assert.equal(matchesDeclined(fresh({ line: 143 }), known[0]), false);
});

test('a different file, a far-away different finding, a posted finding and a GitHub deletion are left alone', () => {
  const known = declinedOf({ comments: [skipped] });
  assert.equal(carryDeclined(known, [fresh({ path: 'app/Other.php', title: skipped.title })]).carried, 0);
  assert.equal(carryDeclined(known, [fresh({ line: 400 })]).carried, 0);
  assert.equal(carryDeclined(known, [fresh({ title: skipped.title, status: 'posted' })]).comments[0].status, 'posted');
  assert.equal(declinedOf({ comments: [{ ...skipped, note: 'deleted on GitHub (found today)' }] }).length, 0);
});

test('suggestionOf normalizes whitespace and case', () => {
  assert.equal(suggestionOf('x\n```suggestion\n  Foo( 1 )\n```'), suggestionOf('```suggestion\nfoo(1)\n```'));
  assert.equal(suggestionOf('no block'), '');
});

const ab = (dbPath: string, input: unknown) =>
  execFileSync(process.execPath, ['bin/ab.mjs', 'reviews', JSON.stringify(input)], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_FILE: '' }, encoding: 'utf8' });

const stored = (dbPath: string) => {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string };
  db.close();
  return JSON.parse(row.json).reviews;
};

test('ab reviews: a later pass cannot reopen a skipped finding, even after a pass that dropped it', () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'ab-declined-')), 'board.db');
  open(dbPath).close();
  const pass = (comments: unknown[]) => [{ repo: 'rows-backend', pr: 2019, verdict: 'Changes needed', comments }];
  const { status: _s, note: _n, id: _i, ...rest } = skipped;
  ab(dbPath, pass([{ ...rest, id: 'c1', status: 'skipped', note: skipped.note }]));
  ab(dbPath, pass([{ ...rest, id: 'c1', status: 'pending' }]));
  let c = stored(dbPath)[0].comments;
  assert.equal(c[0].status, 'skipped');
  assert.equal(c[0].note, skipped.note);
  ab(dbPath, pass([{ ...rest, id: 'c2', title: 'Other issue', line: 9, path: 'app/X.php', body: 'Unrelated', status: 'pending' }]));
  ab(dbPath, pass([{ ...rest, id: 'c3', status: 'pending', line: 150, title: 'Default not built' }, { ...rest, id: 'c4', path: 'app/Y.php', status: 'pending' }]));
  c = stored(dbPath)[0].comments;
  assert.equal(c.find((x: any) => x.id === 'c3').status, 'skipped');
  assert.equal(c.find((x: any) => x.id === 'c4').status, 'pending');
});
