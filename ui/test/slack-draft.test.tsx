// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Decision } from "../src/data/types";
import { DecisionCard } from "../src/DecisionCard";
import { buildPayload } from "../src/delivery";

const TEXT = "This is Eric's bot posting on his behalf.\n\nThe review is done.";

const decision: Decision = {
  id: "qa-slack-rows-5207",
  kind: "slack_draft",
  title: "Slack message to #qa-reviews",
  card_ref: "https://linear.app/rows/issue/ROWS-5207/checkout-images",
  context: "QA finished the review and wants to post the result in the thread.",
  question: "Send this message to #qa-reviews?",
  what_happens_after: "If you send, QA posts this exact text to Slack once. If you don't, nothing is posted.",
  options: [],
  raised_by: "QA",
  created_at: "2026-11-26T20:00:00.000Z",
  slack: {
    channel_id: "C01234567",
    channel: "#qa-reviews",
    text: TEXT,
    thread_ts: "1732650000.123456",
    permalink: "https://rows.slack.com/archives/C01234567/p1732650000123456",
  },
};

afterEach(cleanup);

describe("Slack draft card", () => {
  it("shows the channel, a thread link, and the editable message, not the ordinary answer form", () => {
    render(<DecisionCard decision={decision} index={1} onAnswer={vi.fn()} />);
    expect(screen.getByText("#qa-reviews")).toBeTruthy();
    const thread = screen.getByRole("link", { name: "Open thread" }) as HTMLAnchorElement;
    expect(thread.href).toBe(decision.slack!.permalink);
    const box = screen.getByRole("textbox", { name: "Slack message" }) as HTMLTextAreaElement;
    expect(box.value).toBe(TEXT);
    expect(screen.getByRole("button", { name: "Send to Slack" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Don't send" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Your own answer" })).toBeNull();
  });

  it("Send to Slack uses the edited text and Don't send declines", () => {
    const onAnswer = vi.fn();
    render(<DecisionCard decision={decision} index={1} onAnswer={onAnswer} />);
    const box = screen.getByRole("textbox", { name: "Slack message" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: TEXT + "\nEdited." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to Slack" }));
    expect(onAnswer).toHaveBeenCalledWith(decision, { action: "send", text: TEXT + "\nEdited." });
    onAnswer.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Don't send" }));
    expect(onAnswer).toHaveBeenCalledWith(decision, { action: "decline" });
  });

  it("buildPayload carries action and the final text, including edits, plus to_bot", () => {
    const now = new Date("2026-11-26T20:05:00.000Z");
    const send = buildPayload(decision, { action: "send", text: TEXT + "\nEdited." }, now, "QA");
    expect(send).toMatchObject({
      event: "decision.answered",
      decision_id: "qa-slack-rows-5207",
      answer: "send",
      answer_label: "Send to Slack",
      action: "send",
      text: TEXT + "\nEdited.",
      to_bot: "QA",
    });
    const decline = buildPayload(decision, { action: "decline" }, now, "QA");
    expect(decline.action).toBe("decline");
    expect(decline.answer).toBe("decline");
    expect(decline.text).toBeUndefined();
    expect(decline.to_bot).toBe("QA");
  });
});
