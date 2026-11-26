import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { board as bundledBoard } from "./data/board";
import type { Board, Decision, ItemDetail, MyPR, Priority, ReviewDraft } from "./data/types";
import { DecisionCard, type ClarifyState, type NotRelevantState } from "./DecisionCard";
import { CardSvg } from "./DecisionCard";
import { ContextBody } from "./contextBody";
import {
  buildClarifyPayload,
  buildNotRelevantPayload,
  buildPayload,
  choiceText,
  CLEAR_PATH,
  createDelivery,
  deliveryMarker,
  FALLBACK_PATH,
  loadAnswers,
  loadMessages,
  MESSAGES_KEY,
  STORAGE_KEY,
  type AppAnswers,
  type AppChoice,
  type AppMessages,
  type MessageRecord,
  type ReviewPayload,
} from "./delivery";
import { buildMessagePayload, decisionItem, glanceItem, itemKey, newMessageId, slug, type BoardItem, type GlanceSection } from "./messages";
import { MessageAssistant, type Draft } from "./MessageAssistant";
import { isReviewRequest, prRef, prPath, sortOthers } from "./others";
import { ExpandableRow, FocusView, ItemDetails } from "./ItemExpand";
import { Markdown } from "./markdown";
import { hasUnread, loadMyNotes, loadSeen, rememberMyNote, saveSeen } from "./Thread";
import { Conversation } from "./Conversation";
import { buildTopics, openCount } from "./topics";
import type { Ask, ReplyQuestion } from "./data/types";
import {
  allFindingsAnswered,
  answersForCard,
  answersFromAsks,
  buildFindingPayload,
  findingAnswerLabel,
  findingStoreKey,
  isPerFindingReview,
  reviewFindings,
  loadFindingAnswers,
  localFindingAsks,
  mergeFindingMaps,
  saveFindingAnswers,
  type FindingAction,
  type FindingAnswerMap,
  type FindingPick,
} from "./reviewFindings";
import { itemStatus, type StatusInput } from "./itemStatus";
import { postText } from "./entities";
import { recordAsk } from "./delivery";
import { setTicketSummaries } from "./ticketRefs";
import { draftSummary, reviewKey, ReviewDrafts, type OnReview, type ReviewLocals } from "./ReviewDrafts";
import { effectivePriority, groupByPriority, PRIORITY_LABEL, PRIORITY_PATH, sortByPriority } from "./priority";
import { headerDate } from "./stamp";
import { useLiveBoard } from "./useLiveBoard";
import { useNow } from "./useNow";
import { needsYou } from "./visibility";
import { useNeedsYouBadge } from "./needsYouBadge";
import { sameSha, staleContext } from "./triage";
import { TriageQueue } from "./TriageQueue";
import { WEBHOOK_CONFIGURED } from "./config";

const TOAST_MS = 5000;
// The page never holds the webhook URL or auth: every send goes to the server's forwarder (FALLBACK_PATH).

type Toast = { id: number; text: string };

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

// The card for "Explain this better" comparisons: a priority change is not a rewording.
const withoutPriority = ({ priority: _priority, ...rest }: Decision) => JSON.stringify(rest);

// The left nav's destinations. #project is the project tab; the rest are board sections.
export type View = "conversation" | "home" | "tickets" | "mine" | "reviews" | "waiting" | "others" | "audit" | "project" | "focus";

type AppProps = {
  // Which section the main area shows. Missing: the classic one-page board with every section (used by tests).
  view?: View;
  onSelect?: (view: View) => void;
  // The project tab's content and its nav label, owned by Tabs so project.ts edits hot-reload.
  project?: ReactNode;
  projectLabel?: ReactNode;
  // Focus mode: "<kind>/<id>" of the one item shown full width (view "focus"), e.g. "ticket/PROJ-2512".
  focus?: string;
  onFocus?: (focus: string) => void;
};

const REVIEW_KEY = "action-board:review-answers";
const loadReviewLocals = (): ReviewLocals => {
  try {
    const v = JSON.parse(window.localStorage.getItem(REVIEW_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

type Kind = "ticket" | "mypr" | "pr" | "waiting" | "decision";
const KIND_LABEL: Record<Kind, string> = { ticket: "Ticket", mypr: "My PR", pr: "Pull request", waiting: "Waiting on others", decision: "Decision" };
const KIND_BACK: Record<Kind, { view: View; label: string }> = {
  ticket: { view: "tickets", label: "My tickets" },
  mypr: { view: "mine", label: "My PRs" },
  pr: { view: "others", label: "Others' PRs" },
  waiting: { view: "waiting", label: "Waiting on others" },
  decision: { view: "home", label: "Home" },
};
// Quick actions when the item's detail names none. Each sends its label to the assistant as a message on the item.
const DEFAULT_ACTIONS: Record<Kind, string[]> = {
  ticket: ["Start this ticket", "Write a plan first", "Not now"],
  mypr: ["Fix the failing checks", "Address the review comments", "Mark it ready for review"],
  pr: ["Review this PR", "Remind me later"],
  waiting: ["Nudge them", "Drop this"],
  decision: [],
};

// One board item in the new layout: its row cells, focus page facts and what its chevron opens.
type Entry = {
  kind: Kind;
  id: string;
  ref: BoardItem;
  section: GlanceSection;
  title: string;
  sub?: string;
  link?: string;
  cells: ReactNode;
  badge?: ReactNode;
  meta: { label: string; value: ReactNode }[];
  draft?: ReviewDraft;
  // Facts for the Needs you / In progress split.
  status?: Partial<StatusInput>;
};
const focusOf = (e: Pick<Entry, "kind" | "id">) => `${e.kind}/${e.id}`;
const detailKey = (kind: Kind, id: string) => `${kind}:${id}`;


// One chip for the real approve-ready / approved case. A conflicting green "Ready to approve"
// next to "Review running" (or a second chip next to the status reason) is never shown.
function approvalChipOf(e: Entry, st: { needs: boolean; reason: string }, detail: ItemDetail | undefined) {
  if (e.kind !== "pr") return null;
  if (st.reason !== "Ready to approve" && st.reason !== "Approved") return null;
  const approval = detail?.approval;
  if (!approval) return null;
  return (
    <span className={`approval-chip ${approval}`} title={approval === "approved" ? "Approved on GitHub" : "All checks passed and nothing is open: ready to approve"}>
      {approval === "approved" ? "Approved" : "Ready to approve"}
    </span>
  );
}

export default function App({ view, onSelect, project, projectLabel, focus, onFocus }: AppProps = {}) {
  const board = useLiveBoard(bundledBoard);
  setTicketSummaries(board.ticket_summaries);
  // One clock for every card's stamp and the header date, ticking each minute.
  const now = useNow();
  const [answers, setAnswers] = useState<AppAnswers>(() => loadAnswers(window.localStorage));
  const [messages, setMessages] = useState<AppMessages>(() => loadMessages(window.localStorage));
  // Open composers by itemKey, so typed text survives live board updates and reorders.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  // "Explain this better" per decision id, so it survives live updates and reorders.
  const [clarifying, setClarifying] = useState<Record<string, ClarifyState>>({});
  // Ids with a clarify POST in flight; a ref so two clicks in the same tick still send one request.
  const clarifyInFlight = useRef(new Set<string>());
  // Priority taps shown before the live board has them, by decision id; dropped once the board agrees.
  const [priorityOverride, setPriorityOverride] = useState<Record<string, Priority>>({});
  // Ids whose last priority save failed, for the card's error line.
  const [priorityFailed, setPriorityFailed] = useState<Record<string, true>>({});
  // Ids with a priority POST in flight: a ref for the same-tick guard, state so the override check reruns when one ends.
  const priorityInFlight = useRef(new Set<string>());
  const [prioritySaving, setPrioritySaving] = useState<Record<string, true>>({});
  // "Not relevant anymore" per decision id. The refs: ids with a try in flight (two taps in one tick send one
  // webhook POST), and ids whose webhook already got a 2xx (a retry then only clears).
  const [notRelevant, setNotRelevant] = useState<Record<string, NotRelevantState>>({});
  const notRelevantInFlight = useRef(new Set<string>());
  const notRelevantSent = useRef(new Set<string>());

  const delivery = useMemo(
    () =>
      createDelivery({
        fetch: window.fetch.bind(window),
        sleep,
        storage: window.localStorage,
        enabled: WEBHOOK_CONFIGURED,
        fallbackUrl: FALLBACK_PATH,
        onChange: setAnswers,
        onMessagesChange: setMessages,
      }),
    [],
  );

  // On load, after every live update of board.ts, and when the window comes back:
  // drop app answers the file has taken over, then retry any answer or message not yet delivered.
  useEffect(() => {
    const retry = () => {
      void delivery.deliverPending(board);
      void delivery.deliverPendingMessages();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") retry();
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setAnswers(loadAnswers(window.localStorage));
      if (e.key === MESSAGES_KEY) setMessages(loadMessages(window.localStorage));
    };
    retry();
    window.addEventListener("focus", retry);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", retry);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
    };
  }, [delivery, board]);

  const toast = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), TOAST_MS);
  }, []);

  const choose = useCallback(
    (decision: Decision, pick: AppChoice) => {
      let payload;
      try {
        payload = buildPayload(decision, pick, new Date());
      } catch {
        return; // The card only offers valid picks; ignore anything else rather than record it.
      }
      toast(`Answered: ${choiceText(payload)}`);
      void delivery.answer(payload);
    },
    [delivery, toast],
  );

  const requestClarify = useCallback(
    (decision: Decision) => {
      const id = decision.id;
      if (clarifyInFlight.current.has(id) || clarifying[id]?.status === "rewording") return;
      clarifyInFlight.current.add(id);
      // The card as it was at click time; Rewording... lasts until the live board changes it (priority aside).
      const snapshot = withoutPriority(decision);
      setClarifying((cs) => ({ ...cs, [id]: { status: "sending" } }));
      void delivery.clarify(buildClarifyPayload(decision, new Date())).then(({ ok, http }) => {
        clarifyInFlight.current.delete(id);
        setClarifying((cs) => ({ ...cs, [id]: ok ? { status: "rewording", snapshot } : { status: "failed", http } }));
      });
    },
    [delivery, clarifying],
  );

  // Rewording... ends once the live board changes that decision (a re-raise), answers it or drops it.
  useEffect(() => {
    setClarifying((cs) => {
      const byId = new Map(board.decisions.map((d) => [d.id, d]));
      const done = Object.keys(cs).filter((id) => {
        const c = cs[id];
        if (c.status !== "rewording") return false;
        const d = byId.get(id);
        return !d || Boolean(d.answer) || withoutPriority(d) !== c.snapshot;
      });
      if (done.length === 0) return cs;
      const next = { ...cs };
      for (const id of done) delete next[id];
      return next;
    });
  }, [board, clarifying]);

  // Priority tap: show the new level at once (the queue re-sorts), save it through the dev server's
  // `ab priority`, and put the old level back with an error line if that fails. One save per card at a time.
  const changePriority = useCallback((decision: Decision, level: Priority) => {
    const id = decision.id;
    if (priorityInFlight.current.has(id) || effectivePriority(decision) === level) return;
    priorityInFlight.current.add(id);
    setPrioritySaving((s) => ({ ...s, [id]: true }));
    setPriorityOverride((o) => ({ ...o, [id]: level }));
    setPriorityFailed((f) => {
      if (!f[id]) return f;
      const next = { ...f };
      delete next[id];
      return next;
    });
    const without = <T,>(r: Record<string, T>) => {
      const next = { ...r };
      delete next[id];
      return next;
    };
    window
      .fetch(PRIORITY_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, priority: level }) })
      .then((r) => r.ok)
      .catch(() => false)
      .then((ok) => {
        priorityInFlight.current.delete(id);
        setPrioritySaving(without);
        if (ok) return;
        setPriorityOverride(without);
        setPriorityFailed((f) => ({ ...f, [id]: true }));
      });
  }, []);

  // An override ends once the live board shows that level for the card (or the card is gone), after its save returned.
  useEffect(() => {
    setPriorityOverride((o) => {
      const byId = new Map(board.decisions.map((d) => [d.id, d]));
      const done = Object.keys(o).filter((id) => {
        if (prioritySaving[id]) return false;
        const d = byId.get(id);
        return !d || effectivePriority(d) === o[id];
      });
      if (done.length === 0) return o;
      const next = { ...o };
      for (const id of done) delete next[id];
      return next;
    });
  }, [board, prioritySaving]);

  // "Not relevant anymore": tell the assistant first (decision.not_relevant, with the usual retries and fallback), and only
  // after a 2xx clear the card through the dev server's `ab clear`. The card stays, with Clearing..., until the live
  // board drops it. A failure re-enables the control; after a sent webhook, the retry only clears.
  const markNotRelevant = useCallback(
    (decision: Decision) => {
      const id = decision.id;
      if (notRelevantInFlight.current.has(id) || notRelevant[id]?.status === "clearing") return;
      notRelevantInFlight.current.add(id);
      const sent = notRelevantSent.current.has(id);
      setNotRelevant((s) => ({ ...s, [id]: { status: "sending", sent } }));
      const tellAssistant = sent ? Promise.resolve(true) : delivery.notRelevant(buildNotRelevantPayload(decision, new Date())).then((r) => r.ok);
      void tellAssistant
        .then(async (ok): Promise<NotRelevantState> => {
          if (!ok) return { status: "failed", sent: false };
          notRelevantSent.current.add(id);
          const cleared = await window
            .fetch(CLEAR_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) })
            .then((r) => r.ok)
            .catch(() => false);
          return cleared ? { status: "clearing" } : { status: "failed", sent: true };
        })
        .then((next) => {
          notRelevantInFlight.current.delete(id);
          setNotRelevant((s) => ({ ...s, [id]: next }));
        });
    },
    [delivery, notRelevant],
  );

  // A card's not relevant state ends once the live board no longer has it open (cleared, or answered meanwhile).
  useEffect(() => {
    setNotRelevant((s) => {
      const open = new Set(board.decisions.filter((d) => !d.answer).map((d) => d.id));
      const done = Object.keys(s).filter((id) => !open.has(id) && !notRelevantInFlight.current.has(id));
      if (done.length === 0) return s;
      const next = { ...s };
      for (const id of done) {
        delete next[id];
        notRelevantSent.current.delete(id);
      }
      return next;
    });
  }, [board, notRelevant]);

  // A composer closes once its message is delivered (2xx).
  useEffect(() => {
    setDrafts((ds) => {
      const done = Object.keys(ds).filter((k) => ds[k].message_id && messages[ds[k].message_id!]?.status === "delivered");
      if (done.length === 0) return ds;
      const next = { ...ds };
      for (const k of done) delete next[k];
      return next;
    });
  }, [messages]);

  // The newest message for each item, for its "Sent to <assistant>" / retry line.
  const latest = useMemo(() => {
    const byItem = new Map<string, MessageRecord>();
    for (const rec of Object.values(messages)) {
      if (!rec?.payload?.item_id) continue;
      const k = itemKey(rec.payload);
      const prev = byItem.get(k);
      if (!prev || prev.payload.sent_at <= rec.payload.sent_at) byItem.set(k, rec);
    }
    return byItem;
  }, [messages]);

  const openComposer = useCallback((item: BoardItem) => {
    setDrafts((ds) => (ds[itemKey(item)] ? ds : { ...ds, [itemKey(item)]: { text: "" } }));
  }, []);
  const typeDraft = useCallback((item: BoardItem, text: string) => {
    setDrafts((ds) => ({ ...ds, [itemKey(item)]: { ...ds[itemKey(item)], text } }));
  }, []);
  const closeComposer = useCallback((item: BoardItem) => {
    setDrafts((ds) => {
      const next = { ...ds };
      delete next[itemKey(item)];
      return next;
    });
  }, []);
  const sendMessage = useCallback(
    (item: BoardItem, text: string) => {
      let payload;
      try {
        payload = buildMessagePayload(item, text, new Date(), newMessageId());
      } catch {
        return; // Blank text: Send is disabled, so this only guards against a stray submit.
      }
      setDrafts((ds) => ({ ...ds, [itemKey(item)]: { text: payload.text, message_id: payload.message_id } }));
      void delivery.message(payload);
    },
    [delivery],
  );

  const renderMessage = (item: BoardItem) => (
    <MessageAssistant
      item={item}
      draft={drafts[itemKey(item)]}
      latest={latest.get(itemKey(item))}
      webhookConfigured={WEBHOOK_CONFIGURED}
      onOpen={openComposer}
      onText={typeDraft}
      onClose={closeComposer}
      onSend={sendMessage}
    />
  );

  // High first, then medium, then low; oldest first within a level. Unsaved taps count already.
  // Shown as one section per level that has cards. Audit findings have their own tab.
  const [findingLocals, setFindingLocals] = useState<FindingAnswerMap>(() => loadFindingAnswers());
  const findingAnswersOf = (d: Decision) => {
    const fromAsks = answersFromAsks(board.asks, d.id, reviewFindings(d));
    const locals = answersForCard(d.id, findingLocals);
    // A later rewrite must not drop a Post / Don't post he already tapped.
    for (const f of reviewFindings(d)) {
      if (f.revision_at && !fromAsks.has(String(f.n))) {
        const loc = (locals.get(String(f.n)) ?? "").trim();
        if (!/^post$/i.test(loc) && !/^don't post(?: any)?$/i.test(loc)) locals.delete(String(f.n));
      }
    }
    return mergeFindingMaps(fromAsks, locals);
  };
  const openDecisions = sortByPriority(
    needsYou(board.decisions, answers, staleContext(board))
      .map((d) => (priorityOverride[d.id] ? { ...d, priority: priorityOverride[d.id] } : d))
      .filter((d) => !isPerFindingReview(d) || !allFindingsAnswered(d, board.asks, answersForCard(d.id, findingLocals))),
  );
  const queue = openDecisions.filter((d) => d.section !== "audit");
  const auditQueue = openDecisions.filter((d) => d.section === "audit");
  // Without a webhook, pending messages also explain the "not set up" marker.
  const marker = deliveryMarker(WEBHOOK_CONFIGURED ? answers : { ...answers, ...messages }, WEBHOOK_CONFIGURED);

  // New layout: open chevrons by item key, and review answers that went through from this browser.
  const [expanded, setExpanded] = useState<Record<string, true>>({});
  const [reviewLocals, setReviewLocals] = useState<ReviewLocals>(loadReviewLocals);

  // When the owner last opened each item (detail key -> ISO time), so a new Assistant reply shows an unread dot.
  // Once per load: send this browser's delivered notes and answers to the board, so the Conversation view has
  // the owner's side from any browser (the server skips ones it already has).
  useEffect(() => {
    // ab ask also drops anything older than board.reset_at (ab wipe), so a wiped board stays empty.
    for (const r of Object.values(loadMessages(window.localStorage))) if (r.status === "delivered") recordAsk(JSON.stringify(r.payload));
    for (const r of Object.values(loadAnswers(window.localStorage))) if (r.status === "delivered") recordAsk(JSON.stringify(r.payload));
  }, []);
  const [seen, setSeen] = useState<Record<string, string>>(() => loadSeen());
  const markSeen = useCallback((dk: string) => {
    setSeen((x) => {
      const next = { ...x, [dk]: new Date().toISOString() };
      saveSeen(next);
      return next;
    });
  }, []);
  useEffect(() => {
    if (view !== "focus" || !focus) return;
    const i = focus.indexOf("/");
    markSeen(`${focus.slice(0, i)}:${focus.slice(i + 1)}`);
  }, [view, focus, markSeen, board]);
  const toggle = (key: string) =>
    setExpanded((x) => {
      const next = { ...x };
      if (next[key]) delete next[key];
      else next[key] = true;
      return next;
    });

  // Notify open NoteBoxes when background deliverPendingMessages succeeds for a message.
  const prevMsgStatus = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const [id, rec] of Object.entries(messages)) {
      if (rec?.status === "delivered" && prevMsgStatus.current[id] && prevMsgStatus.current[id] !== "delivered") {
        window.dispatchEvent(new CustomEvent("action-board:note-delivered", { detail: { text: rec.payload?.text } }));
      }
      if (rec?.status) prevMsgStatus.current[id] = rec.status;
    }
  }, [messages]);

  // A reply box or quick action on an item: an item.message to the assistant, like "Message your assistant".
  // If an identical message failed earlier, retry the same message_id rather than queuing a duplicate.
  const sendNote = useCallback(
    async (item: BoardItem, text: string): Promise<boolean> => {
      let payload;
      try {
        payload = buildMessagePayload(item, text, new Date(), newMessageId());
      } catch {
        return false;
      }
      const existing = Object.entries(loadMessages(window.localStorage)).find(
        ([, r]) =>
          r &&
          r.status !== "delivered" &&
          r.payload?.item_id === payload.item_id &&
          r.payload?.item_section === payload.item_section &&
          r.payload?.text === payload.text,
      );
      const id = existing ? existing[0] : payload.message_id;
      if (existing) await delivery.deliverMessage(id);
      else await delivery.message(payload);
      return loadMessages(window.localStorage)[id]?.status === "delivered";
    },
    [delivery],
  );

  // Post, Skip, Edit then Post, or a note on a drafted review comment (comment null: the per-PR box).
  const onReview: OnReview = useCallback(
    async (d, c, action, text) => {
      const cid = c?.id ?? "pr";
      const k = reviewKey(d, cid);
      if (action !== "note") setReviewLocals((s) => ({ ...s, [k]: { status: "sending", action } }));
      const link = (board.glance.others ?? []).find((o) => prPath(o.link) === `${d.repo}/${d.pr}`)?.link;
      const payload: ReviewPayload = {
        event: "review.answer",
        decision_id: `review:${k}`,
        repo: d.repo,
        pr: d.pr,
        ...(link ? { pr_link: link } : {}),
        comment_id: cid,
        action,
        ...(text ? { text: postText(text) } : {}),
        ...(action === "post" && text !== undefined && c && postText(text) !== postText(c.body) ? { edited: true } : {}),
        ...(c ? { severity: c.severity, path: c.path, line: c.line, body: postText(c.body) } : {}),
        answered_at: new Date().toISOString(),
      };
      const { ok } = await delivery.review(payload);
      if (action !== "note")
        setReviewLocals((s) => {
          const next: ReviewLocals = { ...s, [k]: ok ? { status: action === "post" ? "posted" : "skipped", action, at: new Date().toISOString() } : { status: "failed", action } };
          try {
            window.localStorage.setItem(REVIEW_KEY, JSON.stringify(next));
          } catch {
            // Storage full or blocked: the board's own status still shows once the assistant records it.
          }
          return next;
        });
      if (ok) toast(`${d.repo} #${d.pr}: ${action === "post" ? "sent to Assistant to post on GitHub" : action === "skip" ? "skipped" : "note sent to Assistant"}`);
      return ok;
    },
    [delivery, board, toast],
  );

  const priorDecisionOf = (d: Decision) => {
    if (d.already_decided) return d.already_decided;
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const prev = board.decisions.find(
      (p) =>
        p.id !== d.id &&
        p.answer &&
        ((p.group && d.group && p.group === d.group) || (!d.group && !p.group)) &&
        (norm(p.question) === norm(d.question) || (p.title && d.title && norm(p.title) === norm(d.title))) &&
        (!d.sha || !p.sha || sameSha(d.sha, p.sha)),
    );
    return prev?.answer ? { answer: choiceText(prev.answer), source: prev.title ?? "earlier card", at: prev.answer.answered_at } : undefined;
  };

  const findingGuards = useRef(new Set<string>());
  const findingInflight = useRef(new Map<string, Promise<boolean>>());
  const answerFinding = async (d: Decision, finding: FindingPick, action: FindingAction, text?: string) => {
    const guard = `${d.id}:${finding}:${action}:${(text ?? "").trim()}`;
    // Same answer already saved, or the same send is already in flight: treat as success so the
    // finding grays out instead of showing "Could not send" on a second tap.
    if (findingGuards.current.has(guard)) return true;
    const inflight = findingInflight.current.get(guard);
    if (inflight) return inflight;
    const run = (async () => {
      let payload: ReviewPayload;
      try {
        payload = buildFindingPayload(d, finding, action, text, new Date());
      } catch {
        return false;
      }
      const { ok } = await delivery.review(payload);
      if (ok) {
        findingGuards.current.add(guard);
        const label = finding === "all" ? "Don't post any" : findingAnswerLabel(action, text);
        setFindingLocals((prev) => {
          const next = new Map(prev);
          next.set(findingStoreKey(d.id, finding), label);
          saveFindingAnswers(next);
          return next;
        });
        toast(finding === "all" ? "Answered: Don't post any" : `Answered #${finding}: ${label}`);
      }
      return ok;
    })();
    findingInflight.current.set(guard, run);
    try {
      return await run;
    } finally {
      findingInflight.current.delete(guard);
    }
  };

  const renderCard = (d: Decision, index: number, rich: boolean) => (
    <DecisionCard
      key={d.id}
      decision={d}
      index={index}
      onAnswer={choose}
      onClarify={requestClarify}
      clarify={clarifying[d.id]}
      now={now}
      onPriority={changePriority}
      priorityError={Boolean(priorityFailed[d.id])}
      onNotRelevant={markNotRelevant}
      notRelevant={notRelevant[d.id]}
      staleCtx={staleContext(board)}
      priorDecision={priorDecisionOf(d)}
      onAnswerFinding={answerFinding}
      findingAnswered={findingAnswersOf(d)}
      {...(rich ? decisionExtras(d) : {})}
    />
  );

  let classicIdx = 0;
  const renderNeeds = (rich: boolean) => (
    <section className="needs-you">
      {queue.length === 0 ? (
        <p className="empty">Nothing needs you here.</p>
      ) : (
        <>
          <h2 className="kicker">
            Needs you <span className="n">{queue.length}</span>
          </h2>
          <div className="queue">
            {rich ? (
              <TriageQueue cards={queue} board={board} answers={answers} renderCard={(d, index) => renderCard(d, index, true)} />
            ) : (
              groupByPriority(queue).map(({ level, items }) => (
                <section key={level} className="priority-section" data-level={level} aria-labelledby={`level-${level}`}>
                  <h3 className="priority-heading" id={`level-${level}`}>
                    {PRIORITY_LABEL[level]} <span className="n">{items.length}</span>
                  </h3>
                  <div className="queue-group">{items.map((d) => renderCard(d, ++classicIdx, false))}</div>
                </section>
              ))
            )}
          </div>
          <div className="queue-end" aria-hidden="true">
            End of queue
          </div>
        </>
      )}
    </section>
  );

  const footer = <footer className="footer">Board updated {new Date(board.updated_at).toLocaleString()}</footer>;
  const toastList = (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          {t.text}
        </div>
      ))}
    </div>
  );
  const markerEl = marker && (
    <span className="marker" role="status">
      {marker}
    </span>
  );

  if (!view) {
    return (
      <div className="page">
        <header className="top">
          <h1 className="wordmark">
            <span className="dot" aria-hidden="true" />
            Action Board
          </h1>
          {markerEl}
          <span className="top-meta">{headerDate(now)} · local</span>
        </header>

        <main className="shell">
          {renderNeeds(false)}
          <GlanceStrip glance={board.glance} renderMessage={renderMessage} />
        </main>

        {footer}
        {toastList}
      </div>
    );
  }

  const details: Record<string, ItemDetail> = board.details && typeof board.details === "object" ? board.details : {};
  const reviewDrafts = new Map((board.reviews ?? []).filter((r) => r && typeof r === "object").map((r): [string, ReviewDraft] => [`${r.repo}/${r.pr}`, r]));
  const others = sortOthers(board.glance.others ?? []);
  const reviews = others.filter(isReviewRequest);
  const mine: MyPR[] = Array.isArray(board.glance.mine) ? board.glance.mine : [];
  const urgent = queue.some((d) => effectivePriority(d) === "high");

  const prEntry = (o: (typeof others)[number]): Entry => {
    const path = prPath(o.link);
    const draft = path ? reviewDrafts.get(path) : undefined;
    const sum = draft && draftSummary(draft, reviewLocals);
    return {
      kind: "pr",
      id: path ?? slug(o.title),
      ref: glanceItem("others", o),
      section: "others",
      title: o.title,
      sub: prRef(o.link),
      link: o.link,
      cells: (
        <>
          <span className="meta">{o.author}</span>
          <span className="meta">{o.who}</span>
        </>
      ),
      badge: sum ? <span className={sum.done ? "draft-chip done" : "draft-chip"}>{sum.label}</span> : undefined,
      meta: [
        { label: "Author", value: o.author },
        { label: "Status", value: o.who },
      ],
      draft,
      status: {
        reviewRequested: isReviewRequest(o),
        pendingDrafts: sum ? (sum.done ? 0 : draft!.comments.length ? Number.parseInt(sum.label, 10) || 0 : 0) : undefined,
      },
    };
  };
  const ticketEntries: Entry[] = keyed("tickets", board.glance.tickets).map(({ item: t, ref }) => ({
    kind: "ticket",
    id: t.id,
    ref,
    section: "tickets",
    title: t.title,
    sub: t.id,
    link: t.link,
    cells: (
      <span>
        <span className={/review/i.test(t.status) ? "status review" : "status"}>{t.status}</span>
      </span>
    ),
    meta: [{ label: "Status", value: t.status }],
  }));
  const myEntries: Entry[] = keyed("mine", mine).map(({ item: m, ref }) => ({
    kind: "mypr",
    id: `${m.repo}/${m.number}`,
    ref,
    section: "mine",
    title: m.title,
    sub: `${m.repo} #${m.number}`,
    link: m.link,
    cells: (
      <>
        <span>
          <span className={`state-chip state-${slug(m.state)}`}>{m.state}</span>
        </span>
        <span>{m.ci ? <span className={`ci-chip ci-${m.ci}`}>{m.ci}</span> : <span className="meta">–</span>}</span>
        <span className="meta num-cell">{m.reviews ?? "–"}</span>
      </>
    ),
    status: { state: m.state, ci: m.ci },
    meta: [
      { label: "State", value: m.state },
      { label: "CI", value: m.ci ?? "unknown" },
      { label: "Reviews", value: m.reviews ?? "unknown" },
    ],
  }));
  const waitingEntries: Entry[] = keyed("waiting", board.glance.waiting).map(({ item: w, ref }) => ({
    kind: "waiting",
    id: slug(w.title),
    ref,
    section: "waiting",
    title: w.title,
    link: w.link,
    cells: <span className="meta">{w.who}</span>,
    status: { who: w.who },
    meta: [{ label: "Waiting on", value: w.who }],
  }));
  const otherEntries = others.map(prEntry);
  const reviewEntries = reviews.map(prEntry);

  const go = (v: View) => onSelect?.(v);
  const openFocus = (f: string) => onFocus?.(f);

  // What any item's chevron or focus page opens.
  const entryDetails = (e: Entry) => (
    <ItemDetails
      detail={details[detailKey(e.kind, e.id)]}
      itemKey={detailKey(e.kind, e.id)}
      asks={(board.asks ?? []).filter((a) => a.item_key === detailKey(e.kind, e.id))}
      extra={e.draft && <ReviewDrafts draft={e.draft} locals={reviewLocals} onReview={onReview} />}
      actions={DEFAULT_ACTIONS[e.kind]}
      onSend={(t) => sendNote(e.ref, t)}
      questionPrefix={e.kind === "ticket" ? `${e.id} ` : e.sub ? `${e.sub} ` : ""}
    />
  );

  function decisionExtras(d: Decision) {
    const key = `decision/${d.id}`;
    return {
      onFocus: () => openFocus(key),
      expanded: Boolean(expanded[key]) || view === "focus",
      onToggle: () => toggle(key),
      extra: <ItemDetails detail={details[detailKey("decision", d.id)]} actions={[]} onSend={(t) => sendNote(decisionItem(d), t)} />,
    };
  }

  const resetAt = board.reset_at ?? "";
  const myNotes = Object.fromEntries(Object.entries(loadMyNotes()).map(([k, ns]) => [k, ns.filter((n) => n.at > resetAt)]));
  // Answers the owner gave that the board may not have yet (sent from this browser a moment ago), as asks.
  const localAnswers: Ask[] = Object.entries(myNotes).flatMap(([k, ns]) =>
    ns.flatMap((n, i) => (n.reply ? [{ id: `local-${k}-${i}`, at: n.at, item_key: k, label: k, kind: "answer" as const, text: n.text, reply_to: n.reply }] : [])),
  );
  const statusOf = (e: Entry) => {
    const dk = detailKey(e.kind, e.id);
    const answered = new Set([...(board.asks ?? []), ...localAnswers].flatMap((n) => (n.item_key === dk && n.reply_to ? [n.reply_to] : [])));
    return itemStatus({ kind: e.kind, detail: details[dk], seenAt: seen[dk], answered, ...e.status });
  };
  // Every tab: "Needs you" first, then "In progress, not ready yet" collapsed, each row with a short reason.
  const rows = (entries: Entry[]) => {
    const tagged = entries.map((e) => ({ e, st: statusOf(e) }));
    const needs = tagged.filter((x) => x.st.needs);
    const later = tagged.filter((x) => !x.st.needs);
    const section = entries[0]?.section ?? "none";
    const groupKey = `group|${section}|${view}`;
    const open = Boolean(expanded[groupKey]);
    return (
      <>
        {needs.length > 0 ? (
          <li className="group-head needs-head">Needs you ({needs.length})</li>
        ) : (
          <li className="group-head needs-empty">Nothing needs you here</li>
        )}
        {needs.map((x) => row(x.e, x.st))}
        {later.length > 0 && (
          <li className="group-head">
            <button type="button" aria-expanded={open} onClick={() => toggle(groupKey)}>
              <span aria-hidden="true">{open ? "▾" : "▸"}</span> In progress, not ready yet ({later.length})
            </button>
          </li>
        )}
        {open && later.map((x) => row(x.e, x.st))}
      </>
    );
  };
  const row = (e: Entry, st: { needs: boolean; reason: string }) => {
      const key = focusOf(e);
      const dk = detailKey(e.kind, e.id);
      const unread = hasUnread(details[dk]?.thread, seen[dk]);
      return (
        <ExpandableRow
          key={`${e.section}|${key}`}
          itemId={e.ref.item_id}
          section={e.section}
          title={e.title}
          sub={e.kind === "ticket" ? undefined : e.sub}
          link={e.link}
          cells={e.kind === "ticket" ? <>{e.cells}</> : e.cells}
          badge={
            <>
              {unread && <span className="unread-dot" role="img" aria-label="New reply" title="New reply from Assistant" />}
              {approvalChipOf(e, st, details[dk]) ?? (
                <span className={st.needs ? "status-chip needs" : "status-chip"}>{st.reason}</span>
              )}
              {e.badge}
            </>
          }
          expanded={Boolean(expanded[`${e.section}|${key}`])}
          onToggle={() => {
            if (!expanded[`${e.section}|${key}`]) markSeen(dk);
            toggle(`${e.section}|${key}`);
          }}
          onFocus={() => {
            markSeen(dk);
            openFocus(key);
          }}
          after={renderMessage(e.ref)}
        >
          {entryDetails(e)}
        </ExpandableRow>
      );
  };

  // Conversation: names and refs of every item by detail key, the exchanges, and the open questions.
  const itemIndex: Record<string, { label: string; link?: string; ref: BoardItem }> = {};
  for (const e of [...ticketEntries, ...myEntries, ...waitingEntries, ...otherEntries])
    itemIndex[detailKey(e.kind, e.id)] = { label: e.kind === "ticket" ? `${e.id} ${e.title}` : e.sub ? `${e.sub} ${e.title}` : e.title, link: e.link, ref: e.ref };
  for (const d of board.decisions) itemIndex[`decision:${d.id}`] = { label: d.section === "audit" ? `Audit: ${d.title ?? d.question}` : (d.title ?? d.question), ref: decisionItem(d) };
  const detailRef = (k: string): { label: string; link?: string; ref: BoardItem } => {
    const ask = (board.asks ?? []).find((a) => a.item_key === k);
    const colon = k.indexOf(":");
    const kind = colon >= 0 ? k.slice(0, colon) : "decision";
    const id = colon >= 0 ? k.slice(colon + 1) : k;
    const sectionMap: Record<string, BoardItem["item_section"]> = { ticket: "tickets", mypr: "mine", pr: "others", waiting: "waiting", decision: "decision" };
    const item_section = sectionMap[kind] ?? "tickets";
    const summaryId = kind === "ticket" ? id : undefined;
    const safeAskLabel = ask?.label && !/^#+\s|\*\*Ticket:\*\*|\*\*Priority:\*\*/m.test(ask.label) ? ask.label : undefined;
    const sumText = summaryId ? board.ticket_summaries?.[summaryId] : undefined;
    const label = sumText ? `${id} ${sumText}` : (safeAskLabel ?? id);
    const link = ask?.link;
    return { label, ...(link ? { link } : {}), ref: { item_id: id, item_section, item_title: label, ...(link ? { item_link: link } : {}) } };
  };
  for (const k of [...Object.keys(details), ...(board.asks ?? []).map((a) => a.item_key)]) {
    if (!itemIndex[k]) itemIndex[k] = detailRef(k);
  }
  // This browser's own notes (plan answers like "PROJ-2512 Q3: ...") count until the server has them as asks.
  const localNotes: Ask[] = Object.entries(myNotes).flatMap(([k, ns]) =>
    ns.flatMap((n, i) => (!n.reply ? [{ id: `local-note-${k}-${i}`, at: n.at, item_key: k, label: k, kind: "note" as const, text: n.text }] : [])),
  );
  const serverAsks = board.asks ?? [];
  const findingAsks = localFindingAsks(findingLocals, board.decisions).filter(
    (l) => !serverAsks.some((a) => a.ref && l.ref && a.ref === l.ref),
  );
  const convoBoard = {
    ...board,
    asks: [
      ...serverAsks,
      ...localAnswers.filter((l) => !serverAsks.some((a) => a.reply_to === l.reply_to)),
      ...localNotes.filter((l) => !serverAsks.some((a) => a.item_key === l.item_key && a.text.trim() === l.text.trim())),
      ...findingAsks,
    ],
  };
  const topics = buildTopics(convoBoard, itemIndex, (d) => openDecisions.some((x) => x.id === d.id));
  const openQs = openCount(topics);
  const needsHuman = openQs > 0 || queue.length > 0 || auditQueue.length > 0;
  useNeedsYouBadge(needsHuman);
  const openItem = (key: string) => {
    const i = key.indexOf(":");
    markSeen(key);
    openFocus(`${key.slice(0, i)}/${key.slice(i + 1)}`);
  };
  const [, setConvoTick] = useState(0);
  // A plan question answered on its own (t103u): "PROJ-2512 Q3: his words", sent as an item message.
  const answeredPlans = useRef(new Set<string>());
  const answerPlan = async (key: string, label: string, text: string) => {
    const ref = itemIndex[key]?.ref;
    if (!ref) return false;
    const guard = `${key}|${label}`;
    if (answeredPlans.current.has(guard)) return false;
    answeredPlans.current.add(guard);
    const prefix = key.startsWith("ticket:") ? `${key.slice(7)} ` : "";
    const msg = `${prefix}${label}: ${text}`;
    const ok = await sendNote(ref, msg);
    if (ok) {
      rememberMyNote(key, { at: new Date().toISOString(), text: msg });
      setConvoTick((n) => n + 1);
    } else {
      answeredPlans.current.delete(guard);
    }
    return ok;
  };
  const answeredThreads = useRef(new Set<string>());
  const answerThread = async (key: string, q: ReplyQuestion, text: string) => {
    const ref = itemIndex[key]?.ref;
    if (!ref) return false;
    const guard = `${key}|${q.id}`;
    if (answeredThreads.current.has(guard)) return false;
    answeredThreads.current.add(guard);
    const ok = await sendNote(ref, `Answer to "${q.text}": ${text}`);
    if (ok) {
      rememberMyNote(key, { at: new Date().toISOString(), text, reply: q.id });
      setConvoTick((n) => n + 1);
    } else {
      answeredThreads.current.delete(guard);
    }
    return ok;
  };

  // Sidebar badges and tab headers show only the Needs-you count. Zero means no badge.
  const needsCount = (entries: Entry[]) => entries.filter((e) => statusOf(e).needs).length;
  const nav: { id: View; label: ReactNode; count?: number; urgent?: boolean }[] = [
    { id: "conversation", label: "Conversation", count: openQs, urgent: openQs > 0 },
    { id: "home", label: "Home", count: queue.length, urgent },
    { id: "tickets", label: "My tickets", count: needsCount(ticketEntries) },
    { id: "mine", label: "My PRs", count: needsCount(myEntries) },
    { id: "reviews", label: "Reviews", count: needsCount(reviewEntries) },
    { id: "waiting", label: "Waiting on others", count: needsCount(waitingEntries) },
    { id: "others", label: "Others' PRs", count: needsCount(otherEntries) },
    { id: "audit", label: "Audit", count: auditQueue.length, urgent: auditQueue.length > 0 },
    ...(project ? [{ id: "project" as const, label: projectLabel ?? "Project" }] : []),
  ];

  // Focus mode: find the item named in the hash.
  let focusView: ReactNode = null;
  if (view === "focus" && focus) {
    const slash = focus.indexOf("/");
    const kind = focus.slice(0, slash) as Kind;
    const id = focus.slice(slash + 1);
    const focusDecision = kind === "decision" ? board.decisions.find((x) => x.id === id) : undefined;
    const back = focusDecision?.section === "audit"
      ? { view: "audit" as View, label: "Audit" }
      : (KIND_BACK[kind] ?? KIND_BACK.decision);
    if (kind === "decision") {
      const d = queue.find((x) => x.id === id) ?? board.decisions.find((x) => x.id === id);
      focusView = (
        <FocusView backLabel={back.label} onBack={() => go(back.view)} kind="Decision" title={d?.title ?? d?.question ?? id}>
          {d ? (
            d.answer ? (
              <>
                <ContextBody text={d.context} />
                <CardSvg src={d.svg} />
                <p className="panel-empty">Answered: {String(d.answer.answer_label ?? d.answer.answer)}</p>
                <ItemDetails detail={details[detailKey("decision", d.id)]} actions={[]} onSend={(t) => sendNote(decisionItem(d), t)} />
              </>
            ) : (
              <DecisionCard
                decision={d}
                index={queue.indexOf(d) + 1}
                onAnswer={choose}
                onClarify={requestClarify}
                clarify={clarifying[d.id]}
                now={now}
                onPriority={changePriority}
                priorityError={Boolean(priorityFailed[d.id])}
                onNotRelevant={markNotRelevant}
                notRelevant={notRelevant[d.id]}
                staleCtx={staleContext(board)}
                priorDecision={priorDecisionOf(d)}
                onAnswerFinding={answerFinding}
                findingAnswered={findingAnswersOf(d)}
                {...decisionExtras(d)}
                onFocus={undefined}
              />
            )
          ) : (
            <p className="panel-empty">This decision is no longer on the board.</p>
          )}
        </FocusView>
      );
    } else {
      const pool = kind === "ticket" ? ticketEntries : kind === "mypr" ? myEntries : kind === "waiting" ? waitingEntries : otherEntries;
      const e = pool.find((x) => x.id === id);
      focusView = (
        <FocusView
          backLabel={back.label}
          onBack={() => go(back.view)}
          kind={KIND_LABEL[kind] ?? "Item"}
          title={e?.title ?? id}
          sub={e?.sub}
          link={e?.link}
          meta={e?.meta}
        >
          {e ? (
            <>
              {entryDetails(e)}
              <div className="focus-message">{renderMessage(e.ref)}</div>
            </>
          ) : (
            <p className="panel-empty">This item is no longer on the board.</p>
          )}
        </FocusView>
      );
    }
  }
  const navCurrent: View = view === "focus"
    ? (focus?.startsWith("decision/") && board.decisions.find((d) => d.id === focus.slice(9))?.section === "audit"
        ? "audit"
        : (KIND_BACK[(focus ?? "").split("/")[0] as Kind]?.view ?? "home"))
    : (view ?? "conversation");

  return (
    <div className="layout">
      <nav className="sidenav" aria-label="Views">
        <div className="sidenav-brand">
          <span className="dot" aria-hidden="true" />
          Action Board
        </div>
        <ul>
          {nav.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className="nav-item"
                aria-current={navCurrent === n.id ? "page" : undefined}
                data-view={n.id}
                onClick={() => go(n.id)}
              >
                <span className="nav-label">{n.label}</span>
                {n.count ? <span className={n.urgent ? "nav-count urgent" : "nav-count"}>{n.count}</span> : null}
              </button>
            </li>
          ))}
        </ul>
        <div className="sidenav-foot">{headerDate(now)} · local</div>
      </nav>

      <div className="content">
        {markerEl && <div className="content-marker">{markerEl}</div>}
        {view === "focus" && focusView}
        {view === "conversation" && (
          <Conversation topics={topics} briefs={board.briefs} details={details} onOpen={openItem} onAnswerThread={answerThread} onAnswerPlan={answerPlan} onAnswerDecision={choose} onAnswerFinding={answerFinding} />
        )}
        {view === "home" && (
          <div className="view">
            <header className="view-head">
              <h1>Home</h1>
              <p>What needs you now, most urgent first.</p>
            </header>
            {renderNeeds(true)}
            <PrTable title="Reviews waiting for your yes" count={needsCount(reviewEntries)} total={reviewEntries.length}>
              {rows(reviewEntries)}
            </PrTable>
          </div>
        )}
        {view === "tickets" && (
          <div className="view">
            <header className="view-head">
              <h1>My tickets</h1>
              <p>Tickets with no PR yet. Click a title to focus on it.</p>
            </header>
            {details["page:tickets"]?.plan && <PagePlan text={details["page:tickets"].plan} file={details["page:tickets"].plan_file} />}
            <WidePanel title="Tickets with no PR yet" count={needsCount(ticketEntries)} total={ticketEntries.length} head={["Ticket", "Status"]}>
              {rows(ticketEntries.map((e) => ({ ...e, title: `${e.id}  ${e.title}` })))}
            </WidePanel>
          </div>
        )}
        {view === "mine" && (
          <div className="view">
            <header className="view-head">
              <h1>My PRs</h1>
              <p>Your open pull requests.</p>
            </header>
            <WidePanel title="My open PRs" count={needsCount(myEntries)} total={myEntries.length} head={["Pull request", "State", "CI", "Reviews"]}>
              {rows(myEntries)}
            </WidePanel>
          </div>
        )}
        {view === "reviews" && (
          <div className="view">
            <header className="view-head">
              <h1>Reviews</h1>
              <p>Pull requests waiting on your review. Open a row to see the drafted comments.</p>
            </header>
            <PrTable title="Reviews waiting for your yes" count={needsCount(reviewEntries)} total={reviewEntries.length}>
              {rows(reviewEntries)}
            </PrTable>
          </div>
        )}
        {view === "waiting" && (
          <div className="view">
            <header className="view-head">
              <h1>Waiting on others</h1>
              <p>Things you are waiting on someone else for.</p>
            </header>
            <WidePanel title="Waiting on others" count={needsCount(waitingEntries)} total={waitingEntries.length} head={["Item", "Waiting on"]}>
              {rows(waitingEntries)}
            </WidePanel>
          </div>
        )}
        {view === "others" && (
          <div className="view">
            <header className="view-head">
              <h1>Others' PRs</h1>
              <p>Other people's open PRs that involve you.</p>
            </header>
            <PrTable title="Others' PRs with you" count={needsCount(otherEntries)} total={otherEntries.length}>
              {rows(otherEntries)}
            </PrTable>
          </div>
        )}
        {view === "audit" && (
          <div className="view">
            <header className="view-head">
              <h1>Audit</h1>
              <p>Audit findings and proposed bot changes. Apply one, skip it, or say how it should change.</p>
            </header>
            <section className="needs-you">
              {auditQueue.length === 0 ? (
                <p className="empty">Nothing needs you here.</p>
              ) : (
                <>
                  <h2 className="kicker">
                    Needs you <span className="n">{auditQueue.length}</span>
                  </h2>
                  <div className="queue">
                    {groupByPriority(auditQueue).map(({ level, items }) => (
                      <section key={level} className="priority-section" data-level={level} aria-labelledby={`audit-level-${level}`}>
                        <h3 className="priority-heading" id={`audit-level-${level}`}>
                          {PRIORITY_LABEL[level]} <span className="n">{items.length}</span>
                        </h3>
                        <div className="queue-group">
                          {items.map((d) => (
                            <DecisionCard
                              key={d.id}
                              decision={d}
                              index={auditQueue.indexOf(d) + 1}
                              onAnswer={choose}
                              onClarify={requestClarify}
                              clarify={clarifying[d.id]}
                              now={now}
                              onPriority={changePriority}
                              priorityError={Boolean(priorityFailed[d.id])}
                              onNotRelevant={markNotRelevant}
                              notRelevant={notRelevant[d.id]}
                              staleCtx={staleContext(board)}
                              priorDecision={priorDecisionOf(d)}
                              {...decisionExtras(d)}
                            />
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                </>
              )}
            </section>
          </div>
        )}
        {view === "project" && <div className="view">{project}</div>}
        {footer}
      </div>
      {toastList}
    </div>
  );
}

// A page-level plan above a list (e.g. the build order on My tickets), collapsible.
function PagePlan({ text, file }: { text: string; file?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="panel page-plan">
      <button type="button" className="chev-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="chev" aria-hidden="true" />
        {file ? file.replace(/\.md$/, "").replace(/[-_]/g, " ") : "Plan"}
      </button>
      {open && <Markdown text={text} className="md plan-md" />}
    </section>
  );
}

// A full-width list: a panel with column headings over table-like rows.
function WidePanel({ title, count, total, head, children }: { title: string; count: number; total?: number; head: string[]; children: ReactNode }) {
  const n = total ?? count;
  return (
    <section className={`panel wide cols-${head.length}`}>
      <h3>
        {title}
        {count > 0 && (
          <>
            {" "}
            <span className="n">{count}</span>
          </>
        )}
      </h3>
      {n === 0 ? (
        <p className="panel-empty">Nothing here.</p>
      ) : (
        <>
          <div className="list-head" aria-hidden="true">
            {head.map((h, i) => (
              <span key={i}>{h}</span>
            ))}
          </div>
          <ul>{children}</ul>
        </>
      )}
    </section>
  );
}

// Pull requests as a table: repo and number above the title, then author and what it waits on.
function PrTable({ title, count, total, children }: { title: string; count: number; total?: number; children: ReactNode }) {
  return (
    <WidePanel title={title} count={count} total={total} head={["Pull request", "Author", "Status"]}>
      {children}
    </WidePanel>
  );
}

function Item({ link, children }: { link?: string; children: ReactNode }) {
  if (!link) return <div className="item">{children}</div>;
  return (
    <a className="item" href={link} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function Panel({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="panel">
      <h3>
        {title} <span className="n">{count}</span>
      </h3>
      {count === 0 ? <p className="panel-empty">Nothing here.</p> : <ul>{children}</ul>}
    </section>
  );
}

type RenderMessage = (item: BoardItem) => ReactNode;

// React keys from item_id, so list items (and their composers) follow the item, not its position.
// A repeated item_id within one list gets a suffix to keep keys unique.
function keyed<T extends NonNullable<Board["glance"][GlanceSection]>[number]>(section: GlanceSection, items: T[]): { key: string; item: T; ref: BoardItem }[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const ref = glanceItem(section, item);
    const n = seen.get(ref.item_id) ?? 0;
    seen.set(ref.item_id, n + 1);
    return { key: n ? `${ref.item_id}#${n}` : ref.item_id, item, ref };
  });
}

function Row({ item, link, message, children }: { item: BoardItem; link?: string; message: RenderMessage; children: ReactNode }) {
  return (
    <li className="row" data-item-id={item.item_id} data-item-section={item.item_section}>
      <Item link={link}>{children}</Item>
      {message(item)}
    </li>
  );
}

function GlanceStrip({ glance, renderMessage }: { glance: Board["glance"]; renderMessage: RenderMessage }) {
  // Older files have no others list; treat it as empty.
  const others = sortOthers(glance.others ?? []);
  return (
    <aside className="glance">
      <Panel title="Waiting on others" count={glance.waiting.length}>
        {keyed("waiting", glance.waiting).map(({ key, item: w, ref }) => (
          <Row key={key} item={ref} link={w.link} message={renderMessage}>
            <span className="title">{w.title}</span>
            <span className="meta">{w.who}</span>
          </Row>
        ))}
      </Panel>
      <Panel title="Others' PRs with you" count={others.length}>
        {keyed("others", others).map(({ key, item: o, ref }) => (
          <Row key={key} item={ref} link={o.link} message={renderMessage}>
            <span className="title">{o.title}</span>
            <span className="meta">{`${o.author} · ${o.who}`}</span>
          </Row>
        ))}
      </Panel>
      <Panel title="Tickets with no PR yet" count={glance.tickets.length}>
        {keyed("tickets", glance.tickets).map(({ key, item: t, ref }) => (
          <Row key={key} item={ref} link={t.link} message={renderMessage}>
            <span className="title">
              <span className="tid">{t.id}</span>
              {t.title}
            </span>
            <span className={/review/i.test(t.status) ? "status review" : "status"}>{t.status}</span>
          </Row>
        ))}
      </Panel>
    </aside>
  );
}
