// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "../src/Conversation";
import { DecisionCard } from "../src/DecisionCard";
import type { Ask, Board, Decision } from "../src/data/types";
import {
  allFindingsAnswered,
  answersFromAsks,
  isFindingSettled,
  buildFindingPayload,
  isPerFindingReview,
  reviewFindings,
} from "../src/reviewFindings";
import { buildTopics } from "../src/topics";
import { FindingDraft, type OnAnswerFinding } from "../src/ReviewFindingsBlock";

type FindingFn = (...a: Parameters<OnAnswerFinding>) => Promise<boolean>;

const AB_MJS = path.resolve(__dirname, "../../bin/ab.mjs");
const BOARD_SRC = path.resolve(__dirname, "../src/data/board.ts");

afterEach(() => cleanup());

function makeTempBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-review-findings-"));
  const dataDir = path.join(dir, "app", "src", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const boardFile = path.join(dataDir, "board.ts");
  fs.copyFileSync(BOARD_SRC, boardFile);
  return { dir, boardFile };
}

function runAb(boardFile: string, args: string[]) {
  try {
    const out = execFileSync(process.execPath, [AB_MJS, ...args], {
      env: { ...process.env, AB_FILE: boardFile, AB_NO_SERVER: "1" },
      encoding: "utf8",
    });
    return { code: 0, out, err: "" };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: err.stdout ?? "", err: err.stderr ?? "" };
  }
}

const finding = (n: number, extra: Partial<Decision["post_comments"] extends (infer T)[] | undefined ? T : never> = {}) => ({
  n,
  label: `#${n} (High) Foo.php:${100 + n}`,
  severity: "High",
  path: "app/Services/Foo.php",
  line: 100 + n,
  url: `https://github.com/acme/example-repo/pull/1935/files`,
  summary: `Summary for finding ${n}`,
  body: `Exact comment text for #${n}.`,
  ...extra,
});

function reviewCard(over: Partial<Decision> = {}): Decision {
  return {
    id: "pr1935-test",
    card_ref: "https://github.com/acme/example-repo/pull/1935",
    title: "QA review of #1935",
    context: "QA reviewed PR #1935 and found two issues on the export.",
    question: "Should QA post each of these comments?",
    what_happens_after: "Each answer goes to QA with the PR, finding number, and file:line.",
    options: [],
    post_comments: [finding(1), finding(2)],
    group: "pr:example-repo/1935",
    glance: {
      ticket: { id: "PROJ-4936", summary: "Rebuilds the single-employee timecard export" },
      pr: { number: 1935, link: "https://github.com/acme/example-repo/pull/1935" },
      asking: "For each comment, Post, Don't post, or write your own words.",
      outcomes: [
        { id: "post", happens: "ops posts that comment as written." },
        { id: "skip", happens: "ops does not post that comment." },
      ],
    },
    created_at: "2026-11-25T16:00:00.000Z",
    ...over,
  };
}

describe("per-finding review helpers", () => {
  it("reads findings and builds a webhook payload with PR, finding, file:line, and answer", () => {
    const d = reviewCard();
    expect(isPerFindingReview(d)).toBe(true);
    expect(reviewFindings(d).map((f) => f.n)).toEqual([1, 2]);
    const payload = buildFindingPayload(d, 1, "note", "Please get me a link for the figma", new Date("2026-11-25T21:13:00.000Z"));
    expect(payload).toMatchObject({
      event: "review.answer",
      decision_id: "pr1935-test:1",
      card_id: "pr1935-test",
      repo: "acme/example-repo",
      pr: 1935,
      pr_link: "https://github.com/acme/example-repo/pull/1935",
      comment_id: "1",
      finding: 1,
      action: "note",
      text: "Please get me a link for the figma",
      path: "app/Services/Foo.php",
      line: 101,
    });
    const skipAll = buildFindingPayload(d, "all", "skip", undefined, new Date("2026-11-25T21:13:00.000Z"));
    expect(skipAll).toMatchObject({ event: "review.answer", card_id: "pr201-test", comment_id: "all", action: "skip", pr: 201 });
  });

  it("treats each finding as answered from asks, including Don't post any", () => {
    const d = reviewCard();
    const asks: Ask[] = [
      {
        id: "a1",
        at: "2026-11-25T21:14:00.000Z",
        item_key: "decision:pr201-test",
        label: "ops review of #201",
        kind: "review",
        text: "Finding #1 (app/Services/Foo.php:101): Post",
        ref: "pr201-test:1",
      },
    ];
    expect(answersFromAsks(asks, d.id).get("1")).toBe("Post");
    expect(allFindingsAnswered(d, asks)).toBe(false);
    const all: Ask[] = [
      { ...asks[0], id: "a2", text: "Don't post any", ref: "pr201-test:all" },
    ];
    expect(allFindingsAnswered(d, all)).toBe(true);
  });

  it("treats Post and Don't post as done, but a free-text note still waits for a tap", () => {
    const d = reviewCard();
    const note: Ask[] = [
      {
        id: "a1",
        at: "2026-11-25T21:14:00.000Z",
        item_key: "decision:pr201-test",
        label: "ops review of #201",
        kind: "review",
        text: "Finding #1 (app/Services/Foo.php:101): How many times is that used",
        ref: "pr201-test:1",
      },
    ];
    expect(isFindingSettled(d.post_comments![0] as never, "How many times is that used")).toBe(false);
    expect(allFindingsAnswered(d, note)).toBe(false);
    const postedAsk: Ask[] = [
      { ...note[0], text: "Finding #1 (app/Services/Foo.php:101): Post" },
      { ...note[0], id: "a2", text: "Finding #2 (app/Services/Foo.php:102): Post", ref: "pr201-test:2" },
    ];
    expect(allFindingsAnswered(d, postedAsk)).toBe(true);
    expect(isFindingSettled({ status: "pending" }, "Post")).toBe(true);
    expect(isFindingSettled({ status: "skipped" }, "Don't post")).toBe(true);
    expect(isFindingSettled({}, undefined)).toBe(false);
  });

  it("does not reopen a finding after a Don't post or Post tap, even if the text is later revised", () => {
    const d = reviewCard({
      post_comments: [
        finding(1, { status: "skipped", revision_at: "2026-11-25T22:30:31.714Z", answer_to_question: "A later reply." }),
        finding(2, { status: "posted" }),
      ],
    });
    const asks: Ask[] = [
      {
        id: "a1",
        at: "2026-11-25T22:25:56.333Z",
        item_key: "decision:pr201-test",
        label: "ops review of #201",
        kind: "review",
        text: "Finding #1 (app/Services/Foo.php:101): Don't post",
        ref: "pr201-test:1",
      },
      {
        id: "a2",
        at: "2026-11-25T22:00:00.000Z",
        item_key: "decision:pr201-test",
        label: "ops review of #201",
        kind: "review",
        text: "Finding #2 (app/Services/Foo.php:102): Post",
        ref: "pr201-test:2",
      },
    ];
    expect(answersFromAsks(asks, d.id, reviewFindings(d)).get("1")).toBe("Don't post");
    expect(isFindingSettled(d.post_comments![0] as never, "Don't post")).toBe(true);
    expect(allFindingsAnswered(d, asks)).toBe(true);
  });
});

describe("per-finding review card UI", () => {
  it("shows Post, Don't post, and a free-text Send to assistant on each finding, with no preselect and a separate Don't post any", async () => {
    const onAnswerFinding = vi.fn<FindingFn>(async () => true);
    render(
      <DecisionCard
        decision={reviewCard()}
        index={1}
        onAnswer={vi.fn()}
        onAnswerFinding={onAnswerFinding}
        findingAnswered={new Map()}
      />,
    );
    expect(screen.queryByText("Post none")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Post" }).every((b) => b.getAttribute("aria-pressed") !== "true")).toBe(true);
    expect(screen.getAllByRole("button", { name: "Don't post" }).every((b) => b.getAttribute("aria-pressed") !== "true")).toBe(true);
    const post = screen.getAllByRole("button", { name: "Post" });
    const skip = screen.getAllByRole("button", { name: "Don't post" });
    const send = screen.getAllByRole("button", { name: "Send to assistant" });
    expect(post).toHaveLength(2);
    expect(skip).toHaveLength(2);
    expect(send).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Don't post any" })).toBeTruthy();
    expect(screen.getByText("Exact comment text for #1.")).toBeTruthy();
    expect(screen.getByText(/app\/Services\/Foo\.php:101/)).toBeTruthy();

    fireEvent.click(post[0]);
    await waitFor(() => expect(onAnswerFinding).toHaveBeenCalled());
    const call = onAnswerFinding.mock.calls[0]!;
    expect(call[0].id).toBe("pr201-test");
    expect(call[1]).toBe(1);
    expect(call[2]).toBe("post");
  });

  it("grays out a finding as soon as Post saves, and keeps the buttons if the send fails", async () => {
    const onAnswerFinding = vi.fn<FindingFn>(async () => true);
    render(
      <DecisionCard
        decision={reviewCard()}
        index={1}
        onAnswer={vi.fn()}
        onAnswerFinding={onAnswerFinding}
        findingAnswered={new Map()}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Post" })[0]);
    await waitFor(() => expect(onAnswerFinding).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector('[data-finding="1"]')?.className).toMatch(/finding-answered/));
    expect(document.querySelector('[data-finding="1"]')?.querySelectorAll("button")).toHaveLength(0);
    expect(screen.getByText(/You said “Post”|You said "Post"/)).toBeTruthy();

    cleanup();
    const fail = vi.fn<FindingFn>(async () => false);
    render(
      <DecisionCard
        decision={reviewCard()}
        index={1}
        onAnswer={vi.fn()}
        onAnswerFinding={fail}
        findingAnswered={new Map()}
      />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Post" })[0]);
    await waitFor(() => expect(screen.getByText("Could not send, try again")).toBeTruthy());
    expect(screen.getAllByRole("button", { name: "Post" })).toHaveLength(2);
    expect(document.querySelector('[data-finding="1"]')?.className).not.toMatch(/finding-answered/);
  });

  it("keeps typed free text when the send fails, and shows the answer once it goes through", async () => {
    const onAnswerFinding = vi.fn<FindingFn>(async () => false);
    render(
      <DecisionCard
        decision={reviewCard()}
        index={1}
        onAnswer={vi.fn()}
        onAnswerFinding={onAnswerFinding}
        findingAnswered={new Map()}
      />,
    );
    const box = screen.getAllByLabelText("Or write your own words")[0] as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Please get me a link for the figma" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Send to assistant" })[0]);
    await waitFor(() => expect(onAnswerFinding).toHaveBeenCalled());
    const noteCall = onAnswerFinding.mock.calls[0]!;
    expect(noteCall[2]).toBe("note");
    expect(noteCall[3]).toBe("Please get me a link for the figma");
    await waitFor(() => expect(screen.getAllByText("Could not send, try again").length).toBeGreaterThan(0));
    expect((screen.getAllByLabelText("Or write your own words")[0] as HTMLTextAreaElement).value).toBe(
      "Please get me a link for the figma",
    );

    cleanup();
    render(
      <DecisionCard
        decision={reviewCard()}
        index={1}
        onAnswer={vi.fn()}
        findingAnswered={new Map([["1", "Please get me a link for the figma"]])}
      />,
    );
    expect(screen.getByText(/You said “Please get me a link for the figma”|You said "Please get me a link for the figma"/)).toBeTruthy();
    // A note keeps Post / Don't post so he can still tap (e.g. approve a rewrite).
    expect(screen.getAllByRole("button", { name: "Post" })).toHaveLength(2);
    expect(document.querySelector('[data-finding="1"]')?.className).not.toMatch(/finding-answered/);
  });

  it("shows an Answer to your question block and the revised Will post text, not just You said the question", () => {
    const d = reviewCard({
      post_comments: [
        finding(1, {
          body: "Shorter will-post text about the update request only.",
          answer_to_question: "The strings are used 2x in the reset service and about 40x in tests.",
        }),
        finding(2),
      ],
    });
    render(
      <DecisionCard
        decision={d}
        index={1}
        onAnswer={vi.fn()}
        findingAnswered={new Map([["1", "How many times is that string used"]])}
      />,
    );
    expect(screen.getByText("Answer to your question")).toBeTruthy();
    expect(screen.getByText(/The strings are used 2x in the reset service/)).toBeTruthy();
    expect(screen.getByText(/You asked/)).toBeTruthy();
    expect(screen.getByText(/How many times is that string used/)).toBeTruthy();
    expect(screen.getByText("Shorter will-post text about the update request only.")).toBeTruthy();
    expect(screen.queryByText(/You said/)).toBeNull();
    // Still waiting for his Post tap on the revised text.
    expect(screen.getAllByRole("button", { name: "Post" }).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-finding="1"]')?.className).not.toMatch(/finding-answered/);
  });

  it("lists each finding as its own open question and collapses it once answered", () => {
    const d = reviewCard();
    const board = { decisions: [d], details: {}, asks: [] as Ask[], ticket_summaries: {} } as unknown as Board;
    const labels = { "decision:pr201-test": { label: "ops review of #201" } };
    const open = buildTopics(board, labels, () => true);
    const topic = open.find((t) => t.key === "decision:pr201-test");
    expect(topic?.open.map((q) => q.uid)).toEqual(["decision:pr201-test#f1", "decision:pr201-test#f2"]);
    expect(topic?.open.every((q) => q.kind === "finding")).toBe(true);

    const answeredBoard = {
      ...board,
      asks: [
        {
          id: "a1",
          at: "2026-11-25T21:14:00.000Z",
          item_key: "decision:pr201-test",
          label: "ops review of #201",
          kind: "review",
          text: "Finding #1 (app/Services/Foo.php:101): Post",
          ref: "pr201-test:1",
        },
      ] as Ask[],
    } as unknown as Board;
    const after = buildTopics(answeredBoard, labels, () => true);
    const t2 = after.find((x) => x.key === "decision:pr201-test");
    expect(t2?.open.map((q) => q.uid)).toEqual(["decision:pr201-test#f2"]);
    expect(t2?.answered).toEqual([
      expect.objectContaining({ uid: "decision:pr201-test#f1", answer: "Post" }),
    ]);

    const onAnswerFinding = vi.fn<FindingFn>(async () => true);
    render(
      <Conversation
        topics={open}
        onOpen={vi.fn()}
        onAnswerThread={vi.fn(async () => true)}
        onAnswerPlan={vi.fn(async () => true)}
        onAnswerDecision={vi.fn()}
        onAnswerFinding={onAnswerFinding}
      />,
    );
    expect(screen.getAllByRole("button", { name: "Post" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Don't post any" })).toBeTruthy();
  });

  it("shows Posted with a view link, or a not-posted reason, on an answered finding", () => {
    const posted = finding(1, { status: "posted", posted_url: "https://github.com/acme/example-repo/pull/1935#discussion_r1" });
    const pending = finding(2, { status: "pending", note: "The file and line are in the diff, so this comment can still be posted." });
    const { rerender } = render(
      <FindingDraft cardId="pr201-test" finding={posted} answered="Post" onAnswer={async () => true} />,
    );
    expect(screen.getByText(/Posted/)).toBeTruthy();
    const view = screen.getByRole("link", { name: "view" });
    expect(view.getAttribute("href")).toContain("discussion_r1");
    rerender(
      <FindingDraft cardId="pr201-test" finding={pending} answered="Post" onAnswer={async () => true} />,
    );
    expect(screen.getByText(/can still be posted/)).toBeTruthy();
  });
});

describe("ab raise and lint require the per-finding review shape", () => {
  const raiseBase = {
    id: "test-review-per-finding",
    group: "pr:example-repo/9997",
    title: "QA review of #9997",
    context: "QA reviewed PR #9997 and found two issues on the export.",
    question: "Should QA post each of these comments?",
    what_happens_after: "Each answer goes to QA with the PR, finding number, and file:line.",
    glance: {
      ticket: { id: "export-review", summary: "Rebuilds a sample export for review comments" },
      pr: { number: 9997, link: "https://github.com/acme/example-repo/pull/9997" },
      asking: "For each comment, Post, Don't post, or write your own words.",
      outcomes: [
        { id: "post", happens: "ops posts that comment as written." },
        { id: "skip", happens: "ops does not post that comment." },
      ],
    },
  };

  it("rejects multi-select, Post none options, and missing post_comments", () => {
    const { dir, boardFile } = makeTempBoard();
    try {
      const multi = runAb(boardFile, [
        "raise",
        JSON.stringify({
          ...raiseBase,
          id: "test-review-multi",
          multiSelect: true,
          options: [
            { id: "f1", label: "#1 Foo.php:10", post_text: "Body" },
            { id: "none", label: "Post none" },
          ],
        }),
      ]);
      expect(multi.code).toBe(2);
      expect(multi.err).toMatch(/per-finding|multiSelect|Post none/i);

      const missing = runAb(boardFile, [
        "raise",
        JSON.stringify({
          ...raiseBase,
          id: "test-review-missing-comments",
          options: [
            { id: "f1", label: "#1 Foo.php:10" },
            { id: "none", label: "Post none" },
          ],
        }),
      ]);
      expect(missing.code).toBe(2);
      expect(missing.err).toMatch(/post_comments|Post none|per-finding/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a review card with post_comments and no options, and lint stays clean", () => {
    const { dir, boardFile } = makeTempBoard();
    try {
      const ok = runAb(boardFile, [
        "raise",
        JSON.stringify({
          ...raiseBase,
          tier: "decision",
          estimate: "2 minutes",
          post_comments: [
            {
              n: 1,
              label: "#1 (High) Foo.php:10",
              severity: "High",
              path: "app/Foo.php",
              line: 10,
              body: "Exact comment text for #1.",
            },
          ],
        }),
      ]);
      expect(ok.err).toBe("");
      expect(ok.code).toBe(0);
      const lint = runAb(boardFile, ["lint"]);
      expect(lint.code).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
