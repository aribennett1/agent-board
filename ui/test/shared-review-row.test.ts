import { describe, expect, it } from "vitest";
import { commentStatus, draftSummary } from "../src/ReviewDrafts";
import { isFindingSettled } from "../src/reviewFindings";
import type { ReviewDraft } from "../src/data/types";

// A card finding and its Reviews-tab comment are one stored row (src/review-rows.ts); Post or Don't post on either
// sets answered on that row, so both views close.
describe("one shared review row", () => {
  const answered = { at: "2026-11-27T18:11:02.552Z", action: "post" as const };
  const draft: ReviewDraft = {
    repo: "rows-backend", pr: 1994, verdict: "1 low",
    comments: [{ id: "c3", severity: "low", path: "a.php", line: 849, body: "`updateQuietly()`", status: "pending", answered }],
  };

  it("the Reviews tab shows a comment answered on the card as sent to post, with no buttons left", () => {
    expect(commentStatus(draft, draft.comments[0], {})).toBe("posted");
    expect(draftSummary(draft, {}).done).toBe(true);
  });

  it("the card shows a finding answered on the Reviews tab as settled", () => {
    expect(isFindingSettled({ status: "pending", answered: { ...answered, action: "skip" } })).toBe(true);
    expect(isFindingSettled({ status: "pending" })).toBe(false);
  });
});
