// Stable colors for option A / B / C, shared by the buttons and any SVG on the card.
const COLORS: Record<string, string> = {
  a: "#2563eb",
  b: "#c2410c",
  c: "#0f766e",
};

export function optionColor(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const k = id.toLowerCase();
  return COLORS[k] ?? COLORS[k.charAt(0)];
}

export function optionColorClass(id: string | undefined): string {
  if (!id) return "";
  const k = id.toLowerCase();
  if (COLORS[k]) return `opt-${k}`;
  const c = k.charAt(0);
  return COLORS[c] ? `opt-${c}` : "";
}
