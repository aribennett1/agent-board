// Slack draft cards: a bot never posts to Slack until Eric taps Send on this card.
// The stored message must already start with the standing attribution line.

export const SLACK_PREFIX = "This is Eric's bot posting on his behalf.";

export type SlackDraftFields = {
  channel_id: string;
  channel: string;
  text: string;
  thread_ts?: string;
  permalink?: string;
};

const SLACK_KEYS = new Set(['channel_id', 'channel', 'text', 'thread_ts', 'permalink']);

export function isSlackDraft(d: { kind?: unknown; slack?: unknown }): boolean {
  return d.kind === 'slack_draft' || (d.slack != null && typeof d.slack === 'object' && !Array.isArray(d.slack));
}

export function slackDraftError(d: { kind?: unknown; slack?: unknown }): string | null {
  if (d.kind !== undefined && d.kind !== 'slack_draft') return 'kind must be slack_draft when set';
  if (d.kind === 'slack_draft' && (d.slack == null || typeof d.slack !== 'object' || Array.isArray(d.slack))) {
    return 'slack_draft cards need a slack object: {channel_id, channel, text, thread_ts?, permalink?}';
  }
  if (!isSlackDraft(d)) return null;
  const s = d.slack as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!SLACK_KEYS.has(k)) return 'unknown slack field ' + k;
  const id = typeof s.channel_id === 'string' ? s.channel_id.trim() : '';
  if (!id || !/^[CGD][A-Z0-9]{8,}$/i.test(id)) return 'slack.channel_id must be a Slack channel id (starts with C, G or D)';
  if (typeof s.channel !== 'string' || !s.channel.trim()) return 'slack.channel is required (the readable name, for example #qa)';
  if (typeof s.text !== 'string' || !s.text.trim()) return 'slack.text is required';
  if (!s.text.trimStart().startsWith(SLACK_PREFIX)) {
    return 'slack.text must start with "This is Eric\'s bot posting on his behalf."';
  }
  if (s.thread_ts !== undefined) {
    const ts = typeof s.thread_ts === 'string' || typeof s.thread_ts === 'number' ? String(s.thread_ts).trim() : '';
    if (!/^\d+\.\d+$/.test(ts)) return 'slack.thread_ts must look like a Slack timestamp (for example 1732650000.123456)';
  }
  if (s.permalink !== undefined) {
    if (typeof s.permalink !== 'string' || !/^https:\/\//.test(s.permalink.trim())) return 'slack.permalink must be an https URL';
  }
  return null;
}

export function normalizeSlack(s: SlackDraftFields): SlackDraftFields {
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
  const out: SlackDraftFields = {
    channel_id: str(s.channel_id),
    channel: str(s.channel),
    text: typeof s.text === 'string' ? s.text.trim() : '',
  };
  if (str(s.thread_ts)) out.thread_ts = str(s.thread_ts);
  if (str(s.permalink)) out.permalink = str(s.permalink);
  return out;
}
