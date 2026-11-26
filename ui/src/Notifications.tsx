import { useEffect, useRef, useState } from "react";
import type { BoardNotification } from "./data/types";
import { TIME_ZONE } from "./config";
import { Markdown } from "./markdown";

// The Notifications tab: a reverse-chronological feed of status notes the bots posted with `ab notify`.
// Scrolling a note into view, or "Mark all read", records read_at through /__ab/notifications/read.
// That call never hits the wake webhook; the bots are not notified.

export const READ_PATH = "/__ab/notifications/read";

const TIME = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, month: "short", day: "numeric" });
const TODAY = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, year: "numeric", month: "numeric", day: "numeric" });
const plain = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

export function noticeTime(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const time = plain(TIME.format(t));
  const when = TODAY.format(t) === TODAY.format(now) ? time : `${plain(DAY.format(t))}, ${time}`;
  return `${when} ET`;
}

async function postRead(body: { ids: number[] } | { all: true }): Promise<boolean> {
  try {
    const res = await fetch(READ_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res.ok;
  } catch {
    return false;
  }
}

export function Notifications({ items, now = new Date() }: { items: BoardNotification[]; now?: Date }) {
  const [seen, setSeen] = useState<Set<number>>(() => new Set());
  const pending = useRef(new Set<number>());
  const nodes = useRef(new Map<number, Element>());

  const isRead = (n: BoardNotification) => Boolean(n.read_at) || seen.has(n.id);
  const unread = items.filter((n) => !isRead(n));

  const remember = (ids: number[]) =>
    setSeen((s) => {
      const next = new Set(s);
      for (const id of ids) next.add(id);
      return next;
    });

  const mark = (ids: number[]) => {
    const fresh = ids.filter((id) => !pending.current.has(id) && !seen.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) pending.current.add(id);
    void postRead({ ids: fresh }).then((ok) => {
      for (const id of fresh) pending.current.delete(id);
      if (ok) remember(fresh);
    });
  };

  useEffect(() => {
    const queued = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const ids = [...queued];
      queued.clear();
      if (ids.length) mark(ids);
    };
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = Number((e.target as HTMLElement).dataset.noticeId);
          if (!Number.isInteger(id) || seen.has(id) || pending.current.has(id)) continue;
          queued.add(id);
        }
        if (queued.size && !timer) timer = setTimeout(flush, 50);
      },
      { threshold: 0.6 },
    );
    for (const [id, el] of nodes.current) {
      if (!seen.has(id)) observer.observe(el);
    }
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [items, seen]);

  const bind = (id: number) => (el: HTMLElement | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  };

  const markAll = () => {
    const ids = unread.map((n) => n.id);
    if (ids.length === 0) return;
    for (const id of ids) pending.current.add(id);
    void postRead({ all: true }).then((ok) => {
      for (const id of ids) pending.current.delete(id);
      if (ok) remember(ids);
    });
  };

  return (
    <div className="view notices">
      <header className="view-head">
        <h1>Notifications</h1>
        <p>Status updates from the bots. Reading them does not wake anyone.</p>
        {unread.length > 0 && (
          <button type="button" className="btn" onClick={markAll}>
            Mark all read
          </button>
        )}
      </header>
      {items.length === 0 ? (
        <p className="panel-empty">No notifications yet.</p>
      ) : (
        <ol className="notice-list" aria-label="Notifications">
          {items.map((n) => {
            const read = isRead(n);
            return (
              <li
                key={n.id}
                ref={bind(n.id)}
                data-notice-id={n.id}
                data-read={read ? "true" : "false"}
                className={read ? "notice notice-read" : "notice"}
              >
                <p className="notice-meta">
                  <strong className="notice-bot">{n.bot}</strong>
                  <time dateTime={n.created_at}>{noticeTime(n.created_at, now)}</time>
                </p>
                <Markdown text={n.text} className="md notice-text" />
                {n.next_update && <p className="notice-next">Next update by {n.next_update}</p>}
                {n.link && (
                  <p className="notice-link">
                    <a href={n.link} target="_blank" rel="noopener noreferrer">
                      {n.link}
                    </a>
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
