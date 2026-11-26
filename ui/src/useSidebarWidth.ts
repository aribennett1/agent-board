import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
  SIDEBAR_DEFAULT,
} from "./sidebarWidth";

const dragOn = (on: boolean) => {
  document.body.style.userSelect = on ? "none" : "";
  document.body.style.cursor = on ? "col-resize" : "";
};

export function useSidebarWidth() {
  const [preferred, setPreferred] = useState(() => loadSidebarWidth(window.localStorage, window.innerWidth));
  const [viewport, setViewport] = useState(() => window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(preferred);

  const width = clampSidebarWidth(preferred, viewport);
  widthRef.current = width;

  const apply = (next: number, persist: boolean) => {
    const clamped = clampSidebarWidth(next, window.innerWidth);
    widthRef.current = clamped;
    setPreferred(clamped);
    if (persist) saveSidebarWidth(clamped, window.localStorage);
  };

  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      dragOn(false);
    };
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button > 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { pointerId: e.pointerId, startX: e.clientX, startWidth: widthRef.current };
    setDragging(true);
    dragOn(true);
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    apply(d.startWidth + (e.clientX - d.startX), false);
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    setDragging(false);
    dragOn(false);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    saveSidebarWidth(widthRef.current, window.localStorage);
  }, []);

  const onDoubleClick = useCallback(() => {
    apply(SIDEBAR_DEFAULT, true);
  }, []);

  return { width, dragging, onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onDoubleClick };
}
