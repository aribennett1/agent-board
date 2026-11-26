import type { ReactNode } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import php from "highlight.js/lib/languages/php";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";

// Small highlight.js core plus the languages cards actually use. Output is walked into
// React nodes (span.hljs-* and text only), so we never inject raw HTML.

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("php", php);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);

const ALIAS: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
};

export function resolveLang(lang?: string): string | undefined {
  if (!lang) return undefined;
  const key = lang.trim().toLowerCase();
  const id = ALIAS[key] ?? key;
  return hljs.getLanguage(id) ? id : undefined;
}

const HLJS_CLASS = /^hljs-[\w-]+$/;

function htmlToNodes(html: string, key: string): ReactNode[] {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstChild;
  if (!root) return [];
  const walk = (node: Node, k: string): ReactNode[] => {
    const out: ReactNode[] = [];
    node.childNodes.forEach((child, i) => {
      const ck = `${k}-${i}`;
      if (child.nodeType === Node.TEXT_NODE) {
        if (child.textContent) out.push(child.textContent);
        return;
      }
      if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName === "SPAN") {
        const cls = ((child as Element).getAttribute("class") ?? "")
          .split(/\s+/)
          .filter((c) => HLJS_CLASS.test(c))
          .join(" ");
        out.push(
          <span key={ck} className={cls || undefined}>
            {walk(child, ck)}
          </span>,
        );
        return;
      }
      const text = child.textContent;
      if (text) out.push(text);
    });
    return out;
  };
  return walk(root, key);
}

export function highlightCode(code: string, lang?: string, key = "hl"): ReactNode[] {
  const language = resolveLang(lang);
  if (!language) return [code];
  try {
    const html = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    const nodes = htmlToNodes(html, key);
    return nodes.length ? nodes : [code];
  } catch {
    return [code];
  }
}
