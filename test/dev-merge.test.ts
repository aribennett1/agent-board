import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTask } from '../src/board.ts';
import { DEFAULT_CHECKS, devMerge, type Check } from '../src/dev-merge.ts';
import { env } from './helpers.ts';

// Fixture commits/merges need an identity; never touch the user's git config.
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
function commit(cwd: string, file: string, body: string) {
  writeFileSync(join(cwd, file), body);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', `${file}`);
}

/**
 * Local-only fixture: a work repo with dev + feature branches, cloned --bare as "origin"
 * (the git guard refuses raw push), then cloned again as the checkout under test.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dev-merge-test-'));
  dirs.push(dir);
  const work = join(dir, 'work');
  git(dir, 'init', '-q', '-b', 'dev', work);
  commit(work, 'shared.txt', 'base\n');
  const branch = (name: string, file: string, body: string) => {
    git(work, 'checkout', '-q', '-b', name, 'dev');
    commit(work, file, body);
    git(work, 'checkout', '-q', 'dev');
  };
  branch('clean', 'feature.txt', 'feature\n');
  branch('conflict', 'shared.txt', 'branch side\n');
  branch('lint-bad', 'lint-bad', 'x\n');
  branch('test-bad', 'test-bad', 'x\n');
  commit(work, 'shared.txt', 'dev side\n'); // dev moves on
  branch('current', 'current.txt', 'already has dev\n');
  git(dir, 'clone', '-q', '--bare', work, join(dir, 'origin.git'));
  const repo = join(dir, 'repo');
  git(dir, 'clone', '-q', join(dir, 'origin.git'), repo);

  // Fake agent-board-hooks bin dir: ci and push only log "<name> <cwd> <args>", pushing nowhere.
  const log = join(dir, 'hooks.log');
  const hooksDir = join(dir, 'hooks');
  const script = (file: string, body: string) => (writeFileSync(file, `#!/bin/sh\n${body}\n`), chmodSync(file, 0o755));
  const makeHooks = () => {
    mkdirSync(hooksDir, { recursive: true });
    for (const name of ['ci', 'push']) script(join(hooksDir, name), `echo "${name} $(pwd -P) $*" >> '${log}'`);
  };
  makeHooks();
  const installCmd = join(dir, 'fake-install');
  script(installCmd, `echo "install $(pwd -P)" >> '${log}'\nmkdir -p '${hooksDir}'\nfor n in ci push; do printf '#!/bin/sh\\necho "%s $(pwd -P) $*" >> "${log}"\\n' $n > '${hooksDir}'/$n; chmod +x '${hooksDir}'/$n; done`);

  const ran = join(dir, 'ran.txt');
  const checks: Check[] = [
    { name: 'pint', cmd: `echo pint >> '${ran}'; test ! -f lint-bad || { echo 'pint: style errors'; exit 1; }` },
    { name: 'tests', cmd: `echo tests >> '${ran}'; test ! -f test-bad || sh -c 'echo boom; exit 1'` },
  ];
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n') : []);
  const e = env();
  return {
    ...e, repo,
    dir, hooksDir, makeHooks,
    log: () => read(log),
    /** branches the fake push was called for (cwd basename = worktree name) */
    pushed: () => read(log).filter((l) => l.startsWith('push ')).map((l) => l.split(' ')[1].split('/').at(-1)!),
    ran: () => read(ran),
    merge: (branches: string[], extra: { pushCmd?: string; stampCmd?: string } = {}) =>
      devMerge(e.db, { ...e.run, branches, repo, worktreeRoot: join(dir, 'wt'), checks, hooksDir, installCmd, base: 'dev', ...extra }),
    notes: () => e.db.prepare(`SELECT author, kind, body FROM notes WHERE task_id = 'dev-merge' AND kind = 'info' ORDER BY id`).all() as { author: string; body: string }[],
  };
}

test('clean merge → checks run → fake push called with the branch → pushed', () => {
  const f = fixture();
  const { results, wake } = f.merge(['clean']);
  assert.equal(results[0].status, 'pushed');
  assert.deepEqual(f.ran(), ['pint', 'tests']);
  assert.deepEqual(f.pushed(), ['clean']);
  assert.equal(git(f.repo, 'rev-parse', 'clean'), results[0].sha);
  assert.equal(git(f.repo, 'merge-base', '--is-ancestor', 'origin/dev', 'clean'), '');
  assert.equal(results[0].worktree, undefined); // temp worktree removed
  assert.equal(wake, null);
  assert.equal(f.sent.length, 0);
});

test('conflict → merge aborted, branch tip unchanged, no push, recorded with files', () => {
  const f = fixture();
  const tip = git(f.repo, 'rev-parse', 'origin/conflict');
  const { results } = f.merge(['conflict']);
  assert.equal(results[0].status, 'conflict');
  assert.deepEqual(results[0].files, ['shared.txt']);
  assert.equal(git(f.repo, 'rev-parse', 'conflict'), tip);
  // plain `worktree remove` refuses a mid-merge tree, so a removed worktree proves the abort
  assert.equal(results[0].worktree, undefined);
  assert.ok(!existsSync(join(f.repo, '.git', 'worktrees', 'conflict')));
  assert.deepEqual(f.pushed(), []);
  assert.deepEqual(f.ran(), []);
  assert.match(f.notes()[0].body, /^conflict: conflict merging origin\/dev.*\nfiles: shared\.txt/s);
});

test('failing lint and failing tests → no push, recorded with the check name, merge undone locally', () => {
  const f = fixture();
  const tips = ['lint-bad', 'test-bad'].map((b) => git(f.repo, 'rev-parse', `origin/${b}`));
  const { results } = f.merge(['lint-bad', 'test-bad']);
  assert.deepEqual(results.map((r) => [r.status, r.check]), [['check_failed', 'pint'], ['check_failed', 'tests']]);
  assert.match(results[0].output!, /pint: style errors/);
  assert.match(results[1].output!, /boom/);
  assert.deepEqual(f.ran(), ['pint', 'pint', 'tests']); // first failure stops the checks
  assert.deepEqual(f.pushed(), []);
  assert.deepEqual(['lint-bad', 'test-bad'].map((b) => git(f.repo, 'rev-parse', b)), tips);
  const notes = f.notes();
  assert.equal(notes.length, 2);
  assert.match(notes[0].body, /^lint-bad: check pint failed/);
  assert.match(notes[1].body, /^test-bad: check tests failed/);
});

test('dev already merged → up_to_date, no checks, no push, no wake', () => {
  const f = fixture();
  const { results, wake } = f.merge(['current']);
  assert.equal(results[0].status, 'up_to_date');
  assert.deepEqual(f.ran(), []);
  assert.deepEqual(f.pushed(), []);
  assert.equal(wake, null);
});

test('mixed run → one note per problem, exactly one engineer wake; a rerun is absorbed', () => {
  const f = fixture();
  git(f.repo, 'branch', 'clean', 'origin/clean'); // existing local branch path: ff-only, no -b
  const { results, wake } = f.merge(['clean', 'conflict', 'lint-bad', 'test-bad', 'current', 'bad;name']);
  assert.deepEqual(results.map((r) => r.status), ['pushed', 'conflict', 'check_failed', 'check_failed', 'up_to_date', 'error']);
  assert.deepEqual(f.pushed(), ['clean']);
  assert.equal(f.notes().length, 4);
  assert.ok(f.notes().every((n) => n.author === 'script'));
  assert.equal(f.sent.length, 1);
  assert.deepEqual([wake?.bot, wake?.reason, wake?.task_id], ['engineer', 'dev_merge', 'dev-merge']);
  assert.equal(f.task('dev-merge').state, 'building');
  assert.deepEqual(f.settle(), []); // the notes' events never cause a second wake

  // engineer hasn't finished yet → the next run's problems join the open wake
  const again = f.merge(['conflict']);
  assert.equal(again.wake, null);
  assert.equal(f.sent.length, 1);
  assert.equal(f.notes().length, 5);
});

test('push failure → push_failed, recorded and woken', () => {
  const f = fixture();
  const { results, wake } = f.merge(['clean'], { pushCmd: 'false' });
  assert.equal(results[0].status, 'push_failed');
  assert.equal(git(f.repo, 'rev-parse', 'clean'), git(f.repo, 'rev-parse', 'origin/clean'));
  assert.equal(wake?.bot, 'engineer');
});

test('all-clean run → zero wakes, no notes', () => {
  const f = fixture();
  addTask(f.db, { id: 'dev-merge', title: 't', state: 'done' }, f.clock);
  const { results } = f.merge(['clean', 'current']);
  assert.deepEqual(results.map((r) => r.status), ['pushed', 'up_to_date']);
  assert.equal(f.sent.length, 0);
  assert.equal(f.wakes().length, 0);
  assert.equal(f.notes().length, 0);
});

test('default push flow: install skipped when push exists, ci stamp then push -u origin HEAD in the worktree', () => {
  const f = fixture();
  const { results } = f.merge(['clean']);
  assert.equal(results[0].status, 'pushed');
  const wt = join(realpathSync(f.dir), 'wt', 'clean');
  assert.deepEqual(f.log(), [`ci ${wt} `, `push ${wt} -u origin HEAD`]);
});

test('default push flow: missing hooks → install runs first, then ci, then push', () => {
  const f = fixture();
  rmSync(f.hooksDir, { recursive: true });
  const { results } = f.merge(['clean']);
  assert.equal(results[0].status, 'pushed');
  const wt = join(realpathSync(f.dir), 'wt', 'clean');
  assert.deepEqual(f.log(), [`install ${wt}`, `ci ${wt} `, `push ${wt} -u origin HEAD`]);
});

test('hooks install failure → push_failed, no ci, no push', () => {
  const f = fixture();
  rmSync(f.hooksDir, { recursive: true });
  const { results } = devMerge(f.db, { ...f.run, branches: ['clean'], repo: f.repo, base: 'dev', worktreeRoot: join(f.dir, 'wt'), checks: [], hooksDir: f.hooksDir, installCmd: 'echo nope; false' });
  assert.equal(results[0].status, 'push_failed');
  assert.match(results[0].output!, /hooks install failed\nnope/);
  assert.deepEqual(f.log(), []);
});

test('ci stamp fails → check_failed ci-stamp, no push, merge undone', () => {
  const f = fixture();
  const { results } = f.merge(['clean'], { stampCmd: 'echo dirty tree; false' });
  assert.deepEqual([results[0].status, results[0].check], ['check_failed', 'ci-stamp']);
  assert.match(results[0].output!, /dirty tree/);
  assert.deepEqual(f.pushed(), []);
  assert.equal(git(f.repo, 'rev-parse', 'clean'), git(f.repo, 'rev-parse', 'origin/clean'));
});

test('default checks are generic: install, lint, tests', () => {
  assert.deepEqual(DEFAULT_CHECKS[0], { name: 'install', cmd: 'npm ci' });
  assert.deepEqual(DEFAULT_CHECKS.map((c) => c.name), ['install', 'lint', 'tests']);
});

test('missing hooks and no install command → push_failed with a clear message, nothing pushed', () => {
  const f = fixture();
  const { results } = devMerge(f.db, { ...f.run, branches: ['clean'], repo: f.repo, base: 'dev', worktreeRoot: join(f.dir, 'wt'), checks: [], hooksDir: join(f.dir, 'no-hooks') });
  assert.equal(results[0].status, 'push_failed');
  assert.match(results[0].output!, /no install command/);
});

test('an unsafe base branch name is rejected before anything runs', () => {
  const f = fixture();
  assert.throws(() => devMerge(f.db, { ...f.run, branches: ['clean'], repo: f.repo, base: '--evil', checks: [] }), /invalid base branch/);
});

test('local branch with a commit not on origin → local_commits, nothing run, tip unchanged, one wake', () => {
  const f = fixture();
  git(f.repo, 'branch', 'clean', 'origin/clean');
  git(f.repo, 'checkout', '-q', 'clean');
  commit(f.repo, 'local.txt', 'mine\n');
  git(f.repo, 'checkout', '-q', 'dev');
  const tip = git(f.repo, 'rev-parse', 'clean');
  const { results, wake } = f.merge(['clean', 'conflict']);
  assert.deepEqual(results.map((r) => r.status), ['local_commits', 'conflict']);
  assert.equal(results[0].output, 'local commits not on remote (1)');
  assert.equal(git(f.repo, 'rev-parse', 'clean'), tip);
  assert.deepEqual(f.ran(), []);
  assert.deepEqual(f.log(), []);
  assert.equal(f.notes().length, 2);
  assert.match(f.notes()[0].body, /^clean: local commits not on remote \(1\)/);
  assert.equal(wake?.bot, 'engineer');
  assert.equal(f.sent.length, 1);
});

test('local branch behind origin with no extra commits → fast-forwarded, merged, pushed', () => {
  const f = fixture();
  git(f.repo, 'branch', 'clean', 'origin/clean~1'); // behind by the feature commit
  const { results } = f.merge(['clean']);
  assert.equal(results[0].status, 'pushed');
  assert.equal(git(f.repo, 'merge-base', '--is-ancestor', 'origin/clean', 'clean'), '');
  assert.equal(git(f.repo, 'merge-base', '--is-ancestor', 'origin/dev', 'clean'), '');
  assert.deepEqual(f.pushed(), ['clean']);
});

test('leftover worktree dir is removed before the run; an unremovable one is an error', () => {
  const f = fixture();
  const wt = join(f.dir, 'wt', 'clean');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'clean', wt, 'origin/clean');
  assert.equal(f.merge(['clean']).results[0].status, 'pushed');

  const g = fixture();
  const stray = join(g.dir, 'wt', 'clean');
  mkdirSync(stray, { recursive: true }); // not a worktree: plain remove refuses
  const { results } = g.merge(['clean']);
  assert.equal(results[0].status, 'error');
  assert.match(results[0].output!, /leftover worktree/);
  assert.ok(existsSync(stray));
  assert.deepEqual(g.log(), []);
});

test('default hooks dir is <git-common-dir>/agent-board-hooks/bin, shared by the linked worktree', () => {
  const f = fixture();
  const common = join(f.repo, '.git', 'agent-board-hooks', 'bin');
  mkdirSync(common, { recursive: true });
  const log = join(f.dir, 'common.log');
  for (const n of ['ci', 'push']) writeFileSync(join(common, n), `#!/bin/sh\necho "${n} $*" >> '${log}'\n`, { mode: 0o755 });
  const { results } = devMerge(f.db, { ...f.run, branches: ['clean'], repo: f.repo, base: 'dev', worktreeRoot: join(f.dir, 'wt'), checks: [], installCmd: 'false' });
  assert.equal(results[0].status, 'pushed');
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['ci ', 'push -u origin HEAD']);
});
