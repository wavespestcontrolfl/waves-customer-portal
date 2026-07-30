/**
 * Treatment Zone auto-trace (owner 2026-07-21): vision-detect the building
 * footprint on the visit's satellite photo so the tech starts from a
 * pre-drawn perimeter and just adjusts + confirms instead of tapping every
 * corner. The suggested loop follows the OUTER edge of the residence and
 * MUST include any attached lanai / screened pool enclosure ("pool cage") —
 * in SWFL the perimeter application wraps the cage footprint.
 *
 * Gemini vision first (best → fallback — it reads aerial imagery well),
 * Claude VISION as the cross-provider backstop, mirroring the
 * tree-shrub-assessment ladder. Pure suggestion: nothing is persisted here;
 * the tech's adjusted trace goes through the existing save route.
 */
const MODELS = require('../config/models');
const logger = require('./logger');
const { anthropicCreateWithSamplingRetry } = require('./llm/call');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { /* optional in some test envs */ }

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const GEMINI_VISION_MODEL = process.env.GEMINI_VISION_MODEL || MODELS.GEMINI_VISION_BEST;
const GEMINI_VISION_FALLBACK_MODEL = MODELS.GEMINI_VISION_FALLBACK;

const SUGGEST_PROMPT = `You are analyzing a satellite photo of a single residential property for a pest-control perimeter treatment. Identify the OUTER perimeter of the main residence, following the building's outer wall line.

The perimeter MUST include, as one continuous loop:
- the house itself and any attached garage
- any attached lanai, screened porch, screened pool enclosure, or pool cage (in Florida these read as a dark or gridded rectangular area attached to the rear of the house, often over or around a pool — include the OUTER frame of that enclosure in the loop)

Do NOT include: detached sheds, fences, driveways, the pool deck beyond the enclosure frame, or property lines.

Return ONLY this JSON, nothing else — no markdown, no backticks:
{
  "perimeter": [[x, y], ...],
  "includes_pool_enclosure": <true|false>,
  "confidence": <number 0-1>
}

Rules for "perimeter":
- 8 to 28 [x, y] points, each normalized 0-1 relative to the image (x = fraction of width from the left, y = fraction of height from the top).
- Ordered clockwise around the loop; do NOT repeat the first point at the end.
- Follow the visible building corners closely.
- If you cannot confidently locate the main residence, return {"perimeter": [], "includes_pool_enclosure": false, "confidence": 0}.`;

// Lawn visits outline the treated TURF, not the building (owner 2026-07-28):
// suggesting the residence footprint in lawn mode would save a building
// perimeter labeled "treated lawn area" on the customer report.
const LAWN_SUGGEST_PROMPT = `You are analyzing a satellite photo of a single residential property for a lawn-care service. Identify the OUTER boundary of THIS property's maintained lawn (turf/grass) as one continuous loop.

The loop should:
- Follow the outer edge of the property's grass — where turf meets the street, sidewalk, driveway, landscape beds, fences, or the neighboring lot.
- Cover the whole maintained yard (front, sides, and back when the grass is contiguous around the home). The house may sit inside the loop; that is fine.
- Stay on THIS property only — never include a neighbor's grass or the street.

Do NOT trace: the building outline by itself, driveways, pools or pool decks, or property lines beyond the turf.

Return ONLY this JSON, nothing else — no markdown, no backticks:
{
  "perimeter": [[x, y], ...],
  "includes_pool_enclosure": false,
  "confidence": <number 0-1>
}

Rules for "perimeter":
- 8 to 28 [x, y] points, each normalized 0-1 relative to the image (x = fraction of width from the left, y = fraction of height from the top).
- Ordered clockwise around the loop; do NOT repeat the first point at the end.
- If you cannot confidently locate this property's lawn, return {"perimeter": [], "includes_pool_enclosure": false, "confidence": 0}.`;

function promptForMode(mode) {
  return mode === 'lawn' ? LAWN_SUGGEST_PROMPT : SUGGEST_PROMPT;
}

function parseModelJson(text) {
  try {
    return JSON.parse(String(text || '').replace(/```json|```/g, '').trim());
  } catch {
    return null;
  }
}

/**
 * Validate + normalize a model suggestion. Returns
 * { perimeter: [{x, y}...] (normalized 0-1), includesPoolEnclosure, confidence }
 * or null when the suggestion is unusable.
 */
function normalizeSuggestion(parsed) {
  if (!parsed || !Array.isArray(parsed.perimeter)) return null;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const points = parsed.perimeter
    .map((pair) => {
      if (!Array.isArray(pair) || pair.length < 2) return null;
      const x = Number(pair[0]);
      const y = Number(pair[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x: clamp01(x), y: clamp01(y) };
    })
    .filter(Boolean)
    // drop near-duplicate consecutive points (model stutter)
    .filter((p, i, arr) => i === 0 || Math.hypot(p.x - arr[i - 1].x, p.y - arr[i - 1].y) > 0.005);
  if (points.length < 6 || points.length > 40) return null;
  // A believable footprint spans a meaningful part of the frame; a
  // degenerate cluster (all points within a tiny box) is a bad read.
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  if (Math.max(...xs) - Math.min(...xs) < 0.08 || Math.max(...ys) - Math.min(...ys) < 0.08) return null;
  return {
    perimeter: points,
    includesPoolEnclosure: Boolean(parsed.includes_pool_enclosure),
    confidence: Number.isFinite(Number(parsed.confidence)) ? Math.max(0, Math.min(1, Number(parsed.confidence))) : null,
  };
}

async function geminiSuggest(model, base64Png, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: 'image/png', data: base64Png } }, { text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 900 },
    }),
  });
  if (!response.ok) {
    logger.warn(`[treatment-zone-suggest] Gemini ${model} HTTP ${response.status}`);
    return null;
  }
  const data = await response.json();
  return parseModelJson(data.candidates?.[0]?.content?.parts?.[0]?.text);
}

async function claudeSuggest(base64Png, prompt) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropicCreateWithSamplingRetry(anthropic, {
      model: MODELS.VISION,
      max_tokens: 900,
      temperature: 0.1,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Png } },
          { type: 'text', text: prompt },
        ],
      }],
    });
    return parseModelJson(response.content?.[0]?.text);
  } catch (err) {
    logger.warn(`[treatment-zone-suggest] Claude vision failed: ${err.message}`);
    return null;
  }
}

/**
 * @param {Buffer} pngBuffer — the visit's satellite map PNG (1280x960).
 * @param {object} [opts]
 * @param {'perimeter'|'lawn'} [opts.mode] — 'lawn' traces the turf boundary
 *   instead of the building footprint.
 * @returns suggestion (see normalizeSuggestion) or null.
 */
async function suggestTreatmentZone(pngBuffer, opts = {}) {
  if (!pngBuffer?.length) return null;
  const prompt = promptForMode(opts.mode);
  const base64Png = pngBuffer.toString('base64');
  const attempts = [];
  if (GEMINI_KEY) {
    attempts.push(() => geminiSuggest(GEMINI_VISION_MODEL, base64Png, prompt));
    if (GEMINI_VISION_FALLBACK_MODEL && GEMINI_VISION_FALLBACK_MODEL !== GEMINI_VISION_MODEL) {
      attempts.push(() => geminiSuggest(GEMINI_VISION_FALLBACK_MODEL, base64Png, prompt));
    }
  }
  attempts.push(() => claudeSuggest(base64Png, prompt));
  for (const attempt of attempts) {
    try {
      const suggestion = normalizeSuggestion(await attempt());
      if (suggestion) return suggestion;
    } catch (err) {
      logger.warn(`[treatment-zone-suggest] attempt failed: ${err.message}`);
    }
  }
  return null;
}

module.exports = { suggestTreatmentZone, normalizeSuggestion, SUGGEST_PROMPT, LAWN_SUGGEST_PROMPT };
