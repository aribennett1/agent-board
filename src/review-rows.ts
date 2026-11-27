// One stored row per drafted review comment. A per-comment review card (QA's "Which ... should be posted on #N?") and
// the Reviews tab ("Reviews waiting for your yes") render the SAME row: board.reviews[].comments[] is the source of
// truth, and a card finding stores only its card-side fields (n, label) plus `review`, the id of that row.
//
// - hydrateRows(board): on every read (ab, the board server, the backstop), copies each row's fields onto the card
//   findings that point at it, so every reader sees one state.
// - storeRows(board): on every write (ab save), links card findings that are inline copies to their row (same PR and
//   path, and the cN in the label, the same or a near line, or the same body or suggestion), writes what a writer
//   changed on a hydrated finding back to the row, and strips the copied fields off the card. A re-raise therefore
//   updates the row (line, head, context, body) instead of adding a second copy, and answering, posting or skipping
//   on either view writes that one row.
// A card on a PR with no drafted review keeps its findings inline: it is the only copy.

type Json = Record<string, any>;

/** Fields that live on the row. A card finding names the posted comment posted_url; the row names it url. */
export const ROW_FIELDS = ['severity', 'title', 'path', 'line', 'context', 'body', 'status', 'url', 'note', 'pending_bot', 'answer_to_question', 'revision_at', 'answered', 'head'] as const;
const onCard = (k: string) => (k === 'url' ? 'posted_url' : k);
const NEAR_LINES = 3;

const snapshots = new WeakMap<object, string>();
const shared = (f: Json) => JSON.stringify(ROW_FIELDS.map((k) => f[onCard(k)] ?? null));

/** repo and PR number a card is about: its PR link (glance.pr.link or card_ref), else a pr:<repo>/<n> group. */
export function cardPr(d: Json): { repo: string; pr: number } | null {
  const link = d?.glance?.pr?.link ?? (typeof d?.card_ref === 'string' ? d.card_ref : '');
  const m = /github\.com\/[^/]+\/([\w.-]+)\/pull\/(\d+)/.exec(String(link));
  if (m) return { repo: m[1], pr: Number(m[2]) };
  const g = /^pr:([\w.-]+)\/(\d+)$/.exec(String(d?.group ?? ''));
  return g ? { repo: g[1], pr: Number(g[2]) } : null;
}

const draftOf = (b: Json, p: { repo: string; pr: number } | null) =>
  p ? (Array.isArray(b.reviews) ? b.reviews : []).find((r: Json) => r && r.repo === p.repo && r.pr === p.pr) : undefined;
const cards = (b: Json): Json[] => (Array.isArray(b.decisions) ? b.decisions : []).filter((d: Json) => d && Array.isArray(d.post_comments));
const settled = (s: unknown) => s === 'posted' || s === 'skipped';
const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const suggestion = (s: unknown) => /```suggestion[^\n]*\n([\s\S]*?)```/.exec(String(s ?? ''))?.[1]?.trim() ?? null;
const samePath = (a: unknown, b: unknown) => {
  const x = String(a ?? ''), y = String(b ?? '');
  return !!x && !!y && (x === y || x.endsWith('/' + y) || y.endsWith('/' + x));
};
const labelId = (f: Json) => /\b(c\d+)\b/.exec(String(f.label ?? ''))?.[1];

/** The drafted-review row a card finding is (the same comment), or undefined. */
export function matchRow(rows: Json[], f: Json, taken: Set<string> = new Set()): Json | undefined {
  const free = rows.filter((r) => !taken.has(r.id) && samePath(r.path, f.path));
  // The cN in a card label is QA's own name for the row: it wins even when the rewrite moved to another file.
  const byLabel = labelId(f);
  if (byLabel) { const r = rows.find((x) => x.id === byLabel && !taken.has(x.id)); if (r) return r; }
  const s = suggestion(f.body);
  return free.find((r) => norm(r.body) === norm(f.body))
    ?? (s ? free.find((r) => suggestion(r.body) === s) : undefined)
    ?? (Number.isInteger(f.line) ? free.find((r) => Number.isInteger(r.line) && Math.abs(r.line - f.line) <= NEAR_LINES) : undefined);
}

function set(o: Json, k: string, v: unknown) {
  if (v === undefined || v === null && k !== 'line') delete o[k];
  else o[k] = v;
}

/** Copies the row onto the findings that point at it. Idempotent; returns the board. */
export function hydrateRows(b: Json): Json {
  for (const d of cards(b)) {
    const draft = draftOf(b, cardPr(d));
    if (!draft) continue;
    for (const f of d.post_comments) {
      if (!f || typeof f.review !== 'string') continue;
      const row = (draft.comments ?? []).find((r: Json) => r.id === f.review);
      if (!row) continue;
      for (const k of ROW_FIELDS) set(f, onCard(k), row[k]);
      snapshots.set(f, shared(f));
    }
  }
  return b;
}

/** A row built from a card finding that has no row yet. */
function newRow(rows: Json[], f: Json, d: Json): Json {
  const want = labelId(f);
  const used = new Set(rows.map((r) => r.id));
  let id = want && !used.has(want) ? want : '';
  for (let n = rows.length + 1; !id; n++) if (!used.has('c' + n)) id = 'c' + n;
  const row: Json = { id, severity: f.severity ?? 'low', path: f.path, line: Number.isInteger(f.line) ? f.line : null, body: f.body, status: f.status ?? 'pending' };
  if (d.sha) row.head = d.sha;
  return row;
}

/** Merges an inline (re-raised) finding into its row: the raise wins, except a posted or skipped row stays settled. */
function mergeInto(row: Json, f: Json, d: Json) {
  const keepSettled = settled(row.status) && !settled(f.status);
  for (const k of ROW_FIELDS) {
    if (k === 'head') continue;
    if (keepSettled && (k === 'status' || k === 'url' || k === 'pending_bot')) continue;
    const v = f[onCard(k)];
    if (k === 'status') { row.status = settled(v) ? v : keepSettled ? row.status : 'pending'; continue; }
    // A card may leave these out (it has no title, say): an absent one keeps the row's.
    if (['answered', 'note', 'url', 'title', 'severity', 'line', 'answer_to_question'].includes(k)) { if (v !== undefined) row[k] = v; continue; }
    set(row, k, v);
  }
  if (settled(row.status)) delete row.pending_bot;
  if (d.sha) row.head = d.sha;
}

/** Before a write: link inline findings to their row, write back what changed, strip copies off the cards. Returns ids linked. */
export function storeRows(b: Json): string[] {
  const linked: string[] = [];
  for (const d of cards(b)) {
    const p = cardPr(d);
    // A superseded card is history nobody renders: its copy is left as it was.
    const draft = d.superseded_by && !d.post_comments.some((f: Json) => typeof f?.review === 'string') ? undefined : draftOf(b, p);
    if (!draft) {
      for (const f of d.post_comments) if (f && snapshots.has(f)) { snapshots.delete(f); delete f.review; } // its draft went away: the card keeps the copy
      continue;
    }
    const rows: Json[] = Array.isArray(draft.comments) ? draft.comments : (draft.comments = []);
    const taken = new Set<string>(d.post_comments.map((f: Json) => f?.review).filter((x: unknown) => typeof x === 'string'));
    for (const f of d.post_comments) {
      if (!f || typeof f !== 'object') continue;
      let row = typeof f.review === 'string' ? rows.find((r) => r.id === f.review) : undefined;
      const snap = snapshots.get(f);
      if (row && snap !== undefined) {
        // A hydrated finding: only what a writer changed since the read goes to the row.
        const was = JSON.parse(snap) as unknown[];
        ROW_FIELDS.forEach((k, i) => { const v = f[onCard(k)] ?? null; if (JSON.stringify(v) !== JSON.stringify(was[i])) set(row!, k, v); });
      } else {
        if (!row && typeof f.review === 'string' && snap !== undefined) { // the bot replaced the draft without this row: keep it
          row = { id: f.review, severity: f.severity ?? 'low', path: f.path, line: f.line ?? null, body: f.body, status: f.status ?? 'pending' };
          rows.push(row); mergeInto(row, f, d);
        } else {
          if (!f.path || !f.body) continue; // a bare reference to a row that is gone: nothing to store
          row = row ?? matchRow(rows, f, taken);
          if (!row) { row = newRow(rows, f, d); rows.push(row); }
          mergeInto(row, f, d);
          linked.push(`${p!.repo}#${p!.pr}:${row.id}`);
        }
      }
      taken.add(row.id);
      f.review = row.id;
      for (const k of ROW_FIELDS) delete f[onCard(k)];
      snapshots.delete(f);
    }
  }
  return linked;
}

/**
 * Eric's Post or Don't post on either view, stored on the row the moment the answer is recorded, so the other view
 * closes too (the bot still posts and then sets status). Notes are parked separately (finding-notes.ts).
 */
export function markAnswered(b: Json, p: Json): boolean {
  if (p?.event !== 'review.answer' || (p.action !== 'post' && p.action !== 'skip')) return false;
  const at = Date.parse(p.answered_at);
  if (!Number.isFinite(at)) return false;
  const answered = { at: new Date(at).toISOString(), action: p.action as 'post' | 'skip' };
  const mark = (c: Json | undefined) => {
    if (!c || settled(c.status) || (c.answered && c.answered.at >= answered.at)) return false;
    c.answered = answered; delete c.pending_bot; return true;
  };
  if (typeof p.card_id === 'string' && p.card_id) {
    const d = cards(b).find((x) => x.id === p.card_id);
    if (!d) return false;
    if (p.comment_id === 'all') return d.post_comments.map((c: Json) => mark(c)).some(Boolean);
    const n = Number(p.finding ?? p.comment_id);
    return mark(d.post_comments.find((c: Json, i: number) => (Number.isInteger(c.n) ? c.n : Number(/#(\d+)\b/.exec(String(c.label ?? ''))?.[1] ?? i + 1)) === n));
  }
  if (typeof p.repo !== 'string' || p.comment_id === 'pr') return false;
  const r = draftOf(b, { repo: p.repo, pr: Number(p.pr) });
  return mark(r?.comments?.find((c: Json) => c.id === String(p.comment_id)));
}

/**
 * One-time backfill for rows stored before answers were kept on the row: his latest Post / Don't post (card or Reviews
 * tab) on a still-open row, after its last rewrite, becomes the row's answered. A later note wins over an older tap.
 * Call on a hydrated board; returns "repo#pr:id" for each row it closed.
 */
export function backfillAnswers(b: Json): string[] {
  const asks: Json[] = (Array.isArray(b.asks) ? b.asks : []).filter((a: Json) => a?.kind === 'review' && typeof a.ref === 'string' && typeof a.at === 'string');
  const out: string[] = [];
  const consider = (key: string, c: Json, words: (Json & { action: 'post' | 'skip' | 'note' })[]) => {
    if (!c || settled(c.status) || c.answered) return;
    const after = [c.revision_at, c.pending_bot?.at].filter(Boolean).sort().pop();
    const last = words.filter((w) => !after || w.at > after).sort((x, y) => (x.at < y.at ? -1 : 1)).pop();
    if (!last || last.action === 'note') return;
    c.answered = { at: last.at, action: last.action };
    out.push(key);
  };
  const cardWords = (d: Json, n: number) => asks.flatMap((a) => {
    if (a.ref === `${d.id}:all`) return [{ at: a.at, action: 'skip' as const }];
    if (a.ref !== `${d.id}:${n}`) return [];
    const said = String(a.text).slice(String(a.text).indexOf(': ') + 2).trim();
    return [{ at: a.at, action: /^post$/i.test(said) ? 'post' as const : /^don't post$/i.test(said) ? 'skip' as const : 'note' as const }];
  });
  const seen = new Set<string>();
  for (const d of cards(b)) {
    if (d.superseded_by) continue;
    const p = cardPr(d);
    d.post_comments.forEach((f: Json, i: number) => {
      if (typeof f?.review !== 'string' || !p) return;
      const n = Number.isInteger(f.n) ? f.n : Number(/#(\d+)\b/.exec(String(f.label ?? ''))?.[1] ?? i + 1);
      const key = `${p.repo}#${p.pr}:${f.review}`;
      const rowWords = asks.filter((a) => a.ref === key).map((a) => ({ at: a.at, action: /:post:/.test(a.id) ? 'post' as const : /:skip:/.test(a.id) ? 'skip' as const : 'note' as const }));
      consider(key, f, [...cardWords(d, n), ...rowWords]);
      seen.add(key);
    });
  }
  for (const r of Array.isArray(b.reviews) ? b.reviews : []) for (const c of r.comments ?? []) {
    const key = `${r.repo}#${r.pr}:${c.id}`;
    if (seen.has(key)) continue;
    consider(key, c, asks.filter((a) => a.ref === key).map((a) => ({ at: a.at, action: /:post:/.test(a.id) ? 'post' as const : /:skip:/.test(a.id) ? 'skip' as const : 'note' as const })));
  }
  return out;
}
