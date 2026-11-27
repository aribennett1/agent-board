// Eric's rule (Nov 27 2026): a drafted review comment posts only the ask, starting at "What do you think about...",
// plus its suggestion or code. The feature story (what the PR adds, where the code comes in, the gap) is for him on
// the board and lives in the draft's `context` field, which is shown but never posted. Code enforces it, not the bots.

const FENCE = /^[ \t]*(```|~~~)/;
// Labels that only ever open a context story, bold or plain: "**What this PR adds.**", "Where this test comes in:".
const STORY = String.raw`what this pr (?:adds|does|changes|builds|is for)|where (?:this|the) [^\n]{1,60}? comes? in|the gap(?=[ \t]*[.:*_])`;
// Labels that are context only as a bold or heading label: "**The feature today.**", "### How retry works".
const LABELED = String.raw`the feature today|today|how (?:it|this|[^\n*]{1,40}?) works|what the ticket (?:asks|calls for)(?: for)?|the ticket|how this pr does it|what this comment is about|the ask|the question|context|background`;
const STORY_LEAD = new RegExp(String.raw`^(?:#{1,6}[ \t]+|\*\*|__)?(${STORY})\b`, 'i');
const LABEL_LEAD = new RegExp(String.raw`^(?:#{1,6}[ \t]+(${LABELED})\b|(?:\*\*|__)(${LABELED})[.:]?(?:\*\*|__))`, 'i');
// A board-only label in front of the ask ("**The ask**", "**The question:**"); it is cut, the ask after it is kept.
const ASK_LABEL = /^(?:\*\*|__)(?:the )?(?:ask|question)[.:]?(?:\*\*|__)[.:]?[ \t]*\n?/i;
// Where the posted comment starts: the ask.
const ASK_LEAD = /^(?:\*\*|__)?(?:what do you think|what about|how about|can you|could you|can we|could we|should we|would you)\b/i;

type Para = { start: number; text: string };

/** Paragraphs outside code fences, with their offset in the body. A fence is never split or read as prose. */
function paragraphs(body: string): Para[] {
  const out: Para[] = [];
  const lines = body.split('\n');
  let inFence = false;
  let cur: Para | null = null;
  let offset = 0;
  for (const line of lines) {
    const fence = FENCE.test(line);
    if (!inFence && !fence && line.trim()) {
      if (!cur) cur = { start: offset, text: '' };
      cur.text += (cur.text ? '\n' : '') + line.trim();
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
    if (fence) inFence = !inFence;
    offset += line.length + 1;
  }
  if (cur) out.push(cur);
  return out;
}

/** The context label a paragraph opens with ("What this PR adds", "The gap", ...), or null. */
export function contextLabel(paragraph: string): string | null {
  const s = paragraph.trim();
  const m = STORY_LEAD.exec(s) ?? LABEL_LEAD.exec(s);
  if (!m) return null;
  return (m[1] ?? m[2]).trim();
}

/** Why a comment body still carries the context story, or null when it is a clean posted body. */
export function contextInBodyError(body: unknown, field = 'body'): string | null {
  if (typeof body !== 'string') return null;
  for (const p of paragraphs(body)) {
    const label = contextLabel(p.text);
    if (label) {
      return `${field} opens a context section ("${label}"). The body is the only text posted on GitHub and must start at the ask ("What do you think about ...") plus its suggestion or code; put the story (what the PR adds, where the code comes in, the gap, diagrams) in the comment's "context" field, which Eric sees on the board and is never posted`;
    }
  }
  return null;
}

/** Splits a body whose story (at least one context label) comes before the ask: {context, body}, or null when the pattern is not clear. */
export function splitContext(body: string): { context: string; body: string } | null {
  const paras = paragraphs(body);
  const at = paras.findIndex((p) => ASK_LEAD.test(p.text.replace(ASK_LABEL, '')));
  if (at < 0 || !paras.slice(0, at).some((p) => contextLabel(p.text))) return null;
  const ask = paras[at];
  const rest = body.slice(ask.start).replace(/^[ \t]+/, '').replace(ASK_LABEL, '');
  // A context label after the ask means the shape is mixed; leave it for a person.
  if (contextInBodyError(rest)) return null;
  const context = body.slice(0, ask.start).trim();
  const posted = rest.trim();
  if (!context || !posted) return null;
  return { context, body: posted };
}

/** The text that may be posted: the body with any leading context story cut off. Unclear shapes come back as is. */
export function postableBody(body: string): string {
  return splitContext(body)?.body ?? body;
}

/** Splits a body with no labels at its first ask: the plain observation before it becomes context. Null when unclear. */
export function splitAtAsk(body: string): { context: string; body: string } | null {
  const paras = paragraphs(body);
  const at = paras.findIndex((p) => ASK_LEAD.test(p.text.replace(ASK_LABEL, '')));
  if (at <= 0) return null;
  const rest = body.slice(paras[at].start).replace(/^[ \t]+/, '').replace(ASK_LABEL, '').trim();
  if (contextInBodyError(rest)) return null;
  const context = body.slice(0, paras[at].start).trim();
  return context && rest ? { context, body: rest } : null;
}

const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** Moves a clear leading context story from c.body into c.context (appended to any existing context). A comment with no
 * context yet also gives up a plain observation in front of its ask. True when changed. */
export function moveContextOut(c: { body?: unknown; context?: unknown }): boolean {
  if (typeof c.body !== 'string') return false;
  const split = splitContext(c.body) ?? (hasText(c.context) ? null : splitAtAsk(c.body));
  if (!split) return false;
  const prior = hasText(c.context) ? c.context.trim() + '\n\n' : '';
  c.context = prior + split.context;
  c.body = split.body;
  return true;
}

type Draft = { id?: string; n?: number; label?: string; status?: string; body?: unknown; context?: unknown };
type Card = { id: string; context?: unknown; card_ref?: unknown; group?: unknown; answer?: unknown; post_comments?: Draft[] };
type Board = { reviews?: { repo: string; pr: number; comments?: Draft[] }[]; decisions?: Card[] };
const open = (c: { status?: string }) => c.status !== 'posted' && c.status !== 'skipped';
const reviewKey = (r: { repo: string; pr: number }, c: Draft, i: number) => `review:${r.repo}#${r.pr}:${c.id ?? i}`;
const findingKey = (d: Card, c: Draft, i: number) => `${d.id}:${c.n ?? i + 1}`;

/** Moves the context story out of every open drafted comment (Reviews tab and per-finding cards). Safe to rerun. */
export function splitBoardContext(b: Board): string[] {
  const moved: string[] = [];
  for (const r of b.reviews ?? []) (r.comments ?? []).forEach((c, i) => { if (open(c) && moveContextOut(c)) moved.push(reviewKey(r, c, i)); });
  for (const d of b.decisions ?? []) (d.post_comments ?? []).forEach((c, i) => { if (open(c) && moveContextOut(c)) moved.push(findingKey(d, c, i)); });
  return moved;
}

/** The PR number a card is about, from its GitHub link or its repo#123 group. */
function cardPr(d: Card): number | null {
  const m = /\/pull\/(\d+)/.exec(String(d.card_ref ?? '')) ?? /#(\d+)$/.exec(String(d.group ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Fills context on open drafted comments that have none, in order: the same comment's story in an earlier board (the
 * pre-split backup), the card's own context (for a finding on a card), or the context of the card finding for the same
 * PR comment (label "#1 c3" for Reviews-tab c3). Returns what was filled and from where. Safe to rerun.
 */
export function recoverBoardContext(b: Board, earlier?: Board): { id: string; from: string }[] {
  const out: { id: string; from: string }[] = [];
  const fromEarlier = (body: unknown, prior: Draft | undefined) => {
    if (!prior || typeof prior.body !== 'string') return null;
    const s = splitContext(prior.body);
    return s && typeof body === 'string' && s.body.trim() === body.trim() ? s.context : null;
  };
  for (const d of b.decisions ?? []) {
    const was = (earlier?.decisions ?? []).find((x) => x.id === d.id);
    (d.post_comments ?? []).forEach((c, i) => {
      if (!open(c) || hasText(c.context)) return;
      const prior = was?.post_comments?.find((x, j) => (x.n ?? j + 1) === (c.n ?? i + 1));
      const story = fromEarlier(c.body, prior);
      if (story) { c.context = story; out.push({ id: findingKey(d, c, i), from: 'backup' }); }
      else if (hasText(d.context)) { c.context = d.context.trim(); out.push({ id: findingKey(d, c, i), from: 'card' }); }
    });
  }
  for (const r of b.reviews ?? []) {
    const was = (earlier?.reviews ?? []).find((x) => x.repo === r.repo && x.pr === r.pr);
    (r.comments ?? []).forEach((c, i) => {
      if (!open(c) || hasText(c.context)) return;
      const story = fromEarlier(c.body, was?.comments?.find((x) => x.id === c.id));
      if (story) { c.context = story; out.push({ id: reviewKey(r, c, i), from: 'backup' }); return; }
      if (!c.id) return;
      const tag = new RegExp(`(^|\\s)${c.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
      for (const d of b.decisions ?? []) {
        if (cardPr(d) !== r.pr) continue;
        const f = (d.post_comments ?? []).find((x) => tag.test(String(x.label ?? '')) && hasText(x.context));
        if (f) { c.context = String(f.context).trim(); out.push({ id: reviewKey(r, c, i), from: `card ${d.id}` }); return; }
      }
    });
  }
  return out;
}

/** Open drafted comments that still have no context for Eric. */
export function missingContext(b: Board): string[] {
  const out: string[] = [];
  for (const r of b.reviews ?? []) (r.comments ?? []).forEach((c, i) => { if (open(c) && !hasText(c.context)) out.push(reviewKey(r, c, i)); });
  for (const d of b.decisions ?? []) if (!d.answer) (d.post_comments ?? []).forEach((c, i) => { if (open(c) && !hasText(c.context)) out.push(findingKey(d, c, i)); });
  return out;
}

/** Why an unposted drafted comment cannot be stored without context, or null. */
export function missingContextError(c: Draft, field: string): string | null {
  if (!open(c) || hasText(c.context)) return null;
  return `${field} needs a non-empty "context": the story Eric reads on the board before he decides (what the PR adds, how the code works today, the gap). It is never posted; the body stays the ask only`;
}
