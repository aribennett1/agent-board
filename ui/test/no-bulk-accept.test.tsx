// @vitest-environment jsdom
// t103u: The owner answers every Engineer question himself. No card or thread offers "accept all picks", no option is
// labelled "(pick)", nothing is preselected, and a question already answered (ab already-answered) is never re-asked.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { ItemDetails } from "../src/ItemExpand";
import type { Board } from "../src/data/types";

const A = "/* BOARD-JSON-START */";
const Z = "/* BOARD-JSON-END */";
const dir = mkdtempSync(join(tmpdir(), "ab-bulk-"));
const file = join(dir, "app/src/data/board.ts");
mkdirSync(join(dir, "app/src/data"), { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(cleanup);
const AB = join(process.cwd(), "..", "bin/ab.mjs");
const ab = (args: string[]) => spawnSync("node", [AB, ...args], { encoding: "utf8", env: { ...process.env, AB_FILE: file, AB_NO_SERVER: "1" } });
const read = (): Board => {
  const s = readFileSync(file, "utf8");
  return JSON.parse(s.slice(s.indexOf(A) + A.length, s.indexOf(Z)));
};
const at = new Date().toISOString();
const seed = (b: Partial<Board>) =>
  writeFileSync(file, `export const board = ${A}\n${JSON.stringify({ updated_at: at, decisions: [], glance: { waiting: [], tickets: [], others: [] }, ...b })}\n${Z};\n`);
const card = (options: { id: string; label: string }[]) => ({
  id: "plan-x",
  title: "Missing PTO entry plan",
  context: "Engineer wrote the missing PTO entry plan and has nine questions for you to answer.",
  question: "How do you want to answer the missing PTO entry plan questions?",
  what_happens_after: "I pass your answers to Engineer.",
  options,
});

describe("no bulk accept (t103u)", () => {
  it("ab raise refuses a bulk-accept option or a (pick) label", () => {
    seed({});
    for (const label of ["Accept all 9 of Engineer's picks", "Take the recommendations", "Accept all recommendations", "Yes, do it (pick)"]) {
      const r = ab(["raise", JSON.stringify(card([{ id: "a", label }, { id: "b", label: "I'll answer each one under Details" }]))]);
      expect(r.status, label).not.toBe(0);
      expect(r.stdout + r.stderr).toMatch(/bulk accept or marks a pick/);
    }
    expect(ab(["raise", JSON.stringify(card([{ id: "b", label: "I'll answer each one under Details" }, { id: "c", label: "Have Engineer rework the plan" }]))]).status).toBe(0);
  });

  it("ab reply refuses them; ab lint flags old ones; drop-bulk-options cleans them up", () => {
    seed({
      decisions: [{ ...card([{ id: "all", label: "Accept all 5 of Engineer's picks" }, { id: "each", label: "I'll answer each one" }]), created_at: at } as Board["decisions"][number]],
      details: { "ticket:PROJ-1": { thread: [{ at, from: "bot", text: "x", question: { id: "q", text: "Q4: guard?", options: [{ id: "o1", label: "Check only (pick)" }, { id: "o2", label: "Hard stop" }] } }] } },
    });
    expect(ab(["reply", "ticket:PROJ-1", "Q5?", "--question", "Q5: undo?", "--option", "Final (pick)", "--option", "Reversible"]).status).toBe(2);
    expect(ab(["lint"]).status).toBe(1);
    expect(ab(["drop-bulk-options"]).status).toBe(0);
    const b = read();
    expect(b.decisions[0].options.map((o) => o.label)).toEqual(["I'll answer each one"]);
    expect(b.details!["ticket:PROJ-1"].thread![0].question!.options.map((o) => o.label)).toEqual(["Check only", "Hard stop"]);
  });

  it("ab already-answered closes a plan question with his words and notes it on the item; supersede hides a thread question", () => {
    seed({
      details: {
        "ticket:PROJ-2": {
          questions: [{ id: "Q1", question: "One PR?" }, { id: "Q2", question: "Undo?" }],
          thread: [{ at, from: "bot", text: "x", question: { id: "old", text: "Q3: old", options: [{ id: "o1", label: "A" }, { id: "o2", label: "B" }] } }],
        },
      },
    });
    expect(ab(["already-answered", "ticket:PROJ-2", "Q1", "--quote", "I think one PR is the way to go", "--source", "time off plan Q2"]).status).toBe(0);
    expect(ab(["already-answered", "ticket:PROJ-2", "Q2", "--superseded-by", "time off plan Q5"]).status).toBe(0);
    expect(ab(["supersede", "ticket:PROJ-2", "old"]).status).toBe(0);
    const d = read().details!["ticket:PROJ-2"];
    expect(d.questions![0].answered).toMatchObject({ text: "I think one PR is the way to go", source: "time off plan Q2" });
    expect(d.questions![1].superseded_by).toBe("time off plan Q5");
    expect(d.thread![0].question!.superseded_by).toBe("superseded");
    expect(d.thread!.map((e) => e.text)).toContain('Q1: You already answered this: "I think one PR is the way to go" (time off plan Q2)');
  });

  it("plan questions show the pick as a hint, one question at a time, nothing preselected", () => {
    render(
      <ItemDetails
        detail={{ questions: [{ id: "Q1", question: "One PR?", recommendation: "Yes, one PR" }, { id: "Q2", question: "Old", answered: { text: "use constants", source: "your note" } }] }}
        actions={[]}
        onSend={async () => true}
      />,
    );
    expect(screen.getByText("Engineer suggests:")).toBeTruthy();
    expect(screen.getByText(/You already answered this: "use constants"/)).toBeTruthy();
    const labels = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(labels.filter((l) => /accept all|all .*picks|recommendations|\(pick\)/i.test(l))).toEqual([]);
    expect(document.querySelectorAll("input:checked, [aria-pressed='true']").length).toBe(0);
  });

  it("no source file builds a bulk-accept option or a (pick) label", () => {
    const src = join(process.cwd(), "src");
    const files = readdirSync(src).filter((f) => /\.(tsx?|mjs)$/.test(f)).map((f) => join(src, f));
    const hits = [...files, join(process.cwd(), "..", "bin/ab.mjs")].flatMap((f) =>
      readFileSync(f, "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).filter((l) => /["'`](?:Accept|Take) all\b|of Engineer's picks|\(pick\)["'`]/.test(l) && !/BULK|test\(|RE\b|\/\\\(pick/.test(l)).map((l) => `${f}: ${l.trim()}`),
    );
    expect(hits).toEqual([]);
  });
});
