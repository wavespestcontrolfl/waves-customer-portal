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
 *     so the row leaves the auto-merge loop for human review). Every park
 *     persists its reason + the PR head it was rendered against
 *     (park_reason / parked_head_sha), and a park auto-re-arms with fresh
 *     rounds when the branch later receives a NEW head — a park is a verdict
 *     on a specific head, so a human/agent fix push resumes the loop instead
 *     of stranding the PR.
 *   - A round is only spent when Codex has left fresh findings for the current
 *     head. If Codex hasn't re-reviewed the latest push yet it no-ops (and
 *     re-posts the "@codex review" request if a prior post failed), so it never
 *     double-fires or strands a PR on a transient GitHub error.
 *   - Fixes are BODY-ONLY: any frontmatter change parks. A fix that passes the
 *     content gates but introduces named-competitor content parks (the human-
 *     sign-off stamps predate the fix). The autonomous lane re-runs the
 *     runner's uniqueness/quality/SEO/visibility gates on the rewritten body
 *     and parks on anything it can't prove; the scheduler lane mirrors the
 *     committed body into blog_posts.content (park on sync failure) so a
 *     later republish can't resurrect the pre-fix content.
 */

const dbDefault = require('../../models/db');
const ghDefault = require('../content-astro/github-client');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { callAnthropic } = require('../llm/call');
// Same deterministic pre-PR content gates the publisher runs (astro-publisher
// publishAstro) — re-run on a remediated file so an LLM fix can't slip a bad
// frontmatter / hardcoded price / disallowed claim / competitor issue past the
// preview build and merge on a Codex-clean review.
const fm = require('../content-astro/frontmatter');
const { assertValidBlogFrontmatter } = require('../content-astro/schema-validator');
const { SPOKE_SITE_KEYS } = require('../content-astro/spoke-sites');
const contentGuardrails = require('./content-guardrails');
const comparisonTableGate = require('./comparison-table-gate');
const factCheckGate = require('./fact-check-gate');
const { etDateString } = require('../../utils/datetime-et');

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
      created_at: c.created_at || c.createdAt || null,
    }))
    .filter((f) => f.body);
}

// A body "matches" the head when it embeds the full SHA or an abbreviated
// (>=7 hex char) prefix of it — Codex's completion summary prints a 10-char
// "Reviewed commit" SHA (same posture as astro-publisher.bodyMatchesHead,
// where demanding more chars stalled astro PR #357 at codex_review_pending).
function bodyMatchesHead(body, headSha) {
  const head = String(headSha || '').trim().toLowerCase();
  if (!head) return false;
  const text = String(body || '');
  if (text.toLowerCase().includes(head)) return true;
  const runs = text.match(/\b[0-9a-f]{7,40}\b/gi) || [];
  return runs.some((run) => head.startsWith(run.toLowerCase()));
}

/**
 * Evidence that the Codex review round for `headSha` COMPLETED — as opposed
 * to inline findings still streaming in. Exactly two artifacts prove
 * completion (mirroring astro-publisher.codexReviewStatus):
 *   1. a SUBMITTED (non-PENDING) Codex review object pinned to the head, or
 *   2. Codex's top-level summary issue comment embedding the head SHA.
 * A usage-limit bounce is a FAILED round, never completion. When a review
 * request timestamp exists the artifact must be STRICTLY after it — a
 * same-second tie is ambiguous and fails closed, matching the finding
 * filter in p2OnlyMergeEligible.
 */
// A usage-limit bounce is a FAILED round, never completion — regardless of
// which artifact carries it. Codex posts the bounce either as a top-level
// issue comment or (round-10, Codex P1) as the BODY of a submitted review
// object: a partial round can emit one inline P2, then submit the review
// with the bounce in its body, and treating that review as completion
// evidence would let the P2-only bar merge before the round's P0/P1s ever
// surfaced. One regex, applied to BOTH artifact kinds, so they can't drift.
const USAGE_LIMIT_BODY_RE = /usage limits|reached your Codex usage limits/i;

function codexRoundCompleted({ reviews = [], issueComments = [], headSha = null, requestedAt = 0 } = {}) {
  const head = shortSha(headSha);
  if (!head) return false;
  const afterRequest = (ts) => {
    if (!(requestedAt > 0)) return true; // no request timestamp — head match is the only anchor
    return (Date.parse(ts || 0) || 0) > requestedAt;
  };
  const submittedReview = (Array.isArray(reviews) ? reviews : []).some((r) => {
    if (!isCodexAuthor(r && (r.user?.login || r.author?.login))) return false;
    if (String(r?.state || '').toUpperCase() === 'PENDING') return false;
    if (shortSha(r?.commit_id || r?.commit?.oid) !== head) return false;
    // Round-10 (Codex P1): a submitted review whose body is the usage-limit
    // bounce is the round's failure artifact, not its completion — mirror
    // the issue-comment rejection below BEFORE this path can return true.
    if (USAGE_LIMIT_BODY_RE.test(String(r?.body || ''))) return false;
    return afterRequest(r?.submitted_at || r?.submittedAt);
  });
  if (submittedReview) return true;
  return (Array.isArray(issueComments) ? issueComments : []).some((c) => {
    if (!isCodexAuthor(c && (c.user?.login || c.author?.login))) return false;
    const body = String(c?.body || '');
    if (USAGE_LIMIT_BODY_RE.test(body)) return false;
    if (!bodyMatchesHead(body, headSha)) return false;
    return afterRequest(c?.created_at || c?.createdAt);
  });
}

// ── P2-only merge bar (autonomous blog lane) ───────────────────────────────
// A fresh Codex review can ALWAYS surface new P2s on a long post (observed
// on astro #383 and the 07-04 backlog: every re-review goes deeper), so a
// "completely clean" merge bar generates unbounded fix rounds and the lane
// never converges without a human. Owner directive 2026-07-16 ("no gates on
// the auto blog"): P0/P1 findings always block; once remediation has spent
// at least one round improving the PR, a review that leaves ONLY P2 findings
// for the current head stops blocking the merge. The P2s are logged on the
// run for the admin UI. Kill switch: AUTONOMOUS_CODEX_P2_MERGE=false.
function p2MergeEnabled() {
  return String(process.env.AUTONOMOUS_CODEX_P2_MERGE || '').trim().toLowerCase() !== 'false';
}

const SEVERITY_BADGE_RE = /!\[P([012])\s+Badge\]/i;

function findingSeverity(body) {
  const m = String(body || '').match(SEVERITY_BADGE_RE);
  // Unbadged findings fail CLOSED as P1 — an unparseable severity must never
  // downgrade into a mergeable P2.
  return m ? `P${m[1]}` : 'P1';
}

/**
 * p2OnlyMergeEligible(prNumber, headSha) → { eligible, p2Count?, rounds?, reason? }
 * eligible=true means: Codex HAS reviewed this exact head (findings tied to
 * it exist), every current-head finding is a P2, and codex_remediation_state
 * records BOTH >= 1 remediation round spent AND that the current head IS the
 * remediation commit this loop last pushed (last_push_sha). Callers still
 * run their own merge guards (deploy-green, hub-only, sha-pinned merge,
 * queue re-checks).
 */
async function p2OnlyMergeEligible(prNumber, headSha, deps = {}) {
  if (!p2MergeEnabled()) return { eligible: false, reason: 'disabled (AUTONOMOUS_CODEX_P2_MERGE=false)' };
  if (!prNumber || !headSha) return { eligible: false, reason: 'missing pr/head' };
  const db = deps.db || dbDefault;
  const gh = deps.gh || ghDefault;
  const state = await getState(db, prNumber);
  // Two ways remediation "had its shot" (the bar's precondition under the
  // owner directive):
  //   IMPROVED — the head under review IS a remediation commit this loop
  //   pushed (last_push_sha equals the current head; failed attempts never
  //   write it, and a park re-arm resets rounds but keeps last_push_sha as
  //   history, so presence alone is not enough — Round-9, Codex P2).
  //   DECLINED — remediation ATTEMPTED this head and parked with one of its
  //   own fix-safety verdicts (frontmatter-whitelist violation or a
  //   no-change round): the P2s are real but not auto-fixable within the
  //   whitelist. Observed 2026-07-22: every open content PR (#394–#398)
  //   carried ONLY P2/P3 findings yet sat unmergeable because the declined
  //   park kept last_push_sha ≠ head forever — the fixer's safety whitelist
  //   starved the very bar the "no gates on the auto blog" directive added.
  //   Scoped to the CURRENT head and to the two decline classes only —
  //   infrastructure parks (sync failures, unresolvable targets, exhausted
  //   rounds) keep holding for a human.
  const head = String(headSha).trim().toLowerCase();
  const lastPush = String(state.last_push_sha || '').trim().toLowerCase();
  const remediationImproved = Boolean(lastPush) && lastPush === head;
  const remediationDeclined = state.status === 'parked'
    && String(state.parked_head_sha || '').trim().toLowerCase() === head
    && /^(?:fix changed frontmatter beyond the whitelist|remediation produced no change)/.test(String(state.park_reason || ''));
  if (!remediationImproved && !remediationDeclined) {
    if ((state.rounds || 0) < 1) return { eligible: false, reason: 'no remediation round spent yet' };
    if (!lastPush) {
      return { eligible: false, reason: 'no pushed remediation commit recorded (spent rounds may be failed attempts)' };
    }
    return { eligible: false, reason: `current head ${shortSha(headSha)} is not the last pushed remediation commit ${shortSha(state.last_push_sha)}` };
  }
  if (remediationImproved && !remediationDeclined && (state.rounds || 0) < 1) {
    return { eligible: false, reason: 'no remediation round spent yet' };
  }
  const reviewComments = await gh.listPrReviewComments(prNumber);
  const findings = parseCodexFindings(reviewComments, headSha);
  // No findings tied to this head = either review still pending or truly
  // clean — both are the normal path's business, never this bar's.
  if (findings.length === 0) return { eligible: false, reason: 'no findings for current head' };
  // A review request can be RE-POSTED for the SAME head (usage-limit bounce
  // recovery). Mirror assertCodexReviewClear's request-timestamp posture:
  // only findings POSTED AFTER the latest current-head request count as its
  // RESPONSE, and a request with no response yet is a pending review, not
  // an eligible one. Round-9 (Codex P1): that response filter gates ONLY
  // the pending check — severity blocking below considers EVERY
  // current-head finding, because the head hasn't changed: a P0/P1 posted
  // before a same-head re-request is still an unresolved blocker even when
  // the re-review adds only P2s or doesn't repeat old comments.
  const h = shortSha(headSha);
  const issueComments = await gh.listIssueComments(prNumber);
  const latestRequestAt = (Array.isArray(issueComments) ? issueComments : [])
    .filter((c) => /@codex\s+review/i.test(String(c && c.body || '')) && (!h || String(c.body || '').includes(h)))
    .map((c) => Date.parse(c.created_at || c.createdAt || 0) || 0)
    .reduce((a, b) => Math.max(a, b), 0);
  if (latestRequestAt > 0) {
    // STRICTLY after: GitHub timestamps have second precision, so a finding
    // stamped in the same second as the re-request is ambiguous — it could
    // be the previous review's output. Fail closed (pending) on ties.
    const response = findings.filter((f) => (Date.parse(f.created_at || 0) || 0) > latestRequestAt);
    if (response.length === 0) {
      return { eligible: false, reason: 'latest same-head review request has no response yet (pending)' };
    }
  }
  const severities = findings.map((f) => findingSeverity(f.body));
  if (severities.some((s) => s === 'P0' || s === 'P1')) {
    return { eligible: false, reason: `blocking findings present (${severities.join(', ')})` };
  }
  // Round-8 (Codex P1): inline comments can stream in INCREMENTALLY while a
  // review round is in flight — a lone current-head P2 posted after the
  // request is NOT proof the round finished, and merging on it races a
  // P0/P1 that may still be generating. The P2 bar only arms on evidence of
  // a COMPLETED round: a submitted Codex review pinned to this head, or
  // Codex's top-level completion summary embedding this head's SHA, each
  // strictly after the latest same-head request. No artifact = pending.
  if (typeof gh.listPrReviews !== 'function') {
    return { eligible: false, reason: 'cannot verify codex round completion (review lookup unavailable)' };
  }
  const reviews = await gh.listPrReviews(prNumber);
  if (!codexRoundCompleted({ reviews, issueComments, headSha, requestedAt: latestRequestAt })) {
    return { eligible: false, reason: 'codex review round not completed for current head (inline findings may be partial)' };
  }
  return { eligible: true, p2Count: findings.length, rounds: state.rounds, declined: remediationDeclined && !remediationImproved };
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

function buildReviewRequestBody(newHeadSha, { initial = false } = {}) {
  return [
    '@codex review',
    '',
    initial
      ? `Requesting Codex review for head \`${newHeadSha}\` — no prior review request found for this head (the PR-open request is fail-soft and a bounced request is not queued).`
      : `Addressed the review findings on head \`${newHeadSha}\`. Please re-review.`,
  ].join('\n');
}

const FIX_SYSTEM = [
  'You fix Waves Pest Control blog post markdown files in response to automated code-review (Codex) findings.',
  'Rules:',
  '- Apply ONLY the minimal changes needed to resolve the findings. Preserve everything else exactly: document structure and the author voice.',
  '- YAML frontmatter is immutable — reproduce every key and value byte-for-byte — with EXACTLY two exceptions, and only when a finding targets them: (1) you may rewrite the `meta_description` VALUE (a complete sentence, 115–160 characters — it renders as the search snippet and the visible hero intro); (2) you may rewrite the `hero_image.alt` VALUE (describe the actual image, at most 255 characters). Never touch any other frontmatter key — not the hero/og image paths, not slug/canonical/title/dates/domains. If a finding can only be resolved by changing other frontmatter, leave that part unchanged (it will be routed to a human).',
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
    maxTokens: 16000,
  });
  if (!res || !res.ok || !res.text) return null;
  // Fail closed on a truncated completion — committing a cut-off article would
  // pass the preview build and could merge.
  if (res.response && res.response.stop_reason === 'max_tokens') return null;
  return stripCodeFence(res.text);
}

/**
 * Re-run the publisher's pre-PR content gates on a remediated file before
 * committing. Mirrors astro-publisher (frontmatter schema + content guardrails
 * + comparison/named-competitor + fact-check). Async — fact-check is an LLM
 * call. Returns { ok } or { ok:false, reason }.
 *
 * opts.service     — original topic [category, tag] from the caller. Blog
 *   frontmatter omits `tag`, so the scheduler lane passes the real topic (like
 *   astro-publisher ~787) so FAQ-blocked-service etc. fire on Rodents/Bed Bugs.
 * opts.factContext — { title, city, keyword, tag } for the fact-check gate.
 * opts.operatorFaqException — the publish path's NARROW operator-FAQ opt-out
 *   (owner directive 2026-06-11: FAQPage on every intercept post). An intercept
 *   post on a FAQ-blocked service (e.g. termite) legitimately ships WITH a FAQ,
 *   so without this flag the gate P0s on the PRE-EXISTING body and every fix
 *   parks (PR #368). Manifest-derived by the caller, never from generated
 *   content; defaults false (strict).
 */
async function validateFixedBlogFile(markdown, opts = {}, deps = {}) {
  let parsed;
  try { parsed = fm.parse(markdown); } catch (e) { return { ok: false, reason: `unparseable: ${e.message}` }; }
  const data = parsed && parsed.data;
  const body = String((parsed && parsed.content) || '').trim();
  if (!data || Object.keys(data).length === 0) return { ok: false, reason: 'missing frontmatter' };
  // A fix that keeps the frontmatter but drops the article body would sail
  // through every downstream gate (guardrails/comparison scan nothing, the
  // fact-check skips short bodies) and publish a blank post — reject here.
  if (!body) return { ok: false, reason: 'empty body' };

  try { assertValidBlogFrontmatter(data); } catch (e) { return { ok: false, reason: `frontmatter: ${e.message}` }; }

  const domains = (Array.isArray(data.domains) && data.domains.length > 0) ? data.domains : SPOKE_SITE_KEYS;
  const service = (Array.isArray(opts.service) && opts.service.some(Boolean)) ? opts.service : [data.category, data.tag];
  // Run-context allowances (autonomous lane threads them via guardContext):
  // brief-mandated links, checked-existing routes, and refresh grandfathering
  // must apply here exactly as in the run-context gate, or a valid fix parks
  // on structure findings the run legitimately carries. Scheduler lane passes
  // no context — static evaluation is its full contract.
  const runContext = opts.guardContext || {};
  const guardrails = contentGuardrails.evaluate(
    {
      body,
      frontmatter: data,
      checked_existing_routes: Array.isArray(runContext.checkedExistingRoutes) ? runContext.checkedExistingRoutes : undefined,
    },
    {
      domains,
      service,
      primaryKeyword: data.primary_keyword || null,
      operatorFaqException: opts.operatorFaqException === true,
      allowedInternalLinks: Array.isArray(runContext.allowedInternalLinks) ? runContext.allowedInternalLinks : [],
      isRefresh: runContext.isRefresh === true,
      priorBody: typeof runContext.priorBody === 'string' ? runContext.priorBody : null,
    },
  );
  if (!guardrails.pass) {
    const blocking = (guardrails.findings || []).filter((f) => f.severity === 'P0' || f.severity === 'P1');
    if (blocking.length) return { ok: false, reason: `guardrails ${blocking.map((f) => f.code).join(',')}` };
  }

  let namedCompetitorEnabled = false;
  try { namedCompetitorEnabled = require('../../config/feature-gates').isEnabled('namedCompetitorComparison') === true; } catch (_) { namedCompetitorEnabled = false; }
  const comparison = comparisonTableGate.evaluate({ body, frontmatter: data }, { namedCompetitorEnabled });
  if (!comparison.pass) {
    const blocking = (comparison.findings || []).filter((f) =>
      (f.severity === 'P0' || f.severity === 'P1') && f.code !== 'COMPARISON_UNCLASSIFIED_OPTION');
    if (blocking.length) return { ok: false, reason: `comparison ${blocking.map((f) => f.code).join(',')}` };
  }

  // Fact-check (LLM) — same P0-blocking policy as astro-publisher.assertFactCheckClear.
  const fc = opts.factContext || {};
  const evaluate = deps.factCheckEvaluate || factCheckGate.evaluate;
  const factResult = await evaluate({
    title: fc.title || data.title || '',
    body,
    city: fc.city || (Array.isArray(data.service_areas_tag) ? data.service_areas_tag[0] : '') || '',
    keyword: fc.keyword || data.primary_keyword || '',
    tag: fc.tag || data.tag || data.category || '',
  });
  if (factResult && !factResult.pass) {
    const p0 = (factResult.findings || []).filter((f) => f.severity === 'P0');
    if (p0.length) return { ok: false, reason: `factcheck ${p0.map((f) => f.message).slice(0, 2).join('; ')}` };
  }
  // A PASSING comparison gate can still demand a human: a fix that introduces
  // a (valid, sourced) named-competitor comparison sets requiresHumanReview.
  // The merge stamps that enforce it (astro_requires_human_merge / the
  // runner's named_competitor_review park) were taken BEFORE the fix, so the
  // caller must park rather than let the new head auto-merge on Codex-clean.
  return { ok: true, requiresHumanReview: comparison.requiresHumanReview === true };
}

// Canonical value serialization for frontmatter comparison: object keys are
// sorted so a pure YAML re-emit can't read as a change, while any VALUE
// difference (including array order) does.
function canonValue(v) {
  return JSON.stringify(v === undefined ? null : v, (key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val).sort().reduce((acc, k) => { acc[k] = val[k]; return acc; }, {});
    }
    return val;
  });
}

/**
 * Frontmatter is immutable during remediation — with a narrow, validated
 * whitelist. slug/canonical/domains would mark a different Astro route
 * published than the portal recorded, and most other keys (title, hero/og
 * image PATHS, author/reviewer, dates) feed merge stamps and portal columns
 * that were written BEFORE the fix and are never restamped — a frontmatter
 * delta there both diverges from that source of truth and can smuggle
 * changes past gates that only scanned the original.
 *
 * Two fields are exempt because Codex keeps flagging them, they key NOTHING
 * (no routing, no merge-target resolution), and every park they caused
 * needed a trivial human push (4th occurrence 2026-07-15, astro PR #376;
 * heroAlt class on #372/#377 before it):
 *   - `meta_description` — must stay inside the blog schema's hard
 *     115–160-char bound (it feeds the page meta/OG description and the
 *     visible hero intro).
 *   - `hero_image.alt` — non-empty, ≤255 chars (the scheduler-lane mirror
 *     column blog_posts.hero_image_alt is varchar(255) — a longer value
 *     would push the branch and then park on the row sync); the hero PATH
 *     (src) and og_image stay frozen (they reference committed bytes).
 * A whitelisted delta is additionally accepted ONLY when one of the round's
 * Codex findings actually targets that field — otherwise an LLM that
 * spontaneously rewrote SERP/hero copy while fixing a body-only finding
 * would smuggle the change past the frontmatter freeze.
 * Callers mirror both into the portal row / draft payload after the push so
 * a later republish or social share can't resurrect the flagged value, and
 * the autonomous lane re-runs its SEO/quality gates on the REWRITTEN
 * metadata (validateAutonomousRunGates swaps the fixed values into the
 * draft before evaluating).
 *
 * Returns { violation: string|null, changed: { meta_description?, hero_alt? } }.
 * Any other added/removed/altered key — or an invalid or un-targeted
 * whitelisted value — is a violation (parse failure fails closed).
 */
const META_DESCRIPTION_MIN = 115;
const META_DESCRIPTION_MAX = 160;
// blog_posts.hero_image_alt is a Knex string() → varchar(255); the whitelist
// bound must not exceed what the mirror column can store.
const HERO_ALT_MAX = 255;
const META_FINDING_RE = /meta[\s_-]?description/i;
// Alt-SPECIFIC wording only: a finding about the hero IMAGE or its path
// ("replace the misleading hero image", "use accurate hero art") must NOT
// authorize an alt rewrite — the image problem stays for a human while the
// LLM would happily "fix" the alt and mirror it. `\balt\b` covers "alt",
// "alt text", "hero alt"; `hero_?alt` covers heroAlt / hero_alt casings.
const HERO_ALT_FINDING_RE = /\balt\b|hero_?alt/i;

function frontmatterFixViolation(originalMd, fixedMd, findings = []) {
  let a; let b;
  try { a = (fm.parse(originalMd) || {}).data || {}; b = (fm.parse(fixedMd) || {}).data || {}; } catch (_) {
    return { violation: 'frontmatter unparseable after fix', changed: {} };
  }
  const findingBodies = (Array.isArray(findings) ? findings : []).map((f) => String((f && f.body) || ''));
  const metaTargeted = findingBodies.some((t) => META_FINDING_RE.test(t));
  const altTargeted = findingBodies.some((t) => HERO_ALT_FINDING_RE.test(t));
  const changed = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (canonValue(a[k]) === canonValue(b[k])) continue;
    if (k === 'meta_description') {
      if (!metaTargeted) {
        return { violation: 'meta_description changed but no finding in this round targets it', changed: {} };
      }
      const v = b.meta_description;
      const len = typeof v === 'string' ? v.trim().length : 0;
      if (len < META_DESCRIPTION_MIN || len > META_DESCRIPTION_MAX) {
        return { violation: `meta_description rewrite is ${len} chars (schema bound ${META_DESCRIPTION_MIN}–${META_DESCRIPTION_MAX})`, changed: {} };
      }
      changed.meta_description = v;
      continue;
    }
    if (k === 'hero_image') {
      const av = (a.hero_image && typeof a.hero_image === 'object') ? a.hero_image : {};
      const bv = (b.hero_image && typeof b.hero_image === 'object') ? b.hero_image : {};
      const subKeys = new Set([...Object.keys(av), ...Object.keys(bv)]);
      for (const sk of subKeys) {
        if (sk !== 'alt' && canonValue(av[sk]) !== canonValue(bv[sk])) {
          return { violation: `hero_image.${sk} changed (only hero_image.alt is fixable — the path references committed bytes)`, changed: {} };
        }
      }
      if (!altTargeted) {
        return { violation: 'hero_image.alt changed but no finding in this round targets it', changed: {} };
      }
      const alt = bv.alt;
      if (typeof alt !== 'string' || !alt.trim() || alt.trim().length > HERO_ALT_MAX) {
        return { violation: `hero_image.alt rewrite invalid (empty or >${HERO_ALT_MAX} chars)`, changed: {} };
      }
      changed.hero_alt = alt;
      continue;
    }
    return { violation: `frontmatter key "${k}" changed (immutable during remediation; fixable: meta_description, hero_image.alt)`, changed: {} };
  }
  return { violation: null, changed };
}

/**
 * Metadata quality re-check for a rewritten meta_description on the
 * SCHEDULER lane. The autonomous lane re-runs the full quality gate on the
 * rewritten metadata (validateAutonomousRunGates swaps it into the draft),
 * but the scheduler lane's only gate is validateFixedBlogFile, which never
 * invokes content-quality-gate — so a 115–160-char rewrite carrying PII or
 * title/meta spam would ship and mirror into blog_posts unchecked. Re-run
 * exactly the two checks the publish-time gate applies to SEO fields, on
 * the REWRITTEN text only (the legacy body is deliberately NOT re-scanned —
 * it predates the fix, and grading old content with a stricter-than-publish
 * gate parks every fix on legacy posts, the PR #368 lesson).
 */
function validateRewrittenMeta(metaDescription, factContext = null, deps = {}) {
  try {
    // The title is deliberately OMITTED from both checks below: the
    // whitelist can never change it, and evaluateTitleMetaSpam hard-fails
    // titles with pre-existing issues (near-me, >90 chars, term repeats) —
    // passing the unchanged legacy title would park a clean meta rewrite
    // over content this fix didn't touch. An empty title skips every
    // title check (inspectTitle early-returns) while the meta inspection
    // still runs in full.
    const spamGate = deps.titleMetaSpamGate || require('./title-meta-spam-gate');
    const spam = spamGate.evaluateTitleMetaSpam({
      title: '',
      meta_description: metaDescription,
      city: factContext ? factContext.city : undefined,
      service: factContext ? factContext.tag : undefined,
      target_keyword: factContext ? factContext.keyword : undefined,
    });
    if (!spam || spam.ok !== true) {
      const reasons = ((spam && spam.hard_failures) || []).map((f) => f.reason || f.code).join(',');
      return { ok: false, reason: `title/meta spam: ${reasons || 'no result'}` };
    }
    // PII: reuse the quality gate's own redaction evaluator, scoped to the
    // REWRITTEN text only (body = the meta gets the same prose-style scan
    // the gate applies to meta fields). The unchanged title is deliberately
    // NOT passed: it predates the fix, and the gate's Title-Case
    // heading-pair heuristic would park legitimate meta fixes on legacy
    // posts whose titles were never graded by this gate at publish time.
    const qualityGate = deps.contentQualityGate || require('./content-quality-gate');
    const pii = qualityGate._internals.checkRedactionPassed({
      body: metaDescription,
      title: '',
      meta_description: metaDescription,
      frontmatter: {},
    });
    if (!pii || pii.ok !== true) {
      return { ok: false, reason: `pii: ${(pii && pii.reason) || 'no result'}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `metadata quality re-check threw: ${e.message}` };
  }
}

// ── Deterministic date-restamp carve-out ──────────────────────────────────
//
// Date-stamp findings ("use a non-future publish date", placeholder 1970
// dates, "use current dates before publishing") are FRONTMATTER findings, so
// the body-only LLM fix can never resolve them — every date-flagged PR parked
// for a human. Unlike the rest of the frontmatter, the date fields don't key
// routing (slug/canonical/domains) or the pollers' merge-target resolution,
// and both remediation lanes only ever serve UNMERGED publish PRs — so
// "today in ET" is by construction the truthful value for all of them at the
// moment a fix lands. The restamp is pure code (no LLM ever writes
// frontmatter), and a pure-date round skips the LLM call entirely.

const FRONTMATTER_DATE_FIELDS = ['published', 'updated', 'technically_reviewed', 'fact_checked'];

function isDateStampFinding(finding) {
  const b = String((finding && finding.body) || '').toLowerCase();
  if (!/\bdates?\b/.test(b)) return false;
  return /\b(future|current|past|stale|placeholder|outdated|1970|epoch|today|publish\w*)\b/.test(b);
}

// `published` is restamped ONLY when the caller knows the PR publishes a
// brand-new post (includePublished) — on a refresh of an already-live page,
// rewriting `published` to today would silently change the article's
// original publication date. Freshness/review fields (updated /
// technically_reviewed / fact_checked / modified) are safe to restamp on
// either lane: the file IS being updated by this very fix.
function restampFrontmatterDates(markdown, { today = etDateString(), includePublished = false } = {}) {
  let parsed;
  try { parsed = fm.parse(markdown); } catch (_) { return { markdown, changed: false }; }
  const data = parsed && parsed.data;
  if (!data || Object.keys(data).length === 0) return { markdown, changed: false };
  let changed = false;
  const fields = includePublished
    ? FRONTMATTER_DATE_FIELDS
    : FRONTMATTER_DATE_FIELDS.filter((k) => k !== 'published');
  for (const key of fields) {
    if (data[key] !== undefined && data[key] !== today) { data[key] = today; changed = true; }
  }
  // Service/location pages carry a datetime `modified` instead of `updated`;
  // blog files normally won't have it, but restamp it if present.
  if (data.modified !== undefined && String(data.modified).slice(0, 10) !== today) {
    data.modified = `${today}T12:00:00`;
    changed = true;
  }
  if (!changed) return { markdown, changed: false };
  return { markdown: fm.stringify(data, parsed.content), changed: true };
}

function parseJsonMaybe(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function envBool(key, defaultValue = false) {
  const value = process.env[key];
  if (value == null || value === '') return defaultValue;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  return defaultValue;
}

// Same semantics as autonomous-runner's envInt (negative values → default).
function envInt(key, defaultValue = null) {
  const raw = process.env[key];
  if (raw == null || raw === '') return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

/**
 * Frontmatter schema is FROZEN during remediation (body-only fixes), but the
 * publisher derives schema_types FROM the body (astro-publisher
 * schemaTypesForContent — e.g. FAQPage appears iff the body has a visible FAQ
 * section). A body fix that adds/removes a FAQ therefore strands the frozen
 * frontmatter describing content that no longer exists (P0-class structured-
 * data mismatch on the live page). Returns true when the fix changes the
 * derived schema-type set — the caller parks (restamping frontmatter is a
 * human call). Fails closed (true) when the derivation is unavailable.
 */
function schemaShapeChanged(originalMd, fixedMd, deps = {}) {
  let derive = deps.schemaTypesForContent;
  if (!derive) {
    // Exposed on the publisher's _internals (same derivation buildFrontmatter uses).
    try { derive = require('../content-astro/astro-publisher')._internals.schemaTypesForContent; } catch (_) { return true; }
  }
  if (typeof derive !== 'function') return true;
  let a; let b;
  try {
    a = derive(String((fm.parse(originalMd) || {}).content || ''));
    b = derive(String((fm.parse(fixedMd) || {}).content || ''));
  } catch (_) { return true; }
  return canonValue([...(a || [])].sort()) !== canonValue([...(b || [])].sort());
}

/**
 * Re-run the AUTONOMOUS runner's publish gates on a remediated .mdx before
 * committing — the runner's uniqueness / quality / SEO-completion /
 * pre-publish-visibility verdicts were rendered on the ORIGINAL body
 * (autonomous-runner runNext step 4–5b) and a body rewrite can invalidate any
 * of them (dropped CTA/FAQ/component, broken SEO contract, corpus duplicate,
 * unindexable HTML). Mirrors the runner's inputs: the stored draft_payload
 * with the fixed body swapped in, the brief the run was generated against
 * (_loadReviewedBrief), and the published-blog corpus (_loadBlogCorpus).
 *
 * Only new_supporting_blog runs are validated — that is the only autonomous
 * action whose gate set this mirrors, so anything else fails closed (parks
 * for a human) rather than committing a fix we can't prove safe.
 *
 * Returns { ok } or { ok:false, reason }. Every failure path is a park.
 */
async function validateAutonomousRunGates(fixedMarkdown, run, deps = {}) {
  try {
    if (!run || !run.id) return { ok: false, reason: 'autonomous run row unavailable' };
    const db = deps.db || dbDefault;
    // Re-fetch the FULL run row — callers pass whatever their poll SELECT
    // happened to include (pollPending omits facts_sufficiency, which would
    // silently un-gate the claims-ledger re-run below). The gate set must
    // never depend on a caller's column list; same pattern as the scheduler
    // lane's blog_posts re-fetch. Missing row fails closed.
    run = await db('autonomous_runs').where({ id: run.id }).first();
    if (!run) return { ok: false, reason: 'autonomous run row not found' };
    if (run.action_type !== 'new_supporting_blog') {
      return { ok: false, reason: `remediation gates only cover new_supporting_blog runs (got ${run.action_type || 'unknown'})` };
    }
    const runner = deps.autonomousRunner || require('./autonomous-runner');
    const guardrailsMod = deps.contentGuardrails || contentGuardrails;
    const comparisonMod = deps.comparisonTableGate || comparisonTableGate;
    const uniquenessGate = deps.uniquenessGate || require('./uniqueness-gate');
    const qualityGate = deps.qualityGate || require('./content-quality-gate');
    const seoCompletionGate = deps.seoCompletionGate || require('./seo-completion-gate');
    const aiVisibilityGate = deps.aiVisibilityGate || require('./ai-visibility-gate');

    const draft0 = parseJsonMaybe(run.draft_payload);
    if (!draft0 || !draft0.body) return { ok: false, reason: 'stored draft_payload missing or empty' };
    const brief = await runner._loadReviewedBrief(run);
    if (!brief) return { ok: false, reason: 'brief not found for run' };

    let parsed;
    try { parsed = fm.parse(fixedMarkdown); } catch (e) { return { ok: false, reason: `unparseable fix: ${e.message}` }; }
    const draft = { ...draft0, body: String((parsed && parsed.content) || '').trim() };
    if (!draft.body) return { ok: false, reason: 'fixed body is empty' };
    // The fix may carry whitelisted frontmatter rewrites (meta_description /
    // hero alt). The stored payload predates them, so swap the FIXED values
    // into the draft before evaluating — otherwise the SEO/quality gates
    // below re-validate the STALE metadata and a rewritten meta_description
    // reaches the branch (and the draft_payload mirror) ungated.
    const fixedData = (parsed && parsed.data) || {};
    if (typeof fixedData.meta_description === 'string' && fixedData.meta_description.trim()) {
      draft.meta_description = fixedData.meta_description;
      if (draft.frontmatter && typeof draft.frontmatter === 'object') {
        draft.frontmatter = { ...draft.frontmatter, meta_description: fixedData.meta_description };
      }
    }
    const fixedAlt = (fixedData.hero_image && typeof fixedData.hero_image === 'object') ? fixedData.hero_image.alt : undefined;
    if (typeof fixedAlt === 'string' && fixedAlt.trim() && draft.frontmatter && typeof draft.frontmatter === 'object') {
      draft.frontmatter = {
        ...draft.frontmatter,
        hero_image: {
          ...(draft.frontmatter.hero_image && typeof draft.frontmatter.hero_image === 'object' ? draft.frontmatter.hero_image : {}),
          alt: fixedAlt,
        },
      };
    }

    // 0a. Claims-ledger validation for facts-gated runs (runner step 3b): the
    //     run's claims_ledger_result was rendered against the ORIGINAL body,
    //     and a rewrite can introduce an unledgered local claim or a
    //     facts-bank-disallowed phrase that the stale result never saw. Same
    //     trigger, inputs, and fail-closed posture as the runner — facts were
    //     sufficient, so a MISSING ledger is a P1, and an unavailable or
    //     throwing validator parks rather than skipping the hallucinated-fact
    //     P0s. The stored ledger rides draft_payload, so validating the
    //     body-swapped draft checks the REWRITTEN claims against it.
    const factsCtx = parseJsonMaybe(run.facts_sufficiency);
    if (factsCtx && factsCtx.applicable && factsCtx.sufficient) {
      let claimsValidator = deps.claimsLedgerValidator;
      if (!claimsValidator) {
        try { claimsValidator = require('./claims-ledger-validator'); } catch (_) { claimsValidator = null; }
      }
      if (!claimsValidator || typeof claimsValidator.validate !== 'function') {
        return { ok: false, reason: 'claims-ledger validator unavailable for a facts-gated run' };
      }
      let claimsResult;
      try {
        claimsResult = await claimsValidator.validate(draft, {
          city: factsCtx.city_id,
          service: factsCtx.service_id,
          county: factsCtx.county,
        }, { options: { missingLedgerSeverity: 'P1' } });
      } catch (err) {
        return { ok: false, reason: `claims-ledger validation threw: ${err.message}` };
      }
      if (!claimsResult || claimsResult.pass !== true) {
        const codes = (((claimsResult && claimsResult.findings) || []).filter((f) => f.severity === 'P0' || f.severity === 'P1')).map((f) => `${f.severity} ${f.code}`);
        return { ok: false, reason: `claims-ledger: ${codes.join('; ') || 'no result'}` };
      }
    }

    // 0. Content-policy gates with the RUN's context. validateFixedBlogFile
    //    already ran them with frontmatter-derived context, but the runner's
    //    context is stricter and lives off the opportunity + brief: FAQ-blocked
    //    topics ride voice_constraints.operator_brief.faq_blocked_topic /
    //    opp.service (frontmatter omits them), and the comparison gate needs
    //    operatorBriefText so an operator-authorized competitor mention doesn't
    //    depend on it while an UNauthorized one gets flagged. Missing
    //    opportunity row fails closed.
    const opp = run.opportunity_id ? await db('opportunity_queue').where({ id: run.opportunity_id }).first() : null;
    if (!opp) return { ok: false, reason: 'opportunity row unavailable for guardrail context' };
    const guardOptions = await runner._deriveGuardrailOptions(opp, brief);
    const guardResult = guardrailsMod.evaluate(draft, guardOptions);
    if (!guardResult || guardResult.pass !== true) {
      const codes = (((guardResult && guardResult.findings) || []).filter((f) => f.severity === 'P0' || f.severity === 'P1')).map((f) => `${f.severity} ${f.code}`);
      return { ok: false, reason: `run-context guardrails: ${codes.join('; ') || 'no result'}` };
    }
    let namedCompetitorEnabled = false;
    try { namedCompetitorEnabled = require('../../config/feature-gates').isEnabled('namedCompetitorComparison') === true; } catch (_) { namedCompetitorEnabled = false; }
    // _internals is absent on injected test runners → null operatorBriefText,
    // which only makes the gate STRICTER (authorized mentions park for a human).
    const opText = (runner._internals && typeof runner._internals.operatorBriefTextForComparisonGate === 'function')
      ? runner._internals.operatorBriefTextForComparisonGate(opp, brief)
      : null;
    const comparisonResult = comparisonMod.evaluate(draft, { namedCompetitorEnabled, operatorBriefText: opText });
    if (!comparisonResult || comparisonResult.pass !== true) {
      const codes = (((comparisonResult && comparisonResult.findings) || []).filter((f) => f.severity === 'P0' || f.severity === 'P1')).map((f) => f.code);
      return { ok: false, reason: `run-context comparison gate: ${codes.join(',') || 'no result'}` };
    }
    if (comparisonResult.requiresHumanReview === true) {
      return { ok: false, reason: 'fix introduces named-competitor content under run context (requires human sign-off)' };
    }

    // 1. Blog-corpus dedup (same env default as the runner: on unless
    //    explicitly disabled). Corpus load is required — fail closed.
    let uniquenessResult = { ok: true, skipped: 'not_applicable' };
    if (envBool('AUTONOMOUS_CONTENT_BLOG_UNIQUENESS', true)) {
      const siblingPages = await runner._loadBlogCorpus({ required: true });
      uniquenessResult = uniquenessGate.evaluateBlog(draft, brief, { siblingPages });
    }
    if (uniquenessResult.ok !== true) {
      return { ok: false, reason: `uniqueness gate: ${uniquenessResult.error || JSON.stringify(uniquenessResult.failures || uniquenessResult.findings || []).slice(0, 200)}` };
    }

    // 2. Quality gate. ctx is {} exactly as runNext passes for supporting
    //    blogs (sitemap + previousVersion hydration are refresh-only).
    const qualityResult = qualityGate.evaluate(draft, brief, {});
    if (!qualityResult || qualityResult.ok !== true) {
      return { ok: false, reason: `quality gate: ${(qualityResult && (qualityResult.error || JSON.stringify(qualityResult.failures || []).slice(0, 200))) || 'no result'}` };
    }

    // 3. SEO-completion gate — same brief coercion runNext applies, and a
    //    skipped verdict on a supporting blog is a failure, not a pass.
    const seoGateBrief = {
      ...brief,
      action_type: run.action_type,
      page_type: brief.page_type || 'supporting-blog',
    };
    const seoResult = seoCompletionGate.evaluate({
      draft,
      brief: seoGateBrief,
      uniquenessResult,
      shadowMode: false,
      actionType: run.action_type,
      pageType: seoGateBrief.page_type,
    });
    if (!seoResult || seoResult.skipped || seoResult.passed !== true) {
      const p0 = ((seoResult && seoResult.findings) || []).filter((f) => f.severity === 'P0').map((f) => f.code);
      return { ok: false, reason: `seo-completion gate: ${(seoResult && (seoResult.error || p0.join(','))) || 'no result'}` };
    }

    // 3b. SEO canary limits — the content-relevant subset of the runner's
    //     _evaluatePublishingGuards, same env semantics (enable flag defaults
    //     true for new_supporting_blog). The gate can pass with P1 findings a
    //     rewrite introduced (dropped CTA / service link / city link); the
    //     runner would refuse to open a PR for that body, so remediation must
    //     refuse to commit it. Publish-rate caps and infra-availability guards
    //     are deliberately NOT mirrored: they gate publish timing, not body
    //     content, and the poller enforces its own daily merge cap.
    if (envBool('AUTONOMOUS_CONTENT_ENABLE_CANARY_GUARDS', true)) {
      if (envBool('AUTONOMOUS_CONTENT_REQUIRE_ZERO_P0', false) && Number(seoResult?.summary?.p0 || 0) > 0) {
        return { ok: false, reason: `seo canary: ${seoResult.summary.p0} P0 finding(s) with zero-P0 required` };
      }
      const maxP1 = envInt('AUTONOMOUS_CONTENT_MAX_P1_FINDINGS', null);
      if (maxP1 != null && Number(seoResult?.summary?.p1 || 0) > maxP1) {
        return { ok: false, reason: `seo canary: ${seoResult.summary.p1} P1 finding(s), above max ${maxP1}` };
      }
    }

    // 4. Pre-publish visibility static checks on the rewritten body.
    const visResult = aiVisibilityGate.evaluateStatic({ url: draft.url, html: draft.body });
    if (!visResult || visResult.passed !== true) {
      return { ok: false, reason: `pre-publish visibility: ${(visResult && (visResult.error || JSON.stringify((visResult.findings || []).map((f) => f.code)).slice(0, 200))) || 'no result'}` };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `autonomous gate re-run failed: ${err.message}` };
  }
}

// ── PR-keyed remediation state ────────────────────────────────────────────

async function getState(db, prNumber) {
  const row = await db('codex_remediation_state').where({ pr_number: prNumber }).first();
  return row || { pr_number: prNumber, rounds: 0, status: 'active' };
}

const TERMINAL_REMEDIATION_STATES = ['merged', 'closed'];

async function saveState(db, prNumber, patch) {
  // Insert-or-guarded-update, safe against a concurrent markPrTerminal in
  // EVERY interleaving: terminal rows are immutable (a round that began
  // while the PR was open can finish after the terminal stamp — its write
  // must not flip status back to remediating/parked), and a blind insert
  // could recreate a live row right after a tombstone check. onConflict
  // ignore + status-guarded update makes the stamp win; callers get false
  // when it did and must stop the round.
  await db('codex_remediation_state')
    .insert({ pr_number: prNumber, ...patch, created_at: new Date(), updated_at: new Date() })
    .onConflict('pr_number')
    .ignore();
  const updated = await db('codex_remediation_state')
    .where({ pr_number: prNumber })
    .whereNotIn('status', TERMINAL_REMEDIATION_STATES)
    .update({ ...patch, updated_at: new Date() });
  return updated > 0;
}

/**
 * Stamp a PR's remediation row terminal ('merged' | 'closed') once the PR
 * leaves the open state. Nothing transitioned these rows before, so merged
 * PRs stayed at 'parked'/'remediating'/'active' forever — dead rows that
 * read as live park telemetry to anyone sweeping park_reason. Bookkeeping
 * only and fail-soft. When no row exists yet a terminal TOMBSTONE is
 * created: an in-flight round whose first saveState hasn't landed would
 * otherwise insert a live 'remediating' row after the PR already left the
 * open state (saveState's guarded update then loses to nothing).
 */
async function markPrTerminal(prNumber, status, injectedDb = null) {
  const dbc = injectedDb || dbDefault;
  try {
    const n = Number(prNumber);
    if (!Number.isInteger(n) || !TERMINAL_REMEDIATION_STATES.includes(status)) return { updated: 0 };
    // ONE atomic statement: tombstone a missing row, flip a live one, leave
    // a terminal one untouched. A separate update-then-insert had a window
    // where a racing round's first saveState could land a live row (and pass
    // its pre-push guard) between the two — with the upsert, whichever of
    // the stamp and the first save commits first wins, and saveState's
    // status-guarded update then sees the terminal row and aborts the round.
    // 'merged' is permanent (merges are irreversible); 'closed' may only be
    // UPGRADED to 'merged' (a closed PR can be reopened and later merged).
    const res = await dbc.raw(
      `INSERT INTO codex_remediation_state (pr_number, status, rounds, created_at, updated_at)
       VALUES (?, ?, 0, NOW(), NOW())
       ON CONFLICT (pr_number) DO UPDATE
         SET status = EXCLUDED.status, updated_at = NOW()
       WHERE codex_remediation_state.status <> 'merged'
         AND (codex_remediation_state.status <> 'closed' OR EXCLUDED.status = 'merged')`,
      [n, status],
    );
    return { updated: res?.rowCount ?? 0 };
  } catch (err) {
    logger.warn(`[codex-remediation] terminal stamp failed for PR #${prNumber}: ${err.message}`);
    return { updated: 0, error: err.message };
  }
}

function reviewRequestedForHead(issueComments = [], headSha = null) {
  const h = shortSha(headSha);
  return (Array.isArray(issueComments) ? issueComments : []).some((c) => {
    const body = String(c && c.body || '');
    return /@codex\s+review/i.test(body) && (!h || body.includes(h));
  });
}

async function park(db, prNumber, reason, onPark, headSha = null) {
  // Persist the reason and the head the verdict applied to — the reason used
  // to live only in logs (short retention: three parked autonomous PRs were
  // undiagnosable after the fact), and the head is what lets a later push
  // re-arm the loop (a park is a verdict on a specific head, not on the PR).
  const wrote = await saveState(db, prNumber, {
    status: 'parked',
    park_reason: String(reason || '').slice(0, 1000),
    parked_head_sha: headSha ? String(headSha).trim().toLowerCase() : null,
  });
  if (!wrote) {
    // The PR merged/closed while this round ran — the row is terminal and a
    // park (plus its run-notes annotation) would be stale noise.
    logger.info(`[codex-remediation] park skipped for PR #${prNumber}: row already terminal (${reason})`);
    return { parked: false, skipped: true, reason };
  }
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
  const {
    prNumber, branch, slug = null, service = null, factContext = null,
    operatorFaqException = false, guardContext = null,
    onPark = null, revalidateFix = null, onRemediated = null, prePushCheck = null,
  } = ctx;
  if (!prNumber || !branch) return { skipped: true, reason: 'missing PR/branch' };

  const state = await getState(db, prNumber);

  const pr = await gh.getPr(prNumber);
  if (!pr || pr.state !== 'open') return { skipped: true, reason: `PR ${pr && pr.state ? pr.state : 'missing'}` };
  const headSha = pr.head && pr.head.sha ? pr.head.sha : null;

  if (state.status === 'closed') {
    // A 'closed' tombstone can go stale: PRs can be REOPENED, and this code
    // only ever runs for a merge-blocked OPEN PR — so the observation in
    // hand contradicts the tombstone. Re-arm with a direct CAS ('merged'
    // stays permanent; saveState's terminal guard is deliberately bypassed
    // here because this is the one sanctioned closed→live transition).
    await db('codex_remediation_state')
      .where({ pr_number: prNumber, status: 'closed' })
      .update({ status: 'active', rounds: 0, park_reason: null, parked_head_sha: null, updated_at: new Date() });
    state.status = 'active';
    state.rounds = 0;
    logger.info(`[codex-remediation] re-armed closed-tombstoned PR #${prNumber}: PR observed open again (reopened)`);
  }

  if (state.status === 'parked') {
    // A park is a verdict on the head it was rendered against. If the branch
    // has since received a NEW head (a human or agent pushed a fix), the
    // verdict is stale — re-arm with fresh rounds so the loop can carry that
    // push the rest of the way. Same head (or no head to compare) stays
    // parked. Legacy rows parked before parked_head_sha existed re-arm once:
    // the round either succeeds or re-parks stamping reason + head, so this
    // converges instead of looping.
    const parkedHead = String(state.parked_head_sha || '').trim().toLowerCase();
    const currentHead = String(headSha || '').trim().toLowerCase();
    // A 'moved past' park claims ANOTHER push superseded ours mid-round. If
    // the live head IS the push we parked against, that claim was a stale
    // getPr read-after-write (PR #383) — and because such parks stamp OUR
    // pushed head, the head-advanced re-arm below can never fire (the stamp
    // equals the real head). The premise is contradicted by the observation
    // in hand, so re-arm on it. Other same-head parks (sync failures, gate
    // failures) keep holding for a human as designed.
    let staleMovedPastPark = Boolean(parkedHead) && parkedHead === currentHead
      && /^pr head moved past the remediation push/.test(String(state.park_reason || ''));
    if (staleMovedPastPark) {
      // The same-head observation could ITSELF be a stale getPr read of a
      // genuine parallel push (park correctly recorded our push B, a real C
      // landed, and getPr still serves B). Only the branch ref agreeing that
      // the parked push IS the tip proves the park's premise false. Ref
      // disagrees (or is unreadable) → stay parked; the next tick observes
      // the true head and the ordinary head-advance re-arm carries it.
      let refHead = null;
      try { refHead = String((await gh.getBranchSha(branch)) || '').trim().toLowerCase(); } catch (_) { refHead = null; }
      if (refHead !== currentHead) staleMovedPastPark = false;
    }
    if (!currentHead || (parkedHead && parkedHead === currentHead && !staleMovedPastPark)) {
      // Same-head park = held for a human. But a park is a verdict on
      // remediation's ability to FIX this head, not on Codex REVIEWING it —
      // if Codex has neither inline findings, a submitted review, nor a
      // verdict comment for the head, and no "@codex review" request names
      // it, the poller sits at codex_review_pending forever with nothing in
      // flight (astro #394/#395, 2026-07-22: a manual fix push and a
      // remediation push whose re-review request was lost each parked with
      // an unreviewed head for 24h+). Post the request, still stay parked.
      // The branch ref must CONFIRM the observed head first (same stale-read
      // posture as the 'moved past' check above) — a request embedding a
      // stale SHA would just be noise. Bounded: the posted request embeds
      // the head SHA, so the next tick sees it and returns plain 'parked'.
      // Fail-soft: a lookup/post error never blocks the parked hold.
      if (currentHead) {
        try {
          const inlineForHead = parseCodexFindings(await gh.listPrReviewComments(prNumber), headSha);
          if (inlineForHead.length === 0) {
            const reviews = typeof gh.listPrReviews === 'function' ? await gh.listPrReviews(prNumber) : [];
            const issueComments = await gh.listIssueComments(prNumber);
            const responded = codexRoundCompleted({ reviews, issueComments, headSha });
            if (!responded && !reviewRequestedForHead(issueComments, headSha)) {
              let refHead = null;
              try { refHead = String((await gh.getBranchSha(branch)) || '').trim().toLowerCase(); } catch (_) { refHead = null; }
              if (refHead === currentHead) {
                await gh.createIssueComment(prNumber, buildReviewRequestBody(headSha, { initial: true }));
                logger.info(`[codex-remediation] parked PR #${prNumber}: requested Codex review for unreviewed head ${shortSha(headSha)} (park stands)`);
                return { skipped: true, reason: 'parked (requested codex review for unreviewed head)' };
              }
            }
          }
        } catch (err) {
          logger.warn(`[codex-remediation] parked review-signal check failed for PR #${prNumber}: ${err.message}`);
        }
      }
      return { skipped: true, reason: 'parked' };
    }
    await saveState(db, prNumber, { status: 'active', rounds: 0, park_reason: null, parked_head_sha: null });
    state.status = 'active';
    state.rounds = 0;
    logger.info(staleMovedPastPark
      ? `[codex-remediation] re-armed parked PR #${prNumber}: 'moved past' park contradicted — the branch head IS the parked push ${currentHead.slice(0, 7)} (stale read at park time)`
      : `[codex-remediation] re-armed parked PR #${prNumber}: head advanced ${parkedHead ? `${parkedHead.slice(0, 7)} → ` : ''}${currentHead.slice(0, 7)}`);
  }

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
    // Never remediated this PR and no findings: make sure a review request
    // covering the CURRENT head exists at all. The publisher's PR-open
    // request is fail-soft (and a usage-limit bounce is not queued), so a PR
    // whose initial request was lost would otherwise sit at
    // CODEX_REVIEW_REQUIRED forever with this branch waiting on a review
    // that was never asked for. Bounded: the posted request embeds the head
    // SHA, so subsequent ticks see it and wait instead of re-posting.
    const issueComments = await gh.listIssueComments(prNumber);
    if (!reviewRequestedForHead(issueComments, headSha)) {
      await gh.createIssueComment(prNumber, buildReviewRequestBody(headSha, { initial: true }));
      return { skipped: true, reason: 'requested codex review (no request found for current head)' };
    }
    return { skipped: true, reason: 'awaiting codex review (no inline findings)' };
  }

  // Fresh findings on the current head.
  if (atRoundLimit(state.rounds)) {
    return park(db, prNumber, `exhausted ${MAX_ROUNDS} remediation rounds`, onPark, headSha);
  }

  const targetPath = pickTargetPath(findings, slug);
  if (!targetPath) return park(db, prNumber, 'could not resolve target markdown file', onPark, headSha);

  const file = await gh.getFile(targetPath, branch);
  if (!file || !file.content) return park(db, prNumber, `file not found on branch: ${targetPath}`, onPark, headSha);

  // Deterministic date-restamp carve-out: resolve date-stamp findings in code
  // (today ET), and only send the REMAINING findings to the body-only LLM fix.
  // ctx.restampPublished — lane assertion that this PR publishes a BRAND-NEW
  // post, which is what makes rewriting `published` truthful; without it only
  // the freshness/review fields restamp. If the restamp changed nothing
  // (dates already current), the findings were misclassified — leave them in
  // the LLM list so the false-positive park path still applies.
  const dateFindings = findings.filter(isDateStampFinding);
  let baseline = file.content;
  if (dateFindings.length > 0) {
    const restamp = restampFrontmatterDates(baseline, { includePublished: ctx.restampPublished === true });
    if (restamp.changed) baseline = restamp.markdown;
  }
  const restamped = baseline !== file.content;
  const llmFindings = restamped ? findings.filter((f) => !isDateStampFinding(f)) : findings;

  let fixed;
  if (llmFindings.length === 0 && restamped) {
    // Pure date round — the restamp IS the fix; no LLM in the loop.
    fixed = baseline;
  } else {
    fixed = await generateFix(baseline, llmFindings, deps);
  }
  if (!fixed) {
    // Bound the failure: an unavailable / repeatedly-truncating LLM would
    // otherwise re-invoke every tick forever. Count the attempt and park at the
    // round limit so the PR reaches human review instead of looping.
    const attempt = (state.rounds || 0) + 1;
    await saveState(db, prNumber, { branch, rounds: attempt });
    if (atRoundLimit(attempt)) return park(db, prNumber, 'LLM produced no valid fix after max attempts', onPark, headSha);
    return { skipped: true, reason: 'no valid LLM fix (will retry)' };
  }
  if (fixed.trim() === String(file.content).trim()) {
    return park(db, prNumber, 'remediation produced no change (likely false-positive findings)', onPark, headSha);
  }
  // Frontmatter is immutable during remediation outside the validated
  // meta_description / hero_image.alt whitelist — any other added/removed/
  // altered key parks: routing keys would mark a different URL published
  // than the portal recorded, and the rest feed merge stamps and portal
  // columns written before the fix that nothing restamps. Compared against
  // the restamped baseline, so the deterministic date restamp above plus the
  // whitelist are the ONLY frontmatter deltas that can ever pass.
  const fmDelta = frontmatterFixViolation(baseline, fixed, findings);
  if (fmDelta.violation) {
    return park(db, prNumber, `fix changed frontmatter beyond the whitelist: ${fmDelta.violation}`, onPark, headSha);
  }
  // Scheduler-lane metadata quality re-check (the autonomous lane covers
  // this inside revalidateFix — validateAutonomousRunGates swaps the
  // rewritten metadata into the draft before its quality gate runs).
  if (typeof revalidateFix !== 'function' && fmDelta.changed.meta_description !== undefined) {
    const metaVerdict = validateRewrittenMeta(fmDelta.changed.meta_description, factContext, deps);
    if (!metaVerdict.ok) {
      return park(db, prNumber, `rewritten meta_description failed metadata quality checks: ${metaVerdict.reason}`, onPark, headSha);
    }
  }
  // The frozen frontmatter must still DESCRIBE the fixed body: schema_types is
  // derived from the body at publish (FAQPage iff a visible FAQ exists), so a
  // body fix that adds/removes a FAQ section would ship structured data for
  // content that isn't there. Park — restamping schema is a human call.
  const schemaChanged = deps.schemaShapeChanged || schemaShapeChanged;
  if (schemaChanged(file.content, fixed, deps)) {
    return park(db, prNumber, 'fix changes the body-derived schema types (frontmatter schema is frozen)', onPark, headSha);
  }
  // An un-interpolated {{token}} in an .mdx body crashes the MDX compile —
  // publishOrUpdatePage blocks these before opening a PR (astro-publisher
  // mdxBreakingToken), so a fix that introduces one would strand the PR on a
  // failed preview build. Same guard here; unavailable/throwing fails closed.
  if (targetPath.endsWith('.mdx')) {
    let tokenOf = deps.mdxBreakingToken;
    if (!tokenOf) {
      try { tokenOf = require('../content-astro/astro-publisher')._internals.mdxBreakingToken; } catch (_) { tokenOf = null; }
    }
    if (typeof tokenOf !== 'function') return park(db, prNumber, 'mdx token guard unavailable (fail closed)', onPark, headSha);
    let token = null;
    try { token = tokenOf(String((fm.parse(fixed) || {}).content || '')); } catch (e) { return park(db, prNumber, `mdx token guard failed: ${e.message}`, onPark, headSha); }
    if (token) return park(db, prNumber, `fix introduces an MDX-breaking token (${token})`, onPark, headSha);
  }

  // Re-run the publisher's content-safety gates on the fix before committing —
  // a fix that fails them is worse than the original finding, so park it.
  const validate = deps.validateFixedBlogFile || validateFixedBlogFile;
  const gate = await validate(fixed, { service, factContext, operatorFaqException, guardContext }, deps);
  if (!gate || !gate.ok) return park(db, prNumber, `fix failed content gates: ${gate && gate.reason}`, onPark, headSha);
  // A passing fix that INTRODUCES a named-competitor comparison still needs a
  // human: the merge stamps enforcing that sign-off (astro_requires_human_merge
  // / named_competitor_review) predate the fix and are never restamped here.
  if (gate.requiresHumanReview === true) {
    return park(db, prNumber, 'fix introduces named-competitor content (requires human sign-off)', onPark, headSha);
  }

  // Lane-specific gate re-run (autonomous lane: uniqueness / quality /
  // SEO-completion / visibility on the rewritten body). Fail or throw → park.
  if (typeof revalidateFix === 'function') {
    let recheck;
    try { recheck = await revalidateFix(fixed); } catch (e) { recheck = { ok: false, reason: e.message }; }
    if (!recheck || recheck.ok !== true) {
      return park(db, prNumber, `fix failed lane gates: ${(recheck && recheck.reason) || 'no result'}`, onPark, headSha);
    }
  }

  // Last-instant pre-push guard, mirroring the merge path's: the LLM call and
  // gate re-runs above take real time, and the lane's claim (queue row /
  // publishing claim / tracked PR) can move while they run. A failed or
  // throwing check skips WITHOUT spending a round or touching state — if the
  // lane re-arms for this PR later, remediation resumes; if it was superseded,
  // the poller stops invoking it.
  if (typeof prePushCheck === 'function') {
    let stillArmed = false;
    try { stillArmed = (await prePushCheck()) === true; } catch (_) { stillArmed = false; }
    if (!stillArmed) return { skipped: true, reason: 'lane state moved during remediation (pre-push check failed)' };
  }

  const round = (state.rounds || 0) + 1;
  // Mark 'remediating' BEFORE the push so a later save/comment failure can't
  // strand the fix — the recovery branch keys off status='remediating'.
  // A false return means markPrTerminal won (the PR merged/closed while
  // this round was in flight) — stop BEFORE gh.putFile so we never push
  // fixes to a branch whose PR already left the open state.
  const armed = await saveState(db, prNumber, { branch, status: 'remediating' });
  if (!armed) return { skipped: true, reason: 'pr left the open state during remediation (terminal row)' };

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

  // Post-push revalidation: the PR can merge/close in the window between the
  // pre-push saveState and gh.putFile. The push itself is then inert (the
  // commit sits on a branch main never took), but the sync below would
  // mirror content into portal state that was NEVER included in main — so
  // verify the PR is still open and our commit is actually its head before
  // any post-commit synchronization. Best-effort on transient GitHub errors
  // (the recovery branch re-drives an interrupted round next tick).
  try {
    const fresh = await gh.getPr(prNumber);
    if (!fresh || fresh.merged || fresh.merged_at || fresh.state !== 'open') {
      const terminal = fresh && (fresh.merged || fresh.merged_at) ? 'merged' : 'closed';
      await markPrTerminal(prNumber, terminal, db);
      logger.warn(`[codex-remediation] PR #${prNumber} left the open state during the fix push — skipping post-commit sync (fix commit ${shortSha(newHead)} not in main)`);
      return { skipped: true, reason: 'pr left the open state during remediation (post-push check)' };
    }
    if (fresh.head?.sha && newHead
      && String(fresh.head.sha).trim().toLowerCase() !== String(newHead).trim().toLowerCase()) {
      // Ambiguous mismatch: either a parallel push landed mid-round, or getPr
      // served a stale read-after-write snapshot behind our OWN putFile (PR
      // #383 — the "moved past" head was the parent of our commit, and the
      // park below then wedged forever because it stamps the real head). The
      // branch ref is authoritative for putFile's own write; consult it
      // before withholding the sync. A getBranchSha failure falls through to
      // the park (fail closed — the parked-branch contradiction re-arm
      // recovers it if the read was stale).
      let refHead = null;
      try { refHead = String((await gh.getBranchSha(branch)) || '').trim().toLowerCase(); } catch (_) { refHead = null; }
      if (refHead !== String(newHead).trim().toLowerCase()) {
        // A parallel push (usually a human) landed mid-round: our fix is no
        // longer the head, so syncing it would mirror content the merge won't
        // take. Park like the other withheld-sync paths — and stamp OUR
        // pushed head, so the parked row re-arms on the very next blocked
        // tick (branch head ≠ parked head) and remediation re-evaluates the
        // newer content with fresh rounds instead of going silent.
        return park(db, prNumber, `pr head moved past the remediation push (${shortSha(newHead)} → ${shortSha(refHead || fresh.head.sha)}); sync withheld`, onPark, newHead);
      }
      // The ref confirms our push IS the branch head — but the snapshot that
      // misreported the head may misreport PR state too (a close landing
      // right behind the push). Re-fetch and re-run the terminal-state check
      // on the fresher read before any post-commit sync; a throw here lands
      // in the outer catch (park, sync withheld — fail closed).
      const recheck = await gh.getPr(prNumber);
      if (!recheck || recheck.merged || recheck.merged_at || recheck.state !== 'open') {
        const terminal = recheck && (recheck.merged || recheck.merged_at) ? 'merged' : 'closed';
        await markPrTerminal(prNumber, terminal, db);
        logger.warn(`[codex-remediation] PR #${prNumber} left the open state during the fix push — skipping post-commit sync (fix commit ${shortSha(newHead)} not in main)`);
        return { skipped: true, reason: 'pr left the open state during remediation (post-push check)' };
      }
      // The re-read must ALSO agree our push is the head: a concurrent push C
      // can land between the ref confirmation and this read, and proceeding
      // would sync content the merge won't take. Park on any disagreement —
      // stamped with OUR push, both cases converge: a real C re-arms via
      // head-advance next tick; a still-stale read re-arms via the
      // contradiction check (the ref will again confirm our push is the tip).
      if (!recheck.head?.sha
        || String(recheck.head.sha).trim().toLowerCase() !== String(newHead).trim().toLowerCase()) {
        return park(db, prNumber, `pr head moved past the remediation push (${shortSha(newHead)} → ${shortSha(recheck.head?.sha)}); sync withheld`, onPark, newHead);
      }
      // Open AND at our head on the re-read → proceed with the round.
    }
  } catch (e) {
    // Fail CLOSED: proceeding could mirror a fix into portal state that
    // never reached main (if the PR merged during the push and this fetch
    // failed), and completing the round would record it so nothing ever
    // re-checks. The 'remediating'-recovery branch only re-requests review —
    // it cannot re-run the sync — so park instead: sync withheld, the lane's
    // onPark disarms/annotates, and a human (or a re-arm on a new head)
    // reconciles. Stamped with newHead so our own push can't self-re-arm.
    return park(db, prNumber, `post-push PR revalidation failed (fix commit ${shortSha(newHead)} pushed, sync withheld): ${e.message}`, onPark, newHead || headSha);
  }

  // Lane-specific post-commit sync (scheduler lane: mirror the fixed body into
  // blog_posts.content so a later edit/republish/social share can't resurrect
  // the pre-fix body). A failed sync parks: the branch now diverges from the
  // portal row, and onPark disarms the publishing claim so the poller can't
  // merge that divergence — a human reconciles instead.
  if (typeof onRemediated === 'function') {
    try {
      const body = String((fm.parse(fixed) || {}).content || '').trim();
      await onRemediated({ markdown: fixed, body, newHead, round, datesRestamped: restamped, frontmatterChanges: fmDelta.changed });
    } catch (e) {
      // Stamp the park with newHead, NOT the pre-push headSha: the fix commit
      // is already on the branch, so a headSha stamp would make the re-arm
      // logic read our own push as "head advanced" next tick and un-park the
      // exact divergence this park exists to hold for a human.
      return park(db, prNumber, `portal row sync failed after fix commit ${shortSha(newHead)}: ${e.message}`, onPark, newHead || headSha);
    }
  }

  // last_push_sha is the P2-only merge bar's proof that a remediation round
  // actually PUSHED (round 9) — only this success path may write it; the
  // no-valid-fix retry path spends rounds without it.
  await saveState(db, prNumber, { rounds: round, last_push_sha: newHead || null, last_findings: JSON.stringify(findings) });
  await gh.createIssueComment(prNumber, buildReviewRequestBody(newHead));

  logger.info(`[codex-remediation] round ${round} pushed for PR #${prNumber}: ${findings.length} finding(s) → ${shortSha(newHead)}`);
  return { remediated: true, round, findings: findings.length, newHead };
}

// ── Lane entry points ─────────────────────────────────────────────────────

/** Scheduler lane (pages-poll): a blog_posts row. */
async function maybeRemediateBlogPost(post, deps = {}) {
  if (!remediationEnabled()) return { skipped: true, reason: 'disabled' };
  const db = deps.db || dbDefault;
  // Re-fetch the full row — pollPending's SELECT omits astro_pr_number and the
  // topic/fact-check fields (category/tag/title/city/keyword) that remediation
  // and the content gates need.
  const row = await db('blog_posts').where({ id: post.id }).first();
  if (!row) return { skipped: true, reason: 'post gone' };
  return runRemediationForPr({
    prNumber: row.astro_pr_number,
    branch: row.astro_branch_name,
    slug: row.slug,
    // Rows under the `publishing` claim are initial publishes (pages-poll's
    // lane), so restamping `published` to the fix date is truthful here.
    restampPublished: true,
    // Frontmatter `category` is often only the broad Astro value; pass the real
    // topic like the publisher does so FAQ-blocked-service etc. fire.
    service: [row.category, row.tag],
    factContext: { title: row.title, city: row.city, keyword: row.keyword, tag: row.tag },
    // Mirror the committed fix into the portal row. blog_posts.content is the
    // BODY only (publishAstro rebuilds frontmatter from row columns), and
    // frontmatter is immutable during remediation, so the body is the whole
    // delta — without this, a later republish or social share rebuilds from
    // the pre-fix content and resurrects the issue Codex flagged.
    // Last-instant claim check before the branch push (the CAS below guards
    // the row write; this guards the BRANCH write): skip the push entirely
    // when the row left the publishing claim or was repointed mid-flight.
    prePushCheck: async () => {
      const fresh = await db('blog_posts').where({ id: row.id }).first();
      return !!fresh && fresh.publish_status === 'publishing'
        && fresh.astro_pr_number === row.astro_pr_number
        && fresh.astro_branch_name === row.astro_branch_name;
    },
    // Compare-and-set on the publishing claim + tracked PR/branch: the LLM
    // call, gates, and GitHub write above take real time, and the stale-
    // publishing sweep or an admin republish can move the row (or repoint it
    // at a NEW PR) mid-flight — an id-only update would overwrite the current
    // row with the OLD PR's fixed body. A CAS miss throws → the caller parks.
    onRemediated: async ({ markdown, body, datesRestamped, frontmatterChanges }) => {
      const patch = { content: body, updated_at: new Date() };
      // Whitelisted frontmatter fixes mirror into their row columns for the
      // same reason the body does: publishAstro rebuilds frontmatter from
      // blog_posts on a republish, so an unmirrored meta_description /
      // hero alt would resurrect the exact value Codex flagged.
      if (frontmatterChanges && frontmatterChanges.meta_description !== undefined) {
        patch.meta_description = frontmatterChanges.meta_description;
      }
      if (frontmatterChanges && frontmatterChanges.hero_alt !== undefined) {
        patch.hero_image_alt = frontmatterChanges.hero_alt;
      }
      // When the deterministic date restamp is part of the committed fix,
      // mirror the corrected dates into the row's DATE columns too —
      // otherwise the PR merges with healed frontmatter while blog_posts
      // still stores the corrupt 1970/future values, so admin/SEO reads and
      // any later rebuild-from-row keep resurfacing them.
      if (datesRestamped) {
        let data = null;
        try { data = (fm.parse(markdown) || {}).data || null; } catch (_) { data = null; }
        if (data) {
          if (data.published) patch.publish_date = data.published;
          if (data.technically_reviewed) patch.technically_reviewed_at = data.technically_reviewed;
          if (data.fact_checked) patch.fact_checked_at = data.fact_checked;
        }
      }
      const updated = await db('blog_posts').where({
        id: row.id,
        publish_status: 'publishing',
        astro_pr_number: row.astro_pr_number,
        astro_branch_name: row.astro_branch_name,
      }).update(patch);
      if (!updated) throw new Error(`blog_posts row ${row.id} no longer matches the publishing claim / tracked PR (state moved during remediation)`);
    },
    onPark: async (reason) => {
      // Disarm the scheduler's publishing claim (guarded on it) so the
      // stale-publishing sweep moves the row to human review instead of it
      // sitting in the auto-merge loop for the full stale window. Same CAS
      // as the content sync: a row swept and REPUBLISHED against a new PR/
      // branch mid-remediation is a fresh claim this stale round must not
      // disarm (or stamp with its stale error).
      await db('blog_posts').where({
        id: row.id,
        publish_status: 'publishing',
        astro_pr_number: row.astro_pr_number,
        astro_branch_name: row.astro_branch_name,
      }).update({
        publish_status: 'pending_review',
        astro_publish_error: `codex remediation parked: ${reason}`.slice(0, 1000),
        updated_at: new Date(),
      });
    },
  }, deps);
}

/** Autonomous lane (autonomous-pr-poller): a run with a live PR, no blog_posts row. */
async function maybeRemediateAutonomousPr(pr, run = null, deps = {}) {
  if (!remediationEnabled()) return { skipped: true, reason: 'disabled' };
  const revalidate = deps.validateAutonomousRunGates || validateAutonomousRunGates;
  const db = deps.db || dbDefault;
  // Derive the publish path's narrow operator-FAQ exception from the run's
  // opportunity + brief via the SAME runner derivation the run-context gate
  // uses — an intercept post on a FAQ-blocked service carries its FAQ by
  // owner mandate, and evaluating validateFixedBlogFile without the flag
  // P0s the pre-existing body so every fix parks (PR #368). Scoped to
  // new_supporting_blog (the only action the gates cover — and skipping it
  // avoids the refresh lane's live-frontmatter load on every tick); any
  // missing row or lookup failure stays false, which only parks (stricter),
  // never merges.
  let operatorFaqException = false;
  // Full run-context for the preflight gate: the static frontmatter-derived
  // evaluate would P0 brief-mandated links, checked-existing routes, and
  // refresh-grandfathered content the run-context gate allows — the preflight
  // must judge the fix with the SAME allowances or valid fixes park.
  let guardContext = null;
  try {
    const fullRun = run && run.id ? await db('autonomous_runs').where({ id: run.id }).first() : null;
    const opp = (fullRun && fullRun.action_type === 'new_supporting_blog' && fullRun.opportunity_id)
      ? await db('opportunity_queue').where({ id: fullRun.opportunity_id }).first()
      : null;
    if (opp) {
      const runner = deps.autonomousRunner || require('./autonomous-runner');
      const brief = await runner._loadReviewedBrief(fullRun);
      if (brief) {
        const guardOptions = await runner._deriveGuardrailOptions(opp, brief);
        operatorFaqException = !!guardOptions && guardOptions.operatorFaqException === true;
        let dp = fullRun.draft_payload;
        if (typeof dp === 'string') { try { dp = JSON.parse(dp); } catch (_) { dp = null; } }
        guardContext = {
          ...guardOptions,
          checkedExistingRoutes: Array.isArray(dp?.checked_existing_routes) ? dp.checked_existing_routes : [],
        };
      }
    }
  } catch (e) {
    logger.warn(`[codex-remediation] operator-FAQ exception derivation failed for PR #${pr && pr.number}: ${e.message} — evaluating gates without it`);
  }
  return runRemediationForPr({
    guardContext,
    prNumber: pr && pr.number,
    branch: pr && pr.head && pr.head.ref,
    // path comes from the findings themselves (the autonomous run has no slug
    // column and posts are .mdx).
    slug: null,
    // Only a brand-new publish may restamp `published` — refresh/rewrite
    // lanes must never rewrite an existing post's publication date. (Those
    // lanes park at validateAutonomousRunGates before any commit anyway;
    // this keeps the invariant local instead of relying on that gate.)
    restampPublished: (run && run.action_type) === 'new_supporting_blog',
    operatorFaqException,
    // Surface the park on the run itself: the run stays parked at
    // completed_pending_review (status='parked' stops re-remediation until a
    // new head re-arms), and without this note the ONLY record of why lived
    // in short-retention logs — a parked PR was indistinguishable from one
    // still waiting on Codex. Append-only; park() wraps this in try/catch so
    // an annotation failure never blocks the park itself.
    onPark: run && run.id ? async (reason) => {
      const fresh = await db('autonomous_runs').where({ id: run.id }).first();
      if (!fresh) return;
      const note = `Codex remediation parked PR #${pr.number}: ${String(reason || '').slice(0, 500)} — fix the findings on the PR branch (a new head re-arms remediation) or merge/close manually.`;
      await db('autonomous_runs').where({ id: run.id }).update({
        reviewer_notes: [fresh.reviewer_notes, note].filter(Boolean).join(' | '),
        updated_at: new Date(),
      });
    } : null,
    // Mirror whitelisted frontmatter fixes into the run's draft payload: the
    // poller's finalize path builds the social-share caption from
    // draft_payload's meta_description, so an unmirrored fix would post the
    // exact truncated snippet Codex flagged. Fail-SOFT, unlike the scheduler
    // lane's row sync (runRemediationForPr parks when onRemediated throws):
    // a stale caption degrades to the title-only fallback, never a wrong
    // route — not worth parking a pushed fix over, so failures only warn.
    onRemediated: run && run.id ? async ({ frontmatterChanges }) => {
      if (!frontmatterChanges
        || (frontmatterChanges.meta_description === undefined && frontmatterChanges.hero_alt === undefined)) return;
      try {
        const fresh = await db('autonomous_runs').where({ id: run.id }).first();
        if (!fresh || !fresh.draft_payload) return;
        const payload = typeof fresh.draft_payload === 'string' ? JSON.parse(fresh.draft_payload) : fresh.draft_payload;
        if (!payload || typeof payload !== 'object') return;
        payload.frontmatter = payload.frontmatter && typeof payload.frontmatter === 'object' ? payload.frontmatter : {};
        if (frontmatterChanges.meta_description !== undefined) {
          payload.frontmatter.meta_description = frontmatterChanges.meta_description;
        }
        if (frontmatterChanges.hero_alt !== undefined) {
          payload.frontmatter.hero_image = {
            ...(payload.frontmatter.hero_image && typeof payload.frontmatter.hero_image === 'object' ? payload.frontmatter.hero_image : {}),
            alt: frontmatterChanges.hero_alt,
          };
        }
        await db('autonomous_runs').where({ id: run.id }).update({
          draft_payload: JSON.stringify(payload),
          updated_at: new Date(),
        });
      } catch (e) {
        logger.warn(`[codex-remediation] draft_payload mirror failed for PR #${pr && pr.number}: ${e.message} — social caption may use the pre-fix value`);
      }
    } : null,
    // Re-run the runner's publish gates on the rewritten body before it can
    // commit — the run's uniqueness/quality/SEO/visibility verdicts covered
    // the ORIGINAL body only. Missing run row fails closed inside (parks).
    revalidateFix: (fixedMarkdown) => revalidate(fixedMarkdown, run, deps),
    // Last-instant queue re-check before the branch push (the poller's check
    // runs BEFORE the LLM round; this one closes the window during it).
    prePushCheck: deps.prePushCheck || null,
  }, deps);
}

module.exports = {
  maybeRemediateBlogPost,
  maybeRemediateAutonomousPr,
  runRemediationForPr,
  markPrTerminal,
  parseCodexFindings,
  pickTargetPath,
  buildReviewRequestBody,
  buildFixUserMessage,
  reviewRequestedForHead,
  validateFixedBlogFile,
  validateAutonomousRunGates,
  frontmatterFixViolation,
  validateRewrittenMeta,
  schemaShapeChanged,
  isDateStampFinding,
  restampFrontmatterDates,
  _internals: { saveState, getState },
  stripCodeFence,
  atRoundLimit,
  remediationEnabled,
  p2MergeEnabled,
  p2OnlyMergeEligible,
  findingSeverity,
  MAX_ROUNDS,
};
