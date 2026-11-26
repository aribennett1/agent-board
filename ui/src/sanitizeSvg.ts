// An SVG made safe to show: no scripts, event handlers, foreign content or outside links.
export function sanitizeSvg(src: string): string | null {
  if (!/<svg[\s>]/i.test(src)) return null;
  let s = src.replace(/<\?xml[^>]*>/gi, "").replace(/<!DOCTYPE[^>]*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|foreignObject|iframe|object|embed|audio|video|style)\b[\s\S]*?<\/\1\s*>/gi, "").replace(/<(script|foreignObject|iframe|object|embed|audio|video|style)\b[^>]*\/?>/gi, "");
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/\s+(?:xlink:)?href\s*=\s*("|')(?!#)[^"']*\1/gi, "");
  s = s.replace(/javascript:/gi, "");
  return s.trim() ? s.trim() : null;
}
