/**
 * codex-remediation.js — auto-remediation loop for Codex review findings on
 * autonomous blog PRs.
 *
 * The publisher refuses to merge a blog PR until Codex reports "no major
 * issues" (astro-publisher.assertCodexReviewClear throws CODEX_REVIEW_REQUIRED).
 * When Codex leaves findings the PR sits open with nothing to fix it. This
 * service — invoked from BOTH publish-lane pollers when a merge is blocked —
 * reads the inline findings for the current PR head, patches the markdown on the
 * SAME branch via a direct Claude call, and re-requests "@codex review" for the
 * new head, so the poller merges once Codex clears it.
 *
 * Two lanes, one loop:
 *   - scheduler blog posts  → pages-poll (a blog_posts row)     → maybeRemediateBlogPost
 *   - autonomous publishes  → autonomous-pr-poller (a run, NO   → maybeRemediateAutonomousPr
 *                             blog_posts row)
 * Round/attempt state is keyed by PR number (codex_remediation_state) so one
 * store serves both lanes.
 *
 * Safety:
 *   - Gated behind AUTONOMOUS_CODEX_REMEDIATION (default OFF).
 *   - It only ever pushes to an existing draft PR branch and re-requests review;
 *     it NEVER merges (merge still requires a genuine Codex-clean signal).
 *   - Bounded by CODEX_REMEDIATION_MAX_ROUNDS (default 3). After that — or if a
 *     fix produces no change (usually a false-positive finding) — the PR is
 *     parked (status='parked'; scheduler lane also disarms its publishing claim
 *     so the row leaves the auto-merge loop for human review).
 *   - A round is only spent when Codex has left fresh findings for the current
 *     head. If Codex hasn't re-reviewed the latest push yet it no-ops (and
 *     re-posts the "@codex review" request if a prior post failed), so it never
 *     double-fires or strands a PR on a transient GitHub error.
 */

const dbDefault = require('../../models/db');
const ghDefault = require('../content-astro/github-client');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { callAnthropic } = require('../llm/call');

const MAX_ROUNDS = Math.max(1, parseInt(process.env.CODEX_REMEDIATION_MAX_ROUNDS || '3', 10) || 3);
const ASTRO_BLOG_DIR = 'src/content/blog';
const CODEX_LOGINS = new Set(['chatgpt-codex-connector', 'chatgpt-codex-connector[bot]']);

function remediationEnabled() {
  const v = String(process.env.AUTONOMOUS_CODEX_REMEDIATION || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}

function isCodexAuthor(login) {
  return CODEX_LOGINS.has(String(login || '').toLowerCase());
}

function shortSha(sha) {
  return String(sha || '').trim().toLowerCase().slice(0, 7);
}

function atRoundLimit(rounds) {
  return (rounds || 0) >= MAX_ROUNDS;
}

/**
 * Actionable inline Codex findings for the given head, from the PR's review
 * comments (GET /pulls/{n}/comments). Only comments Codex authored and provably
 * tied to the current head (commit_id or original_commit_id) are kept.
 */
function parseCodexFindings(reviewComments = [], headSha = null) {
  const head = shortSha(headSha);
  return (Array.isArray(reviewComments) ? reviewComments : [])
    .filter((c) => isCodexAuthor(c && (c.user?.login || c.author?.login)))
    .filter((c) => {
      if (!head) return true;
      const cid = shortSha(c.commit_id);
      const oid = shortSha(c.original_commit_id);
      return cid === head || oid === head;
    })
    .map((c) => ({
      path: c.path || null,
      line: c.line ?? c.original_line ?? null,
      body: String(c.body || '').trim(),
    }))
    .filter((f) => f.body);
}

/**
 * The blog markdown file the findings target. Autonomous posts are `.mdx`,
 * hand-authored ones `.md` — accept both. Prefer a finding whose path is a blog
 * file; fall back to a slug-derived `.md` path (scheduler lane only).
 */
function pickTargetPath(findings = [], slug = null) {
  const fromFinding = findings
    .map((f) => f.path)
    .find((p) => typeof p === 'string' && p.startsWith(ASTRO_BLOG_DIR) && (p.endsWith('.md') || p.endsWith('.mdx')));
  if (fromFinding) return fromFinding;
  const s = String(slug || '').replace(/^\/+|\/+$/g, '');
  return s ? `${ASTRO_BLOG_DIR}/${s}.md` : null;
}

function buildReviewRequestBody(newHeadSha) {
  return [
    '@codex review',
    '',
    `Addressed the review findings on head \`${newHeadSha}\`. Please re-review.`,
  ].join('\n');
}

const FIX_SYSTEM = [
  'You fix Waves Pest Control blog post markdown files in response to automated code-review (Codex) findings.',
  'Rules:',
  '- Apply ONLY the minimal changes needed to resolve the findings. Preserve everything else exactly: YAML frontmatter keys and values (slug, canonical, domains, author/reviewer, dates), document structure, and the author voice.',
  '- Never invent facts, statistics, reviews, or prices. Pricing phrases link to /pest-control-calculator/ — never a hardcoded number.',
  '- Do not add "near me" phrasing. Do not name competitors.',
  '- Keep every link pointing at a route that actually exists for this post\'s domain.',
  '- If a finding is a genuine false positive, leave that part unchanged.',
  '- Output the ENTIRE corrected file (frontmatter + body) and nothing else — no explanation, no code fence.',
].join('\n');

function buildFixUserMessage(markdown, findings) {
  const findingList = findings
    .map((f, i) => `${i + 1}. [${f.path || 'file'}${f.line ? ':' + f.line : ''}] ${f.body}`)
    .join('\n\n');
  return [
    'A code reviewer (Codex) left these findings on the blog post markdown file below:',
    '',
    findingList,
    '',
    'Current file contents (YAML frontmatter + Markdown body):',
    '',
    '<<<FILE',
    markdown,
    'FILE',
    '',
    'Return the complete corrected file that resolves every finding you agree with. Output only the file contents.',
  ].join('\n');
}

function stripCodeFence(text) {
  let t = String(text || '').trim();
  const fence = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1];
  t = t.replace(/^<<<FILE\n/, '').replace(/\nFILE\s*$/, '');
  return t.trim() + '\n';
}

async function generateFix(markdown, findings, deps = {}) {
  const call = deps.callAnthropic || callAnthropic;
  const res = await call({
    model: MODELS.FLAGSHIP,
    system: FIX_SYSTEM,
    text: buildFixUserMessage(markdown, findings),
    jsonMode: false,
    maxTokens: 8000,
  });
  if (!res || !res.ok || !res.text) return null;
  return stripCodeFence(res.text);
}

// ── PR-keyed remediation state ────────────────────────────────────────────

async function getState(db, prNumber) {
  const row = await db('codex_remediation_state').where({ pr_number: prNumber }).first();
  return row || { pr_number: prNumber, rounds: 0, status: 'active' };
}

async function saveState(db, prNumber, patch) {
  const existing = await db('codex_remediation_state').where({ pr_number: prNumber }).first();
  if (existing) {
    await db('codex_remediation_state').where({ pr_number: prNumber }).update({ ...patch, updated_at: new Date() });
  } else {
    await db('codex_remediation_state').insert({ pr_number: prNumber, ...patch, created_at: new Date(), updated_at: new Date() });
  }
}

function reviewRequestedForHead(issueComments = [], headSha = null) {
  const h = shortSha(headSha);
  return (Array.isArray(issueComments) ? issueComments : []).some((c) => {
    const body = String(c && c.body || '');
    return /@codex\s+review/i.test(body) && (!h || body.includes(h));
  });
}

async function park(db, prNumber, reason, onPark) {
  await saveState(db, prNumber, { status: 'parked' });
  if (typeof onPark === 'function') {
    try { await onPark(reason); } catch (e) { logger.warn(`[codex-remediation] onPark failed for PR #${prNumber}: ${e.message}`); }
  }
  logger.warn(`[codex-remediation] parked PR #${prNumber}: ${reason}`);
  return { parked: true, reason };
}

/**
 * Run one remediation round for a PR whose merge was blocked by Codex.
 * ctx: { prNumber, branch, slug?, onPark? }. onPark is a lane-specific
 * lifecycle hook run when the PR is parked. deps { db, gh, callAnthropic }
 * are injectable for testing.
 */
async function runRemediationForPr(ctx = {}, deps = {}) {
  const db = deps.db || dbDefault;
  const gh = deps.gh || ghDefault;
  const { prNumber, branch, slug = null, onPark = null } = ctx;
  if (!prNumber || !branch) return { skipped: true, reason: 'missing PR/branch' };

  const state = await getState(db, prNumber);
  if (state.status === 'parked') return { skipped: true, reason: 'parked' };

  const pr = await gh.getPr(prNumber);
  if (!pr || pr.state !== 'open') return { skipped: true, reason: `PR ${pr && pr.state ? pr.state : 'missing'}` };
  const headSha = pr.head && pr.head.sha ? pr.head.sha : null;

  const reviewComments = await gh.listPrReviewComments(prNumber);
  const findings = parseCodexFindings(reviewComments, headSha);

  if (findings.length === 0) {
    // No fresh findings for this head. If we've already pushed a fix, make sure
    // the re-review request actually landed (recovers from a failed
    // createIssueComment on a prior tick); then wait.
    if (state.status === 'remediating') {
      const issueComments = await gh.listIssueComments(prNumber);
      if (!reviewRequestedForHead(issueComments, headSha)) {
        await gh.createIssueComment(prNumber, buildReviewRequestBody(headSha));
        return { skipped: true, reason: 're-requested codex review (recovered)' };
      }
      return { skipped: true, reason: 'awaiting codex re-review' };
    }
    return { skipped: true, reason: 'awaiting codex review (no inline findings)' };
  }

  // Fresh findings on the current head.
  if (atRoundLimit(state.rounds)) {
    return park(db, prNumber, `exhausted ${MAX_ROUNDS} remediation rounds`, onPark);
  }

  const targetPath = pickTargetPath(findings, slug);
  if (!targetPath) return park(db, prNumber, 'could not resolve target markdown file', onPark);

  const file = await gh.getFile(targetPath, branch);
  if (!file || !file.content) return park(db, prNumber, `file not found on branch: ${targetPath}`, onPark);

  const fixed = await generateFix(file.content, findings, deps);
  if (!fixed) return { skipped: true, reason: 'no LLM available' };
  if (fixed.trim() === String(file.content).trim()) {
    return park(db, prNumber, 'remediation produced no change (likely false-positive findings)', onPark);
  }

  const round = (state.rounds || 0) + 1;
  const commit = await gh.putFile({
    path: targetPath,
    content: fixed,
    message: `fix(blog): address Codex review findings (round ${round})`,
    branch,
    sha: file.sha,
  });
  const newHead = (commit && commit.commit && commit.commit.sha)
    || (commit && commit.content && commit.content.sha)
    || (await gh.getBranchSha(branch));

  // Persist state BEFORE the comment so a createIssueComment failure can't
  // strand the PR — the next tick's recovery branch re-requests the review.
  await saveState(db, prNumber, {
    branch,
    rounds: round,
    status: 'remediating',
    last_findings: JSON.stringify(findings),
  });
  await gh.createIssueComment(prNumber, buildReviewRequestBody(newHead));

  logger.info(`[codex-remediation] round ${round} pushed for PR #${prNumber}: ${findings.length} finding(s) → ${shortSha(newHead)}`);
  return { remediated: true, round, findings: findings.length, newHead };
}

// ── Lane entry points ─────────────────────────────────────────────────────

/** Scheduler lane (pages-poll): a blog_posts row. */
async function maybeRemediateBlogPost(post, deps = {}) {
  if (!remediationEnabled()) return { skipped: true, reason: 'disabled' };
  const db = deps.db || dbDefault;
  return runRemediationForPr({
    prNumber: post.astro_pr_number,
    branch: post.astro_branch_name,
    slug: post.slug,
    onPark: async (reason) => {
      // Disarm the scheduler's publishing claim (guarded on it) so the
      // stale-publishing sweep moves the row to human review instead of it
      // sitting in the auto-merge loop for the full stale window.
      await db('blog_posts').where({ id: post.id, publish_status: 'publishing' }).update({
        publish_status: 'pending_review',
        astro_publish_error: `codex remediation parked: ${reason}`.slice(0, 1000),
        updated_at: new Date(),
      });
    },
  }, deps);
}

/** Autonomous lane (autonomous-pr-poller): a run with a live PR, no blog_posts row. */
async function maybeRemediateAutonomousPr(pr, deps = {}) {
  if (!remediationEnabled()) return { skipped: true, reason: 'disabled' };
  return runRemediationForPr({
    prNumber: pr && pr.number,
    branch: pr && pr.head && pr.head.ref,
    // path comes from the findings themselves (the autonomous run has no slug
    // column and posts are .mdx); onPark left null — the run stays parked at
    // completed_pending_review and status='parked' stops re-remediation.
    slug: null,
    onPark: null,
  }, deps);
}

module.exports = {
  maybeRemediateBlogPost,
  maybeRemediateAutonomousPr,
  runRemediationForPr,
  parseCodexFindings,
  pickTargetPath,
  buildReviewRequestBody,
  buildFixUserMessage,
  reviewRequestedForHead,
  stripCodeFence,
  atRoundLimit,
  remediationEnabled,
  MAX_ROUNDS,
};
