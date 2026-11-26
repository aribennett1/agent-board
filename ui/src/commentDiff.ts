// Line-and-word diff of an already-posted comment against the proposed new text.
// Unchanged runs are collapsed so the card shows what actually changes, not two full copies.

export type DiffKind = "same" | "del" | "ins";
export type WordSeg = { kind: DiffKind; text: string };
export type DiffRow =
  | { kind: "same"; text: string }
  | { kind: "del"; segs: WordSeg[] }
  | { kind: "ins"; segs: WordSeg[] }
  | { kind: "omit"; count: number };

function linesOf(s: string): string[] {
  return s.replace(/\r\n/g, "\n").split("\n");
}

function lcs(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

type Op = { kind: DiffKind; text: string };

function opsFor(a: string[], b: string[]): Op[] {
  const dp = lcs(a, b);
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "ins", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "ins", text: b[j++] });
  return out;
}

function wordSegs(before: string, after: string): { del: WordSeg[]; ins: WordSeg[] } {
  const ops = opsFor(before.split(/(\s+)/), after.split(/(\s+)/));
  return {
    del: ops.filter((o) => o.kind !== "ins").map((o) => ({ kind: o.kind === "same" ? "same" : "del", text: o.text })),
    ins: ops.filter((o) => o.kind !== "del").map((o) => ({ kind: o.kind === "same" ? "same" : "ins", text: o.text })),
  };
}

function asSegs(text: string, kind: "del" | "ins"): WordSeg[] {
  return [{ kind, text }];
}

// Keep one unchanged line of context on each side of a change; collapse the rest.
const CONTEXT = 1;

export function commentDiff(before: string, after: string): DiffRow[] {
  const ops = opsFor(linesOf(before), linesOf(after));
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === "same") {
      let j = i;
      while (j < ops.length && ops[j].kind === "same") j++;
      const run = ops.slice(i, j);
      const touchedBefore = i > 0;
      const touchedAfter = j < ops.length;
      if (!touchedBefore && !touchedAfter) {
        // Identical texts: don't hide the whole comment behind an omit.
        for (const o of run) rows.push({ kind: "same", text: o.text });
      } else if (run.length <= CONTEXT * 2) {
        for (const o of run) rows.push({ kind: "same", text: o.text });
      } else {
        const head = touchedBefore ? CONTEXT : 0;
        const tail = touchedAfter ? CONTEXT : 0;
        const omit = run.length - head - tail;
        for (let k = 0; k < head; k++) rows.push({ kind: "same", text: run[k].text });
        if (omit > 0) rows.push({ kind: "omit", count: omit });
        for (let k = run.length - tail; k < run.length; k++) rows.push({ kind: "same", text: run[k].text });
      }
      i = j;
      continue;
    }
    // Pair a run of deletions with the following run of insertions so word-level
    // highlights work on lines that only changed in part.
    let j = i;
    while (j < ops.length && ops[j].kind === "del") j++;
    const dels = ops.slice(i, j);
    let k = j;
    while (k < ops.length && ops[k].kind === "ins") k++;
    const ins = ops.slice(j, k);
    const n = Math.min(dels.length, ins.length);
    for (let t = 0; t < n; t++) {
      const w = wordSegs(dels[t].text, ins[t].text);
      rows.push({ kind: "del", segs: w.del });
      rows.push({ kind: "ins", segs: w.ins });
    }
    for (let t = n; t < dels.length; t++) rows.push({ kind: "del", segs: asSegs(dels[t].text, "del") });
    for (let t = n; t < ins.length; t++) rows.push({ kind: "ins", segs: asSegs(ins[t].text, "ins") });
    i = k;
  }
  return rows;
}

export function isCommentEdit(d: { current_text?: string; post_text?: string | null }): boolean {
  return Boolean(d.current_text?.trim()) && typeof d.post_text === "string" && Boolean(d.post_text.trim());
}
