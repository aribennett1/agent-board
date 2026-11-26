// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSidebarWidth } from "../src/useSidebarWidth";
import { SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_WIDTH_KEY } from "../src/sidebarWidth";

// jsdom has no PointerEvent; the hook listens for pointer events, so stand one up on MouseEvent.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

function Harness() {
  const s = useSidebarWidth();
  return (
    <div className={s.dragging ? "layout is-resizing" : "layout"} data-width={s.width} data-dragging={s.dragging ? "1" : "0"}>
      <div
        className="sidenav-resize"
        role="separator"
        aria-label="Resize sidebar"
        onPointerDown={s.onPointerDown}
        onPointerMove={s.onPointerMove}
        onPointerUp={s.onPointerUp}
        onPointerCancel={s.onPointerCancel}
        onDoubleClick={s.onDoubleClick}
      />
    </div>
  );
}

const widthOf = () => Number(document.querySelector(".layout")!.getAttribute("data-width"));
const handle = () => document.querySelector<HTMLElement>(".sidenav-resize")!;

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1200 });
});
afterEach(() => {
  cleanup();
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
});

const pointer = (type: "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel", clientX: number) => {
  const name = type === "pointerDown" ? "pointerdown" : type === "pointerMove" ? "pointermove" : type === "pointerUp" ? "pointerup" : "pointercancel";
  act(() => {
    handle().dispatchEvent(
      new PointerEvent(name, {
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: type === "pointerUp" || type === "pointerCancel" ? 0 : 1,
        clientX,
        clientY: 10,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
};

describe("useSidebarWidth", () => {
  it("starts at the default width and restores a stored one", () => {
    const first = render(<Harness />);
    expect(widthOf()).toBe(SIDEBAR_DEFAULT);
    first.unmount();
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "360");
    render(<Harness />);
    expect(widthOf()).toBe(360);
  });

  it("drags the width, clamps it, disables selection while dragging, and persists on release", () => {
    render(<Harness />);
    pointer("pointerDown", 240);
    expect(document.querySelector(".layout")!.getAttribute("data-dragging")).toBe("1");
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("col-resize");
    pointer("pointerMove", 340);
    expect(widthOf()).toBe(340);
    pointer("pointerUp", 340);
    expect(document.querySelector(".layout")!.getAttribute("data-dragging")).toBe("0");
    expect(document.body.style.userSelect).toBe("");
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("340");

    pointer("pointerDown", 340);
    pointer("pointerMove", 2000);
    expect(widthOf()).toBe(600);
    pointer("pointerUp", 2000);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("600");

    pointer("pointerDown", 600);
    pointer("pointerMove", 0);
    expect(widthOf()).toBe(SIDEBAR_MIN);
    pointer("pointerUp", 0);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_MIN));
  });

  it("double-clicking the handle resets to the default width and saves it", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "400");
    render(<Harness />);
    expect(widthOf()).toBe(400);
    fireEvent.doubleClick(handle());
    expect(widthOf()).toBe(SIDEBAR_DEFAULT);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe(String(SIDEBAR_DEFAULT));
  });

  it("reclamps the displayed width when the viewport shrinks, without overwriting a wider stored preference", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, "400");
    render(<Harness />);
    expect(widthOf()).toBe(400);
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 700 });
    fireEvent(window, new Event("resize"));
    expect(widthOf()).toBe(300);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_KEY)).toBe("400");
  });
});
