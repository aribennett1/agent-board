import { useState, type ReactNode } from "react";
import type { Decision } from "./data/types";
import { Link } from "./linkify";

export function FindingStatusLine({
  status,
  postedUrl,
  note,
  inline = false,
}: {
  status?: string;
  postedUrl?: string;
  note?: string;
  inline?: boolean;
}) {
  let body: ReactNode = null;
  if (status === "posted" || postedUrl) {
    body = (
      <>
        Posted
        {postedUrl ? (
          <>
            {" · "}
            <Link href={postedUrl}>view</Link>
          </>
        ) : null}
      </>
    );
  } else if (status === "skipped") {
    body = <>Not posted{note ? `: ${note}` : ""}</>;
  } else if (note) {
    body = <>{note}</>;
  }
  if (!body) return null;
  const Tag = inline ? "span" : "p";
  return (
    <Tag className={`finding-post-status${inline ? " inline" : ""}`} role="status">
      {body}
    </Tag>
  );
}

import { Markdown } from "./markdown";
import { CollapseChevron, useCollapsed } from "./collapse";
import { NoteBox } from "./ItemExpand";
import { AlreadyDecidedBanner } from "./PostApprovalBlock";
import {
  allFindingsAnswered,
  findingAnswerLabel,
  isFindingSettled,
  type FindingAction,
  type FindingAnswerMap,
  type FindingPick,
  type ReviewFinding,
  reviewFindings,
} from "./reviewFindings";

export type OnAnswerFinding = (
  d: Decision,
  finding: FindingPick,
  action: FindingAction,
  text?: string,
) => Promise<boolean>;

function locOf(c: { path?: string; line?: number }) {
  if (!c.path) return null;
  return c.line ? `${c.path}:${c.line}` : c.path;
}

export function FindingDraft({
  cardId,
  finding,
  answered,
  settled,
  onAnswer,
}: {
  cardId: string;
  finding: ReviewFinding;
  answered?: string;
  settled?: boolean;
  onAnswer: (action: FindingAction, text?: string) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState<"post" | "skip" | null>(null);
  const [error, setError] = useState(false);
  const [localSaid, setLocalSaid] = useState<string | undefined>();
  const loc = locOf(finding);
  const send = async (action: FindingAction, text?: string) => {
    if (busy) return false;
    if (action !== "note") setBusy(action);
    setError(false);
    let ok = false;
    try {
      ok = await onAnswer(action, text);
    } finally {
      if (action !== "note") setBusy(null);
    }
    if (ok) setLocalSaid(findingAnswerLabel(action, text));
    if (!ok) setError(true);
    return ok;
  };
  const rawSaid = localSaid ?? answered;
  const youSaid = rawSaid
    ? rawSaid.startsWith('"')
      ? rawSaid
      : `"${rawSaid}"`
    : null;
  const closed = Boolean(settled) || isFindingSettled(finding, rawSaid);
  // Settled findings start collapsed, open ones expanded; his own toggle wins.
  const [collapsed, toggle] = useCollapsed(`finding:${cardId}:${finding.n}`, closed);
  return (
    <div className={`post-comment-draft${closed ? " finding-answered" : ""}${collapsed ? " is-collapsed" : ""}`} data-finding={finding.n}>
      <div className="post-approval-head">
        <CollapseChevron collapsed={collapsed} onToggle={toggle} label={`finding #${finding.n}`} />
        <strong>{finding.label}</strong>
        {finding.severity && (
          <span className={`severity-chip severity-${finding.severity.toLowerCase()}`}>{finding.severity}</span>
        )}
        {finding.url && (
          <Link className="post-approval-link" href={finding.url}>
            View on GitHub
          </Link>
        )}
        {collapsed && loc && <code className="finding-collapsed-where">{loc}</code>}
        {collapsed && (
          <FindingStatusLine status={finding.status} postedUrl={finding.posted_url} note={finding.note} inline />
        )}
      </div>
      {collapsed ? null : <>
      {loc && (
        <p className="post-approval-meta">
          <code>{loc}</code>
        </p>
      )}
      {finding.summary && <p className="post-comment-summary">{finding.summary}</p>}
      {finding.answer_to_question ? (
        <div className="finding-you-said-wrap">
          {youSaid ? (
            <p className="finding-you-said" role="status">
              You asked {youSaid}
            </p>
          ) : null}
          <div className="finding-answer-block" role="status">
            <span className="finding-answer-label">Answer to your question</span>
            <Markdown text={finding.answer_to_question} className="finding-answer-body md" />
          </div>
        </div>
      ) : youSaid ? (
        <div className="finding-you-said-wrap">
          <p className="finding-you-said" role="status">
            You said {youSaid}
          </p>
          <FindingStatusLine status={finding.status} postedUrl={finding.posted_url} note={finding.note} />
          {finding.pending_bot && <p className="finding-waiting" role="status">Waiting for the assistant to rewrite this</p>}
        </div>
      ) : (
        <FindingStatusLine status={finding.status} postedUrl={finding.posted_url} note={finding.note} />
      )}
      {finding.context?.trim() ? (
        <div className="comment-context-block">
          <span className="comment-context-label">For you, not posted</span>
          <Markdown text={finding.context} className="md" />
        </div>
      ) : !closed ? (
        <p className="comment-context-missing" role="status">No context from the bot</p>
      ) : null}
      <div className="will-post-block">
        <span className="will-post-label">Will post</span>
        <div className="post-text-box">
          <Markdown text={finding.body} className="md" />
        </div>
      </div>
      {finding.answer_to_question ? (
        <FindingStatusLine status={finding.status} postedUrl={finding.posted_url} note={finding.note} />
      ) : null}
      {!closed && (
        <>
          <div className="finding-actions" role="group" aria-label={`Finding #${finding.n}`}>
            <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void send("post")}>
              {busy === "post" ? "Sending to assistant..." : "Post"}
            </button>
            <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => void send("skip")}>
              {busy === "skip" ? "Sending to assistant..." : "Don't post"}
            </button>
          </div>
          {error && (
            <p className="review-flag bad" role="alert">
              Could not send, try again
            </p>
          )}
          <NoteBox
            draftKey={`finding:${cardId}:${finding.n}`}
            label="Or write your own words"
            button="Send to assistant"
            onSend={(t) => send("note", t)}
          />
        </>
      )}
      </>}
    </div>
  );
}

export function ReviewFindingsBlock({
  decision,
  answered,
  onAnswer,
}: {
  decision: Decision;
  answered: FindingAnswerMap;
  onAnswer: OnAnswerFinding;
}) {
  const findings = reviewFindings(decision);
  if (findings.length === 0) return null;
  const skippedAll = answered.get("all");
  const open = findings.some((f) => !skippedAll && !isFindingSettled(f, answered.get(String(f.n))));
  const [allBusy, setAllBusy] = useState(false);
  const [allError, setAllError] = useState(false);
  const done = allFindingsAnswered(decision, undefined, answered);
  void done;
  return (
    <section className="review-findings" aria-label="Review comments">
      <AlreadyDecidedBanner decided={decision.already_decided} />
      <div className="post-approval-head">
        <span className="post-approval-kicker">Exact comments ({findings.length})</span>
      </div>
      <ol className="post-comments-list">
        {findings.map((f) => (
          <li key={f.n}>
            <FindingDraft
              cardId={decision.id}
              finding={f}
              answered={skippedAll ?? answered.get(String(f.n))}
              settled={Boolean(skippedAll) || isFindingSettled(f, skippedAll ?? answered.get(String(f.n)))}
              onAnswer={(action, text) => onAnswer(decision, f.n, action, text)}
            />
          </li>
        ))}
      </ol>
      {open && (
        <div className="dont-post-any">
          <button
            type="button"
            className="btn ghost"
            disabled={allBusy}
            onClick={() => {
              void (async () => {
                setAllBusy(true);
                setAllError(false);
                const ok = await onAnswer(decision, "all", "skip");
                if (!ok) setAllError(true);
                setAllBusy(false);
              })();
            }}
          >
            {allBusy ? "Sending to assistant..." : "Don't post any"}
          </button>
          <span className="hint">Sends one answer covering every comment still open on this card.</span>
          {allError && (
            <p className="review-flag bad" role="alert">
              Could not send, try again
            </p>
          )}
        </div>
      )}
    </section>
  );
}
