// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDelta, diffBoard, fingerprint, flattenBoard, unflattenBoard } from "../src/boardDelta";
import { BOARD_DONE_PATH, BOARD_PATH, PR_DETAIL_PATH, createPoller, resetLiveFeed, useLiveBoard } from "../src/useLiveBoard";
import { VERSION_PATH } from "../src/useLiveRefresh";
import { Conversation } from "../src/Conversation";
import { MyPrs } from "../src/LiveLists";
import { buildTopics } from "../src/topics";
import type { Board, Decision } from "../src/data/types";
import type { FeedPr } from "../src/liveLists";

// The live board leaves done topics and PR descriptions out and refreshes by delta; the page puts it back together,
// pages done topics in when Show done opens, and loads a PR description when its row opens.

const h = (s: string) => String([...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7));
const d = (id: string, extra: Partial<Decision> = {}): Decision => ({
  id, title: id, card_ref: null, context: "Some context for this card.", question: `Decide ${id}?`, what_happens_after: "Then.",
  options: [{ id: "yes", label: "Yes" }], created_at: "2026-11-26T17:00:00.000Z", ...extra,
});
const base = (decisions: Decision[], extra: Partial<Board> = {}) => ({ updated_at: "2026-11-26T17:00:00.000Z", decisions, glance: { waiting: [], tickets: [] }, asks: [], details: {}, ...extra }) as Board;

afterEach(() => {
  cleanup();
  resetLiveFeed();
  vi.unstubAllGlobals();
});
beforeEach(() => window.localStorage.clear());

describe("boardDelta", () => {
  it("rebuilds the board from a delta, and refuses one cut from another version or missing a part", () => {
    const a = base([d("qa-a"), d("qa-b")], { details: { "decision:qa-a": { summary: "s" } } });
    const b = base([d("qa-b", { title: "B!" }), d("qa-c")], { details: {} });
    const fa = flattenBoard(a as never, "r1");
    const fb = flattenBoard(b as never, "r2");
    const delta = diffBoard(fingerprint(fa, h), "r1", fb, fingerprint(fb, h));
    expect(Object.keys(delta.set).sort()).toEqual(["decisions\u0001qa-b", "decisions\u0001qa-c"]);
    expect(delta.drop.sort()).toEqual(["decisions\u0001qa-a", "details\u0001decision:qa-a"]);
    expect(unflattenBoard(applyDelta(fa, delta)!)).toEqual(b);
    expect(applyDelta({ ...fa, version: "other" }, delta)).toBeNull();
    expect(applyDelta(fa, { ...delta, set: {} })).toBeNull();
  });
});

describe("the poller asks for ?since and merges the change", () => {
  it("loads the whole board first, then only the change; a delta that does not fit loads the whole board again", async () => {
    const one = base([d("qa-a")]);
    const two = base([d("qa-a"), d("qa-b")]);
    const f1 = flattenBoard(one as never, "r1");
    const f2 = flattenBoard(two as never, "r2");
    const delta = { ...diffBoard(fingerprint(f1, h), "r1", f2, fingerprint(f2, h)), rev: "r2" };
    let v = 1;
    let mode: "delta" | "stale" = "delta";
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.startsWith(VERSION_PATH)) return new Response(JSON.stringify({ version: String(v).padStart(64, "0") }));
      if (url === BOARD_PATH) return new Response(JSON.stringify({ ...(v === 1 ? one : two), rev: v === 1 ? "r1" : "r2" }));
      if (url === `${BOARD_PATH}?since=r1`) return new Response(JSON.stringify(mode === "delta" ? delta : { ...delta, since: "zzz" }));
      throw new Error(url);
    }) as unknown as typeof fetch;
    const applied: Board[] = [];
    const p = createPoller({ apply: (f) => applied.push(f.board), fetchImpl, isIdle: () => true, doc: document });
    await p.checkVersion();
    expect(applied[0].decisions.map((x) => x.id)).toEqual(["qa-a"]);
    v = 2;
    await p.checkVersion();
    expect(urls.filter((u) => u.startsWith(BOARD_PATH))).toEqual([BOARD_PATH, `${BOARD_PATH}?since=r1`]);
    expect(applied[1].decisions.map((x) => x.id)).toEqual(["qa-a", "qa-b"]);
    // A fresh poller whose since no longer fits: it falls back to the whole board.
    const q = createPoller({ apply: (f) => applied.push(f.board), fetchImpl, isIdle: () => true, doc: document });
    v = 1;
    await q.checkVersion();
    mode = "stale";
    v = 2;
    await q.checkVersion();
    expect(applied[applied.length - 1].decisions.map((x) => x.id)).toEqual(["qa-a", "qa-b"]);
    expect(urls.slice(-2)).toEqual([`${BOARD_PATH}?since=r1`, BOARD_PATH]);
    p.destroy();
    q.destroy();
  });
});

describe("Show done pages in the done topics the board left out", () => {
  function Harness() {
    const b = useLiveBoard(base([]));
    const topics = buildTopics(b, {}, (x) => !x.answer);
    const noop = async () => true;
    return <Conversation topics={topics} onOpen={() => {}} onAnswerThread={noop} onAnswerPlan={noop} onAnswerDecision={() => {}} />;
  }
  it("counts the left-out topics, loads them on Show done, and offers older ones while there are more", async () => {
    const live = { ...base([d("qa-open")]), rev: "r1", done_summary: { total: 2, by_bot: { QA: 2 } } };
    const finished = (id: string) => d(id, { answer: { answer: "yes", answer_label: "Yes", answered_by: "app", answered_at: "2026-11-26T17:05:00.000Z" } as never });
    const pages: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith(VERSION_PATH)) return new Response(JSON.stringify({ version: "1".padStart(64, "0") }));
      if (url === BOARD_PATH) return new Response(JSON.stringify(live));
      if (url.startsWith(BOARD_DONE_PATH)) {
        pages.push(url);
        const first = url.includes("offset=0");
        const id = first ? "qa-done-new" : "qa-done-old";
        return new Response(JSON.stringify({ total: 2, offset: first ? 0 : 1, limit: 1, has_more: first, topics: [`decision:${id}`], decisions: [finished(id)], asks: [], details: {} }));
      }
      throw new Error(url);
    }));
    render(<Harness />);
    const toggle = await waitFor(() => {
      const b = [...document.querySelectorAll<HTMLButtonElement>(".group-toggle")].find((x) => /Show done/.test(x.textContent ?? ""));
      expect(b?.textContent).toBe("Show done (2)");
      return b!;
    });
    await act(async () => void fireEvent.click(toggle));
    await waitFor(() => expect(document.querySelector('[data-topic="decision:qa-done-new"]')).not.toBeNull());
    expect(pages[0]).toBe(`${BOARD_DONE_PATH}?bot=QA&offset=0&limit=20`);
    const older = document.querySelector<HTMLButtonElement>(".done-more")!;
    expect(older.textContent).toBe("Show older done");
    await act(async () => void fireEvent.click(older));
    await waitFor(() => expect(document.querySelector('[data-topic="decision:qa-done-old"]')).not.toBeNull());
    expect(document.querySelector(".done-more")).toBeNull();
    fireEvent.click(document.querySelector<HTMLButtonElement>('[aria-expanded="true"].group-toggle')!);
    expect(document.querySelector<HTMLButtonElement>(".group-toggle")?.textContent).toBe("Show done (2)");
  });
});

describe("a PR row loads its description when it opens", () => {
  it("shows Loading, then the description and open comments from /__ab/pr-detail", async () => {
    const link = "https://github.com/ROWSHR/rows-backend/pull/7";
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`${PR_DETAIL_PATH}?link=${encodeURIComponent(link)}`);
      await gate;
      return new Response(JSON.stringify({ link, body: "The full description", unresolved: [{ author: "sam", path: "a.php", body: "please fix", url: "u" }] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const row: FeedPr = { repo: "rows-backend", number: 7, title: "PR 7", link, author: "sam", who: "you", state: "ready", ci: "passing", unresolved_count: 1, detail_deferred: true, updated_at: "2026-11-26T17:00:00Z" };
    render(<MyPrs items={[row]} />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(document.querySelector<HTMLButtonElement>(".row-chev")!);
    expect(document.querySelector(".live-body")?.textContent).toContain("Loading…");
    await act(async () => release());
    await waitFor(() => expect(document.querySelector(".live-desc")?.textContent).toContain("The full description"));
    expect(document.querySelector(".live-threads")?.textContent).toContain("please fix");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
