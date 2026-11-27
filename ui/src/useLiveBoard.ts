import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { afterLiveUpdate, beforeLiveUpdate, installInteractionTracker } from "./scrollAnchor";
import { isBoard } from "./data/parse";
import type { Ask, Board, Decision, ItemDetail, Project } from "./data/types";
import { applyDelta, flattenBoard, isDelta, unflattenBoard, type Flat } from "./boardDelta";
import { createPoller as createLivePoller, type Poller as LivePoller } from "./useLiveRefresh";

// Server routes: a small content hash (polled by useLiveRefresh), and the board (decisions, glance, details, project...).
// The board leaves out done topics (BOARD_DONE_PATH pages them in when "Show done" opens) and PR descriptions
// (PR_DETAIL_PATH, on expand). After the first load it asks for ?since=<rev> and gets only what changed.
export const BOARD_PATH = "/__ab/board";
export const BOARD_DONE_PATH = "/__ab/board/done";
export const PR_DETAIL_PATH = "/__ab/pr-detail";
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
  // The board as last loaded, in parts, so the next load can ask for just the change (boardDelta.ts).
  let last: Flat | null = null;
  const get = async (since?: string) => {
    const res = await fetchImpl(since ? `${BOARD_PATH}?since=${encodeURIComponent(since)}` : BOARD_PATH, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    return res.ok ? ((await res.json()) as unknown) : null;
  };
  return createLivePoller<Feed>({
    ...opts,
    fetchImpl,
    load: async () => {
      let json = await get(last?.version || undefined);
      let next: Flat | null = null;
      if (isDelta(json)) {
        next = last ? applyDelta(last, json) : null;
        // A delta that does not fit (server restarted, or a version it no longer remembers): load the whole board.
        if (!next) json = await get();
      }
      if (!next) {
        if (!json || typeof json !== "object" || isDelta(json)) return null;
        const { rev, ...rest } = json as Record<string, unknown> & { rev?: unknown };
        next = flattenBoard(rest, typeof rev === "string" ? rev : "");
      }
      const whole = unflattenBoard(next);
      if (!isBoard(whole)) return null;
      last = next;
      const { project, ...board } = whole as Board & { project?: Project };
      return { board: board as Board, project: project ?? null };
    },
  });
}

// Done topics the board left out, paged in per bot section when "Show done" opens. Merged under the live board.
export type DoneSummary = { total: number; by_bot: Record<string, number> };
type DonePage = { total: number; offset: number; limit: number; has_more: boolean; topics: string[]; decisions: Decision[]; asks: Ask[]; details: Record<string, ItemDetail> };
type DoneState = { decisions: Map<string, Decision>; asks: Map<string, Ask>; details: Record<string, ItemDetail>; loaded: Set<string>; pages: Record<string, { next: number; has_more: boolean; loading: boolean }> };
let done: DoneState = { decisions: new Map(), asks: new Map(), details: {}, loaded: new Set(), pages: {} };
let doneRev = 0;
const doneListeners = new Set<Listener>();
const notifyDone = () => {
  doneRev++;
  for (const fn of doneListeners) fn();
};
const subscribeDone = (fn: Listener) => {
  doneListeners.add(fn);
  return () => doneListeners.delete(fn);
};

/** Load the next page of a bot section's done topics. Returns false when the request failed. */
export async function loadMoreDone(bot: string, fetchImpl: typeof fetch = fetch, limit = 20): Promise<boolean> {
  const p = done.pages[bot] ?? { next: 0, has_more: true, loading: false };
  if (p.loading || !p.has_more) return true;
  done = { ...done, pages: { ...done.pages, [bot]: { ...p, loading: true } } };
  notifyDone();
  try {
    const res = await fetchImpl(`${BOARD_DONE_PATH}?bot=${encodeURIComponent(bot)}&offset=${p.next}&limit=${limit}`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(String(res.status));
    const page = (await res.json()) as DonePage;
    if (typeof document !== "undefined") beforeLiveUpdate(document);
    const decisions = new Map(done.decisions);
    for (const d of page.decisions ?? []) decisions.set(d.id, d);
    const asks = new Map(done.asks);
    for (const a of page.asks ?? []) asks.set(a.id, a);
    done = {
      decisions, asks, details: { ...done.details, ...(page.details ?? {}) },
      loaded: new Set([...done.loaded, ...(page.topics ?? [])]),
      pages: { ...done.pages, [bot]: { next: page.offset + (page.topics?.length ?? 0), has_more: Boolean(page.has_more), loading: false } },
    };
    notifyDone();
    return true;
  } catch {
    done = { ...done, pages: { ...done.pages, [bot]: { ...p, loading: false } } };
    notifyDone();
    return false;
  }
}

/** The live board's count of done topics it left out, and what "Show done" has loaded so far per bot. */
export function useDoneInfo(): { summary?: DoneSummary; loaded: Set<string>; page: (bot: string) => { has_more: boolean; loading: boolean; started: boolean } } {
  useSyncExternalStore(subscribeDone, () => doneRev, () => doneRev);
  const summary = useSyncExternalStore(subscribe, () => (feed?.board as Board & { done_summary?: DoneSummary } | undefined)?.done_summary, () => undefined);
  return {
    summary,
    loaded: done.loaded,
    page: (bot) => {
      const p = done.pages[bot];
      return { has_more: p ? p.has_more : true, loading: Boolean(p?.loading), started: Boolean(p) };
    },
  };
}

/** The live board with the loaded done topics under it; anything the live board has wins. */
export function withDone(board: Board, d: Pick<DoneState, "decisions" | "asks" | "details"> = done): Board {
  if (!d.decisions.size && !d.asks.size && !Object.keys(d.details).length) return board;
  const ids = new Set(board.decisions.map((x) => x.id));
  const askIds = new Set((board.asks ?? []).map((a) => a.id));
  return {
    ...board,
    decisions: [...board.decisions, ...[...d.decisions.values()].filter((x) => !ids.has(x.id))],
    asks: [...(board.asks ?? []), ...[...d.asks.values()].filter((a) => !askIds.has(a.id))],
    details: { ...d.details, ...(board.details ?? {}) },
  };
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
        // Note what is on screen so the layout effect in useLiveBoard can hold it still once React commits.
        if (typeof document !== "undefined") beforeLiveUpdate(document);
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
  done = { decisions: new Map(), asks: new Map(), details: {}, loaded: new Set(), pages: {} };
}

function useFeed(): Feed | null {
  useEffect(startFeed, []);
  return useSyncExternalStore(subscribe, () => feed, () => feed);
}

// The board as the server has it now. Starts from `initial` until the first poll lands.
export function useLiveBoard(initial: Board): Board {
  const f = useFeed();
  useEffect(() => (typeof window === "undefined" ? undefined : installInteractionTracker(window)), []);
  // After a live update commits and before paint, put the item he was reading back where it was on screen.
  useLayoutEffect(() => {
    if (typeof document !== "undefined") afterLiveUpdate(document);
  });
  const rev = useSyncExternalStore(subscribeDone, () => doneRev, () => doneRev);
  const board = f?.board ?? initial;
  return useMemo(() => withDone(board), [board, rev]);
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
  if (typeof document !== "undefined") beforeLiveUpdate(document);
  feed = { board, project };
  for (const fn of listeners) fn();
}
