/**
 * Tree & Shrub Health Assessment Service
 *
 * Dual-vision analysis (Claude + Gemini) that scores landscape-plant health from
 * the visit's tree/shrub photos, mirroring lawn-assessment.js. Produces the five
 * customer-facing diagnosis categories as 0-100 "health" scores (higher = healthier
 * / fewer problem signals), persists a tree_shrub_assessments row, and exposes the
 * report loader (buildTreeShrubAssessmentReportData) that shapes a stored assessment
 * into the payload buildTreeShrubReportV2 consumes.
 *
 * GUARDRAIL: the vision models rate the SEVERITY of visible signals (none → severe);
 * we never ask them to "confirm" a pest or disease. Severity → health score is a
 * deterministic ramp, and the report copy says "signals", never "infestation"/"diseased"
 * unless a tech confirms it (tech_confirmed_pest / tech_confirmed_disease).
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');

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

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

// Presigner for S3-backed photos (same view-URL helper the lawn report uses).
let PhotoService = null;
try { PhotoService = require('./photos'); } catch { PhotoService = null; }

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || MODELS.GEMINI_VISION_BEST;
const GEMINI_VISION_FALLBACK_MODEL = process.env.GEMINI_VISION_FALLBACK_MODEL || 'gemini-2.5-flash';

const VISION_PROMPT = `You are a tree & shrub (landscape ornamental) plant-health assessment tool for a professional lawn & pest company in Southwest Florida. Analyze the provided photo of shrubs, hedges, palms, trees, or landscape beds and return ONLY a JSON object with the scores below. Base your analysis strictly on what is visible.

You flag SIGNALS, never a confirmed diagnosis. Report pest-pressure and disease-like SIGNALS — never assert an "infestation" or a confirmed "disease".

Agronomic tells to weigh:
- Foliage fullness: dense, full canopy with even coverage scores high; thin/sparse areas, bare stems, hedge gaps, or dieback score low.
- Leaf color & vigor: vibrant, even color and healthy new growth score high; yellowing, browning, bronzing, pale new growth, dull/uneven color, or leaf scorch score low.
- Pest-pressure SIGNALS: chewed leaves, stippling, webbing, scale-like bumps, sooty mold, whitefly-like residue, or distorted growth.
- Disease / leaf-spot SIGNALS: leaf spots, blight-like patterns, mildew-like residue, blackened foliage, spotting clusters, or disease-like discoloration.
- Water / heat / mechanical stress: wilt, crispy leaf margins, leaf drop, sun scorch, over-pruning, hedge scalping, broken branches, storm/mechanical damage, or standing water / wet-bed clues.

Write "observations" as ONE concise, plain-English paragraph for a homeowner — 2-3 sentences, no contradictions, no lists.

Return this exact JSON structure and nothing else — no markdown, no backticks, no preamble:
{
  "foliage_fullness": <number 0-100>,
  "leaf_color_vigor": <number 0-100>,
  "pest_signals": <"none" | "minor" | "moderate" | "severe">,
  "disease_signals": <"none" | "minor" | "moderate" | "severe">,
  "water_heat_stress": <"none" | "minor" | "moderate" | "severe">,
  "pruning_mechanical": <"none" | "minor" | "moderate" | "severe">,
  "observations": "<one concise paragraph>"
}`;

// Severity word → 0-100 "health" display (higher = healthier). Same ramp as the
// lawn scorer's FUNGUS_DISPLAY so the two reports agree on how a signal reads.
const SEVERITY_DISPLAY = { none: 95, minor: 75, moderate: 50, severe: 20 };
const SEVERITY_INDEX = { none: 0, minor: 1, moderate: 2, severe: 3 };
const SEVERITY_REVERSE = ['none', 'minor', 'moderate', 'severe'];

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

// ── Vision API calls (mirror lawn-assessment.js) ────────────────────────────────
async function callClaudeVision(base64Image, mimeType) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: MODELS.VISION,
      max_tokens: 500,
      temperature: 0.2,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
          { type: 'text', text: VISION_PROMPT },
        ],
      }],
    });
    const text = response.content?.[0]?.text;
    if (!text) { logger.warn('[tree-shrub-assessment] Claude returned empty content'); return null; }
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (err) {
    logger.error(`Tree-shrub assessment Claude vision failed: ${err.message}`);
    return null;
  }
}

async function geminiVisionAttempt(model, base64Image, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mimeType, data: base64Image } }, { text: VISION_PROMPT }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
    }),
  });
  if (!response.ok) {
    logger.error(`Tree-shrub assessment Gemini API ${response.status} (${model}): ${response.statusText}`);
    return null;
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

async function callGeminiVision(base64Image, mimeType) {
  if (!GEMINI_KEY) return null;
  const models = GEMINI_VISION_FALLBACK_MODEL && GEMINI_VISION_FALLBACK_MODEL !== GEMINI_VISION_MODEL
    ? [GEMINI_VISION_MODEL, GEMINI_VISION_FALLBACK_MODEL]
    : [GEMINI_VISION_MODEL];
  for (const model of models) {
    try {
      const parsed = await geminiVisionAttempt(model, base64Image, mimeType);
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
  for (const f of ['foliage_fullness', 'leaf_color_vigor']) {
    const c = num(claude[f]); const g = num(gemini[f]);
    if (c != null && g != null) {
      composite[f] = Math.round((c + g) / 2);
      if (Math.abs(c - g) > 20) divergenceFlags.push({ metric: f, claude: c, gemini: g, gap: Math.abs(c - g) });
    } else composite[f] = c ?? g;
  }
  for (const f of ['pest_signals', 'disease_signals', 'water_heat_stress', 'pruning_mechanical']) {
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
  composite.observations = (claude.observations || gemini.observations || '').trim();
  return { composite, divergenceFlags };
}

/**
 * Analyze one photo with both vision models in parallel.
 * @returns {Promise<{claude, gemini, composite, divergenceFlags}|null>}
 */
async function analyzePhoto(base64Image, mimeType = 'image/jpeg') {
  const [claudeResult, geminiResult] = await Promise.allSettled([
    callClaudeVision(base64Image, mimeType),
    callGeminiVision(base64Image, mimeType),
  ]);
  const claude = claudeResult.status === 'fulfilled' ? claudeResult.value : null;
  const gemini = geminiResult.status === 'fulfilled' ? geminiResult.value : null;
  if (!claude && !gemini) return null;
  const { composite, divergenceFlags } = averageScores(claude, gemini);
  return { claude, gemini, composite, divergenceFlags };
}

// ── Tech-facing findings (exception-based closeout) ─────────────────────────────

const { buildTreeShrubVisualCategories } = require('./service-report/tree-shrub-visual-categories');

// Per-category tech-facing copy for a FLAGGED (watch/attention) signal. Stays in
// "signals" language — the tech confirms before we ever assert a pest/disease.
const FINDING_META = {
  pest_activity: { label: 'Pest-pressure signals', flagged: 'Possible pest-pressure signals on foliage.' },
  disease_leaf_spot: { label: 'Leaf-spot / disease signals', flagged: 'Possible leaf-spot or disease-like signals.' },
  water_heat_mechanical_stress: { label: 'Water / heat / pruning stress', flagged: 'Visible water, heat, or pruning stress.' },
  leaf_color_vigor: { label: 'Leaf color & vigor', flagged: 'Some off-color, pale, or yellowing foliage.' },
  foliage_fullness: { label: 'Foliage fullness', flagged: 'Some thin, sparse, or bare areas.' },
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
  const aiSummary = findings.length
    ? `AI flagged ${findings.length} item${findings.length > 1 ? 's' : ''} to review.`
    : 'No urgent visible plant issues found.';
  const suggestedCustomerAction = findings.length
    ? 'Monitor the flagged areas; we’ll recheck on the next visit.'
    : 'No action needed';
  return { aiSummary, suggestedCustomerAction, findings };
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
  for (const f of ['foliage_fullness', 'leaf_color_vigor']) {
    const vals = list.map((c) => num(c[f])).filter((v) => v != null);
    merged[f] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }
  for (const f of ['pest_signals', 'disease_signals', 'water_heat_stress', 'pruning_mechanical']) {
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
// finding as a monitored signal; "hide" lifts a false-read category out of the
// flagging band. Every decision is preserved in composite_scores for audit.
//  - hide    → false read; lift that category so the report doesn't surface it.
//  - confirm → keep monitoring (no report escalation, no confirmed-diagnosis copy).
//  - edit    → captured (detail) for audit; customer copy stays system-generated.
function applyReviewDecisions(scores = {}, decisions = []) {
  const s = { ...scores };
  for (const d of Array.isArray(decisions) ? decisions : []) {
    const k = REVIEW_CAT_KEY[d && d.key];
    if (!k) continue;
    if (d.action === 'hidden') {
      const v = num(s[k]);
      if (v != null && v < 70) s[k] = 78; // out of watch/attention → healthy
    }
  }
  return { scores: s };
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
    const final = applyReviewDecisions(scores, decisions).scores;
    const overall = calculateOverall(final);
    const now = new Date();

    // If the tech HID any finding, the AI free-text observation was generated from
    // signals that include the hidden one — drop it so the photo summary can't
    // contradict the hide. The deterministic diagnosis/insight copy still carries the report.
    const hasHidden = (Array.isArray(decisions) ? decisions : []).some((d) => d && d.action === 'hidden');
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
async function previewTreeShrubAssessment({ photos = [], loadImage, analyze = analyzePhoto } = {}) {
  if (!Array.isArray(photos) || !photos.length || typeof loadImage !== 'function') return null;
  const composites = (await Promise.all(photos.map(async (photo) => {
    try {
      const img = await loadImage(photo);
      if (!img || !img.base64) return null;
      const result = await analyze(img.base64, img.mimeType || 'image/jpeg');
      return result && result.composite ? result.composite : null;
    } catch { return null; }
  }))).filter(Boolean);
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
  };
}

// ── Report loader ───────────────────────────────────────────────────────────────

async function photoUrl(photo) {
  // Prefer a stored direct URL; otherwise presign the S3 key (same view-URL helper
  // the lawn report uses) so the customer report's photo cards actually render.
  if (photo.url) return photo.url;
  if (photo.s3_key && PhotoService && !String(photo.s3_key).startsWith('pending/')) {
    try { return await PhotoService.getViewUrl(photo.s3_key, 15 * 60); } catch { return null; }
  }
  return null;
}

function formatAssessmentScores(row) {
  if (!row) return null;
  return {
    foliageFullness: tsScoreValue(row.foliage_fullness),
    leafColorVigor: tsScoreValue(row.leaf_color_vigor),
    pestActivity: tsScoreValue(row.pest_activity),
    diseaseLeafSpot: tsScoreValue(row.disease_leaf_spot),
    waterHeatStress: tsScoreValue(row.water_heat_stress),
    overallScore: tsScoreValue(row.overall_score)
      ?? calculateOverall({
        foliageFullness: tsScoreValue(row.foliage_fullness),
        leafColorVigor: tsScoreValue(row.leaf_color_vigor),
        pestActivity: tsScoreValue(row.pest_activity),
        diseaseLeafSpot: tsScoreValue(row.disease_leaf_spot),
        waterHeatStress: tsScoreValue(row.water_heat_stress),
      }),
  };
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
  const photos = (await Promise.all(photoRows.map(async (p) => ({
    url: await photoUrl(p),
    label: p.zone || null,
    zone: p.zone || null,
    caption: p.caption || null,
    isBest: !!p.is_best_photo,
    qualityScore: p.quality_score ?? null,
  })))).filter((p) => p.url);

  const scores = formatAssessmentScores(assessment);
  const trend = historyRows.map((r) => {
    const s = formatAssessmentScores(r);
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
    photos,
    plantGroups,
    trend,
    techConfirmedPest: !!assessment.tech_confirmed_pest,
    techConfirmedDisease: !!assessment.tech_confirmed_disease,
  };
}

module.exports = {
  VISION_PROMPT,
  SEVERITY_DISPLAY,
  toCategoryScores,
  calculateOverall,
  averageScores,
  analyzePhoto,
  treeShrubReviewSignature,
  treeShrubPhotosHash,
  buildTreeShrubTechFindings,
  mergePhotoComposites,
  scoreAndStoreTreeShrubAssessment,
  applyReviewDecisions,
  storeTreeShrubAssessmentFromReview,
  previewTreeShrubAssessment,
  formatAssessmentScores,
  loadLinkedTreeShrubAssessment,
  buildTreeShrubAssessmentReportData,
};
