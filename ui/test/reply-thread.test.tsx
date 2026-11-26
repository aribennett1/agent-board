// @vitest-environment jsdom
// The assistant answers the owner on the item itself (ab reply). A reply shows in the item's thread, moves the item to
// Needs you with an unread dot until opened, and any question in it takes a one-click answer or the owner's own words.
// Every option set on the board (decision cards, reply questions, plan questions, review comments) also has a
// free text box with a mic for dictation.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";
import { itemStatus } from "../src/itemStatus";

const HOOK = "/__ab/webhook"; // every send goes through the server route
const REPLY_AT = "2026-11-24T21:06:21.000Z";

vi.mock("../src/data/board", () => ({
  board: {
    updated_at: "2026-11-24T21:00:00.000Z",
    decisions: [
      {
        id: "closed",
        title: "Pick one",
        question: "Which one?",
        context: "Two ways to go.",
        what_happens_after: "I do the picked one.",
        card_ref: "https://github.com/example/app/pull/1",
        options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
        allowCustom: false,
        created_at: "2026-11-24T20:00:00.000Z",
      },
    ],
    glance: {
      waiting: [],
      tickets: [{ id: "PROJ-1", title: "Banks in seconds", status: "Todo" }],
      others: [
        { title: "Standard hours fix", author: "sam", who: "Your review requested", link: "https://github.com/example/app/pull/203" },
        { title: "Docs pass", author: "sam", who: "Waiting on author", link: "https://github.com/example/app/pull/7" },
      ],
    },
    reviews: [{ repo: "app", pr: 203, verdict: "Comment", comments: [{ id: "c1", severity: "low", title: "Nit", path: "a.php", line: 3, body: "Rename it.", status: "pending" }] }],
    details: {
      "pr:app/203": {
        thread: [
          {
            at: REPLY_AT,
            from: "bot",
            text: "Ready to approve: [#203](https://github.com/example/app/pull/203).",
            image: "/replies/x.png",
            question: { id: "q1", text: "What do you want to do?", options: [{ id: "o1", label: "Approve with LGTM now" }, { id: "o2", label: "Wait for Sam" }] },
          },
        ],
      },
      "ticket:PROJ-1": { plain: "Banks drift.", questions: [{ id: "Q1", question: "Round up?", recommendation: "Yes" }] },
    },
  } satisfies Board,
}));

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  start = vi.fn();
  stop = vi.fn();
  abort = vi.fn();
  onresult = null;
  onend = null;
  onerror = null;
}

let posted: Record<string, unknown>[];
beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  window.location.hash = "#reviews";
  posted = [];
  (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
  vi.stubEnv("ACTION_BOARD_WEBHOOK_CONFIGURED", "1");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === HOOK) {
        posted.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ status: 200 }), { status: 200 });
      }
      if (url === "/__ab/delivery-log") return new Response(null, { status: 204 });
      throw new Error("no network in tests");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  window.location.hash = "";
});

const rowOf = (title: string | RegExp) => screen.getByText(title).closest("li")!;

describe("reply thread", () => {
  it("puts an item with an open reply question in Needs you, with an unread dot that clears on open", async () => {
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
    const row = rowOf("Standard hours fix");
    expect(within(row).getByRole("img", { name: "New reply" })).toBeTruthy();
    expect(within(row).getByText("Question for you")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Expand" }));
    expect(within(row).queryByRole("img", { name: "New reply" })).toBeNull();
    const thread = row.querySelector<HTMLElement>(".item-thread")!;
    expect(within(thread).getByRole("link", { name: "#203" }).getAttribute("href")).toBe("https://github.com/example/app/pull/203");
    expect(thread.querySelector("img.thread-image")?.getAttribute("src")).toBe("/replies/x.png");

    // Others' PRs: the PR with no details sits in the collapsed In progress group.
    window.location.hash = "#others";
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.queryByText("Docs pass")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /In progress, not ready yet \(1\)/ }));
    expect(within(rowOf("Docs pass")).getByText("No details yet")).toBeTruthy();
  });

  it("sends a one-click answer and a free-form answer as item messages", async () => {
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
    const row = rowOf("Standard hours fix");
    fireEvent.click(within(row).getByRole("button", { name: "Expand" }));
    const thread = row.querySelector<HTMLElement>(".item-thread")!;
    const box = within(thread).getByLabelText("Or answer in your own words") as HTMLTextAreaElement;
    expect(within(box.closest(".mic-wrap") as HTMLElement).getByRole("button", { name: "Voice typing" })).toBeTruthy();
    fireEvent.change(box, { target: { value: "Approve, but ping Sam first" } });
    fireEvent.click(within(thread).getByRole("button", { name: "Send to assistant" }));
    await act(async () => {});
    const m = posted.filter((p) => p.event === "item.message").at(-1)!;
    expect(m.text).toBe('Answer to "What do you want to do?": Approve, but ping Sam first');
    expect(within(thread).getByText("Answered: Approve, but ping Sam first", { selector: ".review-flag" })).toBeTruthy();
    expect(within(thread).queryByRole("button", { name: "Approve with LGTM now" })).toBeNull();
  });
});

describe("free text with a mic on every option set", () => {
  it("decision cards (even allowCustom false), plan questions and review comments all take typed or spoken text", async () => {
    window.location.hash = "#home";
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
    const card = document.querySelector<HTMLElement>('[data-decision-id="closed"]')!;
    const custom = within(card).getByRole("textbox", { name: "Your own answer" });
    expect(within(card).getByRole("button", { name: "Voice typing" })).toBeTruthy();
    fireEvent.change(custom, { target: { value: "Neither, ask Sam" } });
    fireEvent.click(within(card).getByRole("button", { name: "Send to assistant" }));
    await act(async () => {});
    const d = posted.find((p) => p.event === "decision.answered")!;
    expect(d).toMatchObject({ answer: "custom", custom_text: "Neither, ask Sam" });

    window.location.hash = "#tickets";
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    const ticket = rowOf(/Banks in seconds/);
    fireEvent.click(within(ticket).getByRole("button", { name: "Expand" }));
    const q = ticket.querySelector<HTMLElement>(".question-row")!;
    expect(within(q).getByLabelText("Or type your own answer")).toBeTruthy();
    expect(within(q).getByRole("button", { name: "Voice typing" })).toBeTruthy();

    window.location.hash = "#reviews";
    await act(async () => {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    const pr = rowOf("Standard hours fix");
    fireEvent.click(within(pr).getByRole("button", { name: "Expand" }));
    const comment = pr.querySelector<HTMLElement>("[data-comment-id=c1]")!;
    expect(within(comment).getAllByRole("textbox").length).toBeGreaterThan(0);
    expect(within(comment).getAllByRole("button", { name: "Voice typing" }).length).toBeGreaterThan(0);
  });
});

describe("status", () => {
  it("never puts a row with no details in Needs you", () => {
    expect(itemStatus({ kind: "pr" })).toEqual({ needs: false, reason: "No details yet" });
    expect(itemStatus({ kind: "pr", detail: { thread: [{ at: REPLY_AT, from: "bot", text: "hi" }] }, seenAt: "2026-11-24T22:00:00.000Z" })).toEqual({ needs: false, reason: "In progress" });
  });

  it("an ack or FYI reply never puts an item in Needs you; only something to act on does", () => {
    const ack = { at: REPLY_AT, from: "bot" as const, text: "Got it. Holding on #203 until Sam answers the bot." };
    expect(itemStatus({ kind: "pr", detail: { thread: [ack] } })).toEqual({ needs: false, reason: "New reply (FYI)" });
    const q = { at: "2026-11-24T21:00:00.000Z", from: "bot" as const, text: "Ready.", question: { id: "q1", text: "Approve?", options: [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }] } };
    expect(itemStatus({ kind: "pr", detail: { thread: [q, ack] } })).toEqual({ needs: true, reason: "Question for you" });
    expect(itemStatus({ kind: "pr", detail: { thread: [q, ack] }, answered: new Set(["q1"]) }).needs).toBe(false);
    // A status never closes unanswered questions; once questions are answered, the status describes who has the ball.
    const parked = { at: "2026-11-24T21:20:00.000Z", from: "bot" as const, text: "", status: "waiting:Sam" };
    expect(itemStatus({ kind: "pr", detail: { thread: [q, ack, parked], approval: "ready" }, pendingDrafts: 3 })).toEqual({ needs: true, reason: "Question for you" });
    expect(itemStatus({ kind: "pr", detail: { thread: [q, ack, parked], approval: "ready" }, answered: new Set(["q1"]), pendingDrafts: 3 })).toEqual({ needs: false, reason: "Waiting on Sam" });
    expect(itemStatus({ kind: "mypr", detail: { thread: [{ ...parked, status: "passed:assistant" }] } }).reason).toBe("Passed to assistant");
  });

  it("does not call a review request Ready to approve just because checks are green", () => {
    const ready = { approval: "ready" as const };
    expect(itemStatus({ kind: "pr", reviewRequested: true, detail: ready })).toEqual({ needs: false, reason: "Review running" });
    expect(itemStatus({ kind: "pr", reviewRequested: true, detail: ready, pendingDrafts: 2 })).toEqual({ needs: true, reason: "2 draft comments to post" });
    expect(itemStatus({ kind: "pr", reviewRequested: true, detail: ready, pendingDrafts: 0 })).toEqual({ needs: true, reason: "Ready to approve" });
    expect(itemStatus({ kind: "pr", reviewRequested: true, pendingDrafts: 0 })).toEqual({ needs: false, reason: "Review done" });
    expect(itemStatus({ kind: "pr", reviewRequested: false, detail: ready })).toEqual({ needs: true, reason: "Ready to approve" });
    expect(itemStatus({ kind: "pr", reviewRequested: true, detail: { approval: "ready", review_plain: "The W-4 step is missing after hire." } })).toEqual({ needs: true, reason: "Ready to approve" });
    const parkedDraft = { at: REPLY_AT, from: "bot" as const, text: "Parked.", status: "waiting:review draft" };
    expect(itemStatus({ kind: "pr", reviewRequested: true, detail: { approval: "ready", thread: [parkedDraft] } })).toEqual({ needs: false, reason: "Waiting on review draft" });
  });
});

describe("ab reply", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-reply-"));
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

  it("appends replies with a timestamp, an image under public/replies and a question; resolves #N", () => {
    writeFileSync(
      file,
      `export const board = ${A}\n${JSON.stringify({
        updated_at: "2026-11-10T09:00:00.000Z",
        decisions: [],
        glance: { waiting: [], tickets: [], others: [{ title: "x", author: "a", who: "w", link: "https://github.com/example/app/pull/203" }], mine: [{ repo: "app", number: 209, title: "y", state: "open", link: "https://github.com/example/app/pull/209" }] },
      })}\n${Z};\n`,
    );
    const png = join(dir, "shot.png");
    writeFileSync(png, "png");
    expect(ab(["reply", "#203"]).status).toBe(2);
    expect(ab(["reply", "#4040", "hi"]).status).toBe(2);
    expect(ab(["reply", "#203", "hi", "--question", "Q?", "--option", "only one"]).status).toBe(2);
    expect(ab(["reply", "#203", "Ready: **yes**", "--question", "Do it?", "--option", "Yes", "--option", "No"]).status).toBe(2);
    expect(ab(["reply", "#203", "Ready: **yes**", "--question", "Do it?", "--context", "Sam fixed the save bug. We're asking if you want to approve it now.", "--option", "Yes", "--option", "No"]).status).toBe(0);
    const r = ab(["reply", "app#209", "PHPStan fails", "--image", png]);
    expect(r.status).toBe(0);
    const d = read().details!;
    expect(d["pr:app/203"].thread).toEqual([
      expect.objectContaining({ from: "bot", text: "Ready: **yes**", question: expect.objectContaining({ text: "Do it?", options: [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }] }) }),
    ]);
    const t = d["mypr:app/209"].thread![0];
    expect(Number.isNaN(Date.parse(t.at))).toBe(false);
    expect(t.image).toMatch(/^\/replies\/mypr-app-209-\d+\.png$/);
    expect(existsSync(join(dir, "app/public", t.image!))).toBe(true);
  });
});
