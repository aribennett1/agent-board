// Eric's style rule: a review comment that suggests a quiet Eloquent swap (update to updateQuietly, save to
// saveQuietly, ...) says only "`updateQuietly()`" and then the suggestion block. Code enforces it, not the bots.

const SUGGESTION_BLOCK = /^[ \t]*```suggestion[^\n]*\n[\s\S]*?^[ \t]*```[ \t]*$/gm;
const ANY_FENCE = /^[ \t]*```[\s\S]*?^[ \t]*```[ \t]*$/gm;
const QUIET_IN_CODE = /->([a-z]\w*Quietly)\s*\(/g;
const CODE_SPAN = /`([^`\n]+)`/g;
// A body with no suggestion block is only trimmed when it is this short, so a long multi-issue comment is never cut.
const MAX_BODY_WITHOUT_SUGGESTION = 700;

const unique = (list: string[]) => [...new Set(list)];

/** The quiet method a review body suggests, or null when the body is not a quiet swap. */
export function quietSwapMethod(body: string): string | null {
  const blocks = body.match(SUGGESTION_BLOCK) ?? [];
  if (blocks.length > 1) return null;
  const prose = body.replace(ANY_FENCE, '');
  const spans = [...prose.matchAll(CODE_SPAN)].map((m) => m[1]);
  const mentioned = unique(spans.flatMap((s) => [...s.matchAll(/\b([a-z]\w*Quietly)\b/g)].map((m) => m[1])));
  if (!mentioned.length) return null;
  const inCode = unique([...(blocks[0] ?? '').matchAll(QUIET_IN_CODE)].map((m) => m[1]));
  if (blocks.length === 1 && !inCode.length) return null;
  if (blocks.length === 0 && body.length > MAX_BODY_WITHOUT_SUGGESTION) return null;
  const candidates = blocks.length ? inCode : mentioned;
  const swapped = (name: string) => {
    const plain = new RegExp(`\\b${name.slice(0, -'Quietly'.length)}\\s*\\(`);
    return spans.some((s) => plain.test(s));
  };
  return candidates.find(swapped) ?? candidates[0];
}

/** "`updateQuietly()`" plus the original suggestion block, or null when the body is not a quiet swap. */
export function quietSwapBody(body: string): string | null {
  const method = quietSwapMethod(body);
  if (!method) return null;
  const block = (body.match(SUGGESTION_BLOCK) ?? [])[0];
  return `\`${method}()\`${block ? `\n\n${block.replace(/^[ \t]*(?=```)/, '')}` : ''}`;
}

/** Rewrites a review comment's body (and its title or summary when set) in place. Returns true when it changed. */
export function applyQuietSwap(c: { body?: unknown; title?: unknown; summary?: unknown }): boolean {
  if (typeof c.body !== 'string') return false;
  const next = quietSwapBody(c.body);
  if (next === null) return false;
  const method = quietSwapMethod(next)!;
  const changed = next !== c.body;
  c.body = next;
  for (const k of ['title', 'summary'] as const) {
    if (typeof c[k] === 'string') {
      const short = `Use \`${method}()\``;
      if (c[k] !== short) {
        c[k] = short;
        return true;
      }
    }
  }
  return changed;
}

/** The same trim for a bare text string (post_text, a posted body). Non-quiet text comes back unchanged. */
export function quietSwapText(text: string): string {
  return quietSwapBody(text) ?? text;
}
