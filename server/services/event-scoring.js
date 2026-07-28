/**
 * Deterministic editorial scoring for newsletter event curation
 * (owner spec 2026-07-28).
 *
 * The model CLASSIFIES (per-factor scores, penalty flags, rejection
 * codes, evidence); this module COMPUTES. The final 0–100 score is
 * never taken from the model — factor scores are clamped to their
 * maxima, data-derived penalties are computed from the row itself, and
 * the arithmetic lives here so a prompt drift can't silently move the
 * editorial bar.
 *
 * Factors (max 100):
 *   specialness 25 · reader_pull 20 · audience_fit 15 ·
 *   planning_value 15 · local_relevance 10 · source_confidence 10 ·
 *   accessibility 5
 *
 * Thresholds (env-tunable, deterministic defaults):
 *   ≥ NEWSLETTER_MIN_HERO_SCORE    (88) — hero-eligible
 *   ≥ NEWSLETTER_MIN_FEATURE_SCORE (75) — auto-approve for the issue pool
 *   ≥ NEWSLETTER_SHORTLIST_SCORE   (65) — stays pending (operator may approve)
 *   <  shortlist                        — stays pending, flagged below-shortlist
 * An event can never become publishable because the issue needs another
 * card — the floor is absolute (selection happens in
 * newsletter-event-selection.js).
 *
 * Cross-candidate penalties (third-from-same-venue/domain,
 * previously-featured-similar) are NOT here — they depend on the whole
 * candidate set and belong to the portfolio selector.
 */

const FACTOR_MAXES = Object.freeze({
  specialness: 25,
  reader_pull: 20,
  audience_fit: 15,
  planning_value: 15,
  local_relevance: 10,
  source_confidence: 10,
  accessibility: 5,
});

// Model-asserted penalty flags → point values. The model may only FLAG;
// values are fixed here.
const PENALTY_VALUES = Object.freeze({
  generic_class: 15, // ordinary workshop/class with no exceptional element
  retail_promo: 25, // store promotion / lead-gen dressed as an event
  ordinary_screening: 10, // regular film showing (no restoration/Q&A/anniversary)
});

// Data-derived penalties computed from the row, never model-asserted.
const DERIVED_PENALTY_VALUES = Object.freeze({
  short_notice: 10, // starts <12h after the scoring reference
  missing_price: 8, // no is_free flag and no price_text
  unclear_age: 5, // family suitability unknown
});

const SHORT_NOTICE_HOURS = 12;

// Hard-policy rejection codes. Any of these ⇒ never auto-approved,
// regardless of score (the operator can still approve manually — the
// codes make the refusal explicit instead of a vague model opinion).
const REJECTION_CODES = Object.freeze([
  'routine_recurring', // weekly yoga/fitness/trivia/bingo/karaoke/open-mic/networking
  'ordinary_market', // regular weekly/monthly market
  'recurring_live_music', // standard bar/venue music slot
  'happy_hour', // normal restaurant/bar promotion
  'webinar_virtual', // online-only
  'business_open_house', // open house / ribbon cutting / chamber function
  'retail_promotion', // generic sale / sip-and-shop with no exceptional element
  'ordinary_class', // basic library class / story time
  'unverifiable_source', // no official or independently verifiable source
  'cancelled_or_sold_out', // dead listing without a legitimate waitlist
  'outside_corridor', // outside the North Port → Tampa coverage area
  'not_attendable', // listing doesn't describe a real attendable happening
  'government_civic', // council/committee/procurement process
]);

const NOVELTY_TYPES = Object.freeze([
  'one_time', 'inaugural', 'opening_weekend', 'closing_weekend', 'touring',
  'annual_signature', 'special_edition', 'limited_engagement', 'series_debut',
  'ordinary',
]);

const FAMILY_STATUSES = Object.freeze(['confirmed', 'adults_lean', 'unknown']);

function clampFactor(name, value) {
  const max = FACTOR_MAXES[name];
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.round(n)));
}

/**
 * A structurally malformed assessment must never reach the approval
 * math — a response that omits `rejection_codes` (or emits a scalar)
 * would otherwise normalize to [] and auto-approve a high-scoring event
 * without any policy screening (fail-open). Callers route malformed
 * assessments through the same pending fallback as a missing one.
 */
function isMalformedAssessment(raw) {
  if (!raw || typeof raw !== 'object') return true;
  if (!Array.isArray(raw.rejection_codes)) return true;
  // penalty_flags gets the same treatment: an omitted field would
  // normalize to [] and skip the fixed 10–25 point penalties, letting a
  // high-scoring retail promo or generic class cross the floor.
  if (!Array.isArray(raw.penalty_flags)) return true;
  if (!raw.scores || typeof raw.scores !== 'object' || Array.isArray(raw.scores)) return true;
  return false;
}

/**
 * Normalize a raw model assessment into clamped factors, known penalty
 * flags, and known rejection codes. Unknown flags/codes are dropped
 * (fail-closed: a hallucinated code can't invent a new policy).
 */
function normalizeAssessment(raw = {}) {
  const scores = {};
  for (const name of Object.keys(FACTOR_MAXES)) {
    scores[name] = clampFactor(name, raw.scores?.[name]);
  }
  const penaltyFlags = [...new Set((Array.isArray(raw.penalty_flags) ? raw.penalty_flags : [])
    .map(String).filter((f) => f in PENALTY_VALUES))];
  const rejectionCodes = [...new Set((Array.isArray(raw.rejection_codes) ? raw.rejection_codes : [])
    .map(String).filter((c) => REJECTION_CODES.includes(c)))];
  const audienceTags = [...new Set((Array.isArray(raw.audience_tags) ? raw.audience_tags : [])
    .map((t) => String(t).slice(0, 40)))].slice(0, 8);
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : [])
    .map((e) => String(e).slice(0, 240)).slice(0, 5);
  return {
    scores,
    penaltyFlags,
    rejectionCodes,
    audienceTags,
    evidence,
    noveltyType: NOVELTY_TYPES.includes(raw.novelty_type) ? raw.novelty_type : 'ordinary',
    familyStatus: FAMILY_STATUSES.includes(raw.family_status) ? raw.family_status : 'unknown',
    editorialReason: raw.editorial_reason ? String(raw.editorial_reason).slice(0, 200) : null,
  };
}

/**
 * Penalties derivable from the row itself. `reference` is the scoring
 * moment (cron run time).
 */
function derivedPenalties(event = {}, reference = new Date()) {
  const flags = [];
  if (event.start_at) {
    const start = new Date(event.start_at);
    if (!Number.isNaN(start.getTime())
        && start.getTime() - reference.getTime() < SHORT_NOTICE_HOURS * 3600 * 1000) {
      flags.push('short_notice');
    }
  }
  if (event.is_free !== true && !event.price_text) flags.push('missing_price');
  if (event.family_friendly !== true && event.family_friendly !== false) flags.push('unclear_age');
  return flags;
}

/**
 * Final deterministic score: clamped factor sum − penalties, floored at 0.
 */
function computeEditorialScore(normalized, derivedFlags = []) {
  const factorTotal = Object.values(normalized.scores).reduce((a, b) => a + b, 0);
  const modelPenalty = normalized.penaltyFlags.reduce((a, f) => a + PENALTY_VALUES[f], 0);
  const derivedPenalty = derivedFlags.reduce((a, f) => a + (DERIVED_PENALTY_VALUES[f] || 0), 0);
  return Math.max(0, Math.min(100, factorTotal - modelPenalty - derivedPenalty));
}

function envThreshold(name, fallback) {
  // A blank optional var must mean "unset" — Number('') coerces to 0,
  // which would silently drop the editorial floor to zero.
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : fallback;
}

function featureScoreFloor() { return envThreshold('NEWSLETTER_MIN_FEATURE_SCORE', 75); }
function heroScoreFloor() { return envThreshold('NEWSLETTER_MIN_HERO_SCORE', 88); }
function shortlistScoreFloor() { return envThreshold('NEWSLETTER_SHORTLIST_SCORE', 65); }

/**
 * The full curation decision for one event, given the model's raw
 * assessment and the DB row. Pure — the caller persists.
 */
function assessEvent(event, rawAssessment, reference = new Date()) {
  const normalized = normalizeAssessment(rawAssessment);
  const derivedFlags = derivedPenalties(event, reference);
  const score = computeEditorialScore(normalized, derivedFlags);
  const approve = normalized.rejectionCodes.length === 0 && score >= featureScoreFloor();

  let tier;
  if (normalized.rejectionCodes.length > 0) tier = 'rejected_policy';
  else if (score >= heroScoreFloor()) tier = 'hero';
  else if (score >= featureScoreFloor()) tier = 'feature';
  else if (score >= shortlistScoreFloor()) tier = 'shortlist';
  else tier = 'below_shortlist';

  return {
    approve,
    tier,
    score,
    breakdown: {
      factors: normalized.scores,
      penalty_flags: normalized.penaltyFlags,
      derived_penalty_flags: derivedFlags,
      final: score,
      tier,
      // Persisted here so the assessment is auditable and the proof
      // diagnostics / portfolio selector can consume it — family_status
      // has no dedicated column.
      family_status: normalized.familyStatus,
    },
    rejectionCodes: normalized.rejectionCodes,
    audienceTags: normalized.audienceTags,
    noveltyType: normalized.noveltyType,
    familyStatus: normalized.familyStatus,
    evidence: normalized.evidence,
    editorialReason: normalized.editorialReason,
  };
}

module.exports = {
  FACTOR_MAXES,
  PENALTY_VALUES,
  DERIVED_PENALTY_VALUES,
  REJECTION_CODES,
  NOVELTY_TYPES,
  isMalformedAssessment,
  normalizeAssessment,
  derivedPenalties,
  computeEditorialScore,
  featureScoreFloor,
  heroScoreFloor,
  shortlistScoreFloor,
  assessEvent,
};
