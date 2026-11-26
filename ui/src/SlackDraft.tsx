import { useState } from "react";
import type { Decision } from "./data/types";
import type { AppChoice } from "./delivery";
import { Link } from "./linkify";

export function isSlackDraft(d: Pick<Decision, "kind" | "slack">): boolean {
  return d.kind === "slack_draft" || Boolean(d.slack);
}

export function SlackDraftBlock({
  decision,
  onAnswer,
}: {
  decision: Decision;
  onAnswer: (pick: AppChoice) => void;
}) {
  const slack = decision.slack;
  const [text, setText] = useState(slack?.text ?? "");
  if (!slack) return null;
  const channel = slack.channel;
  const rows = Math.min(16, Math.max(6, text.split("\n").length + 1));
  return (
    <div className="slack-draft">
      <div className="slack-preview">
        <div className="slack-preview-head">
          <span className="slack-kicker">Slack</span>
          <span className="slack-channel">{channel}</span>
          {slack.permalink && (
            <Link className="slack-thread-link" href={slack.permalink}>
              Open thread
            </Link>
          )}
        </div>
        <label className="slack-text-label" htmlFor={`slack-text-${decision.id}`}>
          Message
        </label>
        <textarea
          id={`slack-text-${decision.id}`}
          className="slack-text"
          value={text}
          rows={rows}
          onChange={(e) => setText(e.target.value)}
          aria-label="Slack message"
        />
      </div>
      <div className="slack-actions">
        <button type="button" className="btn" disabled={!text.trim()} onClick={() => onAnswer({ action: "send", text })}>
          Send to Slack
        </button>
        <button type="button" className="btn ghost" onClick={() => onAnswer({ action: "decline" })}>
          Don't send
        </button>
      </div>
    </div>
  );
}
