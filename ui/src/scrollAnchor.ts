// Keep what Eric is reading still when the board updates on its own (the same idea as the Zeidy D PDF swap).
// Before a live update lands, note the first fully visible item in each scroll box (the page, the notifications list,
// the sidebar) and how far it sits from the box's top. After React commits, before paint, scroll each box by however far
// that item moved. Items added or removed above it only change how far there is to scroll. Updates wait while he is
// scrolling, and right after his own click or keypress they land unanchored, so his actions can move things.

/** Things that can serve as an anchor. Leaf text (p, h*) lets a long card still anchor on the line he is reading. */
export const ITEM_SELECTOR = "li, article, section, p, h1, h2, h3, h4, pre, tr, .post-comment-draft, [data-anchor]";
/** Scroll boxes with their own scroll offset. Anything outside them belongs to the page (the window). */
export const BOX_SELECTOR = ".feed-list, .sidenav, .wq-list, .live-desc, [data-scroll-box]";
/** Attributes that name an item, so a re-created element can still be found after the update. */
const KEY_ATTRS = ["data-notice-id", "data-decision-id", "data-question-uid", "data-comment-id", "data-item-id", "data-pr", "data-ticket", "data-topic", "data-bot-section", "id"];

export const SCROLL_IDLE_MS = 350;
export const ACTION_WINDOW_MS = 1000;
/** Fallback anchors kept per box, in case the first ones leave the board. Every visible one, since a removed card can take dozens of leaves with it. */
const MAX_ITEMS = 500;

type Item = { el: Element; key: string | null; offset: number };
export type Snapshot = { box: Element | null; items: Item[] };

const boxTop = (box: Element | null) => (box ? box.getBoundingClientRect().top + box.clientTop : 0);
const boxBottom = (box: Element | null, win: Window) =>
  box ? box.getBoundingClientRect().top + box.clientTop + box.clientHeight : win.innerHeight;

function keyOf(el: Element): string | null {
  for (const a of KEY_ATTRS) {
    const v = el.getAttribute(a);
    if (v) return `[${a}="${CSS_escape(v)}"]`;
  }
  return null;
}

function CSS_escape(v: string) {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, "\\$&");
}

// A sticky or fixed element stays put while its box scrolls, so it can't tell us how far the content moved.
function pinned(el: Element, box: Element | null, win: Window, cache: Map<Element, boolean>): boolean {
  const chain: Element[] = [];
  let hit = false;
  for (let n: Element | null = el; n && n !== box; n = n.parentElement) {
    const known = cache.get(n);
    if (known !== undefined) {
      hit = known;
      break;
    }
    chain.push(n);
    const pos = win.getComputedStyle(n).position;
    if (pos === "sticky" || pos === "fixed") {
      hit = true;
      break;
    }
  }
  for (const n of chain) cache.set(n, hit);
  return hit;
}

/** Note the anchor candidates in every scroll box: fully visible items top-down (the deepest first on a tie), then partly visible ones. */
export function captureAnchors(doc: Document = document): Snapshot[] {
  const win = doc.defaultView;
  if (!win) return [];
  const boxes = new Map<Element | null, { full: (Item & { top: number; i: number })[]; part: (Item & { top: number; i: number })[] }>();
  const cache = new Map<Element, boolean>();
  const bounds = new Map<Element | null, [number, number]>();
  const all = doc.querySelectorAll(ITEM_SELECTOR);
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const box = el.parentElement?.closest(BOX_SELECTOR) ?? null;
    let b = bounds.get(box);
    if (!b) bounds.set(box, (b = [boxTop(box), boxBottom(box, win)]));
    const r = el.getBoundingClientRect();
    if (r.height <= 0 || r.bottom <= b[0] || r.top >= b[1]) continue;
    if (pinned(el, box, win, cache)) continue;
    let slot = boxes.get(box);
    if (!slot) boxes.set(box, (slot = { full: [], part: [] }));
    const item = { el, key: keyOf(el), offset: r.top - b[0], top: r.top, i };
    (r.top >= b[0] - 0.5 && r.bottom <= b[1] + 0.5 ? slot.full : slot.part).push(item);
  }
  const out: Snapshot[] = [];
  for (const [box, { full, part }] of boxes) {
    full.sort((a, z) => a.top - z.top || z.i - a.i);
    part.sort((a, z) => a.top - z.top || z.i - a.i);
    const items = [...full, ...part].slice(0, MAX_ITEMS).map(({ el, key, offset }) => ({ el, key, offset }));
    out.push({ box, items });
  }
  return out;
}

function scrollBoxBy(box: Element | null, delta: number, win: Window) {
  // behavior "instant" overrides a CSS scroll-behavior: smooth, which would animate the fix into view.
  if (box) {
    const top = box.scrollTop + delta;
    if (typeof (box as HTMLElement).scrollTo === "function") (box as HTMLElement).scrollTo({ top, behavior: "instant" as ScrollBehavior });
    else box.scrollTop = top;
  } else {
    win.scrollTo?.({ top: win.scrollY + delta, behavior: "instant" as ScrollBehavior });
  }
}

/** Scroll each box so its anchor sits where it was. Returns the shift applied per box (0 when nothing moved). */
export function restoreAnchors(snaps: Snapshot[], doc: Document = document): number[] {
  const win = doc.defaultView;
  if (!win) return [];
  const shifts: number[] = [];
  for (const { box, items } of snaps) {
    if (box && !box.isConnected) {
      shifts.push(0);
      continue;
    }
    let applied = 0;
    for (const item of items) {
      let el: Element | null = item.el.isConnected ? item.el : null;
      if (!el && item.key) el = (box ?? doc).querySelector(item.key);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.height <= 0 && r.width <= 0) continue;
      const delta = r.top - boxTop(box) - item.offset;
      if (Math.abs(delta) >= 0.5) {
        markProgrammaticScroll();
        scrollBoxBy(box, delta, win);
      }
      applied = delta;
      break;
    }
    shifts.push(applied);
  }
  return shifts;
}

// ---- Who moved it: Eric's own scrolling and actions ----

const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
let lastScroll = -Infinity;
let lastAction = -Infinity;
let touching = false;
let ignoreScrollUntil = -Infinity;
let installed: (() => void) | null = null;

function markProgrammaticScroll() {
  ignoreScrollUntil = clock() + 150;
}

const NAV_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const editable = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT");
};

/** Listen for scrolling, clicks and keys on the page. Idempotent; returns an uninstall. */
export function installInteractionTracker(win: Window = window): () => void {
  if (installed) return installed;
  const opts = { capture: true, passive: true } as const;
  const onScroll = () => {
    if (clock() >= ignoreScrollUntil) lastScroll = clock();
  };
  const onWheel = () => (lastScroll = clock());
  const onTouchStart = () => {
    touching = true;
    lastScroll = clock();
  };
  const onTouchEnd = () => {
    touching = false;
    lastScroll = clock();
  };
  const onAction = () => (lastAction = clock());
  const onKey = (e: KeyboardEvent) => {
    // Arrow, Page and Space keys outside a field scroll the page: that is reading, not an action.
    if (NAV_KEYS.has(e.key) && !editable(e.target)) lastScroll = clock();
    else lastAction = clock();
  };
  win.addEventListener("scroll", onScroll, opts);
  win.addEventListener("wheel", onWheel, opts);
  win.addEventListener("touchstart", onTouchStart, opts);
  win.addEventListener("touchend", onTouchEnd, opts);
  win.addEventListener("touchcancel", onTouchEnd, opts);
  win.addEventListener("click", onAction, opts);
  win.addEventListener("keydown", onKey, opts);
  installed = () => {
    win.removeEventListener("scroll", onScroll, opts);
    win.removeEventListener("wheel", onWheel, opts);
    win.removeEventListener("touchstart", onTouchStart, opts);
    win.removeEventListener("touchend", onTouchEnd, opts);
    win.removeEventListener("touchcancel", onTouchEnd, opts);
    win.removeEventListener("click", onAction, opts);
    win.removeEventListener("keydown", onKey, opts);
    installed = null;
  };
  return installed;
}

/** True while he is scrolling, and for a moment after, so an update never lands mid-scroll. */
export function scrollingNow(now = clock()): boolean {
  return touching || now - lastScroll < SCROLL_IDLE_MS;
}

/** True right after his own click or keypress: an update then may move things, as his action expects. */
export function recentAction(now = clock()): boolean {
  return now - lastAction < ACTION_WINDOW_MS;
}

/** Test hook: forget past interactions. */
export function resetInteractions() {
  lastScroll = -Infinity;
  lastAction = -Infinity;
  touching = false;
  ignoreScrollUntil = -Infinity;
}

// ---- One pending anchor set between a live update and its commit ----

let pending: { snaps: Snapshot[]; at: number } | null = null;

/** Call just before a live update is applied. Skips anchoring right after his own action. */
export function beforeLiveUpdate(doc: Document = document) {
  pending = recentAction() ? null : { snaps: captureAnchors(doc), at: clock() };
}

/** Call from a layout effect after the commit: puts every anchor back before paint. */
export function afterLiveUpdate(doc: Document = document): number[] | null {
  const p = pending;
  pending = null;
  // A stale capture (no commit followed it) must not drag the view back later.
  if (!p || clock() - p.at > ACTION_WINDOW_MS) return null;
  return restoreAnchors(p.snaps, doc);
}
