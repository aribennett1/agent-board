// Pure model for My tickets, My PRs and Others' PRs. The rows come from the server's own GitHub / Linear fetch
// (board.feed), never from a bot. Grouping and counts live here so the view and the tests agree.

export type FeedLabel = { name: string; color?: string };
export type FeedPr = {
  repo: string;
  number: number;
  title: string;
  link: string;
  author: string;
  who: string;
  state: "draft" | "ready" | "approved" | "changes requested";
  ci: "passing" | "failing" | "pending" | "none";
  checks?: { passed: number; failed: number; pending: number; failing: string[] };
  reviews?: number;
  labels?: FeedLabel[];
  comments?: number;
  additions?: number;
  deletions?: number;
  files?: number;
  unresolved_count?: number;
  unresolved?: { author: string; path: string; body: string; url: string }[];
  branch?: string;
  base?: string;
  body?: string;
  updated_at?: string;
};
export type FeedTicket = {
  id: string;
  title: string;
  link?: string;
  status: string;
  status_type?: string;
  status_color?: string | null;
  priority?: number;
  priority_label?: string;
  project?: string;
  due?: string | null;
  labels?: FeedLabel[];
  prs?: string[];
  updated_at?: string;
};
export type FeedMeta = {
  fetched_at?: string;
  github?: { ok: boolean; login?: string | null; error?: string | null };
  linear?: { ok: boolean; configured: boolean; error?: string | null };
};
export type Group<T> = { key: string; title: string; items: T[] };

export const isReviewRequested = (p: Pick<FeedPr, "who">) => /review requested/i.test(p.who);

/** My PR that needs him: changes requested, failing checks, or open comments left for him. */
export const mineNeedsAttention = (p: FeedPr) => !isDraft(p) && (p.state === "changes requested" || p.ci === "failing" || (p.unresolved_count ?? 0) > 0);
const isDraft = (p: FeedPr) => p.state === "draft";

/** Checks passed, nothing open, not a draft: safe to approve (the old Reviews "Ready to approve" signal). */
export const readyToApprove = (p: FeedPr) => !isDraft(p) && p.ci === "passing" && (p.unresolved_count ?? 0) === 0 && p.state !== "changes requested";

const keep = <T,>(key: string, title: string, items: T[]): Group<T>[] => (items.length ? [{ key, title, items }] : []);

export function groupMine(items: FeedPr[]): Group<FeedPr>[] {
  const needs = items.filter(mineNeedsAttention);
  const rest = items.filter((p) => !mineNeedsAttention(p));
  return [
    ...keep("needs", "Needs your attention", needs),
    ...keep("review", "In review", rest.filter((p) => !isDraft(p))),
    ...keep("draft", "Drafts", rest.filter(isDraft)),
  ];
}

export function groupOthers(items: FeedPr[]): Group<FeedPr>[] {
  const asked = items.filter(isReviewRequested);
  const rest = items.filter((p) => !isReviewRequested(p));
  return [
    ...keep("asked", "Your review requested", asked),
    ...keep("involved", "You're involved", rest.filter((p) => !isDraft(p))),
    ...keep("draft", "Drafts", rest.filter(isDraft)),
  ];
}

export function groupTickets(items: FeedTicket[]): Group<FeedTicket>[] {
  const out: Group<FeedTicket>[] = [];
  for (const t of items) {
    const g = out.find((x) => x.key === t.status);
    if (g) g.items.push(t);
    else out.push({ key: t.status, title: t.status, items: [t] });
  }
  return out;
}

export const counts = (feed: { tickets: unknown[]; mine: FeedPr[]; others: FeedPr[] }) => ({
  tickets: feed.tickets.length,
  mine: feed.mine.length,
  mineNeeds: feed.mine.filter(mineNeedsAttention).length,
  others: feed.others.length,
  othersAsked: feed.others.filter(isReviewRequested).length,
});

/** "+927 −75" */
export const linesChanged = (p: Pick<FeedPr, "additions" | "deletions">) => `+${p.additions ?? 0} \u2212${p.deletions ?? 0}`;

const PRIORITY_NAME = ["", "Urgent", "High", "Medium", "Low"];
export const priorityName = (n?: number) => PRIORITY_NAME[n ?? 0] ?? "";

/** "5m ago", "3h ago", "2d ago" */
export function ago(iso: string | undefined, now: Date = new Date()): string {
  const t = Date.parse(iso ?? "");
  if (Number.isNaN(t)) return "";
  const m = Math.max(0, Math.round((now.getTime() - t) / 60000));
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}
