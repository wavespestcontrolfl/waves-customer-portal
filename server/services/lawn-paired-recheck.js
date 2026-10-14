/**
 * Lawn paired-photo recheck (lawn report rebuild P19b, GATE_LAWN_PAIRED_RECHECK).
 *
 * Owner ruling 2026-09-29 (SCOPE round 3b): the "since last visit" recheck is an
 * IMAGE ANALYSIS job, not a technician chip. Last visit's overview photos and
 * today's, taken from the same fixed spot, go to ONE vision read as pairs; the
 * model answers better / same / worse / cannot_tell per pair and per carried
 * watch topic, with what changed drawn from a closed set. The verdict is written
 * onto the watched topic inside the visit's frozen memory entry
 * (structured_notes.lawnVisitMemory[assessmentId].sinceLast.checks[].recheck,
 * source 'photo_pair'), exactly where the progress engine reads it
 * (service-report/lawn-progress.js). The technician never sees it, and nothing
 * here is customer copy.
 *
 * When it runs: AFTER the memory entry is frozen (the entry is created by the
 * first healthy render and this job writes onto it, never creating one), as a
 * background job on setImmediate, so neither the technician's Analyze response nor
 * the report render waits on it. One model call per visit at most; any miss
 * (provider error, timeout, unusable answer, no pair, no entry) writes nothing and
 * is logged. Gate off: nothing here runs.
 *
 * Pairing rules (the existing ones, never a guess):
 *   - the prior visit is the FROZEN sinceLast.priorAssessmentId, never a live
 *     "latest" lookup, and both assessments must be the same customer AND the
 *     same recorded property;
 *   - only the shots flagged recheckPairable in shared/lawn-photo-shots.json
 *     pair: front (mailbox or driveway apron) and back (the capture guide fixes
 *     it to the back door or lanai edge, so it is the same spot every visit).
 *     side is NOT one: it records no side of the property, so two visits can show
 *     opposite sides; it stays out until a stable side identity is captured.
 *     (The report's before/after slider keeps its own, wider `pairable` set.)
 *     back counts only when BOTH visits were captured under the shot list (the
 *     photoVocabulary marker), because that word meant something else before
 *     2026-09-24;
 *   - problem-area (trouble) and the other detail shots are a different spot each
 *     time and nothing in a stored photo identifies a watch item, so they never
 *     pair: no guess;
 *   - only USABLE photos (adequate or limited) on BOTH sides.
 *
 * Perception hygiene: the model gets the photos, the view name and the watch
 * topic's plain name. No score, no product, no prior verdict or status.
 *
 * Lighting (GATE_LAWN_LIGHTING, owner 2026-10-04): read under lawn-paired-recheck-v3.
 * Each photo's stored light read (the visit assessment's, never a new model call)
 * rides the request, and a pair whose two photos are not in compatible light
 * (lawn-lighting.js: full_sun with full_sun, overcast and open_shade with each
 * other; everything else, and any photo with no read, is NOT comparable) is told
 * to judge density, weeds and damaged patches only. The server enforces it too:
 * `color` is dropped from such a pair's what_changed, and a better / worse verdict
 * that rested on color alone is not written. A failed read of the stored light
 * writes nothing (the job is a miss), so a degraded read is never frozen as a
 * healthy one. Gate off: v2, byte for byte.
 */
const MODELS = require('../config/models');
const logger = require('./logger');
const db = require('../models/db');
const { dispatchWithFallback } = require('./llm/call');
const shotList = require('./lawn-photo-shots');
const { photoIsUsable } = require('./service-report/lawn-progress');
const { recordPairedRecheck } = require('./service-report/lawn-visit-memory');
const { lawnPairedRecheckLive, lawnLightingLive } = require('../config/feature-gates');
const lighting = require('./lawn-lighting');

const PROMPT_VERSION = 'lawn-paired-recheck-v2';
// The version a read is stamped with while GATE_LAWN_LIGHTING is live.
const LIGHTING_PROMPT_VERSION = 'lawn-paired-recheck-v3';
const LANE_ID = 'lawn_paired_recheck';
const RECHECK_SOURCE = 'photo_pair';
const VERDICTS = ['better', 'same', 'worse', 'cannot_tell'];
const WRITABLE_VERDICTS = new Set(['better', 'same', 'worse']);
// What may be said changed: a closed set, never prose (it can sit next to a
// customer report one day, so nothing the model wrote reaches storage).
const CHANGE_DIMENSIONS = ['patch_size', 'color', 'edge', 'density'];
// One pair per recheck-pairable shot and each shot carries one photo per visit,
// so the natural ceiling is that shot count (front, back = 2); stated as a
// constant so a future shot list cannot silently widen the request.
const MAX_PAIRS = shotList.RECHECK_PAIRABLE_SHOT_ZONES.length;
const MAX_OUTPUT_TOKENS = 4096;
// A background job: generous, but bounded so a stalled provider cannot pile up.
const MAX_MS = 60 * 1000;
const GRACE_MS = 2000;

// The plain name of each watched topic the visit memory can carry
// (lawn-visit-memory.js CHECK_CATEGORIES). A frozen check stores ONLY
// { key, status }: no cause and no direction. So every label is neutral about
// both, and the model is told to judge only whether the affected areas look
// better, the same or worse, never which way the problem runs or why.
//   water    covers drought AND overwatering (lawn-report-insights.js), so it is
//            "a watering problem (too dry or too wet)", not drought
//   weeds    the topic itself
//   damage   the insight's own words, "stress patterns": no disease or pest named
//   coverage thinning AND uneven color (not bare ground)
// mowing is NOT here: it is a measured height of cut, too short or too tall
// (the frozen check does not say which), and an overview photo cannot establish
// it, so it is never put to the model (the engine then says unclear as today).
const ITEM_NAMES = Object.freeze({
  water: 'areas with a watering problem (too dry or too wet)',
  weeds: 'weeds growing among the turf',
  damage: 'areas of turf showing stress or damage (cause not known)',
  coverage: 'thin or uneven-colored areas of turf',
});

// ── Native JSON schema (Gemini response schema / OpenAI strict mode) ──────
// Every object closes additionalProperties and requires every key. No numeric
// minimum/maximum anywhere: the providers reject some of them and the code
// validates ranges itself.
const STR = { type: 'string' };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const enumOf = (values) => ({ type: 'string', enum: values });
const CHANGES = { type: 'array', items: enumOf(CHANGE_DIMENSIONS) };

const RESPONSE_SCHEMA = obj({
  pairs: { type: 'array', items: obj({ pair: { type: 'integer' }, verdict: enumOf(VERDICTS), what_changed: CHANGES }) },
  items: {
    type: 'array',
    items: obj({ item: STR, verdict: enumOf(VERDICTS), what_changed: CHANGES, pairs: { type: 'array', items: { type: 'integer' } } }),
  },
});

const SYSTEM_PROMPT = `You compare photos of the SAME spot on the SAME lawn taken on two different visits.
Each pair has a BEFORE photo (the earlier visit) and an AFTER photo (the later visit), labeled with the view they show. You are given nothing else about either visit: no scores, no treatments, no earlier opinion. Do not assume any treatment worked or failed.

Rules:
- Judge only what is visible. Compare like with like: the same patch against the same patch.
- Camera spot, light, shadow, time of day, season and mowing height can differ between visits. Never call one of those a change in the lawn. If the two photos do not show the same area, or either is too dark, blurred or far away to compare, the pair is cannot_tell.
- better = clearly less of the problem or clearly healthier turf in AFTER. worse = clearly more of the problem or clearly poorer turf in AFTER. same = no clear difference. cannot_tell = you cannot judge. When unsure between a verdict and cannot_tell, answer cannot_tell.
- what_changed lists only the dimensions that clearly differ, chosen from: patch_size (how large an affected area is), color (green versus pale, yellow or brown), edge (how sharp or spreading the border of an affected area is), density (how thick the turf is, how much bare ground shows). Empty for same and cannot_tell.
- pairs: one entry for EVERY pair number you were given, the whole-lawn comparison of that pair.
- items: one entry for EVERY watch item named in the request, using its key exactly as given. Judge that item only from the pairs where it can be seen, and list those pair numbers in pairs. If no pair shows it, answer cannot_tell with an empty pairs list.
- For an item, answer only whether the affected areas look better, the same or worse in AFTER than in BEFORE. Never say which direction the problem runs (for example too dry versus too wet) or what caused it.
Return JSON only, matching the schema.`;

// v3 (GATE_LAWN_LIGHTING): v2 plus the light rule. Appended to the v2 text, so v2
// stays exactly as it was and v3 differs from it only by this block.
const LIGHTING_RULE = `

Light (each pair line below states the light of its BEFORE and AFTER photo and whether color may be compared):
- Sun, shade and cloud change how green turf looks. When a pair line says color may NOT be compared, the two photos are in different or unknown light: do not use color or greenness for that pair or for any watch item you judge from it. Judge only density (how thick the turf is, how much bare ground shows), weeds and how far damaged patches reach, and never list color in what_changed for that pair.
- Never read shadowed turf as thinner, darker or more stressed turf, and never read sunlit turf as yellower or paler turf. If the only difference you can see is color or shadow, answer same or cannot_tell.
- When a pair line says color may be compared, the two photos are in compatible light and color counts as it did before.`;
const LIGHTING_SYSTEM_PROMPT = `${SYSTEM_PROMPT.replace(/\n?Return JSON only, matching the schema\.$/, '')}${LIGHTING_RULE}
Return JSON only, matching the schema.`;

const parseJson = (value) => {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
};

const shotLabel = (zone) => shotList.SHOTS.find((shot) => shot.key === zone)?.label || zone;

// ── Pair formation (pure) ─────────────────────────────────────────────────
function qualityRank(row) {
  const q = Number(row?.quality_score);
  return Number.isFinite(q) ? q : 0;
}

// The best usable, uploaded photo of one shot, or null. Highest quality first,
// then the technician's own order.
function bestPhotoFor(rows, zone) {
  return (rows || [])
    .filter((row) => row && String(row.zone || '').trim().toLowerCase() === zone
      && row.s3_key && !String(row.s3_key).startsWith('pending/')
      && photoIsUsable(row))
    .sort((a, b) => qualityRank(b) - qualityRank(a) || (Number(a.photo_order) || 0) - (Number(b.photo_order) || 0))[0] || null;
}

// True when the assessment's stored per-photo metadata carries the shot-list
// vocabulary marker (lawn-photo-shots.js PHOTO_VOCABULARY).
function capturedUnderShotListMarker(assessment) {
  const meta = parseJson(assessment?.photos);
  return Array.isArray(meta) && meta.some((entry) => entry && entry.photoVocabulary === shotList.PHOTO_VOCABULARY);
}

const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/**
 * The same-premises, same-shot pairs between the PRIOR visit and this one.
 * Pure over the rows the caller loaded. Empty when the two assessments are not
 * provably the same customer and property.
 * @returns {Array<{zone:string, label:string, before:object, after:object}>}
 */
function formPairs({ current, prior, currentPhotos, priorPhotos } = {}) {
  if (!current || !prior || sameId(current.id, prior.id)) return [];
  if (!sameId(current.customer_id, prior.customer_id)) return [];
  // The recorded property is the premises proof. Missing on either side proves
  // nothing, so nothing pairs.
  if (!sameId(current.property_id, prior.property_id)) return [];
  const bothShotList = capturedUnderShotListMarker(current) && capturedUnderShotListMarker(prior);
  const pairs = [];
  for (const zone of shotList.RECHECK_PAIRABLE_SHOT_ZONES) {
    // front was always the one fixed-spot shot; back is a same-spot claim only
    // when both visits were shot under the shot list.
    if (zone !== 'front' && !bothShotList) continue;
    const before = bestPhotoFor(priorPhotos, zone);
    const after = bestPhotoFor(currentPhotos, zone);
    if (before && after) pairs.push({ zone, label: shotLabel(zone), before, after });
    if (pairs.length >= MAX_PAIRS) break;
  }
  return pairs;
}

/** The carried watch topics a read can speak to: known names, no recheck yet. */
function watchItemsFrom(sinceLast) {
  const checks = Array.isArray(sinceLast?.checks) ? sinceLast.checks : [];
  const seen = new Set();
  const items = [];
  for (const check of checks) {
    const key = check && typeof check === 'object' ? String(check.key || '') : '';
    if (!Object.prototype.hasOwnProperty.call(ITEM_NAMES, key) || seen.has(key)) continue;
    if (check.recheck != null || check.recheckOverride != null) continue;
    seen.add(key);
    items.push({ key, name: ITEM_NAMES[key] });
  }
  return items;
}

// ── Request (pure) ────────────────────────────────────────────────────────
/**
 * The provider request for ONE call over every pair. `pairs[i].beforeImage` /
 * `afterImage` are { data, mimeType }. Nothing but the view labels and watch
 * item names is ever put into the text or labels.
 */
function buildRequest({ pairs, items, lighting: lightingOn = false }) {
  const lightLine = (pair) => (lightingOn
    ? ` (BEFORE light: ${pair.beforeLight || 'unknown'}; AFTER light: ${pair.afterLight || 'unknown'}; color ${pair.colorComparable === true ? 'may be compared' : 'may NOT be compared'})`
    : '');
  const lines = [
    `${pairs.length} pair${pairs.length === 1 ? '' : 's'} of same-spot photos follow, each labeled BEFORE then AFTER:`,
    ...pairs.map((pair, i) => `- Pair ${i + 1}: ${pair.label}${lightLine(pair)}`),
    '',
    'Watch items (answer each one by its key):',
    ...items.map((item) => `- ${item.key}: ${item.name}`),
  ];
  const images = pairs.flatMap((pair, i) => [
    { data: pair.beforeImage.data, mimeType: pair.beforeImage.mimeType, label: `Pair ${i + 1} BEFORE (${pair.label})` },
    { data: pair.afterImage.data, mimeType: pair.afterImage.mimeType, label: `Pair ${i + 1} AFTER (${pair.label})` },
  ]);
  return {
    system: lightingOn ? LIGHTING_SYSTEM_PROMPT : SYSTEM_PROMPT,
    text: lines.join('\n'),
    images,
    jsonMode: true,
    jsonSchema: RESPONSE_SCHEMA,
    maxTokens: MAX_OUTPUT_TOKENS,
    thinkingLevel: 'LOW',
    reasoningEffort: 'low',
    timeoutMs: MAX_MS,
    laneId: 'lawn_paired_recheck', // literal on purpose: llm-call-ledger-coverage.test.js greps the call site for it
    promptVersion: lightingOn ? LIGHTING_PROMPT_VERSION : PROMPT_VERSION,
  };
}

// ── Answer validation (pure) ──────────────────────────────────────────────
const isChangeList = (value) => Array.isArray(value) && value.every((d) => CHANGE_DIMENSIONS.includes(d));
const orderedChanges = (list) => CHANGE_DIMENSIONS.filter((d) => list.includes(d));

// An item key as the request sends it is lowercase with no padding; an answer's
// key is matched after trim + lowercase, and two answers for one key are a duplicate.
const itemKeyOf = (value) => String(value == null ? '' : value).trim().toLowerCase();

// EXACT coverage: one entry for every pair number sent and no others.
function pairProblem(pairs, pairCount) {
  const seen = new Set();
  for (const p of pairs) {
    if (!p || !Number.isInteger(p.pair) || p.pair < 1 || p.pair > pairCount || seen.has(p.pair)) return 'invalid_pair';
    if (!VERDICTS.includes(p.verdict) || !isChangeList(p.what_changed)) return 'invalid_pair';
    seen.add(p.pair);
  }
  return seen.size === pairCount ? null : 'incomplete_pairs';
}

// EXACT coverage: one entry for every item key sent and no others.
function itemProblem(items, pairCount, itemKeys) {
  const asked = new Set(itemKeys);
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item.item !== 'string') return 'invalid_item';
    const key = itemKeyOf(item.item);
    if (!asked.has(key)) return 'unknown_item';
    if (seen.has(key)) return 'invalid_item';
    if (!VERDICTS.includes(item.verdict) || !isChangeList(item.what_changed)) return 'invalid_item';
    if (!Array.isArray(item.pairs) || !item.pairs.every((n) => Number.isInteger(n) && n >= 1 && n <= pairCount)) return 'invalid_item';
    seen.add(key);
  }
  return seen.size === asked.size ? null : 'incomplete_items';
}

/**
 * null when the answer conforms, otherwise a short reason. The validator is the
 * chain's per-leg check, so a miss here sends the request to the NEXT provider;
 * it must reject anything normalizeAnswer would otherwise have to drop silently:
 * an empty array, a missing or extra or repeated pair, a missing, unknown or
 * repeated item. Enums and pair numbers are checked here because the schema
 * carries no numeric bounds.
 */
function answerProblem(json, { pairCount, itemKeys } = {}) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.pairs) || !Array.isArray(json.items)) return 'schema_invalid';
  if (!Number.isInteger(pairCount) || pairCount < 1 || !Array.isArray(itemKeys) || !itemKeys.length) return 'no_request_context';
  return pairProblem(json.pairs, pairCount) || itemProblem(json.items, pairCount, itemKeys);
}

/**
 * From a conforming answer: the recheck record per watch item that earns one,
 * and the whole-lawn pair verdicts. A verdict earns a record only when it is
 * better / same / worse, cites at least one pair the model itself could read,
 * and (for better / worse) names at least one changed dimension. cannot_tell
 * and anything unsupported writes NOTHING (the engine then says "unclear").
 * @returns {{rechecks: Object, photoPairs: Array}}
 */
function normalizeAnswer(json, { pairs, items, promptVersion = PROMPT_VERSION }) {
  // A pair whose two photos are not in compatible light (`colorComparable === false`,
  // only ever set while GATE_LAWN_LIGHTING is live) cannot speak to color: color is
  // dropped from its what_changed, and a better / worse verdict that rested on
  // color alone is read as cannot_tell. Pairs with no such mark are untouched.
  const colorBlocked = (n) => pairs[n - 1]?.colorComparable === false;
  const pairChanges = (p) => (p.verdict === 'same' ? [] : orderedChanges(p.what_changed).filter((d) => !(d === 'color' && colorBlocked(p.pair))));
  const verdictOf = (p) => (colorBlocked(p.pair) && (p.verdict === 'better' || p.verdict === 'worse') && !pairChanges(p).length ? 'cannot_tell' : p.verdict);
  const byPair = new Map(json.pairs.map((p) => [p.pair, { ...p, verdict: verdictOf(p) }]));
  const askedKeys = new Set(items.map((item) => item.key));
  const rechecks = {};
  for (const answer of json.items) {
    const key = itemKeyOf(answer.item);
    if (!askedKeys.has(key) || !WRITABLE_VERDICTS.has(answer.verdict)) continue;
    const cited = [...new Set(answer.pairs)].filter((n) => (byPair.get(n)?.verdict || 'cannot_tell') !== 'cannot_tell');
    if (!cited.length) continue;
    // An item may name color only when a cited pair that CAN speak to it (compatible
    // light) itself reported a color change; color seen only in a blocked pair, or
    // not seen in the compatible pairs, does not survive. Gate-off pairs (no light
    // marks) keep the item's own answer.
    const lightMarked = pairs.some((pair) => pair.colorComparable !== undefined);
    const colorAllowed = !lightMarked || cited.some((n) => !colorBlocked(n) && pairChanges(byPair.get(n)).includes('color'));
    const changed = answer.verdict === 'same' ? [] : orderedChanges(answer.what_changed).filter((d) => d !== 'color' || colorAllowed);
    if (answer.verdict !== 'same' && !changed.length) continue;
    rechecks[key] = {
      verdict: answer.verdict,
      source: RECHECK_SOURCE,
      whatChanged: changed,
      pairs: cited.sort((a, b) => a - b).map((n) => pairs[n - 1].zone),
      promptVersion,
    };
  }
  const photoPairs = [...byPair.values()]
    .filter((p) => WRITABLE_VERDICTS.has(p.verdict))
    .sort((a, b) => a.pair - b.pair)
    .map((p) => ({
      zone: pairs[p.pair - 1].zone,
      verdict: p.verdict,
      whatChanged: pairChanges(p),
    }));
  return { rechecks, photoPairs };
}

// ── The job ───────────────────────────────────────────────────────────────
async function loadInputs({ knex, assessmentId, priorAssessmentId }) {
  const ids = [assessmentId, priorAssessmentId];
  const assessments = await knex('lawn_assessments').whereIn('id', ids).select('id', 'customer_id', 'property_id', 'photos');
  const photos = await knex('lawn_assessment_photos').whereIn('assessment_id', ids).select(
    'id', 'assessment_id', 'zone', 's3_key', 'mime_type', 'quality_score', 'quality_gate_passed',
    'turf_density', 'weed_coverage', 'color_health', 'photo_order',
  );
  const find = (id) => assessments.find((row) => sameId(row.id, id)) || null;
  const photosOf = (id) => photos.filter((row) => sameId(row.assessment_id, id));
  return {
    current: find(assessmentId), prior: find(priorAssessmentId), currentPhotos: photosOf(assessmentId), priorPhotos: photosOf(priorAssessmentId),
  };
}

// GATE_LAWN_LIGHTING: the stored light of each of the two visits' photos, by
// photo row id (a photo with no read, or from a run before the gate, is
// 'unknown'). THROWS on a failed read; runPairedRecheck's catch then writes
// nothing, so a degraded read is never frozen as a healthy one.
async function loadPhotoLights({ knex, assessmentId, priorAssessmentId }) {
  const runs = await knex('lawn_assessment_runs')
    .whereIn('assessment_id', [assessmentId, priorAssessmentId])
    .select('assessment_id', 'photo_ids', 'photo_quality');
  const byPhotoId = new Map();
  for (const run of runs) for (const entry of lighting.photoLightsFromRun(run)) if (entry.photoId != null) byPhotoId.set(entry.photoId, entry.light);
  return byPhotoId;
}

// A formed pair with each photo's light and whether color may be compared on it.
function markPairLight(pair, lightByPhotoId) {
  const beforeLight = lightByPhotoId.get(String(pair.before.id)) || 'unknown';
  const afterLight = lightByPhotoId.get(String(pair.after.id)) || 'unknown';
  return { ...pair, beforeLight, afterLight, colorComparable: lighting.colorComparability(afterLight, beforeLight).comparable };
}

async function loadImage(photoService, row) {
  const { data, mimeType } = await photoService.getPhotoBase64(row.s3_key);
  return { data, mimeType: String(mimeType || row.mime_type || 'image/jpeg').toLowerCase() };
}

async function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  try { return await Promise.race([promise, deadline]); } finally { clearTimeout(timer); }
}

// Load the images for each formed pair; a pair with an unreadable photo is dropped.
async function loadPairImages(formed, photoService, assessmentId) {
  const loaded = [];
  for (const pair of formed) {
    try {
      const [beforeImage, afterImage] = await Promise.all([loadImage(photoService, pair.before), loadImage(photoService, pair.after)]);
      if (beforeImage.data && afterImage.data) loaded.push({ ...pair, beforeImage, afterImage });
    } catch (err) {
      logger.warn(`[lawn-paired-recheck] ${pair.zone} photo unreadable for ${assessmentId}: ${err.message}`);
    }
  }
  return loaded;
}

// The one model call over every pair. { outcome } on a conforming answer, else { miss }.
async function askModel({ loaded, items, assessmentId, dispatch, deadlineMs, lighting: lightingOn = false }) {
  const itemKeys = items.map((item) => item.key);
  const payload = buildRequest({ pairs: loaded, items, lighting: lightingOn });
  const started = Date.now();
  const outcome = await withDeadline(
    Promise.resolve().then(() => dispatch(MODELS.TEXT_POLICIES.lawnPairedRecheck, payload, {
      // A nonconforming answer is a failed leg, so the OpenAI stand-in gets its turn.
      validate: (result) => answerProblem(result.json, { pairCount: loaded.length, itemKeys }),
      reserveFallbackBudget: true,
      hardDeadline: true,
    })),
    deadlineMs ?? (MAX_MS + GRACE_MS),
  );
  const latencyMs = Date.now() - started;
  if (!outcome || !outcome.ok) {
    logger.warn(`[lawn-paired-recheck] unavailable for ${assessmentId} (${(outcome && outcome.reason) || 'timeout'})`);
    return { miss: { status: 'unavailable', latencyMs } };
  }
  const problem = answerProblem(outcome.json, { pairCount: loaded.length, itemKeys });
  if (problem) {
    logger.warn(`[lawn-paired-recheck] unusable answer for ${assessmentId} (${problem})`);
    return { miss: { status: 'unavailable', latencyMs } };
  }
  return { outcome, latencyMs };
}

// What the job needs from the frozen entry, or the status that ends it.
function preflight(ctx) {
  const priorAssessmentId = ctx.entry?.sinceLast?.priorAssessmentId;
  if (!ctx.serviceRecordId || !ctx.assessmentId || !priorAssessmentId) return { done: { status: 'no_prior' } };
  const items = watchItemsFrom(ctx.entry.sinceLast);
  return items.length ? { priorAssessmentId, items } : { done: { status: 'no_items' } };
}

// Score the answer into records and store them; the job's final status.
async function storeVerdicts({ ctx, knex, loaded, items, outcome, latencyMs, lighting: lightingOn = false }) {
  const { rechecks, photoPairs } = normalizeAnswer(outcome.json, { pairs: loaded, items, promptVersion: lightingOn ? LIGHTING_PROMPT_VERSION : PROMPT_VERSION });
  const usage = outcome.usage || null;
  logger.info(`[lawn-paired-recheck] ${ctx.assessmentId}: ${loaded.length} pair(s), ${Object.keys(rechecks).length} recheck(s), `
    + `${outcome.provider}/${outcome.model}, ${latencyMs}ms, tokens in ${usage?.input_tokens ?? '?'} out ${usage?.output_tokens ?? '?'}`);
  if (!Object.keys(rechecks).length && !photoPairs.length) return { status: 'no_verdict', latencyMs, usage };
  const stored = await recordPairedRecheck(ctx.serviceRecordId, ctx.assessmentId, { rechecks, photoPairs }, knex);
  if (!stored) return { status: 'not_stored', latencyMs, usage };
  return { status: 'stored', written: stored.written, photoPairs: stored.photoPairs, latencyMs, usage };
}

/**
 * Run the paired read for one freshly frozen visit memory entry. Never throws.
 * @param {{serviceRecordId:string, assessmentId:string, entry:object}} ctx
 * @param {{knex?, photoService?, dispatch?, deadlineMs?}} [deps] injectable for tests
 * @returns {Promise<{status:string, ...}>} status: off | no_prior | no_items |
 *   no_pairs | unavailable | no_verdict | stored | not_stored
 */
async function runPairedRecheck(ctx = {}, deps = {}) {
  if (!lawnPairedRecheckLive()) return { status: 'off' };
  const knex = deps.knex || db;
  try {
    const { done, priorAssessmentId, items } = preflight(ctx);
    if (done) return done;
    const { assessmentId } = ctx;
    // GATE_LAWN_LIGHTING, read at call time: v3 prompt, each photo's stored light,
    // and no color claim across different light. Off, none of this runs.
    const lightingOn = lawnLightingLive();
    const inputs = await loadInputs({ knex, assessmentId, priorAssessmentId });
    const lightByPhotoId = lightingOn ? await loadPhotoLights({ knex, assessmentId, priorAssessmentId }) : null;
    const formed = formPairs(inputs).map((pair) => (lightByPhotoId ? markPairLight(pair, lightByPhotoId) : pair));
    const loaded = formed.length ? await loadPairImages(formed, deps.photoService || require('./photos'), assessmentId) : [];
    if (!loaded.length) {
      logger.info(`[lawn-paired-recheck] no pair for ${assessmentId} (prior ${priorAssessmentId})`);
      return { status: 'no_pairs' };
    }
    const asked = await askModel({
      loaded, items, assessmentId, dispatch: deps.dispatch || dispatchWithFallback, deadlineMs: deps.deadlineMs, lighting: lightingOn,
    });
    if (asked.miss) return asked.miss;
    return await storeVerdicts({ ctx, knex, loaded, items, outcome: asked.outcome, latencyMs: asked.latencyMs, lighting: lightingOn });
  } catch (err) {
    logger.warn(`[lawn-paired-recheck] failed for ${ctx.assessmentId}: ${err.message}`);
    return { status: 'unavailable' };
  }
}

/**
 * The onCreated hook the report render hands the visit-memory freezer (only
 * while the gate is live). Defers the job to the next tick so the render that
 * created the entry returns first; returns the timer for tests, null when off.
 */
function scheduleAfterFreeze(ctx, deps = {}) {
  if (!lawnPairedRecheckLive()) return null;
  // An entry that froze with no prior, or with no watch topic left to speak to,
  // can never carry a recheck, so there is nothing to schedule.
  if (preflight(ctx).done) return null;
  return setImmediate(() => {
    runPairedRecheck(ctx, deps).catch((err) => logger.warn(`[lawn-paired-recheck] job failed: ${err.message}`));
  });
}

module.exports = {
  PROMPT_VERSION,
  LIGHTING_PROMPT_VERSION,
  LIGHTING_SYSTEM_PROMPT,
  LANE_ID,
  RECHECK_SOURCE,
  VERDICTS,
  CHANGE_DIMENSIONS,
  MAX_PAIRS,
  ITEM_NAMES,
  RESPONSE_SCHEMA,
  SYSTEM_PROMPT,
  formPairs,
  watchItemsFrom,
  buildRequest,
  answerProblem,
  normalizeAnswer,
  runPairedRecheck,
  scheduleAfterFreeze,
};
