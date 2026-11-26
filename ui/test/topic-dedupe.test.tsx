// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Decision } from "../src/data/types";
import { Conversation, botTextCoveredByOpen, normCopy, openQuestionBody, summaryCoveredByBody } from "../src/Conversation";
import { buildTopics } from "../src/topics";

afterEach(cleanup);

const t = (minAgo: number) => new Date(Date.now() - minAgo * 60000).toISOString();

const context =
  "A manager requests a day of time off and leaves the start and end times blank. The form request skips the date check, and the server then builds 9:00 plus the standard day, which can run past midnight.";

const decision: Decision = {
  id: "engineer-pr-1838-default-range-2",
  title: "Default time off day can run past midnight",
  question: "What should happen when a blank default day would end after midnight?",
  context,
  what_happens_after: "I make the change and raise a push card.",
  options: [
    { id: "reject", label: "Reject" },
    { id: "cut", label: "Cut the end at midnight" },
  ],
  created_at: t(10),
  raised_by: "Engineer",
};

const answers = {
  onAnswerThread: vi.fn(),
  onAnswerPlan: vi.fn(),
  onAnswerDecision: vi.fn(),
};

describe("copy helpers", () => {
  it("treats a bot message of title plus context as covered by the open decision body", () => {
    const bot = `**${decision.title}**\n\n${context}`;
    const open = [{ text: decision.question, context, decision }];
    expect(botTextCoveredByOpen(bot, open)).toBe(true);
    expect(normCopy(openQuestionBody(open[0]))).toContain(normCopy(decision.title));
    expect(summaryCoveredByBody("A manager requests a day of time off and leaves the start and end times blank.", [openQuestionBody(open[0]), context])).toBe(true);
    expect(botTextCoveredByOpen("A later note about something else entirely.", open)).toBe(false);
    expect(summaryCoveredByBody("A completely different line.", [context])).toBe(false);
  });

  it("treats a first-sentence summary as covered when the body still has the markdown links", () => {
    const linked =
      "Employees can ask for time off in the mobile app ([#1838](https://github.com/ROWSHR/rows-backend/pull/1838), [ROWS-5088](https://linear.app/rows/issue/ROWS-5088)). Approve and decline are not in this PR.";
    const summary = "Employees can ask for time off in the mobile app (1838, ROWS-5088).";
    expect(summaryCoveredByBody(summary, [linked])).toBe(true);
  });
});

describe("TopicCard dedupes bot text and the summary line", () => {
  const topics = buildTopics({ decisions: [decision], details: {}, asks: [] }, {}, () => true);

  it("does not repeat the decision body in topic-explain or the first sentence as topic-summary", () => {
    const topic = topics.find((x) => x.key === "decision:engineer-pr-1838-default-range-2")!;
    expect(topic.summary).toMatch(/A manager requests a day of time off/);
    expect(topic.history.some((h) => h.who !== "You" && h.text.includes(decision.title))).toBe(true);

    render(<Conversation topics={topics} onOpen={vi.fn()} chrome={{ now: new Date() }} {...answers} />);
    const card = document.querySelector<HTMLElement>('[data-topic="decision:engineer-pr-1838-default-range-2"]')!;
    expect(card).not.toBeNull();
    expect(card.querySelector("[data-bot-explain]")).toBeNull();
    expect(card.querySelector(".topic-summary")).toBeNull();
    // The decision itself still shows once.
    expect(card.querySelectorAll("h3.card-title").length).toBe(1);
    expect(card.querySelector("h3.card-title")!.textContent).toContain(decision.title);
    expect(card.querySelector(".context")!.textContent).toContain("leaves the start and end times blank");
    expect(screen.getByText(decision.question)).toBeTruthy();
  });

  it("keeps a unique bot note and a unique summary that the body does not already start with", () => {
    const unique = {
      ...topics[0],
      summary: "This is a unique one-line recap that the card body does not start with.",
      history: [
        ...topics[0].history,
        { at: t(1), who: "Engineer" as const, text: "Here is extra background that is not on the card.", key: "decision:engineer-pr-1838-default-range-2" },
      ],
    };
    render(<Conversation topics={[unique]} onOpen={vi.fn()} chrome={{ now: new Date() }} {...answers} />);
    const card = document.querySelector<HTMLElement>('[data-topic="decision:engineer-pr-1838-default-range-2"]')!;
    // The latest unique bot note is newer than the generated title+context history, so it stays.
    expect(card.querySelector("[data-bot-explain]")!.textContent).toContain("extra background that is not on the card");
    expect(card.querySelector(".topic-summary")!.textContent).toBe(unique.summary);
  });
});
