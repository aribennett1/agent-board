import { useRef, useState } from "react";
import type { Ask, ThreadEntry } from "./data/types";
import { openThreadQuestions, statusText } from "./convoModel";
import { clockTime, NoteBox } from "./ItemExpand";
import { Markdown } from "./markdown";
import { AlreadyDecidedBanner, PostApprovalBlock } from "./PostApprovalBlock";

// The reply thread on one item: the owner's notes from this browser and Assistant's replies (ab reply), oldest first.
// A reply can carry a question with one-click answers; an answer goes to Assistant like any note on the item.

const MINE_KEY = "action-board:my-notes";
export type MyNote = { at: string; text: string; reply?: string };
type MyNotes = Record<string, MyNote[]>;

export function loadMyNotes(): MyNotes {
  try {
    const v = JSON.parse(window.localStorage.getItem(MINE_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
export function rememberMyNote(itemKey: string, note: MyNote) {
  const all = loadMyNotes();
  all[itemKey] = [...(all[itemKey] ?? []), note].slice(-50);
  try {
    window.localStorage.setItem(MINE_KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked: the note was still sent.
  }
}

const SEEN_KEY = "action-board:seen-replies";
export function loadSeen(): Record<string, string> {
  try {
    const v = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
export function saveSeen(seen: Record<string, string>) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // ignore
  }
}

// The newest Assistant reply time, or undefined.
export const lastReplyAt = (thread?: ThreadEntry[]) =>
  (thread ?? []).filter((t) => t.text.trim() || t.question).reduce<string | undefined>((m, t) => (!m || t.at > m ? t.at : m), undefined);
export const hasUnread = (thread: ThreadEntry[] | undefined, seenAt?: string) => {
  const last = lastReplyAt(thread);
  return !!last && (!seenAt || last > seenAt);
};

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? clockTime(d) : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${clockTime(d)}`;
};

export function Thread({
  itemKey,
  thread,
  asks = [],
  onSend,
  version,
}: {
  itemKey: string;
  thread?: ThreadEntry[];
  // the owner's sends on this item stored in the board (from any browser).
  asks?: Ask[];
  onSend: (text: string) => Promise<boolean>;
  // Bumps when a note was sent from this item, so the thread re-reads this browser's notes.
  version?: number;
}) {
  const [, setTick] = useState(0);
  const [busyQ, setBusyQ] = useState<string | null>(null);
  const sendingQ = useRef(new Set<string>());
  const stored: MyNote[] = asks.map((a) => ({ at: a.at, text: a.text, reply: a.reply_to }));
  const local = (loadMyNotes()[itemKey] ?? []).filter((m) => !stored.some((x) => x.text === m.text || x.text === `Answer to: ${m.text}`));
  const mine = [...stored, ...local];
  void version;
  const replies = thread ?? [];
  if (!replies.length) return null;
  const answered = new Map(mine.filter((m) => m.reply).map((m) => [m.reply!, m.text]));
  const open = new Set(openThreadQuestions(replies, new Set(answered.keys())).map((t) => t.question!.id));
  const items = [
    ...mine.map((m) => ({ kind: "me" as const, at: m.at, m })),
    ...replies.map((t, i) => ({ kind: "bot" as const, at: t.at, t, i })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const answer = async (t: ThreadEntry, label: string) => {
    const q = t.question!;
    if (sendingQ.current.has(q.id) || answered.has(q.id)) return false;
    sendingQ.current.add(q.id);
    setBusyQ(q.id);
    let ok = false;
    try {
      ok = await onSend(`Answer to "${q.text}": ${label}`);
      if (ok) {
        rememberMyNote(itemKey, { at: new Date().toISOString(), text: label, reply: q.id });
        setTick((n) => n + 1);
      }
    } finally {
      setBusyQ((b) => (b === q.id ? null : b));
      if (!ok) sendingQ.current.delete(q.id);
    }
    return ok;
  };
  return (
    <section className="item-thread" aria-label="Replies">
      <h4>Replies</h4>
      <ol>
        {items.map((x, idx) =>
          x.kind === "me" ? (
            <li key={`me-${x.at}-${idx}`} className="thread-msg me">
              <p className="thread-head">
                <strong>You</strong> <span className="thread-at">{when(x.at)}</span>
              </p>
              <p className="thread-text">{x.m.reply ? `Answered: ${x.m.text}` : x.m.text}</p>
            </li>
          ) : (
            <li key={`bot-${x.i}`} className="thread-msg bot" data-reply-at={x.at}>
              <p className="thread-head">
                <strong>Assistant</strong> <span className="thread-at">{when(x.at)}</span>
              </p>
              {x.t.text.trim() && <Markdown text={x.t.text} className="md thread-text" />}
              {x.t.status && <p className="thread-status">Status: {statusText(x.t.status).label}</p>}
              {x.t.image && (
                <a href={x.t.image} target="_blank" rel="noopener noreferrer">
                  <img className="thread-image" src={x.t.image} alt={x.t.image_alt ?? "Attached image"} />
                </a>
              )}
              {x.t.question && (
                <div className="thread-question">
                  <p>
                    <strong>{x.t.question.text}</strong>
                  </p>
                  {x.t.question.context && <Markdown text={x.t.question.context} className="md q-context" />}
                  {x.t.question.suggestion && <p className="tq-hint"><span className="tq-hint-label">Assistant suggests:</span> {x.t.question.suggestion}</p>}
                  {answered.has(x.t.question.id) ? (
                    <p className="review-flag ok">Answered: {answered.get(x.t.question.id)}</p>
                  ) : !open.has(x.t.question.id) ? (
                    <p className="review-flag">Closed</p>
                  ) : (
                    <>
                      <AlreadyDecidedBanner decided={x.t.question.already_decided} />
                      <PostApprovalBlock answersComment={x.t.question.answers_comment} postText={x.t.question.post_text} />
                      <div className="quick-actions" role="group" aria-label={x.t.question.text}>
                        {x.t.question.options.map((o) => (
                          <button key={o.id} type="button" className="btn small" disabled={busyQ === x.t.question!.id} onClick={() => void answer(x.t, o.label)}>
                            {o.label}
                          </button>
                        ))}
                      </div>
                      <NoteBox draftKey={`${itemKey}#${x.t.question.id}`} label="Or answer in your own words" button="Send to assistant" onSend={(t) => answer(x.t, t)} />
                    </>
                  )}
                </div>
              )}
            </li>
          ),
        )}
      </ol>
    </section>
  );
}
