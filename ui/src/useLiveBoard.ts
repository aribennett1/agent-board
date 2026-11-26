import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { isBoard } from "./data/parse";
import type { Board, Project } from "./data/types";
import { createPoller as createLivePoller, type Poller as LivePoller } from "./useLiveRefresh";

// Server routes: a small content hash (polled by useLiveRefresh), and the full board (decisions, glance, details, project...).
export const BOARD_PATH = "/__ab/board";
export { POLL_MS, VERSION_PATH, VERSION_RE, versionInfo, userBusy } from "./useLiveRefresh";

type Feed = { board: Board; project: Project | null };
type Listener = () => void;
export type Poller = LivePoller<Feed>;

export function createPoller(opts: {
  apply: (feed: Feed) => void;
  fetchImpl?: typeof fetch;
  isIdle?: () => boolean;
  intervalMs?: number;
  wait?: (ms: number) => Promise<void>;
  doc?: Document;
}): Poller {
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return createLivePoller<Feed>({
    ...opts,
    fetchImpl,
    load: async () => {
      const res = await fetchImpl(BOARD_PATH, { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!res.ok) return null;
      const json = await res.json();
      if (!isBoard(json)) return null;
      const { project, ...board } = json as Board & { project?: Project };
      return { board: board as Board, project: project ?? null };
    },
  });
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
        feed = next;
        for (const fn of listeners) fn();
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

/** True once a poll has replaced the bundled board with the server's. */
export function useLiveReady(): boolean {
  return useSyncExternalStore(subscribe, () => feed !== null, () => false);
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
