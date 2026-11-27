// Incremental board refresh, shared by the server (src/board-view.ts) and the page (useLiveBoard.ts). The board is cut
// into parts: one per card, ask, notification, review, PR row and detail entry, and one per other top-level value. A
// refresh with ?since=<version> sends only the parts that changed, the parts that went away, and the id order of any
// list whose order changed. The page puts the board back together from what it already had. Pure: no DOM, no Node.

type Json = Record<string, unknown>;

/** Lists cut into one part per item, and how each item is named. */
const LISTS: Record<string, (x: any) => string> = {
  decisions: (x) => String(x?.id),
  asks: (x) => String(x?.id),
  notifications: (x) => String(x?.id),
  reviews: (x) => `${x?.repo}/${x?.pr}`,
  "glance.others": (x) => String(x?.link ?? `${x?.repo}#${x?.number}`),
  "glance.mine": (x) => String(x?.link ?? `${x?.repo}#${x?.number}`),
};
/** Objects cut into one part per key. */
const MAPS = new Set(["details"]);
/** Objects whose own keys are kept in order, each value a part (or a list or map above). */
const NESTED = new Set(["glance"]);

const SEP = "\u0001";
export type Flat = { version: string; order: Record<string, string[]>; parts: Record<string, unknown> };
export type Delta = { delta: true; since: string; version: string; order: Record<string, string[]>; set: Record<string, unknown>; drop: string[] };

function flattenInto(path: string, value: unknown, order: Flat["order"], parts: Flat["parts"]) {
  const name = LISTS[path];
  if (name && Array.isArray(value)) {
    const seen = new Map<string, number>();
    order[path] = value.map((item) => {
      const id = name(item);
      const n = seen.get(id) ?? 0;
      seen.set(id, n + 1);
      const key = n ? `${id}#${n}` : id;
      parts[`${path}${SEP}${key}`] = item;
      return key;
    });
    return;
  }
  if ((MAPS.has(path) || NESTED.has(path)) && value && typeof value === "object" && !Array.isArray(value)) {
    order[path] = Object.keys(value as Json);
    for (const [k, v] of Object.entries(value as Json)) {
      if (NESTED.has(path)) flattenInto(`${path}.${k}`, v, order, parts);
      else parts[`${path}${SEP}${k}`] = v;
    }
    return;
  }
  parts[path] = value;
}

/** The board cut into parts. The top level's own keys are order[""]. */
export function flattenBoard(board: Json, version: string): Flat {
  const order: Flat["order"] = { "": Object.keys(board) };
  const parts: Flat["parts"] = {};
  for (const [k, v] of Object.entries(board)) flattenInto(k, v, order, parts);
  return { version, order, parts };
}

function build(path: string, f: Flat): unknown {
  const keys = f.order[path];
  if (keys && LISTS[path]) return keys.map((k) => f.parts[`${path}${SEP}${k}`]);
  if (keys && MAPS.has(path)) return Object.fromEntries(keys.map((k) => [k, f.parts[`${path}${SEP}${k}`]]));
  if (keys && NESTED.has(path)) return Object.fromEntries(keys.map((k) => [k, build(`${path}.${k}`, f)]));
  return f.parts[path];
}

/** The board back from its parts. */
export function unflattenBoard(f: Flat): Json {
  return Object.fromEntries((f.order[""] ?? []).map((k) => [k, build(k, f)]));
}

/** Every part key the order lists name, so a delta that leaves one out is caught. */
function needed(f: Flat): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    const keys = f.order[path];
    if (keys && (LISTS[path] || MAPS.has(path))) for (const k of keys) out.push(`${path}${SEP}${k}`);
    else if (keys && NESTED.has(path)) for (const k of keys) walk(`${path}.${k}`);
    else out.push(path);
  };
  for (const k of f.order[""] ?? []) walk(k);
  return out;
}

export type Fingerprint = { parts: Map<string, string>; order: Map<string, string> };

/** What the server remembers about a version it sent: a hash per part and per order list. */
export function fingerprint(f: Flat, hash: (s: string) => string): Fingerprint {
  return {
    parts: new Map(Object.entries(f.parts).map(([k, v]) => [k, hash(JSON.stringify(v) ?? "undefined")])),
    order: new Map(Object.entries(f.order).map(([k, v]) => [k, hash(JSON.stringify(v))])),
  };
}

/** The change from a version the page has (its fingerprint) to the current board. */
export function diffBoard(prev: Fingerprint, since: string, next: Flat, nextPrint: Fingerprint): Delta {
  const set: Delta["set"] = {};
  const order: Delta["order"] = {};
  for (const [k, h] of nextPrint.parts) if (prev.parts.get(k) !== h) set[k] = next.parts[k];
  for (const [k, h] of nextPrint.order) if (prev.order.get(k) !== h) order[k] = next.order[k];
  const drop = [...prev.parts.keys()].filter((k) => !nextPrint.parts.has(k));
  return { delta: true, since, version: next.version, order, set, drop };
}

export const isDelta = (v: unknown): v is Delta => !!v && typeof v === "object" && (v as Delta).delta === true && typeof (v as Delta).version === "string";

/** The page's next board parts, or null when the delta does not fit what it has (then it loads the whole board). */
export function applyDelta(prev: Flat, d: Delta): Flat | null {
  if (d.since !== prev.version) return null;
  const parts = { ...prev.parts };
  for (const k of d.drop) delete parts[k];
  Object.assign(parts, d.set);
  const order: Flat["order"] = { ...prev.order, ...d.order };
  // Lists and maps that went away entirely lose their order entry.
  const next: Flat = { version: d.version, order, parts };
  for (const k of needed(next)) if (!(k in parts)) return null;
  return next;
}
