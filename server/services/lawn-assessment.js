/**
 * Lawn Health Assessment Service
 *
 * Dual-vision analysis using Claude and Gemini to score lawn health
 * from photos. Averages results, flags divergences, applies seasonal
 * normalization, and tracks baselines over time.
 */

const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

const VISION_PROMPT = `You are a lawn health assessment tool for a professional lawn care company in Southwest Florida. Analyze the provided lawn photo and return ONLY a JSON object with the following scores. Base your analysis on what is visible in the photo. The primary turf type in this region is St. Augustine grass.

Return this exact JSON structure and nothing else — no markdown, no backticks, no preamble:
{
  "turf_density": <number 0-100>,
  "weed_coverage": <number 0-100>,
  "color_health": <number 1-10>,
  "fungal_activity": <"none" | "minor" | "moderate" | "severe">,
  "thatch_visibility": <"low" | "moderate" | "high">,
  "observations": "<brief notes>"
}`;

// ── Category mappings ───────────────────────────────────────────

const FUNGAL_MAP = { none: 0, minor: 1, moderate: 2, severe: 3 };
const FUNGAL_REVERSE = ['none', 'minor', 'moderate', 'severe'];

const THATCH_MAP = { low: 0, moderate: 1, high: 2 };
const THATCH_REVERSE = ['low', 'moderate', 'high'];

const FUNGUS_DISPLAY = { none: 95, minor: 75, moderate: 50, severe: 20 };
const THATCH_DISPLAY = { low: 85, moderate: 60, high: 35 };

// ── Vision API calls ────────────────────────────────────────────

async function callClaudeVision(base64Image, mimeType) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
          { type: 'text', text: VISION_PROMPT },
        ],
      }],
    });

    const text = response.content?.[0]?.text;
    if (!text) { logger.warn('[lawn-assessment] Claude returned empty content'); return null; }
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (err) {
    logger.error(`Lawn assessment Claude vision failed: ${err.message}`);
    return null;
  }
}

async function callGeminiVision(base64Image, mimeType) {
  if (!GEMINI_KEY) return null;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: base64Image } },
            { text: VISION_PROMPT },
          ],
        }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 500 },
      }),
    });

    if (!response.ok) {
      logger.error(`Lawn assessment Gemini API ${response.status}: ${response.statusText}`);
      return null;
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (err) {
    logger.error(`Lawn assessment Gemini vision failed: ${err.message}`);
    return null;
  }
}

// ── Core service methods ────────────────────────────────────────

/**
 * Analyze a single photo with both Claude and Gemini vision in parallel.
 * Returns { claude, gemini, composite, divergenceFlags }
 */
async function analyzePhoto(base64Image, mimeType) {
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

/**
 * Average scores from Claude and Gemini results.
 * If only one is available, use it directly.
 */
function averageScores(claudeResult, geminiResult) {
  const divergenceFlags = [];

  // If only one model returned, use it directly
  if (!claudeResult && !geminiResult) return { composite: null, divergenceFlags };
  if (!claudeResult) return { composite: geminiResult, divergenceFlags };
  if (!geminiResult) return { composite: claudeResult, divergenceFlags };

  const composite = {};

  // Numeric: simple average, flag if >20 difference
  for (const field of ['turf_density', 'weed_coverage']) {
    const c = Number(claudeResult[field]) || 0;
    const g = Number(geminiResult[field]) || 0;
    composite[field] = Math.round((c + g) / 2);
    if (Math.abs(c - g) > 20) divergenceFlags.push({ metric: field, claude: c, gemini: g, gap: Math.abs(c - g) });
  }

  // Color health (1-10 scale, so >2 point gap = >20 on 0-100 scale)
  const cColor = Number(claudeResult.color_health) || 5;
  const gColor = Number(geminiResult.color_health) || 5;
  composite.color_health = Math.round((cColor + gColor) / 2 * 10) / 10;
  if (Math.abs(cColor - gColor) > 2) divergenceFlags.push({ metric: 'color_health', claude: cColor, gemini: gColor, gap: Math.abs(cColor - gColor) });

  // Categorical: fungal_activity
  const cFungal = FUNGAL_MAP[claudeResult.fungal_activity] ?? 0;
  const gFungal = FUNGAL_MAP[geminiResult.fungal_activity] ?? 0;
  composite.fungal_activity = FUNGAL_REVERSE[Math.round((cFungal + gFungal) / 2)];

  // Categorical: thatch_visibility
  const cThatch = THATCH_MAP[claudeResult.thatch_visibility] ?? 0;
  const gThatch = THATCH_MAP[geminiResult.thatch_visibility] ?? 0;
  composite.thatch_visibility = THATCH_REVERSE[Math.round((cThatch + gThatch) / 2)];

  // Observations: concatenate both
  const observations = [claudeResult.observations, geminiResult.observations].filter(Boolean);
  composite.observations = observations.join(' | ');

  return { composite, divergenceFlags };
}

/**
 * Map composite raw scores to customer-facing display scores (all 0-100).
 */
function mapToDisplayScores(composite) {
  if (!composite) return null;

  const clamp = v => Math.max(0, Math.min(100, v));
  return {
    turf_density: clamp(composite.turf_density || 0),
    weed_suppression: clamp(100 - (composite.weed_coverage || 0)),
    color_health: clamp(Math.round((composite.color_health || 5) * 10)),
    fungus_control: clamp(FUNGUS_DISPLAY[composite.fungal_activity] || 50),
    thatch_level: clamp(THATCH_DISPLAY[composite.thatch_visibility] || 60),
    observations: composite.observations || '',
  };
}

/**
 * Apply seasonal normalization to display scores.
 * Peak (May-Sep): no adjustment
 * Shoulder (Mar-Apr, Oct-Nov): turf_density *= 1.1, color_health *= 1.1, cap at 100
 * Dormant (Dec-Feb): turf_density *= 1.15, color_health *= 1.25, cap at 100
 */
function applySeasonalAdjustment(scores, month) {
  if (!scores) return null;

  const season = getSeason(month);
  const adjusted = { ...scores };

  if (season === 'shoulder') {
    adjusted.turf_density = Math.min(100, Math.round(adjusted.turf_density * 1.1));
    adjusted.color_health = Math.min(100, Math.round(adjusted.color_health * 1.1));
  } else if (season === 'dormant') {
    adjusted.turf_density = Math.min(100, Math.round(adjusted.turf_density * 1.15));
    adjusted.color_health = Math.min(100, Math.round(adjusted.color_health * 1.25));
  }

  return adjusted;
}

/**
 * Determine season from month number (1-12).
 */
function getSeason(month) {
  if (month >= 5 && month <= 9) return 'peak';
  if (month >= 3 && month <= 4 || month >= 10 && month <= 11) return 'shoulder';
  return 'dormant'; // Dec (12), Jan (1), Feb (2)
}

/**
 * Get full assessment history for a customer, ordered by date.
 */
async function getCustomerHistory(customerId) {
  return db('lawn_assessments')
    .where({ customer_id: customerId })
    .orderBy('service_date', 'asc');
}

/**
 * Get the baseline assessment for a customer.
 */
async function getBaseline(customerId) {
  return db('lawn_assessments')
    .where({ customer_id: customerId, is_baseline: true })
    .first();
}

/**
 * Reset the baseline: unmark old baseline, mark the next available
 * assessment as the new baseline, and log the reset.
 */
async function resetBaseline(customerId, adminName, reason) {
  const oldBaseline = await getBaseline(customerId);

  // Find the next assessment after the old baseline (or the earliest if none)
  let newBaselineQuery = db('lawn_assessments')
    .where({ customer_id: customerId })
    .where('is_baseline', false)
    .orderBy('service_date', 'asc');

  if (oldBaseline) {
    newBaselineQuery = newBaselineQuery.where('service_date', '>', oldBaseline.service_date);
  }

  const newBaseline = await newBaselineQuery.first();

  await db.transaction(async trx => {
    // Unmark old baseline
    if (oldBaseline) {
      await trx('lawn_assessments')
        .where({ id: oldBaseline.id })
        .update({ is_baseline: false, updated_at: new Date() });
    }

    // Mark new baseline
    if (newBaseline) {
      await trx('lawn_assessments')
        .where({ id: newBaseline.id })
        .update({ is_baseline: true, updated_at: new Date() });
    }

    // Log the reset
    await trx('lawn_baseline_resets').insert({
      customer_id: customerId,
      reset_by: adminName,
      reason,
      old_baseline_id: oldBaseline?.id || null,
      new_baseline_id: newBaseline?.id || null,
    });
  });

  return { oldBaselineId: oldBaseline?.id, newBaselineId: newBaseline?.id };
}

module.exports = {
  VISION_PROMPT,
  analyzePhoto,
  averageScores,
  mapToDisplayScores,
  applySeasonalAdjustment,
  getSeason,
  getCustomerHistory,
  getBaseline,
  resetBaseline,
};
