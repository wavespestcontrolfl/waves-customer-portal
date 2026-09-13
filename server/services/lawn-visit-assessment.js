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
  const outcome = await dispatchWithFallback(MODELS.TEXT_POLICIES.lawnVisitAssessment, {
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
  }, { validate: (result) => validateAssessmentJson(result, photos.length) });
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
    };
  }
  return {
    ...base, status: 'complete', reason: null,
    provider: outcome.provider, model: outcome.model, fallbackUsed: !!outcome.fallbackUsed,
    usage: outcome.usage || null, raw: outcome.json,
    ...withoutNoteInfluencedProse(normalizeAssessment(outcome.json, photos.length, zones), context.technicianNotes),
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
