/** One provider chain over every numbered photo in a technician's lawn visit. */
const MODELS = require('../config/models');
const logger = require('./logger');
const { dispatchWithFallback } = require('./llm/call');
const {
  PROMPT_VERSION, MAX_OUTPUT_TOKENS, SYSTEM_PROMPT, RESPONSE_SCHEMA,
  buildUserText, photoLabel, validateVisitPhotos, contextHash,
} = require('./lawn-visit-input');
const { validateAssessmentJson, normalizeAssessment, emptyAnalysis } = require('./lawn-visit-result');
const { withoutNoteInfluencedProse } = require('./lawn-visit-customer-copy');
const { lawnAssessmentRefereeLive } = require('../config/feature-gates');
const { refereeVisit, skippedReferee } = require('./lawn-visit-referee');

// Invalid input fails before a paid call. Provider misses return an explicit
// unavailable result with no invented scores. The route owns the feature gate.
async function analyzeVisit({ photos = [], visionContext = {}, thinkingLevel } = {}) {
  const { error, zones } = validateVisitPhotos(photos);
  if (error) throw Object.assign(new Error(error), { code: 'INVALID_VISIT_PHOTOS', statusCode: 400 });
  const context = visionContext || {};
  const images = photos.map((photo, index) => ({
    data: photo.data,
    mimeType: (photo.mimeType || 'image/jpeg').toLowerCase(),
    label: photoLabel(index, zones[index]),
  }));
  const started = Date.now();
  const policy = MODELS.TEXT_POLICIES.lawnVisitAssessment;
  const payload = {
    system: SYSTEM_PROMPT,
    text: buildUserText(photos.length, context),
    images,
    jsonMode: true,
    jsonSchema: RESPONSE_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    reasoningEffort: 'medium',
    laneId: 'lawn_visit_assessment',
    promptVersion: PROMPT_VERSION,
  };
  const outcome = await dispatchWithFallback(policy, payload, { validate: (result) => validateAssessmentJson(result, photos.length) });
  // GATE_LAWN_ASSESSMENT_REFEREE (owner ruling 2026-09-29), read at call time.
  // Off: nothing below runs and the return shape is exactly what it always was.
  const refereeOn = lawnAssessmentRefereeLive();
  const base = {
    promptVersion: PROMPT_VERSION,
    contextHash: contextHash({ photos, photoZones: zones, visionContext: context }),
    // The stored snapshot intentionally omits notes. The run writer uses this
    // marker to make such a replay ineligible for exact-input comparisons.
    visionContext: contextSnapshot(context),
    technicianNotesPresent: !!context.technicianNotes,
    latencyMs: Date.now() - started,
    failures: Array.isArray(outcome.failures) ? outcome.failures : [],
  };
  if (!outcome.ok) {
    logger.warn(`[lawn-visit-assessment] unavailable (${outcome.reason || 'error'})`);
    return {
      ...base, status: 'unavailable', reason: outcome.reason || 'error',
      provider: null, model: null, fallbackUsed: false, usage: null, raw: null,
      ...emptyAnalysis(photos.length),
      ...(refereeOn ? { referee: skippedReferee('gemini_unavailable') } : {}),
    };
  }
  // A second opinion + name referee only follow a Gemini answer: when the
  // OpenAI backup already answered, there is no first read to second-guess.
  let assessed = outcome.json;
  let referee = null;
  if (refereeOn) {
    if (outcome.fallbackUsed) {
      referee = skippedReferee('gemini_fallback');
    } else {
      ({ json: assessed, referee } = await refereeVisit({
        policy, payload, geminiJson: outcome.json, visit: { photoCount: photos.length, images, context },
      }));
      if (referee.triggered || referee.secondOpinion.called) {
        logger.info(`[lawn-visit-assessment] second opinion ${referee.secondOpinion.ok ? 'ok' : 'failed'}, referee ${referee.outcome} (${referee.disputes.length} disputed)`);
      }
    }
  }
  return {
    ...base, status: 'complete', reason: null,
    provider: outcome.provider, model: outcome.model, fallbackUsed: !!outcome.fallbackUsed,
    // `raw` stays the provider's own untouched answer; a settled name tie-break
    // changes only the normalized fields, and `referee` records what moved.
    usage: outcome.usage || null, raw: outcome.json,
    ...withoutNoteInfluencedProse(normalizeAssessment(assessed, photos.length, zones), context.technicianNotes),
    ...(refereeOn ? { referee } : {}),
  };
}

function contextSnapshot(context) {
  const snapshot = {};
  for (const key of ['season', 'month', 'region', 'grassType', 'turfHeightIn', 'irrigation', 'priorSummary']) {
    if (context[key] != null) snapshot[key] = context[key];
  }
  return snapshot;
}

module.exports = { analyzeVisit };
