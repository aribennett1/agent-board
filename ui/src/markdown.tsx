import { annotateTickets } from "./ticketRefs";
import { highlightCode } from "./highlight";
import type { ReactNode } from "react";

// A small Markdown renderer for plans and review comments: headings, paragraphs, lists, block quotes, tables,
// fenced code, rules, and inline code, bold, italic and links. Builds React elements only (no HTML injection).

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function hasFence(text: string): boolean {
  return /^\s*(```|~~~)/m.test(text);
}

export function RichText({ text, k = "t", className = "md md-frag" }: { text: string; k?: string; className?: string }) {
  if (hasFence(text)) return <Markdown text={text} className={className} />;
  return <>{inline(text, k)}</>;
}

// Inline: `code`, **bold**, *italic* / _italic_, ++underline++ or <u>underline</u>, ==highlight==, [text](url) and
// bare http(s) URLs.
export function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`+)([\s\S]+?)\1|\+\+([^+]+?)\+\+|<u>([\s\S]+?)<\/u>|==([^=]+?)==|\*\*([^*]+?)\*\*|__([^_]+?)__|\[([^\]]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)([^*]+?)\*(?!\w)|(?<![\w_])_(?!\s)([^_]+?)_(?!\w)|(https?:\/\/[^\s)<]+[^\s)<.,;:!?'"])/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}-${n++}`;
    if (m[2] !== undefined) out.push(<code key={k}>{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<u key={k}>{inline(m[3] ?? m[4], k)}</u>);
    else if (m[5] !== undefined) out.push(<mark key={k}>{inline(m[5], k)}</mark>);
    else if (m[6] !== undefined || m[7] !== undefined) out.push(<strong key={k}>{inline(m[6] ?? m[7], k)}</strong>);
    else if (m[8] !== undefined) {
      out.push(
        SAFE_URL.test(m[9]) ? (
          <a key={k} className="card-link" href={m[9]} target="_blank" rel="noopener noreferrer">
            {inline(m[8], k)}
          </a>
        ) : (
          m[0]
        ),
      );
    } else if (m[10] !== undefined || m[11] !== undefined) out.push(<em key={k}>{inline(m[10] ?? m[11], k)}</em>);
    else if (m[12] !== undefined)
      out.push(
        <a key={k} className="card-link" href={m[12]} target="_blank" rel="noopener noreferrer">
          {m[12]}
        </a>,
      );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

type ListItem = { depth: number; text: string; ordered: boolean };

function itemBody(text: string, key: string): ReactNode {
  return hasFence(text) ? <Markdown text={text} className="md-li" /> : inline(text, key);
}

function renderList(items: ListItem[], ordered: boolean, key: string): ReactNode {
  // Nest by indentation: deeper items belong to the item above them.
  const roots: { text: string; children: ListItem[] }[] = [];
  const base = Math.min(...items.map((i) => i.depth));
  for (const it of items) {
    if (it.depth > base && roots.length) roots[roots.length - 1].children.push(it);
    else roots.push({ text: it.text, children: [] });
  }
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag key={key}>
      {roots.map((r, i) => (
        <li key={i}>
          {itemBody(r.text, `${key}-${i}`)}
          {r.children.length > 0 && renderList(r.children, r.children[0].ordered, `${key}-${i}-c`)}
        </li>
      ))}
    </Tag>
  );
}

function fenceOpen(line: string): { close: string; lang: string } | null {
  const m = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
  return m ? { close: m[1], lang: m[2] } : null;
}

function codeBlock(key: string, lang: string, body: string): ReactNode {
  return (
    <pre key={key} className="md-code" data-lang={lang || undefined}>
      {lang ? <span className="md-code-lang">{lang}</span> : null}
      <code className={lang ? `language-${lang}` : undefined}>{highlightCode(body, lang, key)}</code>
    </pre>
  );
}

export function Markdown({ text: raw, className = "md" }: { text: string; className?: string }) {
  const text = annotateTickets(raw);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  const isList = (l: string) => /^(\s*)([-*+]|\d+[.)])\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${b++}`;
    const fence = fenceOpen(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence.close)) body.push(lines[i++]);
      i++;
      blocks.push(codeBlock(key, fence.lang, body.join("\n")));
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(h[1].length + 2, 6);
      const Tag = `h${level}` as "h3";
      blocks.push(
        <Tag key={key} className={`md-h md-h${h[1].length}`}>
          {inline(h[2].replace(/\s+#+\s*$/, ""), key)}
        </Tag>,
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, `${key}-h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, j) => (
                    <td key={j}>{inline(c, `${key}-${ri}-${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      // Colored callouts: > [!NOTE] / [!TIP] / [!WARNING] / [!JOKE] on the first line.
      const kind = /^\[!(NOTE|TIP|WARNING|JOKE)\]\s*/i.exec(body[0] ?? "");
      if (kind) {
        body[0] = body[0].slice(kind[0].length);
        blocks.push(
          <div key={key} className={`callout callout-${kind[1].toLowerCase()}`}>
            <Markdown text={body.join("\n")} className="md-callout" />
          </div>,
        );
        continue;
      }
      blocks.push(
        <blockquote key={key}>
          <Markdown text={body.join("\n")} className="md-quote" />
        </blockquote>,
      );
      continue;
    }
    if (isList(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: ListItem[] = [];
      let close: string | null = null;
      const dropListIndent = (s: string) => (s.startsWith("  ") ? s.slice(2) : s);
      while (i < lines.length) {
        if (close) {
          items[items.length - 1].text += "\n" + dropListIndent(lines[i]);
          if (lines[i].trim().startsWith(close)) close = null;
          i++;
          continue;
        }
        if (isList(lines[i])) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          if (!m) break;
          items.push({ depth: m[1].length, text: m[3], ordered: /\d/.test(m[2]) });
          const open = fenceOpen(m[3]);
          if (open) close = open.close;
          i++;
          continue;
        }
        if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          const trimmed = dropListIndent(lines[i]);
          const open = fenceOpen(trimmed);
          if (open) {
            items[items.length - 1].text += "\n" + trimmed.trimStart();
            close = open.close;
          } else {
            items[items.length - 1].text += " " + lines[i].trim();
          }
          i++;
          continue;
        }
        break;
      }
      blocks.push(renderList(items, ordered, key));
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*(```|~~~)/.test(lines[i]) &&
      !isList(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*\|/.test(lines[i])
    )
      para.push(lines[i++].trim());
    if (para.length === 0) {
      // A line no rule took (e.g. a lone "|"): show it as text rather than loop.
      para.push(lines[i++].trim());
    }
    blocks.push(<p key={key}>{inline(para.join(" "), key)}</p>);
  }
  return <div className={className}>{blocks}</div>;
}
