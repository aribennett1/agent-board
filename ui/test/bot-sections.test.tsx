// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation, SECTION_ORDER, scrollToTop } from "../src/Conversation";
import { buildTopics } from "../src/topics";
import type { Board, Decision } from "../src/data/types";

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const d = (id: string, extra: Partial<Decision> = {}): Decision => ({
  id,
  title: extra.title ?? id,
  card_ref: null,
  context: "The service needs a decision from you on this point today.",
  question: extra.question ?? `Decide ${id}?`,
  what_happens_after: "The assistant continues.",
  options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
  created_at: "2026-11-26T17:00:00.000Z",
  ...extra,
});
const board = (decisions: Decision[], details: Board["details"] = {}, asks: Board["asks"] = []) => ({ decisions, details, asks }) as Pick<Board, "decisions" | "details" | "asks" | "ticket_summaries">;
const noop = async () => true;
function show(b: ReturnType<typeof board>, handlers: Partial<{ onAnswerDecision: (...a: unknown[]) => void; onAnswerThread: (...a: unknown[]) => Promise<boolean> }> = {}) {
  const topics = buildTopics(b, {}, () => true);
  return render(<Conversation topics={topics} onOpen={() => {}} onAnswerThread={(handlers.onAnswerThread as never) ?? noop} onAnswerPlan={noop} onAnswerDecision={(handlers.onAnswerDecision as never) ?? (() => {})} />);
}
const section = (name: string) => document.querySelector<HTMLElement>(`[data-bot-section="${name}"]`);

const cards = [
  d("planner-a"), d("planner-b"), d("qa-a"), d("engineer-a"), d("eggbot-a"),
  d("mystery-a"), d("rows-1-intake", { group: "ROWS-1" }),
];
const details = { "ticket:ROWS-1": { ticket: "# T" } } as Board["details"];

describe("Conversation grouped by asking bot", () => {
  it("makes one section per bot with its open count, Unknown last, all expanded by default", () => {
    show(board(cards, details));
    const names = [...document.querySelectorAll<HTMLElement>("[data-bot-section]")].map((s) => s.dataset.botSection);
    expect(names).toEqual(["Planner", "QA", "Engineer", "dr eggbot", "Unknown"]);
    expect(SECTION_ORDER[SECTION_ORDER.length - 1]).toBe("Unknown");
    // planner-a, planner-b and the intake card the Planner filed a ticket on
    expect(within(section("Planner")!).getByText("3 open")).toBeTruthy();
    expect(within(section("QA")!).getByText("1 open")).toBeTruthy();
    expect(within(section("Unknown")!).getByText("1 open")).toBeTruthy();
    for (const s of document.querySelectorAll("[data-bot-section]")) expect(s.querySelector(".bot-section-head")?.getAttribute("aria-expanded")).toBe("true");
    expect(section("QA")!.querySelector('[data-topic="decision:qa-a"]')).not.toBeNull();
    expect(section("Planner")!.querySelector('[data-topic="decision:qa-a"]')).toBeNull();
  });

  it("collapses a section with its chevron header and remembers it after a reload", () => {
    show(board(cards, details));
    fireEvent.click(section("QA")!.querySelector(".bot-section-head")!);
    expect(section("QA")!.querySelector('[data-topic="decision:qa-a"]')).toBeNull();
    expect(section("QA")!.querySelector(".bot-section-head")?.getAttribute("aria-expanded")).toBe("false");
    expect(section("Planner")!.querySelector('[data-topic="decision:planner-a"]')).not.toBeNull();
    cleanup();
    show(board(cards, details));
    expect(section("QA")!.querySelector(".bot-section-head")?.getAttribute("aria-expanded")).toBe("false");
    expect(section("Planner")!.querySelector(".bot-section-head")?.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(section("QA")!.querySelector(".bot-section-head")!);
    expect(section("QA")!.querySelector('[data-topic="decision:qa-a"]')).not.toBeNull();
  });

  it("only shows sections that have cards, and puts everything in Unknown when no author is known", () => {
    show(board([d("zzz-1"), d("zzz-2")]));
    expect([...document.querySelectorAll<HTMLElement>("[data-bot-section]")].map((s) => s.dataset.botSection)).toEqual(["Unknown"]);
    expect(within(section("Unknown")!).getByText("2 open")).toBeTruthy();
  });
});

describe("scrolls to the top when he sends", () => {
  it("an option click, own words and the dismissed card all jump to the top", async () => {
    const spy = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const onAnswerDecision = vi.fn();
    show(board([d("planner-a"), d("planner-b")]), { onAnswerDecision });
    const first = document.querySelector<HTMLElement>('[data-topic="decision:planner-a"]')!;
    await act(async () => fireEvent.click(within(first).getByRole("button", { name: "Yes" })));
    expect(onAnswerDecision).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(0, 0);
    spy.mockClear();
    const second = document.querySelector<HTMLElement>('[data-topic="decision:planner-b"]')!;
    fireEvent.change(within(second).getByLabelText(/own words|Your answer/), { target: { value: "Do it differently" } });
    await act(async () => fireEvent.click(within(second).getByRole("button", { name: /^Send to Planner/ })));
    expect(spy).toHaveBeenCalledWith(0, 0);
  });

  it("scrollToTop also resets the main content pane", () => {
    const content = document.createElement("div");
    content.className = "content";
    content.scrollTo = vi.fn() as never;
    document.body.appendChild(content);
    scrollToTop();
    expect(content.scrollTo).toHaveBeenCalledWith(0, 0);
    content.remove();
  });
});

describe("Send to <bot> split button", () => {
  it("defaults to the raising bot, sends there, and a picked bot goes in the payload", async () => {
    const onAnswerDecision = vi.fn();
    show(board([d("planner-a"), d("zzz-1")]), { onAnswerDecision });
    const card = document.querySelector<HTMLElement>('[data-topic="decision:planner-a"]')!;
    expect(within(card).getByRole("button", { name: "Send to Planner" })).toBeTruthy();
    const picker = within(card).getByLabelText("Send to a different bot") as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(["Planner", "QA", "Engineer", "dr eggbot"]);
    fireEvent.change(picker, { target: { value: "QA" } });
    expect(within(card).getByRole("button", { name: "Send to QA" })).toBeTruthy();
    fireEvent.change(within(card).getByLabelText(/own words|Your answer/), { target: { value: "ask QA" } });
    await act(async () => fireEvent.click(within(card).getByRole("button", { name: "Send to QA" })));
    expect(onAnswerDecision).toHaveBeenCalledWith(expect.objectContaining({ id: "planner-a" }), { custom: "ask QA" }, "QA");
    // an option click uses the same recipient
    cleanup();
    const click = vi.fn();
    show(board([d("qa-b")]), { onAnswerDecision: click });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Yes" })));
    expect(click).toHaveBeenCalledWith(expect.objectContaining({ id: "qa-b" }), "yes", "QA");
  });

  it("a card with no known author says Send to Grok Bot and names no recipient", async () => {
    const onAnswerDecision = vi.fn();
    show(board([d("zzz-1")]), { onAnswerDecision });
    expect(screen.getByRole("button", { name: "Send to Grok Bot" })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Yes" })));
    expect(onAnswerDecision).toHaveBeenCalledWith(expect.anything(), "yes", undefined);
  });

  it("shows who an answer went to on the card thread", () => {
    const asks = [{ id: "planner-a:answer", at: "2026-11-26T17:30:00.000Z", item_key: "decision:planner-a", label: "planner-a", kind: "answer", text: "Yes", status: "sent", to_bot: "QA" }] as Board["asks"];
    show(board([d("planner-a", { answer: { answered_at: "2026-11-26T17:30:00.000Z", option: "yes" } as never })], {}, asks));
    fireEvent.click(screen.getByRole("button", { name: /In progress|Show done/ }));
    const line = [...document.querySelectorAll(".msg-to")].map((e) => e.textContent);
    expect(line.join(" ")).toContain("QA");
  });
});
