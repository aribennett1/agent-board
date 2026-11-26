// What a decision card's answer looks like once the board has recorded it. The board server stores this on the card
// the moment it records the answer, so "answered" never depends on a browser's local storage or on a bot following up.

type Json = Record<string, any>;

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The stored answer for a decision.answered payload, or null when the payload carries no answer. */
export function answerOfPayload(p: Json, now: Date = new Date()): Json | null {
  const at = text(p.answered_at) && Number.isFinite(Date.parse(p.answered_at)) ? new Date(p.answered_at).toISOString() : now.toISOString();
  const by = 'app';
  if (p.action === 'send') {
    const t = text(p.text ?? p.custom_text);
    return t ? { answer: 'send', answer_label: 'Send to Slack', answered_by: by, answered_at: at, action: 'send', text: t } : null;
  }
  if (p.action === 'decline') return { answer: 'decline', answer_label: "Don't send", answered_by: by, answered_at: at, action: 'decline' };
  const label = Array.isArray(p.answer_label) ? p.answer_label.join(', ') : text(p.answer_label);
  if (p.answer === 'custom' || text(p.custom_text)) {
    const t = text(p.custom_text) || label;
    return t ? { answer: 'custom', answer_label: t, answered_by: by, answered_at: at, custom_text: t } : null;
  }
  const answer = Array.isArray(p.answer) ? p.answer.filter((x) => typeof x === 'string') : text(p.answer);
  if (!answer.length) return null;
  return { answer, answer_label: Array.isArray(p.answer) ? (Array.isArray(p.answer_label) ? p.answer_label : [label]) : label, answered_by: by, answered_at: at };
}

/**
 * Marks the card answered when the payload is an answer given after the card's latest revision (a bot rewrite
 * after the answer is a new question, so an older answer must not close it). Returns true when it changed the card.
 */
export function settleDecision(d: Json | undefined, p: Json, now: Date = new Date()): boolean {
  if (!d || d.answer || p.event !== 'decision.answered') return false;
  const answer = answerOfPayload(p, now);
  if (!answer) return false;
  const revised = text(d.updated_at) || text(d.created_at);
  if (revised && Date.parse(answer.answered_at) < Date.parse(revised)) return false;
  d.answer = answer;
  return true;
}

const isDecisionAnswer = (a: Json, id: string) => a.item_key === `decision:${id}` && a.id === `${id}:answer` && (a.kind === 'answer' || a.kind === 'custom');

/** The decision.answered payload a recorded answer ask came from, as far as the ask says (option ids come back from the labels). */
function payloadOfAsk(d: Json, a: Json): Json {
  const base = { event: 'decision.answered', decision_id: d.id, answered_at: a.at };
  const said = text(a.text);
  if (d.kind === 'slack_draft' || d.slack) return said === "Don't send" ? { ...base, action: 'decline' } : { ...base, action: 'send', text: said };
  if (a.kind === 'custom') return { ...base, answer: 'custom', answer_label: said, custom_text: said };
  const options: Json[] = Array.isArray(d.options) ? d.options : [];
  if (d.multiSelect) {
    const picked = options.filter((o) => said.split(', ').includes(o.label));
    if (picked.length) return { ...base, answer: picked.map((o) => o.id), answer_label: picked.map((o) => o.label) };
  }
  const one = options.find((o) => o.label === said);
  return one ? { ...base, answer: one.id, answer_label: one.label } : { ...base, answer: 'custom', answer_label: said, custom_text: said };
}

/** Marks every card he answered but the board never closed (an answer ask exists, the card has no answer). Returns the ids. */
export function healAnswers(board: Json): string[] {
  const healed: string[] = [];
  for (const d of Array.isArray(board.decisions) ? board.decisions : []) {
    if (d.answer) continue;
    const ask = (Array.isArray(board.asks) ? board.asks : []).filter((a: Json) => isDecisionAnswer(a, d.id)).sort((x: Json, y: Json) => (x.at < y.at ? -1 : 1)).pop();
    if (ask && settleDecision(d, payloadOfAsk(d, ask))) healed.push(d.id);
  }
  return healed;
}
