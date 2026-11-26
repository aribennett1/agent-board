import { useCallback, useState } from "react";

// Per-comment collapsed state for PR review comments, kept in localStorage.
// Only what he toggled is stored; an untouched comment follows its default (settled ones collapsed, open ones expanded).
export const COLLAPSE_STORAGE_KEY = "action-board:collapsed-comments";

type Store = Record<string, boolean>;

function read(storage: Pick<Storage, "getItem"> | undefined): Store {
  if (!storage) return {};
  try {
    const raw = JSON.parse(storage.getItem(COLLAPSE_STORAGE_KEY) ?? "null");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Store) : {};
  } catch {
    return {};
  }
}

const browserStorage = () => (typeof window === "undefined" ? undefined : window.localStorage);

export function getCollapsed(key: string, fallback: boolean, storage: Pick<Storage, "getItem"> | undefined = browserStorage()): boolean {
  const v = read(storage)[key];
  return typeof v === "boolean" ? v : fallback;
}

export function setCollapsed(key: string, collapsed: boolean, storage: Pick<Storage, "getItem" | "setItem"> | undefined = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify({ ...read(storage), [key]: collapsed }));
  } catch {
    // Storage full or blocked: the toggle still works until reload.
  }
}

export function useCollapsed(key: string, fallback: boolean): [boolean, () => void] {
  const [stored, setStored] = useState<boolean | undefined>(() => {
    const v = read(browserStorage())[key];
    return typeof v === "boolean" ? v : undefined;
  });
  // The default is read once on mount, so answering a comment does not fold it shut under his cursor.
  const [initial] = useState(fallback);
  const collapsed = stored ?? initial;
  const toggle = useCallback(() => {
    setStored(!collapsed);
    setCollapsed(key, !collapsed);
  }, [key, collapsed]);
  return [collapsed, toggle];
}

export function CollapseChevron({ collapsed, onToggle, label }: { collapsed: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      className={`collapse-chevron${collapsed ? " collapsed" : ""}`}
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? "Expand" : "Collapse"} ${label}`}
      title={collapsed ? "Expand" : "Collapse"}
      onClick={onToggle}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6l4 4 4-4" />
      </svg>
    </button>
  );
}
