import { useLayoutEffect, useRef, useState } from "react";
import type { BoardNotification } from "./data/types";
import { TIME_ZONE } from "./config";
import { Markdown } from "./markdown";
import { isBoardBot, botPillClass } from "./raisedBy";

// The notifications feed in the bottom of the sidebar: status notes the bots posted with `ab notify`, as chat bubbles,
// oldest at the top and newest at the bottom. It follows new notes unless the reader has scrolled up.
// An X on a bubble, or Dismiss all, clears it through /__ab/notifications/clear.
// That call never hits the wake webhook; the bots are not notified. Cleared notes leave the feed.

export const CLEAR_PATH = "/__ab/notifications/clear";

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

async function postClear(body: { id: number } | { all: true }): Promise<boolean> {
  try {
    const res = await fetch(CLEAR_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return res.ok;
  } catch {
    return false;
  }
}

const NEAR_BOTTOM = 24;
const initial = (bot: string) => (bot.trim()[0] ?? "?").toUpperCase();
const avatarClass = (bot: string) => (isBoardBot(bot) ? botPillClass(bot).replace("bot-pill ", "") : "bot-pill-grok");

export function Notifications({ items, now = new Date() }: { items: BoardNotification[]; now?: Date }) {
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const pending = useRef(new Set<number>());
  const listRef = useRef<HTMLOListElement>(null);
  const follow = useRef(true);

  // Oldest first, so the newest bubble is at the bottom like a chat.
  const visible = items
    .filter((n) => !n.cleared_at && !hidden.has(n.id))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
  const newest = visible[visible.length - 1]?.id;

  // New note arrived: stay glued to the bottom unless he scrolled up to read.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [newest, visible.length]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM;
  };

  const hide = (ids: number[]) =>
    setHidden((s) => {
      const next = new Set(s);
      for (const id of ids) next.add(id);
      return next;
    });

  const clearOne = (id: number) => {
    if (pending.current.has(id) || hidden.has(id)) return;
    pending.current.add(id);
    void postClear({ id }).then((ok) => {
      pending.current.delete(id);
      if (ok) hide([id]);
    });
  };

  const dismissAll = () => {
    const ids = visible.map((n) => n.id);
    if (ids.length === 0) return;
    for (const id of ids) pending.current.add(id);
    void postClear({ all: true }).then((ok) => {
      for (const id of ids) pending.current.delete(id);
      if (ok) hide(ids);
    });
  };

  return (
    <section className="feed" aria-label="Notifications">
      <header className="feed-head">
        <h2>Notifications</h2>
        {visible.length > 0 && (
          <button type="button" className="feed-dismiss" onClick={dismissAll}>
            Dismiss all
          </button>
        )}
      </header>
      {visible.length === 0 ? (
        <p className="feed-empty">No notifications yet.</p>
      ) : (
        <ol className="feed-list" ref={listRef} onScroll={onScroll}>
          {visible.map((n) => (
            <li key={n.id} data-notice-id={n.id} className="notice">
              <span className={`notice-avatar ${avatarClass(n.bot)}`} aria-hidden="true">
                {initial(n.bot)}
              </span>
              <div className="notice-bubble">
                <button type="button" className="notice-clear" aria-label="Clear notification" onClick={() => clearOne(n.id)}>
                  ×
                </button>
                <p className="notice-meta">
                  <strong className={`notice-bot ${avatarClass(n.bot)}`}>{n.bot}</strong>
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
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
