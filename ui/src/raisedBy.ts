// Who raised a card or thread on the Conversation tab, from data the card already has, in this order:
//   1. raised_by (set by ab raise --bot, or by the server for cards it derives from task notes), 2. an agent field,
//   3. the id prefix (planner-, qa-, engineer-, eggbot-, grok-), 4. the Planner's own work attached to it: a ticket
//   or plan filed on the card (decision:<id>) or on its ticket group (ticket:ROWS-1234). Otherwise unknown.
// --bot is optional and nothing depends on a bot passing it.
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

type DetailsLike = Record<string, { ticket?: string; plan?: string } | undefined>;

// ab ticket and ab plan are how the Planner files a ticket intake or a plan, so a card that carries one is the Planner's.
function plannerFiled(d: { id?: string; group?: string | null }, details?: DetailsLike): boolean {
  if (!details) return false;
  const has = (k: string) => Boolean(details[k]?.ticket || details[k]?.plan);
  if (d.id && has(`decision:${d.id}`)) return true;
  const g = String(d.group ?? "").trim().replace(/^ticket:/, "");
  return /^[A-Za-z]+-\d+$/.test(g) && has(`ticket:${g.toUpperCase()}`);
}

export function raisedByOf(d: { id?: string; group?: string | null; raised_by?: string | null; agent?: string | null; bot?: string | null }, details?: DetailsLike): BoardBot | undefined {
  if (isBoardBot(d.raised_by)) return d.raised_by;
  if (isBoardBot(d.agent)) return d.agent;
  return raisedByFromId(d.id) ?? (plannerFiled(d, details) ? "Planner" : undefined);
}
