'use strict';
/**
 * Lawn visit photo shot list (lawn report rebuild P18, GATE_LAWN_SHOT_LIST).
 * Pure helpers over shared/lawn-photo-shots.json, the one definition the admin
 * client also reads (client/src/lib/lawn-photo-shots.js). Nothing here does
 * I/O, and nothing here reads the gate: callers decide whether the shot list
 * is live and pass it in, so gate-off behavior stays in the callers' hands.
 */
const DEFINITION = require('../../shared/lawn-photo-shots.json');

const SHOTS = Object.freeze(DEFINITION.shots.map((shot) => Object.freeze({ ...shot })));
const SHOT_KEYS = Object.freeze(SHOTS.map((shot) => shot.key));
const SHOT_CAP = DEFINITION.cap;
const SHOT_MINIMUM = DEFINITION.minimum;
const MAX_PHOTO_BYTES = DEFINITION.maxPhotoBytes;
const MAX_TOTAL_BYTES = DEFINITION.maxTotalBytes;
const MINIMUM_SLOTS = Object.freeze(DEFINITION.minimumSlots.map((slot) => Object.freeze([...slot])));
const BY_KEY = new Map(SHOTS.map((shot) => [shot.key, shot]));

const keyOf = (zone) => String(zone == null ? '' : zone).trim().toLowerCase();
const shotFor = (zone) => BY_KEY.get(keyOf(zone)) || null;

// The shot key for a recorded zone, or null when the zone is not a shot.
function normalizeShotZone(zone) {
  return shotFor(zone)?.key || null;
}

// Zones that pair across visits (the same spot every time) and zones that
// never do. Derived from the definition so the pairing sets cannot drift.
const PAIRABLE_SHOT_ZONES = Object.freeze(SHOTS.filter((shot) => shot.pairable).map((shot) => shot.key));
const NON_PAIRABLE_SHOT_ZONES = Object.freeze(SHOTS.filter((shot) => !shot.pairable).map((shot) => shot.key));

// Customer-facing label for a stored zone (report photo strip, report payload).
const SHOT_REPORT_LABELS = Object.freeze(Object.fromEntries(SHOTS.map((shot) => [shot.key, shot.reportLabel])));

// How many photos of one shot a visit may carry (1, or 2 for a problem area).
function maxPerShot(zone) {
  return shotFor(zone)?.max || 1;
}

// Weight a photo carries in an area score. A photo with no recorded shot is
// an unlabeled overview and counts in full; a detail shot never moves an area
// score. Unknown values behave like unlabeled.
function areaWeight(zone) {
  const shot = shotFor(zone);
  return shot ? shot.areaWeight : 1;
}

// Hero ordering for the report's lead photo: front, then any other overview
// (back, side, unlabeled), then the half-weight area shots, then detail shots.
function heroRank(zone) {
  const shot = shotFor(zone);
  return shot ? shot.heroRank : 2;
}

// True when a candidate photo should replace the current lead photo: a higher
// hero rank wins outright, and quality only decides inside a rank. With every
// rank equal (gate off passes 0 for all) this is the plain quality contest.
function beatsHero(candidate, best) {
  return candidate.rank > best.rank || (candidate.rank === best.rank && candidate.quality > best.quality);
}

// Uniqueness check over a visit's already-normalized zones (null = unlabeled).
// Returns an error string or null. The front message keeps its original words.
function shotCountError(zones = []) {
  const counts = new Map();
  for (const zone of zones) {
    const key = normalizeShotZone(zone);
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const [key, count] of counts) {
    const shot = BY_KEY.get(key);
    if (count <= shot.max) continue;
    if (key === 'front') return 'Only one photo can be the Front photo';
    return shot.max === 1
      ? `Only one photo can be the ${shot.label} photo`
      : `At most ${shot.max} photos can be the ${shot.label} photo`;
  }
  return null;
}

// The error for one RAW zone value from a request: an empty zone is fine
// (unlabeled); anything else must be one of the shot keys. Checked before the
// value is normalized or counted, so a bad tag is refused, never stored as
// unlabeled. Shared by both /assess paths.
function rawZoneError(zone) {
  if (zone == null || zone === '') return null;
  return normalizeShotZone(zone) ? null : `photo zone must be one of: ${SHOT_KEYS.join(', ')}`;
}

// Validate a request's RAW zones end to end: every non-empty zone is a shot
// key, then the per-shot maximum. Returns { error, zones } with normalized zones.
function validateZones(rawZones = []) {
  for (const zone of rawZones) {
    const error = rawZoneError(zone);
    if (error) return { error, zones: [] };
  }
  const zones = rawZones.map(normalizeShotZone);
  const error = shotCountError(zones);
  return error ? { error, zones: [] } : { error: null, zones };
}

const mib = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

// Size rule for a visit's photos, in decoded bytes, one entry per photo.
// Each photo within the per-photo limit, and all together within the total, so
// a valid set of 8 always fits under the request body ceiling. The message
// names the photo to retake or remove (1-based, as the technician counts).
function photoSizeError(byteSizes = []) {
  const tooBig = byteSizes.findIndex((bytes) => bytes > MAX_PHOTO_BYTES);
  if (tooBig >= 0) return `Photo ${tooBig + 1} is ${mib(byteSizes[tooBig])}; each photo must be ${mib(MAX_PHOTO_BYTES)} or smaller. Retake it or remove it.`;
  const total = byteSizes.reduce((sum, bytes) => sum + bytes, 0);
  if (total <= MAX_TOTAL_BYTES) return null;
  const largest = byteSizes.indexOf(Math.max(...byteSizes));
  return `These photos total ${mib(total)}; one visit can carry ${mib(MAX_TOTAL_BYTES)}. Photo ${largest + 1} is the largest (${mib(byteSizes[largest])}); retake it smaller or remove it.`;
}

// Whether a replayed capture used the shot-list zone vocabulary. Zones are the
// only record of the capture mode: shade, hot_edge and blade_crown exist only
// there. back/side alone are ambiguous (retired 2026-09-24, same words) and a
// set larger than the old 6-photo cap with none of these zones is
// indistinguishable from a bad legacy case; both replay as legacy.
const SHOT_LIST_ONLY_ZONES = new Set(['shade', 'hot_edge', 'blade_crown']);
function capturedUnderShotList(zones = []) {
  return zones.some((zone) => SHOT_LIST_ONLY_ZONES.has(keyOf(zone)));
}

// Which of the minimum slots the visit's zones do not cover yet, as the
// label(s) a technician can act on ("Back overview or Side overview").
function missingMinimumSlots(zones = []) {
  const have = new Set(zones.map(normalizeShotZone).filter(Boolean));
  return MINIMUM_SLOTS
    .filter((slot) => !slot.some((key) => have.has(key)))
    .map((slot) => slot.map((key) => BY_KEY.get(key).label).join(' or '));
}

module.exports = {
  SHOTS, SHOT_KEYS, SHOT_CAP, SHOT_MINIMUM, MINIMUM_SLOTS, MAX_PHOTO_BYTES, MAX_TOTAL_BYTES,
  PAIRABLE_SHOT_ZONES, NON_PAIRABLE_SHOT_ZONES, SHOT_REPORT_LABELS,
  normalizeShotZone, rawZoneError, validateZones, photoSizeError, capturedUnderShotList, maxPerShot, areaWeight, heroRank, beatsHero, shotCountError, missingMinimumSlots,
};
