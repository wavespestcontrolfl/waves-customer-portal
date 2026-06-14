/**
 * Turf height-of-cut gauge OCR cross-check (PR2).
 *
 * Reuses the lawn-assessment dual-model vision pattern (Claude VISION + Gemini)
 * to READ the height value off the gauge photo, build a consensus, and reconcile
 * it against the tech's manual reading. Manual entry stays the source of truth on
 * every customer surface — OCR is QA + tamper-evidence only and NEVER overwrites
 * the manual value or blocks completion. Runs async (fire-and-forget) after the
 * visit commits; a failure just leaves verification_status at its prior value.
 */
const MODELS = require('../config/models');
const logger = require('./logger');
const db = require('../models/db');
const photos = require('./photos');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;

const GAUGE_OCR_PROMPT = `You are reading a Turfchek rough grass height-of-cut gauge from a photo. Find where the grass canopy line meets the printed inch scale and read the maintained height in inches. Return ONLY a JSON object: {"height_in": number, "confidence": number between 0 and 1, "readable": boolean}. If the gauge scale or canopy line is not clearly legible, set "readable" to false and "confidence" to 0.`;

const DISCREPANCY_IN = 0.5;        // one gauge increment of tolerance
const CONFIDENCE_THRESHOLD = 0.55; // min consensus confidence to auto-verify

function round2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

// Parse a model's JSON reply into a normalized { height_in, confidence, readable }.
function parseGaugeJson(text) {
  if (!text) return null;
  try {
    const p = JSON.parse(String(text).replace(/```json|```/g, '').trim());
    const height = (p.height_in == null || p.height_in === '') ? NaN : Number(p.height_in);
    const heightOk = Number.isFinite(height);
    return {
      height_in: heightOk ? height : null,
      confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0)),
      readable: p.readable === true && heightOk,
    };
  } catch {
    return null;
  }
}

async function callClaudeGaugeOcr(base64Image, mimeType) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: MODELS.VISION,
      max_tokens: 200,
      temperature: 0.1,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
          { type: 'text', text: GAUGE_OCR_PROMPT },
        ],
      }],
    });
    const parsed = parseGaugeJson(response.content?.[0]?.text);
    return { model: 'claude', ...(parsed || { height_in: null, confidence: 0, readable: false }) };
  } catch (err) {
    logger.warn(`[turf-ocr] Claude gauge read failed: ${err.message}`);
    return null;
  }
}

async function callGeminiGaugeOcr(base64Image, mimeType) {
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
            { text: GAUGE_OCR_PROMPT },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200 },
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const parsed = parseGaugeJson(data.candidates?.[0]?.content?.parts?.[0]?.text);
    return { model: 'gemini', ...(parsed || { height_in: null, confidence: 0, readable: false }) };
  } catch (err) {
    logger.warn(`[turf-ocr] Gemini gauge read failed: ${err.message}`);
    return null;
  }
}

/**
 * Pure consensus over per-model results.
 * - both readable → mean; confidence halved when the two differ by > 0.5"
 * - one readable  → use it, confidence discounted
 * - none readable → ocr_height_in null, readableCount 0
 */
function buildConsensus(modelResults) {
  const models = (Array.isArray(modelResults) ? modelResults : []).filter(Boolean);
  const readable = models.filter((m) => m.readable && Number.isFinite(Number(m.height_in)));
  if (!readable.length) {
    return { ocr_height_in: null, ocr_confidence: 0, ocr_models: models, readableCount: 0 };
  }
  if (readable.length === 1) {
    return {
      ocr_height_in: round2(readable[0].height_in),
      ocr_confidence: round2(readable[0].confidence * 0.7),
      ocr_models: models,
      readableCount: 1,
    };
  }
  const heights = readable.map((m) => Number(m.height_in));
  const mean = heights.reduce((s, h) => s + h, 0) / heights.length;
  const maxDiff = Math.max(...heights) - Math.min(...heights); // disagreement between models
  let confidence = readable.reduce((s, m) => s + m.confidence, 0) / readable.length;
  if (maxDiff > DISCREPANCY_IN) confidence *= 0.5;
  return { ocr_height_in: round2(mean), ocr_confidence: round2(confidence), ocr_models: models, readableCount: readable.length };
}

/** Reconcile OCR consensus vs the manual source of truth → verification_status. */
function reconcile(manualHeightIn, consensus) {
  if (!consensus || consensus.readableCount === 0 || consensus.ocr_height_in == null) {
    return 'ocr_failed';
  }
  const diff = Math.abs(Number(manualHeightIn) - consensus.ocr_height_in);
  return (diff <= DISCREPANCY_IN && consensus.ocr_confidence >= CONFIDENCE_THRESHOLD)
    ? 'verified'
    : 'discrepancy';
}

/** Run both models on a gauge image and return the consensus. */
async function runGaugeOcr(base64Image, mimeType) {
  const [claude, gemini] = await Promise.all([
    callClaudeGaugeOcr(base64Image, mimeType),
    callGeminiGaugeOcr(base64Image, mimeType),
  ]);
  return buildConsensus([claude, gemini]);
}

/**
 * Fetch a reading + its gauge photo, OCR it, and persist ocr_* + verification_status.
 * Fail-soft: never throws (fire-and-forget after completion). No gauge photo →
 * the reading stays 'pending' (nothing to cross-check).
 */
async function processReadingOcr(readingId, knex = db) {
  try {
    const reading = await knex('turf_height_readings').where({ id: readingId }).first();
    if (!reading || !reading.gauge_photo_id) return;
    const photo = await knex('service_photos').where({ id: reading.gauge_photo_id }).first();
    if (!photo?.s3_key) return;
    const image = await photos.getPhotoBase64(photo.s3_key).catch(() => null);
    if (!image?.data) return;

    const consensus = await runGaugeOcr(image.data, image.mimeType);
    const status = reconcile(reading.manual_height_in, consensus);
    await knex('turf_height_readings').where({ id: readingId }).update({
      ocr_height_in: consensus.ocr_height_in,
      ocr_models: JSON.stringify(consensus.ocr_models),
      ocr_confidence: consensus.ocr_confidence,
      verification_status: status,
      updated_at: new Date(),
    });
    logger.info(`[turf-ocr] reading ${readingId} → ${status} (ocr=${consensus.ocr_height_in} manual=${reading.manual_height_in})`);
  } catch (err) {
    logger.warn(`[turf-ocr] processReadingOcr ${readingId} failed: ${err.message}`);
  }
}

module.exports = {
  runGaugeOcr,
  buildConsensus,
  reconcile,
  processReadingOcr,
  GAUGE_OCR_PROMPT,
  _internals: { parseGaugeJson, round2 },
};
