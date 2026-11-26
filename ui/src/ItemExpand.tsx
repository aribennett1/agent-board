import { useEffect, useRef, useState, type ReactNode } from "react";
import { MicButton } from "./MicButton";
import { rememberMyNote, Thread } from "./Thread";
import type { Ask, ItemDetail, PlanQuestion } from "./data/types";
import { Markdown } from "./markdown";

// The shared expandable item: one chevron row per board item (tickets, PRs, waiting, others' PRs), the details it
// opens (summary, extra content such as review drafts, Assistant's plan, discussion, quick actions and a reply box),
// and the full-width focus page that shows the same details for one item.

export type SendText = (text: string) => Promise<boolean>;

// "3:55 PM" in the browser's zone.
export const clockTime = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

const DRAFT_PREFIX = "action-board:note-draft:";
function loadNoteDraft(key?: string): string {
  if (!key) return "";
  try {
    return window.localStorage.getItem(DRAFT_PREFIX + key) ?? "";
  } catch {
    return "";
  }
}
function saveNoteDraft(key: string | undefined, value: string) {
  if (!key) return;
  try {
    if (value) window.localStorage.setItem(DRAFT_PREFIX + key, value);
    else window.localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    // ignore storage errors
  }
}

// A free-text box that sends its text, keeps typed text on failure, and retries cleanly. Cmd/Ctrl+Enter sends.
export function NoteBox({
  label,
  button = "Send to assistant",
  onSend,
  icon,
  title,
  buttonClass = "btn ghost small",
  sentLabel = "Sent to assistant",
  draftKey,
}: {
  label: string;
  button?: string;
  onSend: SendText;
  icon?: ReactNode;
  title?: string;
  buttonClass?: string;
  // e.g. "Sent to assistant": shown with the time once the note went through.
  sentLabel?: string;
  draftKey?: string;
}) {
  const [sentAt, setSentAt] = useState<Date | null>(null);
  const [text, setText] = useState(() => loadNoteDraft(draftKey));
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">(
    "idle",
  );
  const field = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const send = async () => {
    const t = text.trim();
    if (!t || sending.current) return;
    sending.current = true;
    setState("sending");
    let ok = false;
    try {
      ok = await onSend(t);
      setState(ok ? "sent" : "failed");
      if (ok) {
        setText("");
        saveNoteDraft(draftKey, "");
        setSentAt(new Date());
      } else {
        saveNoteDraft(draftKey, text);
      }
    } catch {
      setState("failed");
      saveNoteDraft(draftKey, text);
    } finally {
      sending.current = false;
    }
  };
  useEffect(() => {
    if (state !== "failed") return;
    const onRetry = () => {
      void send();
    };
    const onDelivered = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string }>).detail;
      const t = text.trim();
      if (detail?.text && (detail.text === t || detail.text.endsWith(`: ${t}`))) {
        setState("sent");
        setText("");
        saveNoteDraft(draftKey, "");
        setSentAt(new Date());
      }
    };
    window.addEventListener("online", onRetry);
    window.addEventListener("action-board:note-delivered", onDelivered);
    return () => {
      window.removeEventListener("online", onRetry);
      window.removeEventListener("action-board:note-delivered", onDelivered);
    };
  });
  return (
    <div className="note-box">
      <div className="mic-wrap">
        <textarea
          ref={field}
          className="composer-input note-input"
          aria-label={label}
          placeholder={label}
          value={text}
          rows={2}
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            saveNoteDraft(draftKey, v);
            if (state !== "sending") setState("idle");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <MicButton
          field={field}
          value={text}
          onChange={(v) => {
            setText(v);
            saveNoteDraft(draftKey, v);
            if (state !== "sending") setState("idle");
          }}
        />
      </div>
      <div className="note-actions">
        <button
          type="button"
          className={buttonClass}
          title={title}
          disabled={!text.trim() || state === "sending"}
          onClick={() => void send()}
        >
          {icon}
          {state === "sending" ? "Sending to assistant..." : state === "failed" ? "Try again" : button}
        </button>
        {state === "sent" && (
          <span className="review-flag ok">
            {sentLabel} · {clockTime(sentAt!)}
          </span>
        )}
        {state === "failed" && (
          <span className="review-flag bad" role="alert">Could not send, try again</span>
        )}
      </div>
    </div>
  );
}

function QuickActions({
  actions,
  onSend,
}: {
  actions: string[];
  onSend: SendText;
}) {
  const [sent, setSent] = useState<
    Record<string, "sending" | "sent" | "failed">
  >({});
  if (actions.length === 0) return null;
  return (
    <div className="quick-actions" role="group" aria-label="Quick actions">
      {actions.map((a) => (
        <button
          key={a}
          type="button"
          className="btn ghost small"
          disabled={sent[a] === "sending"}
          onClick={async () => {
            setSent((s) => ({ ...s, [a]: "sending" }));
            const ok = await onSend(a);
            setSent((s) => ({ ...s, [a]: ok ? "sent" : "failed" }));
          }}
        >
          {sent[a] === "sent" ? `✓ ${a}` : a}
        </button>
      ))}
    </div>
  );
}

// One open question, answered on its own (t103u: never in bulk, nothing preselected): agree with Assistant's
// suggestion for this one question, or type an own answer. Both go to the assistant.
function QuestionRow({
  q,
  prefix,
  onSend,
}: {
  q: PlanQuestion;
  prefix: string;
  onSend: SendText;
}) {
  const [state, setState] = useState<
    "idle" | "sending" | "accepted" | "answered" | "failed"
  >("idle");
  const [open, setOpen] = useState(false);
  const agree = async () => {
    setState("sending");
    const ok = await onSend(
      `${prefix}${q.id}: agree with Assistant${q.recommendation ? ` (${q.recommendation})` : ""}`,
    );
    setState(ok ? "accepted" : "failed");
  };
  // Already answered (his own earlier words) or replaced by another question: one line, never asked again.
  if (q.answered || q.superseded_by)
    return (
      <li className="question-row done" data-question-done={q.id}>
        <p className="question-head">
          <span className="q-id">{q.id}</span>
          <span className="q-text">{q.question}</span>
        </p>
        <p className="q-done">
          {q.answered ? (
            <>
              ✓ You already answered this: "{q.answered.text}" <span className="q-src">({q.answered.source})</span>
            </>
          ) : (
            <>Replaced by {q.superseded_by}</>
          )}
        </p>
      </li>
    );
  return (
    <li className={`question-row ${state}`}>
      <p className="question-head">
        <span className="q-id">{q.id}</span>
        <span className="q-text">{q.question}</span>
        {state === "accepted" && (
          <span className="review-flag posted">Agreed</span>
        )}
        {state === "answered" && (
          <span className="review-flag posted">Answered</span>
        )}
      </p>
      {q.context && <Markdown text={q.context} className="md q-context" />}
      {q.recommendation && (
        <p className="q-rec">
          <span className="q-rec-label">Assistant suggests:</span> {q.recommendation}
        </p>
      )}
      {q.body && (
        <button
          type="button"
          className="chev-btn small"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="chev" aria-hidden="true" />
          Full question
        </button>
      )}
      {open && q.body && <Markdown text={q.body} className="md q-body" />}
      <div className="q-actions">
        {q.recommendation && (
          <button
            type="button"
            className="btn small"
            disabled={state === "sending"}
            onClick={() => void agree()}
          >
            {state === "sending" ? "Sending..." : "Agree with Assistant"}
          </button>
        )}
        {state === "failed" && (
          <span className="review-flag bad">Could not send, try again</span>
        )}
      </div>
      <NoteBox
        label="Or type your own answer"
        button="Send to assistant"
        onSend={async (t) => {
          const ok = await onSend(`${prefix}${q.id}: ${t}`);
          if (ok) setState("answered");
          return ok;
        }}
      />
    </li>
  );
}

// What an expanded item shows. extra goes first (the item's own content, e.g. review drafts).
export function ItemDetails({
  detail,
  extra,
  actions,
  onSend,
  replyLabel = "Reply or give instructions",
  questionPrefix = "",
  itemKey,
  asks,
}: {
  detail?: ItemDetail;
  extra?: ReactNode;
  actions: string[];
  onSend: SendText;
  replyLabel?: string;
  // Starts each question answer, e.g. "PROJ-2512 ".
  questionPrefix?: string;
  // The item's detail key (e.g. pr:app/203): turns on the reply thread and remembers sent notes in it.
  itemKey?: string;
  // the owner's stored sends on this item (board.asks), for the reply thread.
  asks?: Ask[];
}) {
  const [noteVersion, setNoteVersion] = useState(0);
  const sendAndRemember: SendText = async (t) => {
    const ok = await onSend(t);
    if (ok && itemKey) {
      rememberMyNote(itemKey, { at: new Date().toISOString(), text: t });
      setNoteVersion((n) => n + 1);
    }
    return ok;
  };
  const [planOpen, setPlanOpen] = useState(false);
  const discussion = Array.isArray(detail?.discussion)
    ? detail!.discussion
    : [];
  return (
    <div className="item-details">
      {detail?.ticket && (
        <section className="item-ticket">
          <details>
            <summary>Full ticket</summary>
            <Markdown text={detail.ticket} className="md ticket-md" />
          </details>
        </section>
      )}
      {detail?.plain && (
        <section className="item-plain">
          <h4>In plain words</h4>
          <Markdown text={detail.plain} className="md" />
        </section>
      )}
      {detail?.ci_report && (
        <section className="item-ci">
          <Markdown text={detail.ci_report} className="md" />
        </section>
      )}
      {detail?.review_facts && (
        <section className="item-changes">
          <Markdown text={detail.review_facts} className="md" />
          {detail.review_plain && (
            <>
              <h4>In plain words</h4>
              <Markdown text={detail.review_plain} className="md" />
            </>
          )}
          {detail.review_scope && <Markdown text={detail.review_scope} className="md" />}
          {detail.review_questions && (
            <>
              <h4>Questions for you</h4>
              <Markdown text={detail.review_questions} className="md" />
            </>
          )}
          {detail.review_brief_sig !== detail.review_sig && (
            <p className="hint">
              {detail.review_plain
                ? "New review activity since this summary. Assistant will refresh it."
                : "Assistant will add a plain-words summary and questions on the next refresh."}
            </p>
          )}
        </section>
      )}
      {detail?.summary && (
        <Markdown text={detail.summary} className="md item-summary" />
      )}
      {extra}
      {Array.isArray(detail?.questions) && detail!.questions.length > 0 && (
        <section className="item-questions">
          <h4>Open questions</h4>
          <ul>
            {detail!.questions.map((q) => (
              <QuestionRow
                key={q.id}
                q={q}
                prefix={questionPrefix}
                onSend={onSend}
              />
            ))}
          </ul>
        </section>
      )}
      {detail?.plan && (
        <section className="item-plan">
          <button
            type="button"
            className="chev-btn"
            aria-expanded={planOpen}
            onClick={() => setPlanOpen((o) => !o)}
          >
            <span className="chev" aria-hidden="true" />
            Assistant's plan{detail.plan_file ? ` (${detail.plan_file})` : ""}
          </button>
          {planOpen && <Markdown text={detail.plan} className="md plan-md" />}
        </section>
      )}
      {discussion.length > 0 && (
        <section className="item-discussion">
          <h4>Discussion</h4>
          <ul>
            {discussion.map((d, i) => (
              <li key={i}>
                <p className="disc-head">
                  <strong>{d.author}</strong>
                  {d.at && <span className="disc-at">{d.at}</span>}
                  {d.link && (
                    <a
                      className="card-link"
                      href={d.link}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      open
                    </a>
                  )}
                </p>
                <Markdown text={d.body} className="md" />
              </li>
            ))}
          </ul>
        </section>
      )}
      {!detail?.ticket &&
        !detail?.plain &&
        !detail?.ci_report &&
        !detail?.thread?.length &&
        !detail?.review_facts &&
        !detail?.summary &&
        !detail?.plan &&
        !detail?.questions?.length &&
        discussion.length === 0 &&
        !extra && <p className="panel-empty">No details yet.</p>}
      <QuickActions
        actions={detail?.actions?.length ? detail.actions : actions}
        onSend={onSend}
      />
      {itemKey && <Thread itemKey={itemKey} thread={detail?.thread} asks={asks} onSend={sendAndRemember} version={noteVersion} />}
      <NoteBox label={replyLabel} onSend={sendAndRemember} />
    </div>
  );
}

// One board item as a row with a chevron. The title opens the focus page; the ↗ link opens the item itself.
export function ExpandableRow({
  itemId,
  section,
  title,
  sub,
  link,
  cells,
  badge,
  expanded,
  onToggle,
  onFocus,
  after,
  children,
}: {
  itemId: string;
  section: string;
  title: ReactNode;
  sub?: ReactNode;
  link?: string;
  cells: ReactNode;
  badge?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  onFocus: () => void;
  // Right side: the Message your assistant button and its status/composer.
  after: ReactNode;
  children: ReactNode;
}) {
  return (
    <li
      className={expanded ? "row xrow open" : "row xrow"}
      data-item-id={itemId}
      data-item-section={section}
    >
      <button
        type="button"
        className="chev-btn row-chev"
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse" : "Expand"}
        onClick={onToggle}
      >
        <span className="chev" aria-hidden="true" />
      </button>
      <div className="item">
        <span className="pr-cell">
          {sub && <span className="pr-ref">{sub}</span>}
          <span className="title-line">
            <button
              type="button"
              className="title-link title"
              onClick={onFocus}
            >
              {title}
            </button>
            {link && (
              <a
                className="ext-link"
                href={link}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Open link"
              >
                ↗
              </a>
            )}
            {badge}
          </span>
        </span>
        {cells}
      </div>
      {after}
      {expanded && <div className="row-expand">{children}</div>}
    </li>
  );
}

// The focus page: one item full width, with a Back link.
export function FocusView({
  backLabel,
  onBack,
  kind,
  title,
  sub,
  link,
  meta,
  children,
}: {
  backLabel: string;
  onBack: () => void;
  kind: string;
  title: ReactNode;
  sub?: ReactNode;
  link?: string;
  meta?: { label: string; value: ReactNode }[];
  children: ReactNode;
}) {
  return (
    <div className="view focus">
      <button type="button" className="back-link" onClick={onBack}>
        ← Back to {backLabel}
      </button>
      <header className="view-head focus-head">
        <p className="focus-kind">
          {kind}
          {sub && <span> · {sub}</span>}
        </p>
        <h1>{title}</h1>
        {link && (
          <a
            className="card-link"
            href={link}
            target="_blank"
            rel="noopener noreferrer"
          >
            {link}
          </a>
        )}
      </header>
      {meta && meta.length > 0 && (
        <dl className="focus-meta">
          {meta.map((m) => (
            <div key={m.label}>
              <dt>{m.label}</dt>
              <dd>{m.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <section className="panel focus-body">{children}</section>
    </div>
  );
}
