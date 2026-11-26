import { describe, expect, it } from "vitest";
import {
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  SIDEBAR_WIDTH_KEY,
  MAIN_MIN,
} from "../src/sidebarWidth";

const memory = (init: Record<string, string> = {}) => {
  const store = { ...init };
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    store,
  };
};

describe("clampSidebarWidth", () => {
  it("keeps a width already in range", () => {
    expect(clampSidebarWidth(280, 1200)).toBe(280);
  });

  it("does not go below the minimum", () => {
    expect(clampSidebarWidth(50, 1200)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(-10, 1200)).toBe(SIDEBAR_MIN);
  });

  it("caps at half the viewport", () => {
    expect(clampSidebarWidth(800, 1000)).toBe(500);
  });

  it("leaves at least MAIN_MIN for the board, even when that is under half the viewport", () => {
    expect(clampSidebarWidth(500, 700)).toBe(300);
    expect(700 - clampSidebarWidth(500, 700)).toBe(MAIN_MIN);
  });

  it("never drops below SIDEBAR_MIN when the viewport cannot satisfy both caps", () => {
    expect(clampSidebarWidth(400, 500)).toBe(SIDEBAR_MIN);
  });

  it("falls back to the default for non-finite values", () => {
    expect(clampSidebarWidth(Number.NaN, 1200)).toBe(SIDEBAR_DEFAULT);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY, 1200)).toBe(SIDEBAR_DEFAULT);
  });
});

describe("sidebar width persistence", () => {
  it("loads the default when nothing is stored", () => {
    expect(loadSidebarWidth(memory(), 1200)).toBe(SIDEBAR_DEFAULT);
  });

  it("restores a stored width", () => {
    expect(loadSidebarWidth(memory({ [SIDEBAR_WIDTH_KEY]: "360" }), 1200)).toBe(360);
  });

  it("clamps a stored width on load", () => {
    expect(loadSidebarWidth(memory({ [SIDEBAR_WIDTH_KEY]: "80" }), 1200)).toBe(SIDEBAR_MIN);
    expect(loadSidebarWidth(memory({ [SIDEBAR_WIDTH_KEY]: "9999" }), 1000)).toBe(500);
  });

  it("ignores garbage in storage", () => {
    expect(loadSidebarWidth(memory({ [SIDEBAR_WIDTH_KEY]: "nope" }), 1200)).toBe(SIDEBAR_DEFAULT);
  });

  it("saves the width as a string", () => {
    const s = memory();
    saveSidebarWidth(320, s);
    expect(s.store[SIDEBAR_WIDTH_KEY]).toBe("320");
    expect(loadSidebarWidth(s, 1200)).toBe(320);
  });
});
