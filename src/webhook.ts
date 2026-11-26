import type { WebhookConfig } from './config.ts';

export type Payload = { event: 'task.answered' | 'task.message'; task_id: string; text: string; sent_at: string };
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
export type Notify = (p: Payload) => Promise<'sent' | 'disabled' | 'failed'>;

/** POST a payload to the configured wake webhook. Never throws and never logs the URL or the auth value. */
export function makeNotify(cfg: WebhookConfig | null, fetchImpl: Fetch = fetch as unknown as Fetch, timeoutMs = 10_000): Notify {
  return async (p) => {
    if (!cfg) return 'disabled';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.auth) headers.Authorization = cfg.auth;
    try {
      const r = await fetchImpl(cfg.url, { method: 'POST', headers, body: JSON.stringify(p), signal: AbortSignal.timeout(timeoutMs) });
      return r.ok ? 'sent' : 'failed';
    } catch {
      return 'failed';
    }
  };
}
