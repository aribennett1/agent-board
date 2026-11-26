// Standing rule: any board text that mentions another ticket shows a short summary of it. App registers
// board.ticket_summaries here on each render; Markdown adds "(summary)" after the first mention of each key in a text,
// unless the text already explains it right there (a ":" or "—" title, or an opening parenthesis), or the key is
// inside code, a URL or a branch name.
let summaries: Record<string, string> = {};
export function setTicketSummaries(m: Record<string, string> | undefined) {
  summaries = m ?? {};
}

export function annotateTickets(text: string): string {
  if (!Object.keys(summaries).length || !/[A-Z]+-\d/.test(text)) return text;
  const seen = new Set<string>();
  // Leave fenced code blocks alone.
  return text
    .split(/(```[\s\S]*?```)/)
    .map((part) =>
      part.startsWith("```")
        ? part
        : part.replace(/(`[^`\n]*`)|([A-Z][A-Z0-9]+-\d{2,6})\b/g, (m: string, code: string | undefined, key: string | undefined, off: number, all: string) => {
            if (code || !key) return m;
            const s = summaries[key];
            if (!s || seen.has(key)) return m;
            const before = all.slice(Math.max(0, off - 1), off);
            if (/[/\-_\w]/.test(before)) return m; // URL path, branch name, or part of a longer word
            const after = all.slice(off + key.length, off + key.length + 4);
            seen.add(key);
            if (/^\*{0,2}\s*[:—–(]|^\*{0,2}\s+-\s/.test(after) || /^[/\-_\w]/.test(after)) return m;
            return `${key} (${s})`;
          }),
    )
    .join("");
}
