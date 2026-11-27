// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewDraft } from "../src/data/types";
import { ReviewDrafts } from "../src/ReviewDrafts";
import { FindingDraft } from "../src/ReviewFindingsBlock";

const draft = {
  repo: "rows-backend",
  pr: 2004,
  verdict: "One finding",
  comments: [{ id: "c1", severity: "medium", path: "tests/A.php", line: 10, context: "STORY-FOR-ERIC", body: "What do you think about ASK-TEXT?", status: "pending" }],
} as ReviewDraft;

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe("drafted comment context", () => {
  it("shows the story as not posted, and Post sends only the body", async () => {
    const onReview = vi.fn(async () => true);
    render(<ReviewDrafts draft={draft} locals={{}} onReview={onReview} />);
    const block = document.querySelector(".comment-context-block")!;
    expect(block.textContent).toMatch(/For you, not posted.*STORY-FOR-ERIC/);
    expect(document.querySelector(".will-post-block")!.textContent).toMatch(/Will post.*ASK-TEXT/);
    expect(document.querySelector(".will-post-block")!.textContent).not.toMatch(/STORY/);
    fireEvent.click(screen.getByRole("button", { name: /Post to GitHub/ }));
    expect(onReview).toHaveBeenCalledWith(draft, draft.comments[0], "post", undefined);
  });

  it("a finding on a card shows its context apart from Will post", () => {
    render(<FindingDraft cardId="card-1" finding={{ n: 1, label: "#1 Foo", path: "app/A.php", line: 4, context: "CARD-STORY", body: "CARD-ASK" }} onAnswer={vi.fn(async () => true)} />);
    expect(document.querySelector(".comment-context-block")!.textContent).toMatch(/CARD-STORY/);
    expect(document.querySelector(".will-post-block")!.textContent).not.toMatch(/CARD-STORY/);
  });
});
