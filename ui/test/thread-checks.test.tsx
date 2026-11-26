// @vitest-environment jsdom
// Answered cards collapse into one line inside the thread, the human's messages carry sent / delivered / read checks,
// and the webhook flag is re-read on every live refresh.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "../src/Conversation";
import type { Ask, Board } from "../src/data/types";
import { POLL_MS, VERSION_PATH, BOARD_PATH, resetLiveFeed } from "../src/useLiveBoard";
import { buildTopics } from "../src/topics";

const card = { id: "pick-db", title: "Pick a database", context: "The service needs storage.", question: "Which database?", what_happens_after: "w", card_ref: null, options: [{ id: "pg", label: "Postgres" }], created_at: "2026-11-26T09:00:00.000Z", answer: { answer: "pg", answer_label: "Postgres", answered_by: "app", answered_at: "2026-11-26T09:05:00.000Z" } };
const ask = (id: string, status: Ask["status"], extra: Partial<Ask> = {}): Ask => ({ id, at: "2026-11-26T09:05:00.000Z", item_key: "ticket:PROJ-1", label: "PROJ-1", kind: "note", text: `note ${id}`, status, ...extra });

function view(asks: Ask[], thread: object[] = []) {
  const board = { decisions: [card], asks, details: { "ticket:PROJ-1": { thread } } } as unknown as Board;
  const topics = buildTopics(board, { "ticket:PROJ-1": { label: "PROJ-1 Storage" }, "decision:pick-db": { label: "Pick a database" } }, () => false);
  const noop = async () => true;
  render(<Conversation topics={topics} onOpen={() => {}} onAnswerThread={noop} onAnswerPlan={noop} onAnswerDecision={() => {}} />);
  // Topics with nothing open sit behind the In progress / Done toggles.
  for (const b of document.querySelectorAll(".group-toggle")) fireEvent.click(b);
  // Finished threads are folded; open every thread.
  for (const b of screen.queryAllByRole("button", { name: /Show history/ })) fireEvent.click(b);
}
afterEach(cleanup);

describe("checks on the human's messages", () => {
  it("one gray check is sent, two gray are delivered, two blue are read", () => {
    view([ask("a", "sent"), ask("b", "delivered"), ask("c", "read")]);
    const checks = screen.getAllByRole("img").filter((e) => e.classList.contains("checks"));
    expect(checks.map((c) => [c.getAttribute("aria-label"), c.textContent, c.className.includes("checks-read")])).toEqual([
      ["Sent", "✓", false],
      ["Delivered", "✓✓", false],
      ["Read by the assistant", "✓✓", true],
    ]);
  });

  it("assistant replies are bubbles without checks", () => {
    view([ask("a", "read")], [{ at: "2026-11-26T09:06:00.000Z", from: "bot", text: "Done, see **notes**." }]);
    const bubble = document.querySelector(".msg-bot")!;
    expect(bubble.querySelector("strong")?.textContent).toBe("notes");
    expect(bubble.querySelector(".checks")).toBeNull();
  });
});

describe("answered cards collapse", () => {
  it("shows title and answer on one line, opens to the question on click, and keeps the checks", () => {
    view([ask("pick-db:answer", "delivered", { item_key: "decision:pick-db", label: "Pick a database", kind: "answer", text: "Postgres" })]);
    const row = document.querySelector<HTMLElement>("[data-thread-card]")!;
    const line = within(row).getByRole("button");
    expect(line.textContent).toContain("Pick a database");
    expect(line.textContent).toContain("Postgres");
    expect(within(row).getByRole("img", { name: "Delivered" })).toBeTruthy();
    expect(row.textContent).not.toContain("The service needs storage.");
    fireEvent.click(line);
    expect(row.textContent).toContain("The service needs storage.");
    // The card is not repeated as a separate full message.
    expect(document.querySelectorAll("[data-thread-card]").length).toBe(1);
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("href")).toBe("#home");
  });
});

describe("webhook flag follows the live board", () => {
  const board = (webhook_configured: boolean): Board => ({ updated_at: "2026-11-26T09:00:00.000Z", decisions: [], glance: { waiting: [], tickets: [] }, webhook_configured });
  let served: Board;
  let version: number;
  beforeEach(() => {
    window.localStorage.clear();
    resetLiveFeed();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    version = 0;
    served = board(false);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).startsWith(VERSION_PATH)) return new Response(JSON.stringify({ version: version.toString(16).padStart(64, "0") }), { status: 200 });
      if (url === BOARD_PATH) return new Response(JSON.stringify(served), { status: 200 });
      if (url === "/__ab/webhook") return new Response(JSON.stringify({ status: 200 }), { status: 200 });
      throw new Error("no network in tests");
    }));
  });
  afterEach(() => {
    resetLiveFeed();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("drops 'Webhook not set up' and sends the pending message once a refresh says the webhook is on", async () => {
    vi.resetModules();
    window.localStorage.setItem("action-board:app-messages", "{}");
    const { MESSAGES_KEY } = await import("../src/delivery");
    window.localStorage.setItem(MESSAGES_KEY, JSON.stringify({ m1: { payload: { event: "item.message", message_id: "m1", item_id: "x", item_section: "tickets", item_title: "X", text: "hi", sent_at: "2026-11-26T09:00:00.000Z" }, status: "pending", attempts: 0, last_http: null, last_at: null } }));
    const { default: App } = await import("../src/App");
    render(<App />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(screen.getByRole("status").textContent).toBe("Webhook not set up (AGENT_BOARD_WEBHOOK_URL)");
    served = board(true);
    version++;
    await act(async () => void (await vi.advanceTimersByTimeAsync(POLL_MS)));
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect(screen.queryByText(/Webhook not set up/)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(MESSAGES_KEY)!).m1.status).toBe("delivered");
  });
});
