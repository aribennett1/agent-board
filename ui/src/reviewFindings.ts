import type { Ask, Decision, PostCommentDraft } from "./data/types";
import type { ReviewPayload } from "./delivery";

// ops review cards answer one finding at a time: Post, Don't post, or a free-text note.
// Card-level multi-select and a "Post none" option are not used.

export type FindingAction = "post" | "skip" | "note";
export type FindingPick = number | "all";
export type ReviewFinding = PostCommentDraft & { n: number };
export type FindingAnswerMap = Map<string, string>; // "1" | "all" -> the words shown as "you said"

export const FINDING_STORAGE_KEY = "action-board:finding-answers";

export function parseFindingNumber(label: string | undefined, fallback?: number): number | null {
  const m = /#(\d+)\b/.exec(label ?? "");
  if (m) return Number(m[1]);
  if (typeof fallback === "number" && Number.isInteger(fallback) && fallback > 0) return fallback;
  return null;
}

export function isPerFindingReview(d: Pick<Decision, "id" | "title" | "question" | "context" | "post_comments" | "options">): boolean {
  if (Array.isArray(d.post_comments) && d.post_comments.length > 0) return true;
  const text = [d.id, d.title, d.question, d.context].filter(Boolean).join(" ");
  if (!/\breview\b/i.test(text)) return false;
  const commentOpts = (d.options ?? []).filter((o) => o.post_text || o.path);
  return commentOpts.length > 0 || /\b(?:which comments|ops post|post(?:s|ing)? (?:these |the )?comments)\b/i.test(text);
}

export function reviewFindings(d: Pick<Decision, "post_comments" | "options">): ReviewFinding[] {
  const fromComments = d.post_comments ?? [];
  if (fromComments.length > 0) {
    return fromComments.flatMap((c, i) => {
      const n = (typeof c.n === "number" && Number.isInteger(c.n) && c.n > 0 ? c.n : null) ?? parseFindingNumber(c.label, i + 1);
      return n ? [{ ...c, n }] : [];
    });
  }
  return (d.options ?? []).flatMap((o, i) => {
    if (!o.post_text || !String(o.post_text).trim()) return [];
    const n = parseFindingNumber(o.label, i + 1);
    if (!n) return [];
    return [
      {
        n,
        label: o.label,
        severity: o.severity,
        path: o.path ?? "",
        line: o.line,
        url: o.url,
        summary: o.summary,
        body: o.post_text,
      },
    ];
  });
}

export function reviewPr(d: Decision): { repo: string; pr: number; link?: string } | null {
  const link = d.glance?.pr?.link ?? (typeof d.card_ref === "string" && /^https?:\/\//.test(d.card_ref) ? d.card_ref : undefined);
  const fromLink = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(link ?? "");
  if (fromLink) return { repo: fromLink[1], pr: Number(fromLink[2]), ...(link ? { link } : {}) };
  const fromGroup = /^pr:([^/]+)\/(\d+)$/.exec(d.group ?? "");
  if (fromGroup) return { repo: fromGroup[1], pr: Number(fromGroup[2]), ...(link ? { link } : {}) };
  if (d.glance?.pr?.number) {
    const repo = fromGroup?.[1] ?? "example-repo";
    return { repo, pr: d.glance.pr.number, ...(d.glance.pr.link ? { link: d.glance.pr.link } : {}) };
  }
  return null;
}

export function findingAnswerLabel(action: FindingAction, text?: string): string {
  if (action === "post") return "Post";
  if (action === "skip") return "Don't post";
  return (text ?? "").trim();
}

export function findingAskText(opts: { n: FindingPick; path?: string; line?: number; action: FindingAction; text?: string }): string {
  if (opts.n === "all") return "Don't post any";
  const loc = opts.path ? `${opts.path}${opts.line ? `:${opts.line}` : ""}` : "";
  const where = loc ? ` (${loc})` : "";
  const label = findingAnswerLabel(opts.action, opts.text);
  return `Finding #${opts.n}${where}: ${label}`;
}

export function answersFromAsks(asks: Ask[] | undefined, cardId: string, findings?: ReviewFinding[]): FindingAnswerMap {
  const out: FindingAnswerMap = new Map();
  const prefix = `${cardId}:`;
  const itemKey = `decision:${cardId}`;
  const rev = new Map((findings ?? []).filter((f) => f.revision_at).map((f) => [String(f.n), f.revision_at as string]));
  for (const a of asks ?? []) {
    if (a.item_key !== itemKey && !(typeof a.ref === "string" && a.ref.startsWith(prefix))) continue;
    if (a.ref === `${cardId}:all` || /^Don't post any\b/i.test(a.text)) {
      out.set("all", "Don't post any");
      continue;
    }
    const refN = a.ref && a.ref.startsWith(prefix) ? a.ref.slice(prefix.length) : undefined;
    const textN = /^Finding #(\d+)\b/.exec(a.text)?.[1];
    const n = refN && refN !== "all" ? refN : textN;
    if (!n) continue;
    const after = a.text.includes(": ") ? a.text.slice(a.text.indexOf(": ") + 2) : a.text;
    const said = (after.trim() || a.text).trim();
    const tapped = /^don't post(?: any)?$/i.test(said) || /^post$/i.test(said);
    // A later rewrite must never reopen a finding he already tapped Post or Don't post on.
    const cut = rev.get(n);
    if (cut && a.at && a.at <= cut && !tapped) continue;
    out.set(n, said);
  }
  return out;
}

// Settled (grayed out, no buttons): posted/skipped on GitHub, or the owner tapped Post / Don't post.
// A free-text note does not close the finding — Post / Don't post stay, so he can still approve
// a rewrite (for example #214 #4). Fully settled cards drop off the board.
export function isFindingSettled(finding: Pick<ReviewFinding, "status">, answer?: string): boolean {
  if (finding.status === "posted" || finding.status === "skipped") return true;
  const a = (answer ?? "").trim();
  if (!a) return false;
  if (/^don't post(?: any)?$/i.test(a)) return true;
  if (/^post$/i.test(a)) return true;
  return false;
}

export function allFindingsAnswered(d: Decision, asks?: Ask[], extra?: FindingAnswerMap): boolean {
  const findings = reviewFindings(d);
  if (findings.length === 0) return false;
  const ans = answersFromAsks(asks, d.id, reviewFindings(d));
  if (extra) for (const [k, v] of extra) ans.set(k, v);
  if (ans.has("all")) return true;
  return findings.every((f) => isFindingSettled(f, ans.get(String(f.n))));
}

export function buildFindingPayload(
  d: Decision,
  finding: FindingPick,
  action: FindingAction,
  text: string | undefined,
  now: Date,
): ReviewPayload {
  const pr = reviewPr(d);
  if (!pr) throw new Error(`No PR on ${d.id}`);
  if (finding === "all") {
    return {
      event: "review.answer",
      decision_id: `${d.id}:all`,
      card_id: d.id,
      repo: pr.repo,
      pr: pr.pr,
      ...(pr.link ? { pr_link: pr.link } : {}),
      comment_id: "all",
      action: "skip",
      answered_at: now.toISOString(),
    };
  }
  const c = reviewFindings(d).find((f) => f.n === finding);
  if (!c) throw new Error(`Unknown finding ${finding} on ${d.id}`);
  const note = text?.trim();
  return {
    event: "review.answer",
    decision_id: `${d.id}:${finding}`,
    card_id: d.id,
    repo: pr.repo,
    pr: pr.pr,
    ...(pr.link ? { pr_link: pr.link } : {}),
    comment_id: String(finding),
    finding,
    action,
    ...(action === "note" && note ? { text: note } : {}),
    ...(c.severity ? { severity: c.severity } : {}),
    path: c.path,
    line: c.line ?? null,
    body: c.body,
    answered_at: now.toISOString(),
  };
}

export function loadFindingAnswers(storage: Pick<Storage, "getItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage): FindingAnswerMap {
  const out: FindingAnswerMap = new Map();
  if (!storage) return out;
  try {
    const raw = JSON.parse(storage.getItem(FINDING_STORAGE_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return out;
    for (const [k, v] of Object.entries(raw as Record<string, string>)) if (typeof v === "string" && v.trim()) out.set(k, v);
  } catch {
    // ignore bad storage
  }
  return out;
}

export function saveFindingAnswers(map: FindingAnswerMap, storage: Pick<Storage, "setItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage): void {
  if (!storage) return;
  try {
    storage.setItem(FINDING_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Storage full or blocked: in-memory answers still show until reload.
  }
}

export function findingStoreKey(cardId: string, finding: FindingPick): string {
  return `${cardId}:${finding}`;
}

export function mergeFindingMaps(...maps: (FindingAnswerMap | undefined)[]): FindingAnswerMap {
  const out: FindingAnswerMap = new Map();
  for (const m of maps) if (m) for (const [k, v] of m) out.set(k, v);
  return out;
}

export function answersForCard(cardId: string, map: FindingAnswerMap): FindingAnswerMap {
  const out: FindingAnswerMap = new Map();
  const prefix = `${cardId}:`;
  for (const [k, v] of map) {
    if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v);
    else if (!k.includes(":")) out.set(k, v);
  }
  return out;
}

export function localFindingAsks(map: FindingAnswerMap, decisions: Decision[]): Ask[] {
  const out: Ask[] = [];
  for (const d of decisions) {
    if (!isPerFindingReview(d)) continue;
    const card = answersForCard(d.id, map);
    const asksAns = new Map<string, string>(); // unused; we emit from the store directly
    void asksAns;
    for (const [k, answer] of card) {
      const pick: FindingPick = k === "all" ? "all" : Number(k);
      if (pick !== "all" && !Number.isInteger(pick)) continue;
      const f = pick === "all" ? undefined : reviewFindings(d).find((x) => x.n === pick);
      const text = findingAskText({ n: pick, path: f?.path, line: f?.line, action: k === "all" ? "skip" : /don't post/i.test(answer) ? "skip" : /^Post$/i.test(answer) ? "post" : "note", text: answer });
      out.push({
        id: `local-finding-${d.id}-${k}`,
        at: new Date(0).toISOString(),
        item_key: `decision:${d.id}`,
        label: d.title ?? d.question,
        kind: "review",
        text,
        ref: `${d.id}:${k}`,
      });
    }
  }
  return out;
}
