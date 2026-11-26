import { useEffect, useRef } from "react";

// Live refresh: poll a small version endpoint every 10 seconds and when the tab becomes visible. Same hash: nothing
// happens. New hash: load the data and swap it in with no page reload, so React changes only what changed. Checks never
// overlap (busy), wait while a person is typing or the mic is on, keep scroll, and stop on teardown.

export const VERSION_PATH = "/api/version";
export const POLL_MS = 10_000;
export const VERSION_RE = /^[a-f0-9]{64}$/;

export async function versionInfo(fetchImpl: typeof fetch = fetch, path = VERSION_PATH): Promise<{ version: string }> {
  const res = await fetchImpl(`${path}?check=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("Version check failed");
  const info = await res.json();
  if (!info || typeof info.version !== "string" || !VERSION_RE.test(info.version)) throw new Error("Invalid board version");
  return info;
}

/** A person is busy: a text field is focused or holds a draft, or the mic is recording. */
export function userBusy(doc: Document = document): boolean {
  const el = doc.activeElement as HTMLElement | null;
  if (el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && (el as HTMLInputElement).type === "text"))) return true;
  if ([...doc.querySelectorAll("textarea")].some((t) => t.value.trim())) return true;
  return !!doc.querySelector(".mic-btn.listening");
}

export type Poller<_T = unknown> = {
  state: { version: string | undefined; busy: boolean; dead: boolean; checks: number; loads: number };
  start: () => Promise<void>;
  checkVersion: () => Promise<void>;
  destroy: () => void;
};

export type PollerOptions<T> = {
  /** Fetch the data; return null to skip this round. */
  load: () => Promise<T | null>;
  apply: (data: T) => void;
  fetchImpl?: typeof fetch;
  versionPath?: string;
  isIdle?: () => boolean;
  intervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  doc?: Document;
};

export function createPoller<T>(opts: PollerOptions<T>): Poller<T> {
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const isIdle = opts.isIdle ?? (() => !userBusy());
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const doc = opts.doc ?? document;
  const state: Poller<T>["state"] = { version: undefined, busy: false, dead: false, checks: 0, loads: 0 };
  let timer: ReturnType<typeof setInterval> | undefined;

  async function idle() {
    while (!state.dead && !isIdle()) await wait(250);
  }

  async function checkVersion() {
    if (state.busy || state.dead) return;
    state.busy = true;
    try {
      state.checks++;
      const info = await versionInfo(fetchImpl, opts.versionPath);
      if (info.version === state.version) return;
      state.loads++;
      const data = await opts.load();
      if (data == null || state.dead) return;
      await idle();
      if (state.dead) return;
      const y = typeof window !== "undefined" ? window.scrollY : 0;
      opts.apply(data);
      if (typeof window !== "undefined" && window.scrollY !== y) window.scrollTo?.(0, y);
      state.version = info.version;
    } catch (e) {
      if (!state.dead) console.warn("Board update postponed", e);
    } finally {
      state.busy = false;
    }
  }

  const onVisibility = () => {
    if (!doc.hidden) void checkVersion();
  };

  async function start() {
    await checkVersion();
    if (state.dead) return;
    timer = setInterval(() => void checkVersion(), opts.intervalMs ?? POLL_MS);
    doc.addEventListener("visibilitychange", onVisibility);
  }

  function destroy() {
    if (state.dead) return;
    state.dead = true;
    clearInterval(timer);
    doc.removeEventListener("visibilitychange", onVisibility);
  }

  return { state, start, checkVersion, destroy };
}

/** Run the poller while the component is mounted; cleans up on unmount. Latest load/apply are used without restarting. */
export function useLiveRefresh<T>(opts: PollerOptions<T>) {
  const ref = useRef(opts);
  ref.current = opts;
  useEffect(() => {
    const p = createPoller<T>({
      ...ref.current,
      load: () => ref.current.load(),
      apply: (d) => ref.current.apply(d),
    });
    void p.start();
    return () => p.destroy();
  }, []);
}
