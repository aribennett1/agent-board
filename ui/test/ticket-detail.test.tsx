// @vitest-environment jsdom
// The 3-part order for anything that asks the user about a ticket: the full ticket, then "In plain words",
// then the questions (and the plan). ab ticket stores the first two and refuses a ticket without a summary.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Board } from "../src/data/types";
import { ItemDetails } from "../src/ItemExpand";

afterEach(cleanup);

describe("ticket details", () => {
  it("shows the ticket, then plain words, then questions, then the plan", () => {
    const { container } = render(
      <ItemDetails
        detail={{
          ticket: "## PROJ-1: Banks in seconds\n\n- **Status:** To Do\n\n### Acceptance criteria\n\n- Stored in seconds",
          plain: "Banks drift from timecards. This fixes it.",
          plan: "# Plan",
          questions: [{ id: "Q1", question: "Round up?", recommendation: "Yes" }],
        }}
        actions={[]}
        onSend={async () => true}
      />,
    );
    const order = [...container.querySelectorAll(".item-ticket, .item-plain, .item-questions, .item-plan")].map((e) => e.className);
    expect(order).toEqual(["item-ticket", "item-plain", "item-questions", "item-plan"]);
    expect(container.querySelector(".item-ticket .md-h2")?.textContent).toBe("PROJ-1: Banks in seconds");
    expect(container.querySelector(".item-plain")?.textContent).toContain("Banks drift from timecards.");
  });
});

describe("ab ticket", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-ticket-"));
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

  it("attaches the ticket and plain words without touching the plan, and needs both", () => {
    writeFileSync(file, `export const board = ${A}\n${JSON.stringify({ updated_at: "2026-11-10T09:00:00.000Z", decisions: [], glance: { waiting: [], tickets: [], others: [] }, details: { "ticket:PROJ-1": { plan: "# Plan" } } })}\n${Z};\n`);
    const md = join(dir, "PROJ-1.md");
    writeFileSync(md, "## PROJ-1: Banks in seconds\n");
    expect(ab(["ticket", "PROJ-1", md]).status).toBe(2);
    expect(ab(["ticket", "PROJ-1", join(dir, "missing.md"), "--plain", "x"]).status).toBe(2);
    const ok = ab(["ticket", "PROJ-1", md, "--plain", "Banks drift. This fixes it."]);
    expect(ok.status).toBe(0);
    const d = read().details!["ticket:PROJ-1"];
    expect(d).toMatchObject({ ticket: "## PROJ-1: Banks in seconds\n", ticket_file: "PROJ-1.md", plain: "Banks drift. This fixes it.", plan: "# Plan" });
  });
it("plan reads a Questions for the owner section with My pick answers", () => {
    writeFileSync(file, `export const board = ${A}\n${JSON.stringify({ updated_at: "2026-11-10T09:00:00.000Z", decisions: [], glance: { waiting: [], tickets: [], others: [] } })}\n${Z};\n`);
    const md = join(dir, "PROJ-2-plan.md");
    writeFileSync(md, "### 6. Open questions\n\nMoved to section 4 below.\n\n## 4. Questions for the owner\n\n1. Old amounts are positive. Should we convert them\n   once with a migration?\n   - My pick: Convert them once.\n   - Context: Reimbursements are stored positive today. We're asking whether to flip the old ones once.\n2. Apply it to **net check** too?\n   - My pick: No.\n   - Context: Net check is a take-home-pay amount. Should the same sign rule apply?\n");
    expect(ab(["plan", "PROJ-2", md]).status).toBe(0);
    expect(read().details!["ticket:PROJ-2"].questions).toEqual([
      expect.objectContaining({ id: "Q1", question: "Old amounts are positive. Should we convert them once with a migration?", recommendation: "Convert them once." }),
      expect.objectContaining({ id: "Q2", question: "Apply it to net check too?", recommendation: "No." }),
    ]);
  });
});
