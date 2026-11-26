import { describe, expect, it } from "vitest";
import { commentDiff, isCommentEdit } from "../src/commentDiff";

describe("commentDiff", () => {
  it("highlights the changed line and hides the unchanged paragraphs", () => {
    const before = [
      "Your explanation stays the same.",
      "",
      "```suggestion",
      "// note in the box",
      "$overtimeSeconds = max(0, $entry->overtime_seconds - $entry->holiday_overridden_overtime_seconds);",
      "// another note",
      "```",
    ].join("\n");
    const after = [
      "Your explanation stays the same.",
      "",
      "```suggestion",
      "            $overtimeSeconds = max(0, $entry->overtime_seconds - $entry->holiday_overridden_overtime_seconds);",
      "```",
      "",
      "Or, better, drop the special case.",
    ].join("\n");
    const rows = commentDiff(before, after);
    expect(rows.some((r) => r.kind === "omit" && r.count >= 1)).toBe(true);
    const dels = rows.filter((r) => r.kind === "del").map((r) => r.segs.map((s) => s.text).join(""));
    const ins = rows.filter((r) => r.kind === "ins").map((r) => r.segs.map((s) => s.text).join(""));
    expect(dels.some((t) => t.includes("note in the box"))).toBe(true);
    expect(dels.some((t) => t.includes("another note"))).toBe(true);
    expect(ins.some((t) => t.includes("Or, better"))).toBe(true);
    expect(rows.some((r) => r.kind === "ins" && r.segs.some((s) => s.kind === "ins" && s.text.includes("            ")))).toBe(true);
  });

  it("keeps identical text visible instead of hiding the whole comment", () => {
    const rows = commentDiff("same line\nsecond", "same line\nsecond");
    expect(rows.every((r) => r.kind === "same")).toBe(true);
  });

  it("treats a card as an edit only when both current and new text are present", () => {
    expect(isCommentEdit({ current_text: "old", post_text: "new" })).toBe(true);
    expect(isCommentEdit({ post_text: "new" })).toBe(false);
    expect(isCommentEdit({ current_text: "old", post_text: null })).toBe(false);
  });
});
