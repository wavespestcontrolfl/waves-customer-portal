/**
 * autonomous-review-queue.js — read model for human review of parked
 * autonomous content engine work.
 */

const db = require('../../models/db');
const logger = require('../logger');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const ALLOWED_STATUSES = new Set(['pending_review', 'pending', 'claimed', 'done', 'skipped', 'expired']);

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
  const draft = summarizeDraft(parseJsonMaybe(run?.draft_payload, {}), { includeBody: includeDraftBody });

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
      gate_summary: summarizeGates(qualityGate, uniquenessGate),
    } : null,
    draft,
  };
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
    body: includeBody ? (body || null) : undefined,
  };
}

function summarizeGates(qualityGate, uniquenessGate) {
  const hard = Array.isArray(qualityGate?.hard_failures) ? qualityGate.hard_failures : [];
  const soft = Array.isArray(qualityGate?.soft_failures) ? qualityGate.soft_failures : [];
  const uniqueness = Array.isArray(uniquenessGate?.failed_reasons) ? uniquenessGate.failed_reasons : [];
  return {
    quality_ok: qualityGate?.ok === true,
    quality_score: qualityGate?.total_score ?? null,
    quality_min_score: qualityGate?.min_total_score ?? null,
    hard_failures: hard.map((f) => f.name || f.reason || String(f)).filter(Boolean),
    soft_failures: soft.map((f) => f.name || f.reason || String(f)).filter(Boolean),
    uniqueness_ok: uniquenessGate?.ok !== false,
    uniqueness_failures: uniqueness,
  };
}

function normalizeStatus(status) {
  const value = String(status || 'pending_review');
  if (!ALLOWED_STATUSES.has(value)) return 'pending_review';
  return value;
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
  countsByStatus,
  buildReviewItem,
  summarizeDraft,
  summarizeGates,
  parseJsonMaybe,
  normalizeLimit,
  normalizeStatus,
};
