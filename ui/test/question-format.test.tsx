// @vitest-environment jsdom
// t111u / t112u: every question carries a short plain-words context paragraph shown above its options, cards can be
// rich (tables, underline, highlight, colored callouts) and can carry a sanitized SVG diagram (ab reply --svg).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Markdown } from "../src/markdown";
import type { Board } from "../src/data/types";

const A = "/* BOARD-JSON-START */";
const Z = "/* BOARD-JSON-END */";
const dir = mkdtempSync(join(tmpdir(), "ab-qfmt-"));
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

describe("question context (t111u)", () => {
  it("ab reply --question needs a short --context, and stores it on the question", () => {
    seed({});
    const q = ["reply", "ticket:ROWS-1", "Plan update", "--question", "Q4: overdraw guard?", "--option", "Check only", "--option", "Hard stop too"];
    expect(ab(q).stderr).toMatch(/needs --context/);
    expect(ab([...q, "--context", "x".repeat(701)]).stderr).toMatch(/700 or fewer/);
    expect(ab([...q, "--context", "Banks can dip a little below zero. Should we also add a hard floor?"]).status).toBe(0);
    expect(read().details!["ticket:ROWS-1"].thread![0].question!.context).toBe("Banks can dip a little below zero. Should we also add a hard floor?");
  });

  it("ab lint flags an open question with no context; answered or superseded ones are fine", () => {
    seed({
      details: {
        "ticket:ROWS-2": {
          questions: [{ id: "Q1", question: "A?" }, { id: "Q2", question: "B?", answered: { text: "yes", source: "note" } }],
          thread: [{ at, from: "bot", text: "x", question: { id: "old", text: "C?", options: [{ id: "o1", label: "Y" }, { id: "o2", label: "N" }], superseded_by: "new" } }],
        },
      },
    });
    const r = ab(["lint"]);
    expect(r.status).toBe(1);
    const failing = JSON.parse(r.stdout).failing.find((f: { id: string }) => f.id === "ticket:ROWS-2");
    expect(failing.problems).toEqual([expect.stringMatching(/plan question Q1 has no short context/)]);
  });

  it("ab reply --svg stores a sanitized SVG: no scripts, handlers or outside links", () => {
    seed({});
    const svg = join(dir, "bank.svg");
    writeFileSync(svg, '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><a href="https://evil.test"><rect width="10" height="10" onclick="x()"/></a><foreignObject><div>hi</div></foreignObject><text>Bank</text></svg>');
    const r = ab(["reply", "ticket:ROWS-3", "Here is the picture", "--svg", svg, "--alt", "Bank going below the limit"]);
    expect(r.status).toBe(0);
    const e = read().details!["ticket:ROWS-3"].thread![0];
    expect(e.image).toMatch(/^\/replies\/.*\.svg$/);
    const out = join(dir, "app/public", e.image!);
    expect(existsSync(out)).toBe(true);
    const clean = readFileSync(out, "utf8");
    expect(clean).toContain("<text>Bank</text>");
    expect(clean).not.toMatch(/script|onload|onclick|evil\.test|foreignObject/i);
    writeFileSync(join(dir, "not.svg"), "hello");
    expect(ab(["reply", "ticket:ROWS-3", "x", "--svg", join(dir, "not.svg")]).status).toBe(2);
  });
});

describe("rich markdown (t112u)", () => {
  it("renders tables, underline, highlight and colored callouts as elements, never raw HTML", () => {
    const { container } = render(
      <Markdown
        text={"| Bank | Hours |\n| --- | --- |\n| PTO | -2 |\n\n++underlined++ and <u>also</u> and ==hot== and *fun*\n\n> [!JOKE] Banks going negative: relatable.\n\n> [!WARNING] Hard stop missing.\n\n<img src=x onerror=alert(1)>"}
      />,
    );
    expect(container.querySelector("table td")?.textContent).toBe("PTO");
    expect([...container.querySelectorAll("u")].map((u) => u.textContent)).toEqual(["underlined", "also"]);
    expect(container.querySelector("mark")?.textContent).toBe("hot");
    expect(container.querySelector(".callout-joke")?.textContent).toBe("Banks going negative: relatable.");
    expect(container.querySelector(".callout-warning")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
  });
});
