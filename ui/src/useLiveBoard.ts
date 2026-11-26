import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { isBoard } from "./data/parse";
import type { Board, Project } from "./data/types";

// Server routes: a small content hash, and the full board (decisions, glance, details, project...).
export const VERSION_PATH = "/api/version";
export const BOARD_PATH = "/__ab/board";
export const POLL_MS = 10_000;
export const VERSION_RE = /^[a-f0-9]{64}$/;

// Poll a version endpoint every 10 seconds and when the tab
// becomes visible. Same hash: nothing happens. New hash: fetch the board and swap it in; React then changes only the
// parts of the page whose data changed. Checks never overlap (busy), wait while a person is typing or the mic is on,
// keep the scroll position, and stop on teardown.

export async function versionInfo(fetchImpl: typeof fetch = fetch): Promise<{ version: string }> {
  const res = await fetchImpl(`${VERSION_PATH}?check=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("Version check failed");
  const info = await res.json();
  if (!info || !VERSION_RE.test(info.version)) throw new Error("Invalid board version");
  return info;
}

/** A person is busy: a text field is focused or holds a draft, or the mic is recording. */
export function userBusy(doc: Document = document): boolean {
  const el = doc.activeElement as HTMLElement | null;
  if (el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && (el as HTMLInputElement).type === "text"))) return true;
  return !!doc.querySelector(".mic-btn.listening");
}

type Feed = { board: Board; project: Project | null };
type Listener = () => void;

export type Poller = {
  state: { version: string | undefined; busy: boolean; dead: boolean; checks: number; loads: number };
  start: () => Promise<void>;
  checkVersion: () => Promise<void>;
  destroy: () => void;
};

export function createPoller(opts: {
  apply: (feed: Feed) => void;
  fetchImpl?: typeof fetch;
  isIdle?: () => boolean;
  intervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  doc?: Document;
}): Poller {
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const isIdle = opts.isIdle ?? (() => !userBusy());
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const doc = opts.doc ?? document;
  const state: Poller["state"] = { version: undefined, busy: false, dead: false, checks: 0, loads: 0 };
  let timer: ReturnType<typeof setInterval> | undefined;

  async function idle() {
    while (!state.dead && !isIdle()) await wait(250);
  }

  async function load(): Promise<Feed | null> {
    state.loads++;
    const res = await fetchImpl(BOARD_PATH, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const json = await res.json();
    if (!isBoard(json)) return null;
    const { project, ...board } = json as Board & { project?: Project };
    return { board: board as Board, project: project ?? null };
  }

  async function checkVersion() {
    if (state.busy || state.dead) return;
    state.busy = true;
    try {
      state.checks++;
      const info = await versionInfo(fetchImpl);
      if (info.version === state.version) return;
      const feed = await load();
      if (!feed || state.dead) return;
      await idle();
      if (state.dead) return;
      opts.apply(feed);
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

// One shared feed for the whole page (board sections and the project tab), started by the first subscriber.
let feed: Feed | null = null;
let poller: Poller | null = null;
const listeners = new Set<Listener>();
let users = 0;

function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function startFeed() {
  users++;
  if (!poller) {
    poller = createPoller({
      apply: (next) => {
        const y = typeof window !== "undefined" ? window.scrollY : 0;
        feed = next;
        for (const fn of listeners) fn();
        if (typeof window !== "undefined" && window.scrollY !== y) window.scrollTo?.(0, y);
      },
    });
    void poller.start();
  }
  return () => {
    users--;
    if (users === 0) {
      poller?.destroy();
      poller = null;
    }
  };
}

/** Test hook: forget the shared feed between renders. */
export function resetLiveFeed() {
  poller?.destroy();
  poller = null;
  feed = null;
  users = 0;
  listeners.clear();
}

function useFeed(): Feed | null {
  useEffect(startFeed, []);
  return useSyncExternalStore(subscribe, () => feed, () => feed);
}

// The board as the server has it now. Starts from `initial` until the first poll lands.
export function useLiveBoard(initial: Board): Board {
  const f = useFeed();
  const y = useRef(0);
  // Keep the scroll position across a swap even if layout shifts.
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    if (window.scrollY !== y.current && y.current > 0) window.scrollTo?.(0, y.current);
  });
  if (typeof window !== "undefined") y.current = window.scrollY;
  return f?.board ?? initial;
}

/** The project tab's data from the same poll; null until the server has sent one. */
export function useLiveProject(): Project | null {
  return useFeed()?.project ?? null;
}

/** Test hook: swap a board in as if a poll had fetched it. */
export function pushBoard(board: Board, project: Project | null = feed?.project ?? null) {
  feed = { board, project };
  for (const fn of listeners) fn();
}
