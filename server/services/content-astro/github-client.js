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

// Contents-API path: encodeURI leaves `?`/`#` bare, so a filename holding a
// literal `?` would be read as a query string and a committed file reported
// missing (GH r29). Encode per segment, keeping the `/` separators.
function encodeContentsPath(path) {
  return String(path || '').split('/').map(encodeURIComponent).join('/');
}

async function listDir(path, ref) {
  const { owner, repo, defaultBranch } = env();
  const refQ = ref ? `?ref=${encodeURIComponent(ref)}` : `?ref=${defaultBranch}`;
  const out = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeContentsPath(path)}${refQ}`);
  return Array.isArray(out) ? out : [];
}

async function getFile(path, ref) {
  const { owner, repo, defaultBranch } = env();
  const refQ = ref ? `?ref=${encodeURIComponent(ref)}` : `?ref=${defaultBranch}`;
  const out = await ghFetch(`/repos/${owner}/${repo}/contents/${encodeContentsPath(path)}${refQ}`);
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
  return ghFetch(`/repos/${owner}/${repo}/contents/${encodeContentsPath(path)}`, { method: 'PUT', body });
}

async function putBinary({ path, buffer, message, branch, sha }) {
  const { owner, repo } = env();
  const body = {
    message,
    content: buffer.toString('base64'),
    branch,
  };
  if (sha) body.sha = sha;
  return ghFetch(`/repos/${owner}/${repo}/contents/${encodeContentsPath(path)}`, { method: 'PUT', body });
}

async function deleteFile({ path, message, branch, sha }) {
  const { owner, repo } = env();
  if (!sha) throw new Error('deleteFile requires file sha');
  return ghFetch(`/repos/${owner}/${repo}/contents/${encodeContentsPath(path)}`, {
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
async function commitFiles({ branch, message, files = [], deletes = [], expectedHeadSha = null }) {
  const { owner, repo } = env();
  if (!branch) throw new Error('commitFiles requires branch');
  if (!files.length && !deletes.length) throw new Error('commitFiles requires at least one file or delete');

  const headSha = await getBranchSha(branch);
  if (!headSha) throw new Error(`branch not found: ${branch}`);
  if (expectedHeadSha && headSha !== expectedHeadSha) throw new Error('branch changed since content was reviewed');
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

function baseMovedError(number, baseRef, detail) {
  const moved = new Error(`PR #${number}: base ${baseRef} moved or is unavailable; re-verify before merge${detail ? ` (${detail})` : ''}`);
  moved.code = 'BLOG_BASE_MOVED';
  return moved;
}

// Atomic base-bound merge — used when a caller supplies `verifyPaths` (the
// editorial-evidence gate's signed articles and sidecars). The
// merge endpoint pins the PR HEAD (`sha` in the PUT body, 409 on mismatch)
// but has no equivalent base precondition: a plain re-read-then-PUT leaves a
// window where the Astro repo's main can move between the read and GitHub
// processing the PUT, and the merge would land on a base the caller never
// checked. Instead of the endpoint, drive the git data API directly so the
// base check IS the merge:
//   1. re-read the PR — base/head/mergeable must match what was gated
//   2. read GitHub's own test-merge commit and require its parents are
//      exactly [base, head] (proves it isn't stale)
//   3. optionally verify specific paths resolve to the same blob at the
//      test merge as at head (proves the base's own edits, if any, didn't
//      touch the signed bytes)
//   4. create a real merge commit from the verified tree
//   5. fast-forward-only PATCH the base ref onto it — force:false makes
//      this PATCH the atomic compare-and-swap: it 422s if base moved.
// Trade-off: the merge endpoint's head pin is not reproduced — a push landing
// between step 1 and step 5 does not stop the ref update. What lands is still
// exactly the verified, signed head, and settleAdvancedHead closes the PR as
// superseded so the unpublished commit is not left looking merge-pending.
// Any inconsistency throws the same retryable BLOG_BASE_MOVED code the old
// pre-check used, so callers that already treat that code as "re-verify
// next tick" need no changes.
//
// Steps below are split into small, single-purpose helpers (each under the
// eslint complexity cap) — behavior is identical to the inlined original.
async function mergePrAtomic(number, { title, message, sha, expectBaseSha, baseRef, verifyPaths }) {
  const { owner, repo } = env();
  const headSha = String(sha || '');
  if (!headSha) throw new Error('mergePr: sha (head) is required when expectBaseSha is supplied');

  const current = await assertMergeablePrSnapshot(number, { headSha, expectBaseSha, baseRef });
  const treeSha = await assertVerifiedTestMerge(number, {
    owner, repo, expectBaseSha, headSha, baseRef, mergeCommitSha: current.merge_commit_sha,
  });
  await assertVerifiedPaths(number, { verifyPaths, mergeCommitSha: current.merge_commit_sha, headSha, baseRef });
  const newSha = await createAndFastForward(number, { owner, repo, title, message, treeSha, expectBaseSha, headSha, baseRef });

  return settleAdvancedHead(number, headSha, newSha);
}

// 1. Re-read the PR: base/head/mergeable must match exactly what the caller
// gated, and GitHub must already have computed a test-merge commit — else
// there is nothing trustworthy to build the real merge from yet. Returns the
// fresh PR (its merge_commit_sha feeds the next step).
async function assertMergeablePrSnapshot(number, { headSha, expectBaseSha, baseRef }) {
  const current = await getPr(number);
  const currentBaseSha = String(current?.base?.sha || '').toLowerCase();
  const currentBaseRef = String(current?.base?.ref || '');
  const currentHeadSha = String(current?.head?.sha || '').toLowerCase();
  if (current?.state !== 'open' || currentBaseRef !== baseRef
      || !currentBaseSha || currentBaseSha !== String(expectBaseSha).toLowerCase()
      || currentHeadSha !== headSha.toLowerCase()) {
    throw baseMovedError(number, baseRef, 'base/head moved since gating');
  }
  // mergeable is computed async by GitHub and is null while pending, false
  // on conflicts — either way there is no trustworthy test-merge commit yet.
  // Retryable: the next tick re-reads a (by then) settled value.
  if (current.mergeable !== true || !current.merge_commit_sha) {
    throw baseMovedError(number, baseRef, `PR not cleanly mergeable (mergeable=${current.mergeable})`);
  }
  return current;
}

// 2. GitHub's own test-merge commit proves the merge isn't stale: its
// parents must be exactly [base, head] as gated. Returns its tree sha, which
// the real merge commit reuses verbatim.
async function assertVerifiedTestMerge(number, { owner, repo, expectBaseSha, headSha, baseRef, mergeCommitSha }) {
  const testMerge = await ghFetch(`/repos/${owner}/${repo}/git/commits/${mergeCommitSha}`);
  const parents = Array.isArray(testMerge?.parents) ? testMerge.parents.map((p) => String(p?.sha || '').toLowerCase()) : [];
  if (parents.length !== 2 || parents[0] !== String(expectBaseSha).toLowerCase() || parents[1] !== headSha.toLowerCase()) {
    throw baseMovedError(number, baseRef, 'GitHub test-merge commit is stale');
  }
  const treeSha = testMerge?.tree?.sha;
  if (!treeSha) throw baseMovedError(number, baseRef, 'GitHub test-merge commit has no tree');
  return treeSha;
}

// 3. Each verified path (signed editorial articles + sidecars) must resolve
// to the same blob at the test merge as at head — proves the base's own
// edits, if any, didn't touch the signed bytes. No-op when verifyPaths is
// empty/undefined.
async function assertVerifiedPaths(number, { verifyPaths, mergeCommitSha, headSha, baseRef }) {
  for (const path of verifyPaths || []) {
    const [atMerge, atHead] = await Promise.all([
      getFile(path, mergeCommitSha),
      getFile(path, headSha),
    ]);
    const absentAtBoth = atMerge === null && atHead === null;
    const sameBlob = typeof atMerge?.sha === 'string' && atMerge.sha && atMerge.sha === atHead?.sha;
    if (!absentAtBoth && !sameBlob) throw baseMovedError(number, baseRef, `verified path changed by the merge: ${path}`);
  }
}

// 4–5. Create the real merge commit from the verified tree, then
// fast-forward-only PATCH the base ref onto it — force:false IS the atomic
// compare-and-swap (422 if base moved). Returns the new commit sha.
async function createAndFastForward(number, { owner, repo, title, message, treeSha, expectBaseSha, headSha, baseRef }) {
  const commitMessage = [title, message].filter(Boolean).join('\n\n') || `Merge pull request #${number}`;
  const newCommit = await ghFetch(`/repos/${owner}/${repo}/git/commits`, {
    method: 'POST',
    body: { message: commitMessage, tree: treeSha, parents: [expectBaseSha, headSha] },
  });
  const newSha = newCommit?.sha;
  if (!newSha) throw new Error(`PR #${number}: failed to create merge commit`);

  try {
    await ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(baseRef)}`, {
      method: 'PATCH',
      body: { sha: newSha, force: false },
    });
  } catch (err) {
    if (Number(err?.status) === 422) {
      // 422 means "not a fast-forward" — but it's also what a retried PATCH
      // sees if an EARLIER attempt already landed (ghFetch retries 5xx
      // internally, and GitHub can 5xx after committing the update). Re-read
      // the ref before concluding base moved: if it's already our commit,
      // the merge went through and this is a false alarm, not base drift.
      const refNow = await getBranchSha(baseRef);
      if (refNow === newSha) return newSha;
      throw baseMovedError(number, baseRef, 'main moved during merge (ref update rejected)');
    }
    throw err;
  }
  return newSha;
}

// The ref update published exactly the verified head. If the PR received a
// push in the meantime, GitHub leaves it open with a commit nothing reviewed
// or published — close it as superseded so no open PR implies they will
// ship it. Close FIRST: an unreviewed extra commit sitting open (and, once
// GitHub recomputes mergeable, human-mergeable) is the real risk; the
// explanatory comment is cosmetic and must never gate or undo the close.
//
// `retired` reports whether the close itself landed. false means the
// caller MUST persist a durable retirement debt — the existing
// astro_retire_pr_number mechanism (blog_posts / autonomous_runs), swept
// every poll tick by reconcileTopicBlockedPostPrs / reconcileHeadAdvancedPrs
// — so a lost response here still converges instead of leaving the PR open
// and mergeable indefinitely.
async function settleAdvancedHead(number, headSha, newSha) {
  const result = { sha: newSha, merged: true };
  let after;
  try {
    after = await getPr(number);
  } catch (err) {
    logger.warn(`[github] PR #${number}: post-merge head check failed: ${err.message}`);
    return result;
  }
  const afterHead = String(after?.head?.sha || '').toLowerCase();
  if (after?.state !== 'open' || !afterHead || afterHead === headSha.toLowerCase()) return result;

  result.headAdvanced = afterHead;
  logger.warn(`[github] PR #${number}: head advanced to ${afterHead.slice(0, 9)} during merge; published verified head ${headSha.slice(0, 9)}`);
  try {
    await closePr(number);
    result.retired = true;
  } catch (err) {
    result.retired = false;
    logger.warn(`[github] PR #${number}: close after head-advance failed: ${err.message} (retried via the caller's retirement debt)`);
  }
  // Independently best-effort — its failure must never skip or undo the close.
  try {
    await createIssueComment(number, `Merged the verified head ${headSha.slice(0, 9)} as ${newSha.slice(0, 9)}. Commit ${afterHead.slice(0, 9)} arrived during the merge and was not published; closing this PR. Open a new PR for that change.`);
  } catch (err) {
    logger.warn(`[github] PR #${number}: post-merge explanatory comment failed: ${err.message}`);
  }
  return result;
}

async function mergePr(number, { method = 'squash', title, message, sha, expectBaseSha, expectBaseRef, verifyPaths } = {}) {
  const { owner, repo, defaultBranch } = env();
  const baseRef = expectBaseRef || defaultBranch;
  // Signed editorial evidence must publish exactly the verified bytes, so a
  // caller that supplies `verifyPaths` gets the atomic merge above. Other
  // base pins (gate-off body-image check) keep the squash endpoint behind a
  // final PR re-read: that check guards asset reachability, not signed bytes.
  if (expectBaseSha && Array.isArray(verifyPaths)) {
    return mergePrAtomic(number, { title, message, sha, expectBaseSha, baseRef, verifyPaths });
  }
  if (expectBaseSha) {
    const current = await getPr(number);
    const currentBaseSha = String(current?.base?.sha || '');
    const currentBaseRef = String(current?.base?.ref || '');
    if (current?.state !== 'open' || currentBaseRef !== baseRef
        || !currentBaseSha || currentBaseSha.toLowerCase() !== String(expectBaseSha).toLowerCase()) {
      throw baseMovedError(number, baseRef);
    }
  }
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

// Blob by SHA (git data API): base64 content up to 100 MB — the fallback
// for a committed asset whose contents-API response carries metadata but no
// inline bytes (files over 1 MB).
// Paths a head branch changes relative to the default branch (compare API:
// `base...head`, three-dot = merge-base diff, i.e. exactly what the PR
// carries into the merge). Files GitHub lists are capped at 300 — far above
// any content PR.
async function compareFiles(head, base) {
  const { owner, repo, defaultBranch } = env();
  const out = await ghFetch(`/repos/${owner}/${repo}/compare/${encodeURIComponent(base || defaultBranch)}...${encodeURIComponent(head)}`);
  // A renamed entry changes BOTH paths (the old one is deleted by the
  // merge), so both are reported as PR-changed.
  const files = [];
  for (const f of Array.isArray(out?.files) ? out.files : []) {
    if (f?.filename) files.push(f.filename);
    if (f?.previous_filename) files.push(f.previous_filename);
  }
  return { files, mergeBaseSha: out?.merge_base_commit?.sha || null };
}

async function getBlob(sha) {
  const { owner, repo } = env();
  return ghFetch(`/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(sha)}`);
}

async function deleteRef(branch) {
  const { owner, repo } = env();
  return ghFetch(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'DELETE',
  });
}

// Delete a branch and VERIFY it is gone: a missing ref on delete (404/422)
// counts as gone; anything else propagates. → true only when getBranchSha no
// longer resolves it. Callers retiring a rejected PR must not treat the PR as
// retired until this is true (a surviving branch lets the closed PR be
// reopened and merged).
async function retireBranch(branch) {
  if (!branch) return true;
  try {
    await deleteRef(branch);
  } catch (err) {
    if (![404, 422].includes(Number(err?.status))) throw err;
  }
  return !(await getBranchSha(branch));
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
  getBlob,
  compareFiles,
  deleteRef,
  retireBranch,
  verifyAccess,
};
