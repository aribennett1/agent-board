// Review comment bodies are raw Markdown: `$a->b` must stay `->`. Drafts copied from GitHub HTML or agent output can
// arrive with HTML entities (`-&gt;`), and React would then show them literally. Decode the common ones in one pass,
// so `&amp;gt;` becomes `&gt;` (not `>`).
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#39|#x27|nbsp);/g, (_, name: string) => ENTITIES[name]);
}

// The exact text to show and to post on GitHub: entities decoded, and ```suggestions fences turned into GitHub's
// ```suggestion so the block renders as a suggested change.
export function postText(text: string): string {
  return decodeEntities(text).replace(/^(\s*)```suggestions\b/gm, "$1```suggestion");
}
