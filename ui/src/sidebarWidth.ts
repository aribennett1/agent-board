// Preferred left-sidebar width, remembered in localStorage. The applied width is clamped
// so the sidebar stays usable and the main board never collapses.

export const SIDEBAR_WIDTH_KEY = "action-board:sidebar-width";
export const SIDEBAR_DEFAULT = 240;
export const SIDEBAR_MIN = 200;
export const MAIN_MIN = 400;

export function clampSidebarWidth(width: number, viewportWidth: number): number {
  const half = Math.floor(Math.max(0, viewportWidth) * 0.5);
  const leaveMain = viewportWidth - MAIN_MIN;
  const max = Math.max(SIDEBAR_MIN, Math.min(half, leaveMain));
  const n = Number.isFinite(width) ? Math.round(width) : SIDEBAR_DEFAULT;
  return Math.min(max, Math.max(SIDEBAR_MIN, n));
}

export function loadSidebarWidth(storage: Pick<Storage, "getItem">, viewportWidth: number): number {
  const item = storage.getItem(SIDEBAR_WIDTH_KEY);
  if (item == null || item === "") return clampSidebarWidth(SIDEBAR_DEFAULT, viewportWidth);
  const raw = Number(item);
  return clampSidebarWidth(Number.isFinite(raw) ? raw : SIDEBAR_DEFAULT, viewportWidth);
}

export function saveSidebarWidth(width: number, storage: Pick<Storage, "setItem">): void {
  storage.setItem(SIDEBAR_WIDTH_KEY, String(width));
}
