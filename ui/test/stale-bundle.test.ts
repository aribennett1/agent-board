// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { isStale, loadedBuild, watchBuild } from "../src/staleBundle";

const page = (src: string | null) => {
  document.head.innerHTML = src ? `<script type="module" crossorigin src="${src}"></script>` : "";
};
const served = (ui: string) => vi.fn(async () => new Response(JSON.stringify({ version: "a".repeat(64), ui }), { status: 200 })) as unknown as typeof fetch;
const hidden = (v: boolean) => Object.defineProperty(document, "hidden", { configurable: true, get: () => v });
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => { page(null); hidden(false); });

describe("stale bundle", () => {
  it("reads the loaded build and compares it with the served one", () => {
    page("/assets/index-OLD.js");
    expect(loadedBuild()).toBe("/assets/index-OLD.js");
    expect(isStale("/assets/index-OLD.js", "/assets/index-NEW.js")).toBe(true);
    expect(isStale("/assets/index-OLD.js", "/assets/index-OLD.js")).toBe(false);
    expect(isStale(null, "/assets/index-NEW.js")).toBe(false);
    expect(isStale("/assets/index-OLD.js", null)).toBe(false);
  });

  it("shows the note while he is looking and reloads only once the tab is hidden", async () => {
    page("/assets/index-OLD.js");
    const reload = vi.fn(); const onStale = vi.fn();
    const stop = watchBuild(onStale, { fetchImpl: served("/assets/index-NEW.js"), reload });
    await flush(); await flush();
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    hidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(reload).toHaveBeenCalledTimes(1);
    stop();
  });

  it("does nothing when the build matches or the page is not a built bundle", async () => {
    page("/assets/index-SAME.js");
    const reload = vi.fn(); const onStale = vi.fn();
    watchBuild(onStale, { fetchImpl: served("/assets/index-SAME.js"), reload })();
    page("/src/main.tsx");
    const f = served("/assets/index-NEW.js");
    watchBuild(onStale, { fetchImpl: f, reload })();
    await flush(); await flush();
    expect(onStale).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });
});
