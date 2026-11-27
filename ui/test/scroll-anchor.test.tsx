// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTION_WINDOW_MS,
  SCROLL_IDLE_MS,
  afterLiveUpdate,
  beforeLiveUpdate,
  captureAnchors,
  installInteractionTracker,
  recentAction,
  resetInteractions,
  restoreAnchors,
  scrollingNow,
} from "../src/scrollAnchor";
import { createPoller } from "../src/useLiveRefresh";
import { pushBoard, resetLiveFeed, useLiveBoard } from "../src/useLiveBoard";
import type { Board } from "../src/data/types";

// jsdom has no layout, so fake one: <li data-h> rows stack top-down in their list. The page list starts at y=0 and
// moves with window.scrollY (viewport 768px); the .feed-list box sits at y=100, 300px tall, and moves with its scrollTop.
const FEED_TOP = 100;
const FEED_H = 300;
let scrollY = 0;

function rowTop(li: Element): number {
  let y = 0;
  for (let n = li.previousElementSibling; n; n = n.previousElementSibling) y += Number(n.getAttribute("data-h") ?? 0);
  const feed = li.closest(".feed-list") as HTMLElement | null;
  return feed ? FEED_TOP - feed.scrollTop + y : y - scrollY;
}
function fakeRect(this: Element): DOMRect {
  let top = 0;
  let h = 0;
  if (this.tagName === "LI") {
    top = rowTop(this);
    h = Number(this.getAttribute("data-h") ?? 0);
  } else if (this.classList.contains("feed-list")) {
    top = FEED_TOP;
    h = FEED_H;
  }
  return { top, bottom: top + h, height: h, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

const rows = (ids: string[], h = 100) => ids.map((id) => `<li data-anchor-id="${id}" data-h="${h}">${id}</li>`).join("");
const byId = (id: string) => document.querySelector(`[data-anchor-id="${id}"]`)!;
const ids = (from: number, to: number, p = "r") => Array.from({ length: to - from }, (_, i) => `${p}${from + i}`);

beforeEach(() => {
  scrollY = 0;
  resetInteractions();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(fakeRect);
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
  window.scrollTo = ((o: ScrollToOptions | number, y?: number) => {
    scrollY = typeof o === "number" ? (y ?? 0) : (o.top ?? scrollY);
  }) as typeof window.scrollTo;
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("feed-list") ? FEED_H : 0;
    },
  });
  HTMLElement.prototype.scrollTo = function (this: HTMLElement, o: ScrollToOptions | number) {
    this.scrollTop = typeof o === "number" ? o : (o.top ?? this.scrollTop);
  } as typeof HTMLElement.prototype.scrollTo;
});
afterEach(() => {
  cleanup();
  resetLiveFeed();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("scroll anchor", () => {
  it("keeps the first fully visible row still when rows are added above it", () => {
    document.body.innerHTML = `<ol id="page">${rows(ids(0, 30))}</ol>`;
    window.scrollTo(0, 1050); // r10 is cut off at the top; r11 at y=50 is the first fully visible row
    const snaps = captureAnchors();
    expect(snaps[0].items[0].el).toBe(byId("r11"));
    const before = byId("r11").getBoundingClientRect().top;

    document.getElementById("page")!.insertAdjacentHTML("afterbegin", rows(["n1", "n2", "n3"], 80));
    restoreAnchors(snaps);

    expect(byId("r11").getBoundingClientRect().top).toBe(before);
    expect(window.scrollY).toBe(1050 + 240); // more room to scroll up; the view itself did not change
  });

  it("does not move when rows above are removed or grow", () => {
    document.body.innerHTML = `<ol id="page">${rows(ids(0, 30))}</ol>`;
    window.scrollTo(0, 1000);
    const snaps = captureAnchors();
    byId("r2").remove();
    byId("r3").setAttribute("data-h", "160");
    restoreAnchors(snaps);
    expect(byId("r10").getBoundingClientRect().top).toBe(0);
    expect(window.scrollY).toBe(1000 - 100 + 60);
  });

  it("falls back to the next visible row when the anchor itself leaves", () => {
    document.body.innerHTML = `<ol id="page">${rows(ids(0, 30))}</ol>`;
    window.scrollTo(0, 1000);
    const snaps = captureAnchors();
    const r11 = byId("r11").getBoundingClientRect().top;
    byId("r10").remove(); // the anchor itself
    document.getElementById("page")!.insertAdjacentHTML("afterbegin", rows(["n1"], 50));
    restoreAnchors(snaps);
    expect(byId("r11").getBoundingClientRect().top).toBe(r11);
  });

  it("anchors the notifications list on its own, new notices arriving at the top", () => {
    document.body.innerHTML = `<ol id="page">${rows(ids(0, 5))}</ol><ol class="feed-list">${rows(ids(0, 10, "n"), 60)}</ol>`;
    const feed = document.querySelector(".feed-list") as HTMLElement;
    feed.scrollTop = 0; // reading the top of the list
    const snaps = captureAnchors();
    const box = snaps.find((s) => s.box === feed)!;
    expect(box.items[0].el).toBe(byId("n0"));

    feed.insertAdjacentHTML("afterbegin", rows(["new1", "new2"], 60));
    restoreAnchors(snaps);
    expect(byId("n0").getBoundingClientRect().top).toBe(FEED_TOP);
    expect(feed.scrollTop).toBe(120);
    expect(window.scrollY).toBe(0); // the page box did not move
  });

  it("skips anchoring for a second after his own click, and holds updates while he scrolls", () => {
    const off = installInteractionTracker(window);
    try {
      document.body.innerHTML = `<ol id="page">${rows(ids(0, 30))}</ol>`;
      window.scrollTo(0, 1000);
      document.body.click();
      expect(recentAction()).toBe(true);
      expect(recentAction(performance.now() + ACTION_WINDOW_MS + 1)).toBe(false);
      beforeLiveUpdate();
      document.getElementById("page")!.insertAdjacentHTML("afterbegin", rows(["n1"]));
      expect(afterLiveUpdate()).toBeNull();
      expect(window.scrollY).toBe(1000);

      expect(scrollingNow()).toBe(false);
      window.dispatchEvent(new Event("wheel"));
      expect(scrollingNow()).toBe(true);
      expect(scrollingNow(performance.now() + SCROLL_IDLE_MS + 1)).toBe(false);
      // Arrow keys are reading, not an action.
      resetInteractions();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
      expect(recentAction()).toBe(false);
      expect(scrollingNow()).toBe(true);
    } finally {
      off();
    }
  });

  it("the poller waits for scrolling to stop before applying an update", async () => {
    const off = installInteractionTracker(window);
    try {
      const fetchImpl = (async () => new Response(JSON.stringify({ version: "c".repeat(64) }), { status: 200 })) as unknown as typeof fetch;
      const apply = vi.fn();
      const poller = createPoller<string>({ fetchImpl, load: async () => "x", apply, wait: (ms) => new Promise((r) => setTimeout(r, ms)) });
      window.dispatchEvent(new Event("wheel"));
      const started = performance.now();
      await poller.checkVersion();
      expect(apply).toHaveBeenCalledTimes(1);
      expect(performance.now() - started).toBeGreaterThanOrEqual(SCROLL_IDLE_MS - 20);
      poller.destroy();
    } finally {
      off();
    }
  });

  it("a live board update keeps the row he is reading still, end to end", () => {
    const board = (names: string[]) => ({ updated_at: "x", decisions: [], glance: { waiting: [], tickets: [] }, notifications: names }) as unknown as Board;
    function List() {
      const b = useLiveBoard(board(ids(0, 30))) as unknown as { notifications: string[] };
      return (
        <ol id="page">
          {b.notifications.map((n) => (
            <li key={n} data-anchor-id={n} data-h="100">
              {n}
            </li>
          ))}
        </ol>
      );
    }
    vi.stubGlobal("fetch", () => new Promise(() => undefined)); // the feed's own poll never lands; pushBoard drives it
    render(<List />);
    window.scrollTo(0, 1500);
    const before = byId("r15").getBoundingClientRect().top;
    act(() => pushBoard(board(["a", "b", ...ids(0, 30)])));
    expect(document.querySelectorAll("li")).toHaveLength(32);
    expect(byId("r15").getBoundingClientRect().top).toBe(before);
    act(() => pushBoard(board(ids(5, 30))));
    expect(byId("r15").getBoundingClientRect().top).toBe(before);
  });
});

describe("scroll anchor fallbacks", () => {
  beforeEach(() => {
    scrollY = 0;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(fakeRect);
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
  });
  it("still holds when a whole run of visible rows above the reader is removed", () => {
    // 20 short rows fill the top of the screen, then the row he reads; the short rows all go away.
    document.body.innerHTML = `<ol id="page">${rows(ids(0, 10))}${rows(ids(0, 20, "x"), 20)}${rows(ids(10, 30))}</ol>`;
    window.scrollTo(0, 1000);
    const snaps = captureAnchors();
    const before = byId("r10").getBoundingClientRect().top;
    for (const id of ids(0, 20, "x")) byId(id).remove();
    restoreAnchors(snaps);
    expect(byId("r10").getBoundingClientRect().top).toBe(before);
  });
});
