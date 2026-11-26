// Standing rule: board text that mentions another ticket shows a short summary of it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { annotateTickets, setTicketSummaries } from "../src/ticketRefs";

describe("annotateTickets", () => {
  it("adds the summary after the first plain mention only", () => {
    setTicketSummaries({ "PROJ-4411": "Return accrual hours totals per bank", "PROJ-5088": "Employee app PTO request endpoint" });
    expect(annotateTickets("Blocked on PROJ-4411. Later PROJ-4411 again.")).toBe("Blocked on PROJ-4411 (Return accrual hours totals per bank). Later PROJ-4411 again.");
    // Already explained, in code, in a URL or a branch name: left alone.
    expect(annotateTickets("PROJ-4411: Return totals")).toBe("PROJ-4411: Return totals");
    expect(annotateTickets("**PROJ-5088** — endpoint")).toBe("**PROJ-5088** — endpoint");
    expect(annotateTickets("see `PROJ-4411` and https://linear.app/acme/issue/PROJ-4411/x")).toBe("see `PROJ-4411` and https://linear.app/acme/issue/PROJ-4411/x");
    expect(annotateTickets("branch alex/proj-5088 and PROJ-5088-thing")).toBe("branch alex/proj-5088 and PROJ-5088-thing");
    expect(annotateTickets("```\nPROJ-4411\n```\nPROJ-5088 next")).toBe("```\nPROJ-4411\n```\nPROJ-5088 (Employee app PTO request endpoint) next");
    setTicketSummaries(undefined);
    expect(annotateTickets("PROJ-4411")).toBe("PROJ-4411");
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
    writeFileSync(file, `export const board = ${A}\n${JSON.stringify({ updated_at: "2026-11-24T21:00:00.000Z", decisions: [], glance: { waiting: [], tickets: [], others: [] }, details: { "ticket:PROJ-1": { plain: "Needs PROJ-4411 first." } } })}\n${Z};\n`);
    const bad = ab(["lint"]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("PROJ-4411 is mentioned but has no summary");
    expect(ab(["ticket-summaries", '{"PROJ-4411":"line one\\nline two"}']).status).toBe(2);
    expect(ab(["ticket-summaries", JSON.stringify({ "PROJ-1": "This ticket", "PROJ-4411": "Return accrual hours totals per bank" })]).status).toBe(0);
    expect(ab(["lint"]).status).toBe(0);
  });
});
