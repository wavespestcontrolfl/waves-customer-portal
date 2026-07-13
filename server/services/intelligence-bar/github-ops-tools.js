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
 * There are NO write operations here — no merging, commenting, or branch
 * changes. Anything that mutates GitHub state must go through the write-gate
 * mechanism (issue #1568) and is intentionally not built.
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
];

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
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:github-ops] Tool ${toolName} failed:`, err);
    return { error: err.message };
  }
}

module.exports = { GITHUB_OPS_TOOLS, executeGithubOpsTool };
