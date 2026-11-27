import type { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { addNote, addTask, deliver, getTask, setState, tx, type Clock, type Sender, type Wake } from './board.ts';

/** args 'shell' = run cmd through sh (checks, push wrapper). */
export type Runner = (cmd: string, args: string[] | 'shell', cwd: string) => { code: number; out: string };
export type Check = { name: string; cmd: string };
export type HookVersion = (root: string) => string | null;
export type SdmEntry = { result: string; reason: string };
export type Status = 'pushed' | 'up_to_date' | 'conflict' | 'check_failed' | 'push_failed' | 'local_commits' | 'skipped' | 'error';
export type Result = { branch: string; base?: string; status: Status; sha?: string; files?: string[]; check?: string; output?: string; worktree?: string; sdm?: SdmEntry };

export const TASK = 'dev-merge';
export const DEFAULT_CHECKS: Check[] = [
  { name: 'install', cmd: 'npm ci' },
  { name: 'lint', cmd: 'npm run lint --if-present' },
  { name: 'tests', cmd: 'npm test' },
];
/** Source hook tree whose hook_version must match the installed copy. */
export const DEFAULT_SKILLS_HOOKS = '/workspace/eric-skills/hooks';
/** Append-only log written by hooks/bin/push --scheduled-dev-merge. */
export const DEFAULT_SDM_LOG = '/home/box/.local/state/eric-hooks/scheduled-dev-merge.jsonl';

export const spawnRun: Runner = (cmd, args, cwd) => {
  const opts = { cwd, encoding: 'utf8', maxBuffer: 256 << 20 } as const;
  const r = args === 'shell' ? spawnSync(cmd, { ...opts, shell: true }) : spawnSync(cmd, args, opts);
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error?.message ?? ''}` };
};

const tail = (s: string, n = 40) => s.trimEnd().split('\n').slice(-n).join('\n');
// Branch names come from gh / argv and end up in a shell line: allow plain ref characters only.
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[\w./-]+$/;
const hookTree = (hooksDir: string) => (hooksDir.endsWith('/bin') ? resolve(hooksDir, '..') : hooksDir);

/** hook_version is `_lib.hook_version(root)` with no CLI; hash a hook tree with the source _lib. */
export function readHookVersion(root: string, skillsHookRoot = DEFAULT_SKILLS_HOOKS): string | null {
  const libDir = join(skillsHookRoot, 'bin');
  if (!existsSync(join(libDir, '_lib.py')) || !existsSync(join(root, 'pre-push'))) return null;
  const r = spawnSync('python3', ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); import _lib; print(_lib.hook_version(_lib.Path(sys.argv[2])), end="")', libDir, root], { encoding: 'utf8' });
  const v = (r.stdout ?? '').trim();
  return r.status === 0 && v ? v : null;
}

/** Last jsonl line whose branch and head_sha match this push attempt. */
export function lastSdmEntry(logPath: string, branch: string, sha: string): SdmEntry | undefined {
  if (!existsSync(logPath)) return undefined;
  let found: SdmEntry | undefined;
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { branch?: unknown; head_sha?: unknown; result?: unknown; reason?: unknown };
      if (j.branch === branch && j.head_sha === sha && typeof j.result === 'string') {
        found = { result: j.result, reason: typeof j.reason === 'string' ? j.reason : '' };
      }
    } catch { /* skip a truncated or foreign line */ }
  }
  return found;
}

function staleHooks(
  hooks: string,
  o: { hookVersion?: HookVersion; skillsHookRoot?: string },
): boolean {
  if (!existsSync(join(hooks, 'push'))) return true;
  const ver = o.hookVersion ?? ((root: string) => readHookVersion(root, o.skillsHookRoot ?? DEFAULT_SKILLS_HOOKS));
  const have = ver(hookTree(hooks));
  const want = ver(o.skillsHookRoot ?? DEFAULT_SKILLS_HOOKS);
  return have != null && want != null && have !== want;
}

/** One open PR: its head branch, the base branch it targets, and the listed PR branch it stacks on (if any). */
export type PlanRow = { branch: string; base: string; parent?: string; depth: number };

/**
 * Stack order, root to leaf: a PR whose base is another listed PR's branch comes right after
 * that parent, so dev goes into A, then A into B, then B into C. Roots keep their input order.
 * A base cycle (never valid on GitHub) leaves those branches out of the order; the caller reports them.
 */
export function stackOrder(branches: string[], baseOf: (branch: string) => string): PlanRow[] {
  const listed = new Set(branches);
  const children = new Map<string, string[]>();
  for (const b of branches) {
    const base = baseOf(b);
    if (listed.has(base) && base !== b) children.set(base, [...(children.get(base) ?? []), b]);
  }
  const out: PlanRow[] = [];
  const seen = new Set<string>();
  const visit = (branch: string, depth: number, parent?: string) => {
    if (seen.has(branch)) return;
    seen.add(branch);
    out.push({ branch, base: baseOf(branch), parent, depth });
    for (const c of children.get(branch) ?? []) visit(c, depth + 1, branch);
  };
  for (const b of branches) if (!listed.has(baseOf(b)) || baseOf(b) === b) visit(b, 0);
  return out;
}

/** `{base}` in a check, stamp, or push command line becomes this branch's PR base (already SAFE_BRANCH). */
const withBase = (cmd: string, base: string) => cmd.replaceAll('{base}', base);

/**
 * Merge each PR's own base, origin/<base>, into its branch in a temp worktree; push only if every check passes.
 * Stacked PRs run root to leaf. When a branch is not cleanly up to date or pushed, every branch stacked on it is skipped.
 */
export function devMerge(
  db: DatabaseSync,
  o: Clock & {
    send: Sender;
    branches: string[];
    repo: string;
    /** Each PR branch's base branch as GitHub reports it (baseRefName). */
    bases?: Record<string, string>;
    /** Base for a branch missing from `bases`; default `main`. */
    base?: string;
    worktreeRoot?: string;
    checks?: Check[];
    /** eric-hooks bin dir; default `<git-common-dir>/eric-hooks/bin` of the worktree. */
    hooksDir?: string;
    /** Runs when `<hooksDir>/push` is missing or hook_version differs from skillsHookRoot, before stamping. */
    installCmd?: string;
    stampCmd?: string;
    /** Full push command line; default `<hooksDir>/push --scheduled-dev-merge -u origin HEAD`. */
    pushCmd?: string;
    hookVersion?: HookVersion;
    skillsHookRoot?: string;
    sdmLog?: string;
    run?: Runner;
  },
): { results: Result[]; wake: Wake | null } {
  const run = o.run ?? spawnRun;
  const fallback = o.base ?? 'main';
  if (!SAFE_BRANCH.test(fallback)) throw new Error(`invalid base branch "${fallback}"`);
  const baseOf = (b: string) => o.bases?.[b] ?? fallback;
  const root = o.worktreeRoot ?? join(tmpdir(), 'agent-board-dev-merge');
  const git = (args: string[], cwd: string) => {
    const r = run('git', args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${tail(r.out, 10)}`);
    return r.out.trim();
  };

  git(['fetch', 'origin'], o.repo);
  const plan = stackOrder(o.branches, baseOf);
  const done = new Map<string, Result>();
  const one = ({ branch, base, parent }: PlanRow): Result => {
    if (!SAFE_BRANCH.test(branch)) return { branch, base, status: 'error', output: 'unsafe branch name' };
    if (!SAFE_BRANCH.test(base)) return { branch, base, status: 'error', output: `unsafe base branch "${base}"` };
    const up = parent ? done.get(parent) : undefined;
    if (up && up.status !== 'pushed' && up.status !== 'up_to_date') {
      return { branch, base, status: 'skipped', output: `parent ${parent} was not updated (${up.status})` };
    }
    const wt = join(root, branch.replace(/[^\w.-]/g, '-'));
    // A leftover worktree could carry stale state: remove it (no --force) or skip the branch.
    if (existsSync(wt) && run('git', ['worktree', 'remove', wt], o.repo).code !== 0) {
      return { branch, base, status: 'error', output: `could not remove leftover worktree ${wt}`, worktree: wt };
    }
    let r: Result;
    try {
      // Never carry local commits: the worktree is always the local branch == origin/<branch>.
      if (run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], o.repo).code !== 0) {
        git(['worktree', 'add', '-b', branch, wt, `origin/${branch}`], o.repo);
      } else {
        const ahead = Number(git(['rev-list', '--count', `origin/${branch}..refs/heads/${branch}`], o.repo));
        if (ahead) return { branch, base, status: 'local_commits', output: `local commits not on remote (${ahead})` };
        git(['worktree', 'add', wt, branch], o.repo);
        git(['merge', '--ff-only', `origin/${branch}`], wt);
      }
      // Fresh base tip: a parent pushed earlier in this run is what its child merges.
      git(['fetch', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], o.repo);
      r = { branch, base, ...mergeAndCheck(wt, branch, base) };
    } catch (e) {
      r = { branch, base, status: 'error', output: (e as Error).message };
    }
    // Plain remove (no --force): a dirty worktree is left in place and reported.
    if (existsSync(wt) && run('git', ['worktree', 'remove', wt], o.repo).code !== 0) r.worktree = wt;
    return r;
  };
  const results = plan.map((row) => {
    const r = one(row);
    done.set(row.branch, r);
    return r;
  });
  const placed = new Set(plan.map((p) => p.branch));
  for (const branch of o.branches) {
    if (!placed.has(branch)) results.push({ branch, base: baseOf(branch), status: 'error', output: 'PR bases form a cycle' });
  }

  function mergeAndCheck(wt: string, branch: string, base: string): Omit<Result, 'branch'> {
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
      const r = run(`${withBase(c.cmd, base)} 2>&1`, 'shell', wt);
      if (r.code !== 0) return undo(), { status: 'check_failed', check: c.name, output: tail(r.out) };
    }
    const hooks = o.hooksDir ?? join(resolve(wt, git(['rev-parse', '--git-common-dir'], wt)), 'eric-hooks', 'bin');
    if (staleHooks(hooks, o)) {
      if (!o.installCmd) {
        const why = existsSync(join(hooks, 'push'))
          ? `installed hook_version differs from ${o.skillsHookRoot ?? DEFAULT_SKILLS_HOOKS} and no install command (--install-cmd / AGENT_BOARD_HOOKS_INSTALL)`
          : `no push hook at ${join(hooks, 'push')} and no install command (--install-cmd / AGENT_BOARD_HOOKS_INSTALL); pass --push-cmd to push without hooks`;
        return undo(), { status: 'push_failed', output: why };
      }
      const i = run(`${o.installCmd} 2>&1`, 'shell', wt);
      if (i.code !== 0) return undo(), { status: 'push_failed', output: `hooks install failed\n${tail(i.out)}` };
    }
    const s = run(`${withBase(o.stampCmd ?? `'${join(hooks, 'ci')}'`, base)} 2>&1`, 'shell', wt);
    if (s.code !== 0) return undo(), { status: 'check_failed', check: 'ci-stamp', output: tail(s.out) };
    const p = run(`${withBase(o.pushCmd ?? `'${join(hooks, 'push')}' --scheduled-dev-merge -u origin HEAD`, base)} 2>&1`, 'shell', wt);
    const sdm = lastSdmEntry(o.sdmLog ?? DEFAULT_SDM_LOG, branch, sha);
    if (p.code !== 0 || sdm?.result === 'refused' || sdm?.result === 'push_failed') {
      const output = sdm
        ? `result: ${sdm.result}\nreason: ${sdm.reason}${p.out.trim() ? `\n${tail(p.out)}` : ''}`
        : tail(p.out);
      return undo(), { status: 'push_failed', output, sdm };
    }
    return { status: 'pushed', sha, sdm };
  }

  return { results, wake: report(db, results, o, fallback) };
}

const BODY: Record<Status, (r: Result, base: string) => string> = {
  pushed: () => '',
  up_to_date: () => '',
  conflict: (r, base) => `conflict merging origin/${base}, nothing pushed.\nfiles: ${r.files?.join(', ') || '(none listed)'}${r.output ? `\n${r.output}` : ''}`,
  check_failed: (r, base) => `check ${r.check} failed after merging origin/${base}, nothing pushed.\n${r.output}`,
  push_failed: (r) => `all checks passed but push failed.\n${r.output}`,
  local_commits: (r) => `${r.output}, skipped, nothing pushed.`,
  skipped: (r) => `${r.output}, skipped so it never merges a stale parent, nothing pushed.`,
  error: (r) => `error: ${r.output}`,
};

/** One note per problem and at most one engineer wake, in one transaction. */
function report(db: DatabaseSync, results: Result[], o: Clock & { send: Sender }, base: string): Wake | null {
  const problems = results.filter((r) => r.status !== 'pushed' && r.status !== 'up_to_date');
  if (!problems.length) return null;
  const wake = tx(db, (): Wake | null => {
    if (!getTask(db, TASK)) addTask(db, { id: TASK, title: 'Merge base branch into open PR branches', state: 'building' }, o);
    else if (getTask(db, TASK)!.state !== 'building') setState(db, { task: TASK, by: 'script', to: 'building' }, o);
    for (const r of problems) addNote(db, { task: TASK, author: 'script', kind: 'info', body: `${r.branch}: ${BODY[r.status](r, r.base ?? base)}` }, o);
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
