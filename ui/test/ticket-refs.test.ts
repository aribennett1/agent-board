// Standing rule: board text that mentions another ticket shows a short summary of it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { annotateTickets, setTicketSummaries } from "../src/ticketRefs";

describe("annotateTickets", () => {
  it("adds the summary after the first plain mention only", () => {
    setTicketSummaries({ "ROWS-4411": "Return accrual hours totals per bank", "ROWS-5088": "Employee app PTO request endpoint" });
    expect(annotateTickets("Blocked on ROWS-4411. Later ROWS-4411 again.")).toBe("Blocked on ROWS-4411 (Return accrual hours totals per bank). Later ROWS-4411 again.");
    // Already explained, in code, in a URL or a branch name: left alone.
    expect(annotateTickets("ROWS-4411: Return totals")).toBe("ROWS-4411: Return totals");
    expect(annotateTickets("**ROWS-5088** — endpoint")).toBe("**ROWS-5088** — endpoint");
    expect(annotateTickets("see `ROWS-4411` and https://linear.app/rows/issue/ROWS-4411/x")).toBe("see `ROWS-4411` and https://linear.app/rows/issue/ROWS-4411/x");
    expect(annotateTickets("branch arib/rows-5088 and ROWS-5088-thing")).toBe("branch arib/rows-5088 and ROWS-5088-thing");
    expect(annotateTickets("```\nROWS-4411\n```\nROWS-5088 next")).toBe("```\nROWS-4411\n```\nROWS-5088 (Employee app PTO request endpoint) next");
    setTicketSummaries(undefined);
    expect(annotateTickets("ROWS-4411")).toBe("ROWS-4411");
  });
});

describe("ab lint / ab ticket-summaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-refs-"));
  const file = join(dir, "app/src/data/board.ts");
  mkdirSync(join(dir, "app/src/data"), { recursive: true });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const A = "/* BOARD-JSON-START */";
  const Z = "/* BOARD-JSON-END */";
  const AB = join(process.cwd(), "..", "bin/ab.mjs");
  const ab = (args: string[]) => spawnSync("node", [AB, ...args], { encoding: "utf8", env: { ...process.env, AB_FILE: file, AB_NO_SERVER: "1" } });

  it("flags a mentioned ticket with no summary until one is added", () => {
    writeFileSync(file, `export const board = ${A}\n${JSON.stringify({ updated_at: "2026-11-24T21:00:00.000Z", decisions: [], glance: { waiting: [], tickets: [], others: [] }, details: { "ticket:ROWS-1": { plain: "Needs ROWS-4411 first." } } })}\n${Z};\n`);
    const bad = ab(["lint"]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("ROWS-4411 is mentioned but has no summary");
    expect(ab(["ticket-summaries", '{"ROWS-4411":"line one\\nline two"}']).status).toBe(2);
    expect(ab(["ticket-summaries", JSON.stringify({ "ROWS-1": "This ticket", "ROWS-4411": "Return accrual hours totals per bank" })]).status).toBe(0);
    expect(ab(["lint"]).status).toBe(0);
  });
});
