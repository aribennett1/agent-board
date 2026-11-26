import type { DatabaseSync } from 'node:sqlite';

// The feed shows Eric's PRs, but nothing used to turn "a PR needs work" into a prompt: that depended on a bot remembering.
// After each feed refresh, any of his open PRs that has changes requested, failing checks or open reviewer threads, and that no
// open card names, gets one notification once it has stayed that way for GRACE_MS. It clears itself when a card appears or the work is done.

type Json = Record<string, any>;

export const GRACE_MS = 30 * 60_000;
const BOT_AUTHOR = /^(cursor|claude|copilot|github-actions|linear-code|dev-server-coolify-notfications)$|\[bot\]$/i;

/** Why a PR needs work: a stable key (for change detection) and the words for the notification. */
export function attentionOf(pr: Json): { sig: string; reasons: string[] } {
  const keys: string[] = [];
  const reasons: string[] = [];
  if (pr.state === 'changes requested') {
    keys.push('changes');
    reasons.push('changes requested');
  }
  if (pr.ci === 'failing') {
    const names: string[] = pr.checks?.failing ?? [];
    keys.push(`ci:${names.join(',')}`);
    reasons.push(`failing checks${names.length ? ` (${names.join(', ')})` : ''}`);
  }
  const people = [...new Set<string>((pr.unresolved ?? []).map((t: Json) => String(t.author)).filter((a: string) => !BOT_AUTHOR.test(a)))];
  if (people.length) {
    keys.push('threads');
    reasons.push(`open threads from ${people.join(', ')}`);
  }
  return { sig: keys.join('|'), reasons };
}

/** Open cards (not answered, not cleared) whose id, group, link, title or question names this PR number. */
function coveredBy(db: DatabaseSync): (n: number) => boolean {
  const row = db.prepare("SELECT json FROM ui_doc WHERE key = 'board'").get() as { json: string } | undefined;
  let decisions: Json[] = [];
  try {
    decisions = row ? JSON.parse(row.json).decisions ?? [] : [];
  } catch { /* an unreadable board document covers nothing */ }
  const cleared = new Set((db.prepare('SELECT decision_id FROM ui_derived_state WHERE cleared_at IS NOT NULL').all() as Json[]).map((r) => r.decision_id));
  const open = decisions.filter((d) => !d.answer && !cleared.has(d.id));
  const text = open.map((d) => [d.id, d.group, d.card_ref, d.title, d.question].filter(Boolean).join(' '));
  return (n) => {
    const re = new RegExp(`(?:#|[/:]|\\bPR\\s+)${n}(?!\\d)`, 'i');
    return text.some((t) => re.test(t));
  };
}

const clearNote = (db: DatabaseSync, id: number | null | undefined, at: string) => {
  if (id != null) db.prepare('UPDATE ui_notifications SET cleared_at = ? WHERE id = ? AND cleared_at IS NULL').run(at, id);
};

/** Run after a good feed refresh with the open "mine" PRs. Writes and clears notifications; returns the PR numbers notified now. */
export function watchAttention(db: DatabaseSync, mine: Json[], now: Date): number[] {
  const at = now.toISOString();
  const covered = coveredBy(db);
  const notified: number[] = [];
  const seen = new Set<string>();
  for (const pr of mine) {
    const key = `${pr.repo_full}#${pr.number}`;
    const { sig, reasons } = attentionOf(pr);
    const row = db.prepare('SELECT sig, first_seen, notification_id FROM pr_attention WHERE pr = ?').get(key) as Json | undefined;
    if (!sig || covered(pr.number)) {
      if (row) {
        clearNote(db, row.notification_id as number | null, at);
        db.prepare('DELETE FROM pr_attention WHERE pr = ?').run(key);
      }
      continue;
    }
    seen.add(key);
    let firstSeen = row?.first_seen as string | undefined;
    let noteId = row?.notification_id as number | null | undefined;
    if (!row || row.sig !== sig) {
      clearNote(db, noteId, at);
      firstSeen = at;
      noteId = null;
      db.prepare('INSERT INTO pr_attention (pr, sig, first_seen, notification_id) VALUES (?, ?, ?, NULL) ON CONFLICT(pr) DO UPDATE SET sig = excluded.sig, first_seen = excluded.first_seen, notification_id = NULL').run(key, sig, at);
    }
    if (noteId == null && now.getTime() - Date.parse(firstSeen!) >= GRACE_MS) {
      const text = `PR #${pr.number} (${String(pr.title).slice(0, 80)}) needs work and no open card names it: ${reasons.join('; ')}. Nothing has been asked of you on the board for it.`;
      const r = db.prepare('INSERT INTO ui_notifications (bot, text, link, created_at) VALUES (?, ?, ?, ?)').run('Grok Bot', text.slice(0, 800), pr.link ?? null, at);
      db.prepare('UPDATE pr_attention SET notification_id = ? WHERE pr = ?').run(Number(r.lastInsertRowid), key);
      notified.push(pr.number);
    }
  }
  for (const r of db.prepare('SELECT pr, notification_id FROM pr_attention').all() as Json[]) {
    if (seen.has(r.pr)) continue;
    clearNote(db, r.notification_id as number | null, at);
    db.prepare('DELETE FROM pr_attention WHERE pr = ?').run(r.pr);
  }
  return notified;
}
