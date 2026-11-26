// Detect unfenced code in card text so the UI can render it as a highlighted
// block without making agents follow a formatting rule. Conservative: prose
// with ticket links, times, or arrows stays prose.

const LANGS = [
  "php",
  "sql",
  "javascript",
  "typescript",
  "tsx",
  "jsx",
  "json",
  "bash",
  "shell",
  "diff",
  "ts",
  "js",
  "sh",
  "zsh",
  "python",
  "py",
  "rb",
  "ruby",
  "go",
  "rust",
  "css",
  "html",
  "xml",
  "yaml",
  "yml",
];

const LANG = LANGS.join("|");
const LANG_PREFIX = new RegExp(`^(${LANG})[ \\t]+(\\S[\\s\\S]*)$`, "i");
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /```|~~~/;
const FENCE_OPEN = /^\s*(```+|~~~+)/;

/** Strong markers: $var, ::, trailing ;, function, SELECT … FROM, braces, <?php. `->` alone is not enough. */
function hasStrongMarker(s: string): boolean {
  return (
    /\$[A-Za-z_]/.test(s) ||
    /::/.test(s) ||
    /;\s*$/.test(s) ||
    /\bfunction\s+\w+\s*\(/.test(s) ||
    /\bSELECT\b[\s\S]*\bFROM\b/i.test(s) ||
    /<\?php\b/.test(s) ||
    /[{}]/.test(s) ||
    /^(?:const|let|var|import|export)\s+\w+/m.test(s)
  );
}

function stripLangPrefix(s: string): { lang?: string; body: string } {
  const m = s.trimStart().match(LANG_PREFIX);
  if (!m) return { body: s };
  return { lang: m[1].toLowerCase(), body: m[2] };
}

function looksLikeProse(s: string): boolean {
  const t = s.trim();
  const words = t.split(/\s+/);
  // "See Foo::bar() for the check." or a sentence with a ticket link / time.
  if (
    words.length >= 4 &&
    /^[A-Z][a-z]/.test(t) &&
    !/[;{}]\s*$/.test(t) &&
    !/\$[A-Za-z_]/.test(t) &&
    !/<\?php\b/.test(t) &&
    !/\bfunction\s+\w+\s*\(/.test(t) &&
    !/\bSELECT\b[\s\S]*\bFROM\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

export function looksLikeCodeText(raw: string): boolean {
  const t = raw.trim();
  if (!t || FENCE.test(t)) return false;
  const { lang, body } = stripLangPrefix(t);
  if (!hasStrongMarker(body)) return false;
  if (lang) return true;
  if (looksLikeProse(body)) return false;
  return true;
}

export function guessLang(text: string): string | undefined {
  const { lang, body } = stripLangPrefix(text.trim());
  if (lang) return lang;
  if (/<\?php\b/.test(body) || (/\$[A-Za-z_]/.test(body) && /;|->|::/.test(body))) return "php";
  if (/\bSELECT\b[\s\S]*\bFROM\b/i.test(body)) return "sql";
  if (/^\s*(diff --git|--- |\+\+\+ |@@ )/m.test(body)) return "diff";
  if (/^\s*[{[]/.test(body) && /":/.test(body)) return "json";
  if (/^\s*(const|let|var|function|import|export)\s/m.test(body)) return "typescript";
  if (body.trimStart().startsWith("#!") || /^\s*(npm|yarn|pnpm)\s/m.test(body)) return "bash";
  return undefined;
}

function isFenceOpen(line: string): boolean {
  return FENCE_OPEN.test(line);
}

function isCodeContinuation(line: string, run: string[]): boolean {
  const t = line.trim();
  if (!t || isFenceOpen(line)) return false;
  if (looksLikeCodeText(t)) return true;
  if (/^[{}\])];?$/.test(t) || /^[.)]|^\.?\s*(->|::|\.|&&|\|\|)/.test(t)) return true;
  const soFar = run.join("\n");
  const opens = (soFar.match(/[({[]/g) ?? []).length;
  const closes = (soFar.match(/[)}\]]/g) ?? []).length;
  if (opens > closes && (line.startsWith(" ") || line.startsWith("\t") || /^[)\];,]/.test(t))) return true;
  return false;
}

function wrapRun(lang: string, bodyLines: string[], listPrefix?: string): string[] {
  const body = bodyLines.join("\n").replace(/^\n+|\n+$/g, "");
  const id = lang || "php";
  if (listPrefix !== undefined) {
    const pad = " ".repeat(Math.max(2, listPrefix.length));
    return [`${listPrefix}\`\`\`${id}`, ...body.split("\n").map((l) => pad + l), `${pad}\`\`\``];
  }
  return ["```" + id, body, "```"];
}

/**
 * Wrap unambiguous unfenced code runs in fences. Existing fences, tables,
 * headings, quotes, and prose (links, times, arrows) are left alone.
 */
export function promoteBareCode(text: string): string {
  if (typeof text !== "string" || !text) return text;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let close: string | null = null;
  while (i < lines.length) {
    const line = lines[i];
    if (close) {
      out.push(line);
      if (line.trim().startsWith(close)) close = null;
      i++;
      continue;
    }
    const open = line.match(/^\s*(```+|~~~+)/);
    if (open) {
      out.push(line);
      close = open[1];
      i++;
      continue;
    }
    if (/^\s*([>#]|-{2,}|\||#{1,6}\s)/.test(line) && !looksLikeCodeText(line)) {
      out.push(line);
      i++;
      continue;
    }
    const list = line.match(LIST);
    const content = list ? list[3] : line;
    const contentFence = typeof content === "string" ? content.match(/^(```+|~~~+)/) : null;
    if (list && contentFence) {
      out.push(line);
      close = contentFence[1];
      i++;
      continue;
    }
    if (!looksLikeCodeText(content)) {
      out.push(line);
      i++;
      continue;
    }
    const first = stripLangPrefix(content);
    const run: string[] = [first.body];
    const prefix = list ? list[1] + list[2] + " " : undefined;
    const lang = first.lang ?? guessLang(first.body);
    i++;
    while (i < lines.length) {
      if (close || isFenceOpen(lines[i])) break;
      if (list && LIST.test(lines[i])) break;
      if (list && !/^\s{2,}\S/.test(lines[i]) && lines[i].trim() && !isCodeContinuation(lines[i], run)) break;
      if (!list && !lines[i].trim()) break;
      if (!list && /^\s*([>#]|#{1,6}\s)/.test(lines[i])) break;
      if (!isCodeContinuation(lines[i], run) && !looksLikeCodeText(lines[i])) break;
      const nxt = list ? lines[i].replace(/^\s{2,}/, (s) => (s.startsWith("  ") ? s.slice(2) : s)) : lines[i];
      run.push(stripLangPrefix(nxt).body);
      i++;
    }
    out.push(...wrapRun(lang ?? guessLang(run.join("\n")) ?? "", run, prefix));
  }
  return out.join("\n");
}
