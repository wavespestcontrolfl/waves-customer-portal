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

const SUGGEST_PROMPT = `You are analyzing a satellite photo of a single residential property for a pest-control perimeter treatment. The property being serviced is at the CENTER of the image — neighboring homes are usually visible at the edges; NEVER trace a neighboring building. Identify the OUTER perimeter of the main residence at the center, following the building's outer wall line.

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
const LAWN_SUGGEST_PROMPT = `You are analyzing a satellite photo of a single residential property for a lawn-care service. The property being serviced is at the CENTER of the image — neighboring lots are usually visible at the edges. Identify the OUTER boundary of THIS property's maintained lawn (turf/grass) as one continuous loop.

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

// The map PNG is 1280x960 — angles computed on normalized 0-1 coords would be
// distorted by the 4:3 frame, so geometry runs in aspect-true space.
const FRAME_ASPECT = 1280 / 960;

/**
 * Square up a vision-suggested BUILDING footprint (owner 2026-07-29: raw
 * model corners wander a few degrees per edge and the trace reads sloppy).
 * Finds the footprint's dominant orientation, then snaps every edge within
 * SNAP_DEG of that axis pair to exactly horizontal/vertical in the rotated
 * frame; genuinely diagonal edges (bay windows, angled lanais) are left
 * alone. Lawn boundaries are organic — never orthogonalize those.
 */
function orthogonalizePerimeter(points) {
  const SNAP_DEG = 20;
  const SNAP_RAD = (SNAP_DEG * Math.PI) / 180;
  if (!Array.isArray(points) || points.length < 4) return points;
  const px = points.map((p) => ({ x: p.x * FRAME_ASPECT, y: p.y }));
  const n = px.length;

  // Dominant orientation: length-weighted circular mean of edge angles in the
  // 90°-periodic domain (multiply angles by 4 so perpendicular edges agree).
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = px[i];
    const b = px[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    sx += len * Math.cos(4 * ang);
    sy += len * Math.sin(4 * ang);
  }
  if (sx === 0 && sy === 0) return points;
  const theta = Math.atan2(sy, sx) / 4;

  const cosT = Math.cos(-theta);
  const sinT = Math.sin(-theta);
  const rot = px.map((p) => ({ x: p.x * cosT - p.y * sinT, y: p.x * sinT + p.y * cosT }));

  // Relaxation passes: each near-axis edge pulls both endpoints onto the
  // shared coordinate; shared vertices converge geometrically across passes
  // (8 passes ≈ sub-pixel residual at frame scale).
  const angleToAxis = (ang) => {
    // distance to the nearest multiple of 90°
    const m = Math.abs(ang) % (Math.PI / 2);
    return Math.min(m, Math.PI / 2 - m);
  };
  for (let pass = 0; pass < 8; pass += 1) {
    for (let i = 0; i < n; i += 1) {
      const a = rot[i];
      const b = rot[(i + 1) % n];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      if (angleToAxis(ang) > SNAP_RAD) continue;
      const horizontal = Math.abs(Math.cos(ang)) >= Math.abs(Math.sin(ang));
      if (horizontal) {
        const my = (a.y + b.y) / 2;
        a.y = my;
        b.y = my;
      } else {
        const mx = (a.x + b.x) / 2;
        a.x = mx;
        b.x = mx;
      }
    }
  }

  const cosB = Math.cos(theta);
  const sinB = Math.sin(theta);
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const out = rot.map((p) => ({
    x: clamp01((p.x * cosB - p.y * sinB) / FRAME_ASPECT),
    y: clamp01(p.x * sinB + p.y * cosB),
  }));
  if (out.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return points;

  // Snapping commonly leaves collinear runs along one wall — merge them so
  // the tech gets true corners to drag, not a bead chain. Keep at least 4.
  const merged = out.filter((p, i) => {
    const prev = out[(i - 1 + out.length) % out.length];
    const next = out[(i + 1) % out.length];
    const inAng = Math.atan2((p.y - prev.y), (p.x - prev.x) * FRAME_ASPECT);
    const outAng = Math.atan2((next.y - p.y), (next.x - p.x) * FRAME_ASPECT);
    let turn = Math.abs(outAng - inAng);
    if (turn > Math.PI) turn = 2 * Math.PI - turn;
    return turn > (3 * Math.PI) / 180;
  });
  return merged.length >= 4 ? merged : out;
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
      if (suggestion) {
        if (opts.mode !== 'lawn') {
          suggestion.perimeter = orthogonalizePerimeter(suggestion.perimeter);
        }
        return suggestion;
      }
    } catch (err) {
      logger.warn(`[treatment-zone-suggest] attempt failed: ${err.message}`);
    }
  }
  return null;
}

module.exports = {
  suggestTreatmentZone,
  normalizeSuggestion,
  orthogonalizePerimeter,
  SUGGEST_PROMPT,
  LAWN_SUGGEST_PROMPT,
};
