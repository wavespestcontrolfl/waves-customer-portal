/** Normalize lawn visit evidence and keep unrated photos out of customer delivery. */
const Ajv = require('ajv');
const { RESPONSE_SCHEMA, PHOTO_QUALITY, CONFIDENCE, SEVERITY_LEVELS, THATCH_LEVELS, SIGNAL_LEVELS } = require('./lawn-visit-input');
const { normalizeFindings, safeConditionLabel } = require('./lawn-diagnostic-report');
const { normalizeGrassType } = require('./lawn-grass-context');

const UNAVAILABLE_OBSERVATIONS = 'Visual analysis unavailable';

const UNRATED_QUALITY = 'unrated';

const CUSTOMER_VISIBLE_QUALITY = new Set(['adequate', 'limited']);

const QUALITY_SCORE = { adequate: 80, limited: 55, poor: 20, [UNRATED_QUALITY]: 0 };

const STRESS_SIGNALS = ['fungal_activity', 'insect_damage', 'drought_stress', 'mechanical_damage'];

const NO_STRESS_LABEL = 'no major visible stress';

const clip = (value, max) => String(value == null ? '' : value).trim().slice(0, max);

function uniqueInts(values, max) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 1 && n <= max && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

function normalizeSignal(raw, levels) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const confidence = CONFIDENCE.includes(source.confidence) ? source.confidence : 'unknown';
  return {
    level: confidence !== 'unknown' && levels.includes(source.level) ? source.level : 'unknown',
    evidence: clip(source.evidence, 300),
    confidence,
  };
}

function scoreOrNull(raw, min, max) {
  if (!raw || typeof raw !== 'object' || raw.determinable !== true) return null;
  if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) return null;
  return Math.max(min, Math.min(max, Math.round(raw.value)));
}

function normalizePhotoQuality(list, photoCount) {
  const rows = Array.from({ length: photoCount }, (_, i) => ({ photo: i + 1, quality: UNRATED_QUALITY, issue: 'not rated by the model' }));
  for (const entry of Array.isArray(list) ? list : []) {
    const index = Number(entry?.photo) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= photoCount) continue;
    if (!PHOTO_QUALITY.includes(entry?.quality)) continue;
    rows[index] = { photo: index + 1, quality: entry.quality, issue: clip(entry.issue, 200) };
  }
  return rows;
}

function zoneFromRefs(photoRefs, photoZones = []) {
  const zones = new Set(photoRefs.map((ref) => photoZones[ref - 1]).filter(Boolean));
  return zones.size === 1 ? [...zones][0] : 'unknown';
}

function containerShape(schema) {
  if (schema.type === 'object') {
    return { type: 'object', properties: Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, containerShape(value)])) };
  }
  if (schema.type === 'array') return { type: 'array', items: containerShape(schema.items) };
  return {};
}

const hasResponseShape = new Ajv().compile(containerShape(RESPONSE_SCHEMA));

function validateAssessmentJson(result, photoCount) {
  const json = result && result.json;
  if (!json || typeof json !== 'object' || Array.isArray(json)) return 'malformed_assessment';
  if (!hasResponseShape(json)) return 'malformed_assessment';
  if (!Array.isArray(json.findings)) return 'malformed_assessment';
  if (!json.severities || typeof json.severities !== 'object') return 'malformed_assessment';
  if (!json.scores || typeof json.scores !== 'object') return 'malformed_assessment';
  // A clean lawn is a finding too ("No major visible stress"); an empty set is
  // a skipped job, not an answer — fail the leg so the fallback runs.
  if (!json.findings.length) return 'empty_findings';
  // Every photo of the visit gets a quality read: an answer that rates none
  // (or not all) of them has not looked at the visit — it fails the leg
  // rather than becoming a complete run over unrated photos.
  if (!ratesEveryPhoto(json.photo_quality, photoCount)) return 'incomplete_photo_quality';
  return null;
}

function ratesEveryPhoto(list, photoCount) {
  if (!Array.isArray(list)) return false;
  const rated = new Set();
  for (const entry of list) {
    const photo = Number(entry?.photo);
    if (Number.isInteger(photo) && photo >= 1 && photo <= photoCount && PHOTO_QUALITY.includes(entry?.quality)) rated.add(photo);
  }
  return rated.size === photoCount;
}

function normalizeAssessment(json, photoCount, photoZones = []) {
  const rawFindings = Array.isArray(json.findings) ? json.findings : [];
  const photoQuality = normalizePhotoQuality(json.photo_quality, photoCount);
  const usable = new Set(photoQuality.filter((row) => CUSTOMER_VISIBLE_QUALITY.has(row.quality)).map((row) => row.photo));
  const findings = normalizeFindings(rawFindings).map((finding, index) => {
    const raw = rawFindings[index] || {};
    const photoRefs = uniqueInts(raw.photo_refs, photoCount);
    // A finding the model itself says the photos cannot settle carries no
    // confidence claim: unknown, so the naming gate publishes no cause. The
    // same for a condition that cites no photo of this visit (none, or only
    // out-of-range numbers): evidence nobody can trace is not evidence. The
    // clean-lawn finding is exempt — it has nothing to point at.
    const untraceable = !photoRefs.length && safeConditionLabel(finding.name, finding.confidence) !== NO_STRESS_LABEL;
    // A finding whose every cited photo the same answer rated poor (blurred,
    // too far, not a lawn) rests on evidence the answer itself disowned: in a
    // mixed-quality visit one adequate photo lifts the retake hold, so the
    // gate is applied per finding — undeterminable, no cause published
    // (Codex #4149 r6).
    const unsupported = photoRefs.length > 0 && !photoRefs.some((ref) => usable.has(ref));
    // Determinability is a claim the answer has to make: only a literal
    // `true` keeps the confidence. The shape check lets any scalar through,
    // so an omitted key or the string "false" must read as undeterminable,
    // never as a high-confidence named cause (Codex #4149 r7).
    const unstated = raw.can_determine !== true;
    const canDetermine = !unstated && !untraceable && !unsupported;
    const confidence = canDetermine ? finding.confidence : 'unknown';
    return {
      ...finding,
      // Server-authored ids: the review keys on them, so a duplicate or a
      // technician-shaped ("T1") model id can never alias another finding.
      finding_id: `F${index + 1}`,
      model_finding_id: clip(raw.finding_id, 40) || null,
      confidence,
      photo_refs: photoRefs,
      zone: zoneFromRefs(photoRefs, photoZones),
      can_determine: canDetermine,
      cannot_determine_reason: canDetermine ? '' : (clip(raw.cannot_determine_reason, 300) || (untraceable ? 'no photo of this visit cited' : '') || (unsupported ? 'every cited photo rated poor' : '') || (unstated && raw.can_determine !== false ? 'determinability not stated' : '')),
      // The allowlisted customer label — the naming gate applied here, once,
      // so no consumer ever maps the raw name itself.
      label: safeConditionLabel(finding.name, confidence),
      source: 'model',
    };
  });
  const severities = {};
  for (const key of STRESS_SIGNALS) severities[key] = normalizeSignal(json.severities[key], SEVERITY_LEVELS);
  severities.thatch_visibility = normalizeSignal(json.severities.thatch_visibility, THATCH_LEVELS);
  severities.overwatering_signal = normalizeSignal(json.severities.overwatering_signal, SIGNAL_LEVELS);
  const scores = {
    turf_density: scoreOrNull(json.scores.turf_density, 0, 100),
    weed_coverage: scoreOrNull(json.scores.weed_coverage, 0, 100),
    color_health: scoreOrNull(json.scores.color_health, 1, 10),
  };
  const grass = normalizeGrassType(json.grass_type);
  return {
    findings,
    severities,
    scores,
    photoQuality,
    grassType: grass && grass !== 'unknown' ? grass : null,
    observations: clip(json.observations, 1200),
  };
}

function emptyAnalysis(photoCount) {
  return {
    findings: [],
    severities: null,
    scores: { turf_density: null, weed_coverage: null, color_health: null },
    photoQuality: Array.from({ length: photoCount }, (_, i) => ({ photo: i + 1, quality: UNRATED_QUALITY, issue: 'not rated (analysis unavailable)' })),
    grassType: null,
    observations: UNAVAILABLE_OBSERVATIONS,
  };
}

function photoRowInputs(analysis) {
  const qualityResults = [];
  const resultByPhotoIndex = {};
  for (const row of analysis?.photoQuality || []) {
    const index = row.photo - 1;
    qualityResults[index] = { passed: CUSTOMER_VISIBLE_QUALITY.has(row.quality), issues: row.issue ? [row.issue] : [] };
    resultByPhotoIndex[index] = { qualityScore: QUALITY_SCORE[row.quality] ?? 0 };
  }
  const allPoor = analysis?.status === 'complete' && qualityResults.length > 0 && qualityResults.every((row) => row && !row.passed);
  return { qualityResults, resultByPhotoIndex, allPoor };
}

function compositeFor(analysis) {
  if (!analysis) return { grass_type: null };
  const level = (key) => analysis.severities?.[key]?.level ?? null;
  return {
    grass_type: analysis.grassType || null,
    turf_density: analysis.scores?.turf_density ?? null,
    weed_coverage: analysis.scores?.weed_coverage ?? null,
    color_health: analysis.scores?.color_health ?? null,
    fungal_activity: level('fungal_activity'),
    insect_damage: level('insect_damage'),
    drought_stress: level('drought_stress'),
    mechanical_damage: level('mechanical_damage'),
    thatch_visibility: level('thatch_visibility'),
    overwatering_signal: level('overwatering_signal') === 'yes',
    observations: analysis.observations || '',
  };
}

module.exports = { UNAVAILABLE_OBSERVATIONS, NO_STRESS_LABEL, validateAssessmentJson, normalizeAssessment, emptyAnalysis, zoneFromRefs, photoRowInputs, compositeFor };
