/**
 * codex-remediation.js — auto-remediation loop for Codex review findings on
 * autonomous blog PRs.
 *
 * The publisher refuses to merge a blog PR until Codex reports "no major
 * issues" (astro-publisher.assertCodexReviewClear throws CODEX_REVIEW_REQUIRED).
 * When Codex leaves findings, the PR would otherwise sit open forever with
 * nothing to fix it. This service, invoked from the poller when a merge is
 * blocked, reads the inline findings for the current PR head, patches the
 * markdown on the SAME branch via a direct Claude call, and re-requests
 * "@codex review" for the new head — so the poller merges once Codex clears it.
 *
 * Safety:
 *   - Gated behind AUTONOMOUS_CODEX_REMEDIATION (default OFF).
 *   - It only ever pushes to an existing draft PR branch and re-requests review;
 *     it NEVER merges (merge still requires a genuine Codex-clean signal).
 *   - Bounded by CODEX_REMEDIATION_MAX_ROUNDS (default 3). After that many
 *     unsuccessful fix rounds — or if a fix produces no change (usually a
 *     false-positive finding) — the post is parked for human review.
 *   - A round is only "spent" when Codex has actually left fresh findings for
 *     the current head. If Codex hasn't re-reviewed the latest push yet, this
 *     no-ops (waits) rather than burning a round or parking prematurely.
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
 * tied to the current head (commit_id or original_commit_id) are kept; each is
 * {path, line, body}. A comment we cannot tie to the head is skipped so a stale
 * finding never causes a round to be spent against the wrong commit.
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
 * The blog markdown file the findings target. Prefer a finding whose path is a
 * .md under the blog content dir; fall back to the post's slug-derived path.
 */
function pickTargetPath(findings = [], post = {}) {
  const fromFinding = findings
    .map((f) => f.path)
    .find((p) => typeof p === 'string' && p.startsWith(ASTRO_BLOG_DIR) && p.endsWith('.md'));
  if (fromFinding) return fromFinding;
  const slug = String(post.slug || '').replace(/^\/+|\/+$/g, '');
  return slug ? `${ASTRO_BLOG_DIR}/${slug}.md` : null;
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
  // Strip our own sentinels if the model echoed them.
  t = t.replace(/^<<<FILE\n/, '').replace(/\nFILE\s*$/, '');
  return t.trim() + '\n';
}

async function generateFix(markdown, findings, deps = {}) {
  // Route through the shared cross-provider helper (never throws; { ok, text }).
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

async function park(db, post, reason) {
  await db('blog_posts').where({ id: post.id }).update({
    codex_remediation_status: 'parked',
    astro_publish_error: `codex remediation parked: ${reason}`.slice(0, 1000),
    updated_at: new Date(),
  });
  logger.warn(`[codex-remediation] parked post ${post.id} (${post.slug || ''}): ${reason}`);
  return { parked: true, reason };
}

/**
 * Run one remediation round for a post whose PR merge was blocked by Codex.
 * Deps { db, gh, anthropic } are injectable for testing.
 */
async function runRemediationRound(inputPost, deps = {}) {
  const db = deps.db || dbDefault;
  const gh = deps.gh || ghDefault;

  // Re-fetch fresh so remediation state (rounds/status) is authoritative even
  // if the caller's row was selected without those columns.
  const post = await db('blog_posts').where({ id: inputPost.id }).first();
  if (!post) return { skipped: true, reason: 'post gone' };
  if (post.codex_remediation_status === 'parked') return { skipped: true, reason: 'parked' };
  if (!post.astro_pr_number || !post.astro_branch_name) return { skipped: true, reason: 'missing PR/branch' };

  const pr = await gh.getPr(post.astro_pr_number);
  if (!pr || pr.state !== 'open') return { skipped: true, reason: `PR ${pr && pr.state ? pr.state : 'missing'}` };
  const headSha = pr.head && pr.head.sha ? pr.head.sha : null;

  const reviewComments = await gh.listPrReviewComments(post.astro_pr_number);
  const findings = parseCodexFindings(reviewComments, headSha);

  // No fresh findings for the current head → Codex either hasn't re-reviewed
  // the latest push yet, or hit usage limits. Wait; don't burn a round or park.
  if (findings.length === 0) return { skipped: true, reason: 'awaiting codex re-review (no fresh inline findings)' };

  // Codex left fresh findings. If we've already spent our rounds, this is the
  // final rejection → park for a human.
  if (atRoundLimit(post.codex_remediation_rounds)) {
    return park(db, post, `exhausted ${MAX_ROUNDS} remediation rounds`);
  }

  const targetPath = pickTargetPath(findings, post);
  if (!targetPath) return park(db, post, 'could not resolve target markdown file');

  const file = await gh.getFile(targetPath, post.astro_branch_name);
  if (!file || !file.content) return park(db, post, `file not found on branch: ${targetPath}`);

  const fixed = await generateFix(file.content, findings, deps);
  if (!fixed) return { skipped: true, reason: 'no LLM available' };
  if (fixed.trim() === String(file.content).trim()) {
    return park(db, post, 'remediation produced no change (likely false-positive findings)');
  }

  const commit = await gh.putFile({
    path: targetPath,
    content: fixed,
    message: `fix(blog): address Codex review findings (round ${(post.codex_remediation_rounds || 0) + 1})`,
    branch: post.astro_branch_name,
    sha: file.sha,
  });
  const newHead = (commit && commit.commit && commit.commit.sha)
    || (commit && commit.content && commit.content.sha)
    || (await gh.getBranchSha(post.astro_branch_name));

  await gh.createIssueComment(post.astro_pr_number, buildReviewRequestBody(newHead));

  const round = (post.codex_remediation_rounds || 0) + 1;
  await db('blog_posts').where({ id: post.id }).update({
    codex_remediation_rounds: round,
    codex_remediation_status: 'remediating',
    codex_last_findings: JSON.stringify(findings),
    astro_commit_sha: newHead,
    updated_at: new Date(),
  });

  logger.info(`[codex-remediation] round ${round} pushed for post ${post.id} (${post.slug || ''}): ${findings.length} finding(s) → ${shortSha(newHead)}`);
  return { remediated: true, round, findings: findings.length, newHead };
}

/**
 * Poller entry point. One call handles the enable gate + a single round.
 */
async function maybeRemediate(post, deps = {}) {
  if (!remediationEnabled()) return { skipped: true, reason: 'disabled' };
  return runRemediationRound(post, deps);
}

module.exports = {
  maybeRemediate,
  runRemediationRound,
  parseCodexFindings,
  pickTargetPath,
  buildReviewRequestBody,
  buildFixUserMessage,
  stripCodeFence,
  atRoundLimit,
  remediationEnabled,
  MAX_ROUNDS,
};
