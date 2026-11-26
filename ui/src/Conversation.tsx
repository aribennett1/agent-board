import { useRef, useState, type ReactNode } from "react";
import type { Decision, ItemDetail, Priority, ReplyQuestion, TicketBrief as Brief } from "./data/types";
import { TicketBrief } from "./TicketBrief";
import type { AppChoice } from "./delivery";
import type { AnsweredQuestion, Topic, TopicQuestion } from "./topics";
import { summaryLine } from "./topics";
import { clockTime, NoteBox } from "./ItemExpand";
import { CardSvg, AssistantFacts, AssistantTable, DecisionCard, type ClarifyState, type NotRelevantState } from "./DecisionCard";
import { optionColorClass } from "./optionColor";
import { AlreadyDecidedBanner, PostApprovalBlock } from "./PostApprovalBlock";
import { FindingDraft, FindingStatusLine, type OnAnswerFinding } from "./ReviewFindingsBlock";
import { isFindingSettled } from "./reviewFindings";
import { Markdown } from "./markdown";
import { Checks } from "./Checks";
import { botPillClass, type BoardBot } from "./raisedBy";
import { DEFAULT_BOT, RecipientPicker } from "./sendTo";
import type { HistoryMsg } from "./topics";

// The landing view (t102u): one card per topic (ticket, PR or plan). Each card says what it is, what's happening and
// who has the ball, then "Your turn" with only the open questions (context inline, options, own words + mic), answered
// ones as one line, and the whole back-and-forth folded under "Show the thread", oldest first. Cards that need the owner come
// first; in-progress cards are folded; done cards hide behind a toggle. Every question renders once.

const when = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  return today ? clockTime(d) : `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${clockTime(d)}`;
};

export type Answerers = {
  onAnswerThread: (itemKey: string, q: ReplyQuestion, text: string, toBot?: string) => Promise<boolean>;
  onAnswerPlan: (itemKey: string, label: string, text: string, toBot?: string) => Promise<boolean>;
  onAnswerDecision: (d: Decision, pick: AppChoice, toBot?: string) => void;
  onAnswerFinding?: OnAnswerFinding;
};

/** Home keeps DecisionCard actions (priority, explain, not relevant) on decision questions. */
export type DecisionChrome = {
  onClarify?: (d: Decision) => void;
  clarify?: Record<string, ClarifyState>;
  now?: Date;
  onPriority?: (d: Decision, level: Priority) => void;
  priorityError?: Record<string, boolean>;
  onNotRelevant?: (d: Decision) => void;
  notRelevant?: Record<string, NotRelevantState>;
  staleCtx?: import("./triage").StaleContext;
  priorDecision?: (d: Decision) => Decision["already_decided"];
  findingAnswered?: (d: Decision) => import("./reviewFindings").FindingAnswerMap;
  extras?: (d: Decision) => { onFocus?: () => void; extra?: ReactNode; expanded?: boolean; onToggle?: () => void };
};

function Context({ text }: { text: string }) {
  const [more, setMore] = useState(false);
  const long = text.length > 750;
  return (
    <div className={`tq-context${long && !more ? " clamped" : ""}`}>
      <Markdown text={text} className="md" />
      {long && (
        <button type="button" className="link-btn" aria-expanded={more} onClick={() => setMore((m) => !m)}>
          {more ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}

export { RecipientPicker } from "./sendTo";

function OpenQuestionBox({ q, a, onDone }: { q: TopicQuestion; a: Answerers; onDone: (text: string, to?: string) => void }) {
  const [recipient, setRecipient] = useState<BoardBot | undefined>();
  const to: BoardBot = recipient ?? q.raisedBy ?? DEFAULT_BOT;
  // Only name a recipient in the payload when the card has a known author or one was picked.
  const toBot = recipient ?? q.raisedBy;
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [pickError, setPickError] = useState(false);
  const sending = useRef(false);
  const send = async (text: string) => {
    if (sending.current) return false;
    sending.current = true;
    let ok = false;
    setPickError(false);
    try {
      if (q.kind === "thread" && q.thread) ok = await a.onAnswerThread(q.itemKey, q.thread, text, toBot);
      else if (q.kind === "plan" && q.label) ok = await a.onAnswerPlan(q.itemKey, q.label, text, toBot);
      if (ok) onDone(text, to);
    } finally {
      if (!ok) sending.current = false;
    }
    return ok;
  };
  const pick = async (id: string, label: string) => {
    if (sending.current) return;
    setBusy(true);
    if (q.kind === "decision" && q.decision) {
      sending.current = true;
      a.onAnswerDecision(q.decision, id, toBot);
      onDone(label, to);
    } else {
      const ok = await send(label);
      if (!ok) setPickError(true);
    }
    setBusy(false);
  };
  const title = q.label && !q.text.startsWith(q.label) ? `${q.label}: ${q.text}` : q.text;
  if (q.kind === "finding" && q.finding && q.decision) {
    const d = q.decision;
    const f = q.finding;
    return (
      <li className="tq" data-question-uid={q.uid} data-finding={f.n}>
        <FindingDraft
          cardId={d.id}
          finding={f}
          answered={q.prior_answer}
          settled={isFindingSettled(f, q.prior_answer)}
          onAnswer={async (action, text) => {
            if (!a.onAnswerFinding) return false;
            const ok = await a.onAnswerFinding(d, f.n, action, text);
            // Only a Don't post closes the finding here. A note, or Post not yet on GitHub, stays open.
            if (ok && action === "skip") onDone("Don't post");
            return ok;
          }}
        />
      </li>
    );
  }
  return (
    <li className="tq" data-question-uid={q.uid}>
      <p className="tq-text">{q.raisedBy && <span className={botPillClass(q.raisedBy)}>{q.raisedBy}</span>}{q.raisedBy ? " " : ""}{title}</p>
      {q.context && q.context.trim() && q.context.trim() !== q.text.trim() && <Context text={q.context} />}
      <CardSvg src={q.svg ?? q.decision?.svg} />
      <AssistantFacts bot={q.bot} rule={q.rule} seen={q.seen} proposed_fix={q.proposed_fix} />
      <AssistantTable fixes={q.fixes} />
      {q.image && <img className="thread-image" src={q.image} alt={q.image_alt ?? "Diagram"} />}
      {q.suggestion && (
        <p className="tq-hint">
          <span className="tq-hint-label">Assistant suggests:</span> {q.suggestion}
        </p>
      )}
      {q.decision?.recommendation && (
        <p className="tq-hint" data-rec-id={q.decision.recommendation.id}>
          <span className="tq-hint-label">{q.decision.recommendation.who ?? "Assistant"} recommends:</span>{" "}
          {q.decision.recommendation.reason}
        </p>
      )}
      <AlreadyDecidedBanner decided={q.already_decided} />
      <PostApprovalBlock answersComment={q.answers_comment} postText={q.post_text} currentText={q.current_text} postComments={q.post_comments} options={q.options} lede={q.decision?.glance?.asking} />
      {q.decision?.sha && (
        <p className="card-chips">
          <span className="sha-chip" title={q.decision.sha}>
            Commit <code>{q.decision.sha}</code>
          </span>
        </p>
      )}
      {q.options.length > 0 && !q.decision?.multiSelect && (
        <div className="tq-options" role="group" aria-label={title}>
          {q.options.map((o) => (
            <button key={o.id} type="button" className={["btn", "ghost", optionColorClass(o.id)].filter(Boolean).join(" ")} disabled={busy} onClick={() => void pick(o.id, o.label)}>
              {o.label}
            </button>
          ))}
        </div>
      )}
      {q.options.length > 0 && q.decision?.multiSelect && (
        <div className="tq-options" role="group" aria-label={title}>
          {q.options.map((o) => (
            <button
              key={o.id}
              type="button"
              className={["btn", "toggle", optionColorClass(o.id)].filter(Boolean).join(" ")}
              aria-pressed={picked.includes(o.id)}
              disabled={busy}
              onClick={() => setPicked((p) => (p.includes(o.id) ? p.filter((x) => x !== o.id) : [...p, o.id]))}
            >
              {o.label}
            </button>
          ))}
          <button
            type="button"
            className="btn"
            disabled={busy || picked.length === 0}
            onClick={() => {
              if (sending.current || !q.decision || picked.length === 0) return;
              sending.current = true;
              setBusy(true);
              const labels = q.options.filter((o) => picked.includes(o.id)).map((o) => o.label).join(", ");
              a.onAnswerDecision(q.decision, picked, toBot);
              onDone(labels, to);
              setBusy(false);
            }}
          >
            Send to {to}
          </button>
        </div>
      )}
      {pickError && <p className="review-flag bad" role="alert">Could not send, try again</p>}
      <NoteBox
        draftKey={q.uid}
        label={q.options.length ? "Or answer in your own words" : "Your answer"}
        button={`Send to ${to}`}
        sendingLabel={`Sending to ${to}...`}
        sentLabel={`Sent to ${to}`}
        extra={<RecipientPicker value={to} onChange={setRecipient} />}
        onSend={async (t) => {
          if (q.kind === "decision" && q.decision) {
            a.onAnswerDecision(q.decision, { custom: t }, toBot);
            onDone(t, to);
            return true;
          }
          return send(t);
        }}
      />
    </li>
  );
}

function DontPostAny({
  open,
  a,
  onDone,
}: {
  open: TopicQuestion[];
  a: Answerers;
  onDone: (uid: string, text: string) => void;
}) {
  const findings = open.filter((q) => q.kind === "finding" && q.decision);
  const d = findings[0]?.decision;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!d || !a.onAnswerFinding || findings.length === 0) return null;
  return (
    <div className="dont-post-any">
      <button
        type="button"
        className="btn ghost"
        disabled={busy}
        onClick={() => {
          void (async () => {
            setBusy(true);
            setError(false);
            const ok = await a.onAnswerFinding!(d, "all", "skip");
            if (ok) for (const q of findings.filter((q) => q.decision?.id === d.id)) onDone(q.uid, "Don't post any");
            else setError(true);
            setBusy(false);
          })();
        }}
      >
        {busy ? "Sending to assistant..." : "Don't post any"}
      </button>
      <span className="hint">Sends one answer covering every comment still open on this card.</span>
      {error && (
        <p className="review-flag bad" role="alert">
          Could not send, try again
        </p>
      )}
    </div>
  );
}

// One message in a topic's thread. The assistant's replies and the human's notes are chat bubbles (Markdown); an answered
// decision card is one line, title and answer, that opens to its question. The human's own messages carry the checks.
function ThreadMessage({ m }: { m: HistoryMsg }) {
  const [open, setOpen] = useState(false);
  const mine = m.who === "You";
  const checks = mine && m.status ? <Checks status={m.status} /> : null;
  if (m.card) {
    return (
      <li className="msg msg-you msg-card" data-thread-card>
        <button type="button" className="msg-card-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {m.card.raisedBy && <span className={botPillClass(m.card.raisedBy)}>{m.card.raisedBy}</span>}
          <span className="msg-card-title">{m.card.title}</span>
          <span className="msg-card-answer">{m.card.answer}</span>
          {m.card.to && <span className="msg-to">→ {m.card.to}</span>}
          {checks}
        </button>
        {open && m.card.body && <Markdown text={m.card.body} className="md msg-text" />}
      </li>
    );
  }
  return (
    <li className={`msg msg-${mine ? "you" : "bot"}`}>
      <p className="msg-who">
        {m.who}
        {m.to ? <span className="msg-to"> → {m.to}</span> : null} <span className="msg-at">{when(m.at)}</span>
        {checks}
      </p>
      <Markdown text={m.text} className="md msg-text" />
    </li>
  );
}

// The read-only view of the same record in its own tab (same board payload, filtered there).
const TAB_OF: Record<string, [string, string]> = { ticket: ["home", "Home"], waiting: ["home", "Home"], mypr: ["mine", "My PRs"], pr: ["others", "Others' PRs"], decision: ["home", "Home"] };
const tabOf = (key: string) => TAB_OF[key.split(":")[0]] ?? TAB_OF.decision;

const BALL_CLASS = (ball: string) => (ball === "You" ? "you" : ball === "Done" ? "done" : ball === "Assistant" ? "bot" : "others");


function HomeDecision({ d, a, chrome, onDone, index }: { d: Decision; a: Answerers; chrome: DecisionChrome; onDone: (text: string, to?: string) => void; index: number }) {
  const said = (pick: AppChoice) => {
    if (typeof pick === "string") return d.options.find((o) => o.id === pick)?.label ?? pick;
    if (Array.isArray(pick)) return pick.map((id) => d.options.find((o) => o.id === id)?.label ?? id).join(", ");
    return pick.custom;
  };
  const extras = chrome.extras?.(d) ?? {};
  return (
    <DecisionCard
      decision={d}
      index={index}
      enableSendTo
      onAnswer={(card, pick, toBot) => {
        a.onAnswerDecision(card, pick, toBot);
        onDone(said(pick), toBot);
      }}
      onClarify={chrome.onClarify}
      clarify={chrome.clarify?.[d.id]}
      now={chrome.now}
      onPriority={chrome.onPriority}
      priorityError={Boolean(chrome.priorityError?.[d.id])}
      onNotRelevant={chrome.onNotRelevant}
      notRelevant={chrome.notRelevant?.[d.id]}
      staleCtx={chrome.staleCtx}
      priorDecision={chrome.priorDecision?.(d)}
      onAnswerFinding={a.onAnswerFinding}
      findingAnswered={chrome.findingAnswered?.(d)}
      {...extras}
    />
  );
}

function TopicCard({ t, a, onOpen, sent, sentTo, markSent, brief, detail, chrome }: { t: Topic; a: Answerers; onOpen: (key: string) => void; sent: Record<string, string>; sentTo: Record<string, string>; markSent: (uid: string, text: string, to?: string) => void; brief?: Brief; detail?: ItemDetail; chrome?: DecisionChrome }) {
  const [history, setHistory] = useState(t.group !== "done");
  const open = t.open.filter((q) => !(q.uid in sent));
  const justSent: AnsweredQuestion[] = t.open.filter((q) => q.uid in sent).map((q) => ({
    uid: q.uid,
    label: q.label,
    text: q.text,
    answer: sent[q.uid],
    ...(sentTo[q.uid] ? { to: sentTo[q.uid] } : {}),
    ...(q.finding?.status ? { status: q.finding.status } : {}),
    ...(q.finding?.posted_url ? { posted_url: q.finding.posted_url } : {}),
    ...(q.finding?.note ? { note: q.finding.note } : {}),
  }));
  const answered = [...t.answered, ...justSent];
  const ids = open.map((q) => q.label).filter(Boolean);
  const latestBot = [...t.history].reverse().find((m) => m.who !== "You" && m.text?.trim());
  return (
    <article className={`topic topic-${t.group}`} data-topic={t.key}>
      <header className="topic-head">
        <div className="topic-head-left">
          {t.raisedBy && <span className={botPillClass(t.raisedBy)}>{t.raisedBy}</span>}
          <button type="button" className="topic-title" onClick={() => onOpen(t.keys.find((k) => k === t.key) ?? t.keys[0])} title="Open this item">
            {t.label}
          </button>
        </div>
        {tabOf(t.key)[0] !== "home" && (
          <a className="topic-tab-link" href={`#${tabOf(t.key)[0]}`}>
            {tabOf(t.key)[1]}
          </a>
        )}
        <span className={`ball ball-${BALL_CLASS(open.length ? "You" : t.ball === "You" ? "Assistant" : t.ball)}`}>
          {open.length ? "Your turn" : t.ball === "Done" ? "Done" : t.ball === "You" ? "Assistant" : t.ball}
        </span>
      </header>
      {t.summary && <p className="topic-summary">{t.summary}</p>}
      {brief ? (
        <TicketBrief brief={brief} defaultOpen={true} />
      ) : detail?.plain ? (
        <div className="topic-plain">
          <Markdown text={detail.plain} className="md" />
        </div>
      ) : null}
      {detail?.ticket && (
        <details className="item-ticket topic-full-ticket">
          <summary>Full ticket</summary>
          <Markdown text={detail.ticket} className="md ticket-md" />
        </details>
      )}
      {latestBot && (
        <div className="topic-explain" data-bot-explain>
          <p className="msg-who">{latestBot.who}{latestBot.at ? <span className="msg-at"> {when(latestBot.at)}</span> : null}</p>
          <Markdown text={latestBot.text} className="md msg-text" />
        </div>
      )}
      {open.length === 0 && <p className="topic-status">{t.ball === "You" ? "Assistant has your answers." : t.statusLine}</p>}
      {open.length > 0 && (
        <section className="your-turn" aria-label={`Your turn on ${t.label}`}>
          <h4>
            Your turn: {open.length} open{ids.length ? `: ${ids.join(", ")}` : ""}
          </h4>
          <ol className="tq-list">
            {open.map((q) =>
              chrome && q.kind === "decision" && q.decision ? (
                <li key={q.uid} className="tq tq-decision" data-question-uid={q.uid}>
                  <HomeDecision d={q.decision} a={a} chrome={chrome} onDone={(text, to) => markSent(q.uid, text, to)} index={Math.max(1, t.open.indexOf(q) + 1)} />
                </li>
              ) : (
                <OpenQuestionBox key={q.uid} q={q} a={a} onDone={(text, to) => markSent(q.uid, text, to)} />
              ),
            )}
          </ol>
          <DontPostAny open={open} a={a} onDone={(uid, text) => markSent(uid, text)} />
        </section>
      )}
      {answered.length > 0 && (
        <ul className="answered" aria-label="Answered">
          {answered.map((q) => (
            <li key={q.uid} data-answered-uid={q.uid}>
              ✓ {q.label ? `${q.label}: ` : ""}
              <span className="answered-q">{q.label ? q.text.replace(new RegExp(`^${q.label}\\s*[:.]\\s*`), "") : q.text}</span> <span className="answered-a">you said {q.answer.startsWith('"') ? q.answer : `"${q.answer}"`}</span>{q.to && <span className="msg-to"> → sent to {q.to}</span>}
              <FindingStatusLine status={q.status} postedUrl={q.posted_url} note={q.note} inline />
            </li>
          ))}
        </ul>
      )}
      {t.history.length > 0 && (
        <>
          <button type="button" className="link-btn" aria-expanded={history} onClick={() => setHistory((h) => !h)}>
            {history ? "Hide the thread" : `Show the thread (${t.history.length})`}
          </button>
          {history && (
            <ol className="history">
              {t.history.map((m, i) => (
                <ThreadMessage key={i} m={m} />
              ))}
            </ol>
          )}
        </>
      )}
    </article>
  );
}

// One collapsible section per asking bot, plus Unknown for cards with no author data. Collapse state is remembered locally.
const COLLAPSE_KEY = "agent-board:convo-collapsed";
export const UNKNOWN = "Unknown";
export const SECTION_ORDER: string[] = ["Planner", "QA", "Engineer", "dr eggbot", "Grok Bot", UNKNOWN];

function loadCollapsed(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(COLLAPSE_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Answering a card removes it from the page, so go back to the top the moment he sends.
export function scrollToTop() {
  try {
    window.scrollTo?.(0, 0);
    document.querySelector(".content")?.scrollTo?.(0, 0);
  } catch {
    // jsdom and old browsers: nothing to scroll
  }
}

function BotSection({ name, open, collapsed, onToggle, topics, card }: { name: string; open: number; collapsed: boolean; onToggle: () => void; topics: Topic[]; card: (t: Topic) => ReactNode }) {
  const [showProgress, setShowProgress] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const mine = topics.filter((t) => t.group === "you");
  const progress = topics.filter((t) => t.group === "progress");
  const done = topics.filter((t) => t.group === "done");
  return (
    <section className="bot-section" aria-label={name} data-bot-section={name}>
      <button type="button" className="bot-section-head" aria-expanded={!collapsed} onClick={onToggle}>
        <span className="chev" aria-hidden="true" />
        <span className="bot-section-name">{name}</span>
        <span className={open ? "bot-section-count open" : "bot-section-count"}>{open} open</span>
      </button>
      {!collapsed && (
        <div className="bot-section-body">
          {mine.length === 0 ? <p className="panel-empty">Nothing needs you here.</p> : mine.map(card)}
          {progress.length > 0 && (
            <div className="topic-group">
              <button type="button" className="group-toggle" aria-expanded={showProgress} onClick={() => setShowProgress((x) => !x)}>
                In progress ({progress.length})
              </button>
              {showProgress && progress.map(card)}
            </div>
          )}
          {done.length > 0 && (
            <div className="topic-group">
              <button type="button" className="group-toggle" aria-expanded={showDone} onClick={() => setShowDone((x) => !x)}>
                {showDone ? "Hide done" : `Show done (${done.length})`}
              </button>
              {showDone && done.map(card)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function Conversation({ topics, onOpen, briefs, details, chrome, ...a }: { topics: Topic[]; onOpen: (itemKey: string) => void; briefs?: Record<string, Brief>; details?: Record<string, ItemDetail>; chrome?: DecisionChrome } & Answerers) {
  const [sent, setSent] = useState<Record<string, string>>({});
  const [sentTo, setSentTo] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<string[]>(loadCollapsed);
  const markSent = (uid: string, text: string, to?: string) => {
    setSent((s) => ({ ...s, [uid]: text }));
    if (to) setSentTo((s) => ({ ...s, [uid]: to }));
    scrollToTop();
  };
  const toggle = (name: string) =>
    setCollapsed((c) => {
      const next = c.includes(name) ? c.filter((x) => x !== name) : [...c, name];
      try {
        window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable: the section still toggles
      }
      return next;
    });
  const live = topics.map((t) => ({ ...t, open: t.open.filter((q) => !(q.uid in sent)) }));
  const card = (t: Topic) => <TopicCard key={t.key} t={t} a={a} onOpen={onOpen} sent={sent} sentTo={sentTo} markSent={markSent} brief={briefs?.[t.key]} detail={details?.[t.key] ?? t.keys.map((k) => details?.[k]).find(Boolean)} chrome={chrome} />;
  const nameOf = (t: Topic) => t.raisedBy ?? UNKNOWN;
  const names = SECTION_ORDER.filter((n) => topics.some((t) => nameOf(t) === n));
  return (
    <div className="view convo">
      <p className="convo-summary" role="status">
        {summaryLine(live)}
      </p>
      {names.length === 0 && <p className="panel-empty">Nothing needs you here.</p>}
      {names.map((n) => (
        <BotSection
          key={n}
          name={n}
          open={live.filter((t) => nameOf(t) === n).reduce((c, t) => c + t.open.length, 0)}
          collapsed={collapsed.includes(n)}
          onToggle={() => toggle(n)}
          topics={topics.filter((t) => nameOf(t) === n)}
          card={card}
        />
      ))}
    </div>
  );
}
