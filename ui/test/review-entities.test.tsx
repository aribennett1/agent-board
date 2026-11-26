// @vitest-environment jsdom
// Review comment bodies are raw Markdown. A body that arrived with HTML entities (`-&gt;`) must show and post as `->`,
// and `ab reviews` must store the raw characters.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";
import { decodeEntities, postText } from "../src/entities";

const HOOK = "http://hook.test/assistant";
const ENCODED = "Calls `$employee-&gt;loadMissing()` when a &lt;row&gt; has &quot;notes&quot; &amp; it&#39;s noted.\n\n```suggestions\n$a-&gt;b();\n```";
const RAW = "Calls `$employee->loadMissing()` when a <row> has \"notes\" & it's noted.\n\n```suggestion\n$a->b();\n```";

vi.mock("../src/data/board", () => ({
  board: {
    updated_at: "2026-11-10T09:00:00.000Z",
    decisions: [],
    glance: {
      waiting: [],
      tickets: [],
      others: [{ title: "Rotation notes", author: "alex", who: "Your review requested", link: "https://github.com/ROWSHR/rows-backend/pull/1987" }],
    },
    reviews: [
      {
        repo: "rows-backend",
        pr: 1987,
        verdict: "Comment",
        comments: [{ id: "c1", severity: "low", title: "Hoist -&gt; loop", path: "a.php", line: 66, body: ENCODED, status: "pending" }],
      },
    ],
  } satisfies Board,
}));

let posted: Record<string, unknown>[];
beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  window.location.hash = "#reviews";
  posted = [];
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", HOOK);
  vi.stubEnv("ACTION_BOARD_WEBHOOK_AUTH", "Bearer test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url === HOOK) {
        posted.push(JSON.parse(String(init.body)));
        return new Response("ok", { status: 200 });
      }
      if (url === "/__ab/delivery-log") return new Response(null, { status: 204 });
      throw new Error("no network in tests");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("review comment entities", () => {
  it("decodes the common entities once", () => {
    expect(postText(ENCODED)).toBe(RAW);
    expect(postText("  ```suggestions\nx\n  ```")).toBe("  ```suggestion\nx\n  ```");
    expect(postText("```suggestion\nx\n```")).toBe("```suggestion\nx\n```");
    expect(decodeEntities("&amp;gt;")).toBe("&gt;");
    expect(decodeEntities("a -> b")).toBe("a -> b");
  });

  it("shows and posts raw characters", async () => {
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
    fireEvent.click(screen.getAllByRole("button", { name: "Expand" })[0]);
    const comment = document.querySelector<HTMLElement>("[data-comment-id=c1]")!;
    expect(comment.textContent).toContain("$employee->loadMissing()");
    expect(comment.textContent).toContain("$a->b();");
    expect(comment.textContent).not.toMatch(/&(gt|lt|amp|quot|#39);/);

    fireEvent.click(within(comment).getByRole("button", { name: /Post to GitHub/ }));
    await act(async () => {});
    const p = posted.find((x) => x.event === "review.answer")!;
    expect(p.body).toBe(RAW);
    expect(p.edited).toBeUndefined();
  });

  it("posts edited text with raw characters", async () => {
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
    fireEvent.click(screen.getAllByRole("button", { name: "Expand" })[0]);
    const comment = document.querySelector<HTMLElement>("[data-comment-id=c1]")!;
    fireEvent.click(within(comment).getByRole("button", { name: "Edit" }));
    const box = within(comment).getByLabelText("Edit comment") as HTMLTextAreaElement;
    expect(box.value).toBe(RAW);
    fireEvent.change(box, { target: { value: "Use `$a-&gt;b()`\n\n```suggestions\n$a-&gt;b();\n```" } });
    fireEvent.click(within(comment).getByRole("button", { name: /Post edited/ }));
    await act(async () => {});
    const e = posted.filter((x) => x.event === "review.answer").at(-1)!;
    expect(e.text).toBe("Use `$a->b()`\n\n```suggestion\n$a->b();\n```");
  });

  it("ab reviews stores raw characters", () => {
    const root = join(process.cwd(), "..");
    const dir = mkdtempSync(join(tmpdir(), "ab-entities-"));
    const file = join(dir, "app/src/data/board.ts");
    mkdirSync(join(dir, "app/src/data"), { recursive: true });
    const A = "/* BOARD-JSON-START */";
    const Z = "/* BOARD-JSON-END */";
    writeFileSync(file, `export const board = ${A}\n${JSON.stringify({ updated_at: "2026-11-10T09:00:00.000Z", decisions: [], glance: { waiting: [], tickets: [], others: [] } })}\n${Z};\n`);
    try {
      const draft = { repo: "rows-backend", pr: 1987, verdict: "Comment", comments: [{ id: "c1", severity: "low", title: "a -&gt; b", path: "a.php", line: 66, body: ENCODED, status: "pending" }] };
      const r = spawnSync("node", [join(root, "bin/ab.mjs"), "reviews"], { input: JSON.stringify([draft]), encoding: "utf8", env: { ...process.env, AB_FILE: file, AB_NO_SERVER: "1" } });
      expect(r.status).toBe(0);
      const s = readFileSync(file, "utf8");
      const c = (JSON.parse(s.slice(s.indexOf(A) + A.length, s.indexOf(Z))) as Board).reviews![0].comments[0];
      expect(c.body).toBe(RAW);
      expect(c.title).toBe("a -> b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
