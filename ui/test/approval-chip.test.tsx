// @vitest-environment jsdom
// A review request is not "Ready to approve" just because checks are green. The row shows at most one approval chip.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";

const state = vi.hoisted(() => ({ board: undefined as unknown }));
vi.mock("../src/data/board", () => ({
  get board() {
    return state.board;
  },
}));

const pr = (n: number, title: string, who: string, extra: Record<string, unknown> = {}) => ({
  repo: "app",
  number: n,
  title,
  author: "zedatrix",
  who,
  link: `https://github.com/example/app/pull/${n}`,
  state: "ready",
  ci: "passing",
  unresolved_count: 0,
  ...extra,
});

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/#others");
  vi.resetModules();
  vi.stubEnv("ACTION_BOARD_WEBHOOK_CONFIGURED", "");
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
  render(<App view="others" onSelect={() => {}} />);
}

describe("Ready to approve on Others' PRs", () => {
  it("shows one Ready-to-approve chip on a review request whose checks pass with nothing open", async () => {
    await renderApp({
      updated_at: "2026-11-24T12:00:00.000Z",
      decisions: [],
      glance: { waiting: [], tickets: [], others: [pr(1880, "W-4 amounts missing after hire", "Your review requested")] as never },
    });
    const row = screen.getByText("W-4 amounts missing after hire").closest("li")!;
    expect(within(row).getByText("Ready to approve")).toBeTruthy();
    expect(row.querySelectorAll(".approval-chip")).toHaveLength(1);
  });

  it("shows no chip when checks fail, comments are open, it is a draft, or it was not asked of you", async () => {
    await renderApp({
      updated_at: "2026-11-24T12:00:00.000Z",
      decisions: [],
      glance: {
        waiting: [],
        tickets: [],
        others: [
          pr(1, "Failing checks", "Your review requested", { ci: "failing" }),
          pr(2, "Open comments", "Your review requested", { unresolved_count: 2 }),
          pr(3, "A draft", "Your review requested", { state: "draft" }),
          pr(4, "Not asked", "Involves you"),
        ] as never,
      },
    });
    expect(screen.queryByText("Ready to approve")).toBeNull();
  });
});
