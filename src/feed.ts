import { execFile } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { watchAttention, type AttentionWake } from './attention.ts';

// The data behind My tickets, My PRs and Others' PRs. The board server fetches it itself on a timer: GitHub through
// the gh CLI (GraphQL) and Linear through its GraphQL API with LINEAR_API_KEY. No bot, no AI call and no `ab` command
// is involved, and nothing here writes to GitHub or Linear.

type Json = Record<string, any>;

export type Gh = (args: string[]) => Promise<string>;
export type LinearFetch = (query: string, key: string) => Promise<Json>;
export type FeedDeps = { gh?: Gh; linear?: LinearFetch; linearKey?: string | null; now?: () => Date; /** Test hook: override LINEAR_FEED_ENABLED. */ linearEnabled?: boolean; /** Wake Engineer when a PR is flagged (tests inject a fake). */ attentionWake?: AttentionWake };

export const FEED_INTERVAL_MS = 120_000;
/** How often the timer checks the stored QA drafts (a local read, no GitHub call) for a PR it has not fetched yet. */
export const DRAFT_CHECK_MS = 10_000;
// My tickets is hidden for now. Set this to true (and put "tickets" back in the sidebar and BOARD_VIEWS) to fetch Linear again.
export const LINEAR_FEED_ENABLED = false;
const BODY_MAX = 6000;
const THREAD_BODY_MAX = 400;

const ghExec: Gh = (args) => new Promise((resolve, reject) => {
  execFile('gh', args, { timeout: 60_000, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
    if (err) return reject(new Error(String(stderr || err.message).split('\n')[0].slice(0, 200)));
    resolve(stdout);
  });
});

const linearExec: LinearFetch = async (query, key) => {
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Linear answered HTTP ${res.status}`);
  const j = (await res.json()) as Json;
  if (j.errors?.length) throw new Error(`Linear: ${String(j.errors[0]?.message ?? 'error').slice(0, 160)}`);
  return j.data;
};

const PR_FIELDS = `
  number title url isDraft body additions deletions changedFiles reviewDecision mergeable createdAt updatedAt headRefName baseRefName
  repository { nameWithOwner name }
  author { login }
  labels(first: 12) { nodes { name color } }
  comments { totalCount }
  reviews { totalCount }
  reviewThreads(first: 40) { nodes { isResolved isOutdated comments(first: 1) { totalCount nodes { author { login } path body url } } } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
  latestReviews(first: 20) { nodes { state author { login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 60) { nodes { __typename ... on CheckRun { name conclusion status } ... on StatusContext { context state } } } } } } }
`;

// One search per request: a combined query for both lists is heavy enough for GitHub to answer 504.
// Pages of 30 with a cursor: a list longer than one page (Eric is on 35 open PRs) used to drop the oldest rows.
const GH_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 30, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${PR_FIELDS} } } }
}`;
const MAX_PAGES = 5;

function checksOf(pr: Json) {
  const roll = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const failing: string[] = [];
  let passed = 0, failed = 0, pending = 0;
  for (const n of roll?.contexts?.nodes ?? []) {
    if (n.__typename === 'CheckRun') {
      if (n.status !== 'COMPLETED') pending++;
      else if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(n.conclusion)) passed++;
      else { failed++; failing.push(String(n.name)); }
    } else if (n.__typename === 'StatusContext') {
      if (n.state === 'SUCCESS') passed++;
      else if (n.state === 'PENDING' || n.state === 'EXPECTED') pending++;
      else { failed++; failing.push(String(n.context)); }
    }
  }
  const s = roll?.state as string | undefined;
  const ci = !roll ? 'none' : s === 'SUCCESS' ? 'passing' : s === 'FAILURE' || s === 'ERROR' ? 'failing' : 'pending';
  return { ci, checks: { passed, failed, pending, failing: failing.slice(0, 8) } };
}

/** Review threads still open, with their first comment: what someone left for the PR author to address. */
function unresolvedOf(pr: Json) {
  const open = (pr.reviewThreads?.nodes ?? []).filter((t: Json) => !t.isResolved);
  const list = open.slice(0, 10).map((t: Json) => {
    const c = t.comments?.nodes?.[0] ?? {};
    return { author: c.author?.login ?? 'unknown', path: c.path ?? '', body: String(c.body ?? '').slice(0, THREAD_BODY_MAX), url: c.url ?? '' };
  });
  return { count: open.length, list };
}

export function normalizePr(pr: Json, me: string): Json {
  const { ci, checks } = checksOf(pr);
  const threads = pr.reviewThreads?.nodes ?? [];
  const threadComments = threads.reduce((n: number, t: Json) => n + (t.comments?.totalCount ?? 0), 0);
  const unresolved = unresolvedOf(pr);
  const state = pr.isDraft ? 'draft' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : pr.reviewDecision === 'APPROVED' ? 'approved' : 'ready';
  const requested = (pr.reviewRequests?.nodes ?? []).some((r: Json) => r.requestedReviewer?.login === me);
  const mineReview = (pr.latestReviews?.nodes ?? []).find((r: Json) => r.author?.login === me);
  const who = requested ? 'Your review requested' : mineReview ? `You ${String(mineReview.state).toLowerCase().replace(/_/g, ' ')}` : 'Involves you';
  return {
    repo: pr.repository?.name ?? '', repo_full: pr.repository?.nameWithOwner ?? '', number: pr.number, title: pr.title, link: pr.url,
    author: pr.author?.login ?? 'unknown', who, state, ci, checks,
    reviews: pr.reviews?.totalCount ?? 0,
    review_decision: pr.reviewDecision ?? null,
    labels: (pr.labels?.nodes ?? []).map((l: Json) => ({ name: l.name, color: l.color })),
    comments: (pr.comments?.totalCount ?? 0) + threadComments,
    additions: pr.additions ?? 0, deletions: pr.deletions ?? 0, files: pr.changedFiles ?? 0,
    unresolved_count: unresolved.count, unresolved: unresolved.list,
    branch: pr.headRefName ?? '', base: pr.baseRefName ?? '', mergeable: pr.mergeable ?? null,
    body: String(pr.body ?? '').slice(0, BODY_MAX),
    created_at: pr.createdAt, updated_at: pr.updatedAt,
  };
}

const byUpdated = (a: Json, b: Json) => String(b.updated_at).localeCompare(String(a.updated_at));

async function searchPage(gh: Gh, q: string, after: string | null): Promise<Json> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return JSON.parse(await gh(['api', 'graphql', '-f', `query=${GH_QUERY}`, '-f', `q=${q}`, ...(after ? ['-f', `after=${after}`] : [])])).data?.search ?? {};
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function searchPrs(gh: Gh, q: string, me: string): Promise<Json[]> {
  const nodes: Json[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const s = await searchPage(gh, q, after);
    nodes.push(...(s.nodes ?? []));
    if (!s.pageInfo?.hasNextPage || !s.pageInfo.endCursor) break;
    after = String(s.pageInfo.endCursor);
  }
  const seen = new Set<number>();
  return nodes.filter((n: Json) => n?.number && !seen.has(n.number) && seen.add(n.number)).map((n: Json) => normalizePr(n, me)).sort(byUpdated);
}

// A PR QA drafted a review for gets a row on Others' PRs even when GitHub does not ask for Eric's review and he is
// not otherwise involved. Membership comes from the stored drafts (board.reviews), never from a card.
export const QA_DRAFTED_WHO = 'Not requested, QA drafted';

const PR_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { state ${PR_FIELDS} } }
}`;

/** "rows-backend/2004" for every ROWSHR draft with a finding still pending and the review not marked done. */
export function draftedPrKeys(db: DatabaseSync): { repo: string; number: number }[] {
  const row = db.prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string } | undefined;
  let reviews: unknown = [];
  try { reviews = row ? JSON.parse(row.json)?.reviews : []; } catch { reviews = []; }
  if (!Array.isArray(reviews)) return [];
  const out: { repo: string; number: number }[] = [];
  for (const d of reviews as Json[]) {
    if (!d || typeof d !== 'object' || d.done === true) continue;
    const repo = String(d.repo ?? '').replace(/^ROWSHR\//i, '');
    if (!/^[\w.-]+$/.test(repo) || !Number.isInteger(d.pr) || d.pr < 1) continue;
    if (!(Array.isArray(d.comments) ? d.comments : []).some((c: Json) => c?.status === 'pending')) continue;
    if (!out.some((k) => k.repo === repo && k.number === d.pr)) out.push({ repo, number: d.pr });
  }
  return out;
}

/** One ROWSHR PR by number, normalized like the search rows; null when it is closed, merged, gone or by Eric. */
async function fetchPr(gh: Gh, repo: string, number: number, me: string): Promise<Json | null> {
  const out = JSON.parse(await gh(['api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', 'owner=ROWSHR', '-f', `name=${repo}`, '-F', `number=${number}`]));
  const pr = out.data?.repository?.pullRequest;
  if (!pr?.number || pr.state !== 'OPEN' || pr.author?.login === me) return null;
  const row = normalizePr(pr, me);
  // Keep what GitHub says when it asks for Eric's review or he reviewed; label it only when nothing else ties him to it.
  return row.who === 'Involves you' ? { ...row, who: QA_DRAFTED_WHO, qa_drafted: true } : row;
}

async function fetchGithub(gh: Gh, drafted: { repo: string; number: number }[] = []) {
  const me = (await gh(['api', 'user', '--jq', '.login'])).trim();
  if (!me) throw new Error('gh is not signed in');
  const [mine, others] = await Promise.all([
    searchPrs(gh, `org:ROWSHR is:pr is:open archived:false author:${me}`, me),
    searchPrs(gh, `org:ROWSHR is:pr is:open archived:false involves:${me} -author:${me}`, me),
  ]);
  const have = new Set([...mine, ...others].map((p) => `${p.repo}/${p.number}`));
  const missing = drafted.filter((k) => !have.has(`${k.repo}/${k.number}`));
  // One PR failing to load drops only that row; the rest of the feed stays good.
  const extra = await Promise.all(missing.map((k) => fetchPr(gh, k.repo, k.number, me).catch((e) => (console.error(`drafted PR ${k.repo}#${k.number}: ${errText(e)}`), null))));
  return { login: me, mine, others: [...others, ...extra.filter((p): p is Json => p !== null)] };
}

const LINEAR_QUERY = `{
  issues(first: 100, orderBy: updatedAt, filter: { assignee: { isMe: { eq: true } }, state: { type: { nin: ["completed", "canceled"] } } }) {
    nodes { identifier title url priority priorityLabel dueDate updatedAt estimate
      state { name type color } project { name } team { key }
      labels(first: 8) { nodes { name color } }
      attachments(first: 8) { nodes { url sourceType } } }
  }
}`;

// Work in progress first, then review, then not started, then backlog.
const STATE_ORDER: Record<string, number> = { started: 0, unstarted: 1, triage: 2, backlog: 3 };

export function normalizeTicket(i: Json): Json {
  return {
    id: i.identifier, title: i.title, link: i.url, status: i.state?.name ?? 'Unknown', status_type: i.state?.type ?? '',
    status_color: i.state?.color ?? null,
    priority: i.priority ?? 0, priority_label: i.priority ? i.priorityLabel : '',
    project: i.project?.name ?? '', due: i.dueDate ?? null, estimate: i.estimate ?? null,
    labels: (i.labels?.nodes ?? []).map((l: Json) => ({ name: l.name, color: l.color })),
    prs: (i.attachments?.nodes ?? []).filter((a: Json) => /github\.com\/.+\/pull\/\d+/.test(String(a.url))).map((a: Json) => String(a.url)),
    updated_at: i.updatedAt,
  };
}

async function fetchLinear(linear: LinearFetch, key: string) {
  const data = await linear(LINEAR_QUERY, key);
  const tickets = (data?.issues?.nodes ?? []).map(normalizeTicket);
  const rank = (t: Json) => (/review/i.test(t.status) ? 0.5 : STATE_ORDER[t.status_type] ?? 4);
  return tickets.sort((a: Json, b: Json) => rank(a) - rank(b) || (a.priority || 5) - (b.priority || 5) || byUpdated(a, b));
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** Fetch both sources and store the result. A source that fails keeps its last good items and records the error. */
export async function refreshFeed(db: DatabaseSync, deps: FeedDeps = {}): Promise<Json> {
  const now = (deps.now ?? (() => new Date()))();
  const prev = readFeed(db) ?? {};
  const feed: Json = {
    tickets: prev.tickets ?? [], mine: prev.mine ?? [], others: prev.others ?? [],
    github: { ok: false, login: prev.github?.login ?? null, error: null, last_ok: prev.github?.last_ok ?? null },
    linear: { ok: false, configured: false, error: null, last_ok: prev.linear?.last_ok ?? null },
  };
  const iso = now.toISOString();
  try {
    const g = await fetchGithub(deps.gh ?? ghExec, draftedPrKeys(db));
    feed.mine = g.mine; feed.others = g.others;
    feed.github = { ok: true, login: g.login, error: null, last_ok: iso };
  } catch (e) {
    feed.github.error = errText(e);
  }
  // Linear is off while My tickets is hidden. The fetch, normalizeTicket and LINEAR_QUERY stay so this is one flag to turn back on.
  if (!(deps.linearEnabled ?? LINEAR_FEED_ENABLED)) {
    feed.tickets = [];
    feed.linear = { ok: false, configured: false, enabled: false, error: null, last_ok: null };
  } else {
    const key = deps.linearKey ?? process.env.LINEAR_API_KEY?.trim() ?? '';
    if (!key) {
      feed.linear = { ok: false, configured: false, enabled: true, error: 'LINEAR_API_KEY is not set in the board .env', last_ok: null };
      feed.tickets = [];
    } else {
      feed.linear.configured = true;
      feed.linear.enabled = true;
      try {
        feed.tickets = await fetchLinear(deps.linear ?? linearExec, key);
        feed.linear = { ok: true, configured: true, enabled: true, error: null, last_ok: iso };
      } catch (e) {
        feed.linear.error = errText(e);
      }
    }
  }
  db.prepare('INSERT INTO ui_feed (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at')
    .run('feed', JSON.stringify(feed), iso);
  if (feed.github.ok) {
    try {
      await watchAttention(db, feed.mine, now, deps.attentionWake);
    } catch (e) {
      console.error(`attention watch failed: ${errText(e)}`);
    }
  }
  return feed;
}

export function readFeed(db: DatabaseSync): Json | null {
  const row = db.prepare("SELECT json, updated_at FROM ui_feed WHERE key = 'feed'").get() as { json: string; updated_at: string } | undefined;
  if (!row) return null;
  try {
    return { ...JSON.parse(row.json), fetched_at: row.updated_at };
  } catch {
    return null;
  }
}

/** Start the timer. Overlapping runs are skipped; the first run starts at once. Returns a stop function. */
export function startFeedTimer(db: DatabaseSync, deps: FeedDeps = {}, everyMs = FEED_INTERVAL_MS, draftCheckMs = DRAFT_CHECK_MS): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await refreshFeed(db, deps);
    } catch (e) {
      console.error(`feed refresh failed: ${errText(e)}`);
    } finally {
      running = false;
    }
  };
  void tick();
  const t = setInterval(tick, everyMs);
  t.unref?.();
  // A new QA draft on a PR the last fetch did not cover gets its row within seconds, not at the next two-minute run.
  let seen = draftSig(db);
  const w = setInterval(() => {
    const sig = draftSig(db);
    if (sig === seen) return;
    seen = sig;
    void tick();
  }, draftCheckMs);
  w.unref?.();
  return () => { clearInterval(t); clearInterval(w); };
}

const draftSig = (db: DatabaseSync) => draftedPrKeys(db).map((k) => `${k.repo}/${k.number}`).sort().join(',');
