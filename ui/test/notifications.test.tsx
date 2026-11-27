// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, BoardNotification } from "../src/data/types";
import { Notifications, noticeTime, oldestFirst, CLEAR_PATH } from "../src/Notifications";
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
  cleared_at: extra.cleared_at ?? null,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Notifications feed", () => {
  it("lists oldest first, newest at the bottom, with the bot, ET time, text, next update, and an X on each bubble; nothing is grayed out", () => {
    const items = [
      note(2, { bot: "QA", text: "Approved **PR #12** at `abc`.", created_at: "2026-11-26T17:10:00.000Z" }),
      note(1, { bot: "Planner", text: "Starting now.", next_update: "1:15 PM ET", created_at: "2026-11-26T14:00:00.000Z" }),
    ];
    render(<Notifications items={items} now={now} />);
    const rows = [...document.querySelectorAll<HTMLElement>("[data-notice-id]")];
    expect(rows.map((r) => r.dataset.noticeId)).toEqual(["1", "2"]);
    [rows[0], rows[1]] = [rows[1], rows[0]];
    expect(within(rows[0]).getByText("QA", { selector: ".notice-bot" })).toBeTruthy();
    expect(rows[0].querySelector(".notice-avatar")?.className).toContain("bot-pill-qa");
    expect(within(rows[0]).getByText("12:10 PM ET")).toBeTruthy();
    expect(rows[0].querySelector(".notice-text")?.textContent).toContain("PR #12");
    expect(within(rows[1]).getByText("Next update by 1:15 PM ET")).toBeTruthy();
    expect(rows[0].querySelector(".notice-read")).toBeNull();
    expect(rows[0].classList.contains("notice-read")).toBe(false);
    const x = within(rows[0]).getByRole("button", { name: "Clear notification" });
    expect(x.textContent).toBe("×");
    const style = getComputedStyle(x);
    // The class places it in the top right of the note.
    expect(rows[0].className).toBe("notice");
    expect(x.className).toBe("notice-clear");
    expect(noticeTime("2026-11-25T17:00:00.000Z", now)).toBe("Nov 25, 12:00 PM ET");
    expect(screen.getByRole("button", { name: "Dismiss all" })).toBeTruthy();
    void style;
  });

  it("puts a 4:39 note below a 4:37 note even when the payload is newest first", () => {
    const engineer = note(32, { bot: "Engineer", text: "The 5 cleanups are ready.", created_at: "2026-11-26T21:37:44.887Z" });
    const grok = note(33, { bot: "Grok Bot", text: "PR #2076 needs work.", created_at: "2026-11-26T21:39:36.311Z" });
    expect(oldestFirst([grok, engineer]).map((n) => n.id)).toEqual([32, 33]);
    const { container } = render(<Notifications items={[grok, engineer]} now={now} />);
    const rows = [...container.querySelectorAll<HTMLElement>("[data-notice-id]")];
    expect(rows.map((r) => r.dataset.noticeId)).toEqual(["32", "33"]);
    expect(rows[1].querySelector(".notice-bot")!.textContent).toBe("Grok Bot");
    expect(rows[0].querySelector("time")!.textContent).toBe("4:37 PM ET");
    expect(rows[1].querySelector("time")!.textContent).toBe("4:39 PM ET");
    expect(container.querySelector(".feed-list")).not.toBeNull();
  });

  it("the X posts a clear for that note, hides it, and never hits the webhook", async () => {
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
      fireEvent.click(within(document.querySelector<HTMLElement>("[data-notice-id='1']")!).getByRole("button", { name: "Clear notification" }));
    });
    expect(posted).toEqual([{ url: CLEAR_PATH, body: JSON.stringify({ id: 1 }) }]);
    expect(document.querySelector("[data-notice-id='1']")).toBeNull();
    expect(document.querySelector("[data-notice-id='2']")).not.toBeNull();
    expect(screen.queryByText(/Webhook/)).toBeNull();
  });

  it("Dismiss all posts { all: true } and clears the feed", async () => {
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
      fireEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
    });
    expect(posted).toEqual([{ url: CLEAR_PATH, body: JSON.stringify({ all: true }) }]);
    expect(screen.getByText("No notifications yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss all" })).toBeNull();
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

  it("has no Notifications tab: the feed sits in the sidebar under the tab list, off Conversation and the red dot", async () => {
    vi.resetModules();
    vi.doMock("../src/data/board", () => ({ board: board() }));
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
    const nav = screen.getByRole("navigation", { name: "Views" });
    expect(nav.querySelector('[data-view="notifications"]')).toBeNull();
    const feed = nav.querySelector(".feed")!;
    expect(feed).not.toBeNull();
    // Right after the tab list, before the date footer.
    expect(nav.querySelector("ul")!.nextElementSibling).toBe(feed);
    expect(within(feed as HTMLElement).getByText(/Starting the plan now/)).toBeTruthy();
    expect(within(feed as HTMLElement).getByRole("button", { name: "Dismiss all" })).toBeTruthy();
    expect(screen.getAllByText(/Starting the plan now/)).toHaveLength(1);
    expect(document.title).toBe(badgeTitle.base);
    expect(document.querySelector("link[rel='icon']")?.getAttribute("href")).toBe(badgeTitle.baseIcon);
    // #notifications is not a tab any more.
    expect(window.location.hash).toBe("");
  });
});

describe("feed scrolling", () => {
  it("starts at the top, adds a new note at the bottom, and does not move the scroll", () => {
    const { rerender } = render(<Notifications items={[note(1), note(2)]} now={now} />);
    const list = document.querySelector<HTMLElement>(".feed-list")!;
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 500 });
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 200 });
    expect(list.scrollTop).toBe(0);
    list.scrollTop = 80;
    rerender(<Notifications items={[note(1), note(2), note(3)]} now={now} />);
    expect(list.scrollTop).toBe(80);
    expect([...document.querySelectorAll<HTMLElement>("[data-notice-id]")].map((r) => r.dataset.noticeId)).toEqual(["1", "2", "3"]);
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
    render(<App view="conversation" />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(screen.getByText("No notifications yet.")).toBeTruthy();
    served = { ...initial, notifications: [note(4, { text: "On it.", created_at: "2026-11-26T17:20:00.000Z" })] };
    version++;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS)));
    expect(screen.getByText("On it.")).toBeTruthy();
  });
});
