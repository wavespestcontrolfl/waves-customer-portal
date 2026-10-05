/** One provider chain over every numbered photo in a technician's lawn visit. */
const MODELS = require('../config/models');
const logger = require('./logger');
const { dispatchWithFallback } = require('./llm/call');
const {
  MAX_OUTPUT_TOKENS, promptFor, buildUserText, photoLabel, validateVisitPhotos, contextHash,
} = require('./lawn-visit-input');
const { validateAssessmentJson, normalizeAssessment, emptyAnalysis } = require('./lawn-visit-result');
const { withoutNoteInfluencedProse } = require('./lawn-visit-customer-copy');
const { lawnAssessmentRefereeLive, lawnLightingLive } = require('../config/feature-gates');
const { refereeVisit, skippedReferee } = require('./lawn-visit-referee');

// Invalid input fails before a paid call. Provider misses return an explicit
// unavailable result with no invented scores. The route owns the feature gate.
// `shotList` is GATE_LAWN_SHOT_LIST as the route decided it for this request:
// true widens the photo contract to the eight-shot list (cap 8) and reads the
// visit under the shot-list prompt variant (shot guide, its own prompt version,
// server-side evidence rules). Off = unchanged.
// `lighting` is GATE_LAWN_LIGHTING (owner 2026-10-04), read at call time unless
// the caller decides it: true reads the visit under the lighting variant (the same
// prompt plus the LIGHT block, and a light read on every photo's quality row, its
// own prompt version). Off = the prompt, schema, stored run and return shape are
// exactly what they were.
// timeoutMs (optional): the caller's remaining wall-clock budget for both legs
// together; absent, the dispatcher's default chain budget applies.
async function analyzeVisit({ photos = [], visionContext = {}, thinkingLevel, shotList = false, lighting = lawnLightingLive(), timeoutMs } = {}) {
  const { error, zones } = validateVisitPhotos(photos, { shotList });
  if (error) throw Object.assign(new Error(error), { code: 'INVALID_VISIT_PHOTOS', statusCode: 400 });
  const context = visionContext || {};
  const images = photos.map((photo, index) => ({
    data: photo.data,
    mimeType: (photo.mimeType || 'image/jpeg').toLowerCase(),
    label: photoLabel(index, zones[index]),
  }));
  const prompt = promptFor({ shotList, lighting });
  const started = Date.now();
  const policy = MODELS.TEXT_POLICIES.lawnVisitAssessment;
  const payload = {
    system: prompt.system,
    text: buildUserText(photos.length, context, { shotList, zones }),
    images,
    jsonMode: true,
    jsonSchema: prompt.schema,
    maxTokens: MAX_OUTPUT_TOKENS,
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    reasoningEffort: 'medium',
    laneId: 'lawn_visit_assessment',
    promptVersion: prompt.version,
  };
  const outcome = await dispatchWithFallback(policy, payload, { validate: (result) => validateAssessmentJson(result, photos.length, { lighting }) });
  // GATE_LAWN_ASSESSMENT_REFEREE (owner ruling 2026-09-29), read at call time.
  // Off: nothing below runs and the return shape is exactly what it always was.
  const refereeOn = lawnAssessmentRefereeLive();
  const base = {
    promptVersion: prompt.version,
    contextHash: contextHash({ photos, photoZones: zones, visionContext: context, shotList, lighting }),
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
        policy, payload, geminiJson: outcome.json, visit: { photoCount: photos.length, images, context, lighting },
        deadline: timeoutMs ? started + timeoutMs : null,
      }));
      // The model-claimed findings after a settled tie-break (pre-normalization,
      // like `raw`), so the eval measures naming discipline on the final answer.
      if (referee?.outcome === 'settled') referee.adjustedFindings = assessed.findings;
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
    ...withoutNoteInfluencedProse(normalizeAssessment(assessed, photos.length, zones, { shotList, lighting }), context.technicianNotes),
    // Gate on: latency covers the second opinion and referee calls too.
    ...(refereeOn ? { referee, latencyMs: Date.now() - started } : {}),
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
