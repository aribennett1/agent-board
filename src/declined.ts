// A finding Eric already skipped on a PR must never come back as an open question on a later review pass.
// The board remembers every skipped finding per PR (the "declined" list) and files a new finding that matches
// one as skipped, with his earlier note.

export type Finding = {
  path?: string;
  line?: number | null;
  title?: string;
  label?: string;
  body?: string;
  status?: string;
  note?: string;
  [k: string]: unknown;
};

export type Declined = { path: string; line: number | null; title: string; body: string; note: string };

const NEARBY_LINES = 3;
const MIN_SIMILARITY = 0.4;
const MAX_DECLINED = 60;
const DEFAULT_NOTE = 'Eric turned this down earlier';

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[`*_>#]/g, '').replace(/[^\p{L}\p{N}$-]+/gu, ' ').trim();
const pathOf = (s: unknown) => String(s ?? '').trim().replace(/^\.?\//, '');

/** The replacement code inside a ```suggestion block, normalized; empty when there is none. */
export function suggestionOf(body: unknown): string {
  const m = /```suggestions?[^\n]*\n([\s\S]*?)```/.exec(String(body ?? ''));
  return m ? norm(m[1]) : '';
}

function tokens(s: unknown): Set<string> {
  return new Set(norm(s).split(' ').filter((w) => w.length > 3));
}

function similarity(a: unknown, b: unknown): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** Same file, and the same title, the same suggestion text, or a nearby line with a similar body. */
export function matchesDeclined(f: Finding, d: Declined): boolean {
  if (!f.path || pathOf(f.path) !== pathOf(d.path)) return false;
  const title = norm(f.title);
  if (title && title === norm(d.title)) return true;
  const sug = suggestionOf(f.body);
  if (sug && sug === suggestionOf(d.body)) return true;
  const near = typeof f.line === 'number' && typeof d.line === 'number' && Math.abs(f.line - d.line) <= NEARBY_LINES;
  return near && similarity(f.body, d.body) >= MIN_SIMILARITY;
}

// A comment skipped only because GitHub deleted it was not Eric turning it down.
const isDeclined = (c: Finding) => c.status === 'skipped' && !/^deleted on github/i.test(c.note ?? '');

const toDeclined = (c: Finding): Declined => ({
  path: pathOf(c.path),
  line: typeof c.line === 'number' ? c.line : null,
  title: String(c.title ?? c.label ?? ''),
  body: String(c.body ?? '').slice(0, 2000),
  note: (c.note ?? '').trim() || DEFAULT_NOTE,
});

/** Everything skipped so far on one PR: its stored declined list plus the skipped comments of its previous pass. */
export function declinedOf(prior: { declined?: Declined[]; comments?: Finding[] } | undefined): Declined[] {
  const out: Declined[] = [...(prior?.declined ?? [])];
  for (const c of prior?.comments ?? []) {
    if (!isDeclined(c)) continue;
    const d = toDeclined(c);
    if (!out.some((o) => matchesDeclined({ path: d.path, line: d.line, title: d.title, body: d.body }, o))) out.push(d);
  }
  return out.slice(-MAX_DECLINED);
}

/** File every new finding that matches an earlier skip as skipped, carrying the earlier note. Posted ones stay posted. */
export function carryDeclined<T extends Finding>(known: Declined[], incoming: T[]): { comments: T[]; carried: number } {
  let carried = 0;
  const comments = incoming.map((c) => {
    if (c.status === 'posted' || c.status === 'skipped') return c;
    const hit = known.find((d) => matchesDeclined(c, d));
    if (!hit) return c;
    carried++;
    return { ...c, status: 'skipped', note: hit.note };
  });
  return { comments, carried };
}

/** Skipped findings for one PR across stored reviews and decision cards, for a card that carries its own findings. */
export function declinedForPr(board: any, repo: string, pr: number): Declined[] {
  const out: Declined[] = [];
  const add = (src: Declined[]) => { for (const d of src) if (!out.some((o) => matchesDeclined({ path: d.path, line: d.line, title: d.title, body: d.body }, o))) out.push(d); };
  for (const r of Array.isArray(board?.reviews) ? board.reviews : []) if (r.repo === repo && r.pr === pr) add(declinedOf(r));
  for (const d of Array.isArray(board?.decisions) ? board.decisions : []) {
    if (d.group === `pr:${repo}/${pr}`) add(declinedOf({ comments: Array.isArray(d.post_comments) ? d.post_comments : [] }));
  }
  return out;
}
