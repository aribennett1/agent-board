// Nov 24: Eric does not want to be called "bro". ab lint flags the word on a card, reply or question
// (case-insensitive, whole word; "broken" is fine). ab reply --at rewrites an existing reply's text.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Board } from "../src/data/types";

const A = "/* BOARD-JSON-START */";
const Z = "/* BOARD-JSON-END */";
const dir = mkdtempSync(join(tmpdir(), "ab-no-bro-"));
const file = join(dir, "app/src/data/board.ts");
mkdirSync(join(dir, "app/src/data"), { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const AB = join(process.cwd(), "..", "bin/ab.mjs");
const ab = (args: string[]) => spawnSync("node", [AB, ...args], { encoding: "utf8", env: { ...process.env, AB_FILE: file, AB_NO_SERVER: "1" } });
const read = (): Board => {
  const s = readFileSync(file, "utf8");
  return JSON.parse(s.slice(s.indexOf(A) + A.length, s.indexOf(Z)));
};
const at = "2026-11-24T22:22:06.000Z";
const seed = (b: Partial<Board>) =>
  writeFileSync(file, `export const board = ${A}\n${JSON.stringify({ updated_at: at, decisions: [], glance: { waiting: [], tickets: [], others: [] }, ...b })}\n${Z};\n`);

describe("ab lint: no calling Eric bro", () => {
  it("flags the word on a card, a reply, a question and a plan, and ignores 'broken'", () => {
    seed({
      decisions: [
        {
          id: "c-bro",
          title: "Ship the banner",
          context: "Thanks bro, the billing banner is ready to ship.",
          question: "Ship the billing banner?",
          what_happens_after: "It ships.",
          options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }],
          card_ref: null,
          created_at: at,
        },
        {
          id: "c-ok",
          title: "Fix the broken test",
          context: "The login test is broken on dev and blocks the release.",
          question: "Merge the login test fix?",
          what_happens_after: "It merges.",
          options: [{ id: "y", label: "Yes" }, { id: "n", label: "Hold" }],
          card_ref: null,
          created_at: at,
        },
      ],
      details: {
        "mypr:rows-backend/1": {
          thread: [
            { at, from: "bot", text: "Got it bro: convert to UTC." },
            {
              at: "2026-11-24T22:22:07.000Z",
              from: "bot",
              text: "Need a call.",
              question: {
                id: "q1",
                text: "Bro, lock the row?",
                context: "A race can double-apply the hours.",
                options: [{ id: "o1", label: "Yes" }, { id: "o2", label: "No" }],
              },
            },
          ],
        },
        "ticket:ROWS-1": { plan: "# Ticket\n\n## 2. Bro summary\n\nWhen someone edits a deduction pay code, it waits." },
        "ticket:ROWS-2": { plan: "# Ticket\n\nThe import is broken until we patch it.", ticket: "Nothing broken on the happy path." },
      },
    });
    const r = ab(["lint"]);
    expect(r.status).toBe(1);
    const failing = Object.fromEntries(JSON.parse(r.stdout).failing.map((x: { id: string; problems: string[] }) => [x.id, x.problems]));
    expect(failing["c-bro"]).toEqual([expect.stringMatching(/context contains the word "bro"/)]);
    expect(failing["c-ok"]).toBeUndefined();
    expect(failing["mypr:rows-backend/1"]).toEqual([
      expect.stringMatching(/^reply contains the word "bro"$/),
      expect.stringMatching(/^question "Bro, lock the row\?" contains the word "bro"$/),
    ]);
    expect(failing["ticket:ROWS-1"]).toEqual([expect.stringMatching(/plan contains the word "bro"/)]);
    expect(failing["ticket:ROWS-2"]).toBeUndefined();
  });

  it("ab reply --at rewrites that reply and lint goes clean", () => {
    seed({
      details: {
        "mypr:rows-backend/1": {
          thread: [{ at, from: "bot", text: "Got it bro: convert to UTC." }],
        },
      },
    });
    expect(ab(["lint"]).status).toBe(1);
    const badAt = ab(["reply", "mypr:rows-backend/1", "--at", "1999-01-01T00:00:00.000Z", "Got it: convert to UTC."]);
    expect(badAt.status).toBe(2);
    const edit = ab(["reply", "mypr:rows-backend/1", "--at", at, "Got it: convert to UTC."]);
    expect(edit.status).toBe(0);
    expect(JSON.parse(edit.stdout)).toMatchObject({ ok: true, edited: true, at, key: "mypr:rows-backend/1" });
    expect(read().details!["mypr:rows-backend/1"].thread![0].text).toBe("Got it: convert to UTC.");
    expect(ab(["lint"]).status).toBe(0);
  });
});
