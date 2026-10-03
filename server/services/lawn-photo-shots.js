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

// Which of the minimum slots the visit's zones do not cover yet, as the
// label(s) a technician can act on ("Back overview or Side overview").
function missingMinimumSlots(zones = []) {
  const have = new Set(zones.map(normalizeShotZone).filter(Boolean));
  return MINIMUM_SLOTS
    .filter((slot) => !slot.some((key) => have.has(key)))
    .map((slot) => slot.map((key) => BY_KEY.get(key).label).join(' or '));
}

module.exports = {
  SHOTS, SHOT_KEYS, SHOT_CAP, SHOT_MINIMUM, MINIMUM_SLOTS,
  PAIRABLE_SHOT_ZONES, NON_PAIRABLE_SHOT_ZONES, SHOT_REPORT_LABELS,
  normalizeShotZone, maxPerShot, areaWeight, heroRank, beatsHero, shotCountError, missingMinimumSlots,
};
