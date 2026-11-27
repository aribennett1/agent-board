import { useEffect, useState } from "react";
import { VERSION_PATH } from "./useLiveRefresh";

// A tab left open across a deploy keeps running the old script: live refresh swaps in new data, but old code drops any
// field it does not know (the review comment context on Nov 27 2026). The server names its current build in /api/version;
// when that differs from the script this tab loaded, the tab reloads itself the next time it is hidden (so nothing moves
// while he reads) and shows a small fixed "Reload" note meanwhile.

export const STALE_CHECK_MS = 30_000;
const BUILD_RE = /^\/assets\/[\w.-]+\.js$/;

/** The built main script this page loaded (/assets/index-<hash>.js), or null in dev and tests. */
export function loadedBuild(doc: Document = document): string | null {
  for (const s of doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
    const path = new URL(s.getAttribute("src") ?? "", doc.baseURI).pathname;
    if (BUILD_RE.test(path)) return path;
  }
  return null;
}

/** True when the server names a different build than the one this page runs. Unknown on either side: not stale. */
export function isStale(loaded: string | null, served: unknown): boolean {
  return Boolean(loaded) && typeof served === "string" && BUILD_RE.test(served) && served !== loaded;
}

export type StaleDeps = { doc?: Document; fetchImpl?: typeof fetch; reload?: () => void; intervalMs?: number };

/** Watches for a newer build. Returns a stop function. onStale fires once, the first time it is seen. */
export function watchBuild(onStale: () => void, deps: StaleDeps = {}): () => void {
  const doc = deps.doc ?? document;
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const reload = deps.reload ?? (() => doc.defaultView?.location.reload());
  const loaded = loadedBuild(doc);
  let stale = false;
  let stopped = false;
  if (!loaded) return () => {};
  const check = async () => {
    if (stale || stopped) return;
    try {
      const res = await fetchImpl(`${VERSION_PATH}?build=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const info = await res.json();
      if (stopped || !isStale(loaded, info?.ui)) return;
      stale = true;
      if (doc.hidden) reload();
      else onStale();
    } catch {
      // Offline or restarting: try again on the next tick.
    }
  };
  const onVisibility = () => {
    if (stale && doc.hidden) reload();
    else if (!doc.hidden) void check();
  };
  const timer = setInterval(() => void check(), deps.intervalMs ?? STALE_CHECK_MS);
  doc.addEventListener("visibilitychange", onVisibility);
  void check();
  return () => {
    stopped = true;
    clearInterval(timer);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}

export function useStaleBundle(): boolean {
  const [stale, setStale] = useState(false);
  useEffect(() => watchBuild(() => setStale(true)), []);
  return stale;
}
