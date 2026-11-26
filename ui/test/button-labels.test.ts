// No board button may be labelled just "Send" (or a vague equivalent like "Submit" or "Go").
// Actions that go to the assistant are "Send to Grok Bot"; actions that post publicly are "Post to GitHub".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const BANNED = new Set(["Send", "Submit", "Go", "Send answer"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name.endsWith(".pre-myprs") || name === "node_modules") continue;
      out.push(...walk(p));
    } else if (/\.(tsx|ts)$/.test(name) && !name.includes(".pre-")) out.push(p);
  }
  return out;
}

function labelsIn(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\bbutton\s*=\s*(?:["']([^"']+)["']|\{["']([^"']+)["']\})/g)) {
    out.push((m[1] ?? m[2]).trim());
  }
  for (const m of src.matchAll(/<button\b[^>]*>\s*\{[^}]*\?\s*["']([^"']+)["']\s*:\s*["']([^"']+)["']\s*\}/g)) {
    out.push(m[1].trim(), m[2].trim());
  }
  for (const m of src.matchAll(/<button\b[^>]*>\s*([^<>{}\n]+?)\s*<\/button>/g)) {
    out.push(m[1].trim());
  }
  return out.filter(Boolean);
}

describe("button labels", () => {
  it("no button is labelled exactly Send, Submit, Go, or Send answer", () => {
    const found: string[] = [];
    for (const file of walk(SRC)) {
      for (const label of labelsIn(readFileSync(file, "utf8"))) {
        if (BANNED.has(label)) found.push(`${file.slice(SRC.length + 1)}: "${label}"`);
      }
    }
    expect(found).toEqual([]);
  });
});
