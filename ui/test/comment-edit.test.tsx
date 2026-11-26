// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionCard } from "../src/DecisionCard";
import type { Decision } from "../src/data/types";

const AB_MJS = path.resolve(__dirname, "../../bin/ab.mjs");
const BOARD_SRC = path.resolve(__dirname, "../src/data/board.ts");

afterEach(() => cleanup());

function makeTempBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-comment-edit-"));
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

const current = [
  "The overtime hours are counted twice on a holiday shift.",
  "",
  "What do you think about dropping the special case?",
  "",
  "```suggestion",
  "// If keeping a single OT column:",
  "$overtimeSeconds = max(0, $entry->overtime_seconds - $entry->holiday_overridden_overtime_seconds);",
  "// Or drop overtime_seconds instead.",
  "```",
].join("\n");

const next = [
  "The overtime hours are counted twice on a holiday shift.",
  "",
  "What do you think about dropping the special case?",
  "",
  "```suggestion",
  "            $overtimeSeconds = max(0, $entry->overtime_seconds - $entry->holiday_overridden_overtime_seconds);",
  "```",
  "",
  "Or, better, drop the special case and use pay lines.",
].join("\n");

const asking = "You're being asked to edit the overtime comment you already posted: only the code box changes; your explanation stays the same.";

function editCard(over: Partial<Decision> = {}): Decision {
  return {
    id: "pr202-ot-suggestion-fix-test",
    title: "Fix a code suggestion in your overtime comment",
    card_ref: "https://github.com/example/app/pull/202#discussion_r1",
    context: "You already posted a comment on the payroll export about overtime counting twice. Only the code box is broken.",
    question: "Swap the broken code box in your posted overtime comment for the clean one?",
    what_happens_after: "If you pick Yes, I edit your comment on GitHub to the new text right away. If No, nothing happens.",
    options: [
      { id: "edit", label: "Yes, swap in the clean code box", post_text: next },
      { id: "leave", label: "No, leave my comment as is" },
    ],
    answers_comment: {
      author: "sam-dev",
      pr: 202,
      repo: "example/app",
      path: "app/Services/Timecard/MasterTimecardPayrollExportRowBuilder.php",
      line: 205,
      url: "https://github.com/example/app/pull/202#discussion_r1",
      body: current,
    },
    post_text: next,
    current_text: current,
    glance: {
      ticket: { id: "PROJ-4937", summary: "Master timecard payroll export for all employees in a pay period." },
      pr: { number: 202, link: "https://github.com/example/app/pull/202" },
      asking,
      outcomes: [
        { id: "edit", happens: "I edit your posted comment on GitHub. Only the code box changes." },
        { id: "leave", happens: "Nothing changes on GitHub." },
      ],
    },
    created_at: "2026-11-25T16:00:00.000Z",
    ...over,
  };
}

describe("comment edit cards", () => {
  it("opens with a plain sentence and a highlighted now/new diff, not two full text blobs", () => {
    render(
      <DecisionCard
        decision={editCard()}
        index={1}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.getAllByText(asking).length).toBeGreaterThan(0);
    expect(screen.getByText("What changes")).toBeTruthy();
    expect(screen.getByText("now")).toBeTruthy();
    expect(screen.getByText("new")).toBeTruthy();
    expect(screen.getByText(/unchanged lines hidden/i)).toBeTruthy();
    expect(document.body.textContent).toContain("If keeping a single OT column");
    expect(document.body.textContent).toContain("Or, better, drop the special case");
    expect(screen.getByText("Posted comment")).toBeTruthy();
    expect(screen.queryByText("Will post")).toBeNull();
    expect(screen.queryByText("Comment you're answering")).toBeNull();
  });

  it("still quotes a new reply when the card is not an edit of a posted comment", () => {
    const card = editCard({
      id: "pr202-reply",
      current_text: undefined,
      question: "Post this exact reply on the payroll export thread?",
      what_happens_after: "I post the reply on GitHub.",
      options: [
        { id: "post", label: "Post it" },
        { id: "skip", label: "Skip" },
      ],
      post_text: "Fixed in the next commit.",
    });
    render(<DecisionCard decision={card} index={1} onAnswer={vi.fn()} />);
    expect(screen.getByText("Will post")).toBeTruthy();
    expect(screen.getByText("Fixed in the next commit.")).toBeTruthy();
  });
});

describe("ab raise and lint require current_text and an honest what_happens_after on edit cards", () => {
  const base = {
    id: "test-edit-comment",
    title: "Fix a code suggestion in your overtime comment",
    context: "You already posted a comment on the payroll export about overtime counting twice. Only the code box is broken.",
    question: "Swap the broken code box in your posted overtime comment for the clean one?",
    answers_comment: {
      author: "sam-dev",
      pr: 202,
      path: "app/Foo.php",
      line: 10,
      url: "https://github.com/example/app/pull/202#discussion_r1",
      body: current,
    },
    post_text: next,
    options: [
      { id: "edit", label: "Edit to the corrected text", post_text: next },
      { id: "leave", label: "Leave as posted" },
    ],
    glance: {
      ticket: { id: "export-review", summary: "Payroll export review comments" },
      pr: { number: 202, link: "https://github.com/example/app/pull/202" },
      asking,
      outcomes: [
        { id: "edit", happens: "Edits the posted comment." },
        { id: "leave", happens: "Leaves the comment as it is." },
      ],
    },
    tier: "quick",
    estimate: "20 seconds",
    group: "pr:app/202",
  };

  it("rejects an edit card with no current_text", () => {
    const { boardFile, dir } = makeTempBoard();
    try {
      const bad = runAb(boardFile, [
        "raise",
        JSON.stringify({
          ...base,
          what_happens_after: "If you pick Edit, I update that comment on GitHub. If Leave, nothing changes.",
        }),
      ]);
      expect(bad.code).toBe(2);
      expect(bad.err).toMatch(/current_text/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an edit card whose what_happens_after says nothing changes on GitHub", () => {
    const { boardFile, dir } = makeTempBoard();
    try {
      const bad = runAb(boardFile, [
        "raise",
        JSON.stringify({
          ...base,
          current_text: current,
          what_happens_after: "Your answer goes to ops word for word, and nothing changes on GitHub until you pick.",
        }),
      ]);
      expect(bad.code).toBe(2);
      expect(bad.err).toMatch(/what_happens_after|GitHub/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts an edit card with current_text and a what_happens_after that says the comment is edited on GitHub", () => {
    const { boardFile, dir } = makeTempBoard();
    try {
      const good = runAb(boardFile, [
        "raise",
        JSON.stringify({
          ...base,
          current_text: current,
          what_happens_after: "If you pick Edit, I update that comment on GitHub to the new text. If Leave, nothing changes.",
        }),
      ]);
      expect(good.code).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
