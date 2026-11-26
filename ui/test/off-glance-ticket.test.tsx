// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";

vi.mock("../src/data/board", () => {
  const board: Board = {
    updated_at: "2026-11-25T16:00:00.000Z",
    glance: { waiting: [], tickets: [], others: [], mine: [] },
    decisions: [],
    details: {
      "ticket:PROJ-2512": {
        ticket: "## PROJ-2512: Raw ticket dump\n\n- **Ticket:** [PROJ-2512](https://linear.app/acme/issue/PROJ-2512)",
        plain: "Managers view and approve time off requests here.",
        thread: [
          {
            at: "2026-11-25T15:00:00.000Z",
            from: "bot",
            text: "Open question",
            question: {
              id: "q1c-reworded-test",
              text: "Q1c (reworded): on an approved PTO request, which bank number should the manager see?",
              context: "Need your call on approved bank balance.",
              options: [
                { id: "live", label: "32h" },
                { id: "before", label: "40h" },
              ],
            },
          },
        ],
      },
    },
    // Prior clarifying question ending with '?' (isClarifying=true) keeps the question open
    asks: [
      {
        id: "prior-clarify-1",
        at: "2026-11-25T15:05:00.000Z",
        item_key: "ticket:PROJ-2512",
        label: "PROJ-2512",
        kind: "answer",
        text: "What do you think about returning current balance?",
        reply_to: "q1c-reworded-test",
      },
    ],
  };
  return { board };
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Off-glance ticket plan/thread questions deliver answers", () => {
  it("keeps raw ticket behind collapsed Full ticket toggle and sends free-text answer even after a prior clarifying ask", async () => {
    vi.stubEnv("ACTION_BOARD_WEBHOOK_CONFIGURED", "1");
    const { default: App } = await import("../src/App");

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.spyOn(window, "fetch").mockImplementation(fetchMock as typeof window.fetch);

    render(<App view="conversation" />);
    const topic = document.querySelector('[data-topic="ticket:PROJ-2512"]') as HTMLElement;
    expect(topic).toBeTruthy();
    const detailsEl = topic.querySelector("details.topic-full-ticket") as HTMLDetailsElement;
    expect(detailsEl).toBeTruthy();
    expect(detailsEl.open).toBe(false);
    expect(topic.querySelector(".topic-title")?.textContent).not.toContain("**Ticket:**");

    const input = topic.querySelector("textarea.note-input") as HTMLTextAreaElement;
    const answerText = "Please get me a link for the figma";
    fireEvent.change(input, { target: { value: answerText } });
    fireEvent.click(within(topic).getByRole("button", { name: "Send to assistant" }));

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === "POST" && String(c[1]?.body ?? "").includes("item.message"));
      expect(postCalls.length).toBeGreaterThanOrEqual(1);
    });
    const webhookCall = fetchMock.mock.calls.find((c) => c[1]?.method === "POST" && String(c[1]?.body ?? "").includes("item.message"))!;
    const body = JSON.parse(String(webhookCall[1]?.body));
    expect(body.event).toBe("item.message");
    expect(body.item_id).toBe("PROJ-2512");
    expect(body.item_section).toBe("tickets");
    expect(body.text).toContain(answerText);
    expect(screen.queryByText(/Could not send, try again/)).toBeNull();
  });
});
