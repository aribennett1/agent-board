// GitHub facts for the board, read with the user's gh CLI (read only: nothing is posted).
//  - ciReport: for a PR whose CI is failing, each failed check with a link and a trimmed excerpt of what failed.
//  - changesFacts: for a PR with changes requested, who asked and when, each open review comment (file:line + quote),
//    and the scope (files, size, overlap with the CI failure). The plain-words brief and questions are written by
//    the assistant with `ab detail <key> '{"review_brief":"...","review_brief_sig":"<sig>"}'`.
//  - approval: for a teammate PR, "approved", or "ready" when every check on the latest commit passed and there are
//    no unresolved review threads and no standing change requests. "ready" is a fact; itemStatus decides whether
//    that means Needs you (a review request still waiting on a draft is parked as Review running).
import { execFileSync } from "node:child_process";

const OWNER = process.env.AB_GH_OWNER || "example-org";
const GH = process.env.AB_GH || "gh";
const ENV = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` };

function gh(args) {
  return execFileSync(GH, args, { encoding: "utf8", env: ENV, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
}

const PR_QUERY = `query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){
reviewDecision headRefOid additions deletions url
files(first:100){nodes{path additions deletions}}
reviews(last:50){nodes{author{login} state submittedAt url body}}
reviewThreads(first:100){nodes{isResolved isOutdated path line originalLine comments(first:20){nodes{author{login} body url createdAt}}}}
commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{name conclusion status detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}
}}}`;

export function prData(repo, number) {
  const out = gh(["api", "graphql", "-f", `query=${PR_QUERY}`, "-F", `o=${OWNER}`, "-F", `r=${repo}`, "-F", `n=${number}`]);
  return JSON.parse(out).data.repository.pullRequest;
}

// ---------- pure helpers (tested) ----------

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\^\[\[[0-9;?]*[A-Za-z]/g;
// "job\tstep\t2026-11-24T17:30:41.4953070Z text" -> "text"
export function cleanLog(log) {
  return log
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(ANSI, "").replace(/^[^\t]*\t[^\t]*\t/, "").replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").replace(/\s+$/, ""));
}

// The useful part of a failed job log: PHPStan error tables, failing tests with their assertion and location,
// coverage shortfalls, other error lines; else the lines before the failing step's exit. At most `max` lines.
export function extractFailure(log, max = 40) {
  const L = cleanLog(log);
  const keep = new Set();
  const add = (a, b) => { for (let i = Math.max(0, a); i <= Math.min(L.length - 1, b); i++) keep.add(i); };
  L.forEach((l, i) => {
    // PHPStan: the table from the first dashed rule above "Line  file" to "[ERROR] Found N error(s)".
    if (/^\s*\[ERROR\] Found \d+ errors?/.test(l)) {
      let a = i; while (a > 0 && i - a < 200 && !/^\s*Note: Using configuration file/.test(L[a - 1]) && !/^\s*\d+\/\d+ \[/.test(L[a - 1])) a--;
      add(a, i);
    }
    // Pest / PHPUnit failures and errors, with the assertion and "at file:line" that follow.
    if (/^\s*(FAILED|FAIL|ERROR)\s+\S/.test(l) && !/Code coverage below/.test(l)) add(i, i + 10);
    if (/^\s*(✘|⨯|×)\s/.test(l)) add(i, i + 6);
    if (/Failed asserting|Expected .* but|Error: |Exception: |SQLSTATE\[/.test(l)) add(i - 1, i + 2);
    if (/^\s*Tests:\s.*failed/.test(l)) add(i, i);
    // Coverage: the files under 100% and the summary line.
    if (/Code coverage below/.test(l)) {
      add(i, i);
      for (let j = i - 1; j >= Math.max(0, i - 80); j--) if (/\d+(\.\d+)?\s*%\s*$/.test(L[j]) && !/100(\.0+)?\s*%\s*$/.test(L[j])) add(j, j);
    }
    if (/^##\[error\]/.test(l) && !/Process completed with exit code/.test(l)) add(i, i);
  });
  let lines = [...keep].sort((a, b) => a - b).map((i) => L[i]);
  if (!lines.length) {
    const end = L.findIndex((l) => /^##\[error\]Process completed/.test(l));
    const stop = end < 0 ? L.length : end;
    lines = L.slice(0, stop).filter((l) => l.trim() && !/^\s*\.+\s*$/.test(l) && !/^##\[(end)?group\]/.test(l)).slice(-20);
  }
  // Drop progress bars and blank runs, then cap.
  lines = lines.filter((l) => !/^\s*\d+\/\d+ \[[░▓█▒ ]*\]/.test(l)).filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim()));
  return lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more lines in the full log`] : lines;
}

// "file:line message" for each PHPStan error in an excerpt.
export function phpstanErrors(lines) {
  const out = [];
  let file = null;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^\s*Line\s+(\S.*?)\s*$/);
    if (h) { file = h[1]; continue; }
    const r = lines[i].match(/^\s*(\d+)\s{2,}(\S.*?)\s*$/);
    if (file && r) {
      let msg = r[2];
      for (let j = i + 1; j < lines.length && /^\s{6,}\S/.test(lines[j]) && !/^\s*\d+\s{2,}/.test(lines[j]); j++) {
        const t = lines[j].trim(); if (!t.startsWith("🪪")) msg += " " + t; else msg += ` (${t.replace("🪪", "").trim()})`;
      }
      out.push(`${file}:${r[1]} ${msg}`);
    }
  }
  return out;
}

const fmtET = (iso) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
const quote = (s, n = 160) => { const t = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const isBot = (login) => !login || /\[bot\]$|^(cursor|claude|copilot|github-actions|coderabbitai)$/i.test(login);

// Reviewers whose latest decisive review is CHANGES_REQUESTED.
export function standingChangeRequests(reviews) {
  const last = new Map();
  for (const r of reviews) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) last.set(r.author?.login, r);
  return [...last.values()].filter((r) => r.state === "CHANGES_REQUESTED");
}

export function checkContexts(pr) {
  return pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
}
const passed = (c) => (c.__typename === "CheckRun" ? c.status === "COMPLETED" && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion) : c.state === "SUCCESS");

// "approved" | "ready" | null for a teammate PR.
export function approvalState(pr) {
  if (pr.reviewDecision === "APPROVED") return "approved";
  const checks = checkContexts(pr);
  if (!checks.length || !checks.every(passed)) return null;
  if ((pr.reviewThreads?.nodes ?? []).some((t) => !t.isResolved)) return null;
  if (standingChangeRequests(pr.reviews?.nodes ?? []).length) return null;
  return "ready";
}

// Changes-requested facts as Markdown, plus a signature that changes when new review activity lands.
export function changesFacts(pr, ciText = "") {
  const crs = standingChangeRequests(pr.reviews?.nodes ?? []);
  if (!crs.length) return null;
  const who = new Set(crs.map((r) => r.author.login));
  const open = (pr.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved);
  const theirs = open.filter((t) => who.has(t.comments.nodes[0]?.author?.login));
  const others = open.filter((t) => !who.has(t.comments.nodes[0]?.author?.login));
  const files = new Map((pr.files?.nodes ?? []).map((f) => [f.path, f]));
  const touched = [...new Set([...theirs, ...others.filter((t) => !isBot(t.comments.nodes[0]?.author?.login) || /🔴|High Severity/.test(t.comments.nodes[0]?.body ?? ""))].map((t) => t.path))];
  const L = ["### Changes requested", ""];
  for (const r of crs) {
    L.push(`- **${r.author.login}** asked for changes on ${fmtET(r.submittedAt)}: [review](${r.url})`);
    if (r.body?.trim()) L.push(`  > ${quote(r.body, 600)}`);
  }
  L.push("");
  if (theirs.length) {
    L.push(`#### Their open comments (${theirs.length})`, "");
    for (const t of theirs) { const c = t.comments.nodes[0]; L.push(`- \`${t.path}:${t.line ?? t.originalLine ?? "?"}\`${t.isOutdated ? " (outdated)" : ""}: "${quote(c.body)}" [open](${c.url})`); }
    L.push("");
  }
  const loud = others.filter((t) => /🔴|High Severity/.test(t.comments.nodes[0]?.body ?? "") || !isBot(t.comments.nodes[0]?.author?.login));
  if (loud.length) {
    L.push(`#### Other open threads worth a look (${loud.length} of ${others.length} unresolved)`, "");
    for (const t of loud) { const c = t.comments.nodes[0]; L.push(`- \`${t.path}:${t.line ?? t.originalLine ?? "?"}\` ${c.author?.login}: "${quote(c.body, 120)}" [open](${c.url})`); }
    L.push("");
  }
  const add = touched.reduce((s, p) => s + (files.get(p)?.additions ?? 0), 0);
  const del = touched.reduce((s, p) => s + (files.get(p)?.deletions ?? 0), 0);
  const overlap = touched.filter((p) => ciText.includes(p) || ciText.includes(p.split("/").pop().replace(/\.php$/, "")));
  const facts = L.join("\n").trim();
  L.length = 0;
  L.push(`- **Files:** ${touched.length ? touched.map((p) => `\`${p}\``).join(", ") : "none named in open comments"}`);
  L.push(`- **Size:** ${theirs.length} comment${theirs.length === 1 ? "" : "s"} from the reviewer across ${new Set(theirs.map((t) => t.path)).size} file(s); those files are +${add}/−${del} lines in this PR (whole PR +${pr.additions}/−${pr.deletions}).`);
  L.push(`- **Overlaps the CI failure:** ${ciText ? (overlap.length ? "yes, " + overlap.map((p) => `\`${p}\``).join(", ") : "no") : "CI is not failing"}`);
  const sig = [...crs.map((r) => r.url), ...theirs.map((t) => t.comments.nodes.map((c) => c.url).join(","))].sort().join("|");
  return { facts, scope: L.join("\n"), sig };
}

// ---------- gh-backed ----------

// gh pr checks exits 8 when a check failed or is pending; its JSON is still on stdout.
function ghLoose(args) {
  try { return gh(args); } catch (e) { if (e.stdout) return String(e.stdout); throw e; }
}

// Failed jobs of the newest completed run of each workflow on the PR branch, when that run failed: the last known
// failure while a new run is in progress.
function previousFailures(repo, number) {
  const branch = gh(["pr", "view", String(number), "-R", `${OWNER}/${repo}`, "--json", "headRefName", "--jq", ".headRefName"]).trim();
  const runs = JSON.parse(gh(["run", "list", "-R", `${OWNER}/${repo}`, "--branch", branch, "--limit", "30", "--json", "databaseId,conclusion,status,workflowName,headSha,createdAt"]) || "[]");
  const seen = new Set(); const out = [];
  for (const r of runs) {
    if (r.status !== "completed" || seen.has(r.workflowName)) continue;
    seen.add(r.workflowName);
    if (r.conclusion !== "failure") continue;
    const jobs = JSON.parse(gh(["run", "view", String(r.databaseId), "-R", `${OWNER}/${repo}`, "--json", "jobs"]) || "{}").jobs ?? [];
    for (const j of jobs) if (j.conclusion === "failure") out.push({ name: j.name, workflow: r.workflowName, link: j.url, sha: r.headSha });
  }
  return out;
}

export function ciReport(repo, number) {
  const checks = JSON.parse(ghLoose(["pr", "checks", String(number), "-R", `${OWNER}/${repo}`, "--json", "name,state,bucket,link,workflow"]) || "[]");
  let failed = checks.filter((c) => c.bucket === "fail");
  let previous = false;
  if (!failed.length && checks.some((c) => c.bucket === "pending")) { failed = previousFailures(repo, number); previous = failed.length > 0; }
  if (!failed.length) return null;
  const L = [previous ? `### CI failed on the previous commit (${failed[0].sha.slice(0, 7)}); a new run is in progress` : "### CI failing", ""];
  let text = "";
  for (const c of failed) {
    L.push(`- **${c.name}**${c.workflow ? ` (${c.workflow})` : ""}: [full log](${c.link})`);
    const m = (c.link || "").match(/actions\/runs\/(\d+)\/job\/(\d+)/);
    if (!m) continue;
    let log = "";
    try { log = gh(["run", "view", m[1], "-R", `${OWNER}/${repo}`, "--job", m[2], "--log-failed"]); } catch (e) { L.push(`  (could not read the log: ${quote(String(e.message), 120)})`); continue; }
    const ex = extractFailure(log);
    const stan = phpstanErrors(ex);
    if (stan.length) L.push("", "  PHPStan:", ...stan.map((s) => `  - \`${s.split(" ")[0]}\` ${s.slice(s.indexOf(" ") + 1)}`));
    L.push("", "```text", ...ex, "```", "");
    text += ex.join("\n") + "\n";
  }
  return { report: L.join("\n"), text };
}

// GitHub comment id from a discussion URL (...#discussion_r123) or a pulls/comments API URL.
export function commentIdOf(url) {
  const m = String(url ?? "").match(/discussion_r(\d+)|pulls\/comments\/(\d+)/);
  return m ? m[1] ?? m[2] : null;
}
// The issue comment id in a PR conversation comment URL (#issuecomment-<id>), or null.
export function issueCommentIdOf(url) {
  const m = String(url ?? "").match(/issuecomment-(\d+)|issues\/comments\/(\d+)/);
  return m ? m[1] ?? m[2] : null;
}

// true when the posted review comment still exists, false on a 404, null when it cannot tell.
export function reviewCommentExists(repo, url) {
  const id = commentIdOf(url); const issueId = id ? null : issueCommentIdOf(url);
  if (!id && !issueId) return null;
  try { gh(["api", id ? `repos/${OWNER}/${repo}/pulls/comments/${id}` : `repos/${OWNER}/${repo}/issues/comments/${issueId}`, "--silent"]); return true; }
  catch (e) { return /404|Not Found/i.test(String(e.stderr ?? "") + String(e.message ?? "")) ? false : null; }
}

// The viewer's review comments on a PR, for finding the URL of a posted draft: [{path, line, url, body}].
export function myReviewComments(repo, number) {
  const me = gh(["api", "user", "--jq", ".login"]).trim();
  const out = gh(["api", "--paginate", `repos/${OWNER}/${repo}/pulls/${number}/comments`, "--jq", `.[] | select(.user.login == "${me}") | {path, line, original_line, url: .html_url, body}`]);
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
