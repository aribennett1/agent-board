// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewDraft } from "../src/data/types";
import { ReviewDrafts } from "../src/ReviewDrafts";
import { FindingDraft } from "../src/ReviewFindingsBlock";
import { COLLAPSE_STORAGE_KEY } from "../src/collapse";

const draft: ReviewDraft = {
  repo: "rows-backend",
  pr: 2019,
  verdict: "Changes needed",
  comments: [
    { id: "c1", severity: "high", title: "Default is not built", path: "app/A.php", line: 141, body: "SKIPPED-BODY with `code`", status: "skipped", note: "Eric turned this down earlier" },
    { id: "c2", severity: "medium", title: "Naming", path: "app/B.php", line: 7, body: "OPEN-BODY", status: "pending" },
    { id: "c3", severity: "low", title: "Typo", path: "app/C.php", line: 3, body: "POSTED-BODY", status: "posted", url: "https://github.com/x/y/pull/1#c" },
  ],
} as ReviewDraft;

const view = () => render(<ReviewDrafts draft={draft} locals={{}} onReview={vi.fn(async () => true)} />);

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe("review comment chevrons", () => {
  it("starts skipped and posted comments collapsed to one line and open ones expanded", () => {
    view();
    expect(screen.queryByText(/SKIPPED-BODY/)).toBeNull();
    expect(screen.queryByText(/POSTED-BODY/)).toBeNull();
    expect(screen.getByText(/OPEN-BODY/)).toBeTruthy();
    const skipped = document.querySelector('[data-comment-id="c1"]')!;
    expect(skipped.textContent).toMatch(/high.*app\/A\.php:141.*Default is not built.*Skipped/);
    expect(skipped.querySelectorAll("button")).toHaveLength(1);
  });

  it("an expanded skipped comment has no answer boxes", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: /Expand comment on app\/A\.php:141/ }));
    expect(screen.getByText(/SKIPPED-BODY/)).toBeTruthy();
    const skipped = document.querySelector('[data-comment-id="c1"]')!;
    expect(skipped.querySelector("textarea")).toBeNull();
    expect(skipped.textContent).not.toMatch(/Send to assistant|Post to GitHub/);
  });

  it("collapses an open comment and remembers it in localStorage across a remount", () => {
    view();
    fireEvent.click(screen.getByRole("button", { name: /Collapse comment on app\/B\.php:7/ }));
    expect(screen.queryByText(/OPEN-BODY/)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(COLLAPSE_STORAGE_KEY)!)["review:rows-backend#2019:c2"]).toBe(true);
    cleanup();
    view();
    expect(screen.queryByText(/OPEN-BODY/)).toBeNull();
  });

  it("findings on a card get a chevron, and settled ones start collapsed", () => {
    const base = { n: 1, label: "#1 Foo", severity: "High", path: "app/A.php", line: 4, body: "FINDING-BODY" };
    const { rerender } = render(<FindingDraft cardId="card-1" finding={base} onAnswer={vi.fn(async () => true)} />);
    expect(screen.getByText(/FINDING-BODY/)).toBeTruthy();
    cleanup();
    render(<FindingDraft cardId="card-1" finding={{ ...base, status: "skipped", note: "turned down" }} onAnswer={vi.fn(async () => true)} />);
    expect(screen.queryByText(/FINDING-BODY/)).toBeNull();
    expect(screen.getByText(/Not posted: turned down/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Expand finding #1/ }));
    expect(screen.getByText(/FINDING-BODY/)).toBeTruthy();
    void rerender;
  });
});
