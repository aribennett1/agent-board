import type { DatabaseSync } from 'node:sqlite';
import { routeWebhook } from './routing.ts';
import { slimPayload } from './context.ts';
import type { Fetch } from './webhook.ts';

type Json = Record<string, any>;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isId = (v: unknown): v is string => isStr(v) && v.length > 0;
const isStrOrList = (v: unknown) => isStr(v) || (Array.isArray(v) && v.every(isStr));

/** The delivery log line: only known fields in a fixed order, so a URL, auth value or message text is never stored. */
export function deliveryLogEntry(body: unknown): Json | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Json;
  const outcome = (b.http === null || Number.isInteger(b.http)) && (b.via === null || b.via === 'direct' || b.via === 'fallback') &&
    Number.isInteger(b.attempt) && b.attempt >= 0 && ['delivered', 'failed', 'retrying'].includes(b.status) && isStr(b.at);
  if (!outcome) return null;
  const { http, via, attempt, status, at } = b;
  if (b.event === 'pr.attention') {
    if (!Number.isInteger(b.pr) || b.pr <= 0) return null;
    return { event: 'pr.attention', pr: b.pr, http, via, attempt, status, at };
  }
  if (b.event === 'item.message') {
    if (!isId(b.message_id) || !isId(b.item_id) || !isId(b.item_section)) return null;
    return { event: 'item.message', message_id: b.message_id, item_id: b.item_id, item_section: b.item_section, http, via, attempt, status, at };
  }
  if (b.event === 'decision.clarify' || b.event === 'decision.not_relevant' || b.event === 'review.answer') {
    if (!isId(b.decision_id)) return null;
    return { event: b.event, decision_id: b.decision_id, http, via, attempt, status, at };
  }
  if (b.event !== undefined && b.event !== 'decision.answered') return null;
  if (!isId(b.decision_id) || !isStrOrList(b.answer) || !isStrOrList(b.answer_label)) return null;
  return { event: 'decision.answered', decision_id: b.decision_id, answer: b.answer, answer_label: b.answer_label, http, via, attempt, status, at };
}

export type DeliverOpts = {
  envFile?: string;
  fetchImpl?: Fetch;
  timeoutMs?: number;
  now?: () => Date;
};

/**
 * POST a payload to the bot named in to_bot (or the card author) using the same routing as /__ab/webhook.
 * Never falls back to Grok Bot: if that bot has no hook, nothing is sent. Writes ui_delivery_log and never logs a URL or secret.
 */
export async function deliverToBot(db: DatabaseSync, payload: Json, opts: DeliverOpts = {}): Promise<'delivered' | 'failed'> {
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const route = routeWebhook(db, payload, () => [], null, opts.envFile);
  const hook = route.via === 'bot' && route.webhook ? route.webhook : null;
  const write = (http: number | null, status: 'delivered' | 'failed') => {
    const entry = deliveryLogEntry({ event: payload.event, pr: payload.pr, http, via: hook ? 'direct' : null, attempt: 1, status, at });
    if (entry) db.prepare('INSERT INTO ui_delivery_log (json) VALUES (?)').run(JSON.stringify(entry));
  };
  if (!hook) {
    write(null, 'failed');
    return 'failed';
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (hook.auth) headers.Authorization = hook.auth;
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as Fetch);
  const body = JSON.stringify(slimPayload(payload, route.bot));
  try {
    const r = await fetchImpl(hook.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    write(r.status, r.ok ? 'delivered' : 'failed');
    return r.ok ? 'delivered' : 'failed';
  } catch {
    write(null, 'failed');
    return 'failed';
  }
}
