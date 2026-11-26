import type { AlreadyDecided, AnswersComment, Option, PostCommentDraft } from "./data/types";
import { Link } from "./linkify";
import { Markdown } from "./markdown";
import { CommentEditDiff } from "./CommentEditDiff";

// Strips HTML comment markers and Cursor Bugbot "Fix in Cursor/Web" button boilerplate if raw gh api body was stored.
export function cleanCommentBody(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<div>[\s\S]*?<\/div>/gi, "")
    .replace(/<sup>[\s\S]*?<\/sup>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function AlreadyDecidedBanner({ decided }: { decided?: AlreadyDecided }) {
  if (!decided?.answer?.trim()) return null;
  return (
    <p className="already-decided-banner" role="status">
      You already decided {decided.answer}
      {decided.source ? ` (${decided.source})` : ""}
    </p>
  );
}

export function PostApprovalBlock({
  answersComment,
  postText,
  currentText,
  postComments,
  options,
  lede,
}: {
  answersComment?: AnswersComment;
  postText?: string | null;
  currentText?: string;
  postComments?: PostCommentDraft[];
  options?: Option[];
  lede?: string;
}) {
  const fromOptions: PostCommentDraft[] =
    (!postComments || postComments.length === 0) && options
      ? options
          .filter((o) => typeof o.post_text === "string" && o.post_text.trim() !== "")
          .map((o) => ({
            label: o.label,
            severity: o.severity,
            path: o.path ?? "",
            line: o.line,
            url: o.url,
            summary: o.summary,
            body: o.post_text!,
          }))
      : [];
  const drafts = postComments && postComments.length > 0 ? postComments : fromOptions;
  const current = (currentText ?? "").trim() || (options ?? []).map((o) => o.current_text).find((t) => t && t.trim())?.trim() || "";
  const after =
    typeof postText === "string" && postText.trim()
      ? postText
      : drafts.find((c) => c.body?.trim())?.body ?? "";
  const showDiff = Boolean(current && after);
  if (!answersComment && postText === undefined && drafts.length === 0 && !showDiff && !lede) return null;
  const prLabel = answersComment
    ? answersComment.repo
      ? `${answersComment.repo}#${answersComment.pr}`
      : `PR #${answersComment.pr}`
    : "";
  const loc = answersComment?.path
    ? answersComment.line
      ? `${answersComment.path}:${answersComment.line}`
      : answersComment.path
    : null;
  return (
    <div className="post-approval-block">
      {answersComment && (
        <section className="post-approval-comment" aria-label="Comment you are answering">
          <div className="post-approval-head">
            <span className="post-approval-kicker">{showDiff ? "Posted comment" : "Comment you're answering"}</span>
            {answersComment.severity && (
              <span className={`severity-chip severity-${answersComment.severity.toLowerCase()}`}>
                {answersComment.severity}
              </span>
            )}
            <Link className="post-approval-link" href={answersComment.url}>
              View on GitHub
            </Link>
          </div>
          <p className="post-approval-meta">
            <strong>{answersComment.author}</strong> on {prLabel}
            {loc ? (
              <>
                {" · "}
                <code>{loc}</code>
              </>
            ) : null}
          </p>
          {!showDiff && (
            <blockquote className="comment-quote">
              <Markdown text={cleanCommentBody(answersComment.body)} className="md" />
            </blockquote>
          )}
        </section>
      )}
      {lede?.trim() && (
        <p className="edit-lede">{lede.trim()}</p>
      )}
      {showDiff && <CommentEditDiff before={current} after={after} />}
      {!showDiff && postText !== undefined && (
        <section className="post-approval-text" aria-label={postText === null ? "What gets posted" : "Will post"}>
          <div className="post-approval-head">
            <span className="post-approval-kicker">
              {postText === null ? "What gets posted" : "Will post"}
            </span>
          </div>
          {postText === null ? (
            <p className="post-text-none">No text gets posted — only a 👍 reaction.</p>
          ) : (
            <div className="post-text-box">
              <Markdown text={postText} className="md" />
            </div>
          )}
        </section>
      )}
      {!showDiff && drafts.length > 0 && (
        <section className="post-approval-text" aria-label="Comments that will be posted">
          <div className="post-approval-head">
            <span className="post-approval-kicker">Exact comments ({drafts.length})</span>
          </div>
          <ol className="post-comments-list">
            {drafts.map((c, idx) => {
              const draftLoc = c.path ? (c.line ? `${c.path}:${c.line}` : c.path) : null;
              return (
                <li key={idx} className="post-comment-draft">
                  <div className="post-approval-head">
                    <strong>{c.label}</strong>
                    {c.severity && (
                      <span className={`severity-chip severity-${c.severity.toLowerCase()}`}>{c.severity}</span>
                    )}
                    {c.url && (
                      <Link className="post-approval-link" href={c.url}>View on GitHub</Link>
                    )}
                  </div>
                  {draftLoc && <p className="post-approval-meta"><code>{draftLoc}</code></p>}
                  {c.summary && <p className="post-comment-summary">{c.summary}</p>}
                  <div className="will-post-block">
                    <span className="will-post-label">Will post</span>
                    <div className="post-text-box">
                      <Markdown text={c.body} className="md" />
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
