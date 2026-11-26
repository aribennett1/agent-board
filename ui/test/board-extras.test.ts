import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Board } from "../src/data/types";

// ab mypr, reviews, review-status, detail and plan against a temp board.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const AB = join(ROOT, "bin/ab.mjs");
const repo = mkdtempSync(join(tmpdir(), "ab-extras-"));
const file = join(repo, "app/src/data/board.ts");
mkdirSync(join(repo, "app/src/data"), { recursive: true });
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const A = "/* BOARD-JSON-START */";
const Z = "/* BOARD-JSON-END */";
const empty: Board = { updated_at: "2026-11-10T09:00:00.000Z", decisions: [], glance: { waiting: [], tickets: [], others: [] } };
beforeEach(() => writeFileSync(file, `export const board = ${A}\n${JSON.stringify(empty)}\n${Z};\n`));
const read = (): Board => {
  const s = readFileSync(file, "utf8");
  return JSON.parse(s.slice(s.indexOf(A) + A.length, s.indexOf(Z)));
};
const ab = (args: string[], input?: string) => spawnSync("node", [AB, ...args], { input, encoding: "utf8", env: { ...process.env, AB_FILE: file, AB_NO_SERVER: "1" } });

const pr = { repo: "example-repo", number: 1982, title: "Banks in seconds", link: "https://github.com/acme/example-repo/pull/1982", state: "ready", ci: "passing", reviews: 1 };
const draft = {
  repo: "example-repo",
  pr: 1907,
  verdict: "Looks good",
  comments: [{ id: "c1", severity: "medium", title: "Tag race", path: "a.yaml", line: 10, body: "Body", status: "pending" }],
};

describe("ab board extras", () => {
  it("mypr replaces My PRs, and glance keeps them", () => {
    expect(ab(["mypr"], JSON.stringify([pr])).status).toBe(0);
    expect(read().glance.mine).toEqual([pr]);
    expect(ab(["glance"], JSON.stringify({ waiting: [], tickets: [] })).status).toBe(0);
    expect(read().glance.mine).toEqual([pr]);
    expect(ab(["mypr"], JSON.stringify([{ ...pr, state: "merged" }])).status).toBe(2);
  });

  it("reviews upserts drafts and review-status marks a comment or the whole PR", () => {
    expect(ab(["reviews"], JSON.stringify([draft])).status).toBe(0);
    expect(ab(["reviews"], JSON.stringify([{ ...draft, verdict: "Needs changes" }])).status).toBe(0);
    expect(read().reviews).toHaveLength(1);
    expect(read().reviews?.[0].verdict).toBe("Needs changes");
    expect(ab(["review-status", "example-repo#1907", "c1", "posted"]).status).toBe(0);
    expect(read().reviews?.[0].comments[0].status).toBe("posted");
    expect(ab(["review-status", "example-repo#1907", "--done"]).status).toBe(0);
    expect(read().reviews?.[0].done).toBe(true);
    expect(ab(["review-status", "example-repo#1", "c1", "posted"]).status).toBe(5);
    expect(ab(["reviews"], JSON.stringify([{ ...draft, comments: [{ ...draft.comments[0], severity: "urgent" }] }])).status).toBe(2);
  });

  it("review-status marks a finding on a per-comment review card, with a posted link or a reason", () => {
    const card = {
      id: "pr1907-qa-review",
      title: "QA review of #1907",
      card_ref: "https://github.com/acme/example-repo/pull/1907",
      context: "QA reviewed the payroll export pull request and left two comments to post.",
      question: "Should QA post each of these comments on the payroll export pull request?",
      what_happens_after: "Each answer goes to QA with the finding number and file.",
      options: [],
      post_comments: [
        { n: 1, label: "#1 Foo.php:10", path: "app/Foo.php", line: 10, body: "First finding.", status: "pending" },
        { n: 2, label: "#2 Bar.php:20", path: "app/Bar.php", line: 20, body: "Second finding.", status: "pending" },
      ],
      group: "pr:example-repo/1907",
      glance: { ticket: { id: "export-review", summary: "Payroll export review comments" }, pr: { number: 1907, link: "https://github.com/acme/example-repo/pull/1907" }, asking: "Post or skip each comment.", outcomes: [] },
      created_at: "2026-11-25T16:00:00.000Z",
    };
    const b = read();
    b.decisions = [card as any];
    writeFileSync(file, `export const board = ${A}\n${JSON.stringify(b)}\n${Z};\n`);
    expect(ab(["review-status", "example-repo#1907", "1", "posted"]).status).toBe(2);
    const posted = ab(["review-status", "example-repo#1907", "#1", "posted", "--url", "https://github.com/acme/example-repo/pull/1907#discussion_r1"]);
    expect(posted.status).toBe(0);
    expect(read().decisions[0].post_comments?.[0]).toMatchObject({
      n: 1,
      status: "posted",
      posted_url: "https://github.com/acme/example-repo/pull/1907#discussion_r1",
    });
    expect(read().decisions[0].post_comments?.[0].url).toBeUndefined();
    const skipped = ab(["review-status", "example-repo#1907", "f2", "skipped", "--note", "The line left the diff."]);
    expect(skipped.status).toBe(0);
    expect(read().decisions[0].post_comments?.[1]).toMatchObject({ status: "skipped", note: "The line left the diff." });
    const pending = ab(["review-status", "example-repo#1907", "2", "pending", "--note", "The file and line are still in the diff."]);
    expect(pending.status).toBe(0);
    expect(read().decisions[0].post_comments?.[1]).toMatchObject({ status: "pending", note: "The file and line are still in the diff." });
    const answered = ab([
      "review-status",
      "example-repo#1907",
      "1",
      "--answer-to-question",
      "The strings are used 2x in the reset service.",
      "--body",
      "Shorter will-post text.",
    ]);
    expect(answered.status).toBe(0);
    expect(read().decisions[0].post_comments?.[0]).toMatchObject({
      n: 1,
      status: "posted",
      answer_to_question: "The strings are used 2x in the reset service.",
      body: "Shorter will-post text.",
    });
    expect(ab(["review-status", "example-repo#1", "1", "posted", "--url", "https://github.com/acme/example-repo/pull/1#discussion_r1"]).status).toBe(5);
  });

  it("plan attaches the file and its section 6 questions; detail merges and clears", () => {
    const md = join(repo, "PROJ-1.md");
    writeFileSync(md, "# Plan\n\n## 6. Open questions\n\n- **Q0 — Use the ledger?** Yes. **Recommendation:** use `available_hours`.\n1. **Column names.** *Recommendation: keep them.*\n\n## 7. Next\n");
    // Every question needs its short context paragraph (t111u): without it, ab plan refuses.
    expect(ab(["plan", "PROJ-1", md]).status).toBe(2);
    const ctx = join(repo, "PROJ-1.context.json");
    writeFileSync(ctx, JSON.stringify({ Q0: "Banks track hours. We're asking which number to read.", Q2: "The new table needs column names. Keep the usual ones?" }));
    expect(ab(["plan", "PROJ-1", md, "--context", ctx]).status).toBe(0);
    const d = read().details?.["ticket:PROJ-1"];
    expect(d?.plan).toContain("# Plan");
    expect(d?.questions?.map((q) => [q.id, q.question, q.recommendation])).toEqual([
      ["Q0", "Use the ledger?", "use `available_hours`."],
      ["Q2", "Column names.", "keep them."],
    ]);
    expect(ab(["detail", "ticket:PROJ-1", JSON.stringify({ summary: "Hi" })]).status).toBe(0);
    expect(read().details?.["ticket:PROJ-1"]?.summary).toBe("Hi");
    expect(read().details?.["ticket:PROJ-1"]?.plan).toContain("# Plan");
    expect(ab(["detail", "ticket:PROJ-1", "--clear"]).status).toBe(0);
    expect(read().details?.["ticket:PROJ-1"]).toBeUndefined();
    expect(ab(["detail", "bad key"]).status).toBe(2);
  });
});
