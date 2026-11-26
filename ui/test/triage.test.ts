import { describe, expect, it } from "vitest";
import type { Decision } from "../src/data/types";
import {
  cardStale,
  effectiveTier,
  groupByTicket,
  isActionable,
  nextFiveMinutes,
  sameSha,
  sortTriage,
  waitingLabel,
} from "../src/triage";

const at = (iso: string, extra: Partial<Decision> = {}): Decision => ({
  id: extra.id ?? "c",
  card_ref: null,
  question: extra.question ?? "Push the trimmed branch?",
  what_happens_after: "I pass your answer along.",
  options: extra.options ?? [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  created_at: iso,
  ...extra,
});

describe("effectiveTier", () => {
  it("treats a missing tier as a decision", () => {
    expect(effectiveTier({})).toBe("decision");
    expect(effectiveTier({ tier: "quick" })).toBe("quick");
  });
});

describe("sameSha and cardStale", () => {
  it("matches a short prefix to a full SHA", () => {
    expect(sameSha("fc39d5f", "fc39d5f2b83ae3c313b4c5146e3027e8a60b5020")).toBe(true);
    expect(sameSha("fc39d5f", "834f5f3c8215")).toBe(false);
  });

  it("marks a card superseded, or stale when its SHA is not the latest stamp or head", () => {
    const push = at("2026-11-25T19:00:00.000Z", {
      id: "pr206-push",
      title: "Push the trimmed 206",
      question: "Push the trimmed #206?",
      group: "pr:app/206",
      sha: "fc39d5f2b83ae3c313b4c5146e3027e8a60b5020",
      tier: "quick",
    });
    expect(cardStale({ ...push, superseded_by: "pr206-waiting-stamp" })).toEqual({
      stale: true,
      reason: "Superseded by pr206-waiting-stamp",
    });
    expect(cardStale(push, { stamps: { "pr:app/206": "aaa1111bbbb" } }).stale).toBe(true);
    expect(cardStale(push, { heads: { "pr:app/206": "834f5f3c8215" } }).stale).toBe(true);
    expect(cardStale(push, { stamps: { "pr:app/206": "fc39d5f2b83ae3c313b4c5146e3027e8a60b5020" } }).stale).toBe(false);
  });
});

describe("isActionable", () => {
  it("drops answered, superseded, stale, and locally answered cards", () => {
    const open = at("2026-11-25T19:00:00.000Z", { id: "a", tier: "quick" });
    expect(isActionable(open)).toBe(true);
    expect(isActionable({ ...open, answer: { answer: "yes", answer_label: "Yes", answered_by: "app", answered_at: open.created_at } })).toBe(false);
    expect(isActionable({ ...open, superseded_by: "b" })).toBe(false);
    expect(isActionable(open, {}, { a: true })).toBe(false);
  });
});

describe("waitingLabel", () => {
  const now = new Date("2026-11-25T20:20:00.000Z");
  it("uses minutes, hours, then days", () => {
    expect(waitingLabel("2026-11-25T20:19:30.000Z", now)).toBe("waiting just now");
    expect(waitingLabel("2026-11-25T20:00:00.000Z", now)).toBe("waiting 20 minutes");
    expect(waitingLabel("2026-11-25T19:20:00.000Z", now)).toBe("waiting 1 hour");
    expect(waitingLabel("2026-11-23T20:20:00.000Z", now)).toBe("waiting 2 days");
  });
});

describe("sortTriage, groupByTicket, nextFiveMinutes", () => {
  const cards: Decision[] = [
    at("2026-11-25T19:24:00.000Z", { id: "pr207-push", title: "Push 207", group: "pr:app/207", tier: "quick", unblocks: 3, sha: "89fcc9545" }),
    at("2026-11-25T19:24:10.000Z", { id: "pr207-thumbs", title: "Thumbs on 207", group: "pr:app/207", tier: "quick", unblocks: 1 }),
    at("2026-11-25T19:19:00.000Z", { id: "pr206-push", title: "Push 206", group: "pr:app/206", tier: "quick", unblocks: 2 }),
    at("2026-11-25T18:00:00.000Z", { id: "plan-a", title: "Plan question", group: "pr:app/205", tier: "decision", unblocks: 5 }),
    at("2026-11-25T17:00:00.000Z", { id: "land-2027", title: "Land 2027", group: "stack:2027-2036", tier: "blocking", unblocks: 8 }),
    at("2026-11-25T16:00:00.000Z", { id: "fyi-1917", title: "ops approved 1917", group: "pr:app/1917", tier: "fyi", unblocks: 0 }),
    at("2026-11-25T15:00:00.000Z", { id: "old-push", title: "Push old", group: "pr:app/2036", tier: "quick", unblocks: 4, sha: "be32466ea", superseded_by: "land-2027" }),
  ];

  it("sorts by tier, then how much work it unblocks, then age", () => {
    expect(sortTriage(cards).map((d) => d.id)).toEqual([
      "land-2027",
      "old-push",
      "pr207-push",
      "pr206-push",
      "pr207-thumbs",
      "plan-a",
      "fyi-1917",
    ]);
  });

  it("groups by ticket and keeps stale cards out of the actionable list", () => {
    const groups = groupByTicket(cards);
    expect(groups.map((g) => g.key)).toEqual([
      "stack:2027-2036",
      "pr:app/207",
      "pr:app/206",
      "pr:app/205",
      "pr:app/1917",
      "pr:app/2036",
    ]);
    const g2016 = groups.find((g) => g.key === "pr:app/207")!;
    expect(g2016.actionable.map((d) => d.id)).toEqual(["pr207-push", "pr207-thumbs"]);
    expect(groups.find((g) => g.key === "pr:app/2036")!.actionable).toEqual([]);
    expect(groups.find((g) => g.key === "pr:app/2036")!.stale.map((d) => d.id)).toEqual(["old-push"]);
  });

  it("picks the few quick taps that unblock the most work", () => {
    expect(nextFiveMinutes(cards).map((d) => d.id)).toEqual(["pr207-push", "pr206-push", "pr207-thumbs"]);
    expect(nextFiveMinutes(cards).every((d) => d.tier === "quick")).toBe(true);
    expect(nextFiveMinutes(cards).some((d) => d.id === "old-push")).toBe(false);
  });
});
