// @vitest-environment jsdom
// A review request is not "Ready to approve" just because checks are green. The row shows at most one approval chip.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";

const state = vi.hoisted(() => ({ board: undefined as unknown }));
vi.mock("../src/data/board", () => ({
  get board() {
    return state.board;
  },
}));

const pr = (n: number, title: string, who: string) => ({
  title,
  author: "zedatrix",
  who,
  link: `https://github.com/ROWSHR/rows-backend/pull/${n}`,
});

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/#reviews");
  vi.resetModules();
  vi.stubEnv("ACTION_BOARD_WEBHOOK_URL", "");
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function renderApp(board: Board) {
  state.board = board;
  const { default: App } = await import("../src/App");
  render(<App view="reviews" onSelect={() => {}} />);
}

const openInProgress = () => {
  for (const b of screen.queryAllByRole("button", { name: /In progress, not ready yet/ })) {
    if (b.getAttribute("aria-expanded") === "false") fireEvent.click(b);
  }
};

describe("review approval chips", () => {
  it("parks a green review request with no draft as Review running, with no Ready-to-approve chip", async () => {
    await renderApp({
      updated_at: "2026-11-24T12:00:00.000Z",
      decisions: [],
      glance: { waiting: [], tickets: [], others: [pr(1880, "W-4 amounts missing after hire", "Your review requested")] },
      details: { "pr:rows-backend/1880": { approval: "ready" } },
    });
    expect(screen.getByText("Nothing needs you here")).toBeTruthy();
    expect(screen.queryByText("Ready to approve")).toBeNull();
    openInProgress();
    const row = screen.getByText("W-4 amounts missing after hire").closest("li")!;
    expect(within(row).getByText("Review running")).toBeTruthy();
    expect(row.querySelectorAll(".approval-chip")).toHaveLength(0);
    expect(row.querySelectorAll(".status-chip")).toHaveLength(1);
  });

  it("shows a single Ready-to-approve chip once the review is done and checks are green", async () => {
    await renderApp({
      updated_at: "2026-11-24T12:00:00.000Z",
      decisions: [],
      glance: { waiting: [], tickets: [], others: [pr(1880, "W-4 amounts missing after hire", "Your review requested")] },
      details: { "pr:rows-backend/1880": { approval: "ready" } },
      reviews: [{ repo: "rows-backend", pr: 1880, verdict: "lgtm", done: true, comments: [] }],
    });
    const row = screen.getByText("W-4 amounts missing after hire").closest("li")!;
    expect(within(row).getByText("Ready to approve")).toBeTruthy();
    expect(row.querySelectorAll(".approval-chip.ready, .approval-chip")).toHaveLength(1);
    expect(row.querySelectorAll(".status-chip")).toHaveLength(0);
    expect(screen.getByText("Needs you (1)")).toBeTruthy();
  });
});
