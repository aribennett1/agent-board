#!/usr/bin/env node
// ab: the ONLY supported way to raise, answer, clear, restore or check a decision on the Action Board
// (app/src/data/board.ts, served by the dev server). Run it from anywhere: paths are found from this file.
// `ab raise` writes the board, confirms the live server serves it, and only then prints
// the chat-card payload. No board write => no card text => no chat-only decision.
//
//   ab raise --bot <Planner|QA|Engineer|dr eggbot|Grok Bot> '<json>' | ab raise --bot Planner < decision.json
//     Stored fields: id, title, context, question, ... ("link" is card-only: it fills card_ref).
//     The user must understand the card cold, so raise refuses (exit 2, board untouched) a card that does not say what it is about:
//     "context" (required, shown first): short paragraphs or bullets, each 3 lines or fewer (~280 chars), total 800 or fewer,
//       at least 6 plain words besides ids (ABC-1234, #123, URLs). Say what the item is (feature or screen, not just an id)
//       and what happened. No text block on the card may run longer than 3 lines.
//     "svg" (required when the decision is about a data relationship, flow or timeline): a small sanitized SVG diagram.
//     "question" must name the thing. Refused: "the/this/that/these/those" + ticket|tickets|pr|prs|pull request|issue|card|bug|
//       fix|change|branch|item|one at the end, before punctuation, or before is|are|was|were|be|been|should|will|would|can|could|
//       go|get|stay|need|needs|has|have|do|does; the word "it" anywhere; "this"/"that" at the end or before punctuation.
//       "What should happen to the ticket?" and "Send it back to the vendor?" fail; "Approve the Q3 vendor contract?" passes.
//     "title" (required, stored, shown bold at the top of the card): a SHORT topic, one line, max 60 chars, at least two
//       plain words besides ids and the words pr, ticket, issue ("ABC-1234" fails; "Q3 vendor contract renewal" passes).
//       A re-raise replaces it with the new payload's title.
//     {"id":"vendor-contract-q3","title":"Q3 vendor contract renewal","context":"The hosting vendor sent the Q3 contract. It
//      renews at the same price but adds a 12 month minimum term.","question":"Approve the Q3 vendor contract?",
//      "what_happens_after":"The assistant signs and files the contract.","options":[{"id":"approve","label":"Approve"},{"id":"hold","label":"Hold"}]}
//     optional "details": short structure shown under the question. Each entry is a bullet string, or a
//     labeled list {"label":"...","items":["...",...],"ordered":true|false}. Keep "question" a short headline.
//     optional "svg": a small SVG diagram (sanitized the same way as ab reply --svg).
//     "details":["Reads CRM contacts nightly",{"label":"Defaults","items":["Sync every 24h","Read-only"]},{"label":"Tradeoffs","ordered":true,"items":["Cheaper","Slower to show changes"]}]
//     optional "priority": "high", "medium" or "low" (anything else: exit 2, board untouched). Left out: a new card is stored
//     without it (medium); a re-raise keeps the stored one. The printed card carries the effective priority ("medium" if none).
//     Home cards also require triage: "tier" (blocking|quick|decision|fyi), "estimate" (how long to answer), "group"
//     (ticket or PR key), and "glance" {ticket:{id,summary}, asking, outcomes:[{id,happens},...] for every option}.
//     Optional: unblocks, sha, joke, recommendation:{id,reason,who?}, draft, severity, superseded_by, stale_reason.
//     Cards that edit an already-posted comment also need "current_text" (the text on GitHub now). The board
//     shows a highlighted diff of current_text against post_text, not two full copies. "what_happens_after"
//     must say what actually happens on GitHub (edit, or delete and re-post), not that the answer only goes to ops.
//     Recommendations are shown, never preselected. Dr. Assistant cards are not required to have triage fields.
//   ab raise --bot <Planner|QA|Engineer|dr eggbot|Grok Bot> '<json>'
//                                                      --bot (or raised_by in the JSON) is required. The card id must start
//                                                      with that bot's prefix: planner-, qa-, engineer-, eggbot-, grok-.
//                                                      Also required: what_happens_after (plain words); priority (high|medium|low);
//                                                      group (ROWS-1234, or #1234, or repo#1234); card_ref/link (Linear URL
//                                                      https://linear.app/rows/issue/<same key>/... or GitHub URL
//                                                      https://github.com/ROWSHR/<repo>/pull/<same number>); at least two
//                                                      options with unique ids and none preselected, unless this is a free-text
//                                                      card (allowCustom: true and no options). svg is optional. Unknown fields
//                                                      are rejected. A re-raise must pass the same checks; --bot may be omitted
//                                                      only when the card already has a stored author.
//   ab assistant '<json>' | ab assistant < finding.json
//                                                      posts an assistant finding or proposed bot change on the Dr. Assistant tab
//                                                      (#assistant). Same title/context/question rules as raise, plus required
//                                                      "rule" and "bot" (which bot this is for). A single finding also needs
//                                                      "seen" and "proposed_fix". A group of fixes uses "fixes": [{"id","seen",
//                                                      "proposed"},...] (shown as a table) and usually "multiSelect": true.
//                                                      Optional "svg": a small SVG diagram on the card (sanitized: no scripts,
//                                                      handlers or outside links). Optional "details" can add short bullets.
//                                                      Usual options: each fix id, plus Apply none / Change something; none
//                                                      are preselected; the owner can also answer in his own words. Answers come
//                                                      back as decision.answered (or item.message for a note on the card).
//                                                      A re-post of the same id updates the open card in place.
//                                                      -> {"ok","board":"live","card":{...,"section":"assistant","bot","rule",
//                                                      "seen","proposed_fix","decision_id",...}}
//   ab slack-draft --bot <Planner|QA|Engineer|dr eggbot|Grok Bot> --id <id> --channel-id C… --channel "#name"
//                                                      --text "..." --why "..." --group ROWS-1234 --card-ref <url>
//                                                      [--thread ts] [--thread-link url] [--title "..."] [--priority high|medium|low]
//                                                      [--text-file f]  or  ab slack-draft --bot QA '<json>'
//                                                      raises a Slack draft card. Eric sees a preview, can edit the text, and
//                                                      taps Send to Slack or Don't send. The answer payload is
//                                                      {event:"decision.answered", action:"send"|"decline", text?, ...} and goes
//                                                      to the raising bot, which posts that exact text once, and only after Send.
//                                                      slack.text must start with "This is Eric's bot posting on his behalf."
//                                                      A bot must never post to Slack without this card's Send answer.
//                                                      Same group/card_ref/id-prefix rules as raise. -> {"ok","board":"live","card":{...}}
//   ab notify --bot <Planner|QA|Engineer|dr eggbot|Grok Bot> --text "..." [--next "1:15 PM ET"] [--link url]
//                                                      posts a short Markdown status note to the Notifications tab (starting work, a next-update time, a QA approval).
//                                                      Ticket and PR mentions in --text must be markdown links, same rule as raise.
//                                                      Acknowledging one never wakes a bot. Storage mode only.
//   ab read <id|item>                               marks the human's messages on that item as read by the assistant (blue checks on the board).
//                                                      <id> is a decision id (task:T-1:4 too) or an item key (ticket:PROJ-1, decision:<id>).
//                                                      ab answer and ab reply do this for their item too. Deterministic: no AI involved.
//   ab answer <id> <opt[,opt]> --by chat|app [--at ISO]
//   ab answer <id> --custom "text" --by chat|app [--at ISO]
//   ab answer <id> --action send --text "final text" --by chat|app [--at ISO]
//   ab answer <id> --action decline --by chat|app [--at ISO]
//   ab heal-answers                                      closes cards he answered that the board never marked answered
//   ab clear <id> --reason "why"                    (tombstoned: raise refuses it later) -> {"ok","status":"cleared","id"}
//                                                      the tombstone line in .ab-cleared.jsonl is {id, reason, at, card}: card is
//                                                      the removed decision as it was (lines from before this have no card).
//                                                      The app's "Not relevant anymore" control clears with --reason "not relevant".
//   ab restore <id>                                 puts the card saved by the latest clear back at the end of decisions (answer
//                                                      dropped; priority, created_at, updated_at kept) and appends {id, restored, at}
//                                                      to the tombstones, so raise accepts the id again -> {"ok","status":"restored","id"}
//                                                      nothing cleared (or already restored) exit 5; cleared without a saved card,
//                                                      or already on the board, exit 4
//   ab priority <id> <high|medium|low>              sets only that open card's priority (its updated_at stays)
//                                                      -> {"ok","id","priority","was","live"}; unknown id exit 5, answered exit 4
//   ab open                                         -> open Home decision ids, file vs served, file glance counts {waiting,tickets,others},
//                                                      priority_open {high,medium,low}, open_priority [{id,priority}] (missing = medium),
//                                                      and assistant_open (open Dr. Assistant card ids; not part of --chat)
//   ab check [--chat id1,id2]                       -> same as open; exit 1 on any mismatch
//   ab glance < glance.json                         ({"waiting":[...],"tickets":[...],"others":[...]}; replaces the glance;
//                                                      others is optional (missing = []), each exactly {title,author,who,link},
//                                                      non-blank strings, link http(s)) -> {"ok","live","counts":{waiting,tickets,others}}
//   ab mypr '<json>' | ab mypr [-] < mine.json      replaces My PRs: [{"repo","number","title","link","state":"draft|ready|approved|
//                                                      changes requested","ci"?:"passing|failing|pending|none","reviews"?:<int>}] -> {"ok","live","count"}
//                                                      (ab glance keeps My PRs)
//   ab reviews [--replace] [-] < drafts.json        upserts drafted reviews by repo+pr: [{"repo","pr","verdict","notes"?,"done"?,
//                                                      "comments":[{"id","severity":"high|medium|low","title"?,"path","line":<int>|null,
//                                                      "body","status":"pending|posted|skipped"}]}] -> {"ok","live","set","total"}
//   ab review-status <repo>#<pr> <comment-id> <pending|posted|skipped> [--url <posted comment>] [--note "why"]
//                                                      [--answer-to-question "text"] [--body "revised will-post text"]
//                                                      Marks a drafted-review comment, or a finding on a per-comment ops
//                                                      review card (pr201-ops-review and the like), as posted or not.
//                                                      <comment-id> is the draft id (c1) or the finding number (1, #1, f1).
//                                                      posted needs --url (the GitHub comment or review link) so the board
//                                                      can show it. If a finding could not be posted, use skipped --note
//                                                      "why" (the board shows "Not posted" and the reason).
//                                                      If the owner's finding note was a question, the answers routine must
//                                                      reply with --answer-to-question (shown as "Answer to your question")
//                                                      and, when the comment changed, --body with the revised Will post
//                                                      text. Status can be omitted when only those flags are set. Never
//                                                      leave the card showing only "You said" plus the old comment text.
//   ab review-status <repo>#<pr> --done|--undone      marks a drafted review done (not used on per-comment cards)
//   ab detail <key> [json|-] | ab detail <key> --clear
//                                                      merges {"summary"?,"plan"?,"discussion"?:[{"author","body","at"?,"link"?}],"actions"?:[...],
//                                                      "questions"?:[{"id","question","body"?,"recommendation"?}]} into the item's chevron.
//                                                      key: ticket:PROJ-2512, pr:app/209, mypr:app/209, waiting:<slug>,
//                                                      decision:<id>, page:tickets (shown above My tickets)
//   ab ticket <key> <ticket.md> --plain "text" | --plain-file <f.md>
//                                                      attaches the full ticket (Markdown) and an "In plain words" summary.
//                                                      Shown in this order on the item and its focus page: ticket, plain words,
//                                                      then questions and plan. Bare ABC-123 = ticket:ABC-123. Both are required.
//   ab plan <key> <file.md> [--no-questions]        attaches a plan file in full (rendered Markdown) plus its section 6 open questions
//                                                      as quick answers. Bare ABC-123 = ticket:ABC-123, other bare ids = decision:<id>
//   ab supersede <id> --by <id>                     marks a Home decision as superseded (not an open ask). The existing
//                                                      form ab supersede <item> <question-id> [--by <question-id>] still
//                                                      marks a thread question as replaced.
//   ab brief '<json>' | ab brief < brief.json       stores a ticket brief on board.briefs[group]: {group, title, summary,
//                                                      ticket?, svg?, pr_stand?, decisions?, gaps?, plan_link?, ticket_link?}.
//                                                      Concise plain words and an optional diagram; never a raw ticket dump.
//   ab stamp <group> <sha>                          records the stamped SHA for a group (push-OK cards go stale when they differ).
//   ab heads <group> <sha>                          records the current PR head SHA for a group.
//   ab context --bot <name> [--full] [--last N] [--clip N] [--asks N] [--no-mark]
//                                                      the bot's compact, read-only view of its conversations with Eric, as plain text:
//                                                      its open cards, each thread cut to the last 5 messages ("(+K earlier, see --full)"),
//                                                      long text clipped, and Eric's latest messages to it (unread first, marked NEW).
//                                                      Read this at the start of every run instead of the whole board. --full gives every
//                                                      card (closed too), whole threads, unclipped text and every message. Marks the
//                                                      shown messages as read (the board's checks) unless --no-mark.
//   ab prune [--dry-run] [--card-days N] [--ask-days N] [--log-days N] [--notification-days N]
//                                                      moves closed cards older than 14 days (with their asks and details), notes on tickets
//                                                      and PRs older than 30 days, ui_log and ui_delivery_log rows older than 14 days and
//                                                      notifications cleared more than 3 days ago into archive_* tables in the same database.
//                                                      Nothing is deleted. Idempotent. -> {"ok","dry_run","moved":{...},"updated_at"?}
//   ab lint                                         -> {"ok","failing":[{"id","problems":[...]}]}: open decisions breaking
//                                                      the title/context/question rules above, including the 3-line paragraph
//                                                      cap and a missing diagram on relationship/flow/timeline decisions; exit 1 if any (fix with ab raise, ab reply --at, or ab plan,
//                                                      or ab backfill-titles for cards raised before titles were stored)
//   ab backfill-titles < map.json                   one-shot: {"<decision id>":"<title>"} sets the title on open cards that have
//                                                      none (same title rules; any invalid title: exit 2, nothing written;
//                                                      card stamps unchanged) -> {"ok","wrote","set","unknown","skipped_answered",
//                                                      "skipped_has_title","still_missing"}
//   ab backfill-stamps [--dry-run]                  one-shot: fill missing created_at/updated_at from .ab-log.jsonl
//                                                      -> {"ok","dry_run","wrote","stamped","blank","no_history","unchanged","counts"}
//   ab project-refresh '<json>' | ab project-refresh [-] < project.json
//                                                      rewrites the milestones in project.ts (the project tab) from
//                                                      {"title"?,"parent"?:{"id","url"},"updated_at"?:"<ISO with zone, default now>",
//                                                      "milestones":[{"id":"PROJ-101","done":17,"in_progress":0,"left":1,"total":18,
//                                                      "key"?,"title"?,"url"?},...]}
//                                                      Milestones follow the input order. key/title/url are kept from project.ts for a known
//                                                      id; a new id needs key, title and url. title and parent are kept when left out.
//                                                      Strict (exit 2, project.ts unchanged): milestones a non-empty array, ids
//                                                      unique with no spaces, counts non-negative integers, in_progress <= left,
//                                                      done + left == total. -> {"ok","milestones","totals":{done,in_progress,left,total},"updated_at"}
// Exit codes: 0 ok, 1 check/lint found problems, 2 bad input (including input that is not JSON) or a corrupt file, 3 written but the live server does not
// serve it (raise only), 4 refused (answered, cleared, or already on the board), 5 unknown id or lock timeout.
// Stamps: a new raise sets created_at (given or now) and updated_at = created_at ("added" on the card). A re-raise replaces
// the card in place (same slot), keeps its created_at (a given one is ignored) and sets updated_at = now; so does answer.
// updated_at is set by ab only, so raise refuses it as input.
// Writes are serialized by a lock dir (board.ts.lock: wait up to 10s then exit 5; stale after 30s) and replace board.ts
// atomically (unique temp file, fsync, rename). A corrupt board (not exactly one START/END marker) is refused, exit 2.
// project-refresh uses the same lock and atomic replace on project.ts (lock project.ts.lock).
// Env: AB_FILE (board.ts), AB_PROJECT_FILE (default project.ts next to AB_FILE), AB_URL (default
// http://127.0.0.1:<ACTION_BOARD_PORT>), ACTION_BOARD_HOST and ACTION_BOARD_PORT (shell, then app/.env.local; defaults
// board.localhost and 8085, used for AB_URL and the card footer), AB_NO_SERVER=1 (tests).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { approvalState, changesFacts, ciReport, myReviewComments, prData, reviewCommentExists } from "./gh-enrich.mjs";
import { buildContext } from "../src/context.ts";
import { applyPrune, boardAfter, countsOf, planPrune } from "../src/prune.ts";
import { cardTicketLinkError, ticketLinkError } from "../src/ticket-links.ts";
import { applyCodeFences, fenceBareCode } from "../src/code-fences.ts";
import { isSlackDraft, normalizeSlack, slackDraftError } from "../src/slack-draft.ts";
import { applyQuietSwap, quietSwapText } from "../src/quiet-swap.ts";
import { carryDeclined, declinedForPr, declinedOf } from "../src/declined.ts";
import { healAnswers, settleDecision } from "../src/answered.ts";
import { carryPendingBot, findingNumber, healNotes, markNotePending } from "../src/finding-notes.ts";

// Storage: the agent-board SQLite file (AGENT_BOARD_DB, default ./agent-board.db) unless AB_FILE names a board.ts
// file (the file mode is kept for the UI's own tests and for importing an old board.ts).
const SQL = !process.env.AB_FILE;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DB_PATH = path.resolve(process.env.AGENT_BOARD_DB || "agent-board.db");
const FILE = process.env.AB_FILE || DB_PATH;
const APP_DIR = SQL ? path.join(ROOT, "ui") : path.join(path.dirname(FILE), "..", "..");
let sqlDb = null;
function sql() {
  if (sqlDb) return sqlDb;
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  sqlDb = new DatabaseSync(DB_PATH, { timeout: 5000 });
  sqlDb.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  sqlDb.exec(fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8"));
  const cols = sqlDb.prepare("PRAGMA table_info(ui_notifications)").all().map((c) => c.name);
  if (cols.includes("read_at") && !cols.includes("cleared_at")) sqlDb.exec("ALTER TABLE ui_notifications RENAME COLUMN read_at TO cleared_at");
  else if (cols.length && !cols.includes("cleared_at")) sqlDb.exec("ALTER TABLE ui_notifications ADD COLUMN cleared_at TEXT");
  return sqlDb;
}
const docGet = (key) => sql().prepare("SELECT json FROM ui_doc WHERE key = ?").get(key)?.json;
const docPut = (key, json) => sql().prepare("INSERT INTO ui_doc (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").run(key, json, new Date().toISOString());
// The assistant has seen the human's messages on this item: the board shows their checks as read. Storage mode only.
const markRead = (key) => { if (SQL && key) sql().prepare("INSERT INTO ui_item_read (item_key, read_at) VALUES (?, ?) ON CONFLICT(item_key) DO UPDATE SET read_at = excluded.read_at").run(key, new Date().toISOString()); };
export const EMPTY_BOARD = () => ({ updated_at: new Date(0).toISOString(), decisions: [], glance: { waiting: [], tickets: [], others: [], mine: [] } });
export const EMPTY_PROJECT = () => ({ title: "", updated_at: new Date(0).toISOString(), parent: { id: "", url: "" }, milestones: [] });
// A setting from the shell, else from app/.env.local (plain KEY=value lines), else undefined.
function setting(key) {
  if (process.env[key]) return process.env[key];
  try {
    const line = fs.readFileSync(path.join(APP_DIR, ".env.local"), "utf8").split("\n").filter((l) => l.startsWith(key + "=")).pop();
    return line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") || undefined;
  } catch { return undefined; }
}
const PORT = SQL ? Number(process.env.PORT) || 8787 : Number(setting("ACTION_BOARD_PORT")) || 8085;
const HOST = SQL ? (process.env.AGENT_BOARD_HOST || "localhost").toLowerCase() : (setting("ACTION_BOARD_HOST") || "board.localhost").toLowerCase();
const REPLIES_DIR = SQL ? path.resolve(process.env.AGENT_BOARD_REPLIES_DIR || path.join(path.dirname(DB_PATH), "replies")) : path.join(APP_DIR, "public", "replies");
const URL_ = process.env.AB_URL || "http://127.0.0.1:" + PORT;
const TOMB = path.join(APP_DIR, ".ab-cleared.jsonl");
const LOG = path.join(APP_DIR, ".ab-log.jsonl");
const A = "/* BOARD-JSON-START */", Z = "/* BOARD-JSON-END */";
const PROJECT_FILE = process.env.AB_PROJECT_FILE || path.join(path.dirname(FILE), "project.ts");
const PA = "/* PROJECT-JSON-START */", PZ = "/* PROJECT-JSON-END */";
const BOARD_BOTS = new Set(["Planner", "QA", "Engineer", "dr eggbot", "Grok Bot"]);
const ALLOWED = new Set(["id", "title", "card_ref", "context", "question", "what_happens_after", "details", "options", "multiSelect", "allowCustom", "priority", "pinned", "created_at", "section", "rule", "seen", "proposed_fix", "bot", "fixes", "svg", "tier", "estimate", "unblocks", "sha", "group", "glance", "joke", "recommendation", "draft", "superseded_by", "stale_reason", "severity", "answers_comment", "post_text", "current_text", "post_comments", "already_decided", "raised_by", "kind", "slack"]);
// Priority: missing (or anything else in a hand-edited file) means medium.
const PRIORITIES = ["high", "medium", "low"];
const isPriority = (v) => typeof v === "string" && PRIORITIES.includes(v);
const priorityOf = (d) => (isPriority(d.priority) ? d.priority : "medium");

// Plain-words rules, shared by raise and lint. Each check returns an error that names the field, or null.
// Ids say nothing on their own: URLs, ABC-1234, #123.
const IDS = /https?:\/\/\S+|\b[A-Za-z]+-\d+\b|#\d+/g;
const words = (s) => s.replace(IDS, " ").match(/\p{L}+/gu) || [];
const EXAMPLE = "the Q3 vendor contract";
const THING = "ticket|tickets|pr|prs|pull\\s+request|issue|card|bug|fix|change|branch|item|one";
const NEXT = "is|are|was|were|be|been|should|will|would|can|could|go|get|stay|need|needs|has|have|do|does";
const VAGUE = [
  // "the ticket?", "Should the PR be merged?"
  new RegExp(`\\b(?:the|this|that|these|those)\\s+(?:${THING})(?=\\s*$|\\s*[?.!,;:]|\\s+(?:${NEXT})\\b)`, "i"),
  /\bit\b/i,                                    // "Send it back to the vendor?"
  /\b(?:this|that)(?=\s*$|\s*[?.!,;:])/i,       // "Ship that?"
];
// A paragraph is a blank-line-separated block, or one bullet in a list. ~3 lines at card width.
const PARA_MAX = 280;
function paragraphsOf(text) {
  const chunks = [];
  for (const block of String(text).split(/\n\s*\n/)) {
    const lines = block.split(/\n/);
    const items = [];
    let allList = true;
    for (const line of lines) {
      const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
      if (m) items.push(m[1].trim());
      else if (line.trim()) allList = false;
    }
    if (allList && items.length) chunks.push(...items);
    else if (block.trim()) chunks.push(block.trim());
  }
  return chunks;
}
function paragraphError(text, field) {
  if (text === undefined || text === null || text === "") return null;
  if (typeof text !== "string") return null;
  for (const p of paragraphsOf(text)) {
    if (p.length > PARA_MAX) return field + " has a paragraph of " + p.length + " characters; keep each paragraph to 3 lines or fewer (about " + PARA_MAX + " characters)";
  }
  return null;
}
function textBlockProblems(d) {
  const out = [];
  const add = (v, f) => { const e = paragraphError(v, f); if (e) out.push(e); };
  add(d.question, "question");
  add(d.what_happens_after, "what_happens_after");
  add(d.recommendation?.reason, "recommendation.reason");
  add(d.glance?.asking, "glance.asking");
  for (const o of d.glance?.outcomes ?? []) add(o.happens, "glance.outcomes." + o.id);
  if (Array.isArray(d.details)) {
    d.details.forEach((x, i) => {
      if (typeof x === "string") add(x, "details[" + i + "]");
      else if (x && Array.isArray(x.items)) x.items.forEach((it, j) => add(it, "details[" + i + "].items[" + j + "]"));
    });
  }
  for (const o of d.options ?? []) add(o.label, "option " + (o.id ?? ""));
  return out;
}
function isReviewOrEditCard(d) {
  return Boolean(d.post_comments || d.answers_comment || d.current_text);
}
function diagramError(d) {
  if (d.section === "assistant" || isReviewOrEditCard(d) || isSlackDraft(d)) return null;
  if (d.tier && d.tier !== "decision") return null;
  if (typeof d.svg === "string" && d.svg.trim()) return null;
  const t = [d.title, d.question, d.context].filter(Boolean).join(" ");
  if (!/\b(timeline|end dates?|start dates?|same-day|reopen|ssn|overlap|midnight|merg(?:e|ing)|match(?:es|ing)?|lookups?|badge|lock(?:ing)?|concurrent|race)\b/i.test(t)) return null;
  return "add an svg diagram: this decision is about a relationship, flow or timeline (a small chart, comic panels, or both)";
}
function contextError(c) {
  if (typeof c !== "string" || !c.trim()) return "context is required: short plain words saying what the item is (the feature or screen, not just an id) and what happened that needs the user's call; break it into short paragraphs or bullets";
  const t = c.trim();
  if (t.length > 800) return "context is " + t.length + " chars; keep it to 800 or fewer, in short paragraphs or bullets";
  const e = paragraphError(t, "context");
  if (e) return e;
  if (words(t).length < 6) return "context needs at least 6 plain words besides ids: say what the item is (feature or screen) and what happened";
  return null;
}
function questionError(q) {
  if (typeof q !== "string" || !q.trim()) return "question is required";
  for (const re of VAGUE) { const m = q.match(re); if (m) return "question: \"" + m[0] + "\" is vague. Name the thing in plain words, for example \"" + EXAMPLE + "\"."; }
  return null;
}
const TITLE_EXAMPLE = "for example \"Q3 vendor contract renewal\"";
function titleError(t) {
  if (typeof t !== "string" || !t.trim()) return "title is required: a short bold topic for the top of the card, " + TITLE_EXAMPLE;
  const s = t.trim();
  if (/[\r\n]/.test(t)) return "title must be one line (no line breaks), " + TITLE_EXAMPLE;
  if (s.length > 60) return "title is " + s.length + " chars; keep it to 60 or fewer, a short topic " + TITLE_EXAMPLE;
  if (words(s).filter((w) => !/^(pr|ticket|issue)$/i.test(w)).length >= 2) return null;
  return "title: \"" + s + "\" is only an id. Add plain words saying what it is, for example \"ABC-1234 Checkout button color\".";
}
// The stored-field rules, shared by raise and lint.
// Standing rule (t103u): the owner answers every Assistant question himself. No option may accept several picks at once
// ("Accept all 7 of Assistant's picks", "take the recommendations"), and no label is marked "(pick)": the pick is a hint.
const BULK_RE = /\b(?:accept|take|go with|approve|use|apply)\s+(?:all|every|both)\b|\ball\s+(?:\d+\s+)?(?:of\s+)?(?:assistant'?s\s+|the\s+)?(?:picks|recommendations|suggestions)\b|\btake\s+the\s+(?:picks|recommendations|suggestions)\b|\(pick\)/i;
const bulkProblems = (opts) => (Array.isArray(opts) ? opts : []).filter((o) => BULK_RE.test(String(o?.label ?? ""))).map((o) => `option "${o.label}" is a bulk accept or marks a pick; each question is answered on its own (show the pick as "Assistant suggests: ..." instead)`);
// t111u/t112u: every question the owner gets carries a short plain-words context paragraph (what the ticket is for, what
// this part does, what exactly is asked and why). Short: at most 700 chars, so no walls of text.
function contextParaError(c) {
  if (!nonBlank(c)) return "needs --context: 2 to 4 plain sentences (or a tiny table) on what the ticket is for, what this part does, and what exactly you're asking and why";
  if (c.trim().length > 700) return "context is " + c.trim().length + " chars; keep it to 700 or fewer (short and fun, no walls of text)";
  return null;
}
// An SVG for a reply, made safe to show: no scripts, event handlers, foreign content or outside links.
function sanitizeSvg(src) {
  if (!/<svg[\s>]/i.test(src)) return null;
  let s = src.replace(/<\?xml[^>]*>/gi, "").replace(/<!DOCTYPE[^>]*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|foreignObject|iframe|object|embed|audio|video|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/<(script|foreignObject|iframe|object|embed|audio|video|style)\b[^>]*\/?>/gi, "");
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/\s+(?:xlink:)?href\s*=\s*("|')(?!#)[^"']*\1/gi, "");
  s = s.replace(/javascript:/gi, "");
  return s.trim();
}
function assistantFixesError(fixes) {
  if (fixes === undefined) return null;
  if (!Array.isArray(fixes) || !fixes.length) return "fixes must be a non-empty array of {id, seen, proposed}";
  const ids = new Set();
  for (const [i, f] of fixes.entries()) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return "fixes[" + i + "] must be an object {id, seen, proposed}";
    for (const k of Object.keys(f)) if (!["id", "seen", "proposed"].includes(k)) return "fixes[" + i + "] has unknown key " + k;
    for (const k of ["id", "seen", "proposed"]) {
      if (typeof f[k] !== "string" || !nonBlank(f[k])) return "fixes[" + i + "]." + k + " is required";
      if (f[k].trim().length > 2000) return "fixes[" + i + "]." + k + " is too long (2000 or fewer)";
    }
    const fid = f.id.trim();
    if (ids.has(fid)) return "fixes id " + fid + " is repeated";
    ids.add(fid);
  }
  return null;
}
function assistantFieldError(d) {
  if (d.section !== undefined && d.section !== "assistant") return 'section must be "assistant"';
  const fe = assistantFixesError(d.fixes);
  if (fe) return fe;
  const hasFixes = Array.isArray(d.fixes) && d.fixes.length;
  for (const [k, label, max, oneLine, required] of [
    ["rule", "rule", 2000, false, true],
    ["seen", "seen (what was seen)", 2000, false, !hasFixes],
    ["proposed_fix", "proposed_fix", 2000, false, !hasFixes],
    ["bot", "bot (which bot this is for)", 200, true, true],
  ]) {
    if (!required && d[k] === undefined) continue;
    if (typeof d[k] !== "string" || !nonBlank(d[k])) return label + " is required";
    const t = d[k].trim();
    if (t.length > max) return label + " is too long (" + max + " or fewer)";
    if (oneLine && /\n/.test(t)) return "bot must be one line";
  }
  return null;
}
function svgError(v) {
  if (v === undefined) return null;
  if (typeof v !== "string" || !v.trim()) return "svg must be an SVG document (leave it out when there is none)";
  if (v.length > 20000) return "svg is too long (20000 or fewer)";
  if (!sanitizeSvg(v)) return "svg is not a safe SVG (no scripts, handlers or outside links)";
  return null;
}

const TIERS = ["blocking", "quick", "decision", "fyi"];
const isBlank = (v) => typeof v !== "string" || !v.trim();
function glanceError(g, options) {
  if (!g || typeof g !== "object" || Array.isArray(g)) return "glance is required: ticket summary, what is being asked, and what happens on each answer";
  const ticket = g.ticket;
  if (!ticket || typeof ticket !== "object" || isBlank(ticket.id) || isBlank(ticket.summary)) return "glance.ticket needs an id and a one-line summary (never just the id, never the raw ticket)";
  if (/\n/.test(ticket.summary) || ticket.summary.trim().length > 160) return "glance.ticket.summary must be one line, 160 characters or fewer";
  if (words(ticket.summary).length < 4) return "glance.ticket.summary needs at least 4 plain words";
  if (isBlank(g.asking)) return "glance.asking is required";
  if (!Array.isArray(g.outcomes) || !g.outcomes.length) return "glance.outcomes must list what happens for each option";
  const seen = new Set();
  for (const o of g.outcomes) {
    if (!o || isBlank(o.id) || isBlank(o.happens)) return "each glance.outcome needs id and happens";
    seen.add(o.id);
  }
  for (const o of options || []) if (!seen.has(o.id)) return "glance.outcomes is missing option " + o.id;
  if (g.pr) {
    if (typeof g.pr !== "object" || !Number.isInteger(g.pr.number) || isBlank(g.pr.link)) return "glance.pr needs number and link";
  }
  if (g.done !== undefined && (!Array.isArray(g.done) || g.done.some((x) => isBlank(x)))) return "glance.done must be an array of non-blank strings";
  return null;
}
function answersCommentError(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) return "answers_comment must be an object {author, pr, path?, line?, severity?, url, body}";
  for (const k of Object.keys(c)) if (!["author", "pr", "repo", "path", "line", "severity", "url", "body"].includes(k)) return "answers_comment has unknown key " + k;
  if (isBlank(c.author)) return "answers_comment.author is required";
  if (!Number.isInteger(c.pr) || c.pr <= 0) return "answers_comment.pr must be a positive PR number";
  if (c.repo !== undefined && isBlank(c.repo)) return "answers_comment.repo must be non-blank when set";
  if (c.path !== undefined && isBlank(c.path)) return "answers_comment.path must be non-blank when set";
  if (c.line !== undefined && c.line !== null && (!Number.isInteger(c.line) || c.line <= 0)) return "answers_comment.line must be a positive integer or null";
  if (c.severity !== undefined && isBlank(c.severity)) return "answers_comment.severity must be non-blank when set";
  if (typeof c.url !== "string" || !/^https?:\/\//.test(c.url)) return "answers_comment.url must be an http(s) URL";
  if (isBlank(c.body)) return "answers_comment.body is required (the comment text being answered)";
  return null;
}
const RAW_TICKET_RE = /^#{1,3}\s+[A-Z]+-\d+:|^\s*-\s*\*\*Ticket:\*\*|^\s*\*\*Priority:\*\*|^\s*\*\*Labels:\*\*|^\s*#{1,3}\s+Description\b/m;
function rawTicketError(v, where) {
  if (typeof v !== "string") return null;
  if (RAW_TICKET_RE.test(v)) return where + " contains raw ticket markdown inline (put raw ticket in details.ticket behind Full ticket toggle, use a plain summary instead)";
  return null;
}
function isSkipOption(o) {
  const id = String(o?.id ?? "").trim().toLowerCase();
  const label = String(o?.label ?? "").trim().toLowerCase();
  return /^(none|skip|no|hold|wait|cancel|post_none|post-none)$/.test(id) || /^(post none|skip|no|don't post|do not post|none|hold|wait)/.test(label);
}
function postCommentsError(v) {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length === 0) return "post_comments must be a non-empty array of {label, path, line?, severity?, url?, body, n?}";
  for (const [i, c] of v.entries()) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return `post_comments[${i}] must be an object`;
    if (isBlank(c.label) || isBlank(c.path) || isBlank(c.body)) return `post_comments[${i}] needs label, path, and body`;
    if (c.line !== undefined && (!Number.isInteger(c.line) || c.line <= 0)) return `post_comments[${i}].line must be a positive integer`;
    if (c.n !== undefined && (!Number.isInteger(c.n) || c.n <= 0)) return `post_comments[${i}].n must be a positive integer`;
    if (c.status !== undefined && !["pending", "posted", "skipped"].includes(c.status)) return `post_comments[${i}].status must be pending, posted or skipped`;
    if (c.posted_url !== undefined && (typeof c.posted_url !== "string" || !/^https?:\/\//.test(c.posted_url))) return `post_comments[${i}].posted_url must be an http(s) URL`;
    if (c.note !== undefined && typeof c.note !== "string") return `post_comments[${i}].note must be a string`;
    if (c.answer_to_question !== undefined && (typeof c.answer_to_question !== "string" || isBlank(c.answer_to_question))) return `post_comments[${i}].answer_to_question must be a non-blank string when set`;
    if (c.revision_at !== undefined && (typeof c.revision_at !== "string" || Number.isNaN(Date.parse(c.revision_at)))) return `post_comments[${i}].revision_at must be an ISO timestamp when set`;
  }
  return null;
}
function findingNumberOf(c, fallback) {
  if (Number.isInteger(c?.n) && c.n > 0) return c.n;
  const m = /#(\d+)\b/.exec(String(c?.label ?? c?.id ?? ""));
  if (m) return Number(m[1]);
  if (Number.isInteger(fallback) && fallback > 0) return fallback;
  return null;
}
function isPerFindingReviewCard(d) {
  if (Array.isArray(d.post_comments) && d.post_comments.length > 0) return true;
  const text = [d.id, d.title, d.question, d.context].filter(Boolean).join(" ");
  if (!/\breview\b/i.test(text)) return false;
  const commentOpts = (d.options || []).filter((o) => !isBlank(o?.post_text) || !isBlank(o?.path));
  return commentOpts.length > 0 || /\b(?:which comments|ops post|post(?:s|ing)? (?:these |the )?comments)\b/i.test(text);
}
function perFindingReviewError(d) {
  if (!isPerFindingReviewCard(d)) return null;
  if (d.multiSelect) return "review cards must use per-finding answers, not multiSelect (each finding gets Post / Don't post and its own free-text box)";
  const skipAll = (d.options || []).filter((o) => isSkipOption(o) || /post none/i.test(String(o?.label ?? "")));
  if (skipAll.length) return "review cards cannot include a 'Post none' option; use a separate Don't post any button, and put comments in post_comments";
  const comments = d.post_comments;
  if (!Array.isArray(comments) || comments.length === 0) {
    return "review cards require post_comments (each finding: label with #N or n, path, and body) and no card-level comment options";
  }
  const nums = new Set();
  for (const [i, c] of comments.entries()) {
    const n = findingNumberOf(c, i + 1);
    if (!n) return `post_comments[${i}] needs a finding number (label starting with #N, or n)`;
    if (nums.has(n)) return `post_comments finding #${n} is duplicated`;
    nums.add(n);
  }
  if (Array.isArray(d.options) && d.options.length > 0) {
    return "review cards must not list comments as options; put each finding in post_comments (Post / Don't post are shown automatically)";
  }
  return null;
}
function postApprovalError(d) {
  if (isSlackDraft(d)) return null;
  if (d.answers_comment !== undefined) {
    const e = answersCommentError(d.answers_comment);
    if (e) return e;
  }
  if (d.post_comments !== undefined) {
    const e = postCommentsError(d.post_comments);
    if (e) return e;
  }
  if (d.post_text !== undefined && d.post_text !== null && isBlank(d.post_text)) {
    return "post_text must be a non-blank string (the exact text to post) or null for a thumbs-up with no text";
  }
  if (d.already_decided !== undefined) {
    if (!d.already_decided || typeof d.already_decided !== "object" || Array.isArray(d.already_decided) || isBlank(d.already_decided.answer)) {
      return "already_decided must be {answer, source?, at?}";
    }
  }
  const qAndOpts = [d.question ?? d.text ?? "", ...(d.options || []).map((o) => o.label ?? "")].join(" ");
  const allText = [d.title, d.context, d.question ?? d.text, d.what_happens_after, d.card_ref, d.group, d.glance?.pr?.link, ...(d.options || []).map((o) => o.label)].filter(Boolean).join(" ");
  const hasThumb = /👍|\bthumbs?\s*up\b/i.test(qAndOpts);
  const isPrItem = /^(?:pr|mypr):/i.test(String(d.group ?? "")) || Boolean(d.glance?.pr) || /github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(allText);
  const isGithub = isPrItem || /github\.com|\b(?:pr|bugbot|github|reviewer|thread|lgtm)\b|#\d+/i.test(allText);
  const asksPost =
    /\bpost\s+(?:it|this|that|the\s+(?:reply|comment|message|pushback)|as\s+written|to\s+github|on\s+github|on\s+(?:the|bugbot'?s)\s+thread)\b/i.test(qAndOpts) ||
    (isGithub && /\b(?:post|reply|replies|comment)\b/i.test(qAndOpts)) ||
    /\b(?:approve\s+(?:this\s+pr|the\s+pr|pr\s*#?\d+|#\d+|with\s+lgtm|on\s+github|the\s+review)|lgtm)\b/i.test(qAndOpts) ||
    (isPrItem && /\bapprove\b/i.test(qAndOpts));
  const perFindingErr = perFindingReviewError(d);
  if (perFindingErr) return perFindingErr;
  if (!hasThumb && !asksPost) return null;
  if (Array.isArray(d.post_comments) && d.post_comments.length > 0 && !hasThumb) return null;
  if (Array.isArray(d.options) && d.options.some((o) => !isBlank(o?.post_text)) && !hasThumb) return null;
  if (!d.answers_comment) return "cards that ask to post, reply, approve, or 👍 on GitHub require answers_comment {author, pr, path?, line?, severity?, url, body} (or post_comments for new PR review comments)";
  if (d.post_text === undefined) return "cards that ask to post, reply, approve, or 👍 on GitHub require post_text (exact text to post, or null for 👍 with no text)";
  if (d.post_text === null && !/👍|\bthumbs?\s*up\b|\bapprove\b|\blgtm\b|\bno\s+text\b/i.test(qAndOpts)) {
    return "post_text cannot be null unless this is a 👍 or no-text approval";
  }
  return null;
}
function triageError(d) {
  if (d.section === "assistant") return null;
  if (d.tier !== undefined && !TIERS.includes(d.tier)) return "tier must be blocking, quick, decision, or fyi";
  if (d.estimate !== undefined && isBlank(d.estimate)) return "estimate must be a non-blank string when set";
  if (d.unblocks !== undefined && (!Number.isInteger(d.unblocks) || d.unblocks < 0)) return "unblocks must be a non-negative integer";
  if (d.group !== undefined && isBlank(d.group)) return "group must be a non-blank string when set";
  if (d.glance !== undefined) {
    const g = glanceError(d.glance, d.options);
    if (g) return g;
  }
  if (d.recommendation) {
    if (typeof d.recommendation !== "object" || isBlank(d.recommendation.id) || isBlank(d.recommendation.reason)) return "recommendation needs id and reason (shown, never preselected)";
    if (!(d.options || []).some((o) => o.id === d.recommendation.id)) return "recommendation.id must be one of the options";
    if (d.recommendation.who !== undefined && isBlank(d.recommendation.who)) return "recommendation.who must be a non-blank string when set";
  }
  if (d.severity !== undefined && !["high", "medium", "low"].includes(d.severity)) return "severity must be high, medium or low";
  if (isPushCard(d) && (isBlank(d.sha) || !/^[0-9a-f]{7,40}$/i.test(d.sha.trim()))) return "push cards must include sha (7-40 hex commit SHA)";
  if (d.sha !== undefined && (isBlank(d.sha) || !/^[0-9a-f]{7,40}$/i.test(d.sha.trim()))) return "sha must be a 7-40 hex commit prefix when set";
  if (d.joke !== undefined && isBlank(d.joke)) return "joke must be a non-blank string when set";
  if (d.draft !== undefined && typeof d.draft !== "string") return "draft must be a string";
  if (d.superseded_by !== undefined && isBlank(d.superseded_by)) return "superseded_by must be a decision id";
  if (d.stale_reason !== undefined && isBlank(d.stale_reason)) return "stale_reason must be a non-blank string when set";
  return null;
}
function isPostedCommentEditCard(d) {
  if (typeof d.current_text === "string" && d.current_text.trim()) return true;
  const opts = d.options || [];
  const hasReplacement = (typeof d.post_text === "string" && !isBlank(d.post_text)) || opts.some((o) => !isBlank(o?.post_text));
  if (!d.answers_comment || !hasReplacement) return false;
  const optText = opts.map((o) => `${o?.id ?? ""} ${o?.label ?? ""}`).join(" ");
  const q = [d.id, d.title, d.question, d.context, d.what_happens_after, optText].filter(Boolean).join(" ");
  if (opts.some((o) => /^(edit|repost|replace|swap)$/i.test(String(o?.id ?? "")))) return true;
  if (/\bleave (as )?posted\b/i.test(optText)) return true;
  if (/\b(delete and re-?post|re-?post the corrected)\b/i.test(q)) return true;
  if (/\b(edit|swap|replace|fix|correct|update)\b[\s\S]{0,80}\b(posted|comment|suggestion|code box)\b/i.test(q)) return true;
  if (/\b(posted|already posted)\b[\s\S]{0,80}\b(edit|swap|replace|fix|correct|update)\b/i.test(q)) return true;
  return false;
}
function editCardError(d) {
  if (!isPostedCommentEditCard(d)) return null;
  const fromOpts = (d.options || []).map((o) => o?.current_text).find((t) => typeof t === "string" && t.trim());
  if (isBlank(d.current_text) && !fromOpts) return "cards that edit an already-posted comment need current_text (the text that's on GitHub now)";
  if (d.current_text !== undefined && (typeof d.current_text !== "string" || (isBlank(d.current_text) && !fromOpts))) {
    return "current_text must be a non-blank string (the text that's on GitHub now)";
  }
  const after = String(d.what_happens_after ?? "");
  const mutatesGithub = (d.options || []).some((o) => {
    const id = String(o?.id ?? "");
    const label = String(o?.label ?? "");
    return /^(edit|repost|replace|swap)$/i.test(id) || /\b(edit|swap|re-?post|replace|delete and)\b/i.test(label);
  });
  if (!mutatesGithub) return null;
  const claimsNoGithub = /nothing changes on github|nothing (?:on github )?changes until|goes to ops(?:\s+word for word)?(?:,|\s+and)\s+nothing changes/i.test(after);
  const mentionsGithubEdit = /\b(edit|update|replace|swap|delete|re-?post)\b[\s\S]{0,80}\b(github|comment)\b|\b(github|comment)\b[\s\S]{0,80}\b(edit|update|replace|swap|delete|re-?post)\b/i.test(after);
  if (claimsNoGithub || !mentionsGithubEdit) {
    return "what_happens_after must say what actually happens on GitHub (edit, or delete and re-post) and must not say nothing changes on GitHub";
  }
  return null;
}
const storedProblems = (d) => [contextError(d.context), questionError(d.question), titleError(d.title), svgError(d.svg), diagramError(d), rawTicketError(d.title, "title"), rawTicketError(d.context, "context"), rawTicketError(d.question, "question"), rawTicketError(d.what_happens_after, "what_happens_after"), rawTicketError(d.glance?.ticket?.summary, "glance.ticket.summary"), ...(Array.isArray(d.details) ? d.details.flatMap((x, i) => typeof x === "string" ? [rawTicketError(x, "details[" + i + "]")] : []) : []), ...textBlockProblems(d), ...bulkProblems(d.options), ...(d.section === "assistant" ? [assistantFieldError(d)] : [triageError(d)]), postApprovalError(d), editCardError(d)].filter(Boolean);
// details: a non-empty array of non-blank strings or {label, items, ordered?} objects. Returns an error or null.
function detailsError(v) {
  if (!Array.isArray(v) || !v.length) return "details must be a non-empty array (leave it out when there is nothing)";
  for (let n = 0; n < v.length; n++) {
    const e = v[n], at = "details[" + n + "]";
    if (typeof e === "string") { if (!e.trim()) return at + " is a blank string"; continue; }
    if (!e || typeof e !== "object" || Array.isArray(e)) return at + " must be a string or {\"label\",\"items\",\"ordered\"?}";
    for (const k of Object.keys(e)) if (!["label", "items", "ordered"].includes(k)) return at + " has unknown key " + k + " (allowed: label, items, ordered)";
    if (typeof e.label !== "string" || !e.label.trim()) return at + ".label must be a non-empty string";
    if (!Array.isArray(e.items) || !e.items.length || e.items.some((x) => typeof x !== "string" || !x.trim())) return at + ".items must be a non-empty array of non-empty strings";
    if ("ordered" in e && typeof e.ordered !== "boolean") return at + ".ordered must be true or false";
  }
  return null;
}
// details as plain text lines for the chat card: "- item", "Label:", "1. item".
const detailsText = (v) => v.flatMap((e) => typeof e === "string" ? ["- " + e]
  : [e.label + ":", ...e.items.map((x, i) => (e.ordered ? i + 1 + ". " : "- ") + x)]).join("\n");

const die = (code, msg) => { console.error("ab: " + msg); process.exit(code); };
// Writers take LOCK before load() and hold it until save() is done (released before waiting on the server, or at exit).
const LOCK = (SQL ? DB_PATH + ".ab" : FILE) + ".lock";
let held = null;
const unlock = () => { if (held) { fs.rmSync(held, { recursive: true, force: true }); held = null; } };
process.on("exit", unlock);
function lock(dir = LOCK) {
  const end = Date.now() + 10000;
  while (true) {
    try { fs.mkdirSync(dir); held = dir; return; } catch (e) { if (e.code !== "EEXIST") throw e; }
    try { if (Date.now() - fs.statSync(dir).mtimeMs > 30000) { fs.rmSync(dir, { recursive: true, force: true }); continue; } } catch {}
    if (Date.now() > end) die(5, (dir === LOCK ? "board" : "project") + " is locked by another ab for over 10s: " + dir + " (remove it if no ab is running)");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}
// soft: return { error } instead of exiting (open/check report it as a problem).
function load(soft) {
  if (SQL) {
    const json = docGet("board");
    if (json === undefined) return { b: EMPTY_BOARD() };
    try { return { b: JSON.parse(json) }; } catch (e) { return soft ? { error: "board is corrupt in " + DB_PATH } : die(2, "board is corrupt in " + DB_PATH + "; refusing to read or write it"); }
  }
  const s = fs.readFileSync(FILE, "utf8");
  const bad = (m) => soft ? { error: "board is corrupt: " + m + " in " + FILE } : die(2, "board is corrupt: " + m + " in " + FILE + "; refusing to read or write it");
  const nA = s.split(A).length - 1, nZ = s.split(Z).length - 1;
  if (nA !== 1 || nZ !== 1) return bad(nA + " BOARD-JSON-START and " + nZ + " BOARD-JSON-END markers (need exactly one each)");
  const i = s.indexOf(A) + A.length, j = s.indexOf(Z);
  if (j < i) return bad("BOARD-JSON-END comes before BOARD-JSON-START");
  if (!/^\s*;?\s*$/.test(s.slice(j + Z.length))) return bad("unexpected text after BOARD-JSON-END");
  try { return { s, i, j, b: JSON.parse(s.slice(i, j)) }; } catch (e) { return bad("board JSON does not parse (" + e.message + ")"); }
}
// Atomic replace: unique temp file in the same directory, fsync, rename over file.
function writeAtomic(file, text) {
  const tmp = file + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
  try {
    const fd = fs.openSync(tmp, "wx");
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
}
function save({ s, i, j }, b) {
  b.updated_at = new Date().toISOString();
  if (SQL) { docPut("board", JSON.stringify(b)); return b.updated_at; }
  writeAtomic(FILE, s.slice(0, i) + "\n" + JSON.stringify(b, null, 2) + "\n" + s.slice(j));
  return b.updated_at;
}
// project.ts: the JSON between the PROJECT markers. Missing file, bad markers or bad JSON: exit 2.
function loadProject() {
  if (SQL) { const j = docGet("project"); return { p: j === undefined ? EMPTY_PROJECT() : JSON.parse(j) }; }
  const bad = (m) => die(2, "project file " + m + ": " + PROJECT_FILE + "; refusing to read or write it");
  if (!fs.existsSync(PROJECT_FILE)) bad("not found");
  const s = fs.readFileSync(PROJECT_FILE, "utf8");
  if (s.split(PA).length !== 2 || s.split(PZ).length !== 2) bad("needs exactly one PROJECT-JSON-START and one PROJECT-JSON-END marker");
  const i = s.indexOf(PA) + PA.length, j = s.indexOf(PZ);
  if (j < i) bad("has PROJECT-JSON-END before PROJECT-JSON-START");
  let p; try { p = JSON.parse(s.slice(i, j)); } catch (e) { bad("JSON does not parse (" + e.message + ")"); }
  if (!p || typeof p !== "object" || !Array.isArray(p.milestones)) bad("has no milestones array");
  return { s, i, j, p };
}
const COUNTS = ["done", "in_progress", "left", "total"];
const nonBlank = (v) => typeof v === "string" && !!v.trim();
const isHttp = (v) => /^https?:\/\//.test(v);
// project-refresh input -> the new title, parent and milestones, or an error naming the field. old: project.ts as it is.
function projectData(input, old) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "input must be a JSON object {\"title\"?,\"parent\"?,\"updated_at\"?,\"milestones\":[...]}" };
  for (const k of Object.keys(input)) if (!["title", "parent", "updated_at", "milestones"].includes(k)) return { error: "unknown key " + k + " (allowed: title, parent, updated_at, milestones)" };
  if ("title" in input && (!nonBlank(input.title) || input.title.trim().length > 60)) return { error: "title must be a non-blank string of 60 chars or fewer" };
  if ("parent" in input) {
    const p = input.parent;
    if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((k) => k !== "id" && k !== "url") || !nonBlank(p.id) || !nonBlank(p.url) || !isHttp(p.url)) return { error: "parent must be {\"id\",\"url\"} with non-blank strings and an http(s) url" };
  }
  if (!Array.isArray(input.milestones) || !input.milestones.length) return { error: "milestones must be a non-empty array" };
  const seen = new Set(), out = [];
  for (const [n, m] of input.milestones.entries()) {
    const at = "milestones[" + n + "]";
    if (!m || typeof m !== "object" || Array.isArray(m)) return { error: at + " must be an object {id, done, in_progress, left, total, key?, title?, url?}" };
    for (const k of Object.keys(m)) if (!["id", "key", "title", "url", ...COUNTS].includes(k)) return { error: at + " has unknown key " + k };
    if (typeof m.id !== "string" || !/^\S{1,80}$/.test(m.id)) return { error: at + ".id must be a non-blank string with no spaces, like PROJ-101" };
    const who = at + " (" + m.id + ")";
    if (seen.has(m.id)) return { error: who + " is a duplicate id" };
    seen.add(m.id);
    for (const k of COUNTS) if (!Number.isInteger(m[k]) || m[k] < 0) return { error: who + "." + k + " must be a non-negative integer" };
    if (m.in_progress > m.left) return { error: who + ": in_progress (" + m.in_progress + ") must not exceed left (" + m.left + "); left includes in progress" };
    if (m.done + m.left !== m.total) return { error: who + ": done + left (" + m.done + " + " + m.left + " = " + (m.done + m.left) + ") must equal total (" + m.total + ")" };
    for (const k of ["key", "title", "url"]) if (k in m && !nonBlank(m[k])) return { error: who + "." + k + " must be a non-blank string" };
    if ("url" in m && !isHttp(m.url)) return { error: who + ".url must start with http:// or https://" };
    const known = old.milestones.find((x) => x.id === m.id) || {};
    const key = (m.key ?? known.key)?.trim(), title = (m.title ?? known.title)?.trim(), url = m.url ?? known.url;
    if (!key || !title || !url) return { error: who + " is new: give its key (like \"M5\"), title and url" };
    out.push({ key, id: m.id, title, url, done: m.done, in_progress: m.in_progress, left: m.left, total: m.total });
  }
  return { title: input.title?.trim() ?? old.title, parent: input.parent ?? old.parent, milestones: out };
}
// My PRs, drafted reviews and item details (see the header).
const MYPR_STATES = ["draft", "ready", "approved", "changes requested"];
const MYPR_CI = ["passing", "failing", "pending", "none"];
// HTML entities that leak into drafts from GitHub HTML or agent output, decoded in one pass (&amp;gt; -> &gt;).
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'", nbsp: " " };
function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|apos|#39|#x27|nbsp);/g, (_, name) => ENTITIES[name]);
}

const REVIEW_SEVERITIES = ["high", "medium", "low"];
const REVIEW_STATUSES = ["pending", "posted", "skipped"];
// An item key: kind:id. A bare ABC-123 is a ticket; any other bare id is a decision.
function detailKeyOf(k) {
  if (!nonBlank(k) || /\s/.test(k)) return null;
  if (/^(ticket|pr|mypr|waiting|decision|page):.+/.test(k)) return k;
  if (k.includes(":")) return null;
  return /^[A-Z][A-Z0-9]*-\d+$/.test(k) ? "ticket:" + k : "decision:" + k;
}
function detailError(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return "input must be a JSON object {ticket?, plain?, summary?, plan?, discussion?, actions?, questions?}";
  for (const k of Object.keys(d)) if (!["ticket", "plain", "summary", "plan", "discussion", "actions", "questions", "review_plain", "review_questions", "review_brief_sig"].includes(k)) return "unknown key " + k;
  for (const k of ["ticket", "plain", "summary", "plan", "review_plain", "review_questions", "review_brief_sig"]) if (k in d && typeof d[k] !== "string") return k + " must be a string";
  if ("actions" in d && (!Array.isArray(d.actions) || !d.actions.every(nonBlank))) return "actions must be an array of non-blank strings";
  if ("discussion" in d && (!Array.isArray(d.discussion) || !d.discussion.every((e) => e && nonBlank(e.author) && nonBlank(e.body)))) return "discussion must be an array of {author, body, at?, link?}";
  if ("questions" in d && (!Array.isArray(d.questions) || !d.questions.every((q) => q && nonBlank(q.id) && nonBlank(q.question)))) return "questions must be an array of {id, question, body?, recommendation?}";
  return null;
}
// the owner's side of the conversation (board.asks): one entry per note, answer, click or custom text he sent.
// askOf turns a webhook payload (or a ready ask) into {id, at, item_key, label, link?, kind, text, reply_to?, ref?}.
const STATUS_RE = /^(working|done|passed:(Assistant|ops)|waiting:\S.{0,39})$/;
function askPrKey(link, section) {
  const m = /github\.com\/[^/]+\/([\w.-]+)\/pull\/(\d+)/.exec(link ?? "");
  return m ? `${section === "mine" ? "mypr" : "pr"}:${m[1]}/${m[2]}` : null;
}
const slugOf = (t) => (String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "") || "untitled");
// The ask the board stores for a payload, plus who it was sent to when the person picked or the card named a bot (to_bot).
function askOf(p, b) {
  const a = askOfBase(p, b);
  if (a && p && BOARD_BOTS.has(p.to_bot)) a.to_bot = p.to_bot;
  return a;
}
function askOfBase(p, b) {
  if (!p || typeof p !== "object") return null;
  const short = (t) => String(t ?? "").trim();
  if (p.event === "item.message") {
    if (!nonBlank(p.message_id) || !nonBlank(p.text)) return null;
    const sec = p.item_section;
    const key = sec === "tickets" ? "ticket:" + p.item_id : sec === "decision" ? "decision:" + p.item_id
      : sec === "waiting" ? "waiting:" + slugOf(p.item_title) : askPrKey(p.item_link ?? p.item_id, sec) ?? `${sec}:${slugOf(p.item_title)}`;
    const a = { id: p.message_id, at: p.sent_at ?? new Date().toISOString(), item_key: key, label: short(p.item_title) || key, kind: "note", text: short(p.text) };
    if (nonBlank(p.item_link)) a.link = p.item_link;
    const m = /^Answer to "([\s\S]+?)": ([\s\S]+)$/.exec(a.text);
    if (m) {
      const th = [...(b.details?.[key]?.thread ?? [])].reverse();
      const q = th.find((t) => t.question?.text === m[1] && !t.question.superseded_by) ?? th.find((t) => t.question?.text === m[1]);
      if (q) Object.assign(a, { kind: "answer", reply_to: q.question.id, text: m[2].trim() });
    }
    return a;
  }
  if (p.event === "decision.answered" || p.event === "decision.clarify" || p.event === "decision.not_relevant") {
    if (!nonBlank(p.decision_id)) return null;
    const d = (b.decisions ?? []).find((x) => x.id === p.decision_id);
    const base = { item_key: "decision:" + p.decision_id, label: short(d?.title ?? d?.question ?? p.question ?? p.decision_id) };
    if (p.event === "decision.clarify") return { id: `${p.decision_id}:clarify:${p.clicked_at}`, at: p.clicked_at, ...base, kind: "click", text: "Explain this better" };
    if (p.event === "decision.not_relevant") return { id: `${p.decision_id}:not-relevant`, at: p.cleared_at, ...base, kind: "click", text: "Not relevant anymore" };
    const custom = p.answer === "custom";
    const label = Array.isArray(p.answer_label) ? p.answer_label.join(", ") : short(p.answer_label);
    const text = p.action === "send" ? short(p.text ?? p.custom_text ?? label) : p.action === "decline" ? (label || "Don't send") : custom ? short(p.custom_text ?? label) : label;
    return { id: `${p.decision_id}:answer`, at: p.answered_at, ...base, kind: custom ? "custom" : "answer", text };
  }
  if (p.event === "review.answer") {
    if (!nonBlank(p.repo) || !Number.isInteger(p.pr) || !nonBlank(p.comment_id)) return null;
    const cardId = nonBlank(p.card_id) ? p.card_id : undefined;
    if (cardId) {
      const n = p.comment_id === "all" ? "all" : (Number.isInteger(p.finding) ? p.finding : p.comment_id);
      const loc = p.path ? `${p.path}${p.line ? ":" + p.line : ""}` : "";
      const where = loc ? ` (${loc})` : "";
      const words = p.comment_id === "all" ? "Don't post any" : p.action === "post" ? "Post" : p.action === "skip" ? "Don't post" : short(p.text);
      const text = p.comment_id === "all" ? words : `Finding #${n}${where}: ${words}`;
      const d = (b.decisions ?? []).find((x) => x.id === cardId);
      return {
        id: `${cardId}:${n}:${p.action}:${p.answered_at}`,
        at: p.answered_at,
        item_key: "decision:" + cardId,
        label: short(d?.title ?? d?.question ?? cardId),
        link: p.pr_link,
        kind: "review",
        text,
        ref: `${cardId}:${n}`,
      };
    }
    const where = p.path ? ` (${p.path}${p.line ? ":" + p.line : ""})` : "";
    const c = p.comment_id === "pr" ? "the PR" : p.comment_id + where;
    const text = p.action === "post" ? `Post to GitHub: ${c}${p.edited && p.text ? "\n\n" + p.text : ""}` : p.action === "skip" ? `Skip ${c}` : `Note on ${c}: ${short(p.text)}`;
    return { id: `${p.decision_id}:${p.action}:${p.answered_at}`, at: p.answered_at, item_key: `pr:${p.repo}/${p.pr}`, label: `${p.repo} #${p.pr}`, link: p.pr_link, kind: "review", text, ref: `${p.repo}#${p.pr}:${p.comment_id}` };
  }
  if (nonBlank(p.id) && nonBlank(p.item_key) && nonBlank(p.text) && nonBlank(p.at)) {
    const a = { id: p.id, at: p.at, item_key: p.item_key, label: short(p.label) || p.item_key, kind: ["note", "answer", "custom", "click", "review"].includes(p.kind) ? p.kind : "note", text: short(p.text) };
    for (const k of ["link", "reply_to", "ref"]) if (nonBlank(p[k])) a[k] = p[k];
    return a;
  }
  return null;
}
// The open questions in a plan: a "## N. Questions for the owner" section when there is one (each numbered item is the
// question, its "- My pick:" sub-bullet the recommended answer), else section 6 ("## 6. Open questions ..."), one per
// top-level list item, with the first bold span as the question and the text after "Recommendation:" as the answer.
function planQuestions(md) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let start = lines.findIndex((l) => /^#{2,3}\s*(\d+[.)]?\s+)?Questions for the owner\b/i.test(l));
  const forHuman = start >= 0;
  if (!forHuman) start = lines.findIndex((l) => /^#{2,3}\s*6[.)]?\s/.test(l));
  if (start < 0) return [];
  const items = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,2}\s/.test(l)) break;
    if (/^([-*]|\d+[.)])\s+/.test(l)) items.push(l.replace(/^([-*]|\d+[.)])\s+/, ""));
    else if (items.length && l.trim()) items[items.length - 1] += "\n" + l.trim();
  }
  return items.map((body, n) => {
    const bold = body.match(/\*\*([^*]+?)\*\*/);
    let question;
    if (forHuman && bold && body.trimStart().startsWith("**")) question = bold[1].trim().replace(/\*+/g, "");
    else if (forHuman) {
      const head = [];
      for (const l of body.split("\n")) { if (/^[-*]\s/.test(l)) break; head.push(l.trim()); }
      question = head.join(" ").replace(/\*+/g, "").trim();
    } else question = (bold ? bold[1] : body.split(/(?<=[.?!])\s/)[0]).trim();
    const qid = question.match(/^(Q\d+)\s*[—–:-]\s*/);
    const id = qid ? qid[1] : "Q" + (n + 1);
    if (qid) question = question.slice(qid[0].length);
    const rec = (forHuman && body.match(/^[-*]\s+\**My pick\**\s*:?\**\s*([\s\S]+?)(?=\n[-*]\s|$)/im)) ||
      body.match(/Recommend(?:ation|ed)?(?:\s+for now)?\s*:?\**\s*:?\s*([\s\S]+)$/i);
    const recommendation = rec ? rec[1].replace(/\*+/g, "").replace(/\s+/g, " ").trim() : undefined;
    const ctx = body.match(/^[-*]?\s*\**Context\**\s*:\**\s*([\s\S]+?)(?=\n[-*]\s|$)/im);
    const context = ctx ? ctx[1].replace(/\*+$/g, "").trim() : undefined;
    return { id, question, body, ...(recommendation ? { recommendation } : {}), ...(context ? { context } : {}) };
  });
}
const log = (o) => { const line = JSON.stringify({ at: new Date().toISOString(), ...o }); if (SQL) sql().prepare("INSERT INTO ui_log (json) VALUES (?)").run(line); else fs.appendFileSync(LOG, line + "\n"); };
const addTomb = (o) => { const line = JSON.stringify(o); if (SQL) sql().prepare("INSERT INTO ui_tombstones (card_id, json) VALUES (?, ?)").run(o.id, line); else fs.appendFileSync(TOMB, line + "\n"); };
const logLines = () => SQL ? sql().prepare("SELECT json FROM ui_log ORDER BY id").all().map((r) => r.json) : fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n") : [];
const tombstones = () => SQL ? sql().prepare("SELECT json FROM ui_tombstones ORDER BY id").all().map((r) => JSON.parse(r.json)) : fs.existsSync(TOMB) ? fs.readFileSync(TOMB, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
// The latest tombstone line for id (a clear {id, reason, at, card?} or a restore marker {id, restored, at}), or undefined.
const lastTomb = (id) => tombstones().filter((t) => t.id === id).pop();
// Cleared means the latest line for the id is a clear, not a restore marker.
const isCleared = (id) => { const t = lastTomb(id); return !!t && !t.restored; };
async function served() {
  if (process.env.AB_NO_SERVER) return null;
  try { const r = await fetch(URL_ + "/__ab/board", { cache: "no-store" }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function waitServed(pred, ms = 4000) {
  unlock();                                           // written already; don't block other writers while polling
  if (process.env.AB_NO_SERVER) return true;
  const end = Date.now() + ms;
  while (Date.now() < end) { const b = await served(); if (b && pred(b)) return true; await new Promise((r) => setTimeout(r, 250)); }
  return false;
}
function flag(args, name) { const k = args.indexOf(name); if (k < 0) return undefined; const v = args[k + 1]; args.splice(k, 2); return v; }
const sameSha = (a, b) => {
  if (!a || !b) return false;
  const x = String(a).toLowerCase(), y = String(b).toLowerCase();
  const n = Math.min(x.length, y.length);
  return n >= 7 && x.slice(0, n) === y.slice(0, n);
};
const isPushCard = (d) => {
  const text = [d.id, d.title, d.question].filter(Boolean).join(" ");
  if (/\bpush[\s-]+hold\b/i.test(text)) return false;
  return /\bpush(?:ed)?\b/i.test(text) && (/^(?:pr|mypr):/i.test(d.group ?? "") || /#\d+|\bpr\b|\bbranch\b|\bcommit\b|\bpush\s+(?:it|now|this|the|fixes|to)\b/i.test(text));
};
function cardStale(d, b) {
  if (d.superseded_by) return true;
  const group = d.group;
  if (d.sha && group && b?.stamps?.[group] && !sameSha(d.sha, b.stamps[group])) return true;
  if (d.sha && isPushCard(d) && group && b?.heads?.[group] && !sameSha(d.sha, b.heads[group])) return true;
  return false;
}
// A per-comment review card is done when every finding is posted or skipped, or he tapped
// Post / Don't post (including Don't post any). Those cards must not stay "open" for check.
function allFindingsSettled(d, b = {}) {
  const comments = d.post_comments;
  if (!Array.isArray(comments) || comments.length === 0) return false;
  const cardId = d.id, prefix = cardId + ":", itemKey = "decision:" + cardId;
  const ans = new Map();
  for (const a of b.asks ?? []) {
    if (a.item_key !== itemKey && !(typeof a.ref === "string" && a.ref.startsWith(prefix))) continue;
    if (a.ref === cardId + ":all" || /^Don't post any\b/i.test(a.text ?? "")) { ans.set("all", "Don't post any"); continue; }
    const refN = a.ref && a.ref.startsWith(prefix) ? a.ref.slice(prefix.length) : undefined;
    const textN = /^Finding #(\d+)\b/.exec(a.text ?? "")?.[1];
    const n = refN && refN !== "all" ? refN : textN;
    if (!n) continue;
    const after = (a.text ?? "").includes(": ") ? a.text.slice(a.text.indexOf(": ") + 2) : a.text;
    ans.set(String(n), String(after ?? "").trim());
  }
  if (ans.get("all")) return true;
  return comments.every((c, i) => {
    const n = (Number.isInteger(c.n) && c.n > 0 ? c.n : (/#(\d+)\b/.exec(c.label ?? "")?.[1])) ?? (i + 1);
    if (c.status === "posted" || c.status === "skipped") return true;
    const said = (ans.get(String(n)) ?? "").trim();
    return /^don't post(?: any)?$/i.test(said) || /^post$/i.test(said);
  });
}
// Open Home and Dr. Assistant cards: unanswered, not superseded or stale, and not a fully settled review card.
const isOpen = (d, b = {}) => !d.answer && !cardStale(d, b) && !allFindingsSettled(d, b);


const [cmd, ...args] = process.argv.slice(2);
const input = () => (args[0] && args[0].trim().startsWith("{") ? args[0] : fs.readFileSync(0, "utf8"));
// Input that is not valid JSON is bad input: exit 2, nothing written.
const parseInput = (text) => { try { return JSON.parse(text); } catch (e) { die(2, cmd + ": input is not valid JSON (" + e.message + ")"); } };

// ---- GitHub refresh (read only, through gh): CI failures and change requests on My PRs, Ready to approve on PRs
// that ask for the user's review, and whether posted review comments still exist. Skipped in tests (AB_NO_SERVER)
// and with AB_NO_GH=1. Runs the gh calls first, then applies the results under the lock.
const ghEnabled = () => !process.env.AB_NO_SERVER && !process.env.AB_NO_GH;
const prKeyOf = (link) => { const m = String(link ?? "").match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/); return m ? { repo: m[1], number: Number(m[2]) } : null; };
function ghCollect(b, { mine = true, others = true, posted = true } = {}) {
  const out = { mine: {}, others: {}, comments: [], errors: [] };
  const tryIt = (what, fn) => { try { return fn(); } catch (e) { out.errors.push(what + ": " + String(e.message ?? e).split("\n")[0].slice(0, 200)); return undefined; } };
  if (mine) for (const p of b.glance?.mine ?? []) {
    const key = "mypr:" + p.repo + "/" + p.number; const r = { ci: null, changes: null };
    // Failing: refresh what failed (keep the last report if nothing failed yet on a new run). Passing: clear it.
    if (p.ci === "failing") r.ci = tryIt(key + " ci", () => ciReport(p.repo, p.number)) ?? undefined;
    else if (p.ci === "passing") r.ci = null;
    else r.ci = undefined;
    if (p.state === "changes requested") { const pr = tryIt(key + " reviews", () => prData(p.repo, p.number)); if (pr) r.changes = changesFacts(pr, r.ci?.text ?? ""); else r.changes = undefined; }
    out.mine[key] = r;
  }
  if (others) for (const o of b.glance?.others ?? []) {
    if (!/review requested/i.test(o.who ?? "")) continue; const k = prKeyOf(o.link); if (!k) continue;
    const pr = tryIt("pr:" + k.repo + "/" + k.number, () => prData(k.repo, k.number));
    if (pr) out.others["pr:" + k.repo + "/" + k.number] = approvalState(pr);
  }
  if (posted) for (const d of b.reviews ?? []) {
    const posts = d.comments.filter((c) => c.status === "posted"); if (!posts.length) continue;
    let mineList = null;
    for (const c of posts) {
      if (c.url) { const ok = tryIt(d.repo + "#" + d.pr + " " + c.id, () => reviewCommentExists(d.repo, c.url)); if (ok === false) out.comments.push({ repo: d.repo, pr: d.pr, id: c.id, deleted: true }); continue; }
      if (!/[./]/.test(c.path)) continue;
      mineList ??= tryIt(d.repo + "#" + d.pr + " comments", () => myReviewComments(d.repo, d.pr)) ?? [];
      // Same file and line, else the only unclaimed comment of mine on that file.
      const onFile = mineList.filter((m) => !m.claimed && (m.path === c.path || m.path.endsWith("/" + c.path) || c.path.endsWith(m.path)));
      const hit = onFile.find((m) => c.line != null && (m.line === c.line || m.original_line === c.line)) ?? (onFile.length === 1 ? onFile[0] : undefined);
      if (hit) { hit.claimed = true; out.comments.push({ repo: d.repo, pr: d.pr, id: c.id, url: hit.url }); }
    }
  }
  return out;
}
function ghApply(b, got) {
  const all = b.details && typeof b.details === "object" ? b.details : (b.details = {});
  const now = new Date().toISOString(); const needsBrief = [];
  const tidy = (k) => { const d = all[k]; if (d && Object.keys(d).every((x) => x === "updated_at")) delete all[k]; };
  for (const [k, r] of Object.entries(got.mine)) {
    const d = (all[k] ??= {});
    if (r.ci !== undefined) { if (r.ci) d.ci_report = r.ci.report; else delete d.ci_report; }
    if (r.changes !== undefined) {
      if (r.changes) { d.review_facts = r.changes.facts; d.review_scope = r.changes.scope; d.review_sig = r.changes.sig; if (d.review_brief_sig !== r.changes.sig) needsBrief.push(k); }
      else for (const x of ["review_facts", "review_scope", "review_sig", "review_plain", "review_questions", "review_brief_sig"]) delete d[x];
    }
    d.updated_at = now; tidy(k);
  }
  for (const [k, a] of Object.entries(got.others)) { const d = (all[k] ??= {}); if (a) d.approval = a; else delete d.approval; d.updated_at = now; tidy(k); }
  const ET = new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) + " ET";
  for (const c of got.comments) {
    const d = (b.reviews ?? []).find((r) => r.repo === c.repo && r.pr === c.pr); const x = d?.comments.find((y) => y.id === c.id); if (!x) continue;
    if (c.deleted) { x.status = "skipped"; x.note = "deleted on GitHub (found " + ET + ")"; } else if (c.url) x.url = c.url;
  }
  return { needs_brief: needsBrief, approvals: got.others, ci: Object.keys(got.mine).filter((k) => all[k]?.ci_report), changes: Object.keys(got.mine).filter((k) => all[k]?.review_facts), comments: got.comments, errors: got.errors };
}

function decisionReviewPr(d) {
  const link = d.glance?.pr?.link ?? (typeof d.card_ref === "string" && /^https?:\/\//.test(d.card_ref) ? d.card_ref : "");
  const fromLink = /github\.com\/(?:[^/]+\/)?([\w.-]+)\/pull\/(\d+)/.exec(link);
  if (fromLink) return { repo: fromLink[1], pr: Number(fromLink[2]) };
  const fromGroup = /^pr:([\w.-]+)\/(\d+)$/.exec(d.group ?? "");
  if (fromGroup) return { repo: fromGroup[1], pr: Number(fromGroup[2]) };
  return null;
}
function perFindingCardsForPr(b, repo, pr) {
  return (b.decisions ?? []).filter((d) => {
    const p = decisionReviewPr(d);
    return p && p.repo === repo && p.pr === pr && isPerFindingReviewCard(d) && !d.superseded_by;
  });
}
function findingOnCard(d, id) {
  const raw = String(id ?? "").trim();
  const n = raw.replace(/^#/, "").replace(/^f/i, "");
  return (d.post_comments ?? []).find((c, i) => {
    const fn = findingNumberOf(c, i + 1);
    return String(fn) === n || c.id === raw || (c.n != null && String(c.n) === n);
  });
}


// Required shape for ab raise / ab assistant. Existing open cards are not rewritten to this shape; they still render.
const BOT_ID_PREFIX = { Planner: "planner-", QA: "qa-", Engineer: "engineer-", "dr eggbot": "eggbot-", "Grok Bot": "grok-" };
function prefixesFor(bot) {
  if (bot === "dr eggbot") return ["eggbot-", "dr-eggbot-"];
  const p = BOT_ID_PREFIX[bot];
  return p ? [p] : [];
}
function parseGroup(g) {
  const s = String(g ?? "").trim();
  let m = /^(?:ticket:)?(ROWS-\d+)$/i.exec(s);
  if (m) return { kind: "ticket", key: m[1].toUpperCase() };
  m = /^#(\d+)$/.exec(s);
  if (m) return { kind: "pr", number: m[1], repo: null };
  m = /^([A-Za-z0-9._-]+)#(\d+)$/.exec(s);
  if (m) return { kind: "pr", repo: m[1], number: m[2] };
  return null;
}
function groupLinkError(d) {
  const g = parseGroup(d.group);
  if (!g) return "group is required and must be a ticket key (ROWS-1234) or a PR (#1234 or repo#1234)";
  const url = typeof d.card_ref === "string" ? d.card_ref.trim() : "";
  if (!url) return "card_ref (or link) is required: a Linear URL for a ticket group, or a GitHub URL for a PR group";
  if (g.kind === "ticket") {
    const m = /^https:\/\/linear\.app\/rows\/issue\/(ROWS-\d+)(?:\/|$|\?)/i.exec(url);
    if (!m) return "card_ref must be a Linear URL starting with https://linear.app/rows/issue/" + g.key;
    if (m[1].toUpperCase() !== g.key) return "card_ref ticket key must match group " + g.key;
    return null;
  }
  const m = /^https:\/\/github\.com\/ROWSHR\/([^/]+)\/pull\/(\d+)(?:\/|$|\?)/i.exec(url);
  if (!m) return "card_ref must be a GitHub URL of the form https://github.com/ROWSHR/<repo>/pull/<number>";
  if (m[2] !== g.number) return "card_ref PR number must match group";
  if (g.repo && g.repo.toLowerCase() !== m[1].toLowerCase()) return "card_ref repo must match group " + g.repo;
  return null;
}
function afterError(t) {
  if (typeof t !== "string" || !t.trim()) return "what_happens_after is required, in plain words";
  if (words(t).length < 4) return "what_happens_after needs at least 4 plain words";
  return null;
}
function optionsShapeError(d) {
  if (isSlackDraft(d)) return Array.isArray(d.options) && d.options.length ? "slack_draft cards use Send to Slack / Don't send, not options" : null;
  const freeText = d.allowCustom === true && (!Array.isArray(d.options) || d.options.length === 0);
  if (freeText) return null;
  if (isPerFindingReviewCard(d) && (!Array.isArray(d.options) || d.options.length === 0)) return null;
  if (!Array.isArray(d.options) || d.options.length < 2) return "need at least two options with unique ids (or a free-text card: allowCustom true and no options)";
  if (d.options.some((o) => o && (o.selected === true || o.preselected === true || o.default === true))) return "options must not be preselected";
  return null;
}
/** New-write / re-raise checks. Does not infer the author from the id prefix. */
function raiseShapeError(d, cmd) {
  if (!BOARD_BOTS.has(d.raised_by)) return cmd + ": --bot <Planner|QA|Engineer|dr eggbot|Grok Bot> is required (or set raised_by in the JSON). A re-raise may omit it only when the card already has a stored author.";
  const prefixes = prefixesFor(d.raised_by);
  if (!prefixes.some((p) => String(d.id || "").startsWith(p))) return cmd + ": id must start with " + BOT_ID_PREFIX[d.raised_by] + " when the author is " + d.raised_by;
  const slack = slackDraftError(d);
  if (slack) return cmd + ": " + slack;
  const after = afterError(d.what_happens_after);
  if (after) return cmd + ": " + after;
  const opts = optionsShapeError(d);
  if (opts) return cmd + ": " + opts;
  const gl = groupLinkError(d);
  if (gl) return cmd + ": " + gl;
  if (!isPriority(d.priority)) return cmd + ": priority is required and must be high, medium or low";
  return null;
}

function slackDraftFromFlags(rest, bot) {
  const usage = "usage: ab slack-draft --bot <Planner|QA|Engineer|dr eggbot|Grok Bot> --id <id> --channel-id C… --channel \"#name\" --text \"...\" --why \"...\" --group ROWS-1234 --card-ref <url> [--thread ts] [--thread-link url] [--title \"...\"] [--priority high|medium|low] [--text-file f]";
  const take = (name) => flag(rest, name);
  bot = bot ?? take("--bot");
  const id = take("--id");
  const channelId = take("--channel-id");
  const channel = take("--channel");
  const textFile = take("--text-file");
  let text = take("--text");
  const why = take("--why");
  const group = take("--group");
  const cardRef = take("--card-ref") ?? take("--link");
  const thread = take("--thread");
  const threadLink = take("--thread-link");
  const title = take("--title");
  const priority = take("--priority");
  if (textFile !== undefined) {
    if (text !== undefined) die(2, "slack-draft: use --text or --text-file, not both");
    try { text = fs.readFileSync(textFile, "utf8"); } catch { die(2, "slack-draft: cannot read --text-file " + textFile); }
  }
  if (!BOARD_BOTS.has(bot) || !id || !channelId || !channel || !text || !why || !group || !cardRef) die(2, "slack-draft: " + usage);
  const name = String(channel).trim();
  const d = {
    id, raised_by: bot, kind: "slack_draft",
    title: title?.trim() || ("Slack message to " + name).slice(0, 60),
    context: why,
    question: "Send this message to " + name + "?",
    what_happens_after: "If you send, " + bot + " posts this exact text to Slack once. If you don't, nothing is posted.",
    priority: priority ?? "medium",
    group, card_ref: cardRef, options: [],
    slack: { channel_id: channelId, channel: name, text, ...(thread !== undefined ? { thread_ts: thread } : {}), ...(threadLink !== undefined ? { permalink: threadLink } : {}) },
  };
  return d;
}

if (cmd === "raise" || cmd === "assistant" || cmd === "slack-draft") {
  const asAssistant = cmd === "assistant";
  const asSlack = cmd === "slack-draft";
  const cmdName = asAssistant ? "assistant" : asSlack ? "slack-draft" : "raise";
  const raisedByFlag = flag(args, "--bot");
  if (raisedByFlag !== undefined && !BOARD_BOTS.has(raisedByFlag)) die(2, cmdName + ": --bot must be Planner, QA, Engineer, dr eggbot or Grok Bot");
  const jsonInput = args[0] && String(args[0]).trim().startsWith("{");
  const d = asSlack && !jsonInput ? slackDraftFromFlags(args, raisedByFlag) : parseInput(input());
  if (!d || typeof d !== "object" || Array.isArray(d)) die(2, cmdName + ": input must be a JSON object");
  const link = d.link; delete d.link;                 // card-only field, not board schema
  if (link && !d.card_ref) d.card_ref = link;
  if (asAssistant) {
    if (d.section !== undefined && d.section !== "assistant") die(2, 'assistant: section must be "assistant"');
    d.section = "assistant";
  } else if (d.section !== undefined || d.rule !== undefined || d.seen !== undefined || d.proposed_fix !== undefined || d.bot !== undefined || d.fixes !== undefined) {
    die(2, cmdName + ": Dr. Assistant findings use ab assistant '<json>', not raise");
  }
  for (const k of Object.keys(d)) if (!ALLOWED.has(k)) die(2, "unknown field " + k + " (allowed: " + [...ALLOWED].join(", ") + ", link)");
  if (isSlackDraft(d) || asSlack) {
    d.kind = "slack_draft";
    if (d.slack && typeof d.slack === "object" && !Array.isArray(d.slack)) d.slack = normalizeSlack(d.slack);
  }
  if (raisedByFlag) d.raised_by = raisedByFlag;
  if (d.raised_by !== undefined && !BOARD_BOTS.has(d.raised_by)) die(2, cmdName + ": --bot / raised_by must be Planner, QA, Engineer, dr eggbot or Grok Bot");
  if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(d.id || "")) die(2, "id must be lowercase-kebab, 3-81 chars");
  if (d.options !== undefined && !Array.isArray(d.options)) die(2, "options must be an array when set");
  d.options = Array.isArray(d.options) ? d.options : [];
  const freeText = d.allowCustom === true && d.options.length === 0;
  if (asAssistant && !freeText && !isPerFindingReviewCard(d) && d.options.length < 2) die(2, "assistant: need at least two options (usual set: Apply it, Don't apply, Change it)");
  const ids = d.options.map((o) => o.id);
  if (d.options.length && (d.options.some((o) => !o.id || !o.label || ("post_text" in o && typeof o.post_text !== "string")) || new Set(ids).size !== ids.length || ids.includes("custom"))) die(2, "options need unique id+label (and string post_text when set); 'custom' is reserved");
  for (const k of ["multiSelect", "allowCustom", "pinned"]) if (k in d && typeof d[k] !== "boolean") die(2, k + " must be true or false");
  if ("details" in d) { const e = detailsError(d.details); if (e) die(2, e); }
  if ("priority" in d && !isPriority(d.priority)) die(2, "priority must be high, medium or low");
  if (asAssistant) {
    const e = assistantFieldError(d);
    if (e) die(2, "assistant: " + e);
    for (const k of ["rule", "seen", "proposed_fix", "bot"]) if (typeof d[k] === "string") d[k] = d[k].trim();
    if (d.fixes) d.fixes = d.fixes.map((f) => ({ id: f.id.trim(), seen: f.seen.trim(), proposed: f.proposed.trim() }));
  }
  const problems = storedProblems(d);
  if (problems.length) die(2, problems.join("\nab: "));
  for (const c of Array.isArray(d.post_comments) ? d.post_comments : []) applyQuietSwap(c);
  if (typeof d.post_text === "string") d.post_text = quietSwapText(d.post_text);
  for (const o of d.options) if (typeof o.post_text === "string") o.post_text = quietSwapText(o.post_text);
  applyCodeFences(d);
  const links = cardTicketLinkError(d);
  if (links) die(2, links);
  d.context = d.context.trim();
  const title = d.title.trim();
  lock();
  if (isCleared(d.id)) die(4, "refusing: " + d.id + " was cleared before; use a new id only for a genuinely new decision");
  const f = load();
  const prGroup = /^pr:([^/]+)\/(\d+)$/.exec(d.group || "");
  if (prGroup && Array.isArray(d.post_comments)) d.post_comments = carryDeclined(declinedForPr(f.b, prGroup[1], Number(prGroup[2])), d.post_comments).comments;
  const k = f.b.decisions.findIndex((x) => x.id === d.id);
  if (k < 0 && SQL && sql().prepare("SELECT 1 FROM archive_cards WHERE card_id = ?").get(d.id)) die(4, "refusing: " + d.id + " was answered and archived; use a new id only for a genuinely new decision");
  if (k >= 0 && f.b.decisions[k].answer) die(4, "refusing: " + d.id + " is already answered; never restore an answered decision");
  if (Array.isArray(d.post_comments)) carryPendingBot(k >= 0 ? f.b.decisions[k].post_comments : undefined, d.post_comments, findingNumber, new Date(), true);
  if (k >= 0 && !asAssistant && f.b.decisions[k].section === "assistant") die(2, "raise: " + d.id + " is a Dr. Assistant card; use ab assistant");
  if (k >= 0 && asAssistant && f.b.decisions[k].section !== "assistant") die(2, "assistant: " + d.id + " is already a Home decision; use a new id");
  d.card_ref = d.card_ref ?? null;
  if (typeof d.svg === "string") d.svg = sanitizeSvg(d.svg);
  if (!("raised_by" in d) && k >= 0 && f.b.decisions[k].raised_by) d.raised_by = f.b.decisions[k].raised_by;
  const shape = raiseShapeError(d, cmdName);
  if (shape) die(2, shape);
  // created_at and updated_at go last, side by side. New: updated_at = created_at. Re-raise: updated_at = now,
  // and the stored created_at wins over a passed one (a passed one only fills a card that has none).
  const created = (k >= 0 && f.b.decisions[k].created_at) || d.created_at || (k >= 0 ? undefined : new Date().toISOString());
  delete d.created_at;
  if (created) d.created_at = created;
  d.updated_at = k >= 0 ? new Date().toISOString() : created;
  // title goes first after id.
  const { id, title: _t, ...rest } = d;
  const stored = { id, title, ...rest };
  k >= 0 ? (f.b.decisions[k] = stored) : f.b.decisions.push(stored);
  if (isPushCard(stored) && stored.group && stored.sha) {
    for (const prev of f.b.decisions) {
      if (prev.id !== stored.id && !prev.answer && !prev.superseded_by && isPushCard(prev) && prev.group === stored.group && (!prev.sha || !sameSha(prev.sha, stored.sha))) {
        prev.superseded_by = stored.id;
        if (!prev.stale_reason) prev.stale_reason = "SHA moved to " + stored.sha.slice(0, 9);
      }
    }
  }
  save(f, f.b);
  const live = await waitServed((b) => b.decisions.some((x) => x.id === d.id && !x.answer && x.question === d.question));
  log({ op: asSlack ? "slack-draft" : asAssistant ? "assistant" : "raise", id: d.id, live });
  if (!live) die(3, "written to the board but the live board at " + URL_ + " does not serve it. Is the board server running (npm start)? Do NOT send the chat card until this passes.");
  console.log(JSON.stringify({ ok: true, board: "live", card: {
    title, context: d.context, question: d.question, ...(d.details ? { details: detailsText(d.details) } : {}), what_happens_after: d.what_happens_after,
    options: d.options.map((o) => o.label), multiSelect: !!d.multiSelect, allowCustom: d.allowCustom !== false,
    link: d.card_ref, decision_id: d.id, priority: priorityOf(d),
    ...(isSlackDraft(d) ? { kind: "slack_draft", slack: d.slack } : {}),
    ...(asAssistant ? { section: "assistant", bot: d.bot, rule: d.rule, ...(d.seen ? { seen: d.seen } : {}), ...(d.proposed_fix ? { proposed_fix: d.proposed_fix } : {}), ...(d.fixes ? { fixes: d.fixes } : {}) } : {}),
    footer: "Also on your Action Board: http://" + HOST + ":" + PORT + (asAssistant ? "/#assistant" : "") + " (" + d.id + ")" } }, null, 2));
} else if (cmd === "answer") {
  const by = flag(args, "--by"), at = flag(args, "--at") || new Date().toISOString(), custom = flag(args, "--custom");
  const action = flag(args, "--action");
  const sendText = flag(args, "--text");
  const id = args[0];
  if (!id || !["chat", "app"].includes(by)) die(2, "usage: ab answer <id> <opt[,opt]>|--custom text|--action send --text \"...\"|--action decline --by chat|app [--at ISO]");
  markRead("decision:" + id);
  lock(); const f = load(); const d = f.b.decisions.find((x) => x.id === id);
  if (!d) die(5, "no decision " + id + " on the board");
  if (d.answer) { console.log(JSON.stringify({ ok: true, status: "already-answered", answer: d.answer })); process.exit(0); }
  let a;
  if (action !== undefined) {
    if (action !== "send" && action !== "decline") die(2, "answer: --action must be send or decline");
    if (action === "send") {
      const t = (sendText ?? "").trim(); if (!t) die(2, "answer: --action send needs --text with the final message");
      a = { answer: "send", answer_label: "Send to Slack", answered_by: by, answered_at: at, action: "send", text: t };
    } else {
      a = { answer: "decline", answer_label: "Don't send", answered_by: by, answered_at: at, action: "decline" };
    }
  } else if (custom !== undefined) { const t = custom.trim(); if (!t) die(2, "blank custom text"); a = { answer: "custom", answer_label: t, answered_by: by, answered_at: at, custom_text: t }; }
  else {
    const pick = (args[1] || "").split(",").filter(Boolean); if (!pick.length) die(2, "need an option id");
    for (const x of pick) if (!d.options.some((o) => o.id === x)) die(2, "unknown option " + x);
    if (pick.length > 1 && !d.multiSelect) die(2, id + " is single-select");
    const p = d.options.filter((o) => pick.includes(o.id));
    a = d.multiSelect ? { answer: p.map((o) => o.id), answer_label: p.map((o) => o.label), answered_by: by, answered_at: at } : { answer: p[0].id, answer_label: p[0].label, answered_by: by, answered_at: at };
  }
  d.updated_at = new Date().toISOString(); d.answer = a; save(f, f.b);
  const live = await waitServed((b) => b.decisions.some((x) => x.id === id && x.answer));
  log({ op: "answer", id, by, live });
  console.log(JSON.stringify({ ok: true, status: "answered", live, answer: a }));
} else if (cmd === "clear") {
  const reason = flag(args, "--reason"); const id = args[0];
  if (!id || !reason) die(2, "usage: ab clear <id> --reason \"why\"");
  lock(); const f = load(); const card = f.b.decisions.find((x) => x.id === id);
  if (!card) die(5, "no decision " + id);
  f.b.decisions = f.b.decisions.filter((x) => x.id !== id);
  save(f, f.b);
  // The tombstone keeps the removed card as it was, so ab restore can bring it back.
  addTomb({ id, reason, at: new Date().toISOString(), card });
  log({ op: "clear", id });
  console.log(JSON.stringify({ ok: true, status: "cleared", id }));
} else if (cmd === "restore") {
  const id = args[0];
  if (!id || args.length !== 1) die(2, "usage: ab restore <id>");
  lock(); const f = load();
  if (f.b.decisions.some((x) => x.id === id)) die(4, id + " is already on the board");
  const t = lastTomb(id);
  if (!t || t.restored) die(5, "nothing to restore for " + id);
  if (!t.card || typeof t.card !== "object") die(4, id + " was cleared without a saved card; it cannot be restored");
  // Back at the end and open again; every other field (priority, created_at, updated_at) as it was saved.
  const { answer, ...card } = t.card;
  f.b.decisions.push(card); save(f, f.b);
  addTomb({ id, restored: true, at: new Date().toISOString() });
  await waitServed((b) => b.decisions.some((x) => x.id === id));
  log({ op: "restore", id });
  console.log(JSON.stringify({ ok: true, status: "restored", id }));
} else if (cmd === "priority") {
  const [id, level] = args;
  if (!id || !isPriority(level) || args.length !== 2) die(2, "usage: ab priority <id> <high|medium|low>");
  lock(); const f = load(); const d = f.b.decisions.find((x) => x.id === id);
  if (!d) die(5, "no decision " + id + " on the board");
  if (d.answer) die(4, id + " is already answered");
  const was = priorityOf(d);
  // Only this card's priority changes; its updated_at stays (save() moves the board's own updated_at).
  d.priority = level; save(f, f.b);
  const live = await waitServed((b) => b.decisions.some((x) => x.id === id && x.priority === level));
  log({ op: "priority", id, priority: level });
  console.log(JSON.stringify({ ok: true, id, priority: level, was, live }));
} else if (cmd === "glance") {
  const g = parseInput(fs.readFileSync(0, "utf8"));
  if (!g || typeof g !== "object" || Array.isArray(g)) die(2, "glance: input must be a JSON object");
  for (const k of ["waiting", "tickets"]) if (!Array.isArray(g[k])) die(2, "glance." + k + " must be an array");
  if ("parked" in g && !Array.isArray(g.parked)) die(2, "glance.parked must be an array");
  if (g.parked?.length) die(2, "glance.parked is retired: raise those as decisions with \"ab raise\" instead");
  // others: someone else's PR involving the user. Missing means []; each item is exactly {title, author, who, link}.
  const others = g.others ?? [];
  if (!Array.isArray(others)) die(2, "glance.others must be an array");
  const OTHER_KEYS = ["title", "author", "who", "link"];
  others.forEach((o, n) => {
    const at = "glance.others[" + n + "]";
    if (!o || typeof o !== "object" || Array.isArray(o)) die(2, at + " must be an object {title, author, who, link}");
    for (const k of Object.keys(o)) if (!OTHER_KEYS.includes(k)) die(2, at + " has unknown key " + k);
    for (const k of OTHER_KEYS) if (typeof o[k] !== "string" || !o[k].trim()) die(2, at + "." + k + " must be a non-blank string");
    if (!/^https?:\/\//.test(o.link)) die(2, at + ".link must start with http:// or https://");
  });
  lock(); const f = load(); f.b.glance = { waiting: g.waiting, tickets: g.tickets, others, ...(Array.isArray(f.b.glance?.mine) ? { mine: f.b.glance.mine } : {}) };
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "glance", live });
  console.log(JSON.stringify({ ok: true, live, counts: { waiting: g.waiting.length, tickets: g.tickets.length, others: others.length } }));
} else if (cmd === "mypr") {
  // My PRs: replaces glance.mine with the user's own open PRs.
  const raw = args[0] === undefined || args[0] === "-" ? fs.readFileSync(0, "utf8") : args[0];
  const list = parseInput(raw);
  if (!Array.isArray(list)) die(2, "mypr: input must be a JSON array of {repo, number, title, link, state, ci?, reviews?}");
  const KEYS = ["repo", "number", "title", "link", "state", "ci", "reviews"];
  list.forEach((p, n) => {
    const at = "mypr[" + n + "]";
    if (!p || typeof p !== "object" || Array.isArray(p)) die(2, at + " must be an object");
    for (const k of Object.keys(p)) if (!KEYS.includes(k)) die(2, at + " has unknown key " + k);
    for (const k of ["repo", "title", "link"]) if (!nonBlank(p[k])) die(2, at + "." + k + " must be a non-blank string");
    if (!isHttp(p.link)) die(2, at + ".link must start with http:// or https://");
    if (!Number.isInteger(p.number) || p.number < 1) die(2, at + ".number must be a positive integer");
    if (!MYPR_STATES.includes(p.state)) die(2, at + ".state must be one of " + MYPR_STATES.join(", "));
    if ("ci" in p && !MYPR_CI.includes(p.ci)) die(2, at + ".ci must be one of " + MYPR_CI.join(", "));
    if ("reviews" in p && (!Number.isInteger(p.reviews) || p.reviews < 0)) die(2, at + ".reviews must be a non-negative integer");
  });
  const got = ghEnabled() && !args.includes("--no-gh") ? ghCollect({ glance: { mine: list } }, { others: false, posted: false }) : null;
  lock(); const f = load(); f.b.glance = { ...f.b.glance, mine: list };
  const gh = got ? ghApply(f.b, got) : null;
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "mypr", count: list.length, live, gh: !!gh });
  console.log(JSON.stringify({ ok: true, live, count: list.length, ...(gh ? { gh } : {}) }));
} else if (cmd === "reviews") {
  // Drafted reviews: upserts each draft by repo + pr (--replace replaces the whole list).
  const replace = args.includes("--replace"); const rest = args.filter((a) => a !== "--replace");
  const raw = rest[0] === undefined || rest[0] === "-" ? fs.readFileSync(0, "utf8") : rest[0];
  const list = parseInput(raw);
  if (!Array.isArray(list)) die(2, "reviews: input must be a JSON array of {repo, pr, verdict, notes?, done?, comments:[...]}");
  list.forEach((d, n) => {
    const at = "reviews[" + n + "]";
    if (!d || typeof d !== "object" || Array.isArray(d)) die(2, at + " must be an object");
    for (const k of Object.keys(d)) if (!["repo", "pr", "verdict", "notes", "done", "comments"].includes(k)) die(2, at + " has unknown key " + k);
    if (!nonBlank(d.repo)) die(2, at + ".repo must be a non-blank string like app");
    if (!Number.isInteger(d.pr) || d.pr < 1) die(2, at + ".pr must be a positive integer");
    if (!nonBlank(d.verdict)) die(2, at + ".verdict must be a non-blank string");
    if ("notes" in d && typeof d.notes !== "string") die(2, at + ".notes must be a string");
    if ("done" in d && typeof d.done !== "boolean") die(2, at + ".done must be true or false");
    if (!Array.isArray(d.comments)) die(2, at + ".comments must be an array");
    const ids = new Set();
    d.comments.forEach((c, m) => {
      const ct = at + ".comments[" + m + "]";
      if (!c || typeof c !== "object" || Array.isArray(c)) die(2, ct + " must be an object");
      for (const k of Object.keys(c)) if (!["id", "severity", "title", "path", "line", "body", "status", "url", "note"].includes(k)) die(2, ct + " has unknown key " + k);
      if (typeof c.id !== "string" || !/^[\w.-]{1,40}$/.test(c.id) || c.id === "pr") die(2, ct + ".id must be a short id like c1 (not \"pr\")");
      if (ids.has(c.id)) die(2, ct + ".id " + c.id + " is a duplicate"); ids.add(c.id);
      if (!REVIEW_SEVERITIES.includes(c.severity)) die(2, ct + ".severity must be one of " + REVIEW_SEVERITIES.join(", "));
      if (!nonBlank(c.path) || !nonBlank(c.body)) die(2, ct + ".path and .body must be non-blank strings");
      if (!(c.line === null || (Number.isInteger(c.line) && c.line > 0))) die(2, ct + ".line must be a positive integer or null");
      if ("title" in c && typeof c.title !== "string") die(2, ct + ".title must be a string");
      if ("url" in c && !isHttp(c.url)) die(2, ct + ".url must start with http:// or https://");
      if ("note" in c && typeof c.note !== "string") die(2, ct + ".note must be a string");
      if (!REVIEW_STATUSES.includes(c.status)) die(2, ct + ".status must be one of " + REVIEW_STATUSES.join(", "));
      // Bodies are raw Markdown: store `->`, never `-&gt;`.
      c.body = decodeEntities(c.body).replace(/^(\s*)```suggestions\b/gm, "$1```suggestion");
      if (typeof c.title === "string") c.title = decodeEntities(c.title);
      applyQuietSwap(c);
    });
  });
  lock(); const f = load();
  // A finding Eric already skipped on this PR comes back skipped, never open (see src/declined.ts).
  for (const d of list) {
    const prev = (Array.isArray(f.b.reviews) ? f.b.reviews : []).find((r) => r.repo === d.repo && r.pr === d.pr);
    const known = declinedOf(prev);
    d.comments = carryDeclined(known, d.comments).comments;
    carryPendingBot(prev?.comments, d.comments, (c) => c.id, new Date(), true);
    const all = declinedOf({ declined: known, comments: d.comments });
    if (all.length) d.declined = all;
  }
  const keep = replace ? [] : (Array.isArray(f.b.reviews) ? f.b.reviews : []).filter((r) => !list.some((d) => d.repo === r.repo && d.pr === r.pr));
  f.b.reviews = [...keep, ...list];
  if (ghEnabled() && !args.includes("--no-gh")) { unlock(); const got = ghCollect(f.b, { mine: false }); lock(); const g = load(); g.b.reviews = f.b.reviews; ghApply(g.b, got); Object.assign(f, g); }
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "reviews", count: list.length, replace, live });
  console.log(JSON.stringify({ ok: true, live, set: list.map((d) => d.repo + "#" + d.pr), total: f.b.reviews.length }));
} else if (cmd === "gh-refresh") {
  // ab gh-refresh: the whole GitHub refresh (CI failures, change requests, Ready to approve, deleted comments).
  // Prints needs_brief: My PRs whose change requests have no up-to-date plain-words brief yet.
  if (!ghEnabled()) die(2, "gh-refresh: gh is disabled (AB_NO_GH or AB_NO_SERVER)");
  const got = ghCollect(load().b);
  lock(); const f = load(); const gh = ghApply(f.b, got);
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "gh-refresh", ci: gh.ci.length, changes: gh.changes.length, errors: gh.errors.length });
  console.log(JSON.stringify({ ok: true, live, ...gh }));
} else if (cmd === "review-status") {
  // ab review-status <repo>#<pr> <comment-id> <pending|posted|skipped> [--url <posted comment>] [--note "why"]
  //   [--answer-to-question "text"] [--body "revised will-post text"]
  //   or   ab review-status <repo>#<pr> <comment-id> --answer-to-question "text" [--body "text"]
  //   or   ab review-status <repo>#<pr> --done [--undone]
  // comment-id is a drafted-review id (c1) or a per-comment ops card finding number (1, #1, f1).
  const urlFlag = flag(args, "--url"), noteFlag = flag(args, "--note");
  const answerQFlag = flag(args, "--answer-to-question"), bodyFlag = flag(args, "--body");
  if (urlFlag !== undefined && !isHttp(urlFlag)) die(2, "review-status: --url must start with http:// or https://");
  if (bodyFlag !== undefined && !nonBlank(bodyFlag)) die(2, "review-status: --body must be the revised Will post text");
  if (answerQFlag !== undefined && !nonBlank(answerQFlag)) die(2, "review-status: --answer-to-question must be the reply to show on the card");
  const done = args.includes("--done"), undone = args.includes("--undone"); const rest = args.filter((a) => a !== "--done" && a !== "--undone");
  const m = /^([\w.-]+)#(\d+)$/.exec(rest[0] ?? "");
  const hasRewrite = answerQFlag !== undefined || bodyFlag !== undefined;
  const hasStatus = rest.length === 3 && REVIEW_STATUSES.includes(rest[2]);
  const rewriteOnly = rest.length === 2 && hasRewrite;
  if (!m || (!done && !undone && !hasStatus && !rewriteOnly)) die(2, "review-status: usage: ab review-status <repo>#<pr> <comment-id> <pending|posted|skipped> [--url <github link>] [--note \"why\"] [--answer-to-question \"text\"] [--body \"revised will-post text\"] | ab review-status <repo>#<pr> <comment-id> --answer-to-question \"text\" [--body \"text\"] | ab review-status <repo>#<pr> --done|--undone");
  lock(); const f = load();
  const drafted = (f.b.reviews ?? []).find((r) => r.repo === m[1] && r.pr === Number(m[2]));
  const cards = perFindingCardsForPr(f.b, m[1], Number(m[2]));
  if (!drafted && cards.length === 0) die(5, "review-status: no drafted review or per-comment review card for " + rest[0]);
  if (done || undone) {
    if (!drafted) die(2, "review-status: --done/--undone is for drafted reviews on the Reviews tab");
    drafted.done = done;
  } else {
    const id = rest[1], status = hasStatus ? rest[2] : undefined;
    let hit = false;
    if (drafted) {
      const c = drafted.comments.find((x) => x.id === id);
      if (c) {
        if (status !== undefined) { c.status = status; delete c.pending_bot; }
        // A rewrite answers his note: --body replaces the draft, and either flag takes it off QA's plate.
        if (bodyFlag !== undefined) c.body = quietSwapText(bodyFlag.trim());
        if (answerQFlag !== undefined) c.answer_to_question = answerQFlag.trim();
        if (hasRewrite) { delete c.pending_bot; c.revision_at = new Date().toISOString(); }
        if (urlFlag !== undefined) c.url = urlFlag;
        if (noteFlag !== undefined) { if (noteFlag.trim()) c.note = noteFlag.trim(); else delete c.note; }
        hit = true;
      }
    }
    const findings = [];
    for (const card of cards) {
      const c = findingOnCard(card, id);
      if (!c) continue;
      findings.push({ card, c });
    }
    if (!hit && findings.length === 0) die(5, "review-status: " + rest[0] + " has no comment " + id);
    if (status === "posted" && !hit && findings.length && urlFlag === undefined) die(2, "review-status: posted needs --url <github comment or review link>");
    const out = [];
    for (const { card, c } of findings) {
      if (status !== undefined || answerQFlag !== undefined || bodyFlag !== undefined) delete c.pending_bot;
      if (status !== undefined) c.status = status;
      if (urlFlag !== undefined) c.posted_url = urlFlag;
      if (noteFlag !== undefined) { if (noteFlag.trim()) c.note = noteFlag.trim(); else delete c.note; }
      if (answerQFlag !== undefined) c.answer_to_question = answerQFlag.trim();
      if (bodyFlag !== undefined) c.body = quietSwapText(bodyFlag.trim());
      if (answerQFlag !== undefined || bodyFlag !== undefined) c.revision_at = new Date().toISOString();
      hit = true;
      out.push({ card: card.id, n: c.n ?? id, ...(c.status ? { status: c.status } : {}), ...(c.posted_url ? { posted_url: c.posted_url } : {}), ...(c.note ? { note: c.note } : {}), ...(c.answer_to_question ? { answer_to_question: c.answer_to_question } : {}) });
    }
    const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
    log({ op: "review-status", pr: rest[0], comment: id, status });
    console.log(JSON.stringify({
      ok: true, live, pr: rest[0],
      ...(drafted ? { done: drafted.done ?? false, comments: drafted.comments.map((c) => ({ id: c.id, status: c.status })) } : {}),
      ...(out.length ? { findings: out } : {}),
    }));
  }
  if (done || undone) {
    const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
    log({ op: "review-status", pr: rest[0], comment: rest[1] ?? null, status: done ? "done" : "undone" });
    console.log(JSON.stringify({ ok: true, live, pr: rest[0], done: drafted.done ?? false, comments: drafted.comments.map((c) => ({ id: c.id, status: c.status })) }));
  }
} else if (cmd === "detail") {
  // ab detail <key> '<json>' | ab detail <key> [-] < detail.json   merges {summary?, plan?, discussion?, actions?, questions?}
  // ab detail <key> --clear                                          removes the item's detail
  const key = detailKeyOf(args[0]);
  if (!key) die(2, "detail: usage: ab detail <key> [json|-] | ab detail <key> --clear (key like ticket:PROJ-2512, pr:app/209, mypr:app/209, waiting:<slug>, decision:<id>, page:tickets)");
  lock(); const f = load(); const all = f.b.details && typeof f.b.details === "object" ? f.b.details : {};
  if (args[1] === "--clear") { delete all[key]; }
  else {
    const raw = args[1] === undefined || args[1] === "-" ? fs.readFileSync(0, "utf8") : args[1];
    const d = parseInput(raw);
    const err = detailError(d); if (err) die(2, "detail: " + err);
    all[key] = { ...(all[key] ?? {}), ...d, updated_at: new Date().toISOString() };
  }
  f.b.details = all;
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "detail", key, cleared: args[1] === "--clear" });
  console.log(JSON.stringify({ ok: true, live, key, fields: all[key] ? Object.keys(all[key]) : [] }));
} else if (cmd === "ticket") {
  // ab ticket <key> <ticket.md> --plain "text" | --plain-file <f.md>: the full ticket plus a short plain-words
  // summary, shown above the questions and plan. Every ticket or plan-question item that asks the user something needs it.
  const plainText = flag(args, "--plain"); const plainFile = flag(args, "--plain-file");
  const rest = args.filter((a, i) => !["--plain", "--plain-file"].includes(a) && !["--plain", "--plain-file"].includes(args[i - 1]));
  const key = detailKeyOf(rest[0]);
  if (!key || !rest[1]) die(2, 'ticket: usage: ab ticket <key> <ticket.md> --plain "text" | --plain-file <f.md>');
  if (!fs.existsSync(rest[1])) die(2, "ticket: file not found: " + rest[1]);
  const text = fs.readFileSync(rest[1], "utf8");
  if (!text.trim()) die(2, "ticket: file is empty: " + rest[1]);
  if (plainFile !== undefined && !fs.existsSync(plainFile)) die(2, "ticket: file not found: " + plainFile);
  const plain = (plainFile !== undefined ? fs.readFileSync(plainFile, "utf8") : plainText ?? "").trim();
  if (!plain) die(2, 'ticket: an "In plain words" summary is required (--plain "text" or --plain-file <f.md>)');
  lock(); const f = load(); const all = f.b.details && typeof f.b.details === "object" ? f.b.details : {};
  all[key] = { ...(all[key] ?? {}), ticket: text, ticket_file: path.basename(rest[1]), plain, updated_at: new Date().toISOString() };
  f.b.details = all;
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "ticket", key, file: path.basename(rest[1]) });
  console.log(JSON.stringify({ ok: true, live, key, chars: text.length, plain: plain.length }));
} else if (cmd === "ask") {
  // ab ask '<json>' | ab ask - < payload.json: records what the owner'sent (a webhook payload: item.message,
  // decision.answered, decision.clarify, decision.not_relevant, review.answer; or a ready ask) in board.asks, so the
  // Conversation view shows it from any browser. Same id twice is a no-op. The /__ab/webhook forwarder calls this.
  const raw = args[0] === undefined || args[0] === "-" ? fs.readFileSync(0, "utf8") : args[0];
  let p; try { p = JSON.parse(raw); } catch { die(2, "ask: input must be JSON"); }
  lock(); const f = load();
  const a = askOf(p, f.b); if (!a || !nonBlank(a.at)) die(2, "ask: not an ask or a known webhook payload");
  const asks = Array.isArray(f.b.asks) ? f.b.asks : [];
  // A card answer is stored on the card here, in the same write that records the ask, so the answer survives a refresh,
  // another browser and a bot re-raise. A browser re-sending an answer the board already has heals a card that missed it.
  const noted = markNotePending(f.b, p);
  const settled = settleDecision(f.b.decisions?.find((x) => x.id === p.decision_id), p) || noted;
  if (asks.some((x) => x.id === a.id)) {
    if (settled) { save(f, f.b); log({ op: noted ? "note-pending" : "answer", id: p.decision_id, by: "app", healed: true }); }
    console.log(JSON.stringify({ ok: true, live: false, id: a.id, duplicate: true, settled })); process.exit(0);
  }
  // After ab wipe, a browser re-sending its old local history must not bring it back.
  if (f.b.reset_at && a.at <= f.b.reset_at) { console.log(JSON.stringify({ ok: true, live: false, id: a.id, before_reset: true })); process.exit(0); }
  if (settled && !noted) { const d = f.b.decisions.find((x) => x.id === p.decision_id); d.updated_at = new Date().toISOString(); }
  f.b.asks = [...asks, a].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0)).slice(-1000);
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "ask", id: a.id, key: a.item_key, kind: a.kind, settled });
  console.log(JSON.stringify({ ok: true, live, id: a.id, key: a.item_key, kind: a.kind, settled }));
} else if (cmd === "heal-answers") {
  // ab heal-answers: closes every card he answered that the board never marked answered (an answer ask exists, the card
  // has no answer, and the answer came after the card's latest revision) and parks findings whose last word from him is a
  // note (pending_bot). Safe to rerun. -> {"ok","healed":[ids],"parked":[findings]}
  lock(); const f = load();
  const healed = healAnswers(f.b);
  const parked = healNotes(f.b);
  if (healed.length || parked.length) save(f, f.b);
  log({ op: "heal-answers", count: healed.length, parked: parked.length });
  console.log(JSON.stringify({ ok: true, healed, parked }));
} else if (cmd === "reply") {
  // ab reply <item> "text" [--image path] [--alt "text"] [--question "q" --option "Label" ...]: appends a Assistant reply
  // (Markdown, links) to the item's thread with a timestamp. This is how to answer the owner on the board. The image is copied
  // into app/public/replies/. A question shows its options as one-click answers that go to the webhook as item.message.
  // The item moves to Needs you with an unread dot until the owner opens it. <item> is a detail key (pr:app/203,
  // mypr:app/209, ticket:PROJ-2512, decision:<id>), a bare ticket key, or repo#N / #N for a PR.
  // ab reply <item> --at <iso> "text": replaces the text of the existing reply with that timestamp (other fields stay).
  const image = flag(args, "--image"); const alt = flag(args, "--alt"); const question = flag(args, "--question"); const status = flag(args, "--status");
  const qContext = flag(args, "--context"); const svg = flag(args, "--svg"); const suggestion = flag(args, "--suggestion");
  const answersCommentFlag = flag(args, "--answers-comment"); const postTextFlag = flag(args, "--post-text");
  const noPostTextFlag = args.includes("--no-post-text");
  if (noPostTextFlag) args.splice(args.indexOf("--no-post-text"), 1);
  if (postTextFlag !== undefined && noPostTextFlag) die(2, "reply: use --post-text or --no-post-text, not both");
  const atFlag = flag(args, "--at");
  if (status !== undefined && !STATUS_RE.test(status)) die(2, "reply: --status must be working, done, passed:assistant, passed:ops or waiting:<who>");
  const options = []; for (let o; (o = flag(args, "--option")) !== undefined; ) options.push(o);
  const [target, text] = args;
  if (text !== undefined && (!nonBlank(text) || text.trimStart().startsWith("--"))) die(2, 'reply: the text must not be empty or start with "--" (a mistyped flag such as --text would be posted as the reply). Pass the reply as the second argument: ab reply <item> "text"');
  if (!nonBlank(target) || (!nonBlank(text) && status === undefined && atFlag === undefined)) die(2, 'reply: usage: ab reply <item> "text" [--image path] [--alt "text"] [--svg file.svg] [--question "q" --context "short paragraph" --option "Label" ...] [--supersedes id,...] [--status working|done|passed:assistant|passed:ops|waiting:<who>] (text is optional with --status); or ab reply <item> --at <iso> "text" to replace an existing reply\'s text');
  if (question !== undefined && (!nonBlank(question) || options.length < 2 || !options.every(nonBlank))) die(2, "reply: --question needs text and at least two --option values");
  if (question === undefined && options.length) die(2, "reply: --option needs --question");
  if (question !== undefined) { const e = contextParaError(qContext); if (e) die(2, "reply: --question " + e); }
  if (question === undefined && qContext !== undefined) die(2, "reply: --context goes with --question");
  if (question === undefined && (answersCommentFlag !== undefined || postTextFlag !== undefined || noPostTextFlag)) die(2, "reply: --answers-comment / --post-text / --no-post-text go with --question");
  let parsedAnswersComment;
  if (answersCommentFlag !== undefined) {
    try { parsedAnswersComment = JSON.parse(answersCommentFlag === "-" ? fs.readFileSync(0, "utf8") : answersCommentFlag); }
    catch (e) { die(2, "reply: --answers-comment is not valid JSON (" + e.message + ")"); }
  }
  const parsedPostText = noPostTextFlag ? null : postTextFlag;
  if (question === undefined && suggestion !== undefined) die(2, "reply: --suggestion goes with --question");
  if (svg !== undefined && image !== undefined) die(2, "reply: use --image or --svg, not both");
  if (svg !== undefined && (!fs.existsSync(svg) || !/\.svg$/i.test(svg))) die(2, "reply: --svg needs an .svg file: " + svg);
  const cleanSvg = svg !== undefined ? sanitizeSvg(fs.readFileSync(svg, "utf8")) : undefined;
  if (svg !== undefined && !cleanSvg) die(2, "reply: not an SVG: " + svg);
  const supersedes = flag(args, "--supersedes");
  if (supersedes !== undefined && (question === undefined || !nonBlank(supersedes))) die(2, "reply: --supersedes <question-id,...> needs --question");
  const bulk = bulkProblems(options.map((label) => ({ label })));
  if (bulk.length) die(2, "reply: " + bulk[0]);
  if (image !== undefined && !fs.existsSync(image)) die(2, "reply: image not found: " + image);
  if (image !== undefined && !/\.(png|jpe?g|gif|webp|svg)$/i.test(image)) die(2, "reply: image must be png, jpg, gif, webp or svg");
  lock(); const f = load();
  let key = detailKeyOf(target);
  const pr = /^(?:([\w.-]+)#|#)(\d+)$/.exec(target);
  if (pr) {
    const n = Number(pr[2]); const repo = pr[1];
    const mine = (f.b.glance?.mine ?? []).find((m) => m.number === n && (!repo || m.repo === repo));
    const other = (f.b.glance?.others ?? []).find((o) => new RegExp(`/${repo ? repo.replace(/[.]/g, "\\.") : "[\\w.-]+"}/pull/${n}(?:$|[/?#])`).test(o.link ?? ""));
    if (mine) key = `mypr:${mine.repo}/${n}`;
    else if (other) key = `pr:${/\/([\w.-]+)\/pull\//.exec(other.link)[1]}/${n}`;
    else die(2, "reply: no PR " + target + " on the board");
  }
  if (!key) die(2, "reply: bad item " + target);
  if (atFlag !== undefined) {
    if (!nonBlank(atFlag) || Number.isNaN(Date.parse(atFlag))) die(2, "reply: --at must be an ISO timestamp of an existing reply");
    if (question !== undefined || image !== undefined || svg !== undefined || suggestion !== undefined || qContext !== undefined || supersedes !== undefined || status !== undefined || options.length) die(2, "reply: --at only updates the reply text");
    if (!nonBlank(text)) die(2, 'reply: usage: ab reply <item> --at <iso> "text"');
    const all = f.b.details && typeof f.b.details === "object" ? f.b.details : {};
    const prior = all[key]?.thread ?? [];
    const entry = prior.find((t) => t.at === atFlag);
    if (!entry) die(2, `reply: no reply at ${atFlag} on ${key}`);
    entry.text = text.trim();
    const updated = new Date().toISOString();
    all[key] = { ...(all[key] ?? {}), thread: prior, updated_at: updated };
    f.b.details = all;
    const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
    log({ op: "reply", key, at: atFlag, edited: true });
    console.log(JSON.stringify({ ok: true, live, key, at: atFlag, edited: true, replies: all[key].thread.length }));
  } else {
  const at = new Date().toISOString();
  markRead(key);
  const entry = { at, from: "bot", text: (text ?? "").trim() };
  if (status !== undefined) entry.status = status;
  if (image !== undefined) {
    const dir = REPLIES_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const name = `${key.replace(/[^\w.-]+/g, "-")}-${Date.now()}${path.extname(image).toLowerCase()}`;
    fs.copyFileSync(image, path.join(dir, name));
    entry.image = "/replies/" + name;
    if (nonBlank(alt)) entry.image_alt = alt;
  }
  if (cleanSvg) {
    const dir = REPLIES_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const name = `${key.replace(/[^\w.-]+/g, "-")}-${Date.now()}.svg`;
    fs.writeFileSync(path.join(dir, name), cleanSvg);
    entry.image = "/replies/" + name;
    if (nonBlank(alt)) entry.image_alt = alt;
  }
  if (question !== undefined) {
    const qslug = question.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    entry.question = {
      id: `${qslug}-${Date.now().toString(36)}`,
      text: question.trim(),
      context: qContext.trim(),
      ...(nonBlank(suggestion) ? { suggestion: suggestion.trim() } : {}),
      ...(parsedAnswersComment !== undefined ? { answers_comment: parsedAnswersComment } : {}),
      ...(parsedPostText !== undefined ? { post_text: parsedPostText } : {}),
      options: options.map((o, i) => ({ id: "o" + (i + 1), label: o.trim() })),
    };
    const paErr = postApprovalError({ ...entry.question, group: key });
    if (paErr) die(2, "reply: " + paErr);
  }
  const all = f.b.details && typeof f.b.details === "object" ? f.b.details : {};
  const prior = all[key]?.thread ?? [];
  for (const id of supersedes ? supersedes.split(",").map((x) => x.trim()).filter(Boolean) : []) {
    const old = prior.find((t) => t.question?.id === id);
    if (!old) die(2, `reply: no question ${id} on ${key}`);
    old.question.superseded_by = entry.question.id;
  }
  if (entry.question && !supersedes) {
    const qLbl = (s) => /^(?:[A-Z]+-\d+\s+)?(Q\d+[a-z]?)\b\s*(?:[:.=]|$)/i.exec(String(s || "").trim())?.[1]?.toUpperCase();
    const normQ = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
    const answeredIds = new Set((f.b.asks ?? []).filter((a) => a.item_key === key && a.reply_to).map((a) => a.reply_to));
    const newLbl = qLbl(entry.question.text);
    for (const prev of prior) {
      const pq = prev.question;
      if (!pq || pq.superseded_by || answeredIds.has(pq.id)) continue;
      if (key.startsWith("decision:") || (newLbl && qLbl(pq.text) === newLbl) || normQ(pq.text) === normQ(entry.question.text)) {
        pq.superseded_by = entry.question.id;
      }
    }
  }
  all[key] = { ...(all[key] ?? {}), thread: [...prior, entry], updated_at: at };
  f.b.details = all;
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "reply", key, image: entry.image, question: entry.question?.id });
  console.log(JSON.stringify({ ok: true, live, key, at, replies: all[key].thread.length, image: entry.image, question: entry.question?.id }));
  }
} else if (cmd === "notify") {
  // ab notify --bot <name> --text "..." [--next "1:15 PM ET"] [--link url]: a status note on the Notifications tab.
  // Acknowledging it never wakes a bot. Short Markdown. Storage mode only.
  const bot = flag(args, "--bot");
  const text = flag(args, "--text");
  const next = flag(args, "--next");
  const link = flag(args, "--link");
  if (!BOARD_BOTS.has(bot)) die(2, "notify: usage: ab notify --bot <Planner|QA|Engineer|dr eggbot|Grok Bot> --text \"...\" [--next \"1:15 PM ET\"] [--link url]");
  let body = typeof text === "string" ? text.trim() : "";
  if (!body) die(2, "notify: --text is required");
  body = fenceBareCode(body);
  if (body.length > 800) die(2, "notify: --text is too long (800 characters or fewer)");
  const notifyLinks = ticketLinkError(body, "notify");
  if (notifyLinks) die(2, notifyLinks);
  if (next !== undefined && !nonBlank(next)) die(2, "notify: --next, if given, cannot be blank");
  if (link !== undefined && !isHttp(link)) die(2, "notify: --link must be an http(s) URL");
  if (!SQL) die(2, "notify: needs the SQLite board (unset AB_FILE)");
  const at = new Date().toISOString();
  const r = sql().prepare("INSERT INTO ui_notifications (bot, text, next_update, link, created_at) VALUES (?, ?, ?, ?, ?)").run(bot, body, next === undefined ? null : next.trim(), link ?? null, at);
  console.log(JSON.stringify({ ok: true, id: Number(r.lastInsertRowid), bot, text: body, next_update: next === undefined ? null : next.trim(), link: link ?? null, created_at: at }));
} else if (cmd === "read") {
  if (!nonBlank(args[0]) || /\s/.test(args[0])) die(2, "usage: ab read <decision id | item key>");
  const key = detailKeyOf(args[0]) ?? "decision:" + args[0];
  markRead(key);
  console.log(JSON.stringify({ ok: true, key, read: SQL }));
} else if (cmd === "wipe") {
  // ab wipe --yes: empties the board (cards, items, PRs, reviews, details, threads, asks) and sets reset_at, so asks
  // older than the wipe are ignored when a browser re-syncs. Keeps ticket_summaries. Back up board.ts first.
  if (!args.includes("--yes")) die(2, "wipe: usage: ab wipe --yes (back up app/src/data/board.ts first)");
  lock(); const f = load();
  const at = new Date().toISOString();
  f.b = { updated_at: f.b.updated_at, reset_at: at, decisions: [], glance: { waiting: [], tickets: [], others: [], mine: [] }, reviews: [], details: {}, asks: [], ticket_summaries: f.b.ticket_summaries ?? {} };
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "wipe", at });
  console.log(JSON.stringify({ ok: true, live, reset_at: at }));
} else if (cmd === "already-answered") {
  // ab already-answered <item> <Qid> (--quote "his earlier words" --source "where" | --superseded-by "what replaces it")
  //   [--no-note]: marks a plan question as answered with the owner's own earlier words (or replaced by another question),
  // so the board never asks it again, and adds a one-line note on the item: You already answered this: "...".
  const quote = flag(args, "--quote"); const source = flag(args, "--source"); const sup = flag(args, "--superseded-by");
  const noNote = args.includes("--no-note"); const rest = args.filter((a) => a !== "--no-note");
  const [target, qid] = rest;
  const key = detailKeyOf(target ?? "");
  if (!key || !nonBlank(qid) || (quote === undefined) === (sup === undefined) || (quote !== undefined && (!nonBlank(quote) || !nonBlank(source))))
    die(2, 'already-answered: usage: ab already-answered <item> <Qid> (--quote "text" --source "where" | --superseded-by "text") [--no-note]');
  lock(); const f = load();
  const q = (f.b.details?.[key]?.questions ?? []).find((x) => x.id === qid);
  if (!q) die(2, `already-answered: no plan question ${qid} on ${key}`);
  const at = new Date().toISOString();
  if (quote !== undefined) { q.answered = { text: quote.trim(), source: source.trim(), at }; delete q.superseded_by; }
  else { q.superseded_by = sup.trim(); delete q.answered; }
  const det = f.b.details[key];
  if (!noNote) det.thread = [...(det.thread ?? []), { at, from: "bot", text: quote !== undefined ? `${qid}: You already answered this: "${quote.trim()}" (${source.trim()})` : `${qid}: replaced by ${sup.trim()}, so it's not asked here.` }];
  det.updated_at = at;
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "already-answered", key, question: qid, superseded: sup !== undefined });
  console.log(JSON.stringify({ ok: true, live, key, question: qid }));
} else if (cmd === "supersede") {
  // ab supersede <id> --by <id>: marks a Home decision as replaced so it is not an open ask.
  // ab supersede <item> <question-id> [--by <question-id>]: marks an earlier thread question as replaced, so the board
  // stops showing it as open (the newer question, if given, is the one the owner answers).
  const by = flag(args, "--by");
  const [target, qid] = args;
  if (target && !qid && by) {
    lock(); const f = load();
    const d = f.b.decisions.find((x) => x.id === target);
    if (!d) die(5, "no decision " + target + " on the board");
    if (!f.b.decisions.some((x) => x.id === by)) die(5, "no decision " + by + " on the board");
    d.superseded_by = by;
    if (!d.stale_reason) d.stale_reason = "Replaced by " + by;
    const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
    log({ op: "supersede", id: target, by });
    console.log(JSON.stringify({ ok: true, live, id: target, superseded_by: by }));
  } else {
  const key = detailKeyOf(target ?? "");
  if (!key || !nonBlank(qid)) die(2, "supersede: usage: ab supersede <id> --by <id>  or  ab supersede <item> <question-id> [--by <question-id>]");
  lock(); const f = load();
  const thread = f.b.details?.[key]?.thread ?? [];
  const t = thread.find((e) => e.question?.id === qid);
  if (!t) die(2, `supersede: no question ${qid} on ${key}`);
  if (by !== undefined && !thread.some((e) => e.question?.id === by)) die(2, `supersede: no question ${by} on ${key}`);
  t.question.superseded_by = by ?? "superseded";
  f.b.details[key].updated_at = new Date().toISOString();
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "supersede", key, question: qid, by: t.question.superseded_by });
  console.log(JSON.stringify({ ok: true, live, key, question: qid, superseded_by: t.question.superseded_by }));
  }
} else if (cmd === "brief") {
  const brief = parseInput(args[0] && args[0].trim().startsWith("{") ? args[0] : fs.readFileSync(0, "utf8"));
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) die(2, "brief: input must be a JSON object");
  const allowed = ["group", "title", "ticket", "summary", "svg", "pr_stand", "decisions", "gaps", "plan_link", "ticket_link"];
  for (const k of Object.keys(brief)) if (!allowed.includes(k)) die(2, "brief: unknown field " + k);
  if (isBlank(brief.group)) die(2, "brief: group is required");
  if (isBlank(brief.title)) die(2, "brief: title is required");
  if (isBlank(brief.summary)) die(2, "brief: summary is required (plain words, not a raw ticket dump)");
  if (brief.ticket) {
    if (typeof brief.ticket !== "object" || isBlank(brief.ticket.id) || isBlank(brief.ticket.summary)) die(2, "brief.ticket needs id and a one-line summary");
    if (/\n/.test(brief.ticket.summary) || brief.ticket.summary.trim().length > 160) die(2, "brief.ticket.summary must be one line, 160 characters or fewer");
  }
  if (brief.svg) {
    const e = svgError(brief.svg);
    if (e) die(2, "brief: " + e);
    brief.svg = sanitizeSvg(brief.svg);
  }
  for (const k of ["pr_stand", "plan_link", "ticket_link"]) if (k in brief && isBlank(brief[k])) die(2, "brief." + k + " must be a non-blank string when set");
  for (const k of ["decisions", "gaps"]) if (k in brief && (!Array.isArray(brief[k]) || brief[k].some((x) => isBlank(x)))) die(2, "brief." + k + " must be an array of non-blank strings");
  lock(); const f = load();
  f.b.briefs = { ...(f.b.briefs ?? {}), [brief.group]: brief };
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "brief", group: brief.group });
  console.log(JSON.stringify({ ok: true, live, group: brief.group }));
} else if (cmd === "stamp" || cmd === "heads") {
  const [group, sha] = args;
  if (isBlank(group) || isBlank(sha)) die(2, "usage: ab " + cmd + " <group> <sha>");
  lock(); const f = load();
  const key = cmd === "stamp" ? "stamps" : "heads";
  f.b[key] = { ...(f.b[key] ?? {}), [group]: sha };
  const superseded = [];
  for (const prev of f.b.decisions ?? []) {
    if (!prev.answer && !prev.superseded_by && isPushCard(prev) && prev.group === group && prev.sha && !sameSha(prev.sha, sha)) {
      prev.superseded_by = "sha-changed";
      prev.stale_reason = (cmd === "stamp" ? "Stamped SHA moved to " : "PR head is now ") + String(sha).slice(0, 9);
      superseded.push(prev.id);
    }
  }
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: cmd, group, sha });
  console.log(JSON.stringify({ ok: true, live, group, sha, store: key, ...(superseded.length ? { superseded } : {}) }));
} else if (cmd === "drop-bulk-options") {
  // ab drop-bulk-options: one-off cleanup for the t103u rule. Removes bulk-accept options from every card (unless it is
  // the answer already given) and strips "(pick)" from option labels on cards and thread questions. Idempotent.
  lock(); const f = load();
  let removed = 0, relabeled = 0;
  const unpick = (o) => { const l = String(o.label).replace(/\s*\(pick\)\s*/gi, " ").trim(); if (l !== o.label) { o.label = l; relabeled++; } };
  for (const d of f.b.decisions) {
    const keep = new Set([].concat(d.answer?.answer ?? []));
    const before = d.options.length;
    d.options = d.options.filter((o) => keep.has(o.id) || !BULK_RE.test(String(o.label).replace(/\(pick\)/gi, "")));
    removed += before - d.options.length;
    d.options.forEach(unpick);
  }
  for (const det of Object.values(f.b.details ?? {})) for (const t of det?.thread ?? []) t.question?.options.forEach(unpick);
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "drop-bulk-options", removed, relabeled });
  console.log(JSON.stringify({ ok: true, live, removed, relabeled }));
} else if (cmd === "plan") {
  // ab plan <key> <file.md> [--no-questions]: attaches the plan file's full Markdown to the item, and (unless
  // --no-questions) the open questions from its section 6 as quick answers. A bare ABC-123 key means ticket:ABC-123;
  // any other bare key means decision:<id>; page:tickets shows the text above My tickets.
  const noQ = args.includes("--no-questions"); const rest = args.filter((a) => a !== "--no-questions");
  const ctxFile = flag(rest, "--context");
  const key = detailKeyOf(rest[0]);
  if (!key || !rest[1]) die(2, "plan: usage: ab plan <key> <file.md> [--context file.json] [--no-questions]");
  if (!fs.existsSync(rest[1])) die(2, "plan: file not found: " + rest[1]);
  const text = fs.readFileSync(rest[1], "utf8");
  if (!text.trim()) die(2, "plan: file is empty: " + rest[1]);
  const questions = noQ ? [] : planQuestions(text);
  // Each question needs its context paragraph: a "- Context: ..." line under it in the plan, or --context <file.json>
  // mapping question ids to paragraphs ({"Q1": "..."}).
  let ctxMap = {};
  if (ctxFile !== undefined) { try { ctxMap = JSON.parse(fs.readFileSync(ctxFile, "utf8")); } catch { die(2, "plan: --context must be a JSON file of {\"Q1\": \"paragraph\"}"); } }
  for (const q of questions) {
    if (nonBlank(ctxMap[q.id])) q.context = ctxMap[q.id].trim();
    const e = contextParaError(q.context);
    if (e) die(2, `plan: ${q.id} ${e} (add a "- Context: ..." line under it, or pass --context file.json)`);
  }
  lock(); const f = load(); const all = f.b.details && typeof f.b.details === "object" ? f.b.details : {};
  // Keep answers the owner already gave (ab already-answered) when the same question comes back in a rebuilt plan.
  for (const q of questions) {
    const was = (all[key]?.questions ?? []).find((o) => o.id === q.id && o.question.trim() === q.question.trim());
    if (was?.answered) q.answered = was.answered;
    if (was?.superseded_by) q.superseded_by = was.superseded_by;
  }
  all[key] = { ...(all[key] ?? {}), plan: text, plan_file: path.basename(rest[1]), questions, updated_at: new Date().toISOString() };
  f.b.details = all;
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "plan", key, file: path.basename(rest[1]), questions: questions.length });
  console.log(JSON.stringify({ ok: true, live, key, chars: text.length, questions: questions.map((q) => q.id) }));
} else if (cmd === "open" || cmd === "check") {
  const chatArg = flag(args, "--chat");
  const f = load(true);
  if (f.error) { console.log(JSON.stringify({ ok: false, open_on_board: null, served_open: null, counts: null, priority_open: null, open_priority: null, assistant_open: null, problems: [f.error] }, null, 2)); process.exit(1); }
  // Glance list sizes in the file; a missing list (older files have no others) counts 0.
  const counts = Object.fromEntries(["waiting", "tickets", "others"].map((k) => [k, Array.isArray(f.b.glance?.[k]) ? f.b.glance[k].length : 0]));
  const fileB = f.b; const srv = await served();
  const isHomeOpen = (d) => isOpen(d, fileB) && d.section !== "assistant";
  const fileOpen = fileB.decisions.filter(isHomeOpen).map((d) => d.id);
  const assistantOpen = fileB.decisions.filter((d) => isOpen(d, fileB) && d.section === "assistant").map((d) => d.id);
  // Over open Home decisions only; a missing priority counts as medium. Dr. Assistant ids are in assistant_open.
  const openPriority = fileB.decisions.filter(isHomeOpen).map((d) => ({ id: d.id, priority: priorityOf(d) }));
  const priorityOpen = Object.fromEntries(PRIORITIES.map((p) => [p, openPriority.filter((x) => x.priority === p).length]));
  const srvOpen = srv ? srv.decisions.filter(isHomeOpen).map((d) => d.id) : null;
  const problems = [];
  if (!process.env.AB_NO_SERVER) {
    if (!srv) problems.push("live board not reachable at " + URL_ + " (dev server down?)");
    else if (srv.updated_at !== fileB.updated_at) problems.push("served board is stale: file " + fileB.updated_at + " vs served " + srv.updated_at);
  }
  let missing = [], boardOnly = [];
  if (chatArg !== undefined) {
    const chat = chatArg.split(",").map((s) => s.trim()).filter(Boolean);
    missing = chat.filter((id) => !fileOpen.includes(id));
    boardOnly = fileOpen.filter((id) => !chat.includes(id));
    const answered = new Set(fileB.decisions.filter((d) => d.answer).map((d) => d.id));
    for (const id of missing) problems.push(answered.has(id) ? "chat card " + id + " is answered on the board: clear the chat card" : "chat card " + id + " is NOT on the board: run ab raise for it");
    for (const id of boardOnly) problems.push("board decision " + id + " has no open chat card: card it from `ab raise` output, or ab clear it");
  }
  // Compact by default: one line, and served_open only when it differs from open_on_board. --full is the complete pretty view.
  const out = { ok: problems.length === 0, open_on_board: fileOpen, served_open: srvOpen, counts, priority_open: priorityOpen, open_priority: openPriority, assistant_open: assistantOpen, problems };
  if (args.includes("--full")) console.log(JSON.stringify(out, null, 2));
  else {
    const same = srvOpen && srvOpen.length === fileOpen.length && srvOpen.every((id, i) => id === fileOpen[i]);
    const { served_open, ...rest } = out;
    console.log(JSON.stringify({ ...rest, ...(same ? { served_open_same: true } : { served_open }) }));
  }
  if (cmd === "check" && problems.length) process.exit(1);
} else if (cmd === "context") {
  if (!SQL) die(2, "context: needs the SQLite board (unset AB_FILE)");
  const bot = flag(args, "--bot") ?? process.env.AGENT_BOT;
  const intFlag = (name) => { const v = flag(args, name); if (v === undefined) return undefined; const n = Number(v); if (!Number.isInteger(n) || n < 1) die(2, "context: " + name + " must be a positive integer"); return n; };
  const last = intFlag("--last"), clipN = intFlag("--clip"), asksN = intFlag("--asks");
  const full = args.includes("--full"), noMark = args.includes("--no-mark");
  if (!BOARD_BOTS.has(bot)) die(2, "context: usage: ab context --bot <Planner|QA|Engineer|dr eggbot|Grok Bot> [--full] [--last N] [--clip N] [--asks N] [--no-mark]");
  const b = load().b;
  const reads = new Map(sql().prepare("SELECT item_key, read_at FROM ui_item_read").all().map((r) => [r.item_key, r.read_at]));
  const r = buildContext(b, { bot, now: new Date(), timeZone: process.env.AGENT_BOARD_TIMEZONE || "America/New_York", full, last, clip: clipN, asks: asksN, isOpen: (d) => isOpen(d, b), isRead: (a) => (reads.get(a.item_key) ?? "") >= a.at });
  console.log(r.text);
  if (!noMark) for (const k of r.read_keys) markRead(k);
} else if (cmd === "prune") {
  if (!SQL) die(2, "prune: needs the SQLite board (unset AB_FILE)");
  const dryRun = args.includes("--dry-run");
  const num = (name) => { const v = flag(args, name); if (v === undefined) return undefined; const n = Number(v); if (!Number.isFinite(n) || n < 0) die(2, "prune: " + name + " must be a number of days, 0 or more"); return n; };
  const o = { cardDays: num("--card-days"), askDays: num("--ask-days"), logDays: num("--log-days"), notificationDays: num("--notification-days") };
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  lock(); const f = load();
  const now = new Date();
  const plan = planPrune(sql(), f.b, { now, ...o, isOpen: (d) => isOpen(d, f.b) });
  const moved = countsOf(plan);
  if (dryRun || Object.values(moved).every((n) => n === 0)) { console.log(JSON.stringify({ ok: true, dry_run: dryRun, moved })); process.exit(0); }
  const next = boardAfter(f.b, plan);
  let updated;
  applyPrune(sql(), plan, now, () => { updated = save(f, next); });
  const live = await waitServed((x) => x.updated_at === updated);
  log({ op: "prune", ...moved });
  console.log(JSON.stringify({ ok: true, dry_run: false, live, moved, updated_at: updated }));
} else if (cmd === "lint") {
  const lb = load().b;
  const failing = lb.decisions.filter((d) => isOpen(d, lb)).map((d) => ({ id: d.id, problems: storedProblems(d) })).filter((x) => x.problems.length);
  const answeredQ = new Set((lb.asks ?? []).flatMap((a) => (a.reply_to ? [a.reply_to] : [])));
  for (const [k, det] of Object.entries(lb.details ?? {})) {
    const missing = [
      ...(det?.thread ?? []).filter((t) => t.question && !t.question.superseded_by && !answeredQ.has(t.question.id) && contextParaError(t.question.context)).map((t) => `question "${t.question.text}" has no short context paragraph (ab reply --question ... --context "...")`),
      ...(det?.thread ?? []).filter((t) => t.question && !t.question.superseded_by && !answeredQ.has(t.question.id)).flatMap((t) => { const e = postApprovalError({ ...t.question, group: k }); return e ? [e] : []; }),
      ...(det?.questions ?? []).filter((q) => !q.answered && !q.superseded_by && contextParaError(q.context)).map((q) => `plan question ${q.id} has no short context paragraph (ab plan ... --context file.json)`),
    ];
    if (missing.length) failing.push({ id: k, problems: missing });
  }
  for (const [k, det] of Object.entries(lb.details ?? {})) {
    const problems = (det?.thread ?? []).flatMap((t) => (t.question && !t.question.superseded_by ? bulkProblems(t.question.options) : []));
    if (problems.length) failing.push({ id: k, problems });
  }
  // Standing rule: board text that mentions another ticket shows a short summary of it. The board adds the summary
  // from board.ticket_summaries next to the first mention; a key with no summary is a problem.
  const known = lb.ticket_summaries ?? {};
  const unsummarized = [...new Set(JSON.stringify({ ...lb, ticket_summaries: undefined }).match(/\b[A-Z][A-Z0-9]+-\d{2,6}\b/g) ?? [])].filter((k) => /^PROJ-/.test(k) && !known[k]).sort();
  if (unsummarized.length) failing.push({ id: "ticket_summaries", problems: unsummarized.map((k) => `${k} is mentioned but has no summary: node bin/ab.mjs ticket-summaries '{"${k}":"short summary"}'`) });
  for (const [k, det] of Object.entries(lb.details ?? {})) {
    const problems = [
      rawTicketError(det?.summary, "summary"),
      rawTicketError(det?.plain, "plain"),
      ...(det?.thread ?? []).flatMap((t, idx) => [
        rawTicketError(t?.text, `thread[${idx}].text`),
        rawTicketError(t?.question?.text, `thread[${idx}].question.text`),
        rawTicketError(t?.question?.context, `thread[${idx}].question.context`),
      ]),
    ].filter(Boolean);
    if (problems.length) failing.push({ id: k, problems });
  }
  for (const [k, br] of Object.entries(lb.briefs ?? {})) {
    const problems = [rawTicketError(br?.summary, "brief.summary"), rawTicketError(br?.ticket?.summary, "brief.ticket.summary")].filter(Boolean);
    if (problems.length) failing.push({ id: "brief:" + k, problems });
  }
  for (const [k, sum] of Object.entries(lb.ticket_summaries ?? {})) {
    const e = rawTicketError(sum, "ticket_summaries." + k);
    if (e) failing.push({ id: "ticket_summaries", problems: [e] });
  }
  console.log(JSON.stringify({ ok: failing.length === 0, failing }, null, 2));
  if (failing.length) process.exit(1);
} else if (cmd === "ticket-summaries") {
  // ab ticket-summaries '{"PROJ-4411":"Return accrual hours totals per bank"}' | - : merges short summaries (one line,
  // at most 120 chars) the board shows next to the first mention of each ticket key in any text.
  const raw = args[0] === undefined || args[0] === "-" ? fs.readFileSync(0, "utf8") : args[0];
  let m; try { m = JSON.parse(raw); } catch { die(2, "ticket-summaries: input must be a JSON object"); }
  if (!m || typeof m !== "object" || Array.isArray(m)) die(2, "ticket-summaries: input must be a JSON object");
  for (const [k, v] of Object.entries(m)) if (!/^[A-Z][A-Z0-9]+-\d+$/.test(k) || !nonBlank(v) || v.length > 120 || /\n/.test(v)) die(2, "ticket-summaries: bad entry " + k);
  lock(); const f = load();
  f.b.ticket_summaries = { ...(f.b.ticket_summaries ?? {}), ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.trim()])) };
  const u = save(f, f.b); const live = await waitServed((b) => b.updated_at === u);
  log({ op: "ticket-summaries", keys: Object.keys(m) });
  console.log(JSON.stringify({ ok: true, live, count: Object.keys(f.b.ticket_summaries).length }));
} else if (cmd === "backfill-stamps") {
  const dry = args[0] === "--dry-run";
  if (args.length > (dry ? 1 : 0)) die(2, "usage: ab backfill-stamps [--dry-run]");
  lock(); const f = load();
  // Log lines per id, in file order; unparseable lines and lines without an id or a valid time are skipped.
  const hist = new Map();
  for (const l of logLines()) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (!o || typeof o.id !== "string" || typeof o.at !== "string" || Number.isNaN(Date.parse(o.at))) continue;
    if (!hist.has(o.id)) hist.set(o.id, []);
    hist.get(o.id).push(o);
  }
  const stamped = [], blank = [], noHistory = [];
  for (const d of f.b.decisions) {
    const lines = hist.get(d.id) || [];
    if (!lines.length) noHistory.push(d.id);
    // A raise is logged ~300ms after its board write, so the first raise is the creation; later raises and answers are updates.
    const ops = lines.filter((o) => o.op === "raise" || o.op === "answer");
    const first = ops.findIndex((o) => o.op === "raise");
    const later = first >= 0 ? ops.slice(first + 1) : ops;
    let changed = false;
    if (!(typeof d.created_at === "string" && d.created_at.trim()) && first >= 0) { d.created_at = ops[first].at; changed = true; }
    if (!d.updated_at) {
      const u = later.length ? later[later.length - 1].at : first >= 0 && d.created_at ? d.created_at : undefined;
      if (u) { d.updated_at = u; changed = true; }
    }
    if (changed) stamped.push(d.id);
    if (!d.created_at && !d.updated_at) blank.push(d.id);
  }
  const wrote = !dry && stamped.length > 0;
  if (wrote) { save(f, f.b); log({ op: "backfill-stamps", count: stamped.length }); }
  const total = f.b.decisions.length, unchanged = total - stamped.length;
  console.log(JSON.stringify({ ok: true, dry_run: dry, wrote, stamped, blank, no_history: noHistory, unchanged,
    counts: { stamped: stamped.length, blank: blank.length, no_history: noHistory.length, unchanged, total } }, null, 2));
} else if (cmd === "backfill-titles") {
  const map = parseInput(fs.readFileSync(0, "utf8"));
  if (!map || typeof map !== "object" || Array.isArray(map)) die(2, "backfill-titles reads {\"<decision id>\":\"<title>\"} on stdin");
  const bad = Object.entries(map).map(([id, t]) => { const e = titleError(t); return e && id + ": " + e; }).filter(Boolean);
  if (bad.length) die(2, bad.join("\nab: "));
  lock(); const f = load();
  const set = [], unknown = [], skippedAnswered = [], skippedHasTitle = [];
  const hasTitle = (d) => typeof d.title === "string" && !!d.title.trim();
  for (const [id, t] of Object.entries(map)) {
    const k = f.b.decisions.findIndex((x) => x.id === id), d = f.b.decisions[k];
    if (!d) unknown.push(id);
    else if (d.answer) skippedAnswered.push(id);
    else if (hasTitle(d)) skippedHasTitle.push(id);
    else { const { id: _i, title: _t, ...rest } = d; f.b.decisions[k] = { id, title: t.trim(), ...rest }; set.push(id); }
  }
  // Card stamps stay as they were; save() moves only the board's own updated_at.
  const wrote = set.length > 0;
  if (wrote) { save(f, f.b); log({ op: "backfill-titles", count: set.length }); }
  const stillMissing = f.b.decisions.filter((d) => isOpen(d, f.b) && !hasTitle(d)).map((d) => d.id);
  console.log(JSON.stringify({ ok: true, wrote, set, unknown, skipped_answered: skippedAnswered, skipped_has_title: skippedHasTitle, still_missing: stillMissing }, null, 2));
} else if (cmd === "project-refresh") {
  if (args.length > 1) die(2, "project-refresh: usage: ab project-refresh '<json>' | ab project-refresh [-] < project.json");
  const raw = args[0] === undefined || args[0] === "-" ? fs.readFileSync(0, "utf8") : args[0];
  let input; try { input = JSON.parse(raw); } catch (e) { die(2, "project-refresh: input is not valid JSON (" + e.message + ")"); }
  let updated = new Date().toISOString();
  if (input && typeof input === "object" && "updated_at" in input) {
    const u = input.updated_at;
    if (typeof u !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(u) || Number.isNaN(Date.parse(u))) die(2, "project-refresh: updated_at must be an ISO 8601 time with a zone, like 2026-11-23T18:35:00Z");
    updated = new Date(u).toISOString();
  }
  lock((SQL ? DB_PATH + ".project" : PROJECT_FILE) + ".lock");
  const f = loadProject();
  const r = projectData(input, f.p);
  if (r.error) die(2, "project-refresh: " + r.error);
  const p = { title: r.title, updated_at: updated, parent: r.parent, milestones: r.milestones };
  if (SQL) docPut("project", JSON.stringify(p)); else writeAtomic(PROJECT_FILE, f.s.slice(0, f.i) + "\n" + JSON.stringify(p, null, 2) + "\n" + f.s.slice(f.j));
  unlock();
  const totals = Object.fromEntries(COUNTS.map((k) => [k, r.milestones.reduce((n, m) => n + m[k], 0)]));
  log({ op: "project-refresh", milestones: r.milestones.length });
  console.log(JSON.stringify({ ok: true, milestones: r.milestones.length, totals, updated_at: updated }));
} else {
  die(2, "usage: ab raise|assistant|slack-draft|answer|heal-answers|read|context|prune|notify|clear|restore|priority|glance|mypr|reviews|review-status|gh-refresh|detail|ticket|ticket-summaries|plan|reply|supersede|already-answered|wipe|drop-bulk-options|ask|open|check|lint|backfill-stamps|backfill-titles|project-refresh (see header of " + process.argv[1] + ")");
}
