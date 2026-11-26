// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";
import { STORAGE_KEY } from "../src/delivery";
import { BOARD_PATH, POLL_MS, VERSION_PATH, resetLiveFeed } from "../src/useLiveBoard";

const d = (id: string, extra: object = {}) => ({
  id,
  card_ref: null,
  question: `Question ${id}?`,
  what_happens_after: "Something happens.",
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  created_at: "2026-11-10T09:00:00.000Z",
  ...extra,
});
const glance = {
  waiting: [
    { title: "Analytics dashboard (#101)", who: "Blake", link: "https://github.com/acme/example/pull/101" },
    { title: "chat alerts (#102)", who: "Two approvals", link: "https://github.com/acme/example/pull/102" },
  ],
  tickets: [],
};
const initial: Board = { updated_at: "2026-11-10T09:00:00.000Z", decisions: [d("one"), d("two")], glance };

vi.mock("../src/data/board", () => ({ board: initial }));

let served: Board;
let version = 0;
let fetchMock: ReturnType<typeof vi.fn>;
const boardFetches = () => fetchMock.mock.calls.filter(([url]) => url === BOARD_PATH).length;
// Serve a new board: the next version check sees a new hash, so the poller loads the board.
const serve = (b: Board) => {
  served = b;
  version++;
};
const hash = () => version.toString(16).padStart(64, "0");

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", "");
  resetLiveFeed();
  served = initial;
  version = 0;
  fetchMock = vi.fn(async (url: string) => {
    if (String(url).startsWith(VERSION_PATH)) return new Response(JSON.stringify({ version: hash() }), { status: 200 });
    if (url === BOARD_PATH) return new Response(JSON.stringify(served), { status: 200 });
    throw new Error("no network in tests");
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  resetLiveFeed();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const shownIds = () => [...document.querySelectorAll("[data-decision-id]")].map((e) => e.getAttribute("data-decision-id"));

async function renderApp() {
  const { default: App } = await import("../src/App");
  render(<App />);
  // Let the first poll settle (it loads the board because no version has been seen yet).
  await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
}
// Serve a board, then run one poll tick so the app picks it up.
const update = async (b: Board) => {
  serve(b);
  await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS)));
};

const ans = (by: "chat" | "app") => ({ answer: "yes", answer_label: "Yes", answered_by: by, answered_at: "2026-11-10T10:00:00.000Z" });
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("live board (useLiveBoard in App)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
  });

  it("starts from the bundled board and follows board updates without a reload", async () => {
    await renderApp();
    expect(shownIds()).toEqual(["one", "two"]);

    await update({ ...initial, decisions: [...initial.decisions, d("three")] });
    expect(shownIds()).toEqual(["one", "two", "three"]);

    await update({ ...initial, decisions: [d("one", { answer: ans("chat") }), d("two"), d("three")] });
    expect(shownIds()).toEqual(["two", "three"]);
  });

  it("does not load the board again while the hash is unchanged", async () => {
    await renderApp();
    const before = boardFetches();
    await advance(POLL_MS * 3);
    expect(boardFetches()).toBe(before);
  });

  it("keeps a typed, unsent answer in another card across an update", async () => {
    await renderApp();
    const input = () => within(document.querySelector<HTMLElement>('[data-decision-id="two"]')!).getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input(), { target: { value: "half a thought" } });
    await update({ ...initial, updated_at: "2026-11-10T09:30:00.000Z", decisions: [d("two"), d("four")] });
    expect(shownIds()).toEqual(["two", "four"]);
    expect(input().value).toBe("half a thought");
  });

  it("holds an update while a Message your assistant draft is open, keeps the draft, and applies it once the draft is gone", async () => {
    await renderApp();
    const rootOf = (id: string) => [...document.querySelectorAll<HTMLElement>("[data-item-id]")].find((e) => e.dataset.itemId === id)!;
    const pr101 = "https://github.com/acme/example/pull/101";
    const field = (id: string) => within(rootOf(id)).queryByRole("textbox", { name: /^Message to your assistant/ }) as HTMLTextAreaElement | null;
    fireEvent.click(within(rootOf(pr101)).getByRole("button", { name: /^Message your assistant about/ }));
    fireEvent.change(field(pr101)!, { target: { value: "about 101" } });

    await update({ ...initial, updated_at: "2026-11-10T09:30:00.000Z", decisions: [d("zero"), d("two"), d("one")] });
    expect(shownIds()).toEqual(["one", "two"]);
    expect(field(pr101)!.value).toBe("about 101");

    fireEvent.change(field(pr101)!, { target: { value: "" } });
    (document.activeElement as HTMLElement | null)?.blur();
    await advance(500);
    expect(shownIds()).toEqual(["zero", "two", "one"]);
  });

  it("ignores a board response that is not a board", async () => {
    await renderApp();
    served = { decisions: "nope" } as unknown as Board;
    version++;
    await advance(POLL_MS);
    expect(shownIds()).toEqual(["one", "two"]);
  });

  it("drops a local app answer once a live update shows the file answered it", async () => {
    await renderApp();
    await act(async () => fireEvent.click(within(document.querySelector<HTMLElement>('[data-decision-id="one"]')!).getByRole("button", { name: "Yes" })));
    expect(Object.keys(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!))).toEqual(["one"]);
    await update({ ...initial, decisions: [d("one", { answer: ans("app") }), d("two")] });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({});
    expect(shownIds()).toEqual(["two"]);
  });

  it("changes a card's added/updated stamp when a newer board arrives, without a reload", async () => {
    vi.setSystemTime(new Date("2026-11-10T20:00:00.000Z"));
    await renderApp();
    const stamp = () => document.querySelector('[data-decision-id="one"] .stamp')?.textContent;
    expect(stamp()).toBe("added 4:00 AM");
    await update({ ...initial, updated_at: "2026-11-10T19:40:00.000Z", decisions: [d("one", { updated_at: "2026-11-10T19:40:00.000Z" }), d("two")] });
    expect(stamp()).toBe("updated 2:40 PM");
  });

  it("refetches when the tab becomes visible again", async () => {
    await renderApp();
    serve({ ...initial, decisions: [d("visible")] });
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    await advance(0);
    expect(shownIds()).toEqual(["visible"]);
  });
});
