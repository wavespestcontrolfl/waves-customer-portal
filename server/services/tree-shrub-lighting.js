'use strict';
/**
 * Tree & Shrub lighting-aware color (GATE_TS_LIGHTING, owner 2026-10-23, "add to
 * tree and shrub"): the lawn rule (lawn-lighting.js) applied to plant photos.
 *
 * Sun, shade and cloud change how green a plant looks in a photo, so a "color
 * got better / worse" trend between two visits is only honest when both visits'
 * photos were taken in compatible light. This module holds the T&S side: the
 * prompt ask, the tolerant read of the model's answer, the storage shape and the
 * report check. The comparison rules themselves are lawn-lighting.js's, reused
 * as is (closed sets, effectiveLight, visitLightFromPhotos, colorComparability).
 *
 * Reads are PER PHOTO (analyzePhoto runs once for each photo). Storage needs no
 * migration: the visit's light and each photo's read go inside the assessment's
 * existing composite_scores jsonb as `light` (the visit-level light) and
 * `photo_lights` ([{ lighting, hard_shadows: true|false|null }] in photo order).
 * A visit assessed without the gate has neither: its light is `unknown`, and an
 * unknown light is never comparable (no re-reading of old photos).
 *
 * Nothing here reads a model. Only `lightingLive` reads the gate, at call time.
 */
const crypto = require('crypto');
const lawnLighting = require('./lawn-lighting');

const { LIGHTING, HARD_SHADOWS } = lawnLighting;

const lightingLive = () => {
  const gates = require('../config/feature-gates');
  return typeof gates.tsLightingLive === 'function' && gates.tsLightingLive() === true;
};

const MARKER = 'Return this exact JSON structure';
const LIGHT_PROMPT_RULE = `LIGHT IN THE PHOTO: sun, shade and cloud change how green and how full plants look in a photo. Also record the light you can SEE in the pixels:
- lighting: full_sun (direct sun on the plants), overcast (cloud cover: even, soft light, no distinct shadows), open_shade (the plants sit in even shade, such as the shaded side of a building, not dappled), mixed_sun_shade (sun and shade both on the plants in one frame: dappled light or tree shadows), low_light (dusk, dawn or too dark to judge color), unknown (you cannot tell).
- hard_shadows: "yes" when hard-edged shadows (trees, fences, buildings, the photographer) fall across the plants, "no" when none do, "unknown" when you cannot tell.
Never infer the light from the season, the weather or the time of year. Judge leaf color and fullness from foliage in even light. Where one photo shows both sun and shade, read the sunlit foliage and the shadowed foliage each against its own light: never read shadowed foliage as darker, thinner or more stressed, and never read sunlit foliage as paler or more bleached. Light is never a finding by itself.`;
const LIGHT_JSON_FIELDS = [
  `  "lighting": <${LIGHTING.map((word) => `"${word}"`).join(' | ')}>`,
  `  "hard_shadows": <${HARD_SHADOWS.map((word) => `"${word}"`).join(' | ')}>`,
];

/** The vision prompt plus the light ask (gate on). The caller passes the gate-off prompt. */
function withLightPrompt(prompt) {
  const asked = prompt.replace(MARKER, () => `${LIGHT_PROMPT_RULE}\n\n${MARKER}`);
  return asked.replace(/\n\}$/, () => `,\n${LIGHT_JSON_FIELDS.join(',\n')}\n}`);
}

const lowerWord = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : null);

/**
 * Make a provider reply's light fields a closed answer, in place. A missing or
 * invalid answer becomes `unknown`; it never fails the read (the schema
 * validator does not look at these fields).
 */
function normalizeLightFields(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const lighting = lowerWord(parsed.lighting);
  const hard = lowerWord(parsed.hard_shadows);
  parsed.lighting = LIGHTING.includes(lighting) ? lighting : 'unknown';
  parsed.hard_shadows = HARD_SHADOWS.includes(hard) ? hard : 'unknown';
  return parsed;
}

/** The light fields of a merged read, or {} when neither provider read the light. */
function lightFieldsFrom(claude, gemini) {
  if (!lightingLive()) return {};
  const read = [gemini, claude].find((r) => r && typeof r === 'object' && 'lighting' in r);
  return read ? { lighting: read.lighting, hard_shadows: read.hard_shadows } : {};
}

/**
 * The stored light of a set of scored photos, in photo order, or null when the
 * gate is off or no photo carries a read. A photo with no read counts as unknown,
 * so it makes the visit's light unknown.
 * @returns {{light:string, photo_lights:Array}|null}
 */
function lightFromComposites(composites) {
  if (!lightingLive()) return null;
  const list = (Array.isArray(composites) ? composites : []).filter(Boolean);
  if (!list.some((c) => 'lighting' in c)) return null;
  return lightFromReads(list);
}

function lightFromReads(reads) {
  const photoLights = reads.map((r) => lawnLighting.normalizeLightRead(r));
  const photos = photoLights.map((r) => ({ light: lawnLighting.effectiveLight(r), quality: 'adequate' }));
  return {
    light: lawnLighting.visitLightFromPhotos(photos, { shotList: false }),
    photo_lights: photoLights,
  };
}

// Canonical text of a light read list: what the preview signs and the
// completion handler re-derives. Only closed words and booleans can appear.
const lightCanon = (photoLights) => photoLights
  .map((r) => `${r.lighting}:${r.hard_shadows === true ? 'y' : (r.hard_shadows === false ? 'n' : 'u')}`).join(',');

/** HMAC over the per-photo light reads, bound to the visit and the exact photo set. */
function lightSignature(photoLights, serviceId, photosHash) {
  const canon = `ts-light|${lightCanon(photoLights)}|${serviceId || ''}|${photosHash || ''}`;
  return crypto.createHmac('sha256', process.env.JWT_SECRET || 'tree-shrub-review-key').update(canon).digest('hex');
}

/**
 * The light a completion's signed preview carried, or null: the gate is off, the
 * preview sent no light (an older client, or the preview ran gate-off), or the
 * signature does not match. A forged or stale light is dropped (unknown), never
 * stored. The visit light is derived here from the verified reads.
 */
function verifiedLightFromReview(review, serviceId, photosHash) {
  if (!lightingLive() || !review || !Array.isArray(review.photoLights) || !review.photoLights.length) return null;
  if (typeof review.lightSignature !== 'string' || !photosHash) return null;
  const photoLights = review.photoLights.map((r) => lawnLighting.normalizeLightRead(r));
  const expected = lightSignature(photoLights, serviceId, photosHash);
  const given = Buffer.from(review.lightSignature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;
  return lightFromReads(photoLights);
}

/** The visit light stored on an assessment row's composite_scores ('unknown' when none). */
function storedVisitLight(compositeScores) {
  let composite = compositeScores;
  if (typeof composite === 'string') {
    try { composite = JSON.parse(composite); } catch { composite = null; }
  }
  const light = composite && typeof composite === 'object' ? composite.light : null;
  return LIGHTING.includes(light) || light === lawnLighting.MIXED_LIGHT ? light : 'unknown';
}

/**
 * Whether the Leaf Color & Vigor trend may stay: the two latest visits that carry
 * a color score (same-month readings collapsed to the later one, as the chart
 * draws them) are in known, compatible light.
 * @param {Array<{date:*, leafColorVigor:*, light?:string}>} trend history, oldest first
 * @param {(date:*) => string} labelOf the chart's own point label
 */
function colorTrendComparable(trend, labelOf) {
  const score = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
  const rows = (Array.isArray(trend) ? trend : []).map((t, i) => ({ id: i, date: t.date, colorHealth: score(t.leafColorVigor) }));
  const tail = lawnLighting.colorTrendTail(rows, labelOf);
  if (!tail) return true; // fewer than two readings: no series to hide
  const light = (i) => trend[i].light || 'unknown';
  return lawnLighting.colorComparability(light(tail.latestId), light(tail.previousId)).comparable;
}

module.exports = {
  lightingLive,
  withLightPrompt,
  normalizeLightFields,
  lightFieldsFrom,
  lightFromComposites,
  lightSignature,
  verifiedLightFromReview,
  storedVisitLight,
  colorTrendComparable,
  LIGHT_PROMPT_RULE,
};
