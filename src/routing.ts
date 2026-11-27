import { existsSync, readFileSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { WebhookConfig } from './config.ts';
import { raisedByOf, isBoardBot, type BoardBot } from '../ui/src/raisedBy.ts';

// Answers go straight to the bot that raised the card, or to the bot the person picked, never through Grok Bot.
// Each bot has its own webhook in .env: AB_WEBHOOK_URL_<BOT> and AB_WEBHOOK_SECRET_<BOT> (sent as the Authorization
// header exactly as written, like AGENT_BOARD_WEBHOOK_AUTH). Grok Bot's AGENT_BOARD_WEBHOOK_URL / _AUTH stay the
// fallback for an unknown author or a bot with no key. The .env file is re-read on every forward (cached by mtime),
// so a bot adding its keys needs no restart. URLs and secrets are never logged or returned.

type Json = Record<string, any>;
export const BOT_KEY: Partial<Record<BoardBot, string>> = { Planner: 'PLANNER', QA: 'QA', Engineer: 'ENGINEER', 'dr eggbot': 'EGGBOT' };
export const ROUTE_KEYS = ['AB_WEBHOOK_URL', 'AB_WEBHOOK_SECRET'] as const;

let cache: { path: string; mtime: number; vars: Record<string, string> } | null = null;

/** KEY=VALUE lines, optional `export` and quotes. Parsed, never executed. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function envVars(envFile: string | undefined): Record<string, string | undefined> {
  if (!envFile || !existsSync(envFile)) return process.env;
  const mtime = statSync(envFile).mtimeMs;
  if (!cache || cache.path !== envFile || cache.mtime !== mtime) cache = { path: envFile, mtime, vars: parseEnv(readFileSync(envFile, 'utf8')) };
  return { ...process.env, ...cache.vars };
}

function asWebhook(url: string | undefined, auth: string | undefined): WebhookConfig | null {
  const u = url?.trim();
  if (!u) return null;
  try {
    const p = new URL(u);
    if (p.protocol !== 'https:' && p.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return { url: u, auth: auth?.trim() || null };
}

/** The author of the card an answer or message is about, from the same data the Conversation labels use. */
export function authorOfPayload(db: DatabaseSync, p: Json, derived: Json[]): BoardBot | undefined {
  const id = typeof p.decision_id === 'string' && p.decision_id ? p.decision_id
    : p.event === 'item.message' && p.item_section === 'decision' && typeof p.item_id === 'string' ? p.item_id : null;
  if (!id) return undefined;
  const row = db.prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string } | undefined;
  let doc: Json = {};
  try {
    doc = row ? JSON.parse(row.json) : {};
  } catch { /* an unreadable document just means no extra data */ }
  const card = (Array.isArray(doc.decisions) ? doc.decisions : []).find((d: Json) => d?.id === id) ?? derived.find((d) => d.id === id);
  return raisedByOf(card ?? { id }, doc.details);
}

export type Route = { webhook: WebhookConfig | null; bot: BoardBot | null; via: 'bot' | 'default' };

/** Where to send this payload: the picked bot (to_bot), else the card's author, else Grok Bot's webhook. */
export function routeWebhook(db: DatabaseSync, p: Json, derived: () => Json[], defaultHook: WebhookConfig | null, envFile?: string): Route {
  const picked = isBoardBot(p.to_bot) ? p.to_bot : undefined;
  // A note or post on a drafted review (Reviews tab, no card) is QA's: QA writes the drafts. Without this it fell back to
  // Grok Bot's webhook, and QA only saw it if someone passed it on.
  const drafted = p.event === 'review.answer' && !p.card_id ? 'QA' : undefined;
  const bot = picked ?? authorOfPayload(db, p, derived()) ?? drafted;
  const key = bot ? BOT_KEY[bot] : undefined;
  if (bot && key) {
    const vars = envVars(envFile);
    const hook = asWebhook(vars[`AB_WEBHOOK_URL_${key}`], vars[`AB_WEBHOOK_SECRET_${key}`]);
    if (hook) return { webhook: hook, bot, via: 'bot' };
  }
  // Grok Bot's own webhook, re-read too so a changed key applies without a restart.
  const vars = envVars(envFile);
  const fresh = envFile ? asWebhook(vars.AGENT_BOARD_WEBHOOK_URL, vars.AGENT_BOARD_WEBHOOK_AUTH) : null;
  return { webhook: fresh ?? defaultHook, bot: bot ?? null, via: 'default' };
}
