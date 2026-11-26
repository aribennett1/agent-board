import { useState, type ReactNode } from "react";
import type { Board, Decision, TicketBrief as Brief, Tier } from "./data/types";
import { TicketBrief } from "./TicketBrief";
import {
  TIER_LABEL,
  effectiveTier,
  groupByTicket,
  nextFiveMinutes,
  staleContext,
  type TicketGroup,
} from "./triage";

type RenderCard = (d: Decision, index: number) => ReactNode;

export function TriageQueue({
  cards,
  board,
  answers = {},
  renderCard,
}: {
  cards: Decision[];
  board: Board;
  answers?: Record<string, unknown>;
  renderCard: RenderCard;
}) {
  const ctx = staleContext(board);
  const next = nextFiveMinutes(cards, ctx, answers);
  const groups = groupByTicket(cards, ctx, answers);
  let n = 0;
  return (
    <>
      {next.length > 0 && (
        <section className="next-five" aria-label="Next 5 minutes">
          <h2>Next 5 minutes</h2>
          <p className="next-five-hint">Quick taps that unblock the most work right now.</p>
          <div className="next-five-list">
            {next.map((d) => {
              n += 1;
              return <div key={d.id}>{renderCard(d, n)}</div>;
            })}
          </div>
        </section>
      )}
      {groups.map((g) => (
        <TicketGroupRow key={g.key} group={g} brief={board.briefs?.[g.key]} renderCard={renderCard} indexStart={n} onIndexed={(i) => { n = i; }} />
      ))}
    </>
  );
}

function TicketGroupRow({
  group,
  brief,
  renderCard,
  indexStart,
  onIndexed,
}: {
  group: TicketGroup;
  brief?: Brief;
  renderCard: RenderCard;
  indexStart: number;
  onIndexed: (n: number) => void;
}) {
  const [open, setOpen] = useState(group.bestTier === "blocking" || group.bestTier === "quick" || group.actionable.some((d) => effectiveTier(d) !== "fyi"));
  const [smallOpen, setSmallOpen] = useState(false);
  const [fyiOpen, setFyiOpen] = useState(group.bestTier === "blocking");
  const [staleOpen, setStaleOpen] = useState(false);
  const actionable = group.actionable;
  const small = actionable.filter((d) => d.severity === "low");
  const main = actionable.filter((d) => d.severity !== "low");
  const fyi = main.filter((d) => effectiveTier(d) === "fyi");
  const byTier = (tier: Tier) => main.filter((d) => effectiveTier(d) === tier);
  let i = indexStart;
  const list = (ds: Decision[]) =>
    ds.map((d) => {
      i += 1;
      onIndexed(i);
      return <div key={d.id}>{renderCard(d, i)}</div>;
    });
  const title = [group.ticketId, group.title].filter(Boolean).join(" · ");
  return (
    <section className="ticket-group" data-group={group.key} data-best-tier={group.bestTier}>
      <button type="button" className="ticket-group-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="ticket-group-title">{title}</span>
        {group.ticketSummary && <span className="ticket-group-sum">{group.ticketSummary}</span>}
        <span className="ticket-group-count">{group.actionable.length}</span>
      </button>
      {open && (
        <div className="ticket-group-body">
          <TicketBrief brief={brief} defaultOpen={group.bestTier === "blocking"} />
          {fyi.length > 0 && (
            <div className="fyi-stuff">
              <button type="button" className="fyi-toggle" aria-expanded={fyiOpen} onClick={() => setFyiOpen((o) => !o)}>
                FYI <span className="n">{fyi.length}</span>
              </button>
              {fyiOpen && list(fyi)}
            </div>
          )}
          {(["blocking", "quick", "decision"] as Tier[]).map((tier) => {
            const items = byTier(tier);
            if (!items.length) return null;
            return (
              <div key={tier} className={`tier-block tier-block-${tier}`}>
                <h3 className="tier-heading">
                  {TIER_LABEL[tier]} <span className="n">{items.length}</span>
                </h3>
                {list(items)}
              </div>
            );
          })}
          {small.length > 0 && (
            <div className="small-stuff">
              <button type="button" className="small-stuff-toggle" aria-expanded={smallOpen} onClick={() => setSmallOpen((o) => !o)}>
                Small stuff <span className="n">{small.length}</span>
              </button>
              {smallOpen && list(small)}
            </div>
          )}
          {group.stale.length > 0 && (
            <div className="stale-stuff">
              <button type="button" className="stale-toggle" aria-expanded={staleOpen} onClick={() => setStaleOpen((o) => !o)}>
                Superseded <span className="n">{group.stale.length}</span>
              </button>
              {staleOpen && group.stale.map((d) => <div key={d.id}>{renderCard(d, 0)}</div>)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
