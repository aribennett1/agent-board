// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, ReviewDraft } from "../src/data/types";
import { draftSummary } from "../src/ReviewDrafts";
import { itemStatus } from "../src/itemStatus";

// A review request whose only open draft comment carries Eric's note to QA (pending_bot): QA owes the rewrite.
const note = { at: "2026-11-26T21:21:22.960Z", note: "Can we read the name from Slack instead?" };
const draft = (comments: ReviewDraft["comments"]): ReviewDraft => ({ repo: "rows-backend", pr: 1986, verdict: "2 to post", comments });
const posted = { id: "c1", severity: "medium" as const, path: "tests/A.php", line: 1159, body: "Posted one.", status: "posted" as const };
const parked = { id: "c3", severity: "medium" as const, path: "app/Logging/SlackAlertHandler.php", line: 845, body: "Channel note.", status: "pending" as const, pending_bot: note };
const open = { id: "c4", severity: "low" as const, path: "app/B.php", line: 3, body: "Ready to post.", status: "pending" as const };

vi.mock("../src/data/board", () => ({
  board: {
    updated_at: "2026-11-27T09:00:00.000Z",
    decisions: [],
    glance: {
      waiting: [],
      tickets: [],
      others: [{ title: "Make Slack log alerts useful", author: "zedatrix", who: "Your review requested", link: "https://github.com/ROWSHR/rows-backend/pull/1986" }],
    },
    reviews: [
      {
        repo: "rows-backend",
        pr: 1986,
        verdict: "2 to post",
        comments: [
          { id: "c1", severity: "medium", path: "tests/A.php", line: 1159, body: "Posted one.", status: "posted" },
          { id: "c3", severity: "medium", path: "app/Logging/SlackAlertHandler.php", line: 845, body: "Channel note.", status: "pending", pending_bot: { at: "2026-11-26T21:21:22.960Z", note: "Can we read the name from Slack instead?" } },
        ],
      },
    ],
  } satisfies Board,
}));

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.stubEnv("ACTION_BOARD_WEBHOOK_CONFIGURED", "");
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a review draft he sent a note on waits on QA, not on him", () => {
  it("counts parked comments as waiting, not as his to answer", () => {
    expect(draftSummary(draft([posted, parked]), {})).toEqual({ label: "With QA", done: false, pending: 0, waiting: 1 });
    expect(draftSummary(draft([posted, parked, open]), {})).toEqual({ label: "1 to answer", done: false, pending: 1, waiting: 1 });
    expect(draftSummary(draft([posted]), {})).toEqual({ label: "Done", done: true, pending: 0, waiting: 0 });
  });

  it("keeps the row out of Needs you while QA owes the rewrite, and back in once a comment is his to post", () => {
    expect(itemStatus({ kind: "pr", reviewRequested: true, pendingDrafts: 0, waitingDrafts: 1 })).toEqual({ needs: false, reason: "Waiting on QA" });
    expect(itemStatus({ kind: "pr", reviewRequested: true, detail: { approval: "ready" }, pendingDrafts: 0, waitingDrafts: 1 })).toEqual({ needs: false, reason: "Waiting on QA" });
    expect(itemStatus({ kind: "pr", reviewRequested: true, pendingDrafts: 1, waitingDrafts: 1 })).toEqual({ needs: true, reason: "1 draft comment to post" });
  });

  it("Home's review list shows the row as Waiting on QA under In progress, with no Needs-you count", async () => {
    const { default: Tabs } = await import("../src/Tabs");
    render(<Tabs />);
    expect(screen.getByRole("heading", { name: "Reviews waiting for your yes" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Reviews waiting for your yes\s+\d/ })).toBeNull();
    expect(screen.getByText("Nothing needs you here")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /In progress, not ready yet \(1\)/ }));
    const row = screen.getByText("Make Slack log alerts useful").closest("li")!;
    expect(row.textContent).toContain("Waiting on QA");
    expect(row.textContent).toContain("With QA");
    expect(row.textContent).not.toMatch(/to post|to answer/);
  });
});
