import { useEffect, useState, type ReactNode } from "react";
import { Markdown } from "./markdown";
import { TIME_ZONE } from "./config";
import { prRef } from "./others";
import { PR_DETAIL_PATH } from "./useLiveBoard";
import { ago, groupMine, groupOthers, groupTickets, isQaDrafted, isReviewRequested, linesChanged, mineOpenReasons, priorityName, readyToApprove, type FeedLabel, type FeedMeta, type FeedPr, type FeedTicket, type Group } from "./liveLists";

// My tickets, My PRs and Others' PRs: compact rows grouped under plain headings, filled by the server's own timer.
// A row shows the facts on two lines; the chevron opens the description and anything left to address.

const CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" });
const stamp = (iso?: string) => (iso && !Number.isNaN(Date.parse(iso)) ? `${CLOCK.format(Date.parse(iso)).replace(/[\u202f\u00a0]/g, " ")} ET` : "never");

function Labels({ labels }: { labels?: FeedLabel[] }) {
  return (
    <>
      {(labels ?? []).map((l) => (
        <span key={l.name} className="lbl" style={l.color ? { borderColor: `#${l.color}` } : undefined}>
          <i style={l.color ? { background: `#${l.color}` } : undefined} aria-hidden="true" />
          {l.name}
        </span>
      ))}
    </>
  );
}

// Source status line under the header: when it last refreshed, or what is wrong and how to fix it.
function Source({ meta, which }: { meta?: FeedMeta; which: "github" | "linear" }) {
  const src = meta?.[which];
  if (!meta || !src) return <p className="live-note">Loading from {which === "github" ? "GitHub" : "Linear"}…</p>;
  if (which === "linear" && !(src as { configured: boolean }).configured)
    return <p className="live-note warn" role="status">Linear is not connected. Add LINEAR_API_KEY to the board's .env and restart it; tickets then load by themselves.</p>;
  return (
    <p className={src.ok ? "live-note" : "live-note warn"} role="status">
      {src.ok ? `Updated ${stamp(meta.fetched_at)} · refreshes every 2 minutes` : `${which === "github" ? "GitHub" : "Linear"} fetch failed: ${src.error ?? "unknown error"}. Showing the last good list.`}
    </p>
  );
}

function Groups<T>({ groups, empty, row }: { groups: Group<T>[]; empty: string; row: (t: T) => ReactNode }) {
  if (groups.length === 0) return <p className="panel-empty">{empty}</p>;
  return (
    <>
      {groups.map((g) => (
        <section key={g.key} className="live-group" aria-label={g.title}>
          <h3>
            {g.title} <span className="n">{g.items.length}</span>
          </h3>
          <ul className="live-list">{g.items.map(row)}</ul>
        </section>
      ))}
    </>
  );
}

type PrExtras = { badge?: (p: FeedPr) => ReactNode; extra?: (p: FeedPr) => ReactNode; needsYou?: (p: FeedPr) => boolean };

// A row from an older feed may carry only title, author, who and link: fill the repo and number from the link.
const withRef = (p: FeedPr): FeedPr => {
  if (p.repo && p.number) return p;
  const m = /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/.exec(p.link ?? "");
  return m ? { ...p, repo: m[1], number: Number(m[2]) } : p;
};

// The description and open comments of a row the board sent without them, loaded the first time the row opens.
type PrDetail = Pick<FeedPr, "body" | "unresolved">;
const prDetails = new Map<string, PrDetail>();
function usePrDetail(p: FeedPr, open: boolean): { detail?: PrDetail; failed: boolean } {
  const key = `${p.link}@${p.updated_at ?? ""}`;
  const [, setTick] = useState(0);
  const [failed, setFailed] = useState(false);
  const need = open && !!p.detail_deferred && !!p.link && !prDetails.has(key);
  useEffect(() => {
    if (!need) return;
    let live = true;
    fetch(`${PR_DETAIL_PATH}?link=${encodeURIComponent(p.link)}`, { cache: "no-store", signal: AbortSignal.timeout(15000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: PrDetail) => {
        prDetails.set(key, { body: d.body, unresolved: d.unresolved });
        if (live) setTick((n) => n + 1);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [need, key, p.link]);
  return { detail: prDetails.get(key), failed };
}

function PrRow({ p: raw, others, x }: { p: FeedPr; others: boolean; x: PrExtras }) {
  const [open, setOpen] = useState(false);
  const lazy = usePrDetail(raw, open);
  const p = withRef(lazy.detail ? { ...raw, ...lazy.detail } : raw);
  const waiting = !!raw.detail_deferred && !lazy.detail;
  const failing = p.checks?.failing ?? [];
  const unresolved = p.unresolved ?? [];
  const ready = others && isReviewRequested(p) && readyToApprove(p);
  return (
    <li className={open ? "live-row open" : "live-row"} data-pr={`${p.repo}/${p.number}`}>
      <button type="button" className="chev-btn row-chev" aria-expanded={open} aria-label={open ? "Collapse" : "Expand"} onClick={() => setOpen((o) => !o)}>
        <span className="chev" aria-hidden="true" />
      </button>
      <div className="live-main">
        <div className="live-line1">
          <span className="live-ref">{prRef(p.link) ?? `${p.repo} #${p.number}`}</span>
          <a className="live-title" href={p.link} target="_blank" rel="noopener noreferrer">{p.title}</a>
          <span className="live-chips">
            {ready && <span className="approval-chip ready">Ready to approve</span>}
            {!others && x.needsYou?.(p) && <span className="reason-chip needs-you">Needs you</span>}
            {!others && mineOpenReasons(p).map((r) => (
              <span key={r} className="reason-chip">{r}</span>
            ))}
            {x.badge?.(p)}
            <span className={`state-chip state-${String(p.state ?? "ready").replace(/ /g, "-")}`}>{p.state}</span>
            <span className={`ci-chip ci-${p.ci}`} title={failing.length ? `Failing: ${failing.join(", ")}` : undefined}>
              {p.ci === "failing" && p.checks ? `${p.checks.failed} failing` : p.ci === "none" ? "no checks" : p.ci}
            </span>
          </span>
        </div>
        <div className="live-line2">
          {others && <span>{p.author}</span>}
          {others && <span className={isReviewRequested(p) || isQaDrafted(p) ? "strong" : undefined}>{p.who}</span>}
          <Labels labels={p.labels} />
          <span title="Comments">{p.comments ?? 0} comments</span>
          {(p.unresolved_count ?? 0) > 0 && <span className="strong">{p.unresolved_count} unresolved</span>}
          <span className="diff" title={`${p.files ?? 0} files`}>
            <b className="add">+{p.additions ?? 0}</b> <b className="del">{`\u2212${p.deletions ?? 0}`}</b>
          </span>
          <span>{p.files ?? 0} files</span>
          <span>{p.reviews ?? 0} reviews</span>
          <span className="when">{ago(p.updated_at)}</span>
        </div>
        {open && (
          <div className="live-body">
            {failing.length > 0 && <p className="live-fail">Failing checks: {failing.join(", ")}</p>}
            {unresolved.length > 0 && (
              <div className="live-threads">
                <h4>{others ? "Open review comments" : "Comments left for you to address"} ({p.unresolved_count})</h4>
                <ul>
                  {unresolved.map((u, i) => (
                    <li key={i}>
                      <a href={u.url} target="_blank" rel="noopener noreferrer"><b>{u.author}</b> on <code>{u.path || "the PR"}</code></a>
                      <p>{u.body}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <h4>Description</h4>
            {waiting ? (
              <p className="live-empty">{lazy.failed ? "Could not load the description." : "Loading…"}</p>
            ) : p.body?.trim() ? (
              <Markdown text={p.body} className="md live-desc" />
            ) : (
              <p className="live-empty">No description.</p>
            )}
            {x.extra?.(p)}
            <p className="live-branch">{p.branch} → {p.base} · {linesChanged(p)}</p>
          </div>
        )}
      </div>
    </li>
  );
}

export function MyPrs({ items, meta, x = {} }: { items: FeedPr[]; meta?: FeedMeta; x?: PrExtras }) {
  return (
    <div className="view live">
      <header className="view-head">
        <h1>My PRs</h1>
        <p>Your open pull requests, and the comments others left for you to address.</p>
        <Source meta={meta} which="github" />
      </header>
      <Groups groups={groupMine(items)} empty="No open PRs of yours." row={(p) => <PrRow key={p.link} p={p} others={false} x={x} />} />
    </div>
  );
}

export function OthersPrs({ items, meta, x = {} }: { items: FeedPr[]; meta?: FeedMeta; x?: PrExtras }) {
  return (
    <div className="view live">
      <header className="view-head">
        <h1>Others' PRs</h1>
        <p>Other people's open PRs waiting on your review, that QA drafted a review for, or that you are part of.</p>
        <Source meta={meta} which="github" />
      </header>
      <Groups groups={groupOthers(items)} empty="No open PRs from others involve you." row={(p) => <PrRow key={p.link} p={p} others x={x} />} />
    </div>
  );
}

function TicketRow({ t }: { t: FeedTicket }) {
  return (
    <li className="live-row ticket-row" data-ticket={t.id}>
      <div className="live-main">
        <div className="live-line1">
          <span className="live-ref">{t.id}</span>
          {t.link ? <a className="live-title" href={t.link} target="_blank" rel="noopener noreferrer">{t.title}</a> : <span className="live-title">{t.title}</span>}
          <span className="live-chips">
            {priorityName(t.priority) && <span className={`prio prio-${t.priority}`}>{priorityName(t.priority)}</span>}
            <span className="status-pill"><i style={t.status_color ? { background: t.status_color } : undefined} aria-hidden="true" />{t.status}</span>
          </span>
        </div>
        <div className="live-line2">
          {t.project && <span>{t.project}</span>}
          <Labels labels={t.labels} />
          {t.due && <span>Due {t.due}</span>}
          {(t.prs ?? []).map((u) => {
            const m = /\/([^/]+)\/pull\/(\d+)/.exec(u);
            return <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="pr-link">PR {m ? `${m[1]} #${m[2]}` : ""}</a>;
          })}
          <span className="when">{ago(t.updated_at)}</span>
        </div>
      </div>
    </li>
  );
}

export function MyTickets({ items, meta }: { items: FeedTicket[]; meta?: FeedMeta }) {
  return (
    <div className="view live">
      <header className="view-head">
        <h1>My tickets</h1>
        <p>Your open Linear tickets, grouped by status.</p>
        <Source meta={meta} which="linear" />
      </header>
      <Groups groups={groupTickets(items)} empty="No open tickets assigned to you." row={(t) => <TicketRow key={t.id} t={t} />} />
    </div>
  );
}
