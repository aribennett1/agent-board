import type { Board, Decision, Tier } from "./data/types";

export const TIERS: Tier[] = ["blocking", "quick", "decision", "fyi"];

export const TIER_LABEL: Record<Tier, string> = {
  blocking: "Blocking",
  quick: "Quick taps",
  decision: "Decisions",
  fyi: "FYI",
};

export function effectiveTier(d: Pick<Decision, "tier">): Tier {
  return d.tier && TIERS.includes(d.tier) ? d.tier : "decision";
}

export function sameSha(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const x = a.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  const y = b.replace(/[^a-fA-F0-9]/g, "").toLowerCase();
  if (x.length < 7 || y.length < 7) return x.length > 0 && x === y;
  const n = Math.min(x.length, y.length);
  return x.slice(0, n) === y.slice(0, n);
}

export type StaleContext = {
  stamps?: Record<string, string>;
  heads?: Record<string, string>;
};

export function staleContext(board: Pick<Board, "stamps" | "heads">): StaleContext {
  return { stamps: board.stamps, heads: board.heads };
}

export function isPushCard(d: Pick<Decision, "title" | "question" | "sha">): boolean {
  return /\bpush\b/i.test(`${d.title ?? ""} ${d.question ?? ""}`);
}

export function cardStale(d: Decision, ctx: StaleContext = {}): { stale: boolean; reason?: string } {
  if (d.superseded_by) return { stale: true, reason: d.stale_reason || `Superseded by ${d.superseded_by}` };
  const key = d.group;
  if (d.sha && key && ctx.stamps?.[key] && !sameSha(d.sha, ctx.stamps[key])) {
    return { stale: true, reason: `Stamped SHA moved to ${ctx.stamps[key].slice(0, 9)}` };
  }
  if (d.sha && key && ctx.heads?.[key] && !sameSha(d.sha, ctx.heads[key]) && isPushCard(d)) {
    return { stale: true, reason: `PR head is now ${ctx.heads[key].slice(0, 9)}, not the stamped ${d.sha.slice(0, 9)}` };
  }
  return { stale: false };
}

export function isActionable(d: Decision, ctx: StaleContext = {}, appAnswered: Record<string, unknown> = {}): boolean {
  if (d.answer) return false;
  if (Object.prototype.hasOwnProperty.call(appAnswered, d.id)) return false;
  if (cardStale(d, ctx).stale) return false;
  return true;
}

export function waitingLabel(createdAt: string | undefined, now: Date = new Date()): string | null {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return null;
  const ms = Math.max(0, now.getTime() - t);
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "waiting just now";
  if (mins < 60) return `waiting ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `waiting ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `waiting ${days} day${days === 1 ? "" : "s"}`;
}

export function sortTriage<T extends Decision>(cards: readonly T[]): T[] {
  const rank = (t: Tier) => TIERS.indexOf(t);
  return [...cards].sort((a, b) => {
    const tr = rank(effectiveTier(a)) - rank(effectiveTier(b));
    if (tr) return tr;
    const u = (b.unblocks ?? 0) - (a.unblocks ?? 0);
    if (u) return u;
    return (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0);
  });
}

export function groupKey(d: Decision): string {
  if (d.group) return d.group;
  if (d.glance?.pr) return `pr:${d.glance.pr.repo ?? "example-repo"}/${d.glance.pr.number}`;
  if (d.glance?.ticket?.id) return `ticket:${d.glance.ticket.id}`;
  return `decision:${d.id}`;
}

export type TicketGroup<T extends Decision = Decision> = {
  key: string;
  title: string;
  ticketId?: string;
  ticketSummary?: string;
  cards: T[];
  actionable: T[];
  stale: T[];
  bestTier: Tier;
  maxUnblocks: number;
  oldest: string | undefined;
};

export function groupByTicket<T extends Decision>(
  cards: readonly T[],
  ctx: StaleContext = {},
  appAnswered: Record<string, unknown> = {},
): TicketGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const d of cards) {
    const k = groupKey(d);
    const arr = map.get(k) ?? [];
    arr.push(d);
    map.set(k, arr);
  }
  const groups: TicketGroup<T>[] = [];
  for (const [key, list] of map) {
    const sorted = sortTriage(list);
    const actionable = sorted.filter((d) => isActionable(d, ctx, appAnswered) && d.section !== "audit");
    const stale = sorted.filter((d) => cardStale(d, ctx).stale);
    const first = sorted[0];
    // Groups with nothing to answer (all stale, or only FYI left unanswered) should not jump the queue.
    const forRank = actionable;
    const bestTier = forRank.reduce<Tier>((best, d) => {
      const t = effectiveTier(d);
      return TIERS.indexOf(t) < TIERS.indexOf(best) ? t : best;
    }, "fyi");
    groups.push({
      key,
      title: first?.glance?.pr
        ? `#${first.glance.pr.number}`
        : (first?.glance?.ticket?.id ?? first?.title ?? key),
      ticketId: first?.glance?.ticket?.id,
      ticketSummary: first?.glance?.ticket?.summary,
      cards: sorted,
      actionable,
      stale,
      bestTier,
      maxUnblocks: forRank.reduce((n, d) => Math.max(n, d.unblocks ?? 0), 0),
      oldest: (forRank.length ? forRank : sorted).map((d) => d.created_at).filter(Boolean).sort()[0],
    });
  }
  groups.sort((a, b) => {
    const aOpen = a.actionable.length > 0;
    const bOpen = b.actionable.length > 0;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    const tr = TIERS.indexOf(a.bestTier) - TIERS.indexOf(b.bestTier);
    if (tr) return tr;
    const u = b.maxUnblocks - a.maxUnblocks;
    if (u) return u;
    return (Date.parse(a.oldest ?? "") || 0) - (Date.parse(b.oldest ?? "") || 0);
  });
  return groups;
}

export function nextFiveMinutes<T extends Decision>(
  cards: readonly T[],
  ctx: StaleContext = {},
  appAnswered: Record<string, unknown> = {},
  n = 5,
): T[] {
  return sortTriage(
    cards.filter((d) => isActionable(d, ctx, appAnswered) && effectiveTier(d) === "quick" && d.section !== "audit"),
  ).slice(0, n);
}
