import type { Decision, Glance } from "./data/types";
import { Link, linkify } from "./linkify";

// Fixed "At a glance" header: ticket, PR stack and state, what's done, what's asked, and what each answer does.
export function GlanceHeader({ glance }: { glance?: Glance }) {
  if (!glance?.ticket) return null;
  const { ticket, pr, done, asking, outcomes } = glance;
  return (
    <section className="glance" aria-label="At a glance">
      <h4 className="glance-kicker">At a glance</h4>
      <p className="glance-ticket">
        <strong>{ticket.id}</strong>
        {ticket.link ? (
          <>
            {" "}
            <Link href={ticket.link}>Open the ticket</Link>
          </>
        ) : null}
        {": "}
        {linkify(ticket.summary)}
      </p>
      {pr && (
        <p className="glance-pr">
          <Link href={pr.link}>
            {pr.repo ? `${pr.repo}#${pr.number}` : `PR #${pr.number}`}
          </Link>
          {pr.author ? ` by ${pr.author}` : ""}
          {pr.base ? ` · base ${pr.base}` : ""}
          {pr.sits_on ? ` · sits on ${pr.sits_on}` : ""}
          {pr.sat_on_by ? ` · under it: ${pr.sat_on_by}` : ""}
          {pr.state ? ` · ${pr.state}` : ""}
          {pr.sha ? ` · ${pr.sha.slice(0, 9)}` : ""}
        </p>
      )}
      {done && done.length > 0 && (
        <div className="glance-done">
          <h5>Already done and decided</h5>
          <ul>
            {done.map((line, i) => (
              <li key={i}>{linkify(line)}</li>
            ))}
          </ul>
        </div>
      )}
      {asking && (
        <p className="glance-asking">
          <strong>Asking: </strong>
          {linkify(asking)}
        </p>
      )}
      {outcomes && outcomes.length > 0 && (
        <div className="glance-outcomes">
          <h5>If you pick</h5>
          <ul>
            {outcomes.map((o) => (
              <li key={o.id}>
                <strong>{o.id}:</strong> {linkify(o.happens)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function Recommendation({ decision }: { decision: Decision }) {
  const rec = decision.recommendation;
  if (!rec?.id || !rec.reason) return null;
  const label = decision.options.find((o) => o.id === rec.id)?.label ?? rec.id;
  const who = rec.who?.trim() || "Assistant";
  const letter = (label.match(/^[A-Za-z](?=:)/) || [rec.id])[0];
  return (
    <div className="recommendation" data-rec-id={rec.id} data-rec-who={who}>
      <p>
        {who} recommends <strong>{letter}</strong>.
      </p>
      <p>{rec.reason}</p>
    </div>
  );
}

export function DraftToggle({ draft }: { draft?: string }) {
  if (!draft?.trim()) return null;
  return (
    <details className="draft-toggle">
      <summary>Show the draft</summary>
      <pre className="draft-body">{draft.trim()}</pre>
    </details>
  );
}
