import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Board, Decision } from "../src/data/types";
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const AB = join(ROOT, "bin/ab.mjs");
const repo = mkdtempSync(join(tmpdir(), "ab-shape-"));
const file = join(repo, "app/src/data/board.ts");
mkdirSync(join(repo, "app/src/data"), { recursive: true });
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const A = "/* BOARD-JSON-START */";
const Z = "/* BOARD-JSON-END */";
const base = (): Decision => ({
  id: "ssn-match-path",
  title: "SSN match on an old row",
  card_ref: null,
  context: "An applicant SSN can match an old non-employee row.\n\nThe hire check then skips the not-eligible warning.",
  question: "What should happen when an SSN matches two employees?",
  what_happens_after: "Your answer goes to Planner word for word.",
  options: [
    { id: "a", label: "A: Block the hire" },
    { id: "b", label: "B: Merge into the oldest" },
  ],
  tier: "decision",
  estimate: "1 minute",
  created_at: "2026-11-25T22:00:00.000Z",
});
const seed = (d: Decision) => {
  const b: Board = { updated_at: "2026-11-25T22:00:00.000Z", decisions: [d], glance: { waiting: [], tickets: [], others: [] } };
  writeFileSync(file, `export const board = ${A}\n${JSON.stringify(b)}\n${Z};\n`);
};
const lint = () => {
  const r = spawnSync("node", [AB, "lint"], { encoding: "utf8", env: { ...process.env, AB_FILE: file, AB_NO_SERVER: "1" } });
  return { status: r.status, json: JSON.parse(r.stdout || "{}"), err: r.stderr };
};

describe("card shape lint", () => {
  it("flags a paragraph longer than about 3 lines", () => {
    const d = base();
    d.context = "An applicant SSN can match an old row. " + "The rest of this paragraph keeps going so it wraps well past three lines on the card and should be split into shorter bullets or sentences instead of one block. ".repeat(2);
    seed(d);
    const r = lint();
    expect(r.status).toBe(1);
    expect(JSON.stringify(r.json.failing)).toMatch(/3 lines or fewer/);
  });

  it("flags a relationship or flow decision that has no diagram", () => {
    seed(base());
    const r = lint();
    expect(r.status).toBe(1);
    expect(JSON.stringify(r.json.failing)).toMatch(/svg diagram/);
  });

  it("passes short bullets plus a safe svg on a flow decision", () => {
    const d = base();
    d.svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><text x="2" y="14">SSN match</text></svg>';
    seed(d);
    const r = lint();
    expect(r.json.failing ?? []).toEqual([]);
    expect(r.status).toBe(0);
  });
});
