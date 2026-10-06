/**
 * Tree & Shrub live-insect check: the technician's "Live insects found?" answer
 * and the insect types they picked (GATE_TS_PEST_CHECK, owner 2026-10-05).
 *
 * Tech-facing and storage only. The answers ride the /complete body as
 * treeShrubReview.pestCheck ({ liveInsectsFound: true | false, insectTypes: [] })
 * and are frozen on the service record (structured_notes.treeShrubPestCheck).
 * No customer report, PDF, SMS or email reads them. Everything here is
 * tolerant: an invalid answer or type is dropped, never a completion failure,
 * and the gate off stores nothing. No migration: structured_notes is jsonb.
 */
const PEST_CHECK = require('../../shared/tree-shrub-pest-check.json');

const INSECT_TYPE_KEYS = PEST_CHECK.insectTypes.map((type) => type.key);

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
  if (raw.liveInsectsFound === false) return { liveInsectsFound: false, insectTypes: [] };
  const picked = new Set(Array.isArray(raw.insectTypes) ? raw.insectTypes.slice(0, 50) : []);
  return { liveInsectsFound: true, insectTypes: INSECT_TYPE_KEYS.filter((key) => picked.has(key)) };
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
  tsPestCheckLive,
  normalizePestCheck,
  freezePestCheck,
};
