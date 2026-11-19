/**
 * Tree & Shrub live-insect check: the technician's "Live insects found?" answer
 * and the insect types they picked (GATE_TS_PEST_CHECK, owner 2026-10-05).
 *
 * Tech-facing and storage only. The answers ride the /complete body as
 * treeShrubReview.pestCheck ({ liveInsectsFound, insectTypes, lifeStage | preventiveReason })
 * and are frozen on the service record (structured_notes.treeShrubPestCheck).
 * No customer report, PDF, SMS or email reads them. Everything here is
 * tolerant: an invalid answer or type is dropped, never a completion failure,
 * and the gate off stores nothing. No migration: structured_notes is jsonb.
 */
const PEST_CHECK = require('../../shared/tree-shrub-pest-check.json');

const INSECT_TYPE_KEYS = PEST_CHECK.insectTypes.map((type) => type.key);
const LIFE_STAGE_KEYS = PEST_CHECK.lifeStages.map((stage) => stage.key);
const INSECT_TYPE_BY_LABEL = new Map(PEST_CHECK.insectTypes.map((type) => [type.label, type.key]));
const LIFE_STAGE_BY_LABEL = new Map(PEST_CHECK.lifeStages.map((stage) => [stage.label, stage.key]));
const LIVE_FINDS_ONLY_PRODUCT = /\b(tristar|distance|dipel|conserve|mainspring|acelepryn(?!\s+xtra\b)|floramite|tritek)\b/i;
const DISTANCE_PRODUCT = /\bdistance\s+igr\b/i;
const SCALE_TARGETS = new Set(['armored_scale', 'soft_scale']);

function tsPestCheckLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.tsPestCheckLive === 'function' && gates.tsPestCheckLive() === true;
}

// Wire answer -> the durable shape, or null when there is no answer. The answer
// must be a real boolean. Types count only on a Yes, only from the enum, once
// each, in the enum's order; a No stores no types.
function normalizePestCheck(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (typeof raw.liveInsectsFound !== 'boolean') return null;
  if (raw.liveInsectsFound === false) {
    const preventiveReason = String(raw.preventiveReason || '').trim().slice(0, 240);
    return { liveInsectsFound: false, insectTypes: [], ...(preventiveReason ? { preventiveReason } : {}) };
  }
  const picked = new Set(Array.isArray(raw.insectTypes) ? raw.insectTypes.slice(0, 50) : []);
  const lifeStage = LIFE_STAGE_KEYS.includes(raw.lifeStage) ? raw.lifeStage : null;
  return {
    liveInsectsFound: true,
    insectTypes: INSECT_TYPE_KEYS.filter((key) => picked.has(key)),
    ...(lifeStage ? { lifeStage } : {}),
  };
}

function typedPestCheck(values) {
  if (!values || typeof values !== 'object') return null;
  const target = INSECT_TYPE_BY_LABEL.get(String(values.insect_target || '').trim()) || '';
  const lifeStage = LIFE_STAGE_BY_LABEL.get(String(values.insect_life_stage || '').trim()) || '';
  const preventiveReason = String(values.insect_preventive_reason || '').trim().slice(0, 240);
  if (target || lifeStage) {
    return {
      liveInsectsFound: true,
      insectTypes: target ? [target] : [],
      ...(lifeStage ? { lifeStage } : {}),
      ...(preventiveReason ? { preventiveReason } : {}),
    };
  }
  return preventiveReason ? { liveInsectsFound: false, insectTypes: [], preventiveReason } : null;
}

// The fast sheet's evidence prompt is backed at the closeout boundary while
// its gate is live. With no insect product, a scout-only visit remains valid.
// Product names are the frozen catalog/record names already loaded for the
// compliance check; this helper never reclassifies a non-insect product.
function validatePestTreatmentEvidence(review, { hasInsectProduct = false, productNames = [], fallbackValues = null } = {}) {
  if (!tsPestCheckLive() || !hasInsectProduct) return [];
  const fallback = typedPestCheck(fallbackValues);
  const answer = normalizePestCheck(review && review.pestCheck) || normalizePestCheck(fallback);
  const block = (code, message) => ({ code, message, field: 'treeShrubReview.pestCheck' });
  if (!answer) {
    return [block('tree_shrub_treatment_evidence_required', 'Record the live target and stage, or a label-supported preventive reason. A scout-only visit needs no insect treatment.')];
  }
  if (answer.liveInsectsFound) {
    if (fallback?.preventiveReason && !(review && review.pestCheck)) {
      return [block('tree_shrub_treatment_evidence_contradiction', 'Record either a live target and stage or a label-supported preventive reason, not both.')];
    }
    if (!answer.insectTypes.length) return [block('tree_shrub_target_required', 'Select the live target before recording an insect treatment.')];
    if (!answer.lifeStage) return [block('tree_shrub_life_stage_required', 'Select the live stage before recording an insect treatment.')];
    if (productNames.some((name) => DISTANCE_PRODUCT.test(String(name || ''))) && answer.insectTypes.some((type) => SCALE_TARGETS.has(type))) {
      return [block('tree_shrub_distance_scale_hold', 'Distance IGR scale use is on hold. Remove Distance or record a non-scale target supported by the label.')];
    }
    return [];
  }
  const liveOnly = productNames.filter((name) => LIVE_FINDS_ONLY_PRODUCT.test(String(name || '')));
  if (liveOnly.length) {
    return [block('tree_shrub_live_find_required', `${liveOnly.join(', ')} requires a live target and stage; remove the treatment or record what was found.`)];
  }
  if (!answer.preventiveReason) {
    return [block('tree_shrub_preventive_reason_required', 'Enter the label-supported preventive reason before recording an insect treatment.')];
  }
  return [];
}

// The structured_notes fields for a completion, or null when there is nothing
// to freeze (gate off, no valid answer).
function freezePestCheck(review, { now = new Date() } = {}) {
  if (!tsPestCheckLive()) return null;
  const answer = normalizePestCheck(review && review.pestCheck);
  if (!answer) return null;
  return {
    treeShrubPestCheck: answer,
    treeShrubPestCheckDecidedAt: now.toISOString(),
  };
}

module.exports = {
  INSECT_TYPE_KEYS,
  LIFE_STAGE_KEYS,
  tsPestCheckLive,
  normalizePestCheck,
  typedPestCheck,
  validatePestTreatmentEvidence,
  freezePestCheck,
};
