import type { BoardBot } from "./raisedBy";

// The bots a card can be sent to. Grok Bot is only offered when it is the card's default (no known author).
export const PICKABLE: BoardBot[] = ["Planner", "QA", "Engineer", "dr eggbot"];
export const DEFAULT_BOT: BoardBot = "Grok Bot";

// Split send button: the send button beside it reads "Send to <bot>" for the default; this picker sends to another bot.
export function RecipientPicker({ value, onChange }: { value: BoardBot; onChange: (b: BoardBot) => void }) {
  const options = PICKABLE.includes(value) ? PICKABLE : [...PICKABLE, value];
  return (
    <select className="recipient-picker" aria-label="Send to a different bot" value={value} onChange={(e) => onChange(e.target.value as BoardBot)}>
      {options.map((b) => (
        <option key={b} value={b}>
          {b}
        </option>
      ))}
    </select>
  );
}
