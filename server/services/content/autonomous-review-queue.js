/**
 * autonomous-review-queue.js — read model for human review of parked
 * autonomous content engine work.
 */

const db = require('../../models/db');
const logger = require('../logger');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ALLOWED_STATUSES = new Set(['pending_review', 'pending', 'claimed', 'done', 'skipped', 'expired']);
const ALLOWED_DECISIONS = new Set(['requeue', 'dismiss', 'approve_trust_build', 'approve_named_competitor']);

async function listReviewItems({ status = 'pending_review', limit = DEFAULT_LIMIT } = {}) {
  const normalizedStatus = normalizeStatus(status);
  const boundedLimit = normalizeLimit(limit);

  try {
    const counts = await countsByStatus();
    const opportunities = await db('opportunity_queue')
      .where('status', normalizedStatus)
      .orderBy('updated_at', 'desc')
      .limit(boundedLimit)
      .select('*');

    const opportunityIds = opportunities.map((row) => row.id);
    const [briefRows, runRows] = opportunityIds.length
      ? await Promise.all([
        db('content_briefs')
          .whereIn('opportunity_id', opportunityIds)
          .orderBy('composed_at', 'desc')
          .select('*'),
        db('autonomous_runs')
          .whereIn('opportunity_id', opportunityIds)
          .orderBy('claimed_at', 'desc')
          .select('*'),
      ])
      : [[], []];

    const briefs = latestByOpportunity(briefRows);
    const runs = latestByOpportunity(runRows);

    return {
      status: normalizedStatus,
      limit: boundedLimit,
      counts,
      items: opportunities.map((opportunity) => buildReviewItem({
        opportunity,
        brief: briefs.get(opportunity.id),
        run: runs.get(opportunity.id),
        includeDraftBody: false,
      })),
    };
  } catch (err) {
    if (err.code === '42P01') {
      logger.warn(`[autonomous-review-queue] missing review table: ${err.message}`);
      return { status: normalizedStatus, limit: boundedLimit, counts: {}, items: [], unavailable: true };
    }
    throw err;
  }
}

async function getReviewItem(opportunityId) {
  const opportunity = await db('opportunity_queue').where('id', opportunityId).first();
  if (!opportunity) return null;

  const [brief, run] = await Promise.all([
    db('content_briefs')
      .where('opportunity_id', opportunityId)
      .orderBy('composed_at', 'desc')
      .first(),
    db('autonomous_runs')
      .where('opportunity_id', opportunityId)
      .orderBy('claimed_at', 'desc')
      .first(),
  ]);

  return buildReviewItem({ opportunity, brief, run, includeDraftBody: true });
}

async function decideReviewItem(opportunityId, { decision, note, reviewer } = {}) {
  const normalizedDecision = normalizeDecision(decision);
  const reviewerName = normalizeReviewer(reviewer);
  const cleanNote = normalizeNote(note);
  const opportunity = await db('opportunity_queue').where('id', opportunityId).first();
  if (!opportunity) return null;
  if (opportunity.status !== 'pending_review') {
    const err = new Error(`Opportunity is ${opportunity.status}, expected pending_review`);
    err.statusCode = 409;
    err.isOperational = true;
    throw err;
  }

  const run = await db('autonomous_runs')
    .where('opportunity_id', opportunityId)
    .orderBy('claimed_at', 'desc')
    .first();

  if (normalizedDecision === 'approve_trust_build') {
    assertTrustBuildRun(run);
    await db.transaction(async (trx) => {
      await updatePendingReviewOpportunity(trx, opportunityId, {
        status: 'done',
        skip_reason: 'trust_build_approved',
        completed_at: new Date(),
        updated_at: new Date(),
      });
      await trx('autonomous_runs').where('id', run.id).update({
        trust_build_approved_at: new Date(),
        trust_build_approved_by: reviewerName,
        reviewer_notes: appendReviewerNote(run.reviewer_notes, {
          decision: normalizedDecision,
          reviewer: reviewerName,
          note: cleanNote,
        }),
        updated_at: new Date(),
      });
    });
  } else if (normalizedDecision === 'approve_named_competitor') {
    assertNamedCompetitorReviewRun(run);
    // Publish the reviewed draft (PR or live) via the autonomous runner, THEN
    // complete the opportunity. Publish runs first so a gate/guard/publish
    // failure leaves the item pending_review rather than falsely 'done'.
    const runner = require('./autonomous-runner');
    const result = await runner.approveAndPublishNamedCompetitor(opportunityId, { approvedBy: reviewerName });
    await db.transaction(async (trx) => {
      await updatePendingReviewOpportunity(trx, opportunityId, {
        status: 'done',
        skip_reason: result.published_url ? 'named_competitor_published' : 'named_competitor_pr_open',
        completed_at: new Date(),
        updated_at: new Date(),
      });
      if (run?.id) {
        await trx('autonomous_runs').where('id', run.id).update({
          reviewer_notes: appendReviewerNote(run.reviewer_notes, {
            decision: normalizedDecision,
            reviewer: reviewerName,
            note: cleanNote,
          }),
          updated_at: new Date(),
        });
      }
    });
  } else if (normalizedDecision === 'requeue') {
    await db.transaction(async (trx) => {
      await updatePendingReviewOpportunity(trx, opportunityId, {
        status: 'pending',
        claimed_at: null,
        completed_at: null,
        skip_reason: null,
        updated_at: new Date(),
      });
      if (run?.id) {
        await trx('autonomous_runs').where('id', run.id).update({
          reviewer_notes: appendReviewerNote(run.reviewer_notes, {
            decision: normalizedDecision,
            reviewer: reviewerName,
            note: cleanNote,
          }),
          updated_at: new Date(),
        });
      }
    });
  } else if (normalizedDecision === 'dismiss') {
    await db.transaction(async (trx) => {
      await updatePendingReviewOpportunity(trx, opportunityId, {
        status: 'skipped',
        skip_reason: boundedReason(cleanNote ? `manual_dismiss:${cleanNote}` : 'manual_dismiss'),
        completed_at: new Date(),
        updated_at: new Date(),
      });
      if (run?.id) {
        await trx('autonomous_runs').where('id', run.id).update({
          reviewer_notes: appendReviewerNote(run.reviewer_notes, {
            decision: normalizedDecision,
            reviewer: reviewerName,
            note: cleanNote,
          }),
          updated_at: new Date(),
        });
      }
    });
  }

  logger.info(`[autonomous-review-queue] ${normalizedDecision} ${opportunityId}`);
  return getReviewItem(opportunityId);
}

async function updatePendingReviewOpportunity(trx, opportunityId, updates) {
  const updated = await trx('opportunity_queue')
    .where({ id: opportunityId, status: 'pending_review' })
    .update(updates);
  if (!updated) {
    const err = new Error('Opportunity review state changed; refresh before applying a decision');
    err.statusCode = 409;
    err.isOperational = true;
    throw err;
  }
  return updated;
}

async function countsByStatus() {
  const rows = await db('opportunity_queue')
    .select('status')
    .count('* as count')
    .groupBy('status');
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]));
}

function latestByOpportunity(rows = []) {
  const out = new Map();
  for (const row of rows) {
    if (!row?.opportunity_id || out.has(row.opportunity_id)) continue;
    out.set(row.opportunity_id, row);
  }
  return out;
}

function buildReviewItem({ opportunity, brief, run, includeDraftBody = false }) {
  const scoreBreakdown = parseJsonMaybe(opportunity?.score_breakdown, {});
  const signalMetadata = parseJsonMaybe(opportunity?.signal_metadata, {});
  const qualityGate = parseJsonMaybe(run?.quality_gate_result, {});
  const uniquenessGate = parseJsonMaybe(run?.uniqueness_gate_result, {});
  const comparisonGate = parseJsonMaybe(run?.comparison_table_result, {});
  const draft = summarizeDraft(parseJsonMaybe(run?.draft_payload, {}), { includeBody: includeDraftBody });
  const seoCompletion = summarizeSeoCompletion(qualityGate?.seo_completion || draft.seo_completion || draft.seo_contract);

  return {
    id: opportunity.id,
    status: opportunity.status,
    bucket: opportunity.bucket,
    action_type: brief?.action_type || opportunity.action_type,
    proposed_action_type: opportunity.action_type,
    page_type: brief?.page_type || null,
    query: opportunity.query,
    page_url: opportunity.page_url,
    target_url: brief?.target_url || opportunity.page_url || draft.url || null,
    target_keyword: brief?.target_keyword || opportunity.query || null,
    city: brief?.city || opportunity.city || null,
    service: brief?.service || opportunity.service || null,
    score: opportunity.score,
    final_score: brief?.final_score ?? null,
    score_breakdown: scoreBreakdown,
    signal_metadata: signalMetadata,
    mined_at: opportunity.mined_at,
    claimed_at: opportunity.claimed_at,
    completed_at: opportunity.completed_at,
    updated_at: opportunity.updated_at,
    skip_reason: opportunity.skip_reason || run?.skip_reason || null,
    brief: brief ? {
      id: brief.id,
      version: brief.version,
      human_review_required: brief.human_review_required,
      human_review_reason: brief.human_review_reason,
      router_notes: brief.router_notes,
      serp_signal: parseJsonMaybe(brief.serp_signal, {}),
      gsc_signal: parseJsonMaybe(brief.gsc_signal, {}),
      conversion_signal: parseJsonMaybe(brief.conversion_signal, null),
      required_sections: parseJsonMaybe(brief.required_sections, []),
      internal_links_to_add: parseJsonMaybe(brief.internal_links_to_add, []),
      seo_requirements: draft.seo_contract ? buildSeoRequirementsSummary(draft.seo_contract) : null,
      composed_at: brief.composed_at,
    } : null,
    run: run ? {
      id: run.id,
      outcome: run.outcome,
      shadow_mode: run.shadow_mode,
      skip_reason: run.skip_reason,
      failure_message: run.failure_message,
      reviewer_notes: run.reviewer_notes,
      trust_build_count_after: run.trust_build_count_after,
      claimed_at: run.claimed_at,
      completed_at: run.completed_at,
      total_ms: run.total_ms,
      quality_gate_result: qualityGate,
      uniqueness_gate_result: uniquenessGate,
      comparison_table_result: comparisonGate,
      gate_summary: summarizeGates(qualityGate, uniquenessGate, comparisonGate),
      seo_completion: seoCompletion,
    } : null,
    review_actions: reviewActions({ opportunity, run }),
    draft,
  };
}

function reviewActions({ opportunity, run }) {
  const pendingReview = opportunity?.status === 'pending_review';
  return {
    can_requeue: pendingReview,
    can_dismiss: pendingReview,
    can_approve_trust_build: pendingReview && isTrustBuildRun(run),
    can_approve_named_competitor: pendingReview && isNamedCompetitorReviewRun(run),
  };
}

function isTrustBuildRun(run) {
  return !!(
    run
    && run.outcome === 'completed_pending_review'
    && run.shadow_mode === false
    && /^trust_build_\d+_of_\d+$/.test(String(run.skip_reason || ''))
  );
}

// A named-competitor comparison parked for mandatory human review. Approving it
// PUBLISHES the reviewed draft (approve_named_competitor) rather than granting
// trust-build credit — a human signs off on every competitor naming.
function isNamedCompetitorReviewRun(run) {
  return !!(
    run
    && run.outcome === 'completed_pending_review'
    && run.shadow_mode === false
    && run.skip_reason === 'named_competitor_review'
  );
}

function assertTrustBuildRun(run) {
  if (!isTrustBuildRun(run)) {
    const err = new Error('Only live trust-build pending-review runs can be approved');
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }
}

function assertNamedCompetitorReviewRun(run) {
  if (!isNamedCompetitorReviewRun(run)) {
    const err = new Error('Only a live named-competitor review run can be approved-and-published');
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }
}

function summarizeDraft(draft, { includeBody = false } = {}) {
  const body = String(draft?.body || '');
  return {
    title: draft?.title || draft?.frontmatter?.title || null,
    slug: draft?.slug || draft?.frontmatter?.slug || null,
    url: draft?.url || null,
    meta_description: draft?.meta_description || draft?.frontmatter?.meta_description || null,
    body_length: body.length,
    body_preview: body ? body.slice(0, 700) : null,
    seo_contract: draft?.seo_contract || null,
    seo_completion_findings: Array.isArray(draft?.seo_completion_findings) ? draft.seo_completion_findings : [],
    body: includeBody ? (body || null) : undefined,
  };
}

function summarizeSeoCompletion(value = {}) {
  if (!value || Object.keys(value).length === 0) {
    return {
      available: false,
      passed: null,
      score: null,
      p0: 0,
      p1: 0,
      p2: 0,
      findings: [],
      recommended_links: [],
    };
  }
  const result = isSeoGateResult(value) ? value : { contract: value };
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const summary = result.summary || {};
  const contract = result.contract || value;
  return {
    available: true,
    passed: result.passed !== false,
    score: result.score ?? null,
    p0: summary.p0 ?? countSeverity(findings, 'P0'),
    p1: summary.p1 ?? countSeverity(findings, 'P1'),
    p2: summary.p2 ?? countSeverity(findings, 'P2'),
    findings,
    recommended_links: Array.isArray(contract.internalLinkRecommendations)
      ? contract.internalLinkRecommendations
      : (Array.isArray(contract.internalLinks) ? contract.internalLinks : []),
    breadcrumbs: Array.isArray(contract.breadcrumbs) ? contract.breadcrumbs : [],
    faq_count: Array.isArray(contract.faq) ? contract.faq.length : 0,
    schema: contract.schema || null,
    review_flags: Array.isArray(contract.reviewFlags) ? contract.reviewFlags : [],
  };
}

function isSeoGateResult(value = {}) {
  return Object.prototype.hasOwnProperty.call(value, 'passed')
    || Object.prototype.hasOwnProperty.call(value, 'summary')
    || Object.prototype.hasOwnProperty.call(value, 'findings')
    || Object.prototype.hasOwnProperty.call(value, 'score');
}

function buildSeoRequirementsSummary(contract = {}) {
  return {
    breadcrumbsRequired: true,
    articleSchemaRequired: true,
    faqSchemaPolicy: 'only_when_visible_faq_exists',
    internalLinksRecommended: Array.isArray(contract.internalLinkRecommendations)
      ? contract.internalLinkRecommendations.length
      : (Array.isArray(contract.internalLinks) ? contract.internalLinks.length : 0),
  };
}

function summarizeGates(qualityGate, uniquenessGate, comparisonGate = {}) {
  const hard = Array.isArray(qualityGate?.hard_failures) ? qualityGate.hard_failures : [];
  const soft = Array.isArray(qualityGate?.soft_failures) ? qualityGate.soft_failures : [];
  const uniqueness = Array.isArray(uniquenessGate?.failed_reasons) ? uniquenessGate.failed_reasons : [];
  const comparisonFindings = Array.isArray(comparisonGate?.findings) ? comparisonGate.findings : [];
  return {
    quality_ok: qualityGate?.ok === true,
    quality_score: qualityGate?.total_score ?? null,
    quality_min_score: qualityGate?.min_total_score ?? null,
    hard_failures: hard.map((f) => f.name || f.reason || String(f)).filter(Boolean),
    soft_failures: soft.map((f) => f.name || f.reason || String(f)).filter(Boolean),
    uniqueness_ok: uniquenessGate?.ok !== false,
    uniqueness_failures: uniqueness,
    seo_completion_ok: qualityGate?.seo_completion?.passed ?? null,
    // Comparison-table gate: surface the full findings (codes + messages) so the
    // review queue can show the offending names / caption / reason, not just the
    // shortened reviewer_notes codes. comparison_ok is null when the gate did
    // not run (no comparison table in the draft).
    comparison_ok: comparisonFindings.length || comparisonGate?.pass !== undefined
      ? comparisonGate?.pass !== false
      : null,
    comparison_findings: comparisonFindings.map((f) => ({ severity: f.severity, code: f.code, message: f.message })),
  };
}

function countSeverity(findings, severity) {
  return findings.filter((item) => item?.severity === severity).length;
}

function normalizeStatus(status) {
  const value = String(status || 'pending_review');
  if (!ALLOWED_STATUSES.has(value)) return 'pending_review';
  return value;
}

function normalizeDecision(decision) {
  const value = String(decision || '').trim();
  if (!ALLOWED_DECISIONS.has(value)) {
    const err = new Error(`decision must be one of: ${Array.from(ALLOWED_DECISIONS).join(', ')}`);
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }
  return value;
}

function normalizeReviewer(reviewer) {
  return String(reviewer || 'admin').trim().slice(0, 100) || 'admin';
}

function normalizeNote(note) {
  return String(note || '').trim().replace(/\s+/g, ' ').slice(0, 500);
}

function boundedReason(reason) {
  return String(reason || '').slice(0, 100);
}

function appendReviewerNote(existing, { decision, reviewer, note, now = new Date() }) {
  const stamp = `[${now.toISOString()}] ${reviewer}: ${decision}${note ? ` — ${note}` : ''}`;
  return [String(existing || '').trim(), stamp].filter(Boolean).join('\n').slice(-5000);
}

function normalizeLimit(limit) {
  const parsed = Number.parseInt(limit, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function parseJsonMaybe(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

module.exports = {
  listReviewItems,
  getReviewItem,
  decideReviewItem,
  countsByStatus,
  buildReviewItem,
  updatePendingReviewOpportunity,
  reviewActions,
  isTrustBuildRun,
  isNamedCompetitorReviewRun,
  summarizeDraft,
  summarizeSeoCompletion,
  summarizeGates,
  appendReviewerNote,
  normalizeDecision,
  parseJsonMaybe,
  normalizeLimit,
  normalizeStatus,
};
