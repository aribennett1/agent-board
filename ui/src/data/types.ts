export type Option = {
  id: string;
  label: string;
  severity?: string;
  path?: string;
  line?: number;
  url?: string;
  summary?: string;
  post_text?: string;
  // The text already on GitHub, when this option would edit that comment.
  current_text?: string;
};

export type Priority = "high" | "medium" | "low";

export type Tier = "blocking" | "quick" | "decision" | "fyi";

// The GitHub comment a post/reply/approve/thumbs-up card answers, shown verbatim on the card.
export type AnswersComment = {
  author: string;
  pr: number;
  repo?: string;
  path?: string;
  line?: number | null;
  severity?: string;
  url: string;
  body: string;
};

export type PostCommentDraft = {
  // Finding number on a per-comment ops review card (#1, #2, ...).
  n?: number;
  id?: string;
  label: string;
  severity?: string;
  path: string;
  line?: number;
  url?: string;
  summary?: string;
  body: string;
  // Set by ab review-status once the comment has been posted, or if it could not be posted.
  status?: "pending" | "posted" | "skipped";
  posted_url?: string;
  note?: string;
  // When the owner's free-text answer was a question, the reply to show in "Answer to your question".
  answer_to_question?: string;
  // Asks at or before this time are not used to close the finding; he still needs to Post the revised text.
  revision_at?: string;
};

export type AlreadyDecided = {
  answer: string;
  source?: string;
  at?: string;
};

export type GlanceOutcome = { id: string; happens: string };
export type GlanceTicket = { id: string; summary: string; link?: string };
export type GlancePr = {
  repo?: string;
  number: number;
  link: string;
  author?: string;
  base?: string;
  sits_on?: string;
  sat_on_by?: string;
  state?: string;
  sha?: string;
};
// Fixed "At a glance" header on every card. Ticket summary is one plain line, never the raw ticket.
export type Glance = {
  ticket: GlanceTicket;
  pr?: GlancePr;
  done?: string[];
  asking: string;
  outcomes: GlanceOutcome[];
};

export type Recommendation = { id: string; reason: string; who?: string };

// Ticket brief: a concise, human explanation and a simple diagram. The raw ticket is a link, never inlined.
export type TicketBrief = {
  group: string;
  title: string;
  ticket?: GlanceTicket;
  summary: string;
  svg?: string;
  pr_stand?: string;
  decisions?: string[];
  gaps?: string[];
  plan_link?: string;
  ticket_link?: string;
};


// One entry of a decision's details. A bare string is a bullet (consecutive strings share one list).
// An object is a labeled section; ordered: true numbers its items.
export type DetailSection = { label: string; items: string[]; ordered?: boolean };
export type Detail = string | DetailSection;

// What was chosen. Single: one option. Multi (multiSelect decisions): option ids and labels in option order.
// Custom (free text): answer is "custom" and the text is in both answer_label and custom_text.
export type SingleChoice = { answer: string; answer_label: string };
export type MultiChoice = { answer: string[]; answer_label: string[] };
export type CustomChoice = { answer: "custom"; answer_label: string; custom_text: string };
export type Choice = SingleChoice | MultiChoice | CustomChoice;

export type Answer = Choice & {
  answered_by: "chat" | "app";
  answered_at: string;
};

// A Slack message waiting for Eric to send or decline. A bot must not post it until he taps Send.
export type SlackDraft = {
  channel_id: string;
  channel: string;
  text: string;
  thread_ts?: string;
  permalink?: string;
};

export type Decision = {
  id: string;
  // slack_draft: a Slack message preview with Send to Slack / Don't send. Missing means an ordinary decision.
  kind?: "slack_draft";
  slack?: SlackDraft;
  // Short bold topic shown at the top of the card. ab raise requires it; answered and older cards lack it.
  title?: string;
  card_ref: string | null;
  // 1 to 3 plain sentences shown first: what the item is and what happened. ab raise requires it; older cards lack it.
  context?: string;
  question: string;
  // Optional structure under the question: bullets and labeled lists.
  details?: Detail[];
  what_happens_after: string;
  options: Option[];
  // true: options toggle and a Submit button confirms. Missing or false: one click answers.
  multiSelect?: boolean;
  // Free-text answer field. Missing means true; only false hides it.
  allowCustom?: boolean;
  // Who raised this card (ab raise --bot). Missing on older cards; the UI may infer it from the id prefix.
  raised_by?: string;
  // Occasional alias on older payloads; treated like raised_by when that is missing.
  agent?: string;
  // Dr. Assistant assistant finding or proposed bot change (ab assistant). Missing means a Home decision (ab raise).
  section?: "assistant";
  // Required on section "assistant": which bot it is for, and a short rule/theme. seen and proposed_fix
  // are required unless `fixes` lists each row (id, what was seen, proposed change) as a table.
  rule?: string;
  seen?: string;
  proposed_fix?: string;
  bot?: string;
  fixes?: { id: string; seen: string; proposed: string }[];
  // Optional small SVG diagram on the card (ab raise / ab assistant). Stored and rendered sanitized.
  svg?: string;
  // How much it matters; sorts the Needs you queue. Missing means medium. Set by ab raise or ab priority.
  priority?: Priority;
  // Pinned cards sort above every other card, whatever their priority. Set by ab raise.
  pinned?: boolean;
  created_at: string;
  // Last raise or answer (ISO UTC), set by ab; equals created_at until the card changes. Older cards lack it.
  updated_at?: string;

  // Triage. Required on a new ab raise. Missing on older cards counts as "decision".
  tier?: Tier;
  // Short estimate, e.g. "10 seconds" or "1 minute". Required on a new ab raise.
  estimate?: string;
  // How much work answering this unblocks. Higher sorts first within a tier. Missing means 0.
  unblocks?: number;
  // Stamped SHA this card is about (push OKs). Stale when it no longer matches board.stamps / board.heads.
  sha?: string;
  // Ticket or PR grouping key, e.g. "pr:app/206" or "ticket:PROJ-5267".
  group?: string;
  glance?: Glance;
  // Optional one-line light joke, shown muted.
  joke?: string;
  // Shown as a recommendation with its reason; never preselected.
  recommendation?: Recommendation;
  // Optional review draft, hidden behind a toggle. Not shown as a quote wall in the context.
  draft?: string;
  // Set by ab supersede. A superseded card is not an open ask.
  superseded_by?: string;
  stale_reason?: string;
  // Review-finding severity. Low findings collapse under "Small stuff" in a ticket group.
  severity?: "high" | "medium" | "low";
  // Required when the card asks to post, reply, approve, or 👍 on GitHub.
  answers_comment?: AnswersComment;
  // Exact text to post on GitHub, or null when only reacting with 👍 (no text posted).
  post_text?: string | null;
  // The text already on GitHub, when this card would edit or replace that comment. Shown as a diff against post_text.
  current_text?: string;
  post_comments?: PostCommentDraft[];
  // Shown as "You already decided X" when a card repeats an earlier answer.
  already_decided?: AlreadyDecided;
  answer?: Answer;
};

export type WaitingItem = { title: string; who: string; link?: string };
export type Ticket = { id: string; title: string; status: string; link?: string };
// Someone else's open PR that involves the user. who says what it waits on ("Your review requested", "Waiting on the author"); link is the PR URL.
export type OtherPR = { title: string; author: string; who: string; link: string };

// One of the user's own open PRs (My PRs). Set by ab mypr.
export type MyPRState = "draft" | "ready" | "approved" | "changes requested";
export type MyPRCI = "passing" | "failing" | "pending" | "none";
export type MyPR = { repo: string; number: number; title: string; link: string; state: MyPRState; ci?: MyPRCI; reviews?: number };

// A drafted review on someone else's PR: the verdict, optional notes, and one inline comment per finding.
// status: pending until the user posts or skips it (ab review-status, or the app after a delivered answer).
export type ReviewSeverity = "high" | "medium" | "low";
export type ReviewCommentStatus = "pending" | "posted" | "skipped";
export type ReviewComment = {
  id: string;
  severity: ReviewSeverity;
  title?: string;
  path: string;
  line: number | null;
  body: string;
  status: ReviewCommentStatus;
  // The posted comment on GitHub, once it is posted.
  url?: string;
  // Why the status is what it is, e.g. "Deleted on GitHub at 3:35 PM ET".
  note?: string;
};
export type ReviewDraft = {
  repo: string;
  pr: number;
  verdict: string;
  notes?: string;
  // true once every comment the user wants is posted (the row shows Done).
  done?: boolean;
  comments: ReviewComment[];
};

// What an item's chevron (and its focus page) shows beyond the row: a summary, Assistant's full plan, discussion,
// and quick actions. Keyed by item key: ticket:PROJ-2512, pr:app/209, mypr:app/209,
// waiting:<slug of title>, decision:<decision id>. Set by ab detail and ab plan.
// answered (ab already-answered): the owner's own earlier words and where they came from; superseded_by: what replaced it.
// Either one means the question is never asked again.
export type PlanQuestion = { id: string; question: string; body?: string; recommendation?: string; context?: string; answered?: { text: string; source: string; at?: string }; superseded_by?: string };
export type DiscussionEntry = { author: string; at?: string; body: string; link?: string };
// A Assistant reply on an item (ab reply), optionally with an image under app/public and a one-click question.
// superseded_by (ab supersede / ab reply --supersedes): a newer question replaced this one; it is never shown as open.
// context (t111u): the short plain-words paragraph shown right above the options.
export type ReplyQuestion = {
  id: string;
  text: string;
  context?: string;
  suggestion?: string;
  options: { id: string; label: string }[];
  superseded_by?: string;
  answers_comment?: AnswersComment;
  post_text?: string | null;
  current_text?: string;
  post_comments?: PostCommentDraft[];
  already_decided?: AlreadyDecided;
};
// status (ab reply --status): what happens next. working | done | passed:assistant | passed:ops | waiting:<who>.
// A reply with no question is never something the owner must act on; a status never closes unanswered questions.
export type ThreadEntry = { at: string; from: "bot"; text: string; image?: string; image_alt?: string; question?: ReplyQuestion; status?: string };

// What the owner'sent from the board (ab ask, recorded by the /__ab/webhook forwarder): a note, an answer, a click, his
// own words, or a review action. reply_to is the thread question it answers; ref the review comment it acts on.
export type Ask = {
  id: string;
  at: string;
  item_key: string;
  label: string;
  link?: string;
  kind: "note" | "answer" | "custom" | "click" | "review";
  text: string;
  // The check state the server derives: sent (saved), delivered (the wake webhook took it), read (the assistant ran ab on the item).
  status?: "sent" | "delivered" | "read";
  reply_to?: string;
  ref?: string;
  // The bot this was sent to.
  to_bot?: string;
};

export type ItemDetail = {
  // Assistant's replies on this item, oldest first.
  thread?: ThreadEntry[];
  // The full ticket as Markdown (title, description, acceptance criteria, key comments, links, parent and
  // related), shown first; then the plain-words summary; then questions and the plan. ab ticket fills both.
  ticket?: string;
  ticket_file?: string;
  plain?: string;
  // Filled by ab mypr / ab gh-refresh from gh: what failed in CI (Markdown), and for a PR with changes requested,
  // who asked and their open comments (review_facts) and the scope (review_scope). review_sig changes when new
  // review activity lands; the assistant writes review_plain and review_questions with review_brief_sig = review_sig.
  ci_report?: string;
  review_facts?: string;
  review_scope?: string;
  review_sig?: string;
  review_plain?: string;
  review_questions?: string;
  review_brief_sig?: string;
  // A fact from gh: "ready" means checks on the latest commit passed and no review threads or
  // change requests are open; "approved" means GitHub's reviewDecision is APPROVED. itemStatus
  // decides whether "ready" is Needs you (a review request still waiting on a draft is not).
  approval?: "ready" | "approved";
  summary?: string;
  plan?: string;
  plan_file?: string;
  discussion?: DiscussionEntry[];
  // Quick action labels; each sends the label to the assistant as a message on the item.
  actions?: string[];
  // Open questions from the plan's section 6, each with the recommended answer (ab plan fills these).
  questions?: PlanQuestion[];
  updated_at?: string;
};

export type BoardNotification = {
  id: number;
  bot: string;
  text: string;
  next_update?: string | null;
  link?: string | null;
  created_at: string;
  cleared_at?: string | null;
};

export type Board = {
  updated_at: string;
  decisions: Decision[];
  // parked is a retired key: always empty, kept optional so older files still load. Parked things are decisions now.
  // others is optional so older files still load; missing means [].
  // mine (My PRs) is optional so older files still load; missing means [].
  // the owner's side of the conversation, oldest first.
  asks?: Ask[];
  // Whether the server has a wake webhook right now; re-read on every live refresh (the page-load value can be stale).
  webhook_configured?: boolean;
  // Uncleared status notes from the bots (ab notify). Never mixed into Conversation and never part of the red-dot count.
  notifications?: BoardNotification[];
  // Fetch status of the server's own GitHub / Linear pulls behind My tickets, My PRs and Others' PRs.
  feed?: { fetched_at?: string; github?: { ok: boolean; login?: string | null; error?: string | null }; linear?: { ok: boolean; configured: boolean; error?: string | null } } | null;
  // ab wipe: when the board was emptied. Local history from before it is not shown or re-sent.
  reset_at?: string;
  // Short summaries of ticket keys, shown next to the first mention of a key in any board text (ab ticket-summaries).
  ticket_summaries?: Record<string, string>;
  glance: { waiting: WaitingItem[]; tickets: Ticket[]; others?: OtherPR[]; mine?: MyPR[]; parked?: never[] };
  // Drafted reviews for PRs in others, matched by repo and number. Optional; missing means none.
  reviews?: ReviewDraft[];
  // Extra detail per item, by item key (see ItemDetail). Optional; missing means none.
  details?: Record<string, ItemDetail>;

  // Latest Assistant-stamped SHA, and last known GitHub head, per group key. Used to mark push cards stale.
  stamps?: Record<string, string>;
  heads?: Record<string, string>;
  // Concise ticket briefs (never a raw ticket dump), keyed by group.
  briefs?: Record<string, TicketBrief>;
};


// Project tab (data in ./project.ts). Counts leave out duplicate and canceled tickets;
// left includes in_progress, so done + left = total. title is the tab's label and heading.
export type ProjectCounts = { done: number; in_progress: number; left: number; total: number };
export type ProjectMilestone = ProjectCounts & { key: string; id: string; title: string; url: string };
export type Project = {
  title: string;
  updated_at: string;
  parent: { id: string; url: string };
  milestones: ProjectMilestone[];
};
