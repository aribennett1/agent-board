import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { open } from '../src/db.ts';
import { createApp } from '../src/server.ts';
import { normalizePr, normalizeTicket, readFeed, refreshFeed, startFeedTimer, type Gh } from '../src/feed.ts';
import { boardVersion } from '../src/version.ts';
import { env } from './helpers.ts';

const prNode = (n: number, extra: Record<string, any> = {}) => ({
  number: n, title: `PR ${n}`, url: `https://github.com/ROWSHR/rows-backend/pull/${n}`, isDraft: false, body: 'Adds a thing.', additions: 120, deletions: 30, changedFiles: 4,
  reviewDecision: null, mergeable: 'MERGEABLE', createdAt: '2026-11-26T10:00:00Z', updatedAt: '2026-11-26T12:00:00Z', headRefName: 'feat', baseRefName: 'dev',
  repository: { nameWithOwner: 'ROWSHR/rows-backend', name: 'rows-backend' }, author: { login: 'sam' },
  labels: { nodes: [{ name: 'Ready For Review!', color: '0e8a16' }] }, comments: { totalCount: 2 }, reviews: { totalCount: 1 },
  reviewThreads: { nodes: [
    { isResolved: false, comments: { totalCount: 3, nodes: [{ author: { login: 'ann' }, path: 'a.php', body: 'Rename this', url: 'https://github.com/c/1' }] } },
    { isResolved: true, comments: { totalCount: 1, nodes: [{ author: { login: 'bo' }, path: 'b.php', body: 'ok', url: '' }] } },
  ] },
  reviewRequests: { nodes: [] }, latestReviews: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [{ __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS', status: 'COMPLETED' }] } } } }] },
  ...extra,
});

const fakeGh = (mine: any[], others: any[]): Gh & { calls: string[][] } => {
  const f = (async (args: string[]) => {
    f.calls.push(args);
    if (args[0] === 'api' && args[1] === 'user') return 'aribennett1\n';
    const q = args.find((a) => a.startsWith('q='))!;
    return JSON.stringify({ data: { search: { nodes: q.includes('author:aribennett1') && !q.includes('-author') ? mine : others } } });
  }) as Gh & { calls: string[][] };
  f.calls = [];
  return f;
};
const NOW = () => new Date('2026-11-26T17:41:00Z');

test('normalizePr keeps labels, comment count, lines, checks, review state, unresolved comments and the description', () => {
  const p = normalizePr(prNode(5, { reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'aribennett1' } }] } }), 'aribennett1');
  assert.equal(p.repo, 'rows-backend');
  assert.equal(p.who, 'Your review requested');
  assert.equal(p.state, 'ready');
  assert.equal(p.ci, 'passing');
  assert.equal(p.comments, 2 + 3 + 1);
  assert.deepEqual([p.additions, p.deletions, p.files], [120, 30, 4]);
  assert.deepEqual(p.labels, [{ name: 'Ready For Review!', color: '0e8a16' }]);
  assert.equal(p.unresolved_count, 1);
  assert.deepEqual(p.unresolved, [{ author: 'ann', path: 'a.php', body: 'Rename this', url: 'https://github.com/c/1' }]);
  assert.equal(p.body, 'Adds a thing.');
  const bad = normalizePr(prNode(6, { isDraft: true, reviewDecision: 'CHANGES_REQUESTED', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [{ __typename: 'CheckRun', name: 'lint', conclusion: 'FAILURE', status: 'COMPLETED' }] } } } }] } }), 'aribennett1');
  assert.deepEqual([bad.state, bad.ci, bad.checks.failing], ['draft', 'failing', ['lint']]);
  assert.equal(normalizePr(prNode(7, { reviewDecision: 'CHANGES_REQUESTED' }), 'x').state, 'changes requested');
});

test('normalizeTicket keeps the Linear status, priority, project, labels and linked PRs', () => {
  const t = normalizeTicket({ identifier: 'ROWS-9', title: 'Do it', url: 'https://linear.app/x', priority: 2, priorityLabel: 'High', state: { name: 'In Review', type: 'started', color: '#fff' }, project: { name: 'Payroll' }, labels: { nodes: [{ name: 'BE', color: '#000' }] }, attachments: { nodes: [{ url: 'https://github.com/a/b/pull/3' }, { url: 'https://figma.com/x' }] }, updatedAt: 'now' });
  assert.deepEqual([t.id, t.status, t.priority_label, t.project, t.prs], ['ROWS-9', 'In Review', 'High', 'Payroll', ['https://github.com/a/b/pull/3']]);
});

test('refreshFeed fetches GitHub with gh and Linear with the key, no bot involved, and stores both lists', async () => {
  const e = env();
  const gh = fakeGh([prNode(1), prNode(2)], [prNode(3)]);
  const asked: { query: string; key: string }[] = [];
  const f = await refreshFeed(e.db, { gh, now: NOW, linearKey: 'lin_key', linear: async (query, key) => (asked.push({ query, key }), { issues: { nodes: [{ identifier: 'ROWS-1', title: 'T', url: 'u', priority: 1, priorityLabel: 'Urgent', state: { name: 'In Progress', type: 'started' }, updatedAt: 'x' }] } }) });
  assert.deepEqual([f.mine.length, f.others.length, f.tickets.length], [2, 1, 1]);
  assert.ok(f.github.ok && f.linear.ok);
  assert.equal(asked.length, 1);
  assert.match(asked[0].query, /isMe/);
  assert.ok(gh.calls.every((c) => c[0] === 'api'), 'only read-only gh api calls');
  const qs = gh.calls.filter((c) => c.includes('graphql')).map((c) => c.find((a) => a.startsWith('q=')) ?? '');
  assert.equal(qs.length, 2);
  assert.ok(qs.every((q) => q.includes('org:ROWSHR')), 'only PRs in the ROWSHR org');
  assert.ok(qs.some((q) => q.includes('author:aribennett1') && !q.includes('-author')));
  assert.ok(qs.some((q) => q.includes('involves:aribennett1') && q.includes('-author:aribennett1')));
  assert.equal(readFeed(e.db)!.tickets[0].id, 'ROWS-1');
  // the stored JSON holds no secret
  assert.ok(!JSON.stringify(readFeed(e.db)).includes('lin_key'));
});

test('without a Linear key tickets are empty and say why; GitHub still fills', async () => {
  const e = env();
  const f = await refreshFeed(e.db, { gh: fakeGh([prNode(1)], []), now: NOW, linearKey: '' });
  assert.equal(f.linear.configured, false);
  assert.match(f.linear.error, /LINEAR_API_KEY/);
  assert.equal(f.mine.length, 1);
});

test('a source that fails keeps its last good list and records the error', async () => {
  const e = env();
  await refreshFeed(e.db, { gh: fakeGh([prNode(1)], [prNode(3)]), now: NOW, linearKey: '' });
  const f = await refreshFeed(e.db, { gh: (async () => { throw new Error('gh: HTTP 504'); }) as Gh, now: NOW, linearKey: '' });
  assert.equal(f.github.ok, false);
  assert.equal(f.github.error, 'gh: HTTP 504');
  assert.equal(f.mine.length, 1);
  assert.equal(f.others.length, 1);
});

test('the board feed serves tickets, mine and others from the server fetch, ignoring anything a bot wrote with ab', async () => {
  const e = env();
  e.db.prepare('INSERT INTO ui_doc (key, json, updated_at) VALUES (?, ?, ?)').run('board', JSON.stringify({ decisions: [], glance: { waiting: [], tickets: [{ id: 'BOT-1', title: 'x', status: 's' }], others: [{ title: 'bot pr', author: 'a', who: 'w', link: 'l' }], mine: [{ repo: 'r', number: 1, title: 't', link: 'l', state: 'ready' }] } }), 'now');
  const app = createApp(e.db, e.clock, { ui: { timeZone: 'UTC' } });
  let feed = await (await app.request('/__ab/board')).json();
  assert.deepEqual([feed.glance.tickets, feed.glance.mine, feed.glance.others], [[], [], []]);
  assert.equal(feed.feed, null);
  await refreshFeed(e.db, { gh: fakeGh([prNode(1)], [prNode(3), prNode(4)]), now: NOW, linearKey: '' });
  feed = await (await app.request('/__ab/board')).json();
  assert.deepEqual([feed.glance.mine.length, feed.glance.others.length], [1, 2]);
  assert.equal(feed.glance.mine[0].number, 1);
  assert.equal(feed.feed.github.ok, true);
  assert.equal(feed.feed.linear.configured, false);
});

test('a fetch changes the version hash, so the open board picks it up', async () => {
  const e = env();
  const before = boardVersion(e.db);
  await refreshFeed(e.db, { gh: fakeGh([prNode(1)], []), now: NOW, linearKey: '' });
  assert.notEqual(boardVersion(e.db), before);
});

test('the refresh route fetches now, and is limited to one run per 15 seconds', async () => {
  const e = env();
  const gh = fakeGh([prNode(1)], []);
  const app = createApp(e.db, e.clock, { ui: { feed: { gh, now: NOW, linearKey: '' } } });
  const post = () => app.request('/__ab/feed/refresh', { method: 'POST', headers: { Host: 'board.test' } });
  assert.equal((await (await post()).json()).github, true);
  const callsAfterFirst = gh.calls.length;
  assert.equal((await (await post()).json()).skipped, true);
  assert.equal(gh.calls.length, callsAfterFirst);
});

test('the timer runs once at start and then on each tick, never overlapping', async () => {
  const e = env();
  let n = 0;
  let release!: () => void;
  const slow: Gh = async (args) => {
    if (args[1] === 'user') { n++; await new Promise<void>((r) => (release = r)); return 'me'; }
    return JSON.stringify({ data: { search: { nodes: [] } } });
  };
  const stop = startFeedTimer(e.db, { gh: slow, linearKey: '' }, 5);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(n, 1, 'ticks are skipped while a run is in flight');
  release();
  await new Promise((r) => setTimeout(r, 40));
  release?.();
  stop();
  assert.ok(n >= 2);
});

test('ab ask keeps who the answer was sent to (to_bot) and ignores an unknown name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-ask-'));
  const dbPath = join(dir, 'board.db');
  open(dbPath).close();
  const run = (input: unknown) => execFileSync(process.execPath, [join(import.meta.dirname, '..', 'bin', 'ab.mjs'), 'ask', '-'], { env: { ...process.env, AGENT_BOARD_DB: dbPath, AB_NO_SERVER: '1', AB_NO_GH: '1' }, input: JSON.stringify(input), encoding: 'utf8' });
  run({ event: 'item.message', message_id: 'm1', item_id: 'd1', item_section: 'decision', item_title: 'T', text: 'hi', sent_at: '2026-11-26T17:00:00Z', to_bot: 'QA' });
  run({ event: 'item.message', message_id: 'm2', item_id: 'd1', item_section: 'decision', item_title: 'T', text: 'again', sent_at: '2026-11-26T17:01:00Z', to_bot: 'Nobody' });
  const db = open(dbPath);
  const board = JSON.parse((db.prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string }).json);
  const byId = Object.fromEntries(board.asks.map((a: any) => [a.id, a]));
  assert.equal(byId.m1.to_bot, 'QA');
  assert.equal(byId.m2.to_bot, undefined);
});
