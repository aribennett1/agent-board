// A free-text note on a review finding ("Send to assistant") takes the finding off Eric's turn: the server stores the note
// on the finding as pending_bot {at, note}. It stays off his turn until the bot rewrites the draft (a changed body, or
// ab review-status --body / --answer-to-question) or posts or skips it; then pending_bot is gone and he is asked again.

type Json = Record<string, any>;

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The finding number on a per-comment review card: its n, else #N in the label, else its place in the list. */
export function findingNumber(c: Json, index: number): number | null {
  if (Number.isInteger(c.n) && c.n > 0) return c.n;
  const m = /#(\d+)\b/.exec(String(c.label ?? ''));
  return m ? Number(m[1]) : index + 1;
}

const isNote = (p: Json) => p.event === 'review.answer' && p.action === 'note' && Boolean(text(p.text));

function park(c: Json | undefined, p: Json): boolean {
  if (!c || c.status === 'posted' || c.status === 'skipped') return false;
  const at = Date.parse(p.answered_at);
  if (!Number.isFinite(at) || (c.revision_at && at <= Date.parse(c.revision_at))) return false;
  const kept = c.pending_bot ? Date.parse(c.pending_bot.at) : -Infinity;
  if (at < kept) return false;
  c.pending_bot = { at: new Date(at).toISOString(), note: text(p.text) };
  return true;
}

/** Parks the finding a review.answer note is about. Handles per-comment cards (card_id) and drafted reviews (repo, pr, comment id). */
export function markNotePending(board: Json, p: Json): boolean {
  if (!isNote(p)) return false;
  if (text(p.card_id)) {
    const d = (Array.isArray(board.decisions) ? board.decisions : []).find((x: Json) => x.id === p.card_id);
    if (!d || d.answer || !Array.isArray(d.post_comments)) return false;
    const n = Number(p.finding ?? p.comment_id);
    return park(d.post_comments.find((c: Json, i: number) => findingNumber(c, i) === n), p);
  }
  if (!text(p.repo) || p.comment_id === 'pr') return false;
  const r = (Array.isArray(board.reviews) ? board.reviews : []).find((x: Json) => x.repo === p.repo && x.pr === p.pr);
  return park(r?.comments?.find((c: Json) => c.id === String(p.comment_id)), p);
}

/**
 * The bot's update of a draft. `next` comes from the bot and never carries pending_bot itself; a comment whose body is
 * unchanged keeps the parked note, a rewritten one drops it (and on a card, revision_at marks the rewrite so older notes
 * no longer count). keyOf gives the same key for the same finding in both lists.
 */
export function carryPendingBot(prev: Json[] | undefined, next: Json[], keyOf: (c: Json, i: number) => unknown, now: Date = new Date(), stampRewrite = false): void {
  next.forEach((c, i) => {
    delete c.pending_bot;
    const was = (prev ?? []).find((q, j) => keyOf(q, j) === keyOf(c, i));
    if (!was) return;
    if (was.body === c.body) {
      if (was.pending_bot && c.status !== 'posted' && c.status !== 'skipped') c.pending_bot = was.pending_bot;
    } else if (stampRewrite && !c.revision_at) c.revision_at = now.toISOString();
  });
}

const sortAt = (a: Json, b: Json) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

/** Parks every open finding whose latest word from him is a note (older boards never stored the state). Returns "card:n" / "repo#pr:id" labels. */
export function healNotes(board: Json): string[] {
  const asks: Json[] = (Array.isArray(board.asks) ? board.asks : []).filter((a: Json) => a.kind === 'review' && typeof a.id === 'string').sort(sortAt);
  const parked: string[] = [];
  const lastWord = (prefix: string) => asks.filter((a) => a.id.startsWith(prefix)).pop();
  const parkFrom = (c: Json, ask: Json | undefined, label: string) => {
    if (!ask || !/:note:/.test(ask.id) || c.pending_bot) return;
    const tail = String(ask.text).includes(': ') ? String(ask.text).slice(String(ask.text).indexOf(': ') + 2) : String(ask.text);
    if (park(c, { answered_at: ask.at, text: tail })) parked.push(label);
  };
  for (const d of Array.isArray(board.decisions) ? board.decisions : []) {
    if (d.answer || !Array.isArray(d.post_comments)) continue;
    d.post_comments.forEach((c: Json, i: number) => {
      const n = findingNumber(c, i);
      const word = lastWord(`${d.id}:${n}:`);
      const all = asks.find((a) => a.id.startsWith(`${d.id}:all:`));
      if (!all) parkFrom(c, word, `${d.id}:${n}`);
    });
  }
  for (const r of Array.isArray(board.reviews) ? board.reviews : []) {
    for (const c of r.comments ?? []) parkFrom(c, lastWord(`review:${r.repo}#${r.pr}:${c.id}:`), `${r.repo}#${r.pr}:${c.id}`);
  }
  return parked;
}
