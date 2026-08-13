/**
 * Vision Delta Scoring
 *
 * Scores the visual before/after change for a treatment_outcomes row from the
 * tech's best pre/post assessment photos (pre_best_photo_key /
 * post_best_photo_key, written by attachOutcomePhotoRefs in
 * routes/admin-lawn-assessment.js and admin-dispatch.js). One VISION-tier call
 * per pair; the verdict describes ONLY what is visible in the two photos —
 * never causes, products, pests, or diseases (owner rule: never invent field
 * observations).
 *
 * Persistence contract (columns from 20260813000001_treatment_outcome_vision_delta):
 *   - vision_delta          — full jsonb verdict (or {error} when terminally failed)
 *   - vision_delta_score    — overall_change ONLY when comparable=true AND
 *                             confidence >= 0.4; otherwise null (verdict still stored)
 *   - vision_scored_at      — terminal stamp: set on any stored verdict AND on the
 *                             3rd failed attempt, so the sweep never loops a row
 *   - vision_score_attempts — failure counter; rows give up permanently at 3
 *
 * Entirely inert unless GATE_VISION_DELTA === 'true' (checked inside
 * sweepUnscoredOutcomes — single source of truth; the cron leg adds no gate of
 * its own). Kill = unset GATE_VISION_DELTA.
 */

const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');
const { anthropicCreateWithSamplingRetry } = require('./llm/call');
const { stripThinkingBlocks } = require('./llm/deep');
const PhotoService = require('./photos');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const MAX_ATTEMPTS = 3;
const MIN_CONFIDENCE_FOR_SCORE = 0.4;

const PROMPT = `You are comparing two photos of the same lawn: the first is labeled BEFORE (pre-treatment), the second AFTER (post-treatment). Describe ONLY the visible differences between the two photos.

Rules:
- Describe only what is visible. NEVER speculate about causes, products, treatments, pests, or diseases.
- If the photos show different areas, angles, or lighting conditions that prevent a fair comparison, set "comparable" to false.
- Deltas are AFTER minus BEFORE: positive = visibly better in the AFTER photo, negative = visibly worse. 0 = no visible change.

Return ONLY JSON, no markdown:
{
  "overall_change": <-100..100 overall visual change>,
  "density_change": <-100..100>,
  "color_change": <-100..100>,
  "weed_coverage_change": <-100..100 negative = more visible weeds after>,
  "confidence": <0-1>,
  "comparable": <true/false>,
  "notes": "<short factual description of visible differences only>"
}`;

function clampScore(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.max(-100, Math.min(100, n));
}

async function callVisionModel(prePhoto, postPhoto) {
  if (!Anthropic) throw new Error('anthropic sdk unavailable');
  const client = new Anthropic();
  const response = await anthropicCreateWithSamplingRetry(client, {
    model: MODELS.VISION,
    max_tokens: 600,
    temperature: 0.2, // pin output for repeatable verdicts on the same pair
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'BEFORE (pre-treatment) photo:' },
        { type: 'image', source: { type: 'base64', media_type: prePhoto.mimeType, data: prePhoto.data } },
        { type: 'text', text: 'AFTER (post-treatment) photo:' },
        { type: 'image', source: { type: 'base64', media_type: postPhoto.mimeType, data: postPhoto.data } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  // Reasoning-capable VISION models can emit thinking / redacted_thinking
  // blocks ahead of the text block — a blind content[0].text read would turn
  // every valid response into a "failure" and terminally abandon the row.
  // Strip them, then take the FIRST text block wherever it lands.
  const stripped = stripThinkingBlocks(response);
  // First text-bearing block (typeless blocks pass stripThinkingBlocks —
  // tolerate them like deep.js does; tool_use blocks have no .text).
  const textBlock = (stripped?.content || []).find((b) => b && typeof b.text === 'string' && b.text);
  const text = textBlock?.text;
  if (!text) throw new Error('empty vision response');
  const verdict = JSON.parse(String(text).replace(/```json|```/g, '').trim());
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) {
    throw new Error('vision verdict is not a JSON object');
  }
  if (clampScore(verdict.overall_change) === null) {
    throw new Error('vision verdict missing numeric overall_change');
  }
  return verdict;
}

const VisionDelta = {

  // ── Score one outcome's before/after photo pair ─────────────────────────
  async scoreOutcome(outcomeId) {
    const outcome = await db('treatment_outcomes').where({ id: outcomeId }).first();
    if (!outcome) return { ok: false, reason: 'not_found' };
    if (outcome.vision_scored_at) return { ok: false, reason: 'already_scored' };
    if (!outcome.pre_best_photo_key || !outcome.post_best_photo_key) {
      return { ok: false, reason: 'missing_photo_keys' };
    }
    const priorAttempts = Number(outcome.vision_score_attempts) || 0;
    if (priorAttempts >= MAX_ATTEMPTS) return { ok: false, reason: 'attempts_exhausted' };

    try {
      // Photo missing from S3 throws here → same attempt/terminal handling as
      // an LLM failure (the key can never heal, so the row gives up at 3).
      const [prePhoto, postPhoto] = await Promise.all([
        PhotoService.getPhotoBase64(outcome.pre_best_photo_key),
        PhotoService.getPhotoBase64(outcome.post_best_photo_key),
      ]);

      const verdict = await callVisionModel(prePhoto, postPhoto);

      const confidence = Number(verdict.confidence);
      const scoreEligible = verdict.comparable === true
        && Number.isFinite(confidence)
        && confidence >= MIN_CONFIDENCE_FOR_SCORE;
      const score = scoreEligible ? clampScore(verdict.overall_change) : null;

      // Always stamp vision_scored_at with the stored verdict — a
      // non-comparable / low-confidence pair keeps a null score but must
      // never be re-scored in a loop.
      await db('treatment_outcomes').where({ id: outcomeId }).update({
        vision_delta: JSON.stringify(verdict),
        vision_delta_score: score,
        vision_scored_at: new Date(),
        vision_score_attempts: priorAttempts + 1,
      });

      logger.info(`[vision-delta] Scored outcome ${outcomeId}: score=${score === null ? 'null' : score} comparable=${verdict.comparable === true} confidence=${Number.isFinite(confidence) ? confidence : 'n/a'}`);
      return { ok: true, score, verdict };

    } catch (err) {
      const attempts = priorAttempts + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      const patch = { vision_score_attempts: attempts };
      if (terminal) {
        // 3rd failure = permanent give-up: stamp scored_at with an {error}
        // verdict so the sweep stops selecting the row.
        patch.vision_scored_at = new Date();
        patch.vision_delta = JSON.stringify({ error: String(err.message || 'unknown error').slice(0, 500) });
      }
      await db('treatment_outcomes').where({ id: outcomeId }).update(patch);
      logger.error(`[vision-delta] Scoring outcome ${outcomeId} failed (attempt ${attempts}${terminal ? ', terminal' : ''}): ${err.message}`);
      return { ok: false, reason: 'error', terminal, error: err.message };
    }
  },

  // ── Sweep unscored outcomes (bounded, oldest first) ─────────────────────
  async sweepUnscoredOutcomes({ limit = 25 } = {}) {
    // Gate lives HERE (single source of truth) — the cron leg and any manual
    // caller are inert unless the gate is exactly 'true'.
    if (process.env.GATE_VISION_DELTA !== 'true') return { skipped: 'gated' };

    const rows = await db('treatment_outcomes')
      .whereNotNull('pre_best_photo_key')
      .whereNotNull('post_best_photo_key')
      .whereNull('vision_scored_at')
      .where('vision_score_attempts', '<', MAX_ATTEMPTS)
      .orderBy('treatment_date', 'asc')
      .limit(limit);

    let scored = 0;
    let failed = 0;
    for (const row of rows) {
      const result = await VisionDelta.scoreOutcome(row.id);
      if (result.ok) scored += 1;
      else failed += 1;
    }

    if (rows.length) {
      logger.info(`[vision-delta] Sweep: ${rows.length} candidates, ${scored} scored, ${failed} failed`);
    }
    return { candidates: rows.length, scored, failed };
  },
};

module.exports = VisionDelta;
