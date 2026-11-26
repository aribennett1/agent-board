import type { DatabaseSync } from 'node:sqlite';
import type { Bot } from './db.ts';
import { OWNERS, type State } from './board.ts';

// shortcut: tokens per wake can't be seen; these are estimates from setup size + duration, checked weekly against the usage report
export const SETUP_TOKENS: Record<Bot, number> = { planner: 30_000, engineer: 60_000, qa: 40_000, ops: 15_000, chief: 25_000 };
export const TOKENS_PER_MIN = 4_000;

type WakeRow = { id: number; task_id: string; bot: Bot; reason: string; rewake_of: number | null; send_ok: number | null; done_at: string | null; outcome: string | null; mins: number };
type Item = { sink: string; value: number; shown: string; bot: string; trigger: string; task: string };

const dur = (secs: number) => (secs < 3600 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`);
const tok = (n: number) => `~${Math.round(n / 1000)}k`;

function table(head: string[], rows: (string | number)[][]): string {
  if (!rows.length) return '_none_\n';
  return [head, head.map(() => '---'), ...rows].map((r) => `| ${r.join(' | ')} |`).join('\n') + '\n';
}

function sumBy<T>(xs: T[], key: (x: T) => string, val: (x: T) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + val(x));
  return m;
}

export function weeklyReport(db: DatabaseSync, { since, now }: { since: string; now: Date }): string {
  const q = <T>(sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as T[];
  const nowIso = now.toISOString();

  // Time spent in from_state = gap since the previous change (or task creation).
  const waits = q<{ task_id: string; state: State; secs: number }>(`
    SELECT task_id, state, sum(secs) AS secs FROM (
      SELECT sc.task_id, sc.from_state AS state, sc.created_at,
        (julianday(sc.created_at) - julianday(coalesce(lag(sc.created_at) OVER (PARTITION BY sc.task_id ORDER BY sc.id), t.created_at))) * 86400 AS secs
      FROM state_changes sc JOIN tasks t ON t.id = sc.task_id
    ) WHERE created_at >= ? GROUP BY task_id, state`, since);
  const merges = q<{ id: string; ticket: string | null; secs: number }>(`
    SELECT t.id, t.ticket, (julianday(min(sc.created_at)) - julianday(t.created_at)) * 86400 AS secs
    FROM tasks t JOIN state_changes sc ON sc.task_id = t.id AND sc.to_state = 'merged'
    GROUP BY t.id HAVING min(sc.created_at) >= ? ORDER BY secs DESC`, since);
  const wakes = q<WakeRow>(`
    SELECT id, task_id, bot, reason, rewake_of, send_ok, done_at, outcome,
      (julianday(coalesce(done_at, ?)) - julianday(sent_at)) * 1440 AS mins
    FROM wakes WHERE sent_at >= ?`, nowIso, since);
  const rounds = q<{ task_id: string; n: number }>(`
    SELECT task_id, count(*) AS n FROM notes_latest WHERE author = 'qa' AND kind = 'review_changes' AND created_at >= ?
    GROUP BY task_id ORDER BY n DESC`, since);
  const hops = q<{ task_id: string; n: number }>(`SELECT task_id, count(*) AS n FROM cards WHERE kind = 'hop_limit' AND created_at >= ? GROUP BY task_id`, since);
  const drift = q<{ mismatches: number; checks: number }>(`SELECT count(*) FILTER (WHERE mismatch = 1) AS mismatches, count(*) AS checks FROM drift_checks WHERE created_at >= ?`, since)[0];

  const tokens = (w: WakeRow) => (w.send_ok === 1 ? SETUP_TOKENS[w.bot] + w.mins * TOKENS_PER_MIN : 0);
  const rewakes = wakes.filter((w) => w.rewake_of !== null);
  const byState = sumBy(waits, (w) => w.state, (w) => w.secs);
  const tasks = [...new Set(wakes.map((w) => w.task_id))];
  const bots = [...new Set(wakes.map((w) => w.bot))];
  const outcomes = sumBy(wakes, (w) => w.outcome ?? (w.done_at ? 'nothing' : 'open'), () => 1);

  // Every sink item traced to (bot, trigger, task); scored by its share of that sink's total so time and tokens rank together.
  const items: Item[] = [
    ...waits.map((w) => ({ sink: 'wait', value: w.secs, shown: dur(w.secs), bot: OWNERS[w.state] ?? 'human', trigger: `state:${w.state}`, task: w.task_id })),
    ...[...sumBy(wakes, (w) => `${w.bot}\t${w.reason}\t${w.task_id}`, tokens)].map(([k, v]) => {
      const [bot, trigger, task] = k.split('\t');
      return { sink: 'tokens', value: v, shown: tok(v), bot, trigger, task };
    }),
    ...[...sumBy(rewakes, (w) => `${w.bot}\t${w.reason}\t${w.task_id}`, () => 1)].map(([k, v]) => {
      const [bot, trigger, task] = k.split('\t');
      return { sink: 're-wakes', value: v, shown: `${v}`, bot, trigger, task };
    }),
    ...rounds.map((r) => ({ sink: 'review rounds', value: r.n, shown: `${r.n}`, bot: 'qa', trigger: 'note:review_changes', task: r.task_id })),
    ...hops.map((h) => ({ sink: 'hop-limit hits', value: h.n, shown: `${h.n}`, bot: 'qa', trigger: 'hop_limit', task: h.task_id })),
  ].filter((i) => i.value > 0);
  const totals = sumBy(items, (i) => i.sink, (i) => i.value);
  const score = (i: Item) => i.value / totals.get(i.sink)!;
  const top = items.sort((a, b) => score(b) - score(a) || b.value - a.value).slice(0, 3);

  return `# Weekly bottleneck report

${since} to ${nowIso}

## Time sinks

### Wait time by state
${table(['state', 'total'], [...byState].sort((a, b) => b[1] - a[1]).map(([s, v]) => [s, dur(v)]))}
### Ticket to merge
${table(['task', 'ticket', 'time'], merges.map((m) => [m.id, m.ticket ?? '', dur(m.secs)]))}
### Slowest wakes
${table(['wake', 'bot', 'task', 'reason', 'sent to done'], [...wakes].sort((a, b) => b.mins - a.mins).slice(0, 5)
    .map((w) => [`#${w.id}`, w.bot, w.task_id, w.reason, `${dur(w.mins * 60)}${w.done_at ? '' : ' (open)'}`]))}
## Cost sinks

### Wakes per task
${table(['task', 'wakes', 're-wakes', 'est. tokens'], tasks.map((t) => {
    const ws = wakes.filter((w) => w.task_id === t);
    return [t, ws.length, ws.filter((w) => w.rewake_of !== null).length, tok(ws.reduce((s, w) => s + tokens(w), 0))];
  }))}
### Estimated tokens per bot
${table(['bot', 'wakes', 'est. tokens'], bots.map((b) => {
    const ws = wakes.filter((w) => w.bot === b);
    return [b, ws.length, tok(ws.reduce((s, w) => s + tokens(w), 0))];
  }))}
### Outcome mix
${table(['outcome', 'wakes'], [...outcomes])}
### Review rounds per task
${table(['task', 'rounds'], rounds.map((r) => [r.task_id, r.n]))}
Re-wakes: ${rewakes.length}

Hop-limit hits: ${hops.reduce((s, h) => s + h.n, 0)}

## Drift

Mismatches: ${drift.mismatches} of ${drift.checks} checks

## Top 3 to optimize next

${top.map((i, n) => `${n + 1}. ${i.sink} ${i.shown} (${Math.round(score(i) * 100)}% of ${i.sink}): bot ${i.bot}, trigger ${i.trigger}, task ${i.task}`).join('\n') || '_none_'}
`;
}
