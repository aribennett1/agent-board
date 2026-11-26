#!/usr/bin/env node
// Seed a throwaway board DB with clearly fake example data for README screenshots.
// Never points at the live database. Usage:
//   AGENT_BOARD_DB=/tmp/ab-readme-screenshots/board.db node scripts/seed-readme-screenshots.mjs

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { open } from '../src/db.ts';

const LIVE = '/workspace/agent-board-data/board.db';
const root = fileURLToPath(new URL('..', import.meta.url));
const dbPath = resolve(process.env.AGENT_BOARD_DB || '');
if (!dbPath) {
  console.error('Set AGENT_BOARD_DB to a throwaway path under /tmp');
  process.exit(2);
}
if (dbPath === LIVE || dbPath.startsWith('/workspace/agent-board-data/')) {
  console.error('Refusing to seed the live board database');
  process.exit(2);
}

mkdirSync(dirname(dbPath), { recursive: true });
open(dbPath).close();

const env = {
  ...process.env,
  AGENT_BOARD_DB: dbPath,
  AB_NO_SERVER: '1',
  AB_FILE: '',
};
delete env.AGENT_BOARD_WEBHOOK_URL;
delete env.AGENT_BOARD_WEBHOOK_AUTH;
for (const b of ['PLANNER', 'QA', 'ENGINEER', 'EGGBOT']) {
  delete env[`AB_WEBHOOK_URL_${b}`];
  delete env[`AB_WEBHOOK_SECRET_${b}`];
}

const ab = (...args) => {
  const out = execFileSync(process.execPath, [resolve(root, 'bin/ab.mjs'), ...args], {
    env,
    encoding: 'utf8',
    cwd: root,
  });
  return out;
};

const cards = [
  {
    bot: 'Planner',
    at: '2026-11-26T14:12:00Z',
    card: {
      id: 'planner-checkout-images',
      title: 'Checkout image compression',
      context: 'The checkout page is slow because it loads every product image at full size before the page can be used.',
      question: 'Should we compress the checkout images?',
      what_happens_after: 'The planner writes a short compression plan.',
      options: [{ id: 'yes', label: 'Compress them now' }, { id: 'hold', label: 'Hold for later' }],
      priority: 'high',
      group: 'ROWS-1001',
      card_ref: 'https://linear.app/rows/issue/ROWS-1001/checkout-image-compression',
    },
  },
  {
    bot: 'QA',
    at: '2026-11-26T15:40:00Z',
    card: {
      id: 'qa-search-filters',
      title: 'Search filters plan review',
      context: 'The planner drafted a plan to add faceted search filters on the catalog page, including the proposed tests.',
      question: 'Approve the search filters plan?',
      what_happens_after: 'Engineer starts building the approved filters.',
      options: [{ id: 'approve', label: 'Approve' }, { id: 'changes', label: 'Request changes' }],
      priority: 'medium',
      group: 'ROWS-1002',
      card_ref: 'https://linear.app/rows/issue/ROWS-1002/search-filters-plan',
    },
  },
  {
    bot: 'Engineer',
    at: '2026-11-26T16:05:00Z',
    card: {
      id: 'engineer-retry-queue',
      title: 'Retry queue for failed jobs',
      context: 'Background jobs that hit a timeout are dropped. A short retry queue would rerun them a few times before giving up.',
      question: 'Add a retry queue for failed jobs?',
      what_happens_after: 'The engineer opens a pull request for the queue.',
      options: [{ id: 'add', label: 'Add the queue' }, { id: 'later', label: 'Not now' }],
      priority: 'high',
      group: 'example#101',
      card_ref: 'https://github.com/ROWSHR/example/pull/101',
    },
  },
  {
    bot: 'dr eggbot',
    at: '2026-11-26T16:45:00Z',
    card: {
      id: 'eggbot-setup-hooks',
      title: 'Hook setup on new clones',
      context: 'New clones skip the install step, so pre-push hooks are missing until someone runs setup by hand.',
      question: 'Install the hooks automatically on new clones?',
      what_happens_after: 'The setup script starts installing the hooks.',
      options: [{ id: 'auto', label: 'Install automatically' }, { id: 'manual', label: 'Keep the manual step' }],
      priority: 'low',
      group: 'ROWS-1003',
      card_ref: 'https://linear.app/rows/issue/ROWS-1003/hook-setup-on-new-clones',
    },
  },
  {
    bot: 'Planner',
    at: '2026-11-26T17:20:00Z',
    card: {
      id: 'planner-export-format',
      title: 'Weekly export file format',
      context: 'The weekly export is a wide CSV that is hard to open. A compact spreadsheet would be easier to share with the team.',
      question: 'Switch the weekly export to a compact spreadsheet?',
      what_happens_after: 'The planner updates the export format in the plan.',
      options: [{ id: 'switch', label: 'Switch the format' }, { id: 'keep', label: 'Keep the CSV' }],
      priority: 'medium',
      group: 'ROWS-1004',
      card_ref: 'https://linear.app/rows/issue/ROWS-1004/weekly-export-file-format',
    },
  },
];

for (const { bot, at, card } of cards) {
  card.created_at = at;
  const out = ab('raise', '--bot', bot, JSON.stringify(card));
  process.stdout.write(out);
}

const notices = [
  { bot: 'Planner', text: 'Starting the checkout images plan.', next_update: '3:15 PM ET', created_at: '2026-11-26T14:20:00Z' },
  { bot: 'QA', text: 'Search filters plan is ready for review.', next_update: null, created_at: '2026-11-26T15:42:00Z' },
  { bot: 'Engineer', text: 'Retry queue branch is up. Checks are still running.', next_update: '4:00 PM ET', created_at: '2026-11-26T16:18:00Z' },
  { bot: 'dr eggbot', text: 'Looking at hook install on new clones.', next_update: '4:30 PM ET', created_at: '2026-11-26T16:50:00Z' },
  { bot: 'Planner', text: 'Weekly export format options are on the board.', next_update: null, created_at: '2026-11-26T17:22:00Z' },
];

const pr = (opts) => ({
  repo: opts.repo,
  repo_full: `ROWSHR/${opts.repo}`,
  number: opts.number,
  title: opts.title,
  link: `https://github.com/ROWSHR/${opts.repo}/pull/${opts.number}`,
  author: opts.author,
  who: opts.who,
  state: opts.state,
  ci: opts.ci,
  checks: opts.checks,
  reviews: opts.reviews ?? 1,
  review_decision: opts.review_decision ?? null,
  labels: opts.labels ?? [],
  comments: opts.comments,
  additions: opts.additions,
  deletions: opts.deletions,
  files: opts.files,
  unresolved_count: opts.unresolved_count ?? 0,
  unresolved: opts.unresolved ?? [],
  branch: opts.branch,
  base: opts.base ?? 'main',
  mergeable: 'MERGEABLE',
  body: opts.body,
  created_at: opts.created_at,
  updated_at: opts.updated_at,
});

const feed = {
  tickets: [],
  mine: [
    pr({
      repo: 'example', number: 101, title: 'Add a retry queue for failed jobs', author: 'alex',
      who: 'You opened', state: 'changes requested', ci: 'failing',
      checks: { passed: 3, failed: 1, pending: 0, failing: ['tests'] },
      review_decision: 'CHANGES_REQUESTED',
      labels: [{ name: 'enhancement', color: '0e8a16' }, { name: 'backend', color: '1d4ed8' }],
      comments: 6, additions: 142, deletions: 28, files: 5,
      unresolved_count: 2,
      unresolved: [
        { author: 'sam', path: 'src/queue.ts', body: 'Retry budget should be configurable.', url: 'https://github.com/ROWSHR/example/pull/101#discussion-1' },
        { author: 'jordan', path: 'src/queue.ts', body: 'Log the attempt number on each retry.', url: 'https://github.com/ROWSHR/example/pull/101#discussion-2' },
      ],
      branch: 'retry-queue', body: 'Retry timed-out background jobs a few times before giving up.',
      created_at: '2026-11-24T15:00:00Z', updated_at: '2026-11-26T16:10:00Z',
    }),
    pr({
      repo: 'example', number: 108, title: 'Document the export format', author: 'alex',
      who: 'You opened', state: 'draft', ci: 'pending',
      checks: { passed: 0, failed: 0, pending: 2, failing: [] },
      labels: [{ name: 'docs', color: '5319e7' }],
      comments: 1, additions: 36, deletions: 4, files: 2,
      branch: 'export-docs', body: 'Describe the weekly export columns.',
      created_at: '2026-11-25T19:00:00Z', updated_at: '2026-11-26T13:40:00Z',
    }),
    pr({
      repo: 'demo', number: 44, title: 'Tighten catalog search tests', author: 'alex',
      who: 'You opened', state: 'ready', ci: 'passing',
      checks: { passed: 5, failed: 0, pending: 0, failing: [] },
      labels: [{ name: 'tests', color: 'fbca04' }],
      comments: 3, additions: 88, deletions: 12, files: 4,
      branch: 'search-tests', body: 'Cover the new catalog filters.',
      created_at: '2026-11-23T18:00:00Z', updated_at: '2026-11-26T15:55:00Z',
    }),
  ],
  others: [
    pr({
      repo: 'demo', number: 55, title: 'Fix timezone on the schedule page', author: 'sam',
      who: 'Your review requested', state: 'ready', ci: 'passing',
      checks: { passed: 4, failed: 0, pending: 0, failing: [] },
      labels: [{ name: 'bug', color: 'd73a4a' }],
      comments: 2, additions: 24, deletions: 9, files: 2,
      branch: 'schedule-tz', body: 'Show local times on the schedule page.',
      created_at: '2026-11-25T14:00:00Z', updated_at: '2026-11-26T16:30:00Z',
    }),
    pr({
      repo: 'sample', number: 12, title: 'Cache the catalog list', author: 'jordan',
      who: "You're involved", state: 'ready', ci: 'passing',
      checks: { passed: 6, failed: 0, pending: 0, failing: [] },
      labels: [{ name: 'performance', color: 'c5def5' }],
      comments: 5, additions: 67, deletions: 11, files: 3,
      branch: 'catalog-cache', body: 'Cache the catalog list for a short interval.',
      created_at: '2026-11-22T17:00:00Z', updated_at: '2026-11-26T12:15:00Z',
    }),
  ],
  github: { ok: true, login: 'alex', error: null, last_ok: '2026-11-26T18:00:00Z' },
  linear: { ok: false, configured: false, enabled: false, error: null, last_ok: null },
};

const db = new DatabaseSync(dbPath);
const insN = db.prepare('INSERT INTO ui_notifications (bot, text, next_update, link, created_at) VALUES (?, ?, ?, ?, ?)');
for (const n of notices) insN.run(n.bot, n.text, n.next_update, null, n.created_at);
db.prepare('INSERT INTO ui_feed (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
  .run('feed', JSON.stringify(feed), '2026-11-26T18:00:00Z');
db.close();
console.log(JSON.stringify({ ok: true, db: dbPath, cards: cards.length, notifications: notices.length }));
