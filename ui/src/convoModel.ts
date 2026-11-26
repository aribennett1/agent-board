import type { ReplyQuestion, ThreadEntry } from "./data/types";

// Thread helpers shared by the row status (itemStatus), the item thread (Thread) and the Conversation topics.

export type ExchangeStatus = "waiting-you" | "working" | "passed" | "waiting-others" | "done";
const qLabel = (q: ReplyQuestion) => /^(Q\d+[a-z]?)\s*[:.]/.exec(q.text)?.[1];

// Questions in a thread the owner'still has to answer: not answered (an ask with reply_to), not superseded, and not
// replaced by a later question with the same "Qn:" label. A --status reply never closes unanswered questions.
export function openThreadQuestions(thread: ThreadEntry[] | undefined, answered: Set<string>): ThreadEntry[] {
  const t = thread ?? [];
  return t.filter((e, i) => {
    if (!e.question || e.question.superseded_by || answered.has(e.question.id)) return false;
    const label = qLabel(e.question);
    return !(label && t.slice(i + 1).some((l) => l.question && qLabel(l.question) === label));
  });
}

export function latestStatus(thread: ThreadEntry[] | undefined): string | undefined {
  return [...(thread ?? [])].reverse().find((e) => e.status)?.status;
}

export function statusText(s: string): { status: ExchangeStatus; label: string } {
  if (s === "done") return { status: "done", label: "Done" };
  if (s === "working") return { status: "working", label: "Assistant working" };
  if (s.startsWith("passed:")) return { status: "passed", label: `Passed to ${s.slice(7)}` };
  if (s.startsWith("waiting:")) return { status: "waiting-others", label: `Waiting on ${s.slice(8)}` };
  return { status: "done", label: "Done" };
}
