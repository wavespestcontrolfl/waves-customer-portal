'use strict';
/**
 * Lawn lighting-aware color (GATE_LAWN_LIGHTING, owner 2026-10-04).
 *
 * Sun, shade and cloud change how green a lawn looks in a photo. A color score
 * from a full-sun photo with hard tree shadows and one from an overcast sky are
 * not the same measurement, so a "color got better / worse" claim between two
 * visits is only honest when both photos were taken in compatible light.
 *
 * This module is the one definition of that rule. It is pure except
 * `loadVisitLights`, which reads the stored run; nothing here reads the gate
 * (callers decide, so gate-off behavior stays in their hands) and nothing here
 * calls a model.
 *
 * Where the read lives: the visit assessment returns a light read per photo
 * (lawn-visit-input.js, lighting prompt variants) and the run writer stores it
 * inside lawn_assessment_runs.photo_quality, next to the photo's quality. A visit
 * assessed before the gate has no read: its light is `unknown`, and an unknown
 * light is never comparable (no re-reading of old photos).
 */
const shotList = require('./lawn-photo-shots');

// What the model may answer for a photo's light (a closed set).
const LIGHTING = Object.freeze(['full_sun', 'overcast', 'open_shade', 'mixed_sun_shade', 'low_light', 'unknown']);
// The model's vocabulary for hard shadows. The schema carries no nullable types
// (OpenAI strict mode), so "cannot tell" is an explicit word; storage turns it
// into true / false / null.
const HARD_SHADOWS = Object.freeze(['yes', 'no', 'unknown']);

// A color-score move smaller than this (0-100 scale) is "no change" even when the
// light is compatible. PROPOSED, not measured: it is the 8-point category band the
// progress engine already uses to separate a gain from noise
// (service-report/lawn-progress.js CATEGORY_BAND, W5's proposal), reused so the
// code has ONE threshold for "a category moved". Tune it with the same calibration
// replay (server/scripts/replay-lawn-progress.js).
const COLOR_NO_CHANGE_POINTS = 8;

// Which light reads may be compared on color, symmetric. Only these pairs:
//   full_sun   with full_sun                     (same hard light)
//   overcast   with overcast or open_shade       (both even, diffuse light)
//   open_shade with open_shade or overcast
// mixed_sun_shade (sun and shade in one frame), low_light and unknown are never
// compatible, not even with themselves.
const COMPATIBLE = Object.freeze({
  full_sun: Object.freeze(['full_sun']),
  overcast: Object.freeze(['overcast', 'open_shade']),
  open_shade: Object.freeze(['overcast', 'open_shade']),
});

const DIFFUSE = new Set(['overcast', 'open_shade']);
const HARD_LIGHT = new Set(['full_sun', 'overcast', 'open_shade']);
const USABLE_QUALITY = new Set(['adequate', 'limited']);

/**
 * One photo's stored light read, from the model's photo_quality row.
 * @returns {{lighting:string, hard_shadows:boolean|null}}
 */
function normalizeLightRead(entry) {
  const lighting = LIGHTING.includes(entry?.lighting) ? entry.lighting : 'unknown';
  const hard = entry?.hard_shadows;
  // Model answers ('yes'|'no'|'unknown') or an already-stored boolean.
  const hardShadows = hard === 'yes' || hard === true ? true : (hard === 'no' || hard === false ? false : null);
  return { lighting, hard_shadows: hardShadows };
}

/**
 * The light a photo counts as for comparison: hard shadows across the turf make
 * any single-light read a mixed one (shadowed and sunlit turf in one frame).
 */
function effectiveLight(read) {
  if (!read || typeof read !== 'object') return 'unknown';
  const { lighting, hard_shadows: hardShadows } = normalizeLightRead(read);
  return hardShadows === true && HARD_LIGHT.has(lighting) ? 'mixed_sun_shade' : lighting;
}

/** True when two light reads (visit or photo level) may be compared on color. */
function lightsCompatible(a, b) {
  return Object.prototype.hasOwnProperty.call(COMPATIBLE, a) && COMPATIBLE[a].includes(b);
}

/**
 * Whether a color comparison between two lights is allowed, and why not.
 * @returns {{comparable:boolean, reason:null|'light_unknown'|'light_differs'}}
 */
function colorComparability(currentLight, priorLight) {
  const known = (light) => LIGHTING.includes(light) && light !== 'unknown';
  if (!known(currentLight) || !known(priorLight)) return { comparable: false, reason: 'light_unknown' };
  return lightsCompatible(currentLight, priorLight)
    ? { comparable: true, reason: null }
    : { comparable: false, reason: 'light_differs' };
}

/**
 * The per-photo light of one stored run: [{ photoId, photo, quality, light }].
 * `run.photo_ids` is index-aligned with the prompt's 1-based photo numbers (a
 * gap is null), and each `photo_quality` row names its photo number. A row with
 * no stored read (every run before the gate) is `unknown`; a position with no
 * stored photo id or no quality row is `missing`.
 */
function photoLightsFromRun(run) {
  const parse = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  };
  const ids = parse(run?.photo_ids);
  const rows = new Map();
  for (const row of parse(run?.photo_quality)) {
    const number = Number(row?.photo);
    if (Number.isInteger(number) && number >= 1) rows.set(number, row);
  }
  const out = [];
  const positions = Math.max(ids.length, ...rows.keys(), 0);
  for (let number = 1; number <= positions; number += 1) {
    const photoId = ids[number - 1];
    const row = rows.get(number);
    // A prompt position with no stored photo row (its insert failed at /assess) or
    // no quality read has no known light or shot: it is `missing`, and any missing
    // position makes the visit's light unknown.
    if (photoId == null || !row) {
      out.push({ photoId: photoId == null ? null : String(photoId), photo: number, quality: row?.quality || null, light: 'unknown', missing: true });
    } else {
      out.push({ photoId: String(photoId), photo: number, quality: row.quality || null, light: effectiveLight(row) });
    }
  }
  return out;
}

/**
 * Whether a run was read under the shot-list prompt, from the run's OWN stored
 * prompt version (`lawn-visit-v1-shot-list[-lighting]`), never from today's gate.
 */
const readUnderShotList = (promptVersion) => typeof promptVersion === 'string' && promptVersion.includes('-shot-list');

/**
 * ONE light for a whole visit, from the photos the visit's color score rests on.
 * That depends on the prompt the visit was read under (`opts.shotList`, from
 * readUnderShotList of the run's stored version):
 *   - SHOT-LIST prompt (default): area scores come from the shots with a POSITIVE
 *     area weight (shotList.areaWeight: front, back, side, untagged, and the
 *     half-weight shade and hot-edge shots); detail shots (weight 0) do not count,
 *     so a close-up in shade cannot void a sunny overview.
 *   - LEGACY prompt (`shotList: false`, GATE_LAWN_SHOT_LIST off at capture): ONE
 *     whole-visit color score is read from every numbered photo, so EVERY usable
 *     photo counts, close-up and trouble photos included.
 * Usable = adequate or limited.
 *   - any prompt position with no stored photo row -> unknown
 *   - no such photo, or any of them unknown       -> unknown
 *   - all the same                                -> that light
 *   - all overcast / open shade                   -> overcast (open_shade if none is overcast)
 *   - anything else (sun beside shade, low light) -> mixed_sun_shade, or low_light when
 *     every non-matching photo is low light
 * @param {Array<{light:string, quality?:string, zone?:string|null}>} photos
 */
function visitLightFromPhotos(photos, { shotList: shotListPrompt = true } = {}) {
  // A prompt position whose photo row or read is missing could be any shot in any
  // light, so the visit's light cannot be known.
  if ((Array.isArray(photos) ? photos : []).some((p) => p && p.missing === true)) return 'unknown';
  const overview = (Array.isArray(photos) ? photos : [])
    .filter((p) => p && USABLE_QUALITY.has(p.quality) && (!shotListPrompt || shotList.areaWeight(p.zone) > 0));
  if (!overview.length) return 'unknown';
  const lights = overview.map((p) => (LIGHTING.includes(p.light) ? p.light : 'unknown'));
  if (lights.includes('unknown')) return 'unknown';
  const distinct = new Set(lights);
  if (distinct.size === 1) return lights[0];
  if (lights.every((l) => DIFFUSE.has(l))) return lights.includes('overcast') ? 'overcast' : 'open_shade';
  return lights.every((l) => l === 'low_light') ? 'low_light' : 'mixed_sun_shade';
}

/**
 * The stored light of each assessment's visit, for the report. One read of the
 * runs and one of the photo zones for all ids. THROWS on a failed read: the
 * caller must not mistake a failed read for "unknown, nothing to say" and cache
 * it as a healthy render.
 * @returns {Promise<Map<string,string>>} assessment id -> visit light (unknown when no read)
 */
async function loadVisitLights(knex, assessmentIds, { customerId = null } = {}) {
  const ids = [...new Set((Array.isArray(assessmentIds) ? assessmentIds : []).filter((id) => id != null).map(String))];
  const lights = new Map(ids.map((id) => [id, 'unknown']));
  if (!ids.length) return lights;
  const scoped = (query) => (customerId == null ? query : query.where({ customer_id: customerId }));
  const runs = await scoped(knex('lawn_assessment_runs').whereIn('assessment_id', ids))
    .select('assessment_id', 'photo_ids', 'photo_quality', 'prompt_version');
  if (!runs.length) return lights;
  const photoRows = await scoped(knex('lawn_assessment_photos').whereIn('assessment_id', ids))
    .select('id', 'assessment_id', 'zone');
  const zoneById = new Map(photoRows.map((row) => [String(row.id), row.zone || null]));
  for (const run of runs) {
    const photos = photoLightsFromRun(run).map((p) => ({ ...p, zone: p.photoId == null ? null : (zoneById.get(p.photoId) ?? null) }));
    lights.set(String(run.assessment_id), visitLightFromPhotos(photos, { shotList: readUnderShotList(run.prompt_version) }));
  }
  return lights;
}

module.exports = {
  LIGHTING,
  HARD_SHADOWS,
  COLOR_NO_CHANGE_POINTS,
  COMPATIBLE,
  normalizeLightRead,
  effectiveLight,
  lightsCompatible,
  colorComparability,
  photoLightsFromRun,
  readUnderShotList,
  visitLightFromPhotos,
  loadVisitLights,
};
