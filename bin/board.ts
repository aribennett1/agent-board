import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { open } from '../src/db.ts';
import { loadDbPath, resolveAuthor } from '../src/config.ts';
import { addNote, addTask, checkin, printSender, runDrift, runTick, runWake, setState, type DriftRow } from '../src/board.ts';
import { weeklyReport } from '../src/report.ts';
import { devMerge, type Check } from '../src/dev-merge.ts';

const USAGE = `usage: board <command>
  checkin <task> --bot <id>
  note <task> --bot <id> --kind <kind> [--supersedes <noteId>] <body>
  state <task> --bot <id> [--new-cycle] <newState>
  task add <id> --title <t> [--ticket PROJ-n] [--pr n] [--state s]
  wake
  tick [--drift <json file>]
  drift <json file>
  report [--since ISO]
  dev-merge --repo <path> [--base <branch>] [--gh-author <login>] [--worktree-root <dir>] [--check name=cmd]... 
            [--install-cmd <cmd>] [--stamp-cmd <cmd>] [--push-cmd <cmd>]
env: AGENT_BOARD_DB (default ./agent-board.db), AGENT_BOT (default for --bot),
     AGENT_BOARD_BASE (default main), AGENT_BOARD_GH_AUTHOR (default @me), AGENT_BOARD_HOOKS_INSTALL`;

const BOOL = new Set(['new-cycle']);
const pos: string[] = [];
const flags: Record<string, string> = {};
const checks: Check[] = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) pos.push(a);
  else if (a === '--check' && i + 1 < argv.length) {
    const [name, ...cmd] = argv[++i].split('=');
    if (!name || !cmd.join('=')) fail('--check needs name=cmd');
    checks.push({ name, cmd: cmd.join('=') });
  }
  else if (BOOL.has(a.slice(2))) flags[a.slice(2)] = 'true';
  else if (i + 1 < argv.length) flags[a.slice(2)] = argv[++i];
  else fail(`missing value for ${a}`);
}

function fail(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(2);
}
const need = (v: string | undefined, what: string) => v || fail(`missing ${what}`);
function bot(): string {
  try {
    return resolveAuthor(flags.bot);
  } catch (e) {
    return fail((e as Error).message);
  }
}
const readDrift = (file: string) => {
  // shortcut: rows come from a file; fetching Linear/GitHub state is out of scope until the trial wires the APIs
  const rows = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(rows)) fail('drift file must be a JSON array');
  return rows as DriftRow[];
};

const db = open((() => { try { return loadDbPath(); } catch (e) { return fail((e as Error).message); } })());
const clock = { now: () => new Date() };
const run = { ...clock, send: printSender };
const [cmd, ...rest] = pos;

try {
  switch (cmd) {
    case 'checkin': {
      const w = checkin(db, need(rest[0], 'task'), bot(), clock);
      console.log(w ? `checked in to wake #${w}` : 'checked in (no open wake)');
      break;
    }
    case 'note': {
      const supersedes = flags.supersedes ? Number(flags.supersedes) : undefined;
      if (supersedes !== undefined && !Number.isInteger(supersedes)) fail('--supersedes must be a note id');
      const id = addNote(db, { task: need(rest[0], 'task'), author: bot(), kind: need(flags.kind, '--kind'), body: need(rest.slice(1).join(' '), 'body'), supersedes }, clock);
      console.log(`note #${id}`);
      break;
    }
    case 'state':
      setState(db, { task: need(rest[0], 'task'), by: bot(), to: need(rest[1], 'state'), newCycle: flags['new-cycle'] === 'true' }, clock);
      console.log(`${rest[0]} → ${rest[1]}`);
      break;
    case 'task': {
      if (rest[0] !== 'add') fail('only `task add` exists');
      const pr = flags.pr ? Number(flags.pr) : undefined;
      if (pr !== undefined && !Number.isInteger(pr)) fail('--pr must be a number');
      addTask(db, { id: need(rest[1], 'id'), title: need(flags.title, '--title'), ticket: flags.ticket, pr, state: flags.state }, clock);
      console.log(`task ${rest[1]} added`);
      break;
    }
    case 'wake':
      console.log(`${runWake(db, run).length} wake(s)`);
      break;
    case 'tick':
      console.log(JSON.stringify(runTick(db, run, flags.drift ? readDrift(flags.drift) : undefined)));
      break;
    case 'drift':
      console.log(`${runDrift(db, readDrift(need(rest[0], 'json file')), clock)} mismatch(es)`);
      break;
    case 'report': {
      const since = flags.since ?? new Date(Date.now() - 7 * 864e5).toISOString();
      if (Number.isNaN(Date.parse(since))) fail('--since must be an ISO date');
      console.log(weeklyReport(db, { since: new Date(since).toISOString(), now: clock.now() }));
      break;
    }
    case 'dev-merge': {
      const repo = need(flags.repo, '--repo');
      // read-only; stdout only so gh warnings never become branch names
      const gh = spawnSync('gh', ['pr', 'list', '--author', flags['gh-author'] ?? process.env.AGENT_BOARD_GH_AUTHOR ?? '@me', '--state', 'open', '--json', 'headRefName', '--jq', '.[].headRefName'], { cwd: repo, encoding: 'utf8' });
      if (gh.status !== 0) throw new Error(`gh pr list: ${gh.stderr}${gh.error?.message ?? ''}`);
      const branches = gh.stdout.split('\n').map((b) => b.trim()).filter(Boolean);
      const { results, wake } = devMerge(db, {
        ...run, branches, repo, base: flags.base ?? process.env.AGENT_BOARD_BASE, worktreeRoot: flags['worktree-root'], checks: checks.length ? checks : undefined, 
        installCmd: flags['install-cmd'] ?? process.env.AGENT_BOARD_HOOKS_INSTALL, stampCmd: flags['stamp-cmd'], pushCmd: flags['push-cmd'],
      });
      for (const r of results) {
        const detail = r.sha ?? r.files?.join(', ') ?? r.check ?? r.output?.split('\n').at(-1) ?? '';
        console.log(`${r.branch}: ${r.status} ${detail}${r.worktree ? ` (worktree left at ${r.worktree})` : ''}`);
      }
      console.log(`${new Date().toISOString()} ${results.length} branch(es), ${wake ? `engineer wake #${wake.id}` : 'no wake'}`);
      break;
    }
    default:
      fail(cmd ? `unknown command ${cmd}` : 'no command');
  }
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
