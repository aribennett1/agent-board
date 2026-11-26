// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, BoardNotification } from "../src/data/types";
import { Notifications, noticeTime, READ_PATH } from "../src/Notifications";
import { badgeTitle } from "../src/needsYouBadge";
import { POLL_MS, VERSION_PATH, BOARD_PATH, resetLiveFeed } from "../src/useLiveBoard";

const now = new Date("2026-11-26T17:13:00.000Z");
const note = (id: number, extra: Partial<BoardNotification> = {}): BoardNotification => ({
  id,
  bot: extra.bot ?? "Planner",
  text: extra.text ?? `Update ${id}`,
  next_update: extra.next_update ?? null,
  link: extra.link ?? null,
  created_at: extra.created_at ?? `2026-11-26T17:0${id}:00.000Z`,
  read_at: extra.read_at ?? null,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Notifications feed", () => {
  it("lists newest first with the bot, ET time, text, next update, and dims a read item", () => {
    const items = [
      note(2, { bot: "QA", text: "Approved **PR #12** at `abc`.", next_update: null, created_at: "2026-11-26T17:10:00.000Z" }),
      note(1, { bot: "Planner", text: "Starting now.", next_update: "1:15 PM ET", created_at: "2026-11-26T14:00:00.000Z", read_at: "2026-11-26T17:11:00.000Z" }),
    ];
    render(<Notifications items={items} now={now} />);
    const rows = [...document.querySelectorAll<HTMLElement>("[data-notice-id]")];
    expect(rows.map((r) => r.dataset.noticeId)).toEqual(["2", "1"]);
    expect(within(rows[0]).getByText("QA")).toBeTruthy();
    expect(within(rows[0]).getByText("12:10 PM ET")).toBeTruthy();
    expect(rows[0].querySelector(".notice-text")?.textContent).toContain("PR #12");
    expect(within(rows[1]).getByText("Next update by 1:15 PM ET")).toBeTruthy();
    expect(rows[0].dataset.read).toBe("false");
    expect(rows[1].dataset.read).toBe("true");
    expect(rows[1].classList.contains("notice-read")).toBe(true);
    expect(noticeTime("2026-11-25T17:00:00.000Z", now)).toBe("Nov 25, 12:00 PM ET");
  });

  it("Mark all read posts only to the read route and dims every item, with no webhook POST", async () => {
    const posted: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        posted.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    render(<Notifications items={[note(1), note(2)]} now={now} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    });
    expect(posted).toEqual([{ url: READ_PATH, body: JSON.stringify({ all: true }) }]);
    expect(document.querySelectorAll('[data-read="true"]').length).toBe(2);
    expect(screen.queryByRole("button", { name: "Mark all read" })).toBeNull();
  });

  it("marks a note read when it scrolls into view", async () => {
    const posted: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        posted.push({ url: String(url), body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    type Obs = { cb: IntersectionObserverCallback; els: Set<Element> };
    const observers: Obs[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        cb: IntersectionObserverCallback;
        els = new Set<Element>();
        constructor(cb: IntersectionObserverCallback) {
          this.cb = cb;
          observers.push(this);
        }
        observe(el: Element) {
          this.els.add(el);
        }
        unobserve(el: Element) {
          this.els.delete(el);
        }
        disconnect() {
          this.els.clear();
        }
        takeRecords() {
          return [];
        }
      },
    );
    vi.useFakeTimers();
    render(<Notifications items={[note(3, { text: "Visible now." })]} now={now} />);
    expect(observers.length).toBeGreaterThan(0);
    const obs = observers[0];
    const el = document.querySelector("[data-notice-id='3']")!;
    act(() => {
      obs.cb(
        [{ isIntersecting: true, target: el, intersectionRatio: 1, time: 0, boundingClientRect: {} as DOMRectReadOnly, intersectionRect: {} as DOMRectReadOnly, rootBounds: null }] as IntersectionObserverEntry[],
        obs as unknown as IntersectionObserver,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
    expect(posted).toEqual([{ url: READ_PATH, body: JSON.stringify({ ids: [3] }) }]);
    expect(el.getAttribute("data-read")).toBe("true");
  });
});

describe("Notifications stay off Conversation and the red dot", () => {
  const board = (extra: Partial<Board> = {}): Board => ({
    updated_at: "2026-11-26T17:00:00.000Z",
    decisions: [],
    glance: { waiting: [], tickets: [] },
    notifications: [note(1, { text: "Starting the plan now, next update by 1:15 PM ET", next_update: "1:15 PM ET" })],
    ...extra,
  });

  beforeEach(() => {
    window.localStorage.clear();
    resetLiveFeed();
    document.title = badgeTitle.base;
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.href = badgeTitle.baseIcon;
    document.head.appendChild(icon);
  });
  afterEach(() => {
    resetLiveFeed();
    document.head.querySelector("link[rel='icon']")?.remove();
  });

  it("shows an unread badge on the tab, hides the note from Conversation, and leaves the red dot off", async () => {
    vi.resetModules();
    vi.doMock("../src/data/board", () => ({ board: board() }));
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
    const nav = screen.getByRole("navigation", { name: "Views" });
    const item = (view: string) => nav.querySelector<HTMLButtonElement>(`[data-view="${view}"]`)!;
    expect(item("notifications").querySelector(".nav-count")?.textContent).toBe("1");
    expect(item("notifications").querySelector(".nav-count")?.classList.contains("urgent")).toBe(false);
    expect(screen.queryByText(/Starting the plan now/)).toBeNull();
    expect(document.title).toBe(badgeTitle.base);
    expect(document.querySelector("link[rel='icon']")?.getAttribute("href")).toBe(badgeTitle.baseIcon);
    fireEvent.click(item("notifications"));
    expect(window.location.hash).toBe("#notifications");
    expect(screen.getByRole("heading", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByText(/Starting the plan now/)).toBeTruthy();
    expect(screen.getByText("Next update by 1:15 PM ET")).toBeTruthy();
  });
});

describe("a live refresh picks up a new notification", () => {
  it("adds a note on the next poll without a reload", async () => {
    const initial: Board = { updated_at: "2026-11-26T17:00:00.000Z", decisions: [], glance: { waiting: [], tickets: [] }, notifications: [] };
    let served = initial;
    let version = 0;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    resetLiveFeed();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).startsWith(VERSION_PATH)) return new Response(JSON.stringify({ version: version.toString(16).padStart(64, "0") }), { status: 200 });
        if (url === BOARD_PATH) return new Response(JSON.stringify(served), { status: 200 });
        throw new Error("no network in tests");
      }),
    );
    vi.resetModules();
    vi.doMock("../src/data/board", () => ({ board: initial }));
    const { default: App } = await import("../src/App");
    render(<App view="notifications" />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(screen.getByText("No notifications yet.")).toBeTruthy();
    served = { ...initial, notifications: [note(4, { text: "On it.", created_at: "2026-11-26T17:20:00.000Z" })] };
    version++;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS)));
    expect(screen.getByText("On it.")).toBeTruthy();
  });
});
