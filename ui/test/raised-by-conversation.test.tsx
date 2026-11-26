// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Conversation } from "../src/Conversation";
import { buildTopics } from "../src/topics";
import type { Board, Decision } from "../src/data/types";

afterEach(cleanup);

const d = (id: string, extra: Partial<Decision> = {}): Decision => ({
  id,
  title: extra.title ?? id,
  card_ref: null,
  context: "The service needs a decision from you on this point today.",
  question: extra.question ?? `Decide ${id}?`,
  what_happens_after: "The assistant continues.",
  options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
  created_at: "2026-11-26T17:00:00.000Z",
  ...extra,
});

describe("Conversation bot pills", () => {
  it("names the bot at the top left of a card, infers it from an id prefix, and stays blank when it cannot", () => {
    const board = {
      decisions: [
        d("qa-2016-ci-rerun", { title: "CI rerun", question: "Rerun CI?" }),
        d("rows-5844-duplicate-role", { title: "Duplicate role", question: "Fix the duplicate role?" }),
        d("compress-images", { title: "Compress images", question: "Compress the images?", raised_by: "Planner" }),
      ],
    } as Pick<Board, "decisions" | "details" | "asks" | "ticket_summaries">;
    const topics = buildTopics(board, {}, () => true);
    const noop = async () => true;
    render(<Conversation topics={topics} onOpen={() => {}} onAnswerThread={noop} onAnswerPlan={noop} onAnswerDecision={() => {}} />);
    const qa = document.querySelector<HTMLElement>('[data-topic="decision:qa-2016-ci-rerun"]')!;
    const pill = qa.querySelector(".topic-head-left .bot-pill");
    expect(pill?.textContent).toBe("QA");
    expect(pill?.className).toContain("bot-pill-qa");
    expect(pill?.parentElement?.classList.contains("topic-head-left")).toBe(true);
    const explicit = document.querySelector<HTMLElement>('[data-topic="decision:compress-images"]')!;
    expect(explicit.querySelector(".bot-pill")?.textContent).toBe("Planner");
    const unknown = document.querySelector<HTMLElement>('[data-topic="decision:rows-5844-duplicate-role"]')!;
    expect(unknown.querySelector(".bot-pill")).toBeNull();
    expect(screen.queryByText("Mark all read")).toBeNull();
  });
});
