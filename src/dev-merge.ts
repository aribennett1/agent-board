import type { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { addNote, addTask, deliver, getTask, setState, tx, type Clock, type Sender, type Wake } from './board.ts';

/** args 'shell' = run cmd through sh (checks, push wrapper). */
export type Runner = (cmd: string, args: string[] | 'shell', cwd: string) => { code: number; out: string };
export type Check = { name: string; cmd: string };
export type Status = 'pushed' | 'up_to_date' | 'conflict' | 'check_failed' | 'push_failed' | 'local_commits' | 'error';
export type Result = { branch: string; status: Status; sha?: string; files?: string[]; check?: string; output?: string; worktree?: string };

export const TASK = 'dev-merge';
export const DEFAULT_CHECKS: Check[] = [
  { name: 'install', cmd: 'npm ci' },
  { name: 'lint', cmd: 'npm run lint --if-present' },
  { name: 'tests', cmd: 'npm test' },
];

export const spawnRun: Runner = (cmd, args, cwd) => {
  const opts = { cwd, encoding: 'utf8', maxBuffer: 256 << 20 } as const;
  const r = args === 'shell' ? spawnSync(cmd, { ...opts, shell: true }) : spawnSync(cmd, args, opts);
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}` };
};

const tail = (s: string, n = 40) => s.trimEnd().split('\n').slice(-n).join('\n');
// Branch names come from gh / argv and end up in a shell line: allow plain ref characters only.
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[\w./-]+$/;

/** Merge origin/<base> into each branch in a temp worktree; push only if every check passes. */
export function devMerge(
  db: DatabaseSync,
  o: Clock & {
    send: Sender;
    branches: string[];
    repo: string;
    /** Branch merged into each PR branch; default `main`. */
    base?: string;
    worktreeRoot?: string;
    checks?: Check[];
    /** agent-board-hooks bin dir; default `<git-common-dir>/agent-board-hooks/bin` of the worktree. */
    hooksDir?: string;
    /** Runs only when `<hooksDir>/push` is missing and pushCmd isn't overridden. */
    installCmd?: string;
    stampCmd?: string;
    /** Full push command line; default `<hooksDir>/push -u origin HEAD`. */
    pushCmd?: string;
    run?: Runner;
  },
): { results: Result[]; wake: Wake | null } {
  const run = o.run ?? spawnRun;
  const base = o.base ?? 'main';
  if (!SAFE_BRANCH.test(base)) throw new Error(`invalid base branch "${base}"`);
  const root = o.worktreeRoot ?? join(tmpdir(), 'agent-board-dev-merge');
  const git = (args: string[], cwd: string) => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${tail(r.out, 10)}`);
    return r.out.trim();
  };

  git(['fetch', 'origin'], o.repo);
  const results = o.branches.map((branch): Result => {
    if (!SAFE_BRANCH.test(branch)) return { branch, status: 'error', output: 'unsafe branch name' };
    const wt = join(root, branch.replace(/[^\w.-]/g, '-'));
    // A leftover worktree could carry stale state: remove it (no --force) or skip the branch.
    if (existsSync(wt) && run('git', ['worktree', 'remove', wt], o.repo).code !== 0) {
      return { branch, status: 'error', output: `could not remove leftover worktree ${wt}`, worktree: wt };
    }
    let r: Result;
    try {
      // Never carry local commits: the worktree is always the local branch == origin/<branch>.
      if (run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], o.repo).code !== 0) {
        git(['worktree', 'add', '-b', branch, wt, `origin/${branch}`], o.repo);
      } else {
        const ahead = Number(git(['rev-list', '--count', `origin/${branch}..refs/heads/${branch}`], o.repo));
        if (ahead) return { branch, status: 'local_commits', output: `local commits not on remote (${ahead})` };
        git(['worktree', 'add', wt, branch], o.repo);
        git(['merge', '--ff-only', `origin/${branch}`], wt);
      }
      r = { branch, ...mergeAndCheck(wt) };
    } catch (e) {
      r = { branch, status: 'error', output: (e as Error).message };
    }
    // Plain remove (no --force): a dirty worktree is left in place and reported.
    if (existsSync(wt) && run('git', ['worktree', 'remove', wt], o.repo).code !== 0) r.worktree = wt;
    return r;
  });

  function mergeAndCheck(wt: string): Omit<Result, 'branch'> {
    const before = git(['rev-parse', 'HEAD'], wt);
    const m = run('git', ['merge', '--no-edit', `origin/${base}`], wt);
    if (m.code !== 0) {
      const files = run('git', ['diff', '--name-only', '--diff-filter=U'], wt).out.trim().split('\n').filter(Boolean);
      run('git', ['merge', '--abort'], wt);
      return { status: 'conflict', files, output: files.length ? undefined : tail(m.out) };
    }
    const sha = git(['rev-parse', 'HEAD'], wt);
    if (sha === before) return { status: 'up_to_date', sha };
    // An unpushed merge is undone so the next run re-merges and re-checks instead of seeing "up to date".
    const undo = () => git(['reset', '--hard', before], wt);
    for (const c of o.checks ?? DEFAULT_CHECKS) {
      const r = run(`${c.cmd} 2>&1`, 'shell', wt);
      if (r.code !== 0) return undo(), { status: 'check_failed', check: c.name, output: tail(r.out) };
    }
    const hooks = o.hooksDir ?? join(resolve(wt, git(['rev-parse', '--git-common-dir'], wt)), 'agent-board-hooks', 'bin');
    if (!o.pushCmd && !existsSync(join(hooks, 'push'))) {
      if (!o.installCmd) return undo(), { status: 'push_failed', output: `no push hook at ${join(hooks, 'push')} and no install command (--install-cmd / AGENT_BOARD_HOOKS_INSTALL); pass --push-cmd to push without hooks` };
      const i = run(`${o.installCmd} 2>&1`, 'shell', wt);
      if (i.code !== 0) return undo(), { status: 'push_failed', output: `hooks install failed\n${tail(i.out)}` };
    }
    const s = run(`${o.stampCmd ?? `'${join(hooks, 'ci')}'`} 2>&1`, 'shell', wt);
    if (s.code !== 0) return undo(), { status: 'check_failed', check: 'ci-stamp', output: tail(s.out) };
    const p = run(`${o.pushCmd ?? `'${join(hooks, 'push')}' -u origin HEAD`} 2>&1`, 'shell', wt);
    if (p.code !== 0) return undo(), { status: 'push_failed', output: tail(p.out) };
    return { status: 'pushed', sha };
  }

  return { results, wake: report(db, results, o, base) };
}

const BODY: Record<Status, (r: Result, base: string) => string> = {
  pushed: () => '',
  up_to_date: () => '',
  conflict: (r, base) => `conflict merging origin/${base}, nothing pushed.\nfiles: ${r.files?.join(', ') || '(none listed)'}${r.output ? `\n${r.output}` : ''}`,
  check_failed: (r, base) => `check ${r.check} failed after merging origin/${base}, nothing pushed.\n${r.output}`,
  push_failed: (r) => `all checks passed but push failed.\n${r.output}`,
  local_commits: (r) => `${r.output}, skipped, nothing pushed.`,
  error: (r) => `error: ${r.output}`,
};

/** One note per problem and at most one engineer wake, in one transaction. */
function report(db: DatabaseSync, results: Result[], o: Clock & { send: Sender }, base: string): Wake | null {
  const problems = results.filter((r) => r.status !== 'pushed' && r.status !== 'up_to_date');
  if (!problems.length) return null;
  const wake = tx(db, (): Wake | null => {
    if (!getTask(db, TASK)) addTask(db, { id: TASK, title: 'Merge base branch into open PR branches', state: 'building' }, o);
    else if (getTask(db, TASK)!.state !== 'building') setState(db, { task: TASK, by: 'script', to: 'building' }, o);
    for (const r of problems) addNote(db, { task: TASK, author: 'script', kind: 'info', body: `${r.branch}: ${BODY[r.status](r, base)}` }, o);
    // Our own events are this batch: mark them handled so runWake never wakes for them again.
    const now = o.now().toISOString();
    const events = (db.prepare('SELECT id FROM events WHERE task_id = ? AND processed_at IS NULL').all(TASK) as { id: number }[]).map((e) => e.id);
    db.prepare('UPDATE events SET processed_at = ? WHERE task_id = ? AND processed_at IS NULL').run(now, TASK);
    if (db.prepare(`SELECT 1 FROM wakes WHERE task_id = ? AND bot = 'engineer' AND done_at IS NULL AND send_ok = 1`).get(TASK)) return null; // absorbed
    const cycle = getTask(db, TASK)!.cycle;
    const r = db.prepare('INSERT INTO wakes (task_id, bot, reason, event_ids, cycle, sent_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(TASK, 'engineer', 'dev_merge', JSON.stringify(events), cycle, now, now);
    return { id: Number(r.lastInsertRowid), task_id: TASK, bot: 'engineer', reason: 'dev_merge', cycle, rewake_of: null };
  });
  if (wake) deliver(db, wake, o.send);
  return wake;
}
