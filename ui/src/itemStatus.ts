import type { ItemDetail } from "./data/types";
import { latestStatus, openThreadQuestions, statusText } from "./convoModel";
import { hasUnread } from "./Thread";

// Whether an item needs the owner now, or not, with a short reason for the row. Needs you ONLY when there is something
// he can act on: an open question or option set in the thread, plan questions, draft comments (not ones he sent a
// note on, which wait on QA's rewrite), a PR ready to approve, changes requested or failing CI on his PR. A review request is not "Ready to approve" just because
// checks are green and no threads are open; park it as "Review running" until there is a draft, written details,
// or a question. Once the review is done and those checks still pass, it is ready to approve. A bot reply with
// no question (an ack, a status, an FYI) never puts an item in Needs you; its unread dot still shows. A reply
// status (ab reply --status) parks the item.
export type ItemStatus = { needs: boolean; reason: string };

export type StatusInput = {
  kind: "ticket" | "mypr" | "pr" | "waiting" | "decision";
  detail?: ItemDetail;
  // Pending review drafts on a PR asked of the owner (undefined when there is no draft).
  pendingDrafts?: number;
  // Review drafts he sent a note on that wait for QA's rewrite (pending_bot). Never his turn.
  waitingDrafts?: number;
  // A PR that asks for the owner's review.
  reviewRequested?: boolean;
  // My PR: its state and CI.
  state?: string;
  ci?: string;
  // Waiting on whom.
  who?: string;
  seenAt?: string;
  // Reply question ids the owner already answered.
  answered?: Set<string>;
};

export function itemStatus(x: StatusInput): ItemStatus {
  const d = x.detail ?? {};
  if (openThreadQuestions(d.thread, x.answered ?? new Set()).length) return { needs: true, reason: "Question for you" };
  const parked = latestStatus(d.thread);
  if (parked) return { needs: false, reason: statusText(parked).label };
  if ((x.pendingDrafts ?? 0) > 0) return { needs: true, reason: `${x.pendingDrafts} draft comment${x.pendingDrafts === 1 ? "" : "s"} to post` };
  if ((x.waitingDrafts ?? 0) > 0) return { needs: false, reason: "Waiting on QA" };
  if (d.review_facts) return { needs: true, reason: d.review_questions ? "Changes requested: questions for you" : "Changes requested" };
  if (d.ci_report) return { needs: true, reason: "CI failing" };
  if ((d.questions?.length ?? 0) > 0) return { needs: true, reason: `Plan to approve: ${d.questions!.length} questions` };
  // Green checks alone are not enough on a review request still waiting for a draft or a write-up.
  const reviewActionable = !!(d.plain || d.summary || d.review_plain || d.review_questions);
  if (x.kind === "pr" && x.reviewRequested && x.pendingDrafts === undefined && !reviewActionable) {
    return { needs: false, reason: "Review running" };
  }
  if (d.approval === "ready") return { needs: true, reason: "Ready to approve" };
  if (x.kind === "pr" && x.pendingDrafts === 0) return { needs: false, reason: "Review done" };
  if (hasUnread(d.thread, x.seenAt)) return { needs: false, reason: "New reply (FYI)" };
  if (d.approval === "approved") return { needs: false, reason: "Approved" };
  if (x.kind === "waiting") return { needs: false, reason: x.who ? `Waiting on ${x.who}` : "Waiting on others" };
  if (x.kind === "mypr" && x.ci === "pending") return { needs: false, reason: "CI running" };
  if (x.kind === "mypr" && x.state === "draft") return { needs: false, reason: "Draft" };
  if (x.kind === "ticket" && d.plan) return { needs: false, reason: "Waiting on Assistant" };
  const hasDetails = !!(d.ticket || d.plain || d.summary || d.plan || d.discussion?.length || d.thread?.length);
  return { needs: false, reason: hasDetails ? "In progress" : "No details yet" };
}
