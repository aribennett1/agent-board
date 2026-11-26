import { AUTHORS, type Author } from './db.ts';

export type ServerConfig = { dbPath: string; port: number; githubWebhookSecret: string | null; webhook: WebhookConfig | null; timeZone: string };

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

export function loadDbPath(env: Env = process.env): string {
  const dbPath = (env.AGENT_BOARD_DB ?? './agent-board.db').trim();
  if (!dbPath) throw new ConfigError('AGENT_BOARD_DB must not be empty');
  return dbPath;
}

/** Read and validate the server env. Throws ConfigError naming the bad variable. */
export function loadServerConfig(env: Env = process.env): ServerConfig {
  const dbPath = loadDbPath(env);
  const rawPort = env.PORT?.trim() || '8787';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) throw new ConfigError(`PORT must be an integer from 1 to 65535, got "${rawPort}"`);

  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (secret !== undefined && secret.trim() === '') throw new ConfigError('GITHUB_WEBHOOK_SECRET is set but empty; unset it or give it a value');

  const timeZone = env.AGENT_BOARD_TIMEZONE?.trim() || 'America/New_York';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new ConfigError(`AGENT_BOARD_TIMEZONE must be an IANA time zone like America/New_York, got "${timeZone}"`);
  }
  return { dbPath, port, githubWebhookSecret: secret ?? null, webhook: loadWebhookConfig(env), timeZone };
}

/** The bot identity for CLI writes: --bot flag, else AGENT_BOT. */
export function resolveAuthor(flag: string | undefined, env: Env = process.env): Author {
  const b = flag ?? env.AGENT_BOT;
  if (!b) throw new ConfigError(`--bot or AGENT_BOT is required (one of ${AUTHORS.join(', ')})`);
  if (!(AUTHORS as readonly string[]).includes(b)) throw new ConfigError(`bot must be one of ${AUTHORS.join(', ')}, got "${b}"`);
  return b as Author;
}

export type WebhookConfig = { url: string; auth: string | null };

/**
 * Optional outbound webhook that wakes the assistant when a person types in the board.
 * Unset means disabled. The URL and auth value are secrets: they stay server-side and are never logged or sent to the browser.
 */
export function loadWebhookConfig(env: Env = process.env): WebhookConfig | null {
  const url = env.AGENT_BOARD_WEBHOOK_URL?.trim();
  const auth = env.AGENT_BOARD_WEBHOOK_AUTH?.trim() || null;
  if (!url) {
    if (auth) throw new ConfigError('AGENT_BOARD_WEBHOOK_AUTH is set but AGENT_BOARD_WEBHOOK_URL is not');
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError('AGENT_BOARD_WEBHOOK_URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ConfigError('AGENT_BOARD_WEBHOOK_URL must be http or https');
  return { url, auth };
}
