/**
 * Tree & Shrub Health Assessment Service
 *
 * Gemini-first vision analysis that scores landscape-plant health from the
 * visit's tree/shrub photos, mirroring lawn-assessment.js. Owner ruling
 * 2026-09-24: no more Claude+Gemini fan-out — analyzePhoto tries Gemini
 * first; Claude runs ONLY when Gemini returns nothing (HTTP/parse/empty/
 * schema-invalid miss). Produces the five customer-facing diagnosis
 * categories as 0-100 "health" scores (higher = healthier / fewer problem
 * signals), persists a tree_shrub_assessments row, and exposes the report
 * loader (buildTreeShrubAssessmentReportData) that shapes a stored assessment
 * into the payload buildTreeShrubReportV2 consumes.
 *
 * GUARDRAIL: the vision models rate the SEVERITY of visible signals (none → severe);
 * we never ask them to "confirm" a pest or disease. Severity → health score is a
 * deterministic ramp, and the report copy says "signals", never "infestation"/"diseased"
 * unless a tech confirms it (tech_confirmed_pest / tech_confirmed_disease).
 */

const crypto = require('crypto');
const Ajv = require('ajv');
const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { anthropicMaxTokens, anthropicEffortConfig } = require('./llm/anthropic-wire');
const { anthropicText, geminiText } = require('./llm/call');
const {
  TECH_FINDING_LABELS, PALM_CROWN_PROMPT_RULE, techFindingsCopyLive, normalizeTechFindings, editText,
  hideFrozenFindingsInScores, loadFrozenTechFindingsByRecord, withholdScores,
} = require('./service-report/tree-shrub-tech-findings');
const {
  validMonth: validWatchMonth, normalizeWatchSignals, watchListPromptBlock,
} = require('../config/tree-shrub-watch-list');

// Order-independent content hash of a set of photo data URLs (each hashed, then
// hashed together) so the review signature can be bound to the EXACT photos scored —
// swapping photos at the same count then changes the hash and fails verification.
function treeShrubPhotosHash(dataList = []) {
  const h = crypto.createHash('sha256');
  for (const d of (Array.isArray(dataList) ? dataList : [])) {
    h.update(crypto.createHash('sha256').update(String(d == null ? '' : d)).digest('hex'));
  }
  return h.digest('hex');
}

// HMAC binding the preview's score VALUES (fixed field order — order-independent of
// JSON) + scoredCount + serviceId + a hash of the exact photos scored + the
// observation text, so the completion handler can prove the reviewed scores AND copy
// it's about to persist actually came from THIS server's /assess-preview for THESE
// photos. A tampered/stale client can't forge it → the handler re-scores instead.
function treeShrubReviewSignature(scores = {}, scoredCount, serviceId, photosHash, observations) {
  const obsHash = crypto.createHash('sha256').update(String(observations == null ? '' : observations)).digest('hex');
  const canon = ['foliageFullness', 'leafColorVigor', 'pestActivity', 'diseaseLeafSpot', 'waterHeatStress', 'overallScore']
    .map((k) => (scores && scores[k] != null ? scores[k] : '')).join(',')
    + `|${scoredCount == null ? '' : scoredCount}|${serviceId || ''}|${photosHash || ''}|${obsHash}`;
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'tree-shrub-review-key').update(canon).digest('hex');
}

const TREE_SHRUB_REVIEW_SCORE_KEYS = [
  'foliageFullness',
  'leafColorVigor',
  'pestActivity',
  'diseaseLeafSpot',
  'waterHeatStress',
  'overallScore',
];
const TREE_SHRUB_REVIEW_SCORE_KEYSET = [...TREE_SHRUB_REVIEW_SCORE_KEYS].sort().join('|');

const TREE_SHRUB_REVIEW_DECISION_KEYS = {
  foliage_fullness: 'foliageFullness',
  leaf_color_vigor: 'leafColorVigor',
  pest_activity: 'pestActivity',
  disease_leaf_spot: 'diseaseLeafSpot',
  water_heat_mechanical_stress: 'waterHeatStress',
};
const validateReviewDecisions = new Ajv().compile({
  type: 'array', maxItems: 5,
  items: {
    type: 'object', required: ['key', 'action'],
    properties: {
      key: { enum: Object.keys(TREE_SHRUB_REVIEW_DECISION_KEYS) },
      action: { enum: ['monitor', 'confirmed', 'hidden', 'edit'] },
    },
  },
});

// Validate the signed preview contract used by Generate. The HMAC proves only
// that these photo-model scores and observations came from this server's
// preview for this service and photo-set hash. It never converts a visual
// signal into a technician-confirmed pest, disease, deficiency, or diagnosis.
function validateTreeShrubReviewForReport(review, { serviceId } = {}) {
  const invalid = (reason) => ({ ok: false, reason });
  if (Object.prototype.toString.call(review) !== '[object Object]') return invalid('review_shape');
  if (review.confirmed !== true) return invalid('review_not_confirmed');
  if (!serviceId) return invalid('service_id_missing');

  const scoredCount = review.scoredCount;
  const photoCount = review.photoCount;
  if (scoredCount !== photoCount || ![1, 2, 3, 4, 5].includes(photoCount)) return invalid('photo_count_mismatch');
  if (!/^[a-f0-9]{64}$/.test(String(review.photosHash))) return invalid('photos_hash_invalid');
  if (!/^[a-f0-9]{64}$/.test(String(review.signature))) return invalid('signature_invalid');
  if (typeof review.observations !== 'string') return invalid('observations_invalid');

  const scores = review.scores;
  if (Object.prototype.toString.call(scores) !== '[object Object]') return invalid('scores_invalid');
  if (Object.keys(scores).sort().join('|') !== TREE_SHRUB_REVIEW_SCORE_KEYSET) return invalid('score_keys_invalid');
  if (!TREE_SHRUB_REVIEW_SCORE_KEYS.every((key) => (
    Number.isFinite(scores[key]) && scores[key] >= 0 && scores[key] <= 100
  ))) return invalid('score_values_invalid');

  const decisions = review.decisions;
  if (!validateReviewDecisions(decisions)
    || new Set(decisions.map((decision) => decision.key)).size !== decisions.length) {
    return invalid('decisions_invalid');
  }

  const expected = treeShrubReviewSignature(
    scores,
    scoredCount,
    serviceId,
    review.photosHash,
    review.observations,
  );
  if (review.signature !== expected) return invalid('signature_mismatch');

  const hiddenScoreKeys = new Set(decisions
    .filter((decision) => decision.action === 'hidden')
    .map((decision) => TREE_SHRUB_REVIEW_DECISION_KEYS[decision.key]));
  const includedScores = {};
  // The original overall includes every category, including a hidden false
  // read. Omit that aggregate whenever anything was hidden rather than
  // presenting a score still influenced by the rejected signal.
  const includedKeys = hiddenScoreKeys.size
    ? TREE_SHRUB_REVIEW_SCORE_KEYS.filter((key) => key !== 'overallScore' && !hiddenScoreKeys.has(key))
    : TREE_SHRUB_REVIEW_SCORE_KEYS;
  for (const key of includedKeys) includedScores[key] = scores[key];

  const grounding = {
    source: 'reviewed_photo_signals',
    scores: includedScores,
    scoredCount,
    photoCount,
    photosHash: review.photosHash,
    // Any hidden signal can make the aggregate prose contradict the
    // technician's review, so drop it whole.
    observations: hiddenScoreKeys.size ? '' : review.observations.trim(),
    hasHidden: hiddenScoreKeys.size > 0,
  };
  if (techFindingsCopyLive()) {
    // GATE_TS_TECH_FINDINGS_COPY: the writer also hears the technician's own
    // confirmed / edited findings. An edited category's photo-read score and the
    // aggregate prose (written from the read the edit replaces) stay out.
    // Normalized: an edit with nothing printable left reads as a hide, so its
    // score goes like any hide's.
    const techFindings = normalizeTechFindings(decisions);
    const replaced = techFindings.filter((f) => f.action === 'hidden' || editText(f));
    for (const f of replaced) delete grounding.scores[TREE_SHRUB_REVIEW_DECISION_KEYS[f.key]];
    if (replaced.length) {
      grounding.hasHidden = grounding.hasHidden || techFindings.some((f) => f.action === 'hidden');
      delete grounding.scores.overallScore;
      grounding.observations = '';
    }
    grounding.techFindings = techFindings;
  }
  return { ok: true, grounding };
}

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

// Presigner for S3-backed photos (same view-URL helper the lawn report uses).
let PhotoService = null;
try { PhotoService = require('./photos'); } catch { PhotoService = null; }

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || MODELS.GEMINI_VISION_BEST;
const GEMINI_VISION_FALLBACK_MODEL = MODELS.GEMINI_VISION_FALLBACK;

// Severity word → 0-100 "health" display (higher = healthier). Same ramp as the
// lawn scorer's FUNGUS_DISPLAY so the two reports agree on how a signal reads.
const SEVERITY_DISPLAY = { none: 95, minor: 75, moderate: 50, severe: 20 };
const SEVERITY_INDEX = { none: 0, minor: 1, moderate: 2, severe: 3 };
const SEVERITY_REVERSE = ['none', 'minor', 'moderate', 'severe'];

// Shortest observation paragraph accepted as a real read. The prompt asks for
// 2-3 homeowner sentences; 20 characters is below any real sentence and above
// placeholder replies ("n/a", "none", "ok", "see photo").
const OBSERVATIONS_MIN_LENGTH = 20;

// THE declared shape of one vision provider's JSON reply — the single source
// for the prompt's "Return this exact JSON structure" block (VISION_JSON_SHAPE),
// the field lists every merge below iterates (NUMERIC_SCORE_FIELDS /
// SEVERITY_SCORE_FIELDS), and validation — both the per-provider gate that
// decides the Claude fallback (isValidTreeShrubScores) and the admin lane's
// completeness gate (isCompleteVisionResult). A field added here is prompted
// for, merged, and validated with no other edit.
const VISION_RESULT_SCHEMA = {
  foliage_fullness: { kind: 'score', min: 0, max: 100 },
  leaf_color_vigor: { kind: 'score', min: 0, max: 100 },
  pest_signals: { kind: 'severity', values: SEVERITY_REVERSE },
  disease_signals: { kind: 'severity', values: SEVERITY_REVERSE },
  water_heat_stress: { kind: 'severity', values: SEVERITY_REVERSE },
  pruning_mechanical: { kind: 'severity', values: SEVERITY_REVERSE },
  observations: { kind: 'text', minLength: OBSERVATIONS_MIN_LENGTH },
};

const schemaFieldsOfKind = (kind) => Object.keys(VISION_RESULT_SCHEMA)
  .filter((field) => VISION_RESULT_SCHEMA[field].kind === kind);
const NUMERIC_SCORE_FIELDS = schemaFieldsOfKind('score');
const SEVERITY_SCORE_FIELDS = schemaFieldsOfKind('severity');

// Per-kind rendering of a schema field in the prompt's JSON block, and the
// per-kind validator for a provider's value. Every kind in the schema has one
// of each (pinned by tests), so neither the prompt nor the validator can
// drift from the schema.
const SCHEMA_PROMPT_SHAPES = {
  score: (spec) => `<number ${spec.min}-${spec.max}>`,
  severity: (spec) => `<${spec.values.map((word) => `"${word}"`).join(' | ')}>`,
  text: () => '"<one concise paragraph>"',
};
const SCHEMA_VALIDATORS = {
  // A real number in range — not num()'s coercion (false → 0) and not
  // clampScore's rescue of 250 / -5. NaN/Infinity fail the range. Quoted
  // numbers ("82") are formatting noise normalizeTreeShrubScores converts
  // BEFORE a provider reply is validated; an unconverted string fails.
  score: (value, spec) => typeof value === 'number' && value >= spec.min && value <= spec.max,
  // An exact severity word (case/whitespace-insensitive, as normalizeSeverity
  // reads it) — never the "none" default an unknown word falls back to.
  severity: (value, spec) => typeof value === 'string' && spec.values.includes(value.trim().toLowerCase()),
  // Real prose: whitespace-only or placeholder-short text is not a read.
  text: (value, spec) => typeof value === 'string' && value.trim().length >= spec.minLength,
};

const VISION_JSON_SHAPE = `{\n${Object.entries(VISION_RESULT_SCHEMA)
  .map(([field, spec]) => `  "${field}": ${SCHEMA_PROMPT_SHAPES[spec.kind](spec)}`)
  .join(',\n')}\n}`;

const VISION_PROMPT = `You are a tree & shrub (landscape ornamental) plant-health assessment tool for a professional lawn & pest company in Southwest Florida. Analyze the provided photo of shrubs, hedges, palms, trees, or landscape beds and return ONLY a JSON object with the scores below. Base your analysis strictly on what is visible.

You flag SIGNALS, never a confirmed diagnosis. Report pest-pressure and disease-like SIGNALS — never assert an "infestation" or a confirmed "disease".

BE SPECIFIC, NOT GENERIC. When the visual pattern points to a recognizable cause, NAME it using "consistent with" language: name the likely pest group (scale, mealybugs, whiteflies, spider mites, thrips, caterpillars, palm aphids), the likely disease (fungal leaf spot such as Pestalotiopsis or Bipolaris, Graphiola false smut, Ganoderma conk, sooty mold, powdery mildew, anthracnose), or the likely SPECIFIC nutrient deficiency by its species-typical pattern:
- Potassium deficiency (the most common SWFL palm deficiency): OLDER fronds yellowing with translucent yellow-orange speckling and necrotic leaflet tips; the palm pulls potassium from old fronds to feed new growth.
- Magnesium deficiency on palms: broad yellow band along the edges of OLDER fronds with a green center.
- Manganese deficiency on palms/cycads: frizzled, weak, or yellowing NEW growth.
- Iron deficiency: interveinal yellowing on NEW growth, common in alkaline soil.
Note when one issue likely feeds another (nutritional stress opening the door to fungal leaf spot, honeydew from sap-feeders growing sooty mold).

DO NOT FLAG NORMAL PLANT ANATOMY. Many palms carry a natural reddish-brown woolly fuzz (tomentum) on the crownshaft, emerging spear, and leaf bases — dense, uniform, velvety fuzz there is normal anatomy, not scale or pests. Only report scale-like bumps that are hard, shell-like, sticky, or irregularly scattered on leaf and twig surfaces. When unsure, describe it as "worth a touch-check" rather than a pest signal.

"A nutrient-related pattern" or "some pest activity" is too vague to act on — say WHICH one the pattern is consistent with, while keeping it a signal, not a confirmed diagnosis.

Agronomic tells to weigh:
- Foliage fullness: dense, full canopy with even coverage scores high; thin/sparse areas, bare stems, hedge gaps, or dieback score low.
- Leaf color & vigor: vibrant, even color and healthy new growth score high; yellowing, browning, bronzing, pale new growth, dull/uneven color, or leaf scorch score low.
- Pest-pressure SIGNALS: chewed leaves, stippling, webbing, scale-like bumps, sooty mold, whitefly-like residue, or distorted growth.
- Disease / leaf-spot SIGNALS: leaf spots, blight-like patterns, mildew-like residue, blackened foliage, spotting clusters, or disease-like discoloration.
- Water / heat / mechanical stress: wilt, crispy leaf margins, leaf drop, sun scorch, over-pruning, hedge scalping, broken branches, storm/mechanical damage, or standing water / wet-bed clues.

Write "observations" as ONE concise, plain-English paragraph for a homeowner — 2-3 sentences, no contradictions, no lists.

Return this exact JSON structure and nothing else — no markdown, no backticks, no preamble:
${VISION_JSON_SHAPE}`;


function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
const clampScore = (v) => (v == null ? null : Math.max(0, Math.min(100, Math.round(v))));

// Null/undefined/'' → null, never 0 (the Number(null) === 0 trap). Integer DB
// columns can legitimately hold 0, so only blank-ish values become null.
function tsScoreValue(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeSeverity(v) {
  const s = String(v || '').trim().toLowerCase();
  return SEVERITY_INDEX[s] != null ? s : 'none';
}

// ── Schema validation (mirrors lawn-assessment.js's isValidVisionScores) ────────
// Codex P1 (2026-09-24, #4730): a syntactically valid but incomplete/malformed
// response (e.g. `{}`, or a score outside 0-100) is still a truthy object —
// without this check it reads as a real result, skips the Claude fallback, and
// lets a missing field become a false "zero health" finding. Validates the
// VISION_PROMPT contract, i.e. VISION_RESULT_SCHEMA (which renders it).

// Models sometimes quote numbers ("82") or capitalize enums ("None"). Coerce
// those in place first so the validator rejects only genuinely missing or
// out-of-range fields, not formatting noise. Field lists come from
// VISION_RESULT_SCHEMA.
function normalizeTreeShrubScores(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  for (const field of NUMERIC_SCORE_FIELDS) {
    const v = parsed[field];
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) parsed[field] = Number(v);
  }
  for (const field of SEVERITY_SCORE_FIELDS) {
    if (typeof parsed[field] === 'string') parsed[field] = parsed[field].trim().toLowerCase();
  }
  return parsed;
}

// One provider reply against VISION_RESULT_SCHEMA — the same per-kind
// SCHEMA_VALIDATORS walk isCompleteVisionResult uses, so the provider gate
// (which decides the Claude fallback) and the admin lane's completeness gate
// can never disagree about what a valid reply is. Every schema field must be
// present and valid, including a real observations paragraph.
function isValidTreeShrubScores(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  return Object.entries(VISION_RESULT_SCHEMA)
    .every(([field, spec]) => SCHEMA_VALIDATORS[spec.kind](parsed[field], spec));
}

// Raw model scores → the five customer-facing 0-100 health categories.
function toCategoryScores(raw = {}) {
  const pest = normalizeSeverity(raw.pest_signals);
  const disease = normalizeSeverity(raw.disease_signals);
  const water = normalizeSeverity(raw.water_heat_stress);
  const pruning = normalizeSeverity(raw.pruning_mechanical);
  return {
    foliageFullness: clampScore(num(raw.foliage_fullness)),
    leafColorVigor: clampScore(num(raw.leaf_color_vigor)),
    pestActivity: SEVERITY_DISPLAY[pest],
    diseaseLeafSpot: SEVERITY_DISPLAY[disease],
    // Worst (lowest-health) of water/heat vs pruning/mechanical so one severe
    // stressor isn't diluted by a clean one.
    waterHeatStress: Math.min(SEVERITY_DISPLAY[water], SEVERITY_DISPLAY[pruning]),
  };
}

// Weighted overall — foliage + color carry the "is it thriving" read; the three
// signal categories pull it down when present. Average of available categories.
function calculateOverall(scores = {}) {
  const vals = ['foliageFullness', 'leafColorVigor', 'pestActivity', 'diseaseLeafSpot', 'waterHeatStress']
    .map((k) => num(scores[k])).filter((v) => v != null);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

// The typed form's landscape_condition suggested from the preview's 0-100
// overall, on the same 85/70/55 bands the customer report uses. Only the four
// score-derivable options are ever suggested — Declining / Recovering need
// visit history — and a visit with no score suggests nothing.
const LANDSCAPE_CONDITION_BY_BAND = { strong: 'Excellent', healthy: 'Good', watch: 'Fair', needs_attention: 'Poor' };
function suggestLandscapeCondition(overallScore) {
  return LANDSCAPE_CONDITION_BY_BAND[scoreStatus(overallScore)] || null;
}

// ── Vision API calls (mirror lawn-assessment.js) ────────────────────────────────

// GATE_TS_TECH_FINDINGS_COPY (owner 2026-10-01): photos are ground level, so the
// read may only describe what a whole-palm or oldest-fronds shot shows. Gate off
// = VISION_PROMPT exactly as before.
function visionPromptText(watchMonth = null) {
  let prompt = VISION_PROMPT;
  const marker = 'Return this exact JSON structure';
  if (techFindingsCopyLive()) {
    const rule = `${PALM_CROWN_PROMPT_RULE} In "observations", never call a palm's crown, spear leaf or newest fronds healthy, fine or normal; if only the crown is in view, say it is not clearly visible.`;
    prompt = prompt.replace(marker, `${rule}\n\n${marker}`);
  }
  // GATE_TS_WATCH_LIST: this month's watch list, and the optional watch_signals
  // field it asks for. Gate off, or no valid visit month = the prompt as above,
  // byte for byte. The field is not part of VISION_RESULT_SCHEMA, so it can
  // never make an otherwise valid read fail validation.
  const watchBlock = watchListLive() ? watchListPromptBlock(watchMonth) : '';
  if (watchBlock) {
    prompt = prompt.replace(marker, () => `${watchBlock}\n\n${marker}`);
    if (prompt.endsWith(VISION_JSON_SHAPE)) {
      prompt = `${prompt.slice(0, -2)},\n  "watch_signals": ["<watch-list key>"]\n}`;
    }
  }
  return prompt;
}

// GATE_TS_WATCH_LIST read at call time (strict opt-in, dark by default).
function watchListLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.tsWatchListLive === 'function' && gates.tsWatchListLive() === true;
}
// The visit month the watch list applies to: the gate on and a valid 1-12
// month, else null (every watch-list path then stays off).
function activeWatchMonth(month) {
  return watchListLive() ? validWatchMonth(month) : null;
}
async function callClaudeVision(base64Image, mimeType, watchMonth = null) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: MODELS.VISION,
      ...anthropicEffortConfig(MODELS.VISION),
      max_tokens: anthropicMaxTokens(MODELS.VISION, 500),
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
          { type: 'text', text: visionPromptText(watchMonth) },
        ],
      }],
    });
    const text = anthropicText(response);
    if (!text) { logger.warn('[tree-shrub-assessment] Claude returned empty content'); return null; }
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    normalizeTreeShrubScores(parsed);
    if (!isValidTreeShrubScores(parsed)) {
      logger.warn('[tree-shrub-assessment] Claude vision response failed schema validation');
      return null;
    }
    return parsed;
  } catch (err) {
    logger.error(`Tree-shrub assessment Claude vision failed: ${err.message}`);
    return null;
  }
}

async function geminiVisionAttempt(model, base64Image, mimeType, watchMonth = null) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: base64Image } }, { text: visionPromptText(watchMonth) }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }, // thinking spend counts against this ceiling (Gemini 3.x)
    }),
  });
  if (!response.ok) {
    logger.error(`Tree-shrub assessment Gemini API ${response.status} (${model}): ${response.statusText}`);
    return null;
  }
  const data = await response.json();
  const text = geminiText(data);
  if (!text) return null;
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  normalizeTreeShrubScores(parsed);
  if (!isValidTreeShrubScores(parsed)) {
    logger.warn(`Tree-shrub assessment Gemini vision response failed schema validation (${model})`);
    return null;
  }
  return parsed;
}

async function callGeminiVision(base64Image, mimeType, watchMonth = null) {
  if (!GEMINI_KEY) return null;
  const models = GEMINI_VISION_FALLBACK_MODEL && GEMINI_VISION_FALLBACK_MODEL !== GEMINI_VISION_MODEL
    ? [GEMINI_VISION_MODEL, GEMINI_VISION_FALLBACK_MODEL]
    : [GEMINI_VISION_MODEL];
  for (const model of models) {
    try {
      const parsed = await geminiVisionAttempt(model, base64Image, mimeType, watchMonth);
      if (parsed) return parsed;
    } catch (err) {
      logger.error(`Tree-shrub assessment Gemini vision failed (${model}): ${err.message}`);
    }
  }
  return null;
}

// Merge two raw model results: average the 0-100 fields, average the severity
// indices (rounded), and flag a divergence when the two disagree by 2+ levels.
function averageScores(claude, gemini) {
  const divergenceFlags = [];
  if (!claude && !gemini) return { composite: null, divergenceFlags };
  if (!claude) return { composite: gemini, divergenceFlags };
  if (!gemini) return { composite: claude, divergenceFlags };

  const composite = {};
  for (const f of NUMERIC_SCORE_FIELDS) {
    const c = num(claude[f]); const g = num(gemini[f]);
    if (c != null && g != null) {
      composite[f] = Math.round((c + g) / 2);
      if (Math.abs(c - g) > 20) divergenceFlags.push({ metric: f, claude: c, gemini: g, gap: Math.abs(c - g) });
    } else composite[f] = c ?? g;
  }
  for (const f of SEVERITY_SCORE_FIELDS) {
    // Mirror the numeric fields: a MISSING field (model omitted it) must not be
    // counted as a clean "none" read that averages a real signal down — use the
    // available model's value. An explicit "none" still counts as a real read.
    const cHas = claude[f] != null;
    const gHas = gemini[f] != null;
    const ci = SEVERITY_INDEX[normalizeSeverity(claude[f])];
    const gi = SEVERITY_INDEX[normalizeSeverity(gemini[f])];
    if (cHas && gHas) {
      composite[f] = SEVERITY_REVERSE[Math.round((ci + gi) / 2)];
      if (Math.abs(ci - gi) >= 2) divergenceFlags.push({ metric: f, claude: SEVERITY_REVERSE[ci], gemini: SEVERITY_REVERSE[gi], gap: Math.abs(ci - gi) });
    } else {
      composite[f] = SEVERITY_REVERSE[cHas ? ci : (gHas ? gi : 0)];
    }
  }
  // Gemini's prose wins the observations slot (owner 2026-07-21: on real
  // field photos Gemini produced the named-diagnosis specificity we want —
  // K-deficiency patterns, fungal genera, tomentum-vs-scale calls). Claude
  // stands in when Gemini has no read. Since 2026-09-24 analyzePhoto only
  // ever hands this function ONE result (Gemini, or Claude as its fallback)
  // — the both-present branch above only runs for a direct caller that passes
  // two results itself (e.g. dual-input unit tests); live scoring no longer
  // averages two models.
  composite.observations = (gemini?.observations || claude?.observations || '').trim();
  return { composite, divergenceFlags };
}

/**
 * True when an analyzePhoto result satisfies VISION_RESULT_SCHEMA: for EVERY
 * schema field, at least one provider returned it, and every provider that
 * returned it passes that field kind's validator. One generic walk over the
 * schema — no per-field checks. averageScores fills a field both providers
 * omitted with "none" (a clean 95) and falls back to "" observations, so
 * completeness is judged on the raw provider results, not the composite.
 * "Present" matches averageScores (!= null): a blank string IS a reading
 * there, so it is judged (and fails) here, not skipped. Callers that must not
 * persist a silently-defaulted read (the admin assessment lane) gate on this.
 * Since 2026-09-24 analyzePhoto hands back ONE provider's read that already
 * passed isValidTreeShrubScores (the same schema walk), so for live results
 * this is belt-and-braces; it still guards any other result shape.
 */
function isCompleteVisionResult(result) {
  if (!result || !result.composite) return false;
  const readings = [result.claude, result.gemini].filter(Boolean);
  return Object.entries(VISION_RESULT_SCHEMA).every(([field, spec]) => {
    const present = readings.map((raw) => raw[field]).filter((value) => value != null);
    return present.length > 0 && present.every((value) => SCHEMA_VALIDATORS[spec.kind](value, spec));
  });
}

/**
 * Analyze one photo with Gemini vision — Gemini-only per owner ruling
 * 2026-09-24 (no more Claude+Gemini averaging/fan-out). Claude runs ONLY as a
 * fallback when Gemini returns nothing (empty/error/schema-invalid).
 * GATE_TS_WATCH_LIST: an optional third argument { month } (the visit's month,
 * 1-12, America/New_York) adds this month's watch list to the prompt and a
 * `watchSignals` array (known keys on that month's list, list order) to the
 * result. Gate off, or no valid month = the call and the result as before.
 * @returns {Promise<{claude, gemini, composite, divergenceFlags, watchSignals?}|null>}
 */
async function analyzePhoto(base64Image, mimeType = 'image/jpeg', options = {}) {
  const watchMonth = activeWatchMonth(options && options.month);
  const gemini = await callGeminiVision(base64Image, mimeType, watchMonth);
  const claude = gemini ? null : await callClaudeVision(base64Image, mimeType, watchMonth);
  if (!claude && !gemini) return null;
  const { composite, divergenceFlags } = averageScores(claude, gemini);
  if (!watchMonth) return { claude, gemini, composite, divergenceFlags };
  // The raw field comes off the reads so it never rides into a stored composite.
  const read = gemini || claude;
  const watchSignals = normalizeWatchSignals(read.watch_signals, watchMonth);
  delete read.watch_signals;
  return { claude, gemini, composite, divergenceFlags, watchSignals };
}

// ── Tech-facing findings (exception-based closeout) ─────────────────────────────

const { buildTreeShrubVisualCategories, scoreStatus } = require('./service-report/tree-shrub-visual-categories');

// Per-category tech-facing copy for a FLAGGED (watch/attention) signal. Stays in
// "signals" language — the tech confirms before we ever assert a pest/disease.
// Labels live with the frozen tech decisions (one name per finding).
const FINDING_META = {
  pest_activity: { label: TECH_FINDING_LABELS.pest_activity, flagged: 'Possible pest-pressure signals on foliage.' },
  disease_leaf_spot: { label: TECH_FINDING_LABELS.disease_leaf_spot, flagged: 'Possible leaf-spot or disease-like signals.' },
  water_heat_mechanical_stress: { label: TECH_FINDING_LABELS.water_heat_mechanical_stress, flagged: 'Visible water, heat, or pruning stress.' },
  leaf_color_vigor: { label: TECH_FINDING_LABELS.leaf_color_vigor, flagged: 'Some off-color, pale, or yellowing foliage.' },
  foliage_fullness: { label: TECH_FINDING_LABELS.foliage_fullness, flagged: 'Some thin, sparse, or bare areas.' },
};

/**
 * Derive the exception-based closeout findings the tech reviews from the AI scores —
 * one card per flagged (watch/attention) category, plus a one-line AI summary and a
 * suggested customer action. Default per-finding action is 'monitor'; the tech can
 * confirm / hide / edit each. No flags → a clean "no urgent issues" closeout.
 *
 * @param {object} input.scores       { foliageFullness, leafColorVigor, pestActivity, diseaseLeafSpot, waterHeatStress }
 * @param {string} [input.observations]
 * @returns {{ aiSummary, suggestedCustomerAction, findings: Array }}
 */
function buildTreeShrubTechFindings({ scores = {}, observations = '' } = {}) {
  const cats = buildTreeShrubVisualCategories({ scores });
  const findings = cats
    .filter((c) => c.status === 'watch' || c.status === 'needs_attention')
    .map((c) => ({
      key: c.key,
      label: (FINDING_META[c.key] && FINDING_META[c.key].label) || c.label,
      status: c.status === 'needs_attention' ? 'attention' : 'watch',
      detail: (FINDING_META[c.key] && FINDING_META[c.key].flagged) || c.customerExplanation,
      score: c.score,
      defaultAction: 'monitor', // monitor | confirm | hide
    }));
  // codex GH r2 (cloud) P1: a 'tracking' category (the score was never
  // reported by either model — see photo-id.js's treeShrubFieldEverReported)
  // is not a "finding" (it isn't flagged), but it is also not a clean read —
  // "No urgent issues" tells the customer every dimension was checked and
  // came back healthy, which is false for a dimension that was never
  // assessed at all. Say so instead whenever any category is still
  // tracking, even though nothing was flagged.
  const trackingCount = cats.filter((c) => c.status === 'tracking').length;
  const aiSummary = findings.length
    ? `AI flagged ${findings.length} item${findings.length > 1 ? 's' : ''} to review.`
    : trackingCount > 0
      ? "We couldn't get a clear enough read on every area from these photos."
      : 'No urgent visible plant issues found.';
  const suggestedCustomerAction = findings.length
    ? 'Monitor the flagged areas; we’ll recheck on the next visit.'
    : trackingCount > 0
      ? 'Send clearer photos of every area and we can take another look.'
      : 'No action needed';
  return {
    aiSummary, suggestedCustomerAction, findings, trackingCount,
  };
}

/**
 * Customer-facing report for the customer Photo ID API (server/routes/photo-id.js).
 * Reduces a preview/assessment-like `{ scores, observations, aiSummary, plantGroups }`
 * shape (camelCase scores — previewTreeShrubAssessment's own return shape, or
 * formatAssessmentScores(row) + row fields for a stored assessment) to the
 * customer-safe contract: three "signals" (never a confirmed diagnosis — see the
 * module guardrail) plus two health scores and an overall. `plant_groups` stays
 * empty unless the caller supplies plantGroups (a single-shot photo-id submission
 * has no plant inventory).
 */
function buildCustomerTreeShrubReport(assessmentLike = {}) {
  const scores = assessmentLike.scores || {};
  const categories = buildTreeShrubVisualCategories({ scores });
  const byKey = {};
  for (const cat of categories) byKey[cat.key] = cat;

  const SIGNAL_KEYS = ['pest_activity', 'disease_leaf_spot', 'water_heat_mechanical_stress'];
  const signals = SIGNAL_KEYS.filter((key) => byKey[key]).map((key) => ({
    key,
    label: byKey[key].label,
    level: byKey[key].status, // strong | healthy | watch | needs_attention | tracking
  }));

  const plantGroups = Array.isArray(assessmentLike.plantGroups) ? assessmentLike.plantGroups : [];

  return {
    plant_groups: plantGroups.map((g) => ({
      label: (g && (g.label || g.key)) || 'Plant group',
      status: (g && g.status) || 'tracking',
    })),
    scores: {
      foliage_fullness: byKey.foliage_fullness ? byKey.foliage_fullness.score : null,
      leaf_color_vigor: byKey.leaf_color_vigor ? byKey.leaf_color_vigor.score : null,
      overall: scores.overallScore != null ? scores.overallScore : null,
    },
    signals,
    summary: assessmentLike.aiSummary
      || (assessmentLike.observations ? String(assessmentLike.observations).slice(0, 500) : 'No urgent visible plant issues found.'),
  };
}

// ── Scoring + persistence (auto-score at completion) ────────────────────────────

// Merge several per-photo raw composites into ONE assessment-level raw result.
// Numeric fields (foliage/color) average; signal severities take the WORST across
// photos so a trouble-spot photo can't be hidden by clean overview shots. Keeps the
// first non-empty observations paragraph.
function mergePhotoComposites(composites = []) {
  const list = composites.filter(Boolean);
  if (!list.length) return null;
  const merged = {};
  for (const f of NUMERIC_SCORE_FIELDS) {
    const vals = list.map((c) => num(c[f])).filter((v) => v != null);
    merged[f] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }
  for (const f of SEVERITY_SCORE_FIELDS) {
    const worst = Math.max(...list.map((c) => SEVERITY_INDEX[normalizeSeverity(c[f])]));
    merged[f] = SEVERITY_REVERSE[worst];
  }
  merged.observations = (list.map((c) => (c.observations || '').trim()).find(Boolean)) || '';
  return merged;
}

/**
 * Score a tree_shrub visit's photos with dual-vision and persist a
 * tree_shrub_assessments row (+ per-photo rows). Decoupled from storage: the caller
 * injects `loadImage(photo) → { base64, mimeType }` so this is unit-testable and the
 * S3 fetch lives in the route. Best-effort: returns null (never throws) so a scoring
 * hiccup can never break visit completion.
 *
 * @param {object}   input.service     { id (service_record_id), customer_id, service_id|scheduled_service_id, technician_id, service_date }
 * @param {Array}    input.photos      [{ s3Key|url, caption, zone, takenAt, qualityScore }]
 * @param {function} input.loadImage   async (photo) => { base64, mimeType } | null
 * @param {boolean}  [input.autoConfirm=true]  confirm into the report immediately (copy is signal-safe); pest/disease stay "signals" until tech-confirmed
 * @returns {Promise<{assessmentId, scores}|null>}
 */
// Idempotency guard: a completion can resume after the durable commit (e.g. a later
// SMS/PDF side effect fails), re-running the fire-and-forget scoring block. Without
// this, the retry would insert a SECOND confirmed assessment for the same visit and
// pollute history/trends. Returns the existing assessment id, or null if none yet.
async function findExistingAssessment(service, knex = db) {
  if (!service || !service.id) return null;
  const row = await knex('tree_shrub_assessments')
    .where({ service_record_id: service.id })
    .first('id')
    .catch(() => null);
  return row ? (row.id || row) : null;
}

async function scoreAndStoreTreeShrubAssessment({
  service = {},
  photos = [],
  loadImage,
  analyze = analyzePhoto,
  knex = db,
  autoConfirm = true,
  season = null,
} = {}) {
  try {
    if (!service.customer_id || !Array.isArray(photos) || !photos.length || typeof loadImage !== 'function') {
      return null;
    }
    // Skip BEFORE the paid vision scoring if this visit already has an assessment.
    const existing = await findExistingAssessment(service, knex);
    if (existing) return { assessmentId: existing, alreadyExists: true };

    // Score each photo (parallel); keep the raw composite + its category scores.
    const scored = await Promise.all(photos.map(async (photo) => {
      try {
        const img = await loadImage(photo);
        if (!img || !img.base64) return null;
        const result = await analyze(img.base64, img.mimeType || 'image/jpeg');
        if (!result || !result.composite) return null;
        return { photo, raw: result.composite, scores: toCategoryScores(result.composite) };
      } catch { return null; }
    }));
    const ok = scored.filter(Boolean);
    if (!ok.length) return null; // nothing scored → don't create an empty assessment

    const mergedRaw = mergePhotoComposites(ok.map((s) => s.raw));
    const scores = toCategoryScores(mergedRaw);
    const overall = calculateOverall(scores);

    // Best photo: highest per-photo overall, else the first.
    let bestIdx = 0;
    let bestOverall = -1;
    ok.forEach((s, i) => {
      const o = calculateOverall(s.scores);
      if (o != null && o > bestOverall) { bestOverall = o; bestIdx = i; }
    });

    const now = new Date();
    const [inserted] = await knex('tree_shrub_assessments').insert({
      customer_id: service.customer_id,
      technician_id: service.technician_id || null,
      service_id: service.scheduled_service_id || service.service_id || null,
      service_record_id: service.id || null,
      service_date: service.service_date || now,
      season: season || null,
      photos: JSON.stringify(photos.map((p) => ({ url: p.url || null, s3_key: p.s3Key || p.s3_key || null, caption: p.caption || null }))),
      composite_scores: JSON.stringify(mergedRaw),
      foliage_fullness: scores.foliageFullness,
      leaf_color_vigor: scores.leafColorVigor,
      pest_activity: scores.pestActivity,
      disease_leaf_spot: scores.diseaseLeafSpot,
      water_heat_stress: scores.waterHeatStress,
      overall_score: overall,
      observations: mergedRaw.observations || '',
      ai_summary: mergedRaw.observations || '',
      confirmed_by_tech: !!autoConfirm,
      confirmed_at: autoConfirm ? now : null,
    }).returning('id');
    const assessmentId = inserted && (inserted.id || inserted);
    if (!assessmentId) return null;

    await Promise.all(ok.map((s, i) => knex('tree_shrub_assessment_photos').insert({
      assessment_id: assessmentId,
      customer_id: service.customer_id,
      s3_key: s.photo.s3Key || s.photo.s3_key || null,
      url: s.photo.url || null,
      caption: s.photo.caption || null,
      zone: s.photo.zone || null,
      photo_order: i,
      foliage_fullness: s.scores.foliageFullness,
      leaf_color_vigor: s.scores.leafColorVigor,
      pest_activity: s.scores.pestActivity,
      disease_leaf_spot: s.scores.diseaseLeafSpot,
      water_heat_stress: s.scores.waterHeatStress,
      observations: s.raw.observations || '',
      quality_score: s.photo.qualityScore ?? 50,
      is_best_photo: i === bestIdx,
      customer_visible: true,
      taken_at: s.photo.takenAt || null,
    }).catch(() => null)));

    return { assessmentId, scores, overallScore: overall };
  } catch (err) {
    logger.error(`[tree-shrub-assessment] scoreAndStore failed: ${err.message}`);
    return null;
  }
}

// ── Tech-reviewed persistence (CompletionPanel confirm/hide/edit) ───────────────

const REVIEW_CAT_KEY = {
  foliage_fullness: 'foliageFullness',
  leaf_color_vigor: 'leafColorVigor',
  pest_activity: 'pestActivity',
  disease_leaf_spot: 'diseaseLeafSpot',
  water_heat_mechanical_stress: 'waterHeatStress',
};

// Apply the tech's per-finding decisions to the AI scores. The closeout is a
// keep-vs-hide review, NOT a formal pest/disease identification — so "Confirm
// monitor" deliberately does NOT escalate the report to confirmed-diagnosis
// language (guardrail: signals, never confirmed pest/disease). It only keeps the
// finding as a monitored signal; "hide" leaves the category unassessed.
// A rejected signal is not evidence of healthy plants. Every decision and the
// original scores are preserved in composite_scores for audit.
//  - hide    → omit that score and its influenced overall.
//  - confirm → keep monitoring (no report escalation, no confirmed-diagnosis copy).
//  - edit    → captured (detail) for audit; customer copy stays system-generated.
function applyReviewDecisions(scores = {}, decisions = []) {
  const s = { ...scores };
  let hasHidden = false;
  for (const d of Array.isArray(decisions) ? decisions : []) {
    if (!d || !Object.hasOwn(REVIEW_CAT_KEY, d.key)) continue;
    const k = REVIEW_CAT_KEY[d.key];
    if (d.action === 'hidden') {
      s[k] = null;
      hasHidden = true;
    }
  }
  if (hasHidden) s.overallScore = null;
  return { scores: s, hasHidden };
}

/**
 * Persist a tree_shrub assessment from a TECH-REVIEWED closeout (the AI already
 * scored the photos at the preview step, so this does NOT call vision again). The
 * tech's confirm/hide/edit decisions are applied to the scores. Best-effort.
 *
 * @param {object} input.service     same shape as scoreAndStoreTreeShrubAssessment
 * @param {object} input.scores      the AI preview scores { foliageFullness, ... }
 * @param {Array}  input.decisions   [{ key, action:'monitor'|'confirmed'|'hidden', detail }]
 * @param {Array}  input.photos      uploaded photo rows [{ s3_key, url, caption, zone, qualityScore }]
 * @param {string} [input.observations]
 * @returns {Promise<{assessmentId, scores}|null>}
 */
async function storeTreeShrubAssessmentFromReview({
  service = {},
  scores = {},
  decisions = [],
  photos = [],
  observations = '',
  knex = db,
  season = null,
} = {}) {
  try {
    if (!service.customer_id) return null;
    const existing = await findExistingAssessment(service, knex);
    if (existing) return { assessmentId: existing, alreadyExists: true };
    const { scores: final, hasHidden } = applyReviewDecisions(scores, decisions);
    const overall = hasHidden ? null : calculateOverall(final);
    const now = new Date();

    // If the tech HID any finding, the AI free-text observation was generated from
    // signals that include the hidden one — drop it so the photo summary can't
    // contradict the hide. The deterministic diagnosis/insight copy still carries the report.
    const safeObs = hasHidden ? '' : (observations || '');

    const [inserted] = await knex('tree_shrub_assessments').insert({
      customer_id: service.customer_id,
      technician_id: service.technician_id || null,
      service_id: service.scheduled_service_id || service.service_id || null,
      service_record_id: service.id || null,
      service_date: service.service_date || now,
      season: season || null,
      composite_scores: JSON.stringify({ ai: scores, reviewed: decisions || [] }),
      foliage_fullness: num(final.foliageFullness),
      leaf_color_vigor: num(final.leafColorVigor),
      pest_activity: num(final.pestActivity),
      disease_leaf_spot: num(final.diseaseLeafSpot),
      water_heat_stress: num(final.waterHeatStress),
      overall_score: overall,
      observations: safeObs,
      ai_summary: safeObs,
      // Closeout review keeps signal language — never a formal confirmed diagnosis.
      tech_confirmed_pest: false,
      tech_confirmed_disease: false,
      confirmed_by_tech: true,
      confirmed_at: now,
    }).returning('id');
    const assessmentId = inserted && (inserted.id || inserted);
    if (!assessmentId) return null;

    await Promise.all((Array.isArray(photos) ? photos : []).map((p, i) => knex('tree_shrub_assessment_photos').insert({
      assessment_id: assessmentId,
      customer_id: service.customer_id,
      s3_key: p.s3_key || p.s3Key || null,
      url: p.url || null,
      caption: p.caption || null,
      zone: p.zone || null,
      photo_order: i,
      quality_score: p.qualityScore ?? p.quality_score ?? 60,
      is_best_photo: i === 0,
      customer_visible: true,
    }).catch(() => null)));

    return { assessmentId, scores: final };
  } catch (err) {
    logger.error(`[tree-shrub-assessment] storeFromReview failed: ${err.message}`);
    return null;
  }
}

/**
 * Score photos for the closeout PREVIEW (no persistence). Returns the merged
 * scores + the tech-facing findings the closeout UI renders. Decoupled from storage
 * via the injected loadImage; analyze is injectable for tests.
 *
 * @returns {Promise<{ scores, aiSummary, suggestedCustomerAction, findings }|null>}
 */
async function previewTreeShrubAssessment({
  photos = [], loadImage, analyze = analyzePhoto, month = null,
} = {}) {
  if (!Array.isArray(photos) || !photos.length || typeof loadImage !== 'function') return null;
  // GATE_TS_WATCH_LIST: the visit's month. Off or invalid = analyze is called
  // with exactly the two arguments it always was.
  const watchMonth = activeWatchMonth(month);
  const reads = (await Promise.all(photos.map(async (photo) => {
    try {
      const img = await loadImage(photo);
      if (!img || !img.base64) return null;
      const result = watchMonth
        ? await analyze(img.base64, img.mimeType || 'image/jpeg', { month: watchMonth })
        : await analyze(img.base64, img.mimeType || 'image/jpeg');
      return result && result.composite ? { composite: result.composite, watchSignals: result.watchSignals } : null;
    } catch { return null; }
  }))).filter(Boolean);
  const composites = reads.map((read) => read.composite);
  if (!composites.length) return null;
  const mergedRaw = mergePhotoComposites(composites);
  const scores = toCategoryScores(mergedRaw);
  scores.overallScore = calculateOverall(scores);
  // scoredCount/photoCount let the completion handler detect a preview that skipped a
  // photo (a vision call failed) and fall back to server re-scoring of the full set.
  return {
    scores,
    observations: mergedRaw.observations || '',
    scoredCount: composites.length,
    photoCount: photos.length,
    ...buildTreeShrubTechFindings({ scores, observations: mergedRaw.observations }),
    // GATE_TS_WATCH_LIST: the signals any photo showed, in list order. Carried
    // for the sheet only; no score reads it.
    ...(watchMonth ? { watchSignals: normalizeWatchSignals(reads.flatMap((read) => read.watchSignals || []), watchMonth) } : {}),
  };
}

// ── Report loader ───────────────────────────────────────────────────────────────

async function photoUrl(photo) {
  // Presign from the S3 key FIRST — a stored photo.url can be a stale
  // presign from write time and 403 later; the stored URL only remains as
  // the fallback for legacy rows that never got a key.
  if (photo.s3_key && PhotoService && !String(photo.s3_key).startsWith('pending/')) {
    try {
      return await PhotoService.getViewUrl(photo.s3_key, PhotoService.CUSTOMER_DWELL_TTL_SECONDS);
    } catch {
      /* fall through to the stored URL */
    }
  }
  return photo.url || null;
}

function formatAssessmentScores(row) {
  if (!row) return null;
  let composite = row.composite_scores;
  if (typeof composite === 'string') {
    try { composite = JSON.parse(composite); } catch { composite = null; }
  }
  // Reapply stored decisions for older assessments whose hidden metrics were
  // saved as healthy scores. This also governs every historical trend point.
  const { scores, hasHidden } = applyReviewDecisions({
    foliageFullness: tsScoreValue(row.foliage_fullness),
    leafColorVigor: tsScoreValue(row.leaf_color_vigor),
    pestActivity: tsScoreValue(row.pest_activity),
    diseaseLeafSpot: tsScoreValue(row.disease_leaf_spot),
    waterHeatStress: tsScoreValue(row.water_heat_stress),
    overallScore: tsScoreValue(row.overall_score),
  }, composite?.reviewed);
  return { ...scores, overallScore: hasHidden ? null : scores.overallScore ?? calculateOverall(scores) };
}

// Link an assessment to THIS visit (by service record, then scheduled service).
// No customer-wide fallback — a visit only shows an assessment that is its own.
async function loadLinkedTreeShrubAssessment(service, knex = db) {
  if (!service?.customer_id) return null;
  const base = { customer_id: service.customer_id, confirmed_by_tech: true };
  const byRecord = service.id
    ? await knex('tree_shrub_assessments').where({ ...base, service_record_id: service.id })
      .orderBy('confirmed_at', 'desc').orderBy('created_at', 'desc').first().catch(() => null)
    : null;
  if (byRecord) return byRecord;
  const scheduledServiceId = service.scheduled_service_id || service.service_id;
  const byService = scheduledServiceId
    ? await knex('tree_shrub_assessments').where({ ...base, service_id: scheduledServiceId })
      .orderBy('confirmed_at', 'desc').orderBy('created_at', 'desc').first().catch(() => null)
    : null;
  return byService || null;
}

/**
 * Build the `treeShrubAssessment` payload buildTreeShrubReportV2 consumes from the
 * visit's stored, tech-confirmed assessment. Returns null when this visit has none.
 */
async function buildTreeShrubAssessmentReportData(service, serviceLine, knex = db) {
  if (serviceLine !== 'tree_shrub') return null;
  const assessment = await loadLinkedTreeShrubAssessment(service, knex);
  if (!assessment) return null;

  // Trend: all confirmed assessments up to and including this one.
  const allRows = await knex('tree_shrub_assessments')
    .where({ customer_id: service.customer_id, confirmed_by_tech: true })
    .orderBy('service_date', 'asc').orderBy('created_at', 'asc')
    .catch(() => []);
  const idx = allRows.findIndex((r) => String(r.id) === String(assessment.id));
  const historyRows = idx >= 0 ? allRows.slice(0, idx + 1) : allRows;

  const photoRows = await knex('tree_shrub_assessment_photos')
    .where({ assessment_id: assessment.id, customer_visible: true })
    .orderBy('is_best_photo', 'desc').orderBy('quality_score', 'desc').orderBy('photo_order', 'asc')
    .limit(8)
    .catch(() => []);
  const photos = await Promise.all(photoRows.map(async (p) => ({
    url: await photoUrl(p),
    label: p.zone || null,
    zone: p.zone || null,
    caption: p.caption || null,
    isBest: !!p.is_best_photo,
    qualityScore: p.quality_score ?? null,
  })));
  // Photos that EXIST on the assessment but whose URL would not sign are
  // dropped here — an omission the report can never observe downstream
  // (codex P2 #3176 r22). Report the count so the payload's cacheability
  // gate can refuse to cache a silently incomplete PDF.
  const droppedPhotoCount = photos.filter((p) => !p.url).length;
  const visiblePhotos = photos.filter((p) => p.url);

  // GATE_TS_TECH_FINDINGS_COPY: a visit whose preview was rejected and re-scored
  // keeps its hide decisions only in the service record's frozen findings, so
  // history applies each visit's own (one read, current visit included).
  const gateOn = techFindingsCopyLive();
  const frozenByRecord = gateOn ? await loadFrozenTechFindingsByRecord(historyRows, knex) : null;
  // The read FAILED (not "no decisions"): an earlier visit's hides are unknown,
  // so its scores are withheld rather than republished, and the artifact is
  // flagged so no PDF caches it. The current visit's own decisions are in the
  // service record the report builder already holds.
  const techFindingsUnavailable = gateOn && frozenByRecord === null;
  const withFrozenHides = (row, formatted) => {
    if (!gateOn) return formatted;
    if (techFindingsUnavailable) return String(row.id) === String(assessment.id) ? formatted : withholdScores(formatted);
    return hideFrozenFindingsInScores(formatted, frozenByRecord.get(String(row.service_record_id)));
  };
  const scores = withFrozenHides(assessment, formatAssessmentScores(assessment));
  const trend = historyRows.map((r) => {
    const s = withFrozenHides(r, formatAssessmentScores(r));
    return {
      date: r.service_date,
      overallScore: s.overallScore,
      foliageFullness: s.foliageFullness,
      leafColorVigor: s.leafColorVigor,
      pestActivity: s.pestActivity,
      waterHeatStress: s.waterHeatStress,
    };
  });

  let plantGroups = [];
  try {
    plantGroups = Array.isArray(assessment.plant_groups)
      ? assessment.plant_groups
      : JSON.parse(assessment.plant_groups || '[]');
  } catch { plantGroups = []; }

  return {
    assessmentId: assessment.id,
    assessmentDate: assessment.service_date,
    scores,
    observations: assessment.observations || '',
    aiSummary: assessment.ai_summary || null,
    photos: visiblePhotos,
    droppedPhotoCount,
    ...(techFindingsUnavailable ? { techFindingsUnavailable: true } : {}),
    plantGroups,
    trend,
    techConfirmedPest: !!assessment.tech_confirmed_pest,
    techConfirmedDisease: !!assessment.tech_confirmed_disease,
  };
}

module.exports = {
  VISION_PROMPT,
  visionPromptText,
  SEVERITY_DISPLAY,
  VISION_RESULT_SCHEMA,
  SCHEMA_PROMPT_SHAPES,
  SCHEMA_VALIDATORS,
  OBSERVATIONS_MIN_LENGTH,
  NUMERIC_SCORE_FIELDS,
  SEVERITY_SCORE_FIELDS,
  isCompleteVisionResult,
  toCategoryScores,
  calculateOverall,
  suggestLandscapeCondition,
  averageScores,
  isValidTreeShrubScores,
  normalizeTreeShrubScores,
  analyzePhoto,
  treeShrubReviewSignature,
  treeShrubPhotosHash,
  validateTreeShrubReviewForReport,
  buildTreeShrubTechFindings,
  mergePhotoComposites,
  buildCustomerTreeShrubReport,
  scoreAndStoreTreeShrubAssessment,
  applyReviewDecisions,
  storeTreeShrubAssessmentFromReview,
  previewTreeShrubAssessment,
  formatAssessmentScores,
  loadLinkedTreeShrubAssessment,
  buildTreeShrubAssessmentReportData,
};
