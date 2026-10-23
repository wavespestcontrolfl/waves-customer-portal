/**
 * The chinch bug count procedure (owner 2026-10-22), in ONE place. The v13 recipe note (lawn-protocol-v13.json, three tracks) and the
 * Fast Complete chinch card (lawn-treatment-guide.js) both state it, so both are built from these facts; a test holds the JSON note equal
 * to chinchCountNote() and the card equal to chinchCardCheck(), so neither can drift from the other.
 */
const CHINCH_COUNT = Object.freeze({
  can: 'bottomless can',
  depthIn: 3,
  spots: 4,
  minutes: 5,
  bigEyed: 'wide head, bulging eyes',
  recheckDays: Object.freeze([5, 12]),
});

const recheckText = () => CHINCH_COUNT.recheckDays.join(' and ');

// The recheck of a treated area, as the recipe states a recheck for the caterpillar line ("recheck in 7 days"): a short clause.
const chinchRecheckClause = () => `recheck at ${recheckText()} days`;

// The v13 program note's count sentences (the part before "Where chinch bugs are found ...").
function chinchCountNote() {
  const c = CHINCH_COUNT;
  return `Chinch bugs: always count before treating. Push a ${c.can} ${c.depthIn} in into the soil at ${c.spots} spots on the edge of the damage, fill with water, count for ${c.minutes} minutes, and write the count in the visit notes. Big-eyed bugs (${c.bigEyed}) are predators: do not count them. Recheck a treated area at ${recheckText()} days.`;
}

// The Fast Complete chinch card's "check first" text.
function chinchCardCheck() {
  const c = CHINCH_COUNT;
  return `Check first: at the sunny edge of the damaged patch, push a ${c.can} ${c.depthIn} in into the soil at ${c.spots} spots, fill with water and count for ${c.minutes} minutes. Do not count big-eyed bugs (${c.bigEyed}). Write the count in the notes.`;
}

module.exports = { CHINCH_COUNT, chinchCountNote, chinchCardCheck, chinchRecheckClause };
