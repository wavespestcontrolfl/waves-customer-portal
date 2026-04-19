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

async function mergePr(number, { method = 'squash', title, message } = {}) {
  const { owner, repo } = env();
  return ghFetch(`/repos/${owner}/${repo}/pulls/${number}/merge`, {
    method: 'PUT',
    body: { merge_method: method, commit_title: title, commit_message: message },
  });
}

async function getPr(number) {
  const { owner, repo } = env();
  return ghFetch(`/repos/${owner}/${repo}/pulls/${number}`);
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
  getBranchSha,
  createBranch,
  createPr,
  mergePr,
  getPr,
  verifyAccess,
};
