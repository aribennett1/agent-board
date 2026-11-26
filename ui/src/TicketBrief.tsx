import { useState } from "react";
import type { TicketBrief as Brief } from "./data/types";
import { CardSvg } from "./DecisionCard";
import { Link, linkify } from "./linkify";
import { Markdown } from "./markdown";

// Concise ticket brief: the whole problem in plain words, a simple diagram, and where the PR stands.
// The raw ticket is a link, never a dump.
export function TicketBrief({ brief, defaultOpen = false }: { brief?: Brief; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!brief) return null;
  const ticketLink = brief.ticket_link || brief.ticket?.link;
  return (
    <section className="ticket-brief" data-group={brief.group}>
      <button type="button" className="brief-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Ticket brief
      </button>
      {open && (
        <div className="brief-body">
          <h3 className="brief-title">{brief.title}</h3>
          {brief.ticket && (
            <p className="brief-ticket">
              <strong>{brief.ticket.id}</strong>
              {": "}
              {linkify(brief.ticket.summary)}
              {ticketLink ? (
                <>
                  {" "}
                  <Link href={ticketLink}>Open the ticket</Link>
                </>
              ) : null}
            </p>
          )}
          <Markdown text={brief.summary} className="md brief-summary" />
          <CardSvg src={brief.svg} />
          {brief.pr_stand && (
            <div className="brief-stand">
              <h4>Where the PR stands</h4>
              <Markdown text={brief.pr_stand} className="md" />
            </div>
          )}
          {brief.gaps && brief.gaps.length > 0 && (
            <div className="brief-gaps">
              <h4>Gaps</h4>
              <ul>
                {brief.gaps.map((g, i) => (
                  <li key={i}>{linkify(g)}</li>
                ))}
              </ul>
            </div>
          )}
          {brief.decisions && brief.decisions.length > 0 && (
            <div className="brief-decisions">
              <h4>Decisions so far</h4>
              <ul>
                {brief.decisions.map((g, i) => (
                  <li key={i}>{linkify(g)}</li>
                ))}
              </ul>
            </div>
          )}
          {brief.plan_link && (
            <p className="brief-plan">
              <Link href={brief.plan_link}>Open the plan</Link>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
