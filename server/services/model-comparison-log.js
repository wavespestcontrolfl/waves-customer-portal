/**
 * Shadow model-comparison log (Phase 2 cross-provider routing).
 *
 * Records a LIVE model output next to a CANDIDATE (shadow) output + a deterministic
 * agreement signal, into `ai_model_comparisons`. The candidate never affects what the
 * customer sees or how a call is routed — this is silent data accrual so a provider
 * flip can later be made on evidence (same "earn the bar" pattern as the SMS shadow loop).
 *
 * Everything here is fail-closed and non-blocking: call sites use `void shadowCompare(...)`.
 * The agreement helpers are pure (no DB / no network) so they unit-test directly.
 */

const db = require('../models/db');
const logger = require('./logger');
const { dispatch } = require('./llm/call');

function asText(value) {
  if (value == null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// ── Pure agreement helpers ────────────────────────────────────────────────

// Flatten an object/array to a Map of leaf-path → primitive value, skipping any
// path under an ignored prefix (e.g. provenance `meta.*`, which differs by model).
function flattenLeaves(value, ignorePrefixes = [], prefix = '', out = new Map()) {
  if (ignorePrefixes.some((p) => prefix === p || prefix.startsWith(`${p}.`))) return out;
  if (value === null || typeof value !== 'object') {
    out.set(prefix || '$', value === undefined ? null : value);
    return out;
  }
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
  for (const [k, v] of entries) {
    flattenLeaves(v, ignorePrefixes, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function bucket(score) {
  if (score >= 100) return 'identical';
  if (score >= 80) return 'similar';
  return 'divergent';
}

// Structured agreement: fraction of leaf paths (union of both) whose values are equal.
// Coarse by design — a triage signal for later review, not a verdict.
function extractionAgreement(live, candidate, { ignorePrefixes = ['meta'] } = {}) {
  const a = flattenLeaves(live, ignorePrefixes);
  const b = flattenLeaves(candidate, ignorePrefixes);
  const paths = new Set([...a.keys(), ...b.keys()]);
  if (paths.size === 0) return { level: 'divergent', score: 0, divergence: ['<empty>'] };
  let matched = 0;
  const divergence = [];
  for (const p of paths) {
    if (a.has(p) && b.has(p) && a.get(p) === b.get(p)) matched += 1;
    else if (divergence.length < 25) divergence.push(p);
  }
  const score = Math.round((matched / paths.size) * 100);
  return { level: bucket(score), score, divergence: divergence.length ? divergence : null };
}

function tokenize(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z0-9']+/g) || []);
}

// Text agreement: Jaccard overlap of word sets. Rough triage signal for prose.
function textAgreement(liveText, candidateText) {
  const a = tokenize(liveText);
  const b = tokenize(candidateText);
  if (a.size === 0 && b.size === 0) return { level: 'divergent', score: 0, divergence: null };
  let inter = 0;
  for (const w of a) if (b.has(w)) inter += 1;
  const union = a.size + b.size - inter;
  const score = union === 0 ? 0 : Math.round((inter / union) * 100);
  return { level: bucket(score), score, divergence: null };
}

// ── Storage (fail-closed) ───────────────────────────────────────────────────

async function recordModelComparison(row = {}) {
  try {
    await db('ai_model_comparisons').insert({
      feature_key: row.featureKey,
      entity_type: row.entityType || null,
      entity_id: row.entityId != null ? String(row.entityId) : null,
      live_provider: row.liveProvider || null,
      live_model: row.liveModel || null,
      live_output: asText(row.liveOutput),
      live_ms: Number.isFinite(row.liveMs) ? row.liveMs : null,
      candidate_provider: row.candidateProvider || null,
      candidate_model: row.candidateModel || null,
      candidate_output: asText(row.candidateOutput),
      candidate_ms: Number.isFinite(row.candidateMs) ? row.candidateMs : null,
      candidate_ok: row.candidateOk === true,
      candidate_reason: row.candidateReason || null,
      agreement_level: row.agreementLevel || null,
      agreement_score: Number.isFinite(row.agreementScore) ? row.agreementScore : null,
      divergence: row.divergence ? JSON.stringify(row.divergence) : null,
    });
  } catch (err) {
    logger.error(`[model-comparison] record failed (${row.featureKey}): ${err.message}`);
  }
}

// ── Generic dispatch-based shadow (used by text features like estimate-assistant) ─
// Runs the candidate route via llm/call#dispatch, compares vs the live output with the
// injected pure `compare` fn, and logs. Never throws; returns void (fire-and-forget).
async function shadowCompare(opts = {}) {
  try {
    const { featureKey, entityType = null, entityId = null, live = {}, candidateRoute, candidatePayload = {}, compare } = opts;
    if (!candidateRoute || typeof compare !== 'function') return;
    const startedAt = Date.now();
    const r = await dispatch(candidateRoute, candidatePayload);
    const candidateMs = Date.now() - startedAt;
    let candidateOutput = null;
    let agreement = { level: 'candidate_failed', score: 0, divergence: null };
    if (r && r.ok) {
      candidateOutput = r.json != null ? r.json : r.text;
      agreement = compare(live.output, candidateOutput) || agreement;
    }
    await recordModelComparison({
      featureKey,
      entityType,
      entityId,
      liveProvider: live.provider,
      liveModel: live.model,
      liveOutput: live.output,
      liveMs: live.ms,
      candidateProvider: candidateRoute.provider,
      candidateModel: candidateRoute.model,
      candidateOutput,
      candidateMs,
      candidateOk: !!(r && r.ok),
      candidateReason: r && r.ok ? null : (r && r.reason) || 'no_result',
      agreementLevel: agreement.level,
      agreementScore: agreement.score,
      divergence: agreement.divergence,
    });
  } catch (err) {
    logger.error(`[model-comparison] shadowCompare(${opts && opts.featureKey}) failed: ${err.message}`);
  }
}

module.exports = {
  recordModelComparison,
  shadowCompare,
  extractionAgreement,
  textAgreement,
  // exported for tests
  flattenLeaves,
};
