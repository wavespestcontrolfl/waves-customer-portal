/**
 * Intelligence Bar — GitHub Deploy-Provenance Ops Tools
 * server/services/intelligence-bar/github-ops-tools.js
 *
 * Read-only visibility into what code shipped: recently merged PRs on the
 * portal repo and commit lookups, so a Railway deployment SHA can be
 * translated into "PR #2626 — referral credit fix" instead of a bare hash.
 *
 * Auth: reuses the GITHUB_TOKEN already configured for the content-astro
 * publisher. That PAT is fine-grained — if it does not grant the portal
 * repo, these tools surface the permission error and the fix is to widen the
 * PAT's repository access in GitHub settings (no code change).
 * Repo defaults to the portal; GITHUB_OWNER / GITHUB_PORTAL_REPO override.
 *
 * rerun_failed_github_checks / add_github_pr_label / request_codex_review
 * (IB scope expansion item 1, owner ruling 2026-09-28) are the outside-write
 * tools: structurally two-step (write-gates.js OUTSIDE_WRITE_TOOL_NAMES),
 * full-access-only (ib-access.js ibFullAccess, enforced in
 * routes/admin-intelligence-bar.js — not here). request_codex_review always
 * posts the EXACT body "@codex review" — never a model- or caller-supplied
 * string — because a bare "@codex" tag (with no "review") runs a different
 * task instead of a code review. THIS PR IS PREVIEW ONLY: called with
 * confirmed:true, all three refuse — the commit path (the actual GitHub
 * rerun-failed-jobs / add-labels / create-comment calls) ships in a
 * follow-up PR. GITHUB_TOKEN is read-scoped today; a write needs Actions
 * read/write + Pull requests read/write added (see the IB scope doc's token
 * checklist).
 */

const logger = require('../logger');

const GITHUB_API_BASE = process.env.GITHUB_API_BASE || 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_HOURS = 48;
const MAX_HOURS = 24 * 14;
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 30;
const PR_SCAN_PAGE_SIZE = 50;
const MAX_PR_PAGES = 5;

const GITHUB_OPS_TOOLS = [
  {
    name: 'get_recent_merged_prs',
    description: `List recently merged pull requests on the portal repo (default last 48h): number, title, who merged it, and the merge commit SHA — cross-reference the SHA with Railway deployments to see what code is live.
Use for: "what shipped today?", "which PRs went out this week?", "what's in the latest deploy?"`,
    input_schema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: `Merged-within window in hours (default ${DEFAULT_HOURS}, max ${MAX_HOURS})` },
        limit: { type: 'number', description: `Max PRs to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})` },
      },
    },
  },
  {
    name: 'get_commit_info',
    description: `Look up one commit on the portal repo by SHA (full or short): message, author, date, and change size. Use to translate a Railway deployment's commit SHA into what it actually contains.
Use for: "what is commit abae45b?", "what's live right now?" (after getting the SHA from Railway)`,
    input_schema: {
      type: 'object',
      properties: {
        sha: { type: 'string', description: 'Commit SHA (short or full)' },
      },
      required: ['sha'],
    },
  },
  {
    name: 'rerun_failed_github_checks',
    description: `Rerun the failed jobs of the most recent CI run for a pull request's current head commit (only the failed jobs, not the whole run). Owner login only, through a confirmation card. PREVIEW ONLY for now — this does not yet commit to GitHub.
Use for: "rerun the failed checks on PR 5230", "that CI run flaked, retry it"`,
    input_schema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'Pull request number on the portal repo' },
      },
      required: ['pr_number'],
    },
  },
  {
    name: 'add_github_pr_label',
    description: `Add a label to a pull request on the portal repo. Owner login only, through a confirmation card. PREVIEW ONLY for now — this does not yet commit to GitHub.
Use for: "label PR 5230 as needs-review", "tag that PR blocked"`,
    input_schema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'Pull request number on the portal repo' },
        label: { type: 'string', description: 'Existing repo label to add, e.g. "needs-review"' },
      },
      required: ['pr_number', 'label'],
    },
  },
  {
    name: 'request_codex_review',
    description: `Post a comment on a pull request that triggers a Codex review round. The comment body is ALWAYS the exact text "@codex review" — never anything else — because a bare "@codex" mention with no "review" runs a different automated task instead. Owner login only, through a confirmation card. PREVIEW ONLY for now — this does not yet commit to GitHub.
Use for: "tag Codex on PR 5230", "ask for a review round on that PR"`,
    input_schema: {
      type: 'object',
      properties: {
        pr_number: { type: 'number', description: 'Pull request number on the portal repo' },
      },
      required: ['pr_number'],
    },
  },
];

const NOT_YET_IMPLEMENTED_MESSAGE = 'GitHub write commits are not enabled yet — this preview cannot be confirmed. The commit path ships in a follow-up PR.';
const CODEX_REVIEW_COMMENT_BODY = '@codex review';

const NOT_CONFIGURED_MESSAGE = 'GitHub access is not configured. Add the GITHUB_TOKEN service variable (a fine-grained PAT with read access to the portal repo) in the Railway dashboard.';

function repoPath() {
  const owner = process.env.GITHUB_OWNER || 'wavespestcontrolfl';
  const repo = process.env.GITHUB_PORTAL_REPO || 'waves-customer-portal';
  return `${owner}/${repo}`;
}

async function githubGet(path, params = {}) {
  const url = new URL(`${GITHUB_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'waves-portal-intelligence-bar',
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      // Fine-grained PATs return 404 for repos they don't grant.
      throw new Error(`GitHub returned HTTP ${res.status} — the GITHUB_TOKEN PAT may not grant read access to ${repoPath()}.`);
    }
    if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`GitHub API timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getRecentMergedPrs(input) {
  const hours = Math.min(Math.max(Number(input.hours) || DEFAULT_HOURS, 1), MAX_HOURS);
  const limit = Math.min(Math.max(Number(input.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const since = Date.now() - hours * 60 * 60 * 1000;
  // Closed PRs are paginated; updated_at >= merged_at, so with updated-desc
  // ordering a page whose last item was updated before the window means no
  // later page can hold an in-window merge.
  const candidates = [];
  let scanned = 0;
  let exhaustive = true;
  for (let page = 1; page <= MAX_PR_PAGES; page += 1) {
    const pulls = await githubGet(`/repos/${repoPath()}/pulls`, {
      state: 'closed',
      sort: 'updated',
      direction: 'desc',
      per_page: PR_SCAN_PAGE_SIZE,
      page,
    });
    const items = Array.isArray(pulls) ? pulls : [];
    scanned += items.length;
    candidates.push(...items.filter(p => p.merged_at && new Date(p.merged_at).getTime() >= since));
    if (items.length < PR_SCAN_PAGE_SIZE) break; // last page
    const oldest = items[items.length - 1];
    if (oldest?.updated_at && new Date(oldest.updated_at).getTime() < since) break;
    if (page === MAX_PR_PAGES) exhaustive = false;
  }
  const merged = candidates
    .sort((a, b) => new Date(b.merged_at) - new Date(a.merged_at))
    .slice(0, limit)
    .map(p => ({
      number: p.number,
      title: p.title,
      author: p.user?.login || null,
      merged_at: p.merged_at,
      merge_commit_sha: (p.merge_commit_sha || '').slice(0, 10) || null,
    }));
  return {
    repo: repoPath(),
    window_hours: hours,
    merged_prs: merged,
    total: merged.length,
    scanned_recent_prs: scanned,
    scan_exhaustive: exhaustive && merged.length === candidates.length,
  };
}

async function getCommitInfo(input) {
  const sha = String(input.sha || '').trim();
  if (!/^[0-9a-f]{6,40}$/i.test(sha)) throw new Error('sha must be a 6-40 character hex commit SHA.');
  const commit = await githubGet(`/repos/${repoPath()}/commits/${sha}`);
  return {
    repo: repoPath(),
    sha: (commit.sha || '').slice(0, 10),
    message: (commit.commit?.message || '').split('\n')[0],
    author: commit.commit?.author?.name || null,
    date: commit.commit?.author?.date || null,
    files_changed: Array.isArray(commit.files) ? commit.files.length : null,
    additions: commit.stats?.additions ?? null,
    deletions: commit.stats?.deletions ?? null,
  };
}

// Shared by every write tool's preview — resolves the real PR so the card
// names it by TITLE, not just the bare number.
async function resolvePr(prNumber) {
  const n = Number(prNumber);
  if (!Number.isInteger(n) || n <= 0) throw new Error('pr_number must be a positive integer.');
  const pr = await githubGet(`/repos/${repoPath()}/pulls/${n}`);
  if (!pr || !pr.number) throw new Error(`No pull request #${n} found on ${repoPath()}.`);
  return pr;
}

// Unconfirmed: resolve the PR and its head commit's check-runs live, so the
// card names the PR and lists exactly which jobs are currently failing.
// Confirmed: the commit path (a GitHub rerun-failed-jobs POST) is not built
// in this PR. Full access is enforced by the route (ib-access.js).
async function rerunFailedGithubChecks(input) {
  if (input.confirmed !== true) {
    const pr = await resolvePr(input.pr_number);
    const sha = pr.head?.sha;
    if (!sha) throw new Error(`PR #${pr.number} has no head commit to check.`);
    const checkRuns = await githubGet(`/repos/${repoPath()}/commits/${sha}/check-runs`, { per_page: 100 });
    const failed = (checkRuns?.check_runs || [])
      .filter(r => r.status === 'completed' && ['failure', 'timed_out', 'cancelled'].includes(r.conclusion))
      .map(r => ({ name: r.name, conclusion: r.conclusion, run_id: r.id }));
    return {
      preview: true,
      tool: 'rerun_failed_github_checks',
      pr: { number: pr.number, title: pr.title, head_sha: sha.slice(0, 10) },
      failed_checks: failed,
      note: failed.length
        ? `Rerun ${failed.length} failed job(s) on PR #${pr.number} "${pr.title}" (${failed.map(f => f.name).join(', ')}) — only the failed jobs, not the whole run.`
        : `No failed checks found on PR #${pr.number} "${pr.title}"'s current head commit — nothing to rerun.`,
    };
  }
  return { error: NOT_YET_IMPLEMENTED_MESSAGE, code: 'not_yet_implemented' };
}

const MAX_LABEL_SUGGESTIONS = 5;

// Exact (case-insensitive, trimmed) match against the repo's REAL label
// catalog — never the operator's raw string as-typed (pre-push audit
// #5275). GitHub itself enforces label names unique case-insensitively per
// repo, so an exact case-insensitive match is always at most one label; a
// case/whitespace mismatch against an EXISTING label would otherwise create
// a brand-new duplicate label instead of reusing the intended one. Returns
// the label's own canonical name (correct casing), which is what gets
// pinned into the preview/card, never the raw input.
async function resolveRepoLabel(labelName) {
  const needle = String(labelName).trim().toLowerCase();
  const labels = await githubGet(`/repos/${repoPath()}/labels`, { per_page: 100 });
  const list = Array.isArray(labels) ? labels : [];
  const exact = list.filter(l => String(l.name || '').trim().toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(`Multiple labels on ${repoPath()} exactly match "${labelName}" — this should not happen; contact engineering. Candidates: ${exact.map(l => l.name).join(', ')}.`);
  }
  const suggestions = list
    .filter(l => String(l.name || '').toLowerCase().includes(needle))
    .slice(0, MAX_LABEL_SUGGESTIONS)
    .map(l => l.name);
  const hint = suggestions.length ? ` Close matches: ${suggestions.join(', ')}.` : '';
  throw new Error(`No label named "${labelName}" exists on ${repoPath()}.${hint}`);
}

async function addGithubPrLabel(input) {
  const rawLabel = String(input.label || '').trim();
  if (!rawLabel) throw new Error('label is required.');
  if (input.confirmed !== true) {
    const pr = await resolvePr(input.pr_number);
    const label = await resolveRepoLabel(rawLabel);
    const existing = (pr.labels || []).map(l => l.name);
    return {
      preview: true,
      tool: 'add_github_pr_label',
      pr: { number: pr.number, title: pr.title },
      // The pinned canonical label name (its real, existing casing) — never
      // the operator's raw string — is what a future commit path must use.
      label: label.name,
      existing_labels: existing,
      note: existing.includes(label.name)
        ? `PR #${pr.number} "${pr.title}" already has the "${label.name}" label.`
        : `Add the "${label.name}" label to PR #${pr.number} "${pr.title}".`,
    };
  }
  return { error: NOT_YET_IMPLEMENTED_MESSAGE, code: 'not_yet_implemented' };
}

async function requestCodexReview(input) {
  if (input.confirmed !== true) {
    const pr = await resolvePr(input.pr_number);
    return {
      preview: true,
      tool: 'request_codex_review',
      pr: { number: pr.number, title: pr.title },
      comment_body: CODEX_REVIEW_COMMENT_BODY,
      note: `Post the comment "${CODEX_REVIEW_COMMENT_BODY}" on PR #${pr.number} "${pr.title}" — this starts a Codex review round.`,
    };
  }
  return { error: NOT_YET_IMPLEMENTED_MESSAGE, code: 'not_yet_implemented' };
}

async function executeGithubOpsTool(toolName, input = {}) {
  // "Not configured" is the expected DARK state, not a failure — an
  // { error } result would count against the shared admin circuit breaker
  // (see ops-tools.js for the full rationale).
  if (!process.env.GITHUB_TOKEN) {
    return { configured: false, message: NOT_CONFIGURED_MESSAGE };
  }
  try {
    switch (toolName) {
      case 'get_recent_merged_prs': return await getRecentMergedPrs(input);
      case 'get_commit_info': return await getCommitInfo(input);
      case 'rerun_failed_github_checks': return await rerunFailedGithubChecks(input);
      case 'add_github_pr_label': return await addGithubPrLabel(input);
      case 'request_codex_review': return await requestCodexReview(input);
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:github-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { GITHUB_OPS_TOOLS, executeGithubOpsTool };
