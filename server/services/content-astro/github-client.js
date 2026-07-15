/**
 * github-client.js — thin wrapper around the GitHub REST API.
 *
 * Scope is narrow: what the admin → Astro blog publish pipeline needs.
 *   - read directory listings (authors collection, blog tree)
 *   - read + write files via Contents API
 *   - create branches
 *   - open + merge PRs
 *
 * Auth: fine-grained PAT in GITHUB_TOKEN. Repo identified by GITHUB_OWNER +
 * GITHUB_ASTRO_REPO. Throws on missing env — the publisher route handles
 * the error and surfaces it via ToolLogger / the admin UI.
 *
 * No octokit dependency — plain fetch keeps the footprint small.
 */

const logger = require('../logger');

const API = 'https://api.github.com';

function env() {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER || 'wavespestcontrolfl';
  const repo = process.env.GITHUB_ASTRO_REPO || 'wavespestcontrol-astro';
  const defaultBranch = process.env.GITHUB_ASTRO_DEFAULT_BRANCH || 'main';
  if (!token) throw new Error('GITHUB_TOKEN not set');
  return { token, owner, repo, defaultBranch };
}

async function ghFetch(pathOrUrl, { method = 'GET', body, headers = {}, retries = 1 } = {}) {
  const { token } = env();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API}${pathOrUrl}`;
  const init = {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'waves-portal-publisher',
      ...headers,
    },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const res = await fetch(url, init);

  if (res.status === 404 && method === 'GET') return null;

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Retry once on 5xx — transient GitHub blips are common.
    if (res.status >= 500 && retries > 0) {
      logger.warn(`[github] ${method} ${url} → ${res.status}, retrying (${text.slice(0, 200)})`);
      await new Promise((r) => setTimeout(r, 500));
      return ghFetch(pathOrUrl, { method, body, headers, retries: retries - 1 });
    }
    const err = new Error(`GitHub ${method} ${url} → ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

// ── Contents API ──────────────────────────────────────────────────

async function listDir(path, ref) {
  const { owner, repo, defaultBranch } = env();
  const refQ = ref ? `?ref=${encodeURIComponent(ref)}` : `?ref=${defaultBranch}`;
  const out = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeURI(path)}${refQ}`);
  return Array.isArray(out) ? out : [];
}

async function getFile(path, ref) {
  const { owner, repo, defaultBranch } = env();
  const refQ = ref ? `?ref=${encodeURIComponent(ref)}` : `?ref=${defaultBranch}`;
  const out = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeURI(path)}${refQ}`);
  if (!out || Array.isArray(out)) return null;
  const content = out.content ? Buffer.from(out.content, 'base64').toString('utf8') : '';
  return { sha: out.sha, path: out.path, content, raw: out };
}

async function putFile({ path, content, message, branch, sha }) {
  const { owner, repo } = env();
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;
  return ghFetch(`/repos/${owner}/${repo}/contents/${encodeURI(path)}`, { method: 'PUT', body });
}

async function putBinary({ path, buffer, message, branch, sha }) {
  const { owner, repo } = env();
  const body = {
    message,
    content: buffer.toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;
  return ghFetch(`/repos/${owner}/${repo}/contents/${encodeURI(path)}`, { method: 'PUT', body });
}

async function deleteFile({ path, message, branch, sha }) {
  const { owner, repo } = env();
  if (!sha) throw new Error('deleteFile requires file sha');
  return ghFetch(`/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    method: 'DELETE',
    body: { message, branch, sha },
  });
}

// ── Git Data API (atomic multi-file commit) ───────────────────────
//
// The Contents API above writes ONE commit per file, so a publish that
// carries a hero image + markdown (+ a legacy-file delete) lands as 2–3
// commits pushed seconds apart. Cloudflare Pages can register its branch
// deployment against the FIRST commit of that burst; the autonomous PR
// poller's fail-closed head==deployment gate then reads
// `preview_build_stale_commit` on every tick, remediation never runs (it
// sits behind that gate), and the PR silently starves — no new push ever
// arrives to mint a fresh deployment (PR #374, 2026-07-15). One commit per
// publish removes the race at the source.
//
// files:   [{ path, content }] for UTF-8 text, or [{ path, buffer }] for
//          binary (routed through a base64 blob — the tree API's inline
//          `content` field is UTF-8 only and would corrupt image bytes).
// deletes: [path, ...] removed in the same commit.
//
// Return shape matches what publish callers read off putFile:
// `{ commit: { sha } }`.
async function commitFiles({ branch, message, files = [], deletes = [] }) {
  const { owner, repo } = env();
  if (!branch) throw new Error('commitFiles requires branch');
  if (!files.length && !deletes.length) throw new Error('commitFiles requires at least one file or delete');

  const headSha = await getBranchSha(branch);
  if (!headSha) throw new Error(`branch not found: ${branch}`);
  const baseCommit = await ghFetch(`/repos/${owner}/${repo}/git/commits/${headSha}`);
  const baseTreeSha = baseCommit?.tree?.sha;
  if (!baseTreeSha) throw new Error(`could not resolve tree for ${branch}@${headSha}`);

  const tree = [];
  for (const f of files) {
    if (Buffer.isBuffer(f.buffer)) {
      const blob = await ghFetch(`/repos/${owner}/${repo}/git/blobs`, {
        method: 'POST',
        body: { content: f.buffer.toString('base64'), encoding: 'base64' },
      });
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    } else {
      tree.push({ path: f.path, mode: '100644', type: 'blob', content: String(f.content ?? '') });
    }
  }
  // sha:null in a tree entry deletes the path from the base tree.
  for (const path of deletes) {
    tree.push({ path, mode: '100644', type: 'blob', sha: null });
  }

  const newTree = await ghFetch(`/repos/${owner}/${repo}/git/trees`, {
    method: 'POST',
    body: { base_tree: baseTreeSha, tree },
  });
  const commit = await ghFetch(`/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: { message, tree: newTree.sha, parents: [headSha] },
  });
  // force:false → GitHub 422s if the branch moved since headSha was read,
  // the same lost-update protection the Contents API gives via `sha`.
  await ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    body: { sha: commit.sha, force: false },
  });
  return { commit: { sha: commit.sha } };
}

// ── Branches + PRs ────────────────────────────────────────────────

async function getBranchSha(branch) {
  const { owner, repo } = env();
  const out = await ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`);
  return out?.object?.sha || null;
}

async function createBranch(newBranch, fromBranch) {
  const { owner, repo, defaultBranch } = env();
  const base = fromBranch || defaultBranch;
  const sha = await getBranchSha(base);
  if (!sha) throw new Error(`base branch not found: ${base}`);
  return ghFetch(`/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    body: { ref: `refs/heads/${newBranch}`, sha },
  });
}

async function createPr({ head, base, title, body }) {
  const { owner, repo, defaultBranch } = env();
  return ghFetch(`/repos/${owner}/${repo}/pulls`, {
    method: 'POST',
    body: { head, base: base || defaultBranch, title, body },
  });
}

// The open PR whose head is `branch`, or null. Used by publishAstro's
// failure path: a createPr CALL that threw may still have created the PR
// (ghFetch retries POSTs on 5xx, and a timeout can land after creation),
// and the caller must not delete the head branch of a live PR.
async function findOpenPrByHead(branch) {
  const { owner, repo } = env();
  const out = await ghFetch(`/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  return Array.isArray(out) && out.length ? out[0] : null;
}

async function createIssueComment(number, body) {
  const { owner, repo } = env();
  return ghFetch(`/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: 'POST',
    body: { body },
  });
}

async function ghFetchPaginated(path, { perPage = 100, maxPages = 20 } = {}) {
  const rows = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = await ghFetch(`${path}${sep}per_page=${perPage}&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < perPage) break;
  }
  return rows;
}

async function listIssueComments(number) {
  const { owner, repo } = env();
  return ghFetchPaginated(`/repos/${owner}/${repo}/issues/${number}/comments`);
}

async function listPrReviews(number) {
  const { owner, repo } = env();
  return ghFetchPaginated(`/repos/${owner}/${repo}/pulls/${number}/reviews`);
}

// Inline diff review comments (path/line/body/commit_id) — this is where Codex
// leaves its actionable findings. Distinct from listIssueComments (the PR
// conversation-level summary) and listPrReviews (top-level review objects).
async function listPrReviewComments(number) {
  const { owner, repo } = env();
  return ghFetchPaginated(`/repos/${owner}/${repo}/pulls/${number}/comments`);
}

async function mergePr(number, { method = 'squash', title, message, sha } = {}) {
  const { owner, repo } = env();
  const body = { merge_method: method, commit_title: title, commit_message: message };
  // GitHub rejects the merge with 409 when the head no longer matches `sha`,
  // so gated checks (build/review) performed against a specific head commit
  // can't be bypassed by a push that lands while the merge call is in flight.
  if (sha) body.sha = sha;
  return ghFetch(`/repos/${owner}/${repo}/pulls/${number}/merge`, {
    method: 'PUT',
    body,
  });
}

async function getPr(number) {
  const { owner, repo } = env();
  return ghFetch(`/repos/${owner}/${repo}/pulls/${number}`);
}

async function closePr(number) {
  const { owner, repo } = env();
  return ghFetch(`/repos/${owner}/${repo}/pulls/${number}`, {
    method: 'PATCH',
    body: { state: 'closed' },
  });
}

async function updatePr(number, { title, body } = {}) {
  const { owner, repo } = env();
  const fields = {};
  if (title !== undefined) fields.title = title;
  if (body !== undefined) fields.body = body;
  return ghFetch(`/repos/${owner}/${repo}/pulls/${number}`, { method: 'PATCH', body: fields });
}

async function deleteRef(branch) {
  const { owner, repo } = env();
  return ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'DELETE',
  });
}

async function verifyAccess() {
  const { owner, repo } = env();
  const out = await ghFetch(`/repos/${owner}/${repo}`);
  if (!out) throw new Error(`repo not found: ${owner}/${repo}`);
  return { full_name: out.full_name, permissions: out.permissions || {}, default_branch: out.default_branch };
}

module.exports = {
  env,
  listDir,
  getFile,
  putFile,
  putBinary,
  deleteFile,
  commitFiles,
  getBranchSha,
  createBranch,
  createPr,
  findOpenPrByHead,
  createIssueComment,
  ghFetchPaginated,
  listIssueComments,
  listPrReviews,
  listPrReviewComments,
  mergePr,
  getPr,
  closePr,
  updatePr,
  deleteRef,
  verifyAccess,
};
