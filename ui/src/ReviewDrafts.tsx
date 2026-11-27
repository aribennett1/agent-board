import { useRef, useState } from "react";
import { MicButton } from "./MicButton";
import { decodeEntities, postText } from "./entities";
import type { ReviewComment, ReviewDraft } from "./data/types";
import type { ReviewAction } from "./delivery";
import { clockTime, NoteBox } from "./ItemExpand";
import { Markdown } from "./markdown";
import { CollapseChevron, useCollapsed } from "./collapse";

// Per-comment state in the app: an answer in flight, the last answer that went through, or a failed send.
export type ReviewLocal = {
  status: "sending" | "posted" | "skipped" | "noted" | "failed";
  action?: ReviewAction;
  // When the answer went through (ISO).
  at?: string;
};

// Icons that keep the two destinations apart: a chat bubble for Assistant, the GitHub mark for GitHub.
export const ChatIcon = () => (
  <svg className="btn-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
    <path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v6a1.5 1.5 0 0 1-1.5 1.5H7l-3.2 2.6A.5.5 0 0 1 3 13.2V11h0.5A1.5 1.5 0 0 1 2 9.5z" />
  </svg>
);
export const GitHubIcon = () => (
  <svg className="btn-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="currentColor">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);
const POST_TIP = "Posts this comment on the PR on GitHub, where the author and everyone can see it.";
const BOT_TIP = "A private note to Assistant. Nothing is posted on GitHub.";

// The status line under a comment after an action, e.g. "Posted to GitHub · view" or "Skipped · deleted on GitHub".
function statusLabel(status: "posted" | "skipped", comment: ReviewComment, local?: ReviewLocal) {
  const at = local?.at ? ` · ${clockTime(new Date(local.at))}` : "";
  if (status === "posted") {
    if (comment.url)
      return (
        <>
          Posted to GitHub ·{" "}
          <a href={comment.url} target="_blank" rel="noopener noreferrer">
            view
          </a>
        </>
      );
    const sent = local?.at ? at : comment.answered ? ` · ${clockTime(new Date(comment.answered.at))}` : "";
    return comment.status === "posted" ? "Posted to GitHub" : `Sent to assistant to post on GitHub${sent}`;
  }
  if (comment.status !== "skipped" && comment.answered) return `Marked Don't post · ${clockTime(new Date(comment.answered.at))}`;
  return `Skipped${comment.note ? ` · ${comment.note}` : at}`;
}
export type ReviewLocals = Record<string, ReviewLocal>;

export const reviewKey = (
  d: Pick<ReviewDraft, "repo" | "pr">,
  commentId: string,
) => `${d.repo}#${d.pr}:${commentId}`;

// posted / skipped from the board win; otherwise a delivered post or skip from this browser.
export function commentStatus(
  d: ReviewDraft,
  c: ReviewComment,
  locals: ReviewLocals,
): "pending" | "posted" | "skipped" {
  if (c.status === "posted" || c.status === "skipped") return c.status;
  // Answered on the review card or here: the same row, so it is closed on both.
  if (c.answered) return c.answered.action === "post" ? "posted" : "skipped";
  const l = locals[reviewKey(d, c.id)];
  return l?.status === "posted" || l?.status === "skipped"
    ? l.status
    : "pending";
}

export type OnReview = (
  d: ReviewDraft,
  c: ReviewComment | null,
  action: ReviewAction,
  text?: string,
) => Promise<boolean>;

// "2 to answer", "With QA" or Done. pending counts only comments on his turn; a comment he sent a note on
// (pending_bot) waits on QA's rewrite and is counted in waiting instead.
export function draftSummary(
  d: ReviewDraft,
  locals: ReviewLocals,
): { label: string; done: boolean; pending: number; waiting: number } {
  const open = d.comments.filter(
    (c) => commentStatus(d, c, locals) === "pending",
  );
  const waiting = open.filter((c) => Boolean(c.pending_bot)).length;
  const pending = open.length - waiting;
  if (d.done || (d.comments.length > 0 && open.length === 0))
    return { label: "Done", done: true, pending: 0, waiting: 0 };
  if (d.comments.length === 0) return { label: "Nothing new", done: false, pending: 0, waiting: 0 };
  if (pending === 0) return { label: "With QA", done: false, pending, waiting };
  return { label: `${pending} to answer`, done: false, pending, waiting };
}

function CommentCard({
  draft,
  comment,
  locals,
  onReview,
}: {
  draft: ReviewDraft;
  comment: ReviewComment;
  locals: ReviewLocals;
  onReview: OnReview;
}) {
  const [editing, setEditing] = useState(false);
  const body = postText(comment.body);
  const [text, setText] = useState(body);
  const editField = useRef<HTMLTextAreaElement>(null);
  const local = locals[reviewKey(draft, comment.id)];
  const status = commentStatus(draft, comment, locals);
  const sending = local?.status === "sending";
  // His note is with the assistant: no Post, Skip or note box until the draft is rewritten.
  const waiting = status === "pending" && Boolean(comment.pending_bot);
  const where = comment.line ? `${comment.path}:${comment.line}` : comment.path;
  // Posted and skipped comments start collapsed, open ones expanded; his own toggle wins.
  const [collapsed, toggle] = useCollapsed(`review:${reviewKey(draft, comment.id)}`, status !== "pending");
  const post = async (edited?: string) => {
    const ok = await onReview(draft, comment, "post", edited);
    if (ok) setEditing(false);
  };
  return (
    <article
      className={`review-comment ${status}${collapsed ? " is-collapsed" : ""}`}
      data-comment-id={comment.id}
    >
      <header className="review-comment-head">
        <CollapseChevron collapsed={collapsed} onToggle={toggle} label={`comment on ${where}`} />
        <span className={`sev sev-${comment.severity}`}>
          {comment.severity}
        </span>
        <code className="review-where">{where}</code>
        {collapsed && comment.title && (
          <span className="review-collapsed-title">{decodeEntities(comment.title)}</span>
        )}
        {status !== "pending" && (
          <span className={`review-flag ${status}`}>{statusLabel(status, comment, local)}</span>
        )}
        {waiting && <span className="review-flag">Sent to assistant · waiting for the rewrite</span>}
      </header>
      {collapsed ? null : (
        <>
      {comment.title && (
        <h4 className="review-comment-title">{decodeEntities(comment.title)}</h4>
      )}
      {editing ? (
        <div className="mic-wrap">
          <textarea
            ref={editField}
            className="composer-input edit-input"
            aria-label="Edit comment"
            value={text}
            rows={10}
            onChange={(e) => setText(e.target.value)}
          />
          <MicButton field={editField} value={text} onChange={setText} />
        </div>
      ) : (
        <>
          {comment.context?.trim() ? (
            <div className="comment-context-block">
              <span className="comment-context-label">For you, not posted</span>
              <Markdown text={comment.context} className="md review-context" />
            </div>
          ) : status === "pending" ? (
            <p className="comment-context-missing" role="status">No context from the bot</p>
          ) : null}
          <div className="will-post-block">
            <span className="will-post-label">Will post</span>
            <Markdown text={body} className="md review-body" />
          </div>
        </>
      )}
      {status === "pending" && !waiting && (
        <div className="review-actions">
          {editing ? (
            <>
              <button
                type="button"
                className="btn small btn-github"
                title={POST_TIP}
                disabled={sending || !text.trim()}
                onClick={() => void post(text.trim())}
              >
                <GitHubIcon />
                {sending ? "Posting..." : "Post edited to GitHub"}
              </button>
              <button
                type="button"
                className="btn ghost small"
                disabled={sending}
                onClick={() => {
                  setEditing(false);
                  setText(body);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn small btn-github"
                title={POST_TIP}
                disabled={sending}
                onClick={() => void post()}
              >
                <GitHubIcon />
                {sending && local?.action === "post" ? "Posting..." : "Post to GitHub"}
              </button>
              <button
                type="button"
                className="btn ghost small"
                disabled={sending}
                title="Don't post this comment. Nothing goes to GitHub."
                onClick={() => void onReview(draft, comment, "skip")}
              >
                Skip
              </button>
              <button
                type="button"
                className="btn ghost small"
                disabled={sending}
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            </>
          )}
          {local?.status === "failed" && (
            <span className="review-flag bad">Could not send, try again</span>
          )}
        </div>
      )}
      {status !== "skipped" && !waiting && (
      <NoteBox
        label="Private note to Assistant, not posted (e.g. soften this, also mention X)"
        button="Send to assistant"
        buttonClass="btn ghost small btn-bot"
        icon={<ChatIcon />}
        title={BOT_TIP}
        sentLabel="Sent to assistant"
        onSend={(t) => onReview(draft, comment, "note", t)}
      />
      )}
        </>
      )}
    </article>
  );
}

// The expanded drafts under one PR row: verdict, notes, each comment, and one notes box for the whole PR.
export function ReviewDrafts({
  draft,
  locals,
  onReview,
}: {
  draft: ReviewDraft;
  locals: ReviewLocals;
  onReview: OnReview;
}) {
  return (
    <div className="review-drafts">
      <div className="review-verdict">
        <Markdown text={draft.verdict} className="md" />
        {draft.notes && (
          <Markdown text={draft.notes} className="md review-notes" />
        )}
      </div>
      {draft.comments.length === 0 && (
        <p className="panel-empty">No new comments drafted for this PR.</p>
      )}
      {draft.comments.map((c) => (
        <CommentCard
          key={c.id}
          draft={draft}
          comment={c}
          locals={locals}
          onReview={onReview}
        />
      ))}
      <div className="review-pr-note">
        <h4>Notes for the whole PR</h4>
        <NoteBox
          label="Private note to Assistant about this review, not posted"
          button="Send to assistant"
          buttonClass="btn ghost small btn-bot"
          icon={<ChatIcon />}
          title={BOT_TIP}
          sentLabel="Sent to assistant"
          onSend={(t) => onReview(draft, null, "note", t)}
        />
      </div>
    </div>
  );
}
