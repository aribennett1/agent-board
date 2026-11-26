// @vitest-environment jsdom
// The Conversation view (the landing tab, t102u): one card per topic with who has the ball, only the open questions
// (answerable inline), answered ones as one line, history folded. ab ask stores his side.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";
import { buildTopics, summaryLine } from "../src/topics";

const HOOK = "/__ab/webhook"; // every send goes through the server route
const now = Date.now();
const t = (minAgo: number) => new Date(now - minAgo * 60000).toISOString();

vi.mock("../src/data/board", () => {
  const now = Date.now();
  const t = (minAgo: number) => new Date(now - minAgo * 60000).toISOString();
  return {
    board: {
      updated_at: t(0),
      decisions: [
        { id: "plan", title: "Plan questions", question: "Ship the plan?", context: "Assistant wrote the time off plan and needs answers.", what_happens_after: "w", card_ref: null, options: [{ id: "y", label: "Ship it" }, { id: "n", label: "Hold" }], created_at: t(30) },
      ],
      glance: {
        waiting: [],
        tickets: [],
        others: [
          { title: "Standard hours fix", author: "alex", who: "Your review requested", link: "https://github.com/acme/example-repo/pull/1955" },
          { title: "Rounding", author: "sam", who: "Your review requested", link: "https://github.com/acme/example-repo/pull/7" },
        ],
      },
      asks: [
        { id: "m1", at: t(20), item_key: "pr:example-repo/1955", label: "example-repo #1955", kind: "note", text: "Is 1955 ready?" },
        { id: "m2", at: t(7), item_key: "decision:plan", label: "Plan", kind: "note", text: "Q1: one PR is the way to go" },
      ],
      details: {
        "pr:example-repo/1955": {
          thread: [
            { at: t(19), from: "bot", text: "Got it. Holding on #203 until Sam answers the bot." },
            { at: t(18), from: "bot", text: "", status: "waiting:Sam" },
          ],
        },
        "pr:example-repo/7": {
          thread: [{ at: t(10), from: "bot", text: "Checks pass.", question: { id: "q7", text: "Approve #7?", options: [{ id: "o1", label: "Approve" }, { id: "o2", label: "Wait" }] } }],
        },
        "decision:plan": {
          questions: [
            { id: "Q1", question: "One PR?", recommendation: "Yes" },
            { id: "Q2", question: "Ledger cap?", recommendation: "Later" },
            { id: "Q3", question: "Old question", answered: { text: "Use the constants", source: "your note" } },
          ],
          thread: [
            { at: t(9), from: "bot", text: "Ledger cap means a hard stop.", question: { id: "q2-old", text: "Q2: ledger cap now?", options: [{ id: "o1", label: "Now" }, { id: "o2", label: "Later" }] } },
            { at: t(8), from: "bot", text: "Re-explained: the hard stop.", question: { id: "q2-new", text: "Q2: overdraw guard?", options: [{ id: "o1", label: "Check only" }, { id: "o2", label: "Hard stop too" }] } },
          ],
        },
      },
    } satisfies Board,
  };
});

let posted: Record<string, unknown>[];
beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  posted = [];
  vi.stubEnv("ACTION_BOARD_WEBHOOK_CONFIGURED", "1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === HOOK) {
        posted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ status: 200 }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Conversation view", () => {
  it("one card per topic: summary line, ball, open questions only, each rendered once", async () => {
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
    // Open: #7 (1) + plan Q2 (new one) + the plan card itself = 3 across 2 topics. Q1 and Q3 are answered.
    expect(screen.getByRole("status").textContent).toBe("You have 3 things to answer across 2 topics.");
    const plan = document.querySelector<HTMLElement>('[data-topic="decision:plan"]')!;
    expect(within(plan).getByText("Your turn: 2 open: Q2")).toBeTruthy();
    // The superseded Q2 is gone; the newer Q2 shows once on the whole page.
    expect(document.querySelectorAll('[data-question-uid="decision:plan#q2-old"]').length).toBe(0);
    expect(document.querySelectorAll('[data-question-uid="decision:plan#q2-new"]').length).toBe(1);
    const uids = [...document.querySelectorAll("[data-question-uid]")].map((e) => e.getAttribute("data-question-uid"));
    expect(new Set(uids).size).toBe(uids.length);
    // Answered questions collapse to one line with his words.
    const answered = [...plan.querySelectorAll("[data-answered-uid]")].map((e) => e.textContent);
    expect(answered).toEqual(['✓ Q1: One PR? you said "one PR is the way to go"', '✓ Q3: Old question you said "Use the constants" (your note)']);
    // Context shows inline (no hidden toggle), and the #203 topic sits folded under In progress.
    expect(within(plan).getByText("Re-explained: the hard stop.")).toBeTruthy();
    expect(document.querySelector('[data-topic="pr:example-repo/1955"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "In progress (1)" }));
    const pr = document.querySelector<HTMLElement>('[data-topic="pr:example-repo/1955"]')!;
    expect(within(pr).getByText(/^Waiting on Alex\./)).toBeTruthy();
  });

  it("answers inline, then the question collapses and the count drops", async () => {
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
    const q7 = document.querySelector<HTMLElement>('[data-question-uid="pr:example-repo/7#q7"]')!;
    expect(within(q7).getByRole("img", { name: /Voice typing/ })).toBeTruthy();
    fireEvent.change(within(q7).getByLabelText("Or answer in your own words"), { target: { value: "Approve after lunch" } });
    fireEvent.click(within(q7).getByRole("button", { name: "Send to assistant" }));
    await act(async () => {});
    expect(posted.at(-1)).toMatchObject({ event: "item.message", text: 'Answer to "Approve #7?": Approve after lunch' });
    expect(document.querySelector('[data-question-uid="pr:example-repo/7#q7"]')).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("You have 2 things to answer across 1 topic.");

    const card = document.querySelector<HTMLElement>('[data-question-uid="decision:plan"]')!;
    fireEvent.click(within(card).getByRole("button", { name: "Ship it" }));
    await act(async () => {});
    expect(posted.at(-1)).toMatchObject({ event: "decision.answered", decision_id: "plan", answer: "y" });
  });

  it("ignores rapid double clicks on an inline option so an answer fires only one webhook", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url === HOOK) {
          await gate;
          posted.push(JSON.parse(String(init.body)));
          return new Response(JSON.stringify({ status: 200 }), { status: 200 });
        }
        return new Response(null, { status: 204 });
      }),
    );
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
    const q7 = document.querySelector<HTMLElement>('[data-question-uid="pr:example-repo/7#q7"]')!;
    const btn = within(q7).getByRole("button", { name: "Approve" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    release();
    await act(async () => {});
    expect(posted.filter((p) => p.event === "item.message").length).toBe(1);
  });
});

describe("buildTopics", () => {
  const q = (id: string, text: string) => ({ id, text, options: [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }] });
  it("merges a ticket's plan card into the ticket topic and never lists a question twice", () => {
    const ts = buildTopics(
      {
        decisions: [{ id: "proj-12-rebuilt-plan", title: "Plan: 2 questions", question: "Plan?", context: "Plan for twelve.", what_happens_after: "w", card_ref: null, options: [], created_at: t(40), answer: { answer: "each", answer_label: "I'll answer each one under Details", answered_by: "app", answered_at: t(30) } }],
        details: {
          "ticket:PROJ-12": { questions: [{ id: "Q1", question: "A?" }, { id: "Q2", question: "B?" }] },
          "decision:proj-12-rebuilt-plan": { questions: [{ id: "Q1", question: "A?" }, { id: "Q2", question: "B?" }] },
        },
        asks: [],
        ticket_summaries: { "PROJ-12": "Twelve, in plain words" },
      },
      { "ticket:PROJ-12": { label: "PROJ-12 Twelve" } },
      () => false,
    );
    expect(ts.map((x) => [x.key, x.summary, x.open.map((o) => o.label)])).toEqual([["ticket:PROJ-12", "Twelve, in plain words", ["Q1", "Q2"]]]);
    expect(summaryLine(ts)).toBe("You have 2 things to answer across 1 topic.");
  });

  it("a clarifying question is not an answer; a later 'Got your Qn' is; statuses set the ball", () => {
    const ts = buildTopics(
      {
        decisions: [],
        details: {
          "mypr:r/1": { thread: [{ at: t(10), from: "bot", text: "CI fails.", question: q("q1", "Fix it?") }, { at: t(8), from: "bot", text: "", status: "passed:Engineer" }] },
          "ticket:PROJ-9": { questions: [{ id: "Q1", question: "A?" }, { id: "Q2", question: "B?" }] },
        },
        asks: [
          { id: "a1", at: t(9), item_key: "mypr:r/1", label: "r #1", kind: "answer", text: "Yes", reply_to: "q1" },
          { id: "a2", at: t(6), item_key: "ticket:PROJ-9", label: "x", kind: "note", text: "PROJ-9 Q1: what do you mean?" },
          { id: "a3", at: t(5), item_key: "ticket:PROJ-9", label: "x", kind: "note", text: "PROJ-9 Q2: go for it" },
        ],
      },
      { "ticket:PROJ-9": { label: "PROJ-9 Nine" }, "mypr:r/1": { label: "r #1" } },
      () => false,
    );
    const nine = ts.find((x) => x.key === "ticket:PROJ-9")!;
    expect(nine.open.map((o) => o.label)).toEqual(["Q1"]);
    expect(nine.answered.map((o) => [o.label, o.answer])).toEqual([["Q2", "go for it"]]);
    const pr = ts.find((x) => x.key === "mypr:r/1")!;
    expect([pr.group, pr.ball]).toEqual(["progress", "assistant"]);
  });

  it("never closes unanswered questions when a later reply sets status (e.g. passed:assistant)", () => {
    const ts = buildTopics(
      {
        decisions: [],
        details: {
          "mypr:r/208": {
            thread: [
              { at: t(15), from: "bot", text: "Bug 1", question: q("q1", "Bug 1 fix?") },
              { at: t(14), from: "bot", text: "Bug 2", question: q("q2", "Bug 2 fix?") },
              { at: t(13), from: "bot", text: "Bug 3", question: q("q3", "Bug 3 fix?") },
              { at: t(10), from: "bot", text: "Passed Bug 1 to Assistant.", status: "passed:assistant" },
            ],
          },
        },
        asks: [{ id: "a1", at: t(12), item_key: "mypr:r/208", label: "r #208", kind: "answer", text: "Yes", reply_to: "q1" }],
      },
      { "mypr:r/208": { label: "r #208" } },
      () => false,
    );
    const pr = ts.find((x) => x.key === "mypr:r/208")!;
    expect(pr.group).toBe("you");
    expect(pr.ball).toBe("You");
    expect(pr.open.map((o) => o.thread?.id)).toEqual(["q3", "q2"]);
    expect(pr.answered.map((o) => o.text)).toEqual(["Bug 1 fix?"]);
  });
});

describe("ab ask / ab reply --status", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-ask-"));
  const file = join(dir, "app/src/data/board.ts");
  mkdirSync(join(dir, "app/src/data"), { recursive: true });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const A = "/* BOARD-JSON-START */";
  const Z = "/* BOARD-JSON-END */";
  const AB = join(process.cwd(), "..", "bin/ab.mjs");
  const ab = (args: string[]) => spawnSync("node", [AB, ...args], { encoding: "utf8", env: { ...process.env, AB_FILE: file, AB_NO_SERVER: "1" } });
  const read = (): Board => {
    const s = readFileSync(file, "utf8");
    return JSON.parse(s.slice(s.indexOf(A) + A.length, s.indexOf(Z)));
  };

  it("stores webhook payloads once, maps them to items and links answers to their question", () => {
    const q = { id: "q9", text: "Approve?", options: [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }] };
    writeFileSync(file, `export const board = ${A}\n${JSON.stringify({ updated_at: t(0), decisions: [{ id: "d1", title: "Pick", question: "Which?", options: [{ id: "a", label: "A" }], created_at: t(60) }], glance: { waiting: [], tickets: [], others: [] }, details: { "pr:example-repo/9": { thread: [{ at: t(5), from: "bot", text: "x", question: q }] } } })}\n${Z};\n`);
    const msg = { event: "item.message", message_id: "m-1", item_id: "https://github.com/acme/example-repo/pull/9", item_section: "others", item_title: "Nine", item_link: "https://github.com/acme/example-repo/pull/9", text: 'Answer to "Approve?": Yes', sent_at: t(1) };
    expect(ab(["ask", JSON.stringify(msg)]).status).toBe(0);
    expect(JSON.parse(ab(["ask", JSON.stringify(msg)]).stdout).duplicate).toBe(true);
    const ans = { event: "decision.answered", decision_id: "d1", card_ref: null, question: "Which?", answer: "custom", answer_label: "Neither", custom_text: "Neither", answered_by: "app", answered_at: t(0) };
    expect(ab(["ask", JSON.stringify(ans)]).status).toBe(0);
    expect(ab(["ask", '{"nope":1}']).status).toBe(2);
    expect(read().asks).toEqual([
      expect.objectContaining({ id: "m-1", item_key: "pr:example-repo/9", kind: "answer", text: "Yes", reply_to: "q9" }),
      expect.objectContaining({ id: "d1:answer", item_key: "decision:d1", kind: "custom", text: "Neither", label: "Pick" }),
    ]);
    expect(ab(["reply", "pr:example-repo/9", "--status", "waiting:Alex"]).status).toBe(0);
    expect(ab(["reply", "pr:example-repo/9", "--status", "sleeping"]).status).toBe(2);
    expect(read().details!["pr:example-repo/9"].thread!.at(-1)).toMatchObject({ text: "", status: "waiting:Alex" });
  });
});
