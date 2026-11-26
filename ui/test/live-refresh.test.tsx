// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_MS, createPoller, useLiveRefresh, userBusy } from "../src/useLiveRefresh";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);

function setup(versions: string[], idle: () => boolean = () => true) {
  let i = 0;
  const fetchImpl = vi.fn(async (url: string) => {
    expect(url).toMatch(/^\/api\/version\?check=\d+$/);
    const v = versions[Math.min(i++, versions.length - 1)];
    return new Response(JSON.stringify({ version: v }), { status: 200 });
  }) as unknown as typeof fetch;
  const load = vi.fn(async () => "data");
  const apply = vi.fn();
  const poller = createPoller<string>({ fetchImpl, load, apply, isIdle: idle, wait: () => new Promise((r) => setTimeout(r, 1)) });
  return { fetchImpl, load, apply, poller };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("live refresh", () => {
  it("loads and applies on a new hash, skips on the same hash", async () => {
    const t = setup([H1, H1, H2]);
    await t.poller.checkVersion();
    expect(t.apply).toHaveBeenCalledTimes(1);
    await t.poller.checkVersion();
    expect(t.load).toHaveBeenCalledTimes(1);
    await t.poller.checkVersion();
    expect(t.apply).toHaveBeenCalledTimes(2);
  });

  it("rejects a hash that is not 64 hex characters", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup(["xyz"]);
    await t.poller.checkVersion();
    expect(t.load).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("checks on the timer and on visibilitychange, and stops on destroy", async () => {
    const t = setup([H1]);
    await t.poller.start();
    expect(t.fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(t.fetchImpl).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fetchImpl).toHaveBeenCalledTimes(3);
    t.poller.destroy();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(t.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not overlap checks while busy", async () => {
    let release: () => void = () => {};
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (release = () => r(new Response(JSON.stringify({ version: H1 }))))));
    const p = createPoller<string>({ fetchImpl: fetchImpl as unknown as typeof fetch, load: async () => "d", apply: vi.fn() });
    const first = p.checkVersion();
    expect(p.state.busy).toBe(true);
    await p.checkVersion();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(p.state.busy).toBe(false);
  });

  it("waits for idle before applying", async () => {
    let idle = false;
    const t = setup([H1], () => idle);
    const run = t.poller.checkVersion();
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.apply).not.toHaveBeenCalled();
    idle = true;
    await vi.advanceTimersByTimeAsync(2000);
    await run;
    expect(t.apply).toHaveBeenCalledTimes(1);
  });

  it("userBusy: focused field, draft text, or listening mic", () => {
    expect(userBusy()).toBe(false);
    const ta = document.createElement("textarea");
    document.body.append(ta);
    expect(userBusy()).toBe(false);
    ta.focus();
    expect(userBusy()).toBe(true);
    ta.blur();
    ta.value = "half-written";
    expect(userBusy()).toBe(true);
    ta.value = "";
    expect(userBusy()).toBe(false);
    const mic = document.createElement("button");
    mic.className = "mic-btn listening";
    document.body.append(mic);
    expect(userBusy()).toBe(true);
  });

  it("the hook starts on mount and cleans up on unmount", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: H1 }))) as unknown as typeof fetch;
    function C() {
      useLiveRefresh<string>({ fetchImpl, load: async () => "d", apply: () => {}, isIdle: () => true });
      return null;
    }
    const { unmount } = render(<C />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const n = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    unmount();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(n);
  });
});
