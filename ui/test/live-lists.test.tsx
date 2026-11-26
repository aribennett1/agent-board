// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MyPrs, MyTickets, OthersPrs } from "../src/LiveLists";
import { counts, groupMine, groupOthers, groupTickets, linesChanged, mineNeedsAttention, readyToApprove, type FeedPr, type FeedTicket } from "../src/liveLists";

afterEach(cleanup);

const pr = (n: number, extra: Partial<FeedPr> = {}): FeedPr => ({
  repo: "rows-backend", number: n, title: `PR ${n}`, link: `https://github.com/ROWSHR/rows-backend/pull/${n}`, author: "sam", who: "Involves you",
  state: "ready", ci: "passing", checks: { passed: 15, failed: 0, pending: 0, failing: [] }, reviews: 1,
  labels: [{ name: "Ready For Review!", color: "0e8a16" }], comments: 7, additions: 120, deletions: 30, files: 4, unresolved_count: 0, unresolved: [],
  branch: "feat", base: "dev", body: "Adds the **thing**.", updated_at: new Date().toISOString(), ...extra,
});
const ticket = (id: string, status: string, extra: Partial<FeedTicket> = {}): FeedTicket => ({ id, title: `T ${id}`, status, link: `https://linear.app/x/${id}`, priority: 2, priority_label: "High", project: "Payroll", labels: [{ name: "BE" }], prs: [], ...extra });
const ok = { fetched_at: "2026-11-26T17:41:00.000Z", github: { ok: true }, linear: { ok: true, configured: true } };

describe("grouping", () => {
  it("My PRs: needs attention (changes requested, failing checks, comments for you), then in review, then drafts", () => {
    const items = [pr(1), pr(2, { state: "changes requested" }), pr(3, { ci: "failing" }), pr(4, { unresolved_count: 2 }), pr(5, { state: "draft", ci: "failing" })];
    expect(groupMine(items).map((g) => [g.key, g.items.map((p) => p.number)])).toEqual([["needs", [2, 3, 4]], ["review", [1]], ["draft", [5]]]);
    expect(mineNeedsAttention(pr(5, { state: "draft", ci: "failing" }))).toBe(false);
    expect(counts({ tickets: [], mine: items, others: [] }).mineNeeds).toBe(3);
  });

  it("Others' PRs: review requests first, then the rest, then drafts, with Ready to approve only when it is safe", () => {
    const items = [pr(1), pr(2, { who: "Your review requested" }), pr(3, { state: "draft" })];
    expect(groupOthers(items).map((g) => [g.key, g.items.map((p) => p.number)])).toEqual([["asked", [2]], ["involved", [1]], ["draft", [3]]]);
    expect(readyToApprove(pr(2))).toBe(true);
    expect(readyToApprove(pr(2, { ci: "failing" }))).toBe(false);
    expect(readyToApprove(pr(2, { unresolved_count: 1 }))).toBe(false);
    expect(readyToApprove(pr(2, { state: "changes requested" }))).toBe(false);
  });

  it("tickets group by Linear status in the order given", () => {
    expect(groupTickets([ticket("A-1", "In Progress"), ticket("A-2", "In Progress"), ticket("A-3", "Todo")]).map((g) => [g.title, g.items.length])).toEqual([["In Progress", 2], ["Todo", 1]]);
  });
  it("formats lines changed", () => expect(linesChanged({ additions: 927, deletions: 75 })).toBe("+927 \u221275"));
});

describe("rows", () => {
  it("a PR row shows labels, comment count, +/-, files, checks and review state, with the description collapsed under a chevron", () => {
    render(<OthersPrs items={[pr(9, { who: "Your review requested", unresolved_count: 2, unresolved: [{ author: "ann", path: "a.php", body: "Rename this", url: "https://github.com/x" }] })]} meta={ok} />);
    const row = document.querySelector<HTMLElement>('[data-pr="rows-backend/9"]')!;
    expect(within(row).getByText("PR 9")).toBeTruthy();
    expect(within(row).getByText("Ready For Review!")).toBeTruthy();
    expect(within(row).getByText("7 comments")).toBeTruthy();
    expect(within(row).getByText("2 unresolved")).toBeTruthy();
    expect(row.querySelector(".diff")?.textContent).toBe("+120 \u221230");
    expect(within(row).getByText("4 files")).toBeTruthy();
    expect(within(row).getByText("passing")).toBeTruthy();
    expect(within(row).getByText("sam")).toBeTruthy();
    expect(within(row).getByText("Your review requested")).toBeTruthy();
    expect(within(row).getByText("rows-backend #9")).toBeTruthy();
    expect(row.querySelector(".live-body")).toBeNull();
    expect(screen.queryByText("thing")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Expand" }));
    expect(row.querySelector(".live-desc strong")?.textContent).toBe("thing");
    expect(within(row).getByText("Rename this")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Collapse" }));
    expect(row.querySelector(".live-body")).toBeNull();
  });

  it("My PRs lists failing checks and the comments left for him", () => {
    render(<MyPrs items={[pr(3, { ci: "failing", checks: { passed: 13, failed: 1, pending: 0, failing: ["test"] }, unresolved_count: 1, unresolved: [{ author: "bo", path: "b.php", body: "Fix the null case", url: "" }] })]} meta={ok} />);
    expect(screen.getByRole("region", { name: "Needs your attention" })).toBeTruthy();
    const row = document.querySelector<HTMLElement>('[data-pr="rows-backend/3"]')!;
    expect(within(row).getByText("1 failing")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "Expand" }));
    expect(within(row).getByText(/Failing checks: test/)).toBeTruthy();
    expect(within(row).getByText("Comments left for you to address (1)")).toBeTruthy();
    expect(within(row).getByText("Fix the null case")).toBeTruthy();
  });

  it("a ticket row shows its Linear status, priority, project, labels and linked PRs under a status heading", () => {
    render(<MyTickets items={[ticket("ROWS-1", "In Review", { prs: ["https://github.com/ROWSHR/rows-backend/pull/12"] })]} meta={ok} />);
    expect(screen.getByRole("region", { name: "In Review" })).toBeTruthy();
    const row = document.querySelector<HTMLElement>('[data-ticket="ROWS-1"]')!;
    expect(within(row).getByText("High")).toBeTruthy();
    expect(row.querySelector(".status-pill")?.textContent).toBe("In Review");
    expect(within(row).getByText("Payroll")).toBeTruthy();
    expect(within(row).getByText("BE")).toBeTruthy();
    expect(within(row).getByText("PR rows-backend #12")).toBeTruthy();
    expect(within(row).getByRole("link", { name: "T ROWS-1" }).getAttribute("href")).toBe("https://linear.app/x/ROWS-1");
  });

  it("says what is wrong when a source is down, or when Linear has no key", () => {
    const { rerender } = render(<MyTickets items={[]} meta={{ github: { ok: true }, linear: { ok: false, configured: false } }} />);
    expect(screen.getByRole("status").textContent).toMatch(/LINEAR_API_KEY/);
    rerender(<MyPrs items={[]} meta={{ github: { ok: false, error: "gh: HTTP 504" }, linear: { ok: true, configured: true } }} />);
    expect(screen.getByRole("status").textContent).toMatch(/GitHub fetch failed: gh: HTTP 504/);
    expect(screen.getByText("No open PRs of yours.")).toBeTruthy();
  });
});
