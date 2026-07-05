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
  '- Apply ONLY the minimal changes needed to resolve the findings. Preserve everything else exactly: document structure and the author voice.',
  '- NEVER change the YAML frontmatter — reproduce every key and value byte-for-byte. All fixes go in the Markdown body. If a finding can only be resolved by changing frontmatter, leave that part unchanged (it will be routed to a human).',
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
  const guardrails = contentGuardrails.evaluate(
    { body, frontmatter: data },
    { domains, service, primaryKeyword: data.primary_keyword || null },
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
 * The ENTIRE frontmatter is immutable during remediation — fixes are body-only.
 * slug/canonical/domains would mark a different Astro route published than the
 * portal recorded, and everything else (title, description, hero/og images,
 * author/reviewer, dates) feeds merge stamps and portal columns that were
 * written BEFORE the fix and are never restamped — a frontmatter delta both
 * diverges from that source of truth and can smuggle changes past gates that
 * only scanned the original. Returns true if ANY key was added, removed, or
 * altered (parse failure counts as changed — fail closed).
 */
function immutableFrontmatterChanged(originalMd, fixedMd) {
  let a; let b;
  try { a = (fm.parse(originalMd) || {}).data || {}; b = (fm.parse(fixedMd) || {}).data || {}; } catch (_) { return true; }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) { if (canonValue(a[k]) !== canonValue(b[k])) return true; }
  return false;
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
  const {
    prNumber, branch, slug = null, service = null, factContext = null,
    onPark = null, revalidateFix = null, onRemediated = null,
  } = ctx;
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
  if (!fixed) {
    // Bound the failure: an unavailable / repeatedly-truncating LLM would
    // otherwise re-invoke every tick forever. Count the attempt and park at the
    // round limit so the PR reaches human review instead of looping.
    const attempt = (state.rounds || 0) + 1;
    await saveState(db, prNumber, { branch, rounds: attempt });
    if (atRoundLimit(attempt)) return park(db, prNumber, 'LLM produced no valid fix after max attempts', onPark);
    return { skipped: true, reason: 'no valid LLM fix (will retry)' };
  }
  if (fixed.trim() === String(file.content).trim()) {
    return park(db, prNumber, 'remediation produced no change (likely false-positive findings)', onPark);
  }
  // Frontmatter is immutable during remediation (fixes are body-only) — any
  // added/removed/altered key parks: routing keys would mark a different URL
  // published than the portal recorded, and the rest feed merge stamps and
  // portal columns written before the fix that nothing restamps.
  if (immutableFrontmatterChanged(file.content, fixed)) {
    return park(db, prNumber, 'fix changed frontmatter (immutable during remediation — fixes are body-only)', onPark);
  }
  // The frozen frontmatter must still DESCRIBE the fixed body: schema_types is
  // derived from the body at publish (FAQPage iff a visible FAQ exists), so a
  // body fix that adds/removes a FAQ section would ship structured data for
  // content that isn't there. Park — restamping schema is a human call.
  const schemaChanged = deps.schemaShapeChanged || schemaShapeChanged;
  if (schemaChanged(file.content, fixed, deps)) {
    return park(db, prNumber, 'fix changes the body-derived schema types (frontmatter schema is frozen)', onPark);
  }

  // Re-run the publisher's content-safety gates on the fix before committing —
  // a fix that fails them is worse than the original finding, so park it.
  const validate = deps.validateFixedBlogFile || validateFixedBlogFile;
  const gate = await validate(fixed, { service, factContext }, deps);
  if (!gate || !gate.ok) return park(db, prNumber, `fix failed content gates: ${gate && gate.reason}`, onPark);
  // A passing fix that INTRODUCES a named-competitor comparison still needs a
  // human: the merge stamps enforcing that sign-off (astro_requires_human_merge
  // / named_competitor_review) predate the fix and are never restamped here.
  if (gate.requiresHumanReview === true) {
    return park(db, prNumber, 'fix introduces named-competitor content (requires human sign-off)', onPark);
  }

  // Lane-specific gate re-run (autonomous lane: uniqueness / quality /
  // SEO-completion / visibility on the rewritten body). Fail or throw → park.
  if (typeof revalidateFix === 'function') {
    let recheck;
    try { recheck = await revalidateFix(fixed); } catch (e) { recheck = { ok: false, reason: e.message }; }
    if (!recheck || recheck.ok !== true) {
      return park(db, prNumber, `fix failed lane gates: ${(recheck && recheck.reason) || 'no result'}`, onPark);
    }
  }

  const round = (state.rounds || 0) + 1;
  // Mark 'remediating' BEFORE the push so a later save/comment failure can't
  // strand the fix — the recovery branch keys off status='remediating'.
  await saveState(db, prNumber, { branch, status: 'remediating' });

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

  // Lane-specific post-commit sync (scheduler lane: mirror the fixed body into
  // blog_posts.content so a later edit/republish/social share can't resurrect
  // the pre-fix body). A failed sync parks: the branch now diverges from the
  // portal row, and onPark disarms the publishing claim so the poller can't
  // merge that divergence — a human reconciles instead.
  if (typeof onRemediated === 'function') {
    try {
      const body = String((fm.parse(fixed) || {}).content || '').trim();
      await onRemediated({ markdown: fixed, body, newHead, round });
    } catch (e) {
      return park(db, prNumber, `portal row sync failed after fix commit ${shortSha(newHead)}: ${e.message}`, onPark);
    }
  }

  await saveState(db, prNumber, { rounds: round, last_findings: JSON.stringify(findings) });
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
    // Frontmatter `category` is often only the broad Astro value; pass the real
    // topic like the publisher does so FAQ-blocked-service etc. fire.
    service: [row.category, row.tag],
    factContext: { title: row.title, city: row.city, keyword: row.keyword, tag: row.tag },
    // Mirror the committed fix into the portal row. blog_posts.content is the
    // BODY only (publishAstro rebuilds frontmatter from row columns), and
    // frontmatter is immutable during remediation, so the body is the whole
    // delta — without this, a later republish or social share rebuilds from
    // the pre-fix content and resurrects the issue Codex flagged.
    // Compare-and-set on the publishing claim + tracked PR/branch: the LLM
    // call, gates, and GitHub write above take real time, and the stale-
    // publishing sweep or an admin republish can move the row (or repoint it
    // at a NEW PR) mid-flight — an id-only update would overwrite the current
    // row with the OLD PR's fixed body. A CAS miss throws → the caller parks.
    onRemediated: async ({ body }) => {
      const updated = await db('blog_posts').where({
        id: row.id,
        publish_status: 'publishing',
        astro_pr_number: row.astro_pr_number,
        astro_branch_name: row.astro_branch_name,
      }).update({ content: body, updated_at: new Date() });
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
  return runRemediationForPr({
    prNumber: pr && pr.number,
    branch: pr && pr.head && pr.head.ref,
    // path comes from the findings themselves (the autonomous run has no slug
    // column and posts are .mdx); onPark left null — the run stays parked at
    // completed_pending_review and status='parked' stops re-remediation.
    slug: null,
    onPark: null,
    // Re-run the runner's publish gates on the rewritten body before it can
    // commit — the run's uniqueness/quality/SEO/visibility verdicts covered
    // the ORIGINAL body only. Missing run row fails closed inside (parks).
    revalidateFix: (fixedMarkdown) => revalidate(fixedMarkdown, run, deps),
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
  validateFixedBlogFile,
  validateAutonomousRunGates,
  immutableFrontmatterChanged,
  schemaShapeChanged,
  stripCodeFence,
  atRoundLimit,
  remediationEnabled,
  MAX_ROUNDS,
};
