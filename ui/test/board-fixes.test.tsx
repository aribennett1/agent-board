// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "../src/Conversation";
import { DecisionCard } from "../src/DecisionCard";
import { NoteBox } from "../src/ItemExpand";
import type { Board, Decision } from "../src/data/types";
import { buildTopics } from "../src/topics";

const AB_MJS = path.resolve(__dirname, "../../bin/ab.mjs");
const BOARD_SRC = path.resolve(__dirname, "../src/data/board.ts");

function makeTempBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-fix-test-"));
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

function readBoard(boardFile: string): Board {
  const s = fs.readFileSync(boardFile, "utf8");
  const A = "/* BOARD-JSON-START */";
  const Z = "/* BOARD-JSON-END */";
  return JSON.parse(s.slice(s.indexOf(A) + A.length, s.indexOf(Z)));
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("Post/approve/thumb-up cards show comment and exact reply", () => {
  it("renders answers_comment quote, metadata, link, and exact post_text above options in DecisionCard", () => {
    const card: Decision = {
      id: "pr2014-null-shift-reply",
      card_ref: "PR #2014",
      title: "Bugbot pushback on 2014: null shift IDs",
      question: "Post this exact reply on Bugbot's thread on #2014?",
      what_happens_after: "Grok Bot posts the reply.",
      answers_comment: {
        author: "cursor[bot]",
        repo: "ROWSHR/rows-backend",
        pr: 2014,
        path: "app/Http/Requests/EmployeeApp/StoreTimeOffRequestRequest.php",
        line: 167,
        severity: "High",
        url: "https://github.com/ROWSHR/rows-backend/pull/2014#discussion_r4696970871",
        body: "### Null shift IDs fail distinct\n\nTwo unscheduled entries both omit or null the shift id.",
      },
      post_text: "`distinct` is not an implicit rule.\n\nWhat do you think?",
      options: [
        { id: "post", label: "Post it" },
        { id: "skip", label: "Don't post" },
      ],
      created_at: "2026-11-25T15:00:00.000Z",
    };

    const { container } = render(<DecisionCard decision={card} index={1} onAnswer={vi.fn()} />);
    expect(screen.getByText(/StoreTimeOffRequestRequest\.php:167/)).toBeTruthy();
    expect(container.querySelector(".severity-chip")?.textContent).toBe("High");
    expect(screen.getByText(/Two unscheduled entries both omit or null the shift id\./)).toBeTruthy();
    expect(screen.getByText(/What do you think\?/)).toBeTruthy();
    const link = screen.getByRole("link", { name: /View on GitHub/i }) as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/ROWSHR/rows-backend/pull/2014#discussion_r4696970871");

    const block = container.querySelector(".post-approval-block")!;
    const options = container.querySelector(".options")!;
    expect(block.compareDocumentPosition(options) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders 'No text gets posted — only a 👍 reaction.' when post_text is null", () => {
    const card: Decision = {
      id: "pr2016-thumbs-up",
      card_ref: "PR #2016",
      question: "Put a 👍 on Bugbot's #2016 comment?",
      what_happens_after: "Adds 👍.",
      answers_comment: {
        author: "cursor[bot]",
        pr: 2016,
        path: "app/Services/PayrollService.php",
        line: 42,
        url: "https://github.com/ROWSHR/rows-backend/pull/2016#discussion_r123",
        body: "Looks wrong.",
      },
      post_text: null,
      options: [
        { id: "yes", label: "Put 👍" },
        { id: "no", label: "Skip" },
      ],
      created_at: "2026-11-25T15:00:00.000Z",
    };

    render(<DecisionCard decision={card} index={1} onAnswer={vi.fn()} />);
    expect(screen.getByText(/No text gets posted — only a 👍 reaction\./)).toBeTruthy();
  });

  it("forwards answers_comment and post_text through buildTopics into Conversation", () => {
    const board: Board = {
      updated_at: "2026-11-25T15:50:00.000Z",
      glance: { waiting: [], tickets: [], others: [], mine: [] },
      decisions: [],
      details: {
        "decision:pr2014-null-shift-distinct": {
          thread: [
            {
              at: "2026-11-25T15:50:00.000Z",
              from: "bot",
              text: "Draft reply",
              question: {
                id: "q-null-shift",
                text: "Post this exact reply on Bugbot's thread on #2014?",
                context: "Check before posting.",
                answers_comment: {
                  author: "cursor[bot]",
                  repo: "ROWSHR/rows-backend",
                  pr: 2014,
                  path: "app/Http/Requests/EmployeeApp/StoreTimeOffRequestRequest.php",
                  line: 167,
                  severity: "High",
                  url: "https://github.com/ROWSHR/rows-backend/pull/2014#discussion_r4696970871",
                  body: "Two unscheduled entries both omit or null the shift id."
                },
                post_text: "Laravel skips distinct (Validator::isNotNullIfMarkedAsNullable).",
                options: [{ id: "post", label: "Post it" }, { id: "skip", label: "Don't post" }]
              }
            }
          ]
        }
      },
      asks: []
    };
    const topics = buildTopics(
      board,
      {
        "decision:pr2014-null-shift-distinct": {
          label: "Bugbot pushback on 2014: null shift IDs",
        },
      },
      () => false,
    );
    const topic = topics.find((t) => t.key === "decision:pr2014-null-shift-distinct");
    expect(topic).toBeTruthy();
    expect(topic!.open.length).toBeGreaterThan(0);

    render(
      <Conversation
        topics={[topic!]}
        onOpen={vi.fn()}
        onAnswerDecision={vi.fn()}
        onAnswerThread={vi.fn(async () => true)}
        onAnswerPlan={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByText(/StoreTimeOffRequestRequest\.php:167/)).toBeTruthy();
    expect(screen.getByText(/Two unscheduled entries both omit or null the shift id/)).toBeTruthy();
    expect(screen.getByText(/Validator::isNotNullIfMarkedAsNullable/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /View on GitHub/i })).toBeTruthy();
  });
});

describe("Already decided banner and exact SHA on push cards", () => {
  it("renders You already decided X banner when priorDecision is set", () => {
    const card: Decision = {
      id: "repeat-q",
      card_ref: "PR #2014",
      question: "Check shift again?",
      what_happens_after: "Sends answer.",
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      created_at: "2026-11-25T15:00:00.000Z",
    };
    render(
      <DecisionCard
        decision={card}
        index={1}
        onAnswer={vi.fn()}
        priorDecision={{ answer: "Yes, re-check after locking", source: "Q2", at: "2026-11-25T14:00:00.000Z" }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("You already decided Yes, re-check after locking");
  });

  it("renders exact commit SHA on push cards", () => {
    const sha = "cc8d1e0884241ee04eca28db2c414888cf082c9a";
    const card: Decision = {
      id: "push-1838",
      card_ref: "PR #1838",
      title: "Push #1838?",
      question: "Push #1838 now?",
      what_happens_after: "Pushes branch.",
      sha,
      options: [
        { id: "push", label: "Push it" },
        { id: "hold", label: "Hold" },
      ],
      created_at: "2026-11-25T15:00:00.000Z",
    };
    render(<DecisionCard decision={card} index={1} onAnswer={vi.fn()} />);
    expect(screen.getByText(sha)).toBeTruthy();
  });
});

describe("NoteBox keeps typed text on failure and retries", () => {
  it("preserves text on 'Could not send', keeps localStorage draft, and succeeds on Try again", async () => {
    const onSend = vi
      .fn<(t: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    render(<NoteBox draftKey="test-q1b" label="Your answer" button="Send to Grok Bot" onSend={onSend} />);
    const input = screen.getByLabelText("Your answer") as HTMLTextAreaElement;
    const text = "Ya, I'm wondering why would we not use the existing code?";
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Grok Bot" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not send, try again"));
    expect(input.value).toBe(text);
    expect(window.localStorage.getItem("action-board:note-draft:test-q1b")).toBe(text);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(onSend).toHaveBeenLastCalledWith(text);
    expect(input.value).toBe("");
    expect(window.localStorage.getItem("action-board:note-draft:test-q1b")).toBeNull();
  });
});

describe("ab.mjs structural rules", () => {
  it("rejects GitHub post/reply/approve/👍 raise without answers_comment and post_text, and accepts when provided", () => {
    const { dir, boardFile } = makeTempBoard();
    try {
      const bad = runAb(boardFile, [
        "raise",
        JSON.stringify({
          id: "test-post-missing",
          title: "Post on #9999?",
          context: "The time off PR has a Bugbot comment on the validation rule. Checking if you want to post a reply.",
          question: "Post this exact reply on Bugbot's thread on #9999?",
          what_happens_after: "Posts reply.",
          options: [
            { id: "post", label: "Post it" },
            { id: "skip", label: "Skip" },
          ],
        }),
      ]);
      expect(bad.code).toBe(2);
      expect(bad.err).toMatch(/answers_comment/);

      const badNoPostText = runAb(boardFile, [
        "raise",
        JSON.stringify({
          id: "test-post-missing-text",
          title: "Post on #9999?",
          context: "The time off PR has a Bugbot comment on the validation rule. Checking if you want to post a reply.",
          question: "Post this exact reply on Bugbot's thread on #9999?",
          what_happens_after: "Posts reply.",
          answers_comment: {
            author: "cursor[bot]",
            pr: 9999,
            url: "https://github.com/ROWSHR/rows-backend/pull/9999#discussion_r1",
            body: "Bug here.",
          },
          options: [
            { id: "post", label: "Post it" },
            { id: "skip", label: "Skip" },
          ],
        }),
      ]);
      expect(badNoPostText.code).toBe(2);
      expect(badNoPostText.err).toMatch(/post_text/);

      const good = runAb(boardFile, [
        "raise",
        JSON.stringify({
          id: "test-post-ok",
          title: "Post on #9999?",
          context: "The time off PR has a Bugbot comment on the validation rule. Checking if you want to post a reply.",
          question: "Post this exact reply on Bugbot's thread on #9999?",
          what_happens_after: "Posts reply.",
          answers_comment: {
            author: "cursor[bot]",
            pr: 9999,
            path: "app/Foo.php",
            line: 10,
            severity: "High",
            url: "https://github.com/ROWSHR/rows-backend/pull/9999#discussion_r1",
            body: "Bug here.",
          },
          post_text: "Fixed in next commit.",
          options: [
            { id: "post", label: "Post it" },
            { id: "skip", label: "Skip" },
          ],
        }),
      ]);
      expect(good.code).toBe(0);

      const goodThumb = runAb(boardFile, [
        "raise",
        JSON.stringify({
          id: "test-thumb-ok",
          title: "👍 Bugbot on #9999?",
          context: "The time off PR has a Bugbot comment we agree with. Checking if you want to add a thumbs up.",
          question: "Put 👍 on Bugbot's thread on #9999?",
          what_happens_after: "Adds thumbs up.",
          answers_comment: {
            author: "cursor[bot]",
            pr: 9999,
            url: "https://github.com/ROWSHR/rows-backend/pull/9999#discussion_r2",
            body: "Good catch.",
          },
          post_text: null,
          options: [
            { id: "yes", label: "Put 👍" },
            { id: "no", label: "Skip" },
          ],
        }),
      ]);
      expect(goodThumb.code).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supersedes earlier open question on decision thread instead of duplicating, and enforces/supersedes SHA on push cards", () => {
    const { dir, boardFile } = makeTempBoard();
    try {
      const r1 = runAb(boardFile, [
        "reply",
        "decision:time-off-approval-plan",
        "Follow-up on Q97",
        "--question",
        "Q97: Keep this?",
        "--context",
        "Checking Q4 again.",
        "--option",
        "Yes",
        "--option",
        "No",
      ]);
      expect(r1.code).toBe(0);
      const b1 = readBoard(boardFile);
      const openQ4 = (b1.details?.["decision:time-off-approval-plan"]?.thread ?? []).filter(
        (t) => t.question && /^Q97\b/.test(t.question.text) && !t.question.superseded_by,
      );
      expect(openQ4.length).toBe(1);

      const badPush = runAb(boardFile, [
        "raise",
        JSON.stringify({
          id: "test-push-no-sha",
          group: "pr:rows-backend/9998",
          title: "Payroll fix (#9998): push branch",
          context: "Ready to push the payroll fix branch. Waiting for your go-ahead.",
          question: "Push #9998 now?",
          what_happens_after: "Pushes.",
          options: [
            { id: "push", label: "Push" },
            { id: "wait", label: "Wait" },
          ],
        }),
      ]);
      expect(badPush.code).toBe(2);
      expect(badPush.err).toMatch(/sha/i);

      const sha1 = "1111111111111111111111111111111111111111";
      const sha2 = "2222222222222222222222222222222222222222";
      expect(
        runAb(boardFile, [
          "raise",
          JSON.stringify({
            id: "test-push-1",
            group: "pr:rows-backend/9998",
            title: "Payroll fix (#9998): push branch",
            context: "Ready to push the payroll fix branch. Waiting for your go-ahead.",
            question: "Push #9998 now?",
            what_happens_after: "Pushes.",
            sha: sha1,
            options: [
              { id: "push", label: "Push" },
              { id: "wait", label: "Wait" },
            ],
          }),
        ]).code,
      ).toBe(0);

      expect(
        runAb(boardFile, [
          "raise",
          JSON.stringify({
            id: "test-push-2",
            group: "pr:rows-backend/9998",
            title: "Payroll fix (#9998): push branch",
            context: "New commit is ready on the payroll fix branch. Waiting for your go-ahead.",
            question: "Push #9998 now?",
            what_happens_after: "Pushes.",
            sha: sha2,
            options: [
              { id: "push", label: "Push" },
              { id: "wait", label: "Wait" },
            ],
          }),
        ]).code,
      ).toBe(0);

      const b2 = readBoard(boardFile);
      const p1 = b2.decisions.find((d) => d.id === "test-push-1");
      const p2 = b2.decisions.find((d) => d.id === "test-push-2");
      expect(p1?.superseded_by).toBe("test-push-2");
      expect(p2?.superseded_by).toBeUndefined();
      expect(p2?.sha).toBe(sha2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("Review card options post_text and raw ticket inline lint rules", () => {
  it("renders per-finding review comments with severity, file:line, summary, and Will post block", () => {
    const reviewCard: Decision = {
      id: "pr1935-test",
      card_ref: "https://github.com/ROWSHR/rows-backend/pull/1935",
      title: "QA review of #1935",
      question: "Should QA post each of these comments?",
      what_happens_after: "Each answer goes to QA with the PR, finding number, and file:line.",
      options: [],
      post_comments: [
        {
          n: 1,
          label: "#1 (High) Foo.php:177",
          severity: "High",
          path: "app/Services/Foo.php",
          line: 177,
          summary: "Overtime codes fold into OT",
          body: "Exact comment text for #1.",
        },
      ],
      created_at: "2026-11-25T16:00:00.000Z",
    };
    render(<DecisionCard decision={reviewCard} index={1} onAnswer={vi.fn()} />);
    expect(screen.getByText(/app\/Services\/Foo\.php:177/)).toBeTruthy();
    expect(screen.getByText("Overtime codes fold into OT")).toBeTruthy();
    expect(screen.getByText("Will post")).toBeTruthy();
    expect(screen.getByText("Exact comment text for #1.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Post" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Don't post" })).toBeTruthy();
    expect(screen.queryByText("Post none")).toBeNull();
  });

  it("rejects old multi-select review cards and inline raw Linear ticket markdown", () => {
    const { dir, boardFile } = makeTempBoard();
    try {
      const missingOptPostText = runAb(boardFile, [
        "raise",
        JSON.stringify({
          id: "test-review-missing-post-text",
          group: "pr:rows-backend/9997",
          title: "QA review of #9997",
          context: "QA reviewed PR #9997 and found two issues on the export.",
          question: "Which comments should QA post?",
          what_happens_after: "QA posts picked comments.",
          multiSelect: true,
          options: [
            { id: "f1", label: "#1 Foo.php:10" },
            { id: "none", label: "Post none" },
          ],
        }),
      ]);
      expect(missingOptPostText.code).toBe(2);
      expect(missingOptPostText.err).toMatch(/per-finding|multiSelect|Post none|post_comments/i);

      const rawInline = runAb(boardFile, [
        "raise",
        JSON.stringify({
          id: "test-raw-ticket-inline",
          title: "Fix time off request",
          context: "## ROWS-2512: Endpoints for viewing\n\n- **Ticket:** [ROWS-2512](https://linear.app/rows/issue/ROWS-2512)",
          question: "Proceed?",
          what_happens_after: "Continues.",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        }),
      ]);
      expect(rawInline.code).toBe(2);
      expect(rawInline.err).toMatch(/raw Linear ticket markdown/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
