import { describe, expect, it } from "vitest";
import type { Ask, Board, Decision } from "../src/data/types";
import { allFindingsAnswered, answersFromAsks, isFindingSettled, reviewFindings } from "../src/reviewFindings";
import { buildTopics } from "../src/topics";

const comment = { n: 1, label: "#1 naming", path: "tests/A.php", line: 10, severity: "low", body: "Rename it." };
const card = (c: object = comment): Decision =>
  ({ id: "qa-review", title: "Review", context: "ctx", question: "Which comments?", what_happens_after: "then", options: [], group: "pr:rows-backend/1986", created_at: "2026-11-26T09:00:00Z", post_comments: [c] }) as unknown as Decision;
const noteAsk: Ask = { id: "qa-review:1:note:2026-11-26T10:00:00.000Z", at: "2026-11-26T10:00:00.000Z", item_key: "decision:qa-review", label: "Review", kind: "review", text: "Finding #1 (tests/A.php:10): say it softer", ref: "qa-review:1" };
const board = (d: Decision, asks: Ask[]) => ({ decisions: [d], details: {}, asks, ticket_summaries: {} }) as unknown as Pick<Board, "decisions" | "details" | "asks" | "ticket_summaries">;
const topicOf = (d: Decision, asks: Ask[]) => buildTopics(board(d, asks), {}, () => true)[0];

describe("a note parks a review finding with the bot until the bot rewrites it", () => {
  it("without a stored pending state a note alone leaves the finding answerable (the board stores the state)", () => {
    expect(topicOf(card(), [noteAsk]).open.map((q) => q.uid)).toEqual(["decision:qa-review#f1"]);
  });

  it("with pending_bot the finding is settled, off his turn, shown as what he said, and the card drops off", () => {
    const d = card({ ...comment, pending_bot: { at: noteAsk.at, note: "say it softer" } });
    expect(isFindingSettled(reviewFindings(d)[0], answersFromAsks([noteAsk], d.id).get("1"))).toBe(true);
    expect(allFindingsAnswered(d, [noteAsk])).toBe(true);
    const t = topicOf(d, [noteAsk]);
    expect(t.open).toEqual([]);
    expect(t.answered.map((a) => a.answer)).toEqual(["say it softer"]);
  });

  it("still settled when the ask itself is gone, using the stored note", () => {
    const t = topicOf(card({ ...comment, pending_bot: { at: noteAsk.at, note: "say it softer" } }), []);
    expect(t.open).toEqual([]);
    expect(t.answered.map((a) => a.answer)).toEqual(["say it softer"]);
  });

  it("after the bot rewrites it (pending_bot cleared, revision_at after the note) it is his turn again with the new text", () => {
    const d = card({ ...comment, body: "Maybe rename it.", revision_at: "2026-11-26T10:05:00.000Z" });
    const t = topicOf(d, [noteAsk]);
    expect(t.open.map((q) => q.uid)).toEqual(["decision:qa-review#f1"]);
    expect(t.open[0].finding?.body).toBe("Maybe rename it.");
    expect(t.open[0].prior_answer).toBeUndefined();
  });
});
