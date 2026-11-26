import { inline, hasFence, Markdown } from "./markdown";
import { promoteBareCode } from "./bareCode";

export type ContextBlock = { type: "p"; text: string } | { type: "list"; items: string[] };

// Split context into short paragraphs or bullet lists (blank lines separate blocks).
export function contextBlocks(text: string): ContextBlock[] {
  const out: ContextBlock[] = [];
  for (const chunk of text.trim().split(/\n\s*\n/)) {
    const items: string[] = [];
    let allList = true;
    for (const line of chunk.split("\n")) {
      const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
      if (m) items.push(m[1]);
      else if (line.trim()) allList = false;
    }
    if (allList && items.length) out.push({ type: "list", items });
    else if (chunk.trim()) out.push({ type: "p", text: chunk.trim() });
  }
  return out;
}

export function ContextBody({ text }: { text?: string }) {
  const raw = text?.trim();
  if (!raw) return null;
  if (hasFence(promoteBareCode(raw))) return <Markdown text={raw} className="md context" />;
  const blocks = contextBlocks(raw);
  return (
    <div className="context">
      {blocks.map((b, i) =>
        b.type === "list" ? (
          <ul key={i}>
            {b.items.map((t, j) => (
              <li key={j}>{inline(t, `ctx-${i}-${j}`)}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{inline(b.text, `ctx-${i}`)}</p>
        ),
      )}
    </div>
  );
}
