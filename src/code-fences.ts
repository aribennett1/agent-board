// Write-time check and normalizer: user-visible card text that is clearly code
// but not in a fenced block is wrapped when the pattern is unambiguous (a
// language tag like `php ` followed by code). Leftover bare multi-line dumps
// are rejected so every bot gets the same rule. Existing stored cards are left
// alone; only new writes (ab raise, ab slack-draft, ab notify, and the same
// checks on re-raise) are touched.
//
// Normalization rather than a hard reject on the language-tag pattern: bots
// already try to write fences, and a retry would cost a wake. The renderer
// also handles proper fences, including ones nested in lists or details items.

import { visibleFields } from './ticket-links.ts';

type Json = { [k: string]: unknown };

export const CODE_LANGS = [
  'php',
  'sql',
  'javascript',
  'typescript',
  'tsx',
  'jsx',
  'json',
  'bash',
  'shell',
  'diff',
  'ts',
  'js',
  'sh',
  'zsh',
  'python',
  'py',
  'rb',
  'ruby',
  'go',
  'rust',
  'css',
  'html',
  'xml',
  'yaml',
  'yml',
] as const;

const LANG = CODE_LANGS.join('|');
const LANG_PREFIX = new RegExp(`^(${LANG})[ \\t]+(\\S[\\s\\S]*)$`, 'i');
const LIST_LANG_PREFIX = new RegExp(`^(\\s*(?:[-*+]|\\d+[.)])\\s+)(${LANG})[ \\t]+(\\S.*)$`, 'i');
const CODE_HINT = /(?:[;{}]|::|->|=>|\$\w|function\s|const\s+|let\s+|var\s+|SELECT\s+|<\?php|:=)/i;
const FENCE = /```|~~~/;
const BARE_DUMP = /^(?:<\?php|\$\w+\s*=|(?:async\s+)?function\s+\w+\s*\(|(?:const|let|var)\s+\w+\s*=|SELECT\s+\S)/i;

export function looksLikeCode(s: string): boolean {
  const t = s.trim();
  if (!t || FENCE.test(t)) return false;
  return CODE_HINT.test(t);
}

function wrap(lang: string, body: string): string {
  const code = body.replace(/^\n+|\n+$/g, '');
  return '```' + lang.toLowerCase() + '\n' + code + '\n```';
}

function wrapLangPrefixed(text: string): string | null {
  const m = text.trimStart().match(LANG_PREFIX);
  if (m && looksLikeCode(m[2])) return wrap(m[1], m[2]);
  return null;
}

function fenceListItems(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let changed = false;
  for (const line of lines) {
    const m = line.match(LIST_LANG_PREFIX);
    if (m && looksLikeCode(m[3]) && !FENCE.test(m[3])) {
      const pad = ' '.repeat(Math.max(2, m[1].length));
      out.push(`${m[1]}\`\`\`${m[2].toLowerCase()}`);
      out.push(pad + m[3]);
      out.push(pad + '```');
      changed = true;
    } else {
      out.push(line);
    }
  }
  return changed ? out.join('\n') : text;
}

/** Wrap unambiguous unfenced code (language-tag prefix, or the same on a list item). */
export function fenceBareCode(text: string): string {
  if (typeof text !== 'string' || !text) return text;
  const whole = wrapLangPrefixed(text);
  if (whole) return whole;
  return fenceListItems(text);
}

export function guessLang(text: string): string {
  if (/<\?php|\$\w|::|->|function\s+\w+\s*\(/.test(text) && /;/.test(text)) return 'php';
  if (/^\s*SELECT\s+/im.test(text)) return 'sql';
  if (/^\s*(diff --git|--- |\+\+\+ |@@ )/.test(text)) return 'diff';
  if (/^\s*[{[]/.test(text.trim()) && /":/.test(text)) return 'json';
  if (/^\s*(const|let|var|function|import|export)\s/.test(text)) return 'ts';
  if (text.trimStart().startsWith('#!') || /^\s*(npm|yarn|pnpm|cd|export)\s/.test(text)) return 'bash';
  return 'php';
}

/** After normalization, leftover multi-line code dumps still need a fence. */
export function unfencedCodeError(text: string, field?: string): string | null {
  if (typeof text !== 'string' || !text || FENCE.test(text)) return null;
  const t = text.trim();
  // A details item or field that is itself a bare code dump (no language tag, no surrounding prose).
  const lines = t.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return null;
  if (!BARE_DUMP.test(t) || !looksLikeCode(t)) return null;
  // Prose that happens to mention a $variable on the first line still has sentence structure.
  if (/^[A-Z][^;{]{12,}[.?!]\s/.test(t)) return null;
  const lang = guessLang(t);
  const prefix = field ? field + ': ' : '';
  return prefix + 'put code in a fenced ```' + lang + ' block';
}

function setPath(d: Json, field: string, value: string): void {
  const item = /^details\[(\d+)\](?:\.items\[(\d+)\])?$/.exec(field);
  if (item) {
    const details = Array.isArray(d.details) ? d.details : null;
    if (!details) return;
    const block = details[Number(item[1])];
    if (item[2] === undefined) {
      if (typeof block === 'string') details[Number(item[1])] = value;
      return;
    }
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      const items = (block as Json).items;
      if (Array.isArray(items)) items[Number(item[2])] = value;
    }
    return;
  }
  const opt = /^(options|post_comments)\[(\d+)\]\.(label|post_text|summary|body)$/.exec(field);
  if (opt) {
    const arr = d[opt[1]];
    if (!Array.isArray(arr)) return;
    const row = arr[Number(opt[2])];
    if (row && typeof row === 'object' && !Array.isArray(row)) (row as Json)[opt[3]] = value;
    return;
  }
  const glanceOut = /^glance\.outcomes\[(\d+)\]\.happens$/.exec(field);
  if (glanceOut) {
    const glance = d.glance && typeof d.glance === 'object' && !Array.isArray(d.glance) ? (d.glance as Json) : null;
    if (!glance || !Array.isArray(glance.outcomes)) return;
    const row = glance.outcomes[Number(glanceOut[1])];
    if (row && typeof row === 'object' && !Array.isArray(row)) (row as Json).happens = value;
    return;
  }
  if (field === 'slack.text') {
    const slack = d.slack && typeof d.slack === 'object' && !Array.isArray(d.slack) ? (d.slack as Json) : null;
    if (slack) slack.text = value;
    return;
  }
  if (field === 'recommendation.reason') {
    const rec = d.recommendation && typeof d.recommendation === 'object' && !Array.isArray(d.recommendation) ? (d.recommendation as Json) : null;
    if (rec) rec.reason = value;
    return;
  }
  if (field === 'glance.asking') {
    const glance = d.glance && typeof d.glance === 'object' && !Array.isArray(d.glance) ? (d.glance as Json) : null;
    if (glance) glance.asking = value;
    return;
  }
  if (field === 'glance.ticket.summary') {
    const glance = d.glance && typeof d.glance === 'object' && !Array.isArray(d.glance) ? (d.glance as Json) : null;
    const ticket = glance && glance.ticket && typeof glance.ticket === 'object' && !Array.isArray(glance.ticket) ? (glance.ticket as Json) : null;
    if (ticket) ticket.summary = value;
    return;
  }
  if (field === 'answers_comment.body') {
    const comment = d.answers_comment && typeof d.answers_comment === 'object' && !Array.isArray(d.answers_comment) ? (d.answers_comment as Json) : null;
    if (comment) comment.body = value;
    return;
  }
  if (field in d && typeof d[field] === 'string') d[field] = value;
}

function extraFields(d: Json): [string, string][] {
  const out: [string, string][] = [];
  const push = (field: string, v: unknown) => {
    if (typeof v === 'string' && v) out.push([field, v]);
  };
  push('seen', d.seen);
  push('proposed_fix', d.proposed_fix);
  if (Array.isArray(d.fixes)) {
    d.fixes.forEach((f, i) => {
      if (f && typeof f === 'object' && !Array.isArray(f)) {
        const row = f as Json;
        push(`fixes[${i}].seen`, row.seen);
        push(`fixes[${i}].proposed`, row.proposed);
      }
    });
  }
  return out;
}

function setExtra(d: Json, field: string, value: string): void {
  if (field === 'seen' || field === 'proposed_fix') {
    d[field] = value;
    return;
  }
  const m = /^fixes\[(\d+)\]\.(seen|proposed)$/.exec(field);
  if (!m || !Array.isArray(d.fixes)) return;
  const row = d.fixes[Number(m[1])];
  if (row && typeof row === 'object' && !Array.isArray(row)) (row as Json)[m[2]] = value;
}

/** Wrap language-prefixed unfenced code on every user-visible card field. Mutates `d`. */
export function applyCodeFences(d: Json): void {
  for (const [field, text] of visibleFields(d)) {
    const next = fenceBareCode(text);
    if (next !== text) setPath(d, field, next);
  }
  for (const [field, text] of extraFields(d)) {
    const next = fenceBareCode(text);
    if (next !== text) setExtra(d, field, next);
  }
}

export function cardCodeFenceError(d: Json): string | null {
  for (const [field, text] of [...visibleFields(d), ...extraFields(d)]) {
    const e = unfencedCodeError(text, field);
    if (e) return e;
  }
  return null;
}
