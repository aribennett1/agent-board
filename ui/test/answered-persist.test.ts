import { describe, expect, it } from "vitest";
import type { Board, Decision } from "../src/data/types";
import { buildTopics } from "../src/topics";
import { needsYou } from "../src/visibility";

// A browser with empty local storage (a refresh in another browser, or cleared storage) must still see an answered
// card as answered: the board stores the answer on the card, not the browser.
const card = (id: string, extra: Partial<Decision> = {}): Decision =>
  ({ id, title: id, context: "ctx", question: `Q ${id}?`, what_happens_after: "then", options: [{ id: "a", label: "A" }], created_at: "2026-11-26T09:00:00Z", ...extra }) as Decision;
const answer = { answer: "a", answer_label: "A", answered_by: "app" as const, answered_at: "2026-11-26T10:00:00Z" };
const board = (decisions: Decision[]) => ({ decisions, details: {}, asks: [], ticket_summaries: {} }) as unknown as Pick<Board, "decisions" | "details" | "asks" | "ticket_summaries">;

describe("answered cards stay answered without any local storage", () => {
  it("a card with a stored answer is not open, not in Needs you, and not a topic question", () => {
    const decisions = [card("answered", { answer }), card("open")];
    const open = needsYou(decisions, {}, {});
    expect(open.map((d) => d.id)).toEqual(["open"]);
    const topics = buildTopics(board(decisions), {}, (d) => open.some((x) => x.id === d.id));
    expect(topics.flatMap((t) => t.open.map((q) => q.uid))).toEqual(["decision:open"]);
  });

  it("a rewrite of the card after the answer keeps it answered (the board refuses the re-raise, and a stored answer wins)", () => {
    const decisions = [card("rewritten", { answer, updated_at: "2026-11-26T11:00:00Z", question: "A new wording?" })];
    expect(needsYou(decisions, {}, {})).toEqual([]);
  });
});
