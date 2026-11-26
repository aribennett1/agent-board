// Who raised a card or thread on the Conversation tab. Stored as raised_by (ab raise --bot).
// Old cards with no field are inferred from the id prefix or an agent field; otherwise left blank.
// The assistant-card `bot` field is which bot a finding is for, not who raised it, so it is not used here.

export const BOARD_BOTS = ["Planner", "QA", "Engineer", "dr eggbot", "Grok Bot"] as const;
export type BoardBot = (typeof BOARD_BOTS)[number];

const NAMES = new Set<string>(BOARD_BOTS);

// Longer prefixes first so "grok-bot-" wins over "grok-".
const PREFIX: [string, BoardBot][] = [
  ["dr-eggbot-", "dr eggbot"],
  ["eggbot-", "dr eggbot"],
  ["grok-bot-", "Grok Bot"],
  ["grokbot-", "Grok Bot"],
  ["planner-", "Planner"],
  ["engineer-", "Engineer"],
  ["qa-", "QA"],
  ["grok-", "Grok Bot"],
];

export function isBoardBot(v: unknown): v is BoardBot {
  return typeof v === "string" && NAMES.has(v);
}

export function botPillClass(bot: BoardBot): string {
  const slug = bot === "dr eggbot" ? "eggbot" : bot === "Grok Bot" ? "grok" : bot.toLowerCase();
  return `bot-pill bot-pill-${slug}`;
}

export function raisedByFromId(id?: string | null): BoardBot | undefined {
  const s = String(id ?? "")
    .trim()
    .replace(/^(decision|ticket|pr|mypr|waiting):/, "")
    .toLowerCase();
  if (!s) return undefined;
  return PREFIX.find(([p]) => s.startsWith(p))?.[1];
}

export function raisedByOf(d: { id?: string; raised_by?: string | null; agent?: string | null }): BoardBot | undefined {
  if (isBoardBot(d.raised_by)) return d.raised_by;
  if (isBoardBot(d.agent)) return d.agent;
  return raisedByFromId(d.id);
}
