// @vitest-environment jsdom
// Dr. Eggbot tab: ab eggbot posts findings, the tab lists them, Home does not, answers use decision.answered.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, Decision } from "../src/data/types";

const A = "/* BOARD-JSON-START */";
const Z = "/* BOARD-JSON-END */";
const dir = mkdtempSync(join(tmpdir(), "ab-eggbot-"));
const file = join(dir, "app/src/data/board.ts");
mkdirSync(join(dir, "app/src/data"), { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const AB = join(process.cwd(), "..", "bin/ab.mjs");
const ab = (args: string[]) => spawnSync("node", [AB, ...args], { encoding: "utf8", env: { ...process.env, AB_FILE: file, AB_NO_SERVER: "1" } });
const read = (): Board => {
  const s = readFileSync(file, "utf8");
  return JSON.parse(s.slice(s.indexOf(A) + A.length, s.indexOf(Z)));
};
const at = "2026-11-24T23:00:00.000Z";
const seed = (b: Partial<Board>) =>
  writeFileSync(file, `export const board = ${A}\n${JSON.stringify({ updated_at: at, decisions: [], glance: { waiting: [], tickets: [], others: [] }, ...b })}\n${Z};\n`);

const finding = {
  id: "eggbot-sample-finding",
  title: "Engineer skipped the context paragraph",
  context: "Dr. Eggbot audited Engineer against the question format rules. One finding is ready for you to accept or change.",
  bot: "Engineer",
  rule: "Every question needs a short context paragraph.",
  seen: "On a ticket question, Engineer posted with no context paragraph.",
  proposed_fix: "Refuse a question with no context, and re-ask that one with a short paragraph.",
  question: "Apply this Engineer fix?",
  what_happens_after: "If you apply the fix, the profile is updated as proposed. If you do not, Engineer stays as is.",
  options: [
    { id: "apply", label: "Apply it" },
    { id: "dont", label: "Don't apply" },
    { id: "change", label: "Change it" },
  ],
};

describe("ab eggbot", () => {
  it("posts a finding to section eggbot and lists it in eggbot_open, not open_on_board", () => {
    seed({});
    const r = ab(["eggbot", JSON.stringify(finding)]);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ ok: true, card: { section: "eggbot", decision_id: "eggbot-sample-finding", bot: "Engineer" } });
    expect(out.card.footer).toMatch(/#eggbot/);
    const d = read().decisions[0];
    expect(d.section).toBe("eggbot");
    expect(d.rule).toBe(finding.rule);
    const check = JSON.parse(ab(["check"]).stdout);
    expect(check.ok).toBe(true);
    expect(check.open_on_board).toEqual([]);
    expect(check.eggbot_open).toEqual(["eggbot-sample-finding"]);
    expect(ab(["lint"]).status).toBe(0);
  });

  it("refuses a missing bot, a bro word, an apply-all option, and ab raise of an eggbot field", () => {
    seed({});
    const { bot: _b, ...noBot } = finding;
    expect(ab(["eggbot", JSON.stringify(noBot)]).status).toBe(2);
    const bro = ab(["eggbot", JSON.stringify({ ...finding, id: "eggbot-bro-word", rule: "Talk to Eric, bro, in plain words." })]);
    expect(bro.status).toBe(2);
    expect(bro.stderr).toMatch(/bro/i);
    expect(ab(["eggbot", JSON.stringify({ ...finding, options: [...finding.options, { id: "all", label: "Apply all" }] })]).stderr).toMatch(/bulk accept/);
    expect(ab(["raise", JSON.stringify({ ...finding, context: finding.context, id: "home-card-x" })]).stderr).toMatch(/ab eggbot/);
  });

  it("stores a grouped fixes table and multi-select options", () => {
    seed({});
    const grouped = {
      id: "eggbot-audit-root-causes",
      title: "Root causes R1-R5 from today's audit",
      context: "Dr. Eggbot audited Engineer and QA against your rules today. Five root causes sat underneath the repeated questions.",
      bot: "Engineer and QA",
      rule: "Root causes behind today's board and profile drift",
      question: "Which of these root-cause fixes should be applied?",
      what_happens_after: "Picked rows are applied; the rest stay. Apply none leaves the bots as they are.",
      multiSelect: true,
      fixes: [
        { id: "R1", seen: "The nickname slipped into a heading.", proposed: "Never write that nickname; rename the heading." },
        { id: "R2", seen: "The profile still said plan it.", proposed: "Decide remaining plan questions yourself." },
      ],
      options: [
        { id: "r1", label: "R1" },
        { id: "r2", label: "R2" },
        { id: "none", label: "Apply none" },
        { id: "change", label: "Change something" },
      ],
    };
    expect(ab(["eggbot", JSON.stringify(grouped)]).status, ab(["eggbot", JSON.stringify(grouped)]).stderr).toBe(0);
    const d = read().decisions.find((x) => x.id === "eggbot-audit-root-causes")!;
    expect(d.multiSelect).toBe(true);
    expect(d.fixes?.map((f) => f.id)).toEqual(["R1", "R2"]);
    expect(ab(["lint"]).status).toBe(0);
  });

  it("stores a sanitized svg diagram and refuses a non-SVG", () => {
    seed({});
    const dirty = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><text>Roots</text></svg>';
    const r = ab(["eggbot", JSON.stringify({ ...finding, id: "eggbot-svg", svg: dirty })]);
    expect(r.status, r.stderr || r.stdout).toBe(0);
    const d = read().decisions.find((x) => x.id === "eggbot-svg")!;
    expect(d.svg).toContain("<svg");
    expect(d.svg).toContain("Roots");
    expect(d.svg).not.toMatch(/script|onload/i);
    expect(ab(["lint"]).status).toBe(0);
    expect(ab(["eggbot", JSON.stringify({ ...finding, id: "eggbot-not-svg", svg: "just a sketch" })]).status).toBe(2);
  });
});

const eggbotCard: Decision = {
  id: "eggbot-audit-engineer",
  card_ref: null,
  section: "eggbot",
  title: "Engineer profile fixes E1-E10",
  context: "The audit has ten proposed edits to Engineer's profile. Pick any that should go in.",
  bot: "Engineer",
  rule: "Engineer profile and memory, against current rules",
  question: "Which of these Engineer profile fixes should be applied?",
  what_happens_after: "Picked rows are applied.",
  multiSelect: true,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><text x="8" y="24">Pick a fix</text></svg>',
  fixes: [
    { id: "E1", seen: "The nickname showed up in board text.", proposed: "Never write that nickname, including in headings." },
    { id: "E2", seen: "GitHub writes were not tightly gated.", proposed: "Never write to GitHub without explicit OK." },
  ],
  options: [
    { id: "e1", label: "E1" },
    { id: "e2", label: "E2" },
    { id: "none", label: "Apply none" },
    { id: "change", label: "Change something" },
  ],
  created_at: at,
};
const homeCard: Decision = {
  id: "single",
  card_ref: null,
  title: "Ship the billing banner",
  question: "Ship the billing banner?",
  context: "The billing banner is ready to ship on the website.",
  what_happens_after: "It ships.",
  options: [{ id: "yes", label: "Yes" }, { id: "no", label: "Hold" }],
  created_at: at,
};

vi.mock("../src/data/board", () => ({
  board: {
    updated_at: at,
    decisions: [eggbotCard, homeCard],
    glance: { waiting: [], tickets: [], others: [] },
  } satisfies Board,
}));

let posted: Record<string, unknown>[];
beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  posted = [];
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", "http://hook.test/assistant");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "http://hook.test/assistant") {
        posted.push(JSON.parse(String(init?.body)));
        return new Response("ok", { status: 200 });
      }
      return new Response(null, { status: 204 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Dr. Eggbot tab", () => {
  it("lists the tab, keeps findings off Home, and includes them in Needs-you counts", async () => {
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
    const nav = screen.getByRole("navigation", { name: "Views" });
    const item = (view: string) => nav.querySelector<HTMLButtonElement>(`[data-view="${view}"]`)!;
    expect([...nav.querySelectorAll(".nav-item")].map((b) => b.getAttribute("data-view"))).toContain("eggbot");
    expect(item("eggbot").textContent).toMatch(/Dr\. Eggbot/);
    expect(item("eggbot").querySelector(".nav-count")?.textContent).toBe("1");
    expect(item("conversation").querySelector(".nav-count")?.textContent).toBe("2");
    expect(item("home").querySelector(".nav-count")?.textContent).toBe("1");

    fireEvent.click(item("home"));
    expect(document.querySelector('[data-decision-id="eggbot-audit-engineer"]')).toBeNull();
    expect(document.querySelector('[data-decision-id="single"]')).not.toBeNull();

    fireEvent.click(item("eggbot"));
    expect(window.location.hash).toBe("#eggbot");
    expect(screen.getByRole("heading", { name: "Dr. Eggbot" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Needs you\s*1/ })).toBeTruthy();
    const card = document.querySelector<HTMLElement>('[data-decision-id="eggbot-audit-engineer"]')!;
    expect(card.getAttribute("data-section")).toBe("eggbot");
    expect(within(card).getByText("Engineer")).toBeTruthy();
    expect(within(card).getByRole("columnheader", { name: "What was seen" })).toBeTruthy();
    expect(within(card).getByText("The nickname showed up in board text.")).toBeTruthy();
    expect(card.querySelector(".card-diagram svg")).toBeTruthy();
    expect(within(card).getByText("Pick a fix")).toBeTruthy();
    const e1 = within(card).getByRole("button", { name: "E1" });
    expect(e1.getAttribute("aria-pressed")).toBe("false");
    expect(within(card).queryByRole("button", { name: /apply all/i })).toBeNull();
    expect(within(card).getAllByRole("img", { name: /Voice typing/ }).length).toBeGreaterThan(0);

    fireEvent.click(e1);
    fireEvent.click(within(card).getByRole("button", { name: "E2" }));
    expect(e1.getAttribute("aria-pressed")).toBe("true");
    const send = within(card).getAllByRole("button", { name: "Send to Grok Bot" }).find((b) => b.getAttribute("type") !== "submit")!;
    fireEvent.click(send);
    await act(async () => {});
    expect(posted.at(-1)).toMatchObject({ event: "decision.answered", decision_id: "eggbot-audit-engineer", answer: ["e1", "e2"] });
  });
});
