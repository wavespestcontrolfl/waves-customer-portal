/**
 * AI photo analysis for typed completions (owner spec 2026-06-12): the tech
 * attaches completion photos, taps Analyze, and the vision model returns a
 * customer-facing photo summary + per-photo captions for the report's Field
 * Photos section. AI is never in the critical path — analysis is an optional
 * draft-time assist, the tech reviews/edits before submit, and the validated
 * text persists in the immutable typedReportSnapshot / service_photos rows.
 *
 * This module is the testable core: prompt construction and response
 * parsing/validation. The Anthropic call itself lives in the route.
 */

const { findBannedCustomerCopy } = require('./activity-indicators');

const MAX_PHOTO_SUMMARY_CHARS = 600;
const MAX_PHOTO_CAPTION_CHARS = 200;

function buildPhotoAnalysisPrompt({ schema, values = {}, photoCount = 0, serviceType = '' }) {
  const fieldLines = (schema?.fields || [])
    .map((field) => {
      const value = values?.[field.key];
      if (value == null || String(value).trim() === '') return null;
      return `${field.label}: ${String(value).trim()}`;
    })
    .filter(Boolean);
  return `You are reviewing ${photoCount} field photo${photoCount === 1 ? '' : 's'} a pest-control technician attached to today's service visit, in the order shown.

Write customer-facing copy for the service report's photo section as STRICT JSON (no markdown, no code fences):
{"photoSummary": "...", "captions": ["...", ...]}

Rules:
- "photoSummary": 1-3 sentences describing what the photos collectively document for the customer. Maximum ${MAX_PHOTO_SUMMARY_CHARS} characters.
- "captions": exactly ${photoCount} entries, one per photo in order. Each a short plain-language label of what THAT photo shows, maximum ${MAX_PHOTO_CAPTION_CHARS} characters. No numbering ("Photo 1:") — just the description.
- Observation-scoped wording only: describe what is visible. Never claim a problem is fixed, eliminated, or that the home is pest-proof/rodent-proof. Never diagnose beyond visible evidence — "consistent with" or "appears to show" is the strongest allowed framing.
- NEVER use these words/phrases: "clear", "cleared", "gone", "eliminated", "no infestation", "guaranteed", "resolved".
- Never mention chemical product names, application rates, prices, or EPA details.
- If a photo is too unclear to describe, caption it with what context suggests (e.g. "Service area photo").

Service type: ${serviceType || schema?.label || 'service visit'}
Technician findings (context only — caption what the PHOTOS show):
${fieldLines.length ? fieldLines.join('\n') : '[none recorded]'}

Return only the JSON object.`;
}

/**
 * Parse + validate the model's response. Returns
 * { ok, photoSummary, captions, violations, error }.
 */
function parsePhotoAnalysisResponse(text, { photoCount = 0 } = {}) {
  const raw = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fall back to the first {...} block in the text.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, error: 'unparseable' };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return { ok: false, error: 'unparseable' };
    }
  }
  const photoSummary = String(parsed?.photoSummary || '').trim().slice(0, MAX_PHOTO_SUMMARY_CHARS);
  const captions = (Array.isArray(parsed?.captions) ? parsed.captions : [])
    .slice(0, photoCount)
    .map((c) => String(c || '').trim().slice(0, MAX_PHOTO_CAPTION_CHARS));
  if (!photoSummary) return { ok: false, error: 'empty_summary' };
  while (captions.length < photoCount) captions.push('');
  const violations = [...new Set([
    ...findBannedCustomerCopy(photoSummary),
    ...captions.flatMap((c) => findBannedCustomerCopy(c)),
  ])];
  if (violations.length) {
    return { ok: false, error: 'banned_copy', violations, photoSummary, captions };
  }
  return { ok: true, photoSummary, captions, violations: [] };
}

module.exports = {
  MAX_PHOTO_SUMMARY_CHARS,
  MAX_PHOTO_CAPTION_CHARS,
  buildPhotoAnalysisPrompt,
  parsePhotoAnalysisResponse,
};
