// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board } from "../src/data/types";

// A small board instead of the real board.ts; the Board tab only has to show it.
vi.mock("../src/data/board", () => ({
  board: {
    updated_at: "2026-11-10T09:00:00.000Z",
    decisions: [
      {
        id: "single",
        card_ref: null,
        question: "Question single?",
        what_happens_after: "Something happens.",
        options: [{ id: "yes", label: "Yes" }],
        created_at: "2026-11-10T09:00:00.000Z",
      },
    ],
    glance: {
      waiting: [{ title: "Signed NDA", who: "Legal" }],
      tickets: [],
      others: [
        { title: "Fix rounding", author: "sam", who: "Your review requested", link: "https://github.com/acme/api/pull/12" },
        { title: "Docs pass", author: "sam", who: "Waiting on the author", link: "https://github.com/acme/api/pull/13" },
      ],
    },
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

async function renderTabs() {
  const { default: Tabs } = await import("../src/Tabs");
  render(<Tabs />);
}
const nav = () => screen.getByRole("navigation", { name: "Views" });
const item = (view: string) => nav().querySelector<HTMLButtonElement>(`[data-view="${view}"]`)!;
const current = () => [...nav().querySelectorAll('[aria-current="page"]')].map((b) => b.getAttribute("data-view"));


// Items not needing the owner sit in a collapsed "In progress, not ready yet" group: open every one.
const openInProgress = () => {
  for (const b of screen.queryAllByRole("button", { name: /In progress, not ready yet/ })) if (b.getAttribute("aria-expanded") === "false") fireEvent.click(b);
};

describe("Left nav", () => {
  it("opens on Conversation, and Home has every section in the nav and counts", async () => {
    await renderTabs();
    expect(current()).toEqual(["conversation"]);
    expect(screen.getByRole("status").textContent).toMatch(/to answer|Nothing to answer/);
    fireEvent.click(item("home"));
    expect(window.location.hash).toBe("#home");
    expect([...nav().querySelectorAll(".nav-item")].map((b) => b.getAttribute("data-view"))).toEqual([
      "conversation",
      "home",
      "tickets",
      "mine",
      "reviews",
      "waiting",
      "others",
      "audit",
    ]);
    expect(item("project")).toBeNull();
    expect(item("home").querySelector(".nav-count")?.textContent).toBe("1");
    expect(item("conversation").querySelector(".nav-count")?.textContent).toBe("1");
    // Sidebar badges and tab headers show only the Needs-you count; none when it's 0.
    expect(item("reviews").querySelector(".nav-count")).toBeNull();
    expect(item("others").querySelector(".nav-count")).toBeNull();
    expect(item("tickets").querySelector(".nav-count")).toBeNull();
    expect(item("mine").querySelector(".nav-count")).toBeNull();
    expect(item("audit").querySelector(".nav-count")).toBeNull();
    expect(item("waiting").querySelector(".nav-count")).toBeNull();
    expect(current()).toEqual(["home"]);
    expect(screen.getByRole("heading", { name: /Needs you\s*1/ })).toBeTruthy();
    expect(document.querySelector('[data-decision-id="single"]')).not.toBeNull();
    // Home also lists the PRs waiting on a review. None of them need the owner, so the header has no count.
    expect(screen.getByRole("heading", { name: "Reviews waiting for your yes" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Reviews waiting for your yes\s+\d/ })).toBeNull();
    expect(screen.getByText("Nothing needs you here")).toBeTruthy();
    expect(screen.queryByText(/Needs you \(0\)/)).toBeNull();
    openInProgress();
    expect(screen.getByRole("button", { name: /In progress, not ready yet \(1\)/ })).toBeTruthy();
    expect(screen.getByText("api #12")).toBeTruthy();
    expect(screen.queryByText("Docs pass")).toBeNull();
  });

  it("shows only the picked section, keeps it in the hash, and goes back to Conversation", async () => {
    await renderTabs();
    fireEvent.click(item("waiting"));
    expect(current()).toEqual(["waiting"]);
    expect(window.location.hash).toBe("#waiting");
    openInProgress();
    expect(screen.getByText("Signed NDA")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Needs you/ })).toBeNull();

    fireEvent.click(item("others"));
    expect(window.location.hash).toBe("#others");
    openInProgress();
    expect(screen.getByText("Docs pass")).toBeTruthy();

    fireEvent.click(item("conversation"));
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByText("Docs pass")).toBeNull();
  });

  it("opens the section named in the hash on load", async () => {
    window.history.replaceState(null, "", "/#others");
    await renderTabs();
    expect(current()).toEqual(["others"]);
    openInProgress();
    expect(screen.getByText("Docs pass")).toBeTruthy();
  });

  it("follows a hash change, and an unknown hash means Conversation", async () => {
    await renderTabs();
    await act(async () => {
      window.location.hash = "#project";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    // No real project is configured, so #project is treated like an unknown hash.
    expect(current()).toEqual(["conversation"]);
    await act(async () => {
      window.location.hash = "#other";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(current()).toEqual(["conversation"]);
  });

  it("on Reviews, hides the empty Needs you header and shows no sidebar badge when nothing needs you", async () => {
    await renderTabs();
    fireEvent.click(item("reviews"));
    expect(item("reviews").querySelector(".nav-count")).toBeNull();
    expect(screen.getByRole("heading", { name: "Reviews waiting for your yes" })).toBeTruthy();
    expect(screen.queryByText(/Needs you \(0\)/)).toBeNull();
    expect(screen.getByText("Nothing needs you here")).toBeTruthy();
    expect(screen.getByRole("button", { name: /In progress, not ready yet \(1\)/ })).toBeTruthy();
    expect(screen.queryByText("api #12")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /In progress, not ready yet \(1\)/ }));
    expect(screen.getByText("api #12")).toBeTruthy();
  });
});
