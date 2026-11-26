// Write-time check: user-visible board text may not mention a Linear ticket or GitHub PR
// unless that mention is a markdown link (or already inside a URL). Existing stored cards
// are left alone; only new writes (ab raise, ab slack-draft, ab notify, and the same
// checks on re-raise) are refused.

export const LINEAR_ISSUE = 'https://linear.app/rows/issue';
export const GITHUB_PR = 'https://github.com/ROWSHR/<repo>/pull';

export type BareRef = { kind: 'ticket' | 'pr'; raw: string; key: string };

type Json = { [k: string]: unknown };

const TICKET_RE = /\bROWS-\d+\b/gi;
const PR_WORD_RE = /\bPR\s*#?(\d+)\b/gi;
const REPO_PR_RE = /\b([A-Za-z0-9._-]+)#(\d+)\b/g;
const HASH_PR_RE = /#(\d{3,})\b/g;
const FINDING_BEFORE = /(?:finding|comment|fix|item|option|question)\s*$/i;

function maskLinked(text: string): string {
  return text
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => ' '.repeat(m.length))
    .replace(/https?:\/\/[^\s)]+/gi, (m) => ' '.repeat(m.length));
}

export function bareRefs(text: string): BareRef[] {
  if (typeof text !== 'string' || !text) return [];
  const masked = maskLinked(text);
  const out: BareRef[] = [];
  const seen = new Set<string>();
  const add = (kind: BareRef['kind'], raw: string, key: string) => {
    const id = kind + ':' + key.toUpperCase();
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ kind, raw, key });
  };
  for (const m of masked.matchAll(TICKET_RE)) add('ticket', m[0], m[0].toUpperCase());
  for (const m of masked.matchAll(PR_WORD_RE)) add('pr', m[0], m[1]);
  for (const m of masked.matchAll(REPO_PR_RE)) add('pr', m[0], m[2]);
  for (const m of masked.matchAll(HASH_PR_RE)) {
    const start = m.index ?? 0;
    if (FINDING_BEFORE.test(masked.slice(Math.max(0, start - 24), start))) continue;
    add('pr', m[0], m[1]);
  }
  return out;
}

/** Ticket keys (ROWS-1234) and PR numbers this card already links via group or card_ref. */
export function ownRefKeys(d: Json): Set<string> {
  const keys = new Set<string>();
  const addTicket = (v: string) => keys.add(v.toUpperCase());
  const addPr = (v: string) => keys.add(v);
  const group = typeof d.group === 'string' ? d.group.trim() : '';
  let m = /^(?:ticket:)?(ROWS-\d+)$/i.exec(group);
  if (m) addTicket(m[1]);
  m = /^#(\d+)$/.exec(group);
  if (m) addPr(m[1]);
  m = /^([A-Za-z0-9._-]+)#(\d+)$/.exec(group);
  if (m) addPr(m[2]);
  const url = typeof d.card_ref === 'string' ? d.card_ref : typeof d.link === 'string' ? d.link : '';
  m = /linear\.app\/rows\/issue\/(ROWS-\d+)/i.exec(url);
  if (m) addTicket(m[1]);
  m = /github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/i.exec(url);
  if (m) addPr(m[1]);
  return keys;
}

export function ticketLinkError(text: string, field?: string, ignore?: Set<string>): string | null {
  const refs = bareRefs(text).filter((r) => !ignore || (!ignore.has(r.key) && !ignore.has(r.key.toUpperCase())));
  if (!refs.length) return null;
  const parts: string[] = [];
  const tickets = [...new Set(refs.filter((r) => r.kind === 'ticket').map((r) => r.key))];
  const prs = [...new Set(refs.filter((r) => r.kind === 'pr').map((r) => r.key))];
  if (tickets.length) {
    parts.push('link tickets as ' + tickets.map((k) => `[${k}](${LINEAR_ISSUE}/${k})`).join(' or '));
  }
  if (prs.length) {
    parts.push('link PRs as ' + prs.map((n) => `[#${n}](${GITHUB_PR}/${n})`).join(' or '));
  }
  return (field ? field + ': ' : '') + parts.join('. ');
}

function push(out: [string, string][], field: string, v: unknown): void {
  if (typeof v === 'string' && v) out.push([field, v]);
}

/** User-visible text on a card, for the write-time link check. Skips group, card_ref, ids. */
export function visibleFields(d: Json): [string, string][] {
  const out: [string, string][] = [];
  for (const k of ['title', 'context', 'question', 'what_happens_after', 'joke', 'draft', 'post_text', 'current_text'] as const) {
    push(out, k, d[k]);
  }
  const slack = d.slack && typeof d.slack === 'object' && !Array.isArray(d.slack) ? (d.slack as Json) : null;
  if (slack) push(out, 'slack.text', slack.text);
  const rec = d.recommendation && typeof d.recommendation === 'object' && !Array.isArray(d.recommendation) ? (d.recommendation as Json) : null;
  if (rec) push(out, 'recommendation.reason', rec.reason);
  const glance = d.glance && typeof d.glance === 'object' && !Array.isArray(d.glance) ? (d.glance as Json) : null;
  if (glance) {
    push(out, 'glance.asking', glance.asking);
    const ticket = glance.ticket && typeof glance.ticket === 'object' && !Array.isArray(glance.ticket) ? (glance.ticket as Json) : null;
    if (ticket) push(out, 'glance.ticket.summary', ticket.summary);
    if (Array.isArray(glance.outcomes)) {
      glance.outcomes.forEach((o, i) => {
        if (o && typeof o === 'object' && !Array.isArray(o)) push(out, `glance.outcomes[${i}].happens`, (o as Json).happens);
      });
    }
  }
  if (Array.isArray(d.details)) {
    d.details.forEach((x, i) => {
      if (typeof x === 'string') push(out, `details[${i}]`, x);
      else if (x && typeof x === 'object') {
        const block = x as Json;
        push(out, `details[${i}].label`, block.label);
        if (Array.isArray(block.items)) block.items.forEach((it, j) => push(out, `details[${i}].items[${j}]`, it));
      }
    });
  }
  if (Array.isArray(d.options)) {
    d.options.forEach((o, i) => {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return;
      const opt = o as Json;
      push(out, `options[${i}].label`, opt.label);
      push(out, `options[${i}].post_text`, opt.post_text);
      push(out, `options[${i}].summary`, opt.summary);
    });
  }
  const comment = d.answers_comment && typeof d.answers_comment === 'object' && !Array.isArray(d.answers_comment) ? (d.answers_comment as Json) : null;
  if (comment) push(out, 'answers_comment.body', comment.body);
  if (Array.isArray(d.post_comments)) {
    d.post_comments.forEach((c, i) => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) return;
      const row = c as Json;
      push(out, `post_comments[${i}].body`, row.body);
      push(out, `post_comments[${i}].summary`, row.summary);
    });
  }
  return out;
}

export function cardTicketLinkError(d: Json): string | null {
  const own = ownRefKeys(d);
  for (const [field, text] of visibleFields(d)) {
    // Slack message text is posted off the board, so the card's own link does not count there.
    const e = ticketLinkError(text, field, field === 'slack.text' ? undefined : own);
    if (e) return e;
  }
  return null;
}
