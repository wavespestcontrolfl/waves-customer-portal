/**
 * Lawn Diagnostic — LLM diagnosis + narrative prompts (v0.4).
 *
 * Two focused passes that wrap the deterministic contract in
 * `lawn-diagnostic-report.js`:
 *
 *   PASS A — runDiagnosis(): photos + vision scores + product/compliance context
 *            → structured findings with HONEST, evidence-based confidence. A cause
 *            is NAMED only when its minimum-evidence signature is visible; otherwise
 *            the finding is the SYMPTOM at low/unknown confidence (the "naming gate").
 *   PASS B — runNarrative(): the reconciled contract → a calm, specific,
 *            confidence-matched customer_summary ("write it last"). The summary may
 *            never upgrade a low/unknown symptom into a named pest/disease.
 *
 * Neither pass blocks. On any failure the caller falls back to the deterministic
 * `buildFindingsFromVision` / `buildCustomerSummary`. The model never invents
 * agronomy, product names, label timing, or quantities — it selects from the
 * curated reference and the injected, DB-authoritative product/compliance data.
 *
 * Curated agronomy below is condensed from the verified sources named in
 * docs/design/lawn-diagnostic-plan.md (facts-bank/services/lawn-care.md, the
 * Sarasota micronutrient-yellowing post, and lawn-snapshot.js cautious phrasing).
 * Do not add agronomy here that is not backed by those sources.
 */

const logger = require('./logger');
const MODELS = require('../config/models');
// Shared egress sanitizers: reduce names to allowlisted labels and scrub free text
// BEFORE the narrative LLM sees them, so no raw/injected finding text can echo into
// the published customer_summary (the output is scrubbed again at the public route).
const { safeConditionLabel, scrubCustomerText } = require('./lawn-diagnostic-report');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const PROMPT_VERSION = 'lawn-diagnostic-v0.5';
const MAX_PROMPT_IMAGES = 5;

// ── Multi-model pipeline config (env-overridable, no new SDK deps) ─────────────
// Perception = Gemini Flash (vision); Challenge = Claude Opus 4.8 (the adversarial
// reasoner — pinned independently of the app-wide FLAGSHIP, which stays Opus 4.7);
// Writer = GPT-5.5 (OpenAI Responses API). Each is reached by direct REST / SDK,
// mirroring the existing property-lookup / lawn-assessment integrations.
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const LAWN_VISION_MODEL = process.env.LAWN_VISION_MODEL || 'gemini-3.5-flash';
const geminiUrl = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
const LAWN_CHALLENGE_MODEL = process.env.LAWN_CHALLENGE_MODEL || 'claude-opus-4-8';
const OPENAI_RESPONSES_API = 'https://api.openai.com/v1/responses';
// Dedicated writer override — deliberately NOT chained through the global OPENAI_MODEL
// (which other services default to a mini tier), so the lawn writer stays GPT-5.5.
const LAWN_WRITER_MODEL = process.env.LAWN_WRITER_MODEL || 'gpt-5.5';

// ── Curated SWFL St. Augustine reference (selection menu, not free-write) ──────
const CURATED_REFERENCE = `## CURATED REFERENCE — SW Florida, primarily St. Augustine turf

NAMING GATE (hard): use a cause's NAME only when its "Required:" signature below is
visible in the photos (or a technician field test confirms it). If the required
signature is absent, the finding name is the SYMPTOM ("browning", "thinning",
"yellowing", "weed pressure") and confidence is capped at low — unknown if even the
symptom is unclear. "Required:" is the MINIMUM evidence to name that cause.

- Chinch bugs: irregular, expanding yellow→brown patches in full sun / along hot
  edges (driveways, sidewalks) that do NOT green up with water. Look-alike:
  drought stress. Required: an in-sun/edge expanding patch that fails to green up
  with water AND a blade/crown close-up. Photo-only chinch is never "confirmed" —
  confidence caps at moderate; confirmation is a float or cut-and-pull test (~20+/sq ft).
- Large patch (Rhizoctonia): roughly circular patches with yellow/orange margins,
  cooler wet weather. Look-alike: TARR, drought. Required: a close-up of the patch
  margin showing the ring — without it, use "patch-pattern thinning" at low confidence.
- Gray leaf spot: small lesions on blades, after rain or heavy nitrogen, warm
  humid weather. Required: a blade close-up showing the lesions — without it, do
  not name it.
- Color/yellowing — match the pattern before naming a cause: iron shows as
  interveinal yellowing on NEW growth (sandy soil / high pH lockout); nitrogen is
  uniform yellowing on OLDER growth; magnesium shows on leaf margins. Required: the
  matching pattern is visible — without a clear pattern, say "color stress", never a
  named "deficiency".
- Weeds: name a specific weed (dollarweed, sedge/nutsedge, crabgrass) only when
  its morphology is visible. Required: identifiable weed morphology — otherwise
  "weed pressure".
- Drought / irrigation stress: blue-gray cast, folding blades, footprinting,
  uniform thinning in dry zones. Required: the dry-stress signature in a plausibly
  dry zone — distinguish from chinch (no water response) and shade (consistent low light).
- Thatch / shade / scalping: thatch = spongy mat; shade = thinning under canopy;
  scalping = uniform tan after a low mow. Cultural, not pest/disease — name only
  with the stated visible cue present.

## RESULT TIMING (use ranges, never exact day counts beyond these)
- Weeds: visible response ~10-14 days, may need follow-up by weed type.
- Color/green-up: ~2-3 weeks.
- Density / fill-in / thickness: ~60-90 days.
- Disease: treatment stops spread first; browned turf must regrow over time.

## COMPLIANCE & WORDING (hard)
- No product or brand names, no rates, no FRAC/IRAC/HRAC codes in customer copy.
- Use active-ingredient-free functional language; exact watering/mowing/rainfast
  numbers ONLY when injected product-label data is db_authoritative.
- Cautious disease language only ("signs consistent with"), never a hard call.
- Say "trained," never "certified." Never claim "organic-only."
- Fertilizer blackout (Jun 1 – Sep 30, all three counties) holds nitrogen AND
  phosphorus; iron/micronutrients may still be allowed.`;

// ── Shared safety rules (both passes) ─────────────────────────────────────────
const AUTO_RELEASE_RULE = `## AUTO-RELEASE SAFETY RULE

This system does not use manual human review as a report gate. Always produce the
safest valid report the evidence supports.

When evidence is incomplete, conflicting, or low quality:
- lower confidence;
- describe symptoms instead of naming a cause;
- use "appears most consistent with," "treated as suspected," or "we'll keep an eye on";
- list the limitation in observed/negative evidence;
- do not invent label instructions, product effects, quantities, or confirmed causes;
- keep customer wording conservative and useful.

Do not set or request human review. Never block.

## AUTO-OUTPUT MODES (internal routing only — never in customer copy)
The downstream system classifies each report as standard / conservative /
label_limited / minimal based on your confidence and the available data. Your job
is only to be honest about confidence and evidence so that classification is correct.`;

const FALSE_PRECISION_RULE = `## FALSE-PRECISION (hard)
- No invented quantities. Express affected area in bands ("a few spots", "one
  section", "widespread") unless a measured value is provided. Never invent
  percentages or square footage.
- No timelines outside the curated ranges; always a range, never a single day.
- No product-specific watering/mowing/rainfast/reentry numbers unless the injected
  label data is db_authoritative; otherwise use general guidance.
- No brand/active-ingredient names or FRAC/IRAC/HRAC codes in customer-facing text.
- No naming a cause the evidence does not support: a low/unknown finding is a
  symptom, never a named pest, disease, weed species, or deficiency, in ANY output.`;

// ── PASS A: diagnosis system prompt ───────────────────────────────────────────
const DIAGNOSIS_SYSTEM_PROMPT = `# ROLE
You are a Southwest Florida lawn diagnostician for Waves Pest Control & Lawn Care.
You SELECT and ASSEMBLE approved agronomy for what the photo evidence supports.
You do NOT invent agronomy, products, label timing, or numbers. Your output feeds a
deterministic reconciliation + QA layer and may be shown to a prospective customer.

# OPERATING PRINCIPLES
Accuracy over reassurance. Evidence over assumption. Honest confidence over false
certainty. Selection over invention.

${AUTO_RELEASE_RULE}

# PASS 1 — DIAGNOSE
Produce a findings array. For each finding set: name, confidence, severity,
spread_risk, estimated_area_affected, urgency, observed_evidence, inferred_context,
negative_evidence, confirmation_step, customer_wording.

## CONFIDENCE RUBRIC (by evidence, not by model agreement)
- high: multiple corroborating visible signals AND a field test / technician
  verification, OR a pathognomonic pattern. Only level cleared for definitive wording.
- moderate: a clear visible pattern consistent with one primary cause, but a
  credible differential remains; requires the cause's Required signature (curated
  reference) plus at least one close-up and one context shot.
- low: suggestive only — single angle, poor light, a strong competing cause, or the
  cause's Required signature is not visible (name = symptom at this level).
- unknown: cannot name even the symptom; describe what little is visible only.
NAME GATE: assign a cause NAME (chinch, large patch, gray leaf spot, a named weed, a
specific deficiency) ONLY when that cause's Required signature is met; otherwise the
finding name is the SYMPTOM and confidence is low/unknown. Do not let season, weather,
or a vision score alone promote a symptom to a named cause.
HARD CAP: photo-only chinch, disease, or drought never exceeds moderate unless a
confirmation result is present.

## CONFLICT RESOLUTION (precedence)
technician field test > visible photo evidence > vision score > seasonal/weather prior.
Weather and season raise suspicion; they never confirm. If two causes cannot be
separated from the inputs, keep BOTH as a differential at lower confidence with a
confirmation step — do not force one. Negative evidence lowers the confidence of any
finding it contradicts.

## PHOTO INTERPRETATION
Describe what is visible; infer cautiously; never diagnose past what the pixels
support. Account for capture artifacts: white-balance can mimic color stress; mow
stripes / scalping can mimic disease; shade can mimic thinning; a wet sheen can mimic
drought. Require a close-up AND a wide/context shot to exceed low confidence; a single
angle caps confidence. Map each visible cue to observed_evidence, assumptions to
inferred_context, and record what you did NOT see in negative_evidence.

${CURATED_REFERENCE}

${FALSE_PRECISION_RULE}

# OUTPUT
Return ONLY this JSON, no markdown, no backticks, no preamble:
{
  "findings": [
    {
      "finding_id": "F1",
      "name": "<short condition or symptom>",
      "confidence": "high|moderate|low|unknown",
      "severity": "mild|moderate|severe",
      "spread_risk": "low|moderate|high|unknown",
      "estimated_area_affected": "<band or null>",
      "urgency": "monitor|follow_up|immediate_callback",
      "observed_evidence": ["<what is visible>"],
      "inferred_context": ["<assumed, not seen>"],
      "negative_evidence": ["<looked for, not present>"],
      "confirmation_step": "<field test or closer look that would raise confidence>",
      "customer_wording": "<one plain, confidence-matched sentence>"
    }
  ]
}`;

// ── STAGE 1: perception prompt (Gemini Flash, vision) ─────────────────────────
// Identify VISIBLE turf issues only. No diagnosis, no named cause — a later skeptic
// (Opus) does that. Naming a cause here is an error.
const PERCEPTION_PROMPT = `# ROLE
You are a careful lawn-photo OBSERVER for a Southwest Florida lawn care company
(primarily St. Augustine turf). Report ONLY what is visually present. You do NOT
diagnose, name a pest/disease/weed species, or assign a cause — a later step does
that. Naming or concluding a cause here is an error.

# WHAT TO REPORT (per distinct area you can see)
- location/context: full sun, shade, along a hard edge (driveway/sidewalk), low spot.
- color: green / yellowing (note new vs older growth if visible) / brown / blue-gray cast.
- pattern + distribution: patch shape (irregular/circular/diffuse), edges, spread; a few
  spots vs one section vs widespread.
- blade/canopy detail visible: lesions, fraying, thinning, matting, weed morphology,
  mow/scalp stripes.
- caveats: glare, white-balance, single angle, blur, distance — anything limiting judgment.

# RULES
- Describe, never conclude: "irregular browning along the sunny driveway edge that looks
  dry" — NOT "chinch bugs". If you cannot tell, say so; missing detail is valuable.
- No product names, no treatment advice, no confidence scores, no customer wording.

# OUTPUT
Return ONLY this JSON, no markdown/backticks:
{
  "observations": [
    {"area":"<short label>","location":"<sun|shade|edge|low spot|unknown>","color":"<...>","pattern":"<...>","distribution":"<a few spots|one section|widespread|unclear>","detail":"<blade/canopy/weed detail or 'not visible'>","caveats":"<capture limits or null>"}
  ],
  "overall_notes":"<one neutral sentence on overall condition + photo sufficiency>"
}`;

// ── STAGE 2: adversarial challenge prompt (Opus, text over observations) ───────
const CHALLENGE_SYSTEM_PROMPT = `# ROLE
You are a SKEPTICAL Southwest Florida lawn diagnostician for Waves Pest Control & Lawn
Care. You are given a photo OBSERVER's notes (visual observations only) plus
product/compliance context. ADVERSARIALLY test any implied diagnosis and emit honest,
evidence-gated findings. You do NOT invent agronomy, products, label timing, or numbers —
you SELECT from the curated reference. Your output feeds a deterministic reconciliation +
QA layer and may be shown to a prospective customer.

# OPERATING PRINCIPLES
Accuracy over reassurance. Evidence over assumption. Honest confidence over false
certainty. Selection over invention.

# THE CHALLENGE (apply to every cause the observations could imply)
1. What VISIBLE evidence in the observations supports this cause?
2. What ELSE could explain the same observations (differentials / look-alikes)?
3. What CANNOT be determined from these photos (no close-up, single angle, no water-
   response shown, no field test)?
Only after answering all three, gate the name.

${AUTO_RELEASE_RULE}

## CONFIDENCE RUBRIC (by evidence, not by model agreement)
- high: multiple corroborating visible signals AND a field test / technician
  verification, OR a pathognomonic pattern. Only level cleared for definitive wording.
- moderate: a clear visible pattern consistent with one primary cause, but a credible
  differential remains; requires the cause's Required signature (curated reference) plus
  at least one close-up and one context shot in the observations.
- low: suggestive only — single angle, poor light, a strong competing cause, or the
  cause's Required signature is not visible (name = symptom at this level).
- unknown: cannot name even the symptom; describe what little is visible only.
NAME GATE: assign a cause NAME (chinch, large patch, gray leaf spot, a named weed, a
specific deficiency) ONLY when that cause's Required signature is present IN THE
OBSERVATIONS; otherwise the finding name is the SYMPTOM and confidence is low/unknown. Do
not let season, weather, or a vision score alone promote a symptom to a named cause.
HARD CAP: photo-only chinch, disease, or drought never exceeds moderate unless a
confirmation result is present.

## CONFLICT RESOLUTION (precedence)
technician field test > visible photo evidence > vision score > seasonal/weather prior.
Weather and season raise suspicion; they never confirm. If two causes cannot be separated
from the observations, keep BOTH as a differential at lower confidence with a confirmation
step — do not force one. Negative evidence lowers the confidence of any finding it contradicts.

${CURATED_REFERENCE}

${FALSE_PRECISION_RULE}

# OUTPUT
Return ONLY this JSON, no markdown, no backticks, no preamble:
{
  "findings": [
    {
      "finding_id": "F1",
      "name": "<short condition or symptom>",
      "confidence": "high|moderate|low|unknown",
      "severity": "mild|moderate|severe",
      "spread_risk": "low|moderate|high|unknown",
      "estimated_area_affected": "<band or null>",
      "urgency": "monitor|follow_up|immediate_callback",
      "observed_evidence": ["<cited visual cue from the observations>"],
      "inferred_context": ["<assumed, not seen>"],
      "negative_evidence": ["<look-alike ruled out, or detail not visible>"],
      "confirmation_step": "<field test or closer look that would raise confidence>",
      "customer_wording": "<one plain, confidence-matched sentence>"
    }
  ]
}`;

// ── PASS B: narrative (customer summary) system prompt ────────────────────────
const NARRATIVE_SYSTEM_PROMPT = `# ROLE
You write the single customer_summary paragraph for a Waves Pest Control & Lawn Care
lawn report shown to a prospective customer. You are given the already-reconciled
diagnostic contract. Write the summary LAST — synthesize the visit; do not repeat
internal fields.

${AUTO_RELEASE_RULE}

# CUSTOMER-SUMMARY REALISM PASS
- 2-4 plain sentences. No scores, no internal flag names, no jargon, no markdown.
- Reflect the RECONCILED state: if a finding was not treated today or needs a
  follow-up, say so honestly ("one area we'll re-check"). If an application was
  preventive, frame it as preventive — never imply a confirmed problem.
- Confidence-honest: below "high" use "most consistent with" / "signs consistent
  with" / "treated as suspected"; only "high" may be definitive.
- Naming discipline: only name a specific cause (pest, disease, weed species,
  deficiency) when that finding's confidence is moderate or high. For low/unknown
  findings, describe the symptom from its label and confidence — never upgrade a
  symptom into a named cause in the summary.
- Calm, specific, actionable. No fear-selling, no overpromising (no "eliminate",
  "guaranteed", "100%", "pest-free").
- Realism check before finalizing: would a skeptical homeowner standing on the lawn
  agree this matches what they can see? Drop anything not in observed_evidence.

${FALSE_PRECISION_RULE}

# OUTPUT
Return ONLY this JSON, no markdown: {"customer_summary": "<the paragraph>"}`;

// ── Anthropic helpers ─────────────────────────────────────────────────────────
function anthropicClient() {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function parseJsonResponse(response) {
  const text = response?.content?.[0]?.text;
  if (!text) return null;
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

function normalizeDiagnosisJson(json = {}) {
  const findings = Array.isArray(json.findings)
    ? json.findings.filter((finding) => finding && typeof finding === 'object')
    : [];
  return {
    findings,
    customer_summary: typeof json.customer_summary === 'string' ? json.customer_summary : '',
  };
}

function diagnosisContextObject({ visionScores, divergenceFlags, products, compliance, season, grassType } = {}) {
  return {
    season: season || null,
    grass_type: grassType || 'st_augustine (assumed for SWFL)',
    vision_scores: visionScores || null,
    vision_divergence_flags: divergenceFlags || [],
    applied_products: (products || []).map((product) => ({
      product_id: product.product_id,
      category: product.category || null,
      role: product.role || null,
      addresses_findings: product.addresses_findings || [],
      label_constraints: product.product_label_constraints || null,
    })),
    compliance: compliance || {},
  };
}

function buildDiagnosisContext(context = {}) {
  return JSON.stringify(diagnosisContextObject(context), null, 2);
}

// Minimal OpenAI Responses-API text extractor (mirrors property-lookup-v2's helper).
function extractOpenAIText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if ((content?.type === 'output_text' || content?.type === 'text') && content.text) parts.push(content.text);
    }
  }
  return parts.join('');
}

function parseLooseJson(text) {
  if (!text) return null;
  const clean = String(text).replace(/```json|```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  try { return JSON.parse(match ? match[0] : clean); } catch { return null; }
}

/**
 * PASS A — produce structured findings from photos + vision scores + context.
 * Returns { ok, findings, reason }. Never throws.
 */
async function runDiagnosis(context = {}) {
  const client = anthropicClient();
  if (!client) return { ok: false, reason: 'no_api' };

  const photos = (context.photos || []).filter((photo) => photo && photo.data).slice(0, MAX_PROMPT_IMAGES);
  if (!photos.length) return { ok: false, reason: 'no_photos' };

  try {
    const imageBlocks = photos.map((photo) => ({
      type: 'image',
      source: { type: 'base64', media_type: photo.mimeType || 'image/jpeg', data: photo.data },
    }));
    const response = await client.messages.create({
      model: MODELS.VISION,
      max_tokens: 1600,
      temperature: 0.2,
      system: DIAGNOSIS_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          { type: 'text', text: `Diagnose the lawn in the ${photos.length} photo(s) above. Context (JSON):\n${buildDiagnosisContext(context)}` },
        ],
      }],
    });
    const parsed = parseJsonResponse(response);
    if (!parsed) return { ok: false, reason: 'empty_response' };
    const normalized = normalizeDiagnosisJson(parsed);
    if (!normalized.findings.length) return { ok: false, reason: 'no_findings' };
    return { ok: true, findings: normalized.findings };
  } catch (err) {
    logger.error(`[lawn-diagnostic-prompt] runDiagnosis failed: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

/**
 * STAGE 1 — perception (Gemini Flash). Photos → visible observations only (no cause).
 * Returns { ok, observations, overall_notes, model, reason }. Never throws.
 */
async function runPerception(context = {}) {
  if (!GEMINI_KEY) return { ok: false, reason: 'no_gemini_key' };
  const photos = (context.photos || []).filter((photo) => photo && photo.data).slice(0, MAX_PROMPT_IMAGES);
  if (!photos.length) return { ok: false, reason: 'no_photos' };

  try {
    const parts = [
      ...photos.map((photo) => ({ inline_data: { mime_type: photo.mimeType || 'image/jpeg', data: photo.data } })),
      { text: `${PERCEPTION_PROMPT}\n\nReport observations for the ${photos.length} photo(s) above. Season: ${context.season || 'unknown'}.` },
    ];
    const resp = await fetch(geminiUrl(LAWN_VISION_MODEL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.2, maxOutputTokens: 1200 } }),
    });
    if (!resp.ok) {
      logger.error(`[lawn-diagnostic-prompt] runPerception Gemini ${resp.status}`);
      return { ok: false, reason: `gemini_${resp.status}` };
    }
    const data = await resp.json();
    const parsed = parseLooseJson(data?.candidates?.[0]?.content?.parts?.[0]?.text);
    const observations = Array.isArray(parsed?.observations)
      ? parsed.observations.filter((obs) => obs && typeof obs === 'object')
      : [];
    if (!observations.length) return { ok: false, reason: 'no_observations' };
    return {
      ok: true,
      observations,
      overall_notes: typeof parsed.overall_notes === 'string' ? parsed.overall_notes : '',
      model: LAWN_VISION_MODEL,
    };
  } catch (err) {
    logger.error(`[lawn-diagnostic-prompt] runPerception failed: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

// Provenance for the adversarial layer — so a later "this report looks too generic" or
// "a cause slipped through" question can see whether the challenge actually ran.
function challengeMeta(extra = {}) {
  return {
    attempted: false,
    model: LAWN_CHALLENGE_MODEL,
    passed: false,
    degraded: false,
    failureType: null, // null | no_api | timeout | api_error | invalid_json | empty_findings | policy_refusal
    removedFindingIds: [],
    softenedFindingIds: [],
    requiredConfirmationSteps: [],
    ...extra,
  };
}

/**
 * Deterministic, model-free downgrade for when perception SUCCEEDED but the adversarial
 * challenge was unavailable. Turns raw observations into a single SYMPTOM-level finding
 * that names NO cause — "never block" must not mean "publish an un-challenged diagnosis".
 * The customer sees symptoms + a field-check recommendation; the naming gate keeps any
 * cause out because the finding is low-confidence and symptom-named.
 */
function symptomFindingsFromObservations(observations = []) {
  const list = Array.isArray(observations) ? observations.filter((obs) => obs && typeof obs === 'object') : [];
  if (!list.length) return [];
  const cues = list
    .map((obs) => [obs.color, obs.pattern, obs.distribution, obs.detail].filter(Boolean).join(', '))
    .filter(Boolean)
    .slice(0, 6);
  return [{
    finding_id: 'F1',
    name: 'Visible turf stress',
    confidence: 'low',
    severity: 'moderate',
    spread_risk: 'unknown',
    estimated_area_affected: null,
    urgency: 'monitor',
    observed_evidence: cues,
    inferred_context: [],
    negative_evidence: ['adversarial review unavailable — no specific cause is named from these photos'],
    confirmation_step: 'A field check is recommended before naming a specific cause.',
    customer_wording: 'The photos show areas of turf stress; several causes are possible, so a closer look is the best next step before naming one.',
  }];
}

/**
 * STAGE 2 — adversarial challenge (Claude Opus 4.8). Observations + context → gated
 * findings. Returns { ok, findings, reason, challenge } where `challenge` is the
 * provenance metadata (attempted/passed/degraded/failureType/...). Never throws.
 */
async function runChallenge(perception = {}, context = {}) {
  const client = anthropicClient();
  if (!client) {
    return { ok: false, reason: 'no_api', findings: [], challenge: challengeMeta({ degraded: true, failureType: 'no_api' }) };
  }
  const observations = Array.isArray(perception.observations) ? perception.observations : [];
  if (!observations.length) {
    return { ok: false, reason: 'no_observations', findings: [], challenge: challengeMeta({ degraded: true, failureType: 'empty_findings' }) };
  }

  try {
    const payload = JSON.stringify({
      observations,
      overall_notes: perception.overall_notes || null,
      ...diagnosisContextObject(context),
    }, null, 2);
    const response = await client.messages.create({
      model: LAWN_CHALLENGE_MODEL,
      max_tokens: 1800,
      system: CHALLENGE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Photo observations + context (JSON):\n${payload}\n\nChallenge each implied cause, then return the findings JSON now.`,
      }],
    });
    let parsed;
    try { parsed = parseJsonResponse(response); } catch { parsed = null; }
    if (!parsed) {
      const failureType = response?.stop_reason === 'refusal' ? 'policy_refusal' : 'invalid_json';
      return { ok: false, reason: 'empty_response', findings: [], challenge: challengeMeta({ attempted: true, degraded: true, failureType }) };
    }
    const normalized = normalizeDiagnosisJson(parsed);
    if (!normalized.findings.length) {
      return { ok: false, reason: 'no_findings', findings: [], challenge: challengeMeta({ attempted: true, degraded: true, failureType: 'empty_findings' }) };
    }
    const requiredConfirmationSteps = normalized.findings
      .filter((finding) => String(finding.confidence || '').toLowerCase() !== 'high' && finding.confirmation_step)
      .map((finding) => finding.confirmation_step);
    return {
      ok: true,
      findings: normalized.findings,
      challenge: challengeMeta({ attempted: true, passed: true, requiredConfirmationSteps }),
    };
  } catch (err) {
    logger.error(`[lawn-diagnostic-prompt] runChallenge failed: ${err.message}`);
    const failureType = /abort|timeout|ETIMEDOUT/i.test(err.message || '') ? 'timeout' : 'api_error';
    return { ok: false, reason: 'error', findings: [], challenge: challengeMeta({ attempted: true, degraded: true, failureType }) };
  }
}

function buildNarrativeContext(contract = {}) {
  const diag = contract.diagnosis || {};
  return JSON.stringify({
    primary_finding: diag.primary_finding ? safeConditionLabel(diag.primary_finding, diag.confidence) : null,
    confidence: diag.confidence || 'unknown',
    // Only allowlisted, confidence-gated labels + structured fields reach the model —
    // never raw finding/flag free text, and never a named cause for a low/unknown
    // finding. finding_id lets the model align treatment.addresses_findings.
    findings: (diag.findings || []).map((finding) => ({
      finding_id: finding.finding_id || null,
      name: safeConditionLabel(finding.name, finding.confidence),
      confidence: finding.confidence,
      severity: finding.severity,
    })),
    customer_visible_flags: (contract.reconciliation_flags || [])
      .filter((flag) => flag.customer_visible)
      .map((flag) => ({ type: flag.type })),
    treatment: (contract.treatment_rationale || []).map((row) => ({
      application_class: row.application_class,
      addresses_findings: row.addresses_findings,
    })),
    watering_customer_sequence: contract.watering?.customer_sequence || null,
    expectations: contract.expectations || {},
    seasonal_context: scrubCustomerText(contract.seasonal_context || ''),
  }, null, 2);
}

/**
 * PASS B — write the customer_summary from the reconciled contract.
 * Returns { ok, customer_summary, reason }. Never throws.
 */
async function runNarrative(contract = {}, context = {}) {
  const client = anthropicClient();
  if (!client) return { ok: false, reason: 'no_api' };

  try {
    const response = await client.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 600,
      system: NARRATIVE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Reconciled diagnostic contract (JSON):\n${buildNarrativeContext(contract)}\n\nWrite the customer_summary now.`,
      }],
    });
    const parsed = parseJsonResponse(response);
    const summary = parsed && typeof parsed.customer_summary === 'string' ? parsed.customer_summary.trim() : '';
    if (!summary) return { ok: false, reason: 'empty_summary' };
    return { ok: true, customer_summary: summary };
  } catch (err) {
    logger.error(`[lawn-diagnostic-prompt] runNarrative failed: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

/**
 * STAGE 3 — writer (GPT-5.5, OpenAI Responses API). Reconciled contract → the single
 * customer_summary, from the already-sanitized/allowlisted narrative context only.
 * Returns { ok, customer_summary, model, reason }. Never throws.
 */
async function runWriter(contract = {}, _context = {}) {
  if (!process.env.OPENAI_API_KEY) return { ok: false, reason: 'no_openai_key' };
  try {
    const prompt = `${NARRATIVE_SYSTEM_PROMPT}\n\nReconciled diagnostic contract (JSON):\n${buildNarrativeContext(contract)}\n\nWrite the customer_summary now. Return ONLY {"customer_summary":"..."}.`;
    const resp = await fetch(OPENAI_RESPONSES_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: LAWN_WRITER_MODEL, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] }),
    });
    if (!resp.ok) {
      logger.error(`[lawn-diagnostic-prompt] runWriter OpenAI ${resp.status}`);
      return { ok: false, reason: `openai_${resp.status}` };
    }
    const data = await resp.json();
    const parsed = parseLooseJson(extractOpenAIText(data));
    const summary = parsed && typeof parsed.customer_summary === 'string' ? parsed.customer_summary.trim() : '';
    if (!summary) return { ok: false, reason: 'empty_summary' };
    return { ok: true, customer_summary: summary, model: LAWN_WRITER_MODEL };
  } catch (err) {
    logger.error(`[lawn-diagnostic-prompt] runWriter failed: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

module.exports = {
  PROMPT_VERSION,
  // The RESOLVED pipeline model IDs (env override or default) — single source of truth
  // for both the pipeline and the pre-merge readiness check.
  LAWN_PIPELINE_MODELS: { vision: LAWN_VISION_MODEL, challenge: LAWN_CHALLENGE_MODEL, writer: LAWN_WRITER_MODEL },
  DIAGNOSIS_SYSTEM_PROMPT,
  CHALLENGE_SYSTEM_PROMPT,
  PERCEPTION_PROMPT,
  NARRATIVE_SYSTEM_PROMPT,
  CURATED_REFERENCE,
  // New multi-model pipeline (primary): perceive → challenge → write.
  runPerception,
  runChallenge,
  runWriter,
  symptomFindingsFromObservations,
  // Legacy single-call passes, kept as the fallback rungs of the no-block ladder.
  runDiagnosis,
  runNarrative,
  normalizeDiagnosisJson,
};
