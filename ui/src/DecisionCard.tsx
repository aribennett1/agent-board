import { useRef, useState, type ReactNode } from "react";
import { MicButton } from "./MicButton";
import type { AlreadyDecided, Decision, DetailSection, Priority } from "./data/types";
import { AlreadyDecidedBanner, PostApprovalBlock } from "./PostApprovalBlock";
import { isCommentEdit } from "./commentDiff";
import { ReviewFindingsBlock, type OnAnswerFinding } from "./ReviewFindingsBlock";
import type { FindingAnswerMap } from "./reviewFindings";
import { isPerFindingReview } from "./reviewFindings";
import type { AppChoice } from "./delivery";
import { ASSISTANT_NAME } from "./config";
import { bareUrl, Link, linkify } from "./linkify";
import { inline } from "./markdown";
import { effectivePriority, PRIORITIES, PRIORITY_LABEL } from "./priority";
import { sanitizeSvg } from "./sanitizeSvg";
import { stampOf } from "./stamp";
import { ContextBody } from "./contextBody";
import { GlanceHeader, Recommendation, DraftToggle } from "./GlanceHeader";
import { optionColorClass } from "./optionColor";
import { cardStale, effectiveTier, TIER_LABEL, waitingLabel, type StaleContext } from "./triage";

// "Explain this better" for one card: sending, sent and waiting for the assistant to reword it, or the last send failed.
export type ClarifyState =
  | { status: "sending" }
  | { status: "rewording"; snapshot: string }
  | { status: "failed"; http: number | null };

// "Not relevant anymore" for one card: telling the assistant and clearing it ("sending"), cleared and waiting for the live
// board to drop it ("clearing"), or the last try failed. sent: the webhook already got a 2xx, so a retry only clears.
export type NotRelevantState =
  | { status: "sending"; sent: boolean }
  | { status: "clearing" }
  | { status: "failed"; sent: boolean };

type Props = {
  decision: Decision;
  index: number;
  onAnswer: (d: Decision, pick: AppChoice) => void;
  onClarify?: (d: Decision) => void;
  clarify?: ClarifyState;
  // The board's shared clock (useNow); the current time when absent.
  now?: Date;
  // A tap on a priority segment that is not the active one.
  onPriority?: (d: Decision, level: Priority) => void;
  // The last priority save for this card failed.
  priorityError?: boolean;
  // "Not relevant anymore": tells the assistant, then clears the card from the board.
  onNotRelevant?: (d: Decision) => void;
  notRelevant?: NotRelevantState;
  // Clicking the title opens the card on its own page (focus mode).
  onFocus?: () => void;
  // The chevron section under the answers: details, plan, discussion. Hidden until expanded.
  extra?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  staleCtx?: StaleContext;
  priorDecision?: AlreadyDecided;
  // Per-finding answers on an ops review card. Absent on ordinary cards.
  onAnswerFinding?: OnAnswerFinding;
  findingAnswered?: FindingAnswerMap;
};


type Block = { label?: string; items: string[]; ordered?: boolean };

// Rule, what was seen, proposed fix, and which bot — shown on Dr. Assistant cards (and in Conversation).
export function AssistantFacts({ bot, rule, seen, proposed_fix }: { bot?: string; rule?: string; seen?: string; proposed_fix?: string }) {
  if (!bot && !rule && !seen && !proposed_fix) return null;
  const row = (dt: string, dd?: string) =>
    dd?.trim() ? (
      <div>
        <dt>{dt}</dt>
        <dd>{inline(dd, dt)}</dd>
      </div>
    ) : null;
  return (
    <dl className="assistant-fields">
      {row("Bot", bot)}
      {row("Rule", rule)}
      {row("What was seen", seen)}
      {row("Proposed fix", proposed_fix)}
    </dl>
  );
}

export function AssistantTable({ fixes }: { fixes?: { id: string; seen: string; proposed: string }[] }) {
  if (!fixes?.length) return null;
  return (
    <div className="assistant-table-wrap">
      <table className="assistant-table">
        <thead>
          <tr>
            <th scope="col">Id</th>
            <th scope="col">What was seen</th>
            <th scope="col">Proposed change</th>
          </tr>
        </thead>
        <tbody>
          {fixes.map((f) => (
            <tr key={f.id}>
              <th scope="row">{f.id}</th>
              <td>{inline(f.seen, `seen-${f.id}`)}</td>
              <td>{inline(f.proposed, `fix-${f.id}`)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A small sanitized SVG diagram on a card (and in Conversation). Scripts and outside links are stripped.
export function CardSvg({ src }: { src?: string }) {
  const clean = src ? sanitizeSvg(src) : null;
  if (!clean) return null;
  return (
    <figure className="card-diagram">
      <div className="card-svg" role="img" dangerouslySetInnerHTML={{ __html: clean }} />
    </figure>
  );
}

// Groups details into lists: consecutive bare strings share one unlabeled list, each object is its own
// labeled list. Malformed entries (a bad hand edit of board.ts) are skipped so they cannot crash the card.
function detailBlocks(details: unknown): Block[] {
  if (!Array.isArray(details)) return [];
  const blocks: Block[] = [];
  for (const e of details) {
    if (typeof e === "string") {
      if (!e.trim()) continue;
      const last = blocks[blocks.length - 1];
      if (last && last.label === undefined) last.items.push(e);
      else blocks.push({ items: [e] });
    } else if (e && typeof e === "object") {
      const { label, items, ordered } = e as DetailSection;
      if (typeof label !== "string" || !label.trim() || !Array.isArray(items))
        continue;
      const kept = items.filter((x) => typeof x === "string" && x.trim());
      if (kept.length)
        blocks.push({ label, items: kept, ordered: ordered === true });
    }
  }
  return blocks;
}

// Single-select: one click answers. Multi-select: options toggle and "Send to assistant" confirms.
// Every card has a free-text field (with a mic) so the user can answer in their own words.
export function DecisionCard({
  decision,
  index,
  onAnswer,
  onClarify,
  clarify,
  now,
  onPriority,
  priorityError,
  onNotRelevant,
  notRelevant,
  onFocus,
  extra,
  expanded,
  onToggle,
  staleCtx,
  priorDecision,
  onAnswerFinding,
  findingAnswered,
}: Props) {
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const customField = useRef<HTMLInputElement>(null);
  const multi = Boolean(decision.multiSelect);
  const custom = text.trim();
  const qid = `q-${decision.id}`;
  const tid = `t-${decision.id}`;
  const title = decision.title?.trim() ? decision.title : null;
  const blocks = detailBlocks(decision.details);
  // "Today" follows the shared clock, so a stamp gains its date after midnight Eastern with no new board data.
  const stamp = stampOf(decision, now ?? new Date());
  const clock = now ?? new Date();
  const stale = cardStale(decision, staleCtx);
  const waiting = waitingLabel(decision.created_at, clock);
  const tier = effectiveTier(decision);
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const priority = effectivePriority(decision);

  return (
    <article
      className={decision.section === "assistant" ? "card assistant-card" : "card"}
      data-decision-id={decision.id}
      data-priority={priority}
      data-tier={tier}
      data-section={decision.section ?? "home"}
      data-stale={stale.stale ? "true" : undefined}
      aria-labelledby={title ? `${tid} ${qid}` : qid}
    >
      {stale.stale && (
        <p className="superseded-banner" role="status">
          Superseded{stale.reason ? `: ${stale.reason}` : "."} This is not an open ask.
        </p>
      )}
      {title && (
        <h3 className="card-title" id={tid}>
          {onFocus ? (
            <button type="button" className="title-link" onClick={onFocus}>
              {title}
            </button>
          ) : (
            title
          )}
        </h3>
      )}
      {(decision.tier || decision.estimate || decision.sha) && (
        <div className="card-chips">
          {(decision.tier || decision.estimate) && (
            <span className={`tier-pill tier-${tier}`}>{TIER_LABEL[tier]}</span>
          )}
          {decision.estimate && <span className="estimate-chip">{decision.estimate}</span>}
          {decision.sha && (
            <span className="sha-chip" title={decision.sha}>
              Commit <code>{decision.sha}</code>
            </span>
          )}
          {waiting && <span className="waiting-chip">{waiting}</span>}
        </div>
      )}
      {isCommentEdit(decision) && (decision.glance?.asking?.trim() || decision.question) && (
        <p className="edit-lede">{linkify(decision.glance?.asking?.trim() || decision.question)}</p>
      )}
      <ContextBody text={decision.context} />
      {decision.joke?.trim() && <p className="joke">{decision.joke}</p>}
      <CardSvg src={decision.svg} />
      <GlanceHeader glance={decision.glance} />
      <Recommendation decision={decision} />
      <DraftToggle draft={decision.draft} />
      <AssistantFacts bot={decision.bot} rule={decision.rule} seen={decision.seen} proposed_fix={decision.proposed_fix} />
      <AssistantTable fixes={decision.fixes} />
      <div className="card-top">
        <span className="idx" aria-hidden="true">
          {index}
        </span>
        <p className="question" id={qid}>
          {linkify(decision.question)}
        </p>
        {/* Top right: when the card came in, the priority control, "Explain this better", then the status lines. */}
        <div className="card-meta">
          {stamp && (
            <p className="stamp">
              <time dateTime={stamp.iso} title={stamp.full}>
                {stamp.verb} {stamp.when}
              </time>
            </p>
          )}
          {/* Priority: the active segment is the badge (its color and its label). Tapping another one changes it. */}
          <div className="priority" role="group" aria-label="Priority">
            {PRIORITIES.map((p) => (
              <button
                key={p}
                type="button"
                className={`priority-seg priority-${p}`}
                aria-pressed={p === priority}
                onClick={() => p !== priority && onPriority?.(decision, p)}
              >
                {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="clarify-btn"
            disabled={
              clarify?.status === "sending" || clarify?.status === "rewording"
            }
            onClick={() => onClarify?.(decision)}
          >
            <svg
              className="clarify-icon"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M6 0.5C6.4 3.6 8.4 5.6 11.5 6 8.4 6.4 6.4 8.4 6 11.5 5.6 8.4 3.6 6.4 0.5 6 3.6 5.6 5.6 3.6 6 0.5Z" />
            </svg>
            Explain this better
          </button>
          {clarify?.status === "rewording" && (
            <p className="clarify-status" role="status">
              Rewording...
            </p>
          )}
          {clarify?.status === "failed" && (
            <p className="clarify-error" role="alert">
              {clarify.http === null
                ? "Could not send. Try again."
                : `Could not send (HTTP ${clarify.http}). Try again.`}
            </p>
          )}
          {priorityError && (
            <p className="priority-error" role="alert">
              Could not save priority. Try again.
            </p>
          )}
        </div>
      </div>
      {isCommentEdit(decision) && (
        <PostApprovalBlock
          answersComment={decision.answers_comment}
          postText={decision.post_text}
          currentText={decision.current_text}
          postComments={decision.post_comments}
          options={decision.options}
        />
      )}
      {blocks.length > 0 && (
        <div className="details">
          {blocks.map((b, i) => {
            const List = b.ordered ? "ol" : "ul";
            return (
              <div key={i} className="details-block">
                {b.label !== undefined && (
                  <p className="details-label">{linkify(b.label)}</p>
                )}
                <List>
                  {b.items.map((t, j) => (
                    <li key={j}>{inline(t, `d-${i}-${j}`)}</li>
                  ))}
                </List>
              </div>
            );
          })}
        </div>
      )}
      <p className="after">
        <span className="after-label">After you answer:</span>{" "}
        {linkify(decision.what_happens_after)}
      </p>

      <AlreadyDecidedBanner decided={decision.already_decided ?? priorDecision} />
      {isPerFindingReview(decision) ? (
        <ReviewFindingsBlock
          decision={decision}
          answered={findingAnswered ?? new Map()}
          onAnswer={onAnswerFinding ?? (async () => false)}
        />
      ) : (
        <>
      {!isCommentEdit(decision) && (
      <PostApprovalBlock answersComment={decision.answers_comment} postText={decision.post_text} postComments={decision.post_comments} options={decision.options} />
      )}

      <div className="options" role="group" aria-labelledby={qid}>
        {decision.options.map((o) =>
          multi ? (
            <button
              key={o.id}
              type="button"
              className={["btn", "toggle", optionColorClass(o.id)].filter(Boolean).join(" ")}
              aria-pressed={picked.includes(o.id)}
              onClick={() => toggle(o.id)}
            >
              <span className="box" aria-hidden="true" />
              {o.label}
            </button>
          ) : (
            <button
              key={o.id}
              type="button"
              className={["btn", "ghost", optionColorClass(o.id)].filter(Boolean).join(" ")}
              onClick={() => onAnswer(decision, o.id)}
            >
              {o.label}
            </button>
          ),
        )}
      </div>

      {multi && (
        <div className="submit-row">
          <button
            type="button"
            className="btn"
            disabled={picked.length === 0}
            onClick={() => onAnswer(decision, picked)}
          >
            Send to assistant
          </button>
          <span className="hint">
            {picked.length === 0
              ? "Pick one or more"
              : `${picked.length} of ${decision.options.length} selected`}
          </span>
        </div>
      )}

      {/* Every card takes a free-form answer (typed or dictated), even when it lists options. */}
      {(
        <form
          className="custom"
          onSubmit={(e) => {
            e.preventDefault();
            if (custom) onAnswer(decision, { custom });
          }}
        >
          <span className="mic-wrap inline">
            <input
              ref={customField}
              className="custom-input"
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Single-line field: only a plain Enter answers, through the form like Send to assistant. Enter with a
                // modifier does nothing (browsers would otherwise submit on Shift/Ctrl+Enter), nor does IME Enter.
                if (
                  e.key !== "Enter" ||
                  e.nativeEvent.isComposing ||
                  e.keyCode === 229
                )
                  return;
                e.preventDefault();
                if (!(e.shiftKey || e.metaKey || e.ctrlKey || e.altKey))
                  e.currentTarget.form?.requestSubmit();
              }}
              aria-label="Your own answer"
              placeholder="None of these? Write your own answer"
            />
            <MicButton field={customField} value={text} onChange={setText} />
          </span>
          <button type="submit" className="btn" disabled={!custom}>
            Send to assistant
          </button>
        </form>
      )}
        </>
      )}

      {extra && (
        <div className="card-expand">
          <button
            type="button"
            className="chev-btn"
            aria-expanded={Boolean(expanded)}
            onClick={onToggle}
          >
            <span className="chev" aria-hidden="true" />
            {expanded ? "Hide details" : "Details, plan and discussion"}
          </button>
          {expanded && <div className="card-extra">{extra}</div>}
        </div>
      )}

      {/* Footer: the evidence link on the left, "Not relevant anymore" at the bottom right, away from the answers. */}
      <div className="card-foot">
        {decision.card_ref && <CardRef text={decision.card_ref} />}
        <div className="not-relevant">
          {(notRelevant?.status === "sending" ||
            notRelevant?.status === "clearing") && (
            <p className="not-relevant-status" role="status">
              Clearing...
            </p>
          )}
          {notRelevant?.status === "failed" && (
            <p className="not-relevant-error" role="alert">
              {notRelevant.sent
                ? `Sent to ${ASSISTANT_NAME}, but could not clear. Try again.`
                : "Could not send. Try again."}
            </p>
          )}
          <button
            type="button"
            className="not-relevant-btn"
            disabled={
              notRelevant?.status === "sending" ||
              notRelevant?.status === "clearing"
            }
            onClick={() => onNotRelevant?.(decision)}
          >
            Not relevant anymore
          </button>
        </div>
      </div>
    </article>
  );
}

// A bare URL ref is itself the link, keeping the .evidence look. Other refs stay a span, with any URLs inside linked.
function CardRef({ text }: { text: string }) {
  const url = bareUrl(text);
  if (url)
    return (
      <Link className="evidence" href={url}>
        {text}
      </Link>
    );
  return <span className="evidence">{linkify(text)}</span>;
}
