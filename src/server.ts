import { createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { open } from './db.ts';
import { loadServerConfig, ConfigError } from './config.ts';
import { makeNotify, type Notify } from './webhook.ts';
import { OWNERS, addNote, getTask, ingest, printSender, runWake, type Clock } from './board.ts';
import { boardVersion } from './version.ts';
import { startFeedTimer } from './feed.ts';
import { makeEngineerAttentionWake } from './attention.ts';
import { mountUi, type UiOptions } from './ui-routes.ts';

// shortcut: no auth here; run the board behind an auth proxy (e.g. Cloudflare Access) and never expose it directly. Linear signatures are not verified yet; add before exposing.

type Json = Record<string, any>;

function githubSigOk(raw: string, sig: string | undefined, secret: string | null | undefined): boolean {
  if (!secret) return true;
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`);
  const got = Buffer.from(sig ?? '');
  return got.length === want.length && timingSafeEqual(got, want);
}

function normalizeGithub(event: string, b: Json): { pr: unknown; type: string; payload: Json } {
  const login = String(b.comment?.user?.login ?? b.review?.user?.login ?? '');
  const comment = /bugbot|\[bot\]/i.test(login) ? 'bugbot_comment' : 'review_comment';
  if (event === 'pull_request_review_comment' || event === 'pull_request_review') return { pr: b.pull_request?.number, type: comment, payload: { login } };
  if (event === 'issue_comment' && b.issue?.pull_request) return { pr: b.issue.number, type: comment, payload: { login } };
  if (event === 'check_run' && b.action === 'completed' && b.check_run?.conclusion === 'failure') {
    return { pr: b.check_run.pull_requests?.[0]?.number, type: 'check_failed', payload: { check: String(b.check_run.name ?? '') } };
  }
  // shortcut: GitHub doesn't say a push is merge-only; the sender sets merge_only. Upgrade: check the head commit's parents via the API.
  if (event === 'pull_request' && b.action === 'synchronize') return { pr: b.pull_request?.number ?? b.number, type: 'synchronize', payload: { merge_only: b.merge_only === true } };
  return { pr: b.pull_request?.number ?? b.number ?? b.check_run?.pull_requests?.[0]?.number, type: `${event}:${b.action ?? ''}`, payload: {} };
}

export type AppOptions = { notify?: Notify; githubWebhookSecret?: string | null; assistantName?: string; ui?: UiOptions };

export function createApp(db: DatabaseSync, clock: Clock, opts: AppOptions = {}): Hono {
  const app = new Hono();
  const notify = opts.notify ?? (async () => 'disabled' as const);

  // The board has no login of its own. Reject cross-site browser writes; real access control is the auth proxy in front.
  const sameOrigin = async (c: any, next: () => Promise<void>) => {
    const origin = c.req.header('Origin');
    let host: string | null = null;
    try {
      host = origin ? new URL(origin).host : null;
    } catch {
      return c.json({ error: 'bad origin' }, 403);
    }
    if (c.req.method !== 'GET' && origin && host !== c.req.header('Host')) return c.json({ error: 'cross-origin write refused' }, 403);
    await next();
  };
  app.use('/api/*', sameOrigin);
  app.use('/__ab/*', sameOrigin);

  app.get('/api/config', (c) => c.json({ assistantName: opts.assistantName ?? 'your assistant' }));
  app.get('/api/version', (c) => c.json({ version: boardVersion(db, Boolean(opts.ui?.webhook)) }, 200, { 'Cache-Control': 'no-store' }));


  function readBody(raw: string): Json | null {
    try {
      const b = JSON.parse(raw);
      return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
    } catch {
      return null;
    }
  }
  const deliveryOf = (header: string | undefined, b: Json) => header ?? (typeof b.id === 'string' || typeof b.id === 'number' ? String(b.id) : null);

  app.post('/webhooks/github', async (c) => {
    const raw = await c.req.text();
    if (!githubSigOk(raw, c.req.header('X-Hub-Signature-256'), opts.githubWebhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET)) return c.json({ error: 'bad signature' }, 401);
    const b = readBody(raw);
    const event = c.req.header('X-GitHub-Event');
    if (!b || !event) return c.json({ error: 'bad request' }, 400);
    const delivery = deliveryOf(c.req.header('X-GitHub-Delivery'), b);
    if (!delivery) return c.json({ error: 'no delivery id' }, 400);
    const n = normalizeGithub(event, b);
    const task = typeof n.pr === 'number' ? (db.prepare('SELECT id FROM tasks WHERE pr = ?').get(n.pr) as { id: string } | undefined) : undefined;
    if (!task) return c.json({ ignored: 'no task for this PR' }, 202);
    const fresh = ingest(db, { task_id: task.id, source: 'github', type: n.type, dedup_key: `github:${delivery}`, payload: n.payload }, clock);
    return c.json({ ok: true, duplicate: !fresh });
  });

  app.post('/webhooks/linear', async (c) => {
    const b = readBody(await c.req.text());
    if (!b) return c.json({ error: 'bad request' }, 400);
    const delivery = deliveryOf(c.req.header('Linear-Delivery'), b);
    if (!delivery) return c.json({ error: 'no delivery id' }, 400);
    const ticket = b.data?.identifier;
    const task = typeof ticket === 'string' ? (db.prepare('SELECT id FROM tasks WHERE ticket = ?').get(ticket) as { id: string } | undefined) : undefined;
    if (!task) return c.json({ ignored: 'no task for this ticket' }, 202);
    const labels = Array.isArray(b.data.labels) ? b.data.labels.map((l: Json) => String(l?.name)) : undefined;
    const fresh = ingest(db, {
      task_id: task.id, source: 'linear', type: `${b.type}:${b.action}`, dedup_key: `linear:${delivery}`,
      payload: { status: b.data.state?.name ?? null, labels },
    }, clock);
    return c.json({ ok: true, duplicate: !fresh });
  });

  app.get('/api/tasks', (c) => {
    const tasks = db.prepare(`SELECT t.*, (SELECT count(*) FROM cards WHERE task_id = t.id AND resolved_at IS NULL) AS open_cards
      FROM tasks t ORDER BY updated_at DESC`).all() as Json[];
    return c.json(tasks.map((t) => ({ ...t, owner: OWNERS[t.state as keyof typeof OWNERS] ?? 'human' })));
  });

  app.get('/api/tasks/:id', (c) => {
    const id = c.req.param('id');
    const task = getTask(db, id);
    if (!task) return c.json({ error: 'not found' }, 404);
    return c.json({
      task: { ...task, owner: OWNERS[task.state] ?? 'human' },
      notes: db.prepare('SELECT * FROM notes WHERE task_id = ? ORDER BY id').all(id),
      latest: db.prepare('SELECT * FROM notes_latest WHERE task_id = ? ORDER BY id').all(id),
      cards: db.prepare('SELECT * FROM cards WHERE task_id = ? AND resolved_at IS NULL ORDER BY id').all(id),
    });
  });

  app.post('/api/tasks/:id/answer', async (c) => {
    const id = c.req.param('id');
    if (!getTask(db, id)) return c.json({ error: 'not found' }, 404);
    const b = readBody(await c.req.text());
    const body = b?.body;
    if (typeof body !== 'string' || !body.trim() || body.length > 20_000) return c.json({ error: 'body must be a non-empty string' }, 400);
    const note = addNote(db, { task: id, author: 'human', kind: 'answer', body }, clock);
    const webhook = await notify({ event: 'task.answered', task_id: id, text: body, sent_at: clock.now().toISOString() });
    return c.json({ ok: true, note, webhook }, 201);
  });

  // A free-text message to the assistant about a task. Forwarded to the wake webhook only; the board stores nothing.
  app.post('/api/tasks/:id/message', async (c) => {
    const id = c.req.param('id');
    if (!getTask(db, id)) return c.json({ error: 'not found' }, 404);
    const text = readBody(await c.req.text())?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 20_000) return c.json({ error: 'text must be a non-empty string' }, 400);
    const webhook = await notify({ event: 'task.message', task_id: id, text, sent_at: clock.now().toISOString() });
    return c.json({ ok: webhook === 'sent', webhook }, webhook === 'sent' ? 200 : webhook === 'disabled' ? 503 : 502);
  });

  mountUi(app, db, clock, { assistantName: opts.assistantName, ...opts.ui });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let cfg;
  try {
    cfg = loadServerConfig();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(`config error: ${e.message}`);
    process.exit(1);
  }
  const db = open(cfg.dbPath);
  const clock = { now: () => new Date() };
  const assistantName = process.env.AGENT_BOARD_ASSISTANT_NAME?.trim() || undefined;
  const envFile = fileURLToPath(new URL('../.env', import.meta.url));
  const feed = { attentionWake: makeEngineerAttentionWake(db, { envFile }) };
  const app = createApp(db, clock, {
    notify: makeNotify(cfg.webhook), githubWebhookSecret: cfg.githubWebhookSecret, assistantName,
    ui: { envFile, dbPath: cfg.dbPath, webhook: cfg.webhook, timeZone: cfg.timeZone, repliesDir: process.env.AGENT_BOARD_REPLIES_DIR?.trim() || undefined, feed },
  });
  serve({ fetch: app.fetch, port: cfg.port }, (i) => console.log(`agent-board on :${i.port}${cfg.webhook ? ', wake webhook on' : ', wake webhook off'}`));
  startFeedTimer(db, feed);
  // the save script: settle batches every 10s (shadow mode sender: logs only)
  setInterval(() => runWake(db, { ...clock, send: printSender }), 10_000);
}
