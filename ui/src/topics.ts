import type { AlreadyDecided, AnswersComment, Ask, Board, Decision, PlanQuestion, PostCommentDraft, ReplyQuestion, ThreadEntry } from "./data/types";
import { choiceText } from "./delivery";
import { answersFromAsks, isFindingSettled, isPerFindingReview, reviewFindings } from "./reviewFindings";
import { sameSha } from "./triage";
import { latestStatus } from "./convoModel";
import type { CheckStatus } from "./Checks";
import { raisedByOf, raisedByFromId, type BoardBot } from "./raisedBy";

// The Conversation tab's model (t102u): ONE topic per ticket / PR / plan. Each topic says who has the ball, lists only
// the questions still open (a newer "Qn" or an explicit superseded_by replaces an older one), collapses answered ones
// to one line, and keeps the whole back-and-forth as history, oldest first. Pure, so the view and the tests agree.

export type Who = "You" | "Assistant" | "ops";
// A message in a topic's thread. `status` marks one of the human's own messages (it gets checks); `card` marks an
// answered decision card, shown as one line (title + answer) that expands to its question.
export type HistoryMsg = { at: string; who: Who; text: string; key: string; to?: string; status?: CheckStatus; card?: { title: string; answer: string; body: string; raisedBy?: BoardBot; to?: string }; raisedBy?: BoardBot };
export type TopicQuestion = {
  uid: string; // unique on the page: one question renders once
  label?: string; // "Q4", "Q3b"
  text: string;
  context?: string; // shown inline, short
  image?: string;
  image_alt?: string;
  suggestion?: string; // "Assistant suggests: ..." hint, never preselected
  options: import("./data/types").Option[];
  itemKey: string; // where the answer goes
  raisedBy?: BoardBot;
  kind: "thread" | "plan" | "decision" | "finding";
  thread?: ReplyQuestion;
  decision?: Decision;
  finding?: PostCommentDraft & { n: number };
  bot?: string;
  rule?: string;
  seen?: string;
  proposed_fix?: string;
  fixes?: Decision["fixes"];
  svg?: string;
  answers_comment?: AnswersComment;
  post_text?: string | null;
  current_text?: string;
  post_comments?: import("./data/types").PostCommentDraft[];
  already_decided?: AlreadyDecided;
  // Words already sent on a finding that is still open (a note, or Post not yet on GitHub).
  prior_answer?: string;
};
export type AnsweredQuestion = {
  uid: string;
  to?: string; // the bot the answer was sent to
  label?: string;
  text: string;
  answer: string;
  status?: "pending" | "posted" | "skipped";
  posted_url?: string;
  note?: string;
};
export type Topic = {
  key: string;
  keys: string[];
  label: string;
  link?: string;
  summary?: string;
  ball: string; // You | Assistant | ops | Sam | Done
  statusLine: string;
  group: "you" | "progress" | "done";
  open: TopicQuestion[];
  answered: AnsweredQuestion[];
  history: HistoryMsg[];
  at: string;
  /** When the topic began: its first card or message. Sets its place in the section, so new activity never moves it. */
  startedAt: string;
  raisedBy?: BoardBot;
};

type Labels = Record<string, { label: string; link?: string }>;
const byAt = <T extends { at: string }>(a: T, b: T) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
export const qLabelOf = (text: string) => /^(?:[A-Z]+-\d+\s+)?(Q\d+[a-z]?)\b\s*(?:[:.=]|$)/i.exec(text.trim())?.[1]?.toUpperCase().replace(/^Q(\d+)([A-Z]?)$/, (_, n, l) => `Q${n}${l.toLowerCase()}`);
const CLARIFY = /\?|\bwhat (?:do|does) (?:you|it|this) mean\b|\bexplain\b|\bdon'?t (?:understand|know what)\b|\bnot (?:entirely )?sure\b|\bwhat on earth\b|\bconfus/i;
export const isClarifying = (text: string) => CLARIFY.test(text.replace(/https?:\/\/\S+/gi, "").replace(/^(?:[A-Z]+-\d+\s+)?Q\d+[a-z]?\s*[:.]\s*/i, ""));
// Only a reply that opens with "Got it" / "Got your" counts as an acknowledgement of an answer.
const ACK = /^\s*\**\s*got (?:it|your)\b/i;
// "Q1–Q5", "Q1-Q5", "Q2 and Q3", "Q4": the labels a bot acknowledgement covers.
export function mentionsLabel(text: string, label: string) {
  const n = Number(/\d+/.exec(label)?.[0]);
  const exact = new RegExp(`\\b${label}\\b`, "i").test(text);
  if (exact) return true;
  if (/[a-z]$/i.test(label)) return false; // Q3b is never covered by a Q1–Q5 range
  for (const m of text.matchAll(/\bQ(\d+)\s*(?:–|-|to|through)\s*Q?(\d+)\b/gi)) if (n >= Number(m[1]) && n <= Number(m[2])) return true;
  return false;
}
const whoOf = (e: ThreadEntry): Who => (/^\s*\**\s*assistant\b/i.test(e.text) ? "assistant" : /^\s*\**\s*ops\b/i.test(e.text) ? "ops" : "Assistant");
const ticketOf = (key: string) => /^decision:proj-(\d+)-/i.exec(key)?.[1];
const BULK = /\b(?:accept|take|apply)\s+all\b|\ball\s+\d*\s*(?:of\s+)?(?:engineer'?s\s+)?(?:picks|recommendations|suggestions)\b/i;
const unpick = (l: string) => l.replace(/\s*\(pick\)\s*/gi, " ").trim();
const firstSentence = (t: string) => {
  const plain = t.replace(/[*_`#>]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
  const m = /^(.{12,160}?[.!?])(\s|$)/.exec(plain);
  return m ? m[1] : plain.length > 160 ? `${plain.slice(0, 157)}...` : plain;
};
// A plan question's body repeats the question and Assistant's pick; keep only what's extra.
const planContext = (q: PlanQuestion) => {
  const rest = (q.body ?? "")
    .split("\n")
    .filter((l) => l.trim() && l.replace(/^[-*\s]+/, "").trim() !== q.question.trim() && !/^\s*[-*]?\s*\**(my pick|assistant'?s pick|recommend(ed|ation))\b/i.test(l))
    .join("\n")
    .trim();
  return rest || undefined;
};
const short = (t: string) => (t.length > 140 ? `${t.slice(0, 137)}...` : t);

export function buildTopics(
  board: Pick<Board, "decisions" | "details" | "asks" | "ticket_summaries">,
  labels: Labels,
  isOpenDecision: (d: Decision) => boolean,
): Topic[] {
  const asks = board.asks ?? [];
  const details = board.details ?? {};
  const summaries = board.ticket_summaries ?? {};
  // Merge keys into topics: a decision about PROJ-2512 joins ticket:PROJ-2512 when that ticket is on the board.
  const prKeys = Object.keys(labels).filter((k) => /^mypr:|^pr:/.test(k));
  const topicOf = (key: string) => {
    const n = ticketOf(key);
    if (n && labels[`ticket:PROJ-${n}`]) return `ticket:PROJ-${n}`;
    // A "waiting on others" row about one of the owner's PRs (waiting:209-...) joins that PR's topic.
    const w = /^waiting:(\d+)-/.exec(key)?.[1];
    const pr = w ? prKeys.find((k) => k.startsWith("mypr:") && k.endsWith(`/${w}`)) : undefined;
    return pr ?? key;
  };
  const decisions = new Map(board.decisions.map((d) => [`decision:${d.id}`, d]));
  const keys = new Set<string>([
    ...asks.map((a) => a.item_key),
    ...Object.keys(details).filter((k) => details[k]?.thread?.length),
    ...board.decisions.filter((d) => d.answer || isOpenDecision(d)).map((d) => `decision:${d.id}`),
  ]);
  const groups = new Map<string, string[]>();
  for (const k of keys) groups.set(topicOf(k), [...(groups.get(topicOf(k)) ?? []), k]);

  const topics: Topic[] = [];
  for (const [tkey, members] of groups) {
    const tAsks = asks.filter((a) => members.includes(a.item_key)).sort(byAt);
    const tThread = members.flatMap((k) => (details[k]?.thread ?? []).map((e) => ({ ...e, key: k }))).sort(byAt);
    const tDecisions = members.flatMap((k) => (decisions.get(k) ? [decisions.get(k)!] : []));
    const botAcks = tThread.filter((e) => !e.question && ACK.test(e.text));

    // Who answered a labelled question after it was asked: the owner's own words (not a clarifying question), or a bot
    // acknowledgement that names the label.
    const answerFor = (label: string, since: string): string | null => {
      const mine = tAsks.filter((a) => a.at > since && qLabelOf(a.text) === label && !isClarifying(a.text));
      if (mine.length) return mine[mine.length - 1].text.replace(/^(?:[A-Z]+-\d+\s+)?Q\d+[a-z]?\s*[:.]\s*/i, "");
      const ack = botAcks.find((e) => e.at > since && mentionsLabel(e.text, label));
      return ack ? "answered (see history)" : null;
    };

    // Assistant's latest plain-words explanation of a question ("Q3, explained in more detail ..."), shown inline.
    const explained = (label: string) =>
      [...tThread].reverse().find((e) => !e.question && new RegExp(`^\\s*\\**\\s*${label}\\b(?!\\s*:\\s*you said)`, "i").test(e.text) && !/already answered/i.test(e.text))?.text;
    const open: TopicQuestion[] = [];
    const answered: AnsweredQuestion[] = [];
    const seenLabels = new Set<string>();
    // 1. Thread questions, newest first, so a newer Qn wins over an older one and over the plan's Qn.
    for (const e of [...tThread].reverse()) {
      const q = e.question;
      if (!q || q.superseded_by) continue;
      const label = qLabelOf(q.text);
      if (label && seenLabels.has(label)) continue;
      if (label) seenLabels.add(label);
      const replies = tAsks.filter((a) => a.reply_to === q.id && !isClarifying(a.text));
      const viaLabel = label ? answerFor(label, e.at) : null;
      const reply = replies.length ? replies[replies.length - 1].text.replace(/^Answer to "[^"]*":\s*/, "") : viaLabel;
      if (reply) answered.push({ uid: `${e.key}#${q.id}`, label, text: q.text, answer: reply });
      else
        open.push({
          uid: `${e.key}#${q.id}`, label, text: q.text, context: q.context ?? e.text, image: e.image, image_alt: e.image_alt, suggestion: q.suggestion, itemKey: e.key, kind: "thread", thread: q, raisedBy: raisedByFromId(e.key),
          ...(q.answers_comment ? { answers_comment: q.answers_comment } : {}),
          ...(q.post_text !== undefined ? { post_text: q.post_text } : {}),
          ...(q.current_text !== undefined ? { current_text: q.current_text } : {}),
          ...(q.already_decided ? { already_decided: q.already_decided } : {}),
          options: q.options.filter((o) => !BULK.test(o.label)).map((o) => ({ ...o, label: unpick(o.label) })),
        });
    }
    // 2. Plan questions (ticket or plan card details), unless a thread question with the same label replaced them.
    const planQs: { q: PlanQuestion; key: string }[] = [];
    for (const k of members) for (const q of details[k]?.questions ?? []) if (!planQs.some((p) => p.q.id === q.id)) planQs.push({ q, key: k });
    // A plan card answered with something other than "I'll answer each one" (e.g. "skip it") closes its questions.
    const ansText = (d: Decision) => String(d.answer?.answer_label ?? "");
    const planClosed = tDecisions.some((d) => d.answer && !/\beach\b|one by one|under details/i.test(ansText(d))) && !tDecisions.some((d) => d.answer && /\beach\b|one by one/i.test(ansText(d)));
    for (const { q, key } of planQs) {
      const label = qLabelOf(q.id) ?? q.id;
      if (seenLabels.has(label)) continue;
      seenLabels.add(label);
      if (q.superseded_by) continue;
      const a = q.answered ? `"${q.answered.text}" (${q.answered.source})` : answerFor(label, "");
      if (a) answered.push({ uid: `${key}#plan-${q.id}`, label, text: q.question, answer: a });
      else if (!planClosed)
        open.push({ uid: `${key}#plan-${q.id}`, label, text: q.question, context: q.context ?? explained(label) ?? planContext(q), suggestion: q.recommendation, itemKey: key, kind: "plan", options: [] });
    }
    // 3. Open decision cards (not plan containers whose questions are above).
    // ops review cards expand into one question per finding, each answered on its own.
    for (const d of tDecisions) {
      if (isPerFindingReview(d)) {
        const ans = answersFromAsks(tAsks, d.id, reviewFindings(d));
        const skippedAll = ans.get("all");
        for (const f of reviewFindings(d)) {
          const reply = skippedAll ?? ans.get(String(f.n));
          const uid = `decision:${d.id}#f${f.n}`;
          const text = f.summary ? f.summary : f.label;
          const settled = Boolean(skippedAll) || isFindingSettled(f, reply);
          if (settled && (reply || f.status || f.pending_bot || f.answered)) answered.push({ uid, label: `#${f.n}`, text, answer: reply ?? (f.pending_bot ? f.pending_bot.note : f.status === "skipped" || (f.status !== "posted" && f.answered?.action === "skip") ? "Don't post" : f.note || "Post"), ...(f.status ? { status: f.status } : {}), ...(f.posted_url ? { posted_url: f.posted_url } : {}), ...(f.note ? { note: f.note } : {}) });
          else if (!d.answer && isOpenDecision(d))
            open.push({
              uid, label: `#${f.n}`, text, context: d.context, itemKey: `decision:${d.id}`, kind: "finding", decision: d, finding: f,
              options: [],
              ...(reply ? { prior_answer: reply } : {}),
              ...(d.already_decided ? { already_decided: d.already_decided } : {}),
            });
        }
        continue;
      }
      if (d.answer || !isOpenDecision(d)) continue;
      const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
      const prior = board.decisions.find((p) =>
        p.id !== d.id && p.answer &&
        ((p.group && d.group && p.group === d.group) || (!d.group && !p.group)) &&
        (norm(p.question) === norm(d.question) || (p.title && d.title && norm(p.title) === norm(d.title))) &&
        (!d.sha || !p.sha || sameSha(d.sha, p.sha))
      );
      const already_decided = d.already_decided ?? (prior?.answer ? { answer: choiceText(prior.answer), source: prior.title ?? "earlier card", at: prior.answer.answered_at } : undefined);
      open.push({
        uid: `decision:${d.id}`, text: d.question, context: d.context, itemKey: `decision:${d.id}`, kind: "decision", decision: d, raisedBy: raisedByOf(d, details),
        ...(d.section === "assistant" ? { bot: d.bot, rule: d.rule, seen: d.seen, proposed_fix: d.proposed_fix, fixes: d.fixes, svg: d.svg } : {}),
        ...(d.answers_comment ? { answers_comment: d.answers_comment } : {}),
        ...(d.post_text !== undefined ? { post_text: d.post_text } : {}),
        ...(d.current_text !== undefined ? { current_text: d.current_text } : {}),
        ...(d.post_comments?.length ? { post_comments: d.post_comments } : {}),
        ...(already_decided ? { already_decided } : {}),
        options: d.options.filter((o) => !BULK.test(o.label)).map((o) => ({ id: o.id, label: unpick(o.label) })),
      });
    }
    const order = (q: { label?: string }) => {
      const m = /^Q(\d+)([a-z]?)$/.exec(q.label ?? "");
      return m ? Number(m[1]) * 100 + (m[2] ? m[2].charCodeAt(0) - 96 : 0) : 1e6;
    };
    open.sort((a, b) => order(a) - order(b));
    answered.sort((a, b) => order(a) - order(b));

    // An answered decision card collapses into one row: its title and what he said, with the question inside.
    const cardBody = (d?: Decision) => (d ? `**${d.question}**${d.context ? `\n\n${d.context}` : ""}` : "");
    const isCardAsk = (a: Ask) => a.item_key.startsWith("decision:") && (a.kind === "answer" || a.kind === "custom");
    const cardAsks = tAsks.filter(isCardAsk);
    const collapsed = new Set(tDecisions.filter((d) => d.answer || cardAsks.some((a) => a.item_key === `decision:${d.id}`)).map((d) => `decision:${d.id}`));
    const history: HistoryMsg[] = [
      ...tAsks.map((a) => {
        const d = decisions.get(a.item_key);
        return { at: a.at, who: "You" as Who, text: a.text, key: a.item_key, ...(a.to_bot ? { to: a.to_bot } : {}), status: (a.status ?? "sent") as CheckStatus, ...(isCardAsk(a) ? { card: { title: a.label, answer: a.text, body: cardBody(d), raisedBy: d ? raisedByOf(d, details) : raisedByFromId(a.item_key), ...(a.to_bot ? { to: a.to_bot } : {}) } } : {}) };
      }),
      ...tThread.filter((e) => e.text.trim() || e.question).map((e) => ({ at: e.at, who: whoOf(e), text: [e.text.trim(), e.question ? `**${e.question.text}**` : ""].filter(Boolean).join("\n\n"), key: e.key })),
      ...tDecisions.filter((d) => !collapsed.has(`decision:${d.id}`)).flatMap((d) => (d.created_at ? [{ at: d.created_at, who: "Assistant" as Who, text: `**${d.title ?? d.question}**\n\n${d.context}`, key: `decision:${d.id}` }] : [])),
      ...tDecisions.flatMap((d) => {
        const said = ansText(d);
        if (!d.answer || !said || cardAsks.some((a) => a.item_key === `decision:${d.id}`)) return [];
        return [{ at: d.answer.answered_at ?? d.created_at ?? "", who: "You" as Who, text: `You chose: ${said}`, key: `decision:${d.id}`, card: { title: d.title ?? d.question, answer: said, body: cardBody(d), raisedBy: raisedByOf(d, details) } }];
      }),
    ].sort(byAt);

    const status = members.map((k) => ({ s: latestStatus(details[k]?.thread), at: (details[k]?.thread ?? []).filter((e) => e.status).pop()?.at ?? "" })).filter((x) => x.s).sort(byAt).pop();
    const last = history[history.length - 1];
    let ball: string;
    if (open.length) ball = "You";
    else if (status && (!last || status.at >= last.at || last.who !== "You")) ball = status.s === "done" ? "Done" : status.s === "working" ? "Assistant" : status.s!.replace(/^(passed|waiting):/, "");
    else if (last?.who === "You" && !last.text.startsWith("You chose: ")) ball = "Assistant";
    else ball = "Done";
    if (ball === "the owner") ball = "You";
    const lastBot = [...history].reverse().find((h) => h.who !== "You");
    const now = lastBot ? firstSentence(lastBot.text) : "";
    const statusLine =
      ball === "You" ? `Your turn: ${open.length} to answer.`
      : ball === "Done" ? `Done.${last?.who === "You" ? ` ${firstSentence(last.text)}` : now ? ` ${now}` : ""}`
      : ball === "Assistant" ? `Assistant has it.${last?.who === "You" ? " Your last message is being handled." : now ? ` ${now}` : ""}`
      : ball === "Assistant" || ball === "ops" ? `${ball} has it.${now ? ` ${now}` : ""}`
      : `Waiting on ${ball}.${now ? ` ${now}` : ""}`;

    const n = /PROJ-(\d+)/.exec(tkey)?.[0] ?? (ticketOf(tkey) ? `PROJ-${ticketOf(tkey)}` : undefined) ?? /\bPROJ-\d+\b/.exec(labels[tkey]?.label ?? "")?.[0];
    const d0 = decisions.get(tkey);
    const summary = n && summaries[n] ? summaries[n] : d0?.context ? firstSentence(d0.context) : undefined;
    const label = d0?.section === "assistant"
      ? `Dr. Assistant: ${d0.title ?? d0.question}`
      : (labels[tkey]?.label && !/^#+\s|\*\*Ticket:\*\*|\*\*Priority:\*\*/m.test(labels[tkey]!.label) ? labels[tkey]!.label : tkey).replace(/:\s*\d+\s+questions?$/i, "");
    topics.push({
      key: tkey, keys: members, label, link: labels[tkey]?.link, summary: summary ? short(summary) : undefined, ball, statusLine,
      group: open.length ? "you" : ball === "Done" ? "done" : "progress", open, answered, history, at: last?.at ?? "",
      startedAt: [...tDecisions.map((d) => d.created_at ?? ""), history[0]?.at ?? ""].filter(Boolean).sort()[0] ?? "",
      raisedBy: tDecisions.map((d) => raisedByOf(d, details)).find(Boolean) ?? members.map((k) => raisedByFromId(k)).find(Boolean),
    });
  }
  // Within a group, oldest first by when the topic began: a new card lands at the bottom of its group, and a new reply on
  // an older card does not move that card.
  const rank = { you: 0, progress: 1, done: 2 } as const;
  const started = (t: Topic) => t.startedAt || t.at;
  return topics.sort((a, b) => rank[a.group] - rank[b.group] || (started(a) < started(b) ? -1 : started(a) > started(b) ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export const openCount = (topics: Topic[]) => topics.reduce((n, t) => n + t.open.length, 0);
export function summaryLine(topics: Topic[]) {
  const n = openCount(topics);
  const m = topics.filter((t) => t.open.length).length;
  if (!n) return "Nothing to answer right now.";
  return `You have ${n} ${n === 1 ? "thing" : "things"} to answer across ${m} ${m === 1 ? "topic" : "topics"}.`;
}
export type { Ask };
