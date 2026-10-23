/**
 * Lawn v13 nitrogen targets that depend on a mapped trouble area (GATE_LAWN_NOV_LARGE_PATCH_N, owner 2026-10-09).
 *
 * UF/IFAS Large Patch (SS-PLP-5): reduce nitrogen and use slow-release in the disease window, November to May; it does not say
 * zero. The v13 November visit applies LESCO 24-0-11 at 0.75 lb N per 1,000 sq ft; while fungus is mapped as active the bag is
 * sized for 0.5 lb N instead (24-0-11: 2.1 lb of product per 1,000, because 2.1 x 0.24 = 0.504).
 *
 * An entry applies to the visit whose month number is `month`, when the property has an ACTIVE trouble area of type
 * `troubleType` (lawn-trouble-areas TYPES; take-all is its own type and does not match), and only LOWERS the visit's nitrogen
 * target (never raises it). Nitrogen only; potassium is untouched. December (10-0-22) already carries 0.45 lb N, so it has no entry.
 * Kept in code, not in a protocol row, so no migration is needed and the gate off leaves every stored row as it was.
 */
const V13_TROUBLE_N_TARGETS = Object.freeze([
  Object.freeze({ month: 11, troubleType: 'fungus', targetNPer1000: 0.5 }),
]);

// The key of the line note a reduced nitrogen bag carries (plan gateNotes), so the Fast Complete sheet can pick that one note out.
const FUNGUS_NITROGEN_NOTE_KEY = 'activeFungusNitrogen';

// GATE_LAWN_RECLAIMED_HALF_N (owner 2026-10-05 and 2026-10-23): a lawn watered with reclaimed water gets half the nitrogen at every
// N visit. A fraction of the visit's own target, not a table: it applies to every v13 visit that states a nitrogen target above
// zero, except a visit whose bag is a pre-emergent plus fertilizer (the pre-emergent rate matters, so that bag keeps its rate).
// When the November large-patch cut also applies, the SMALLER target wins (the two reasons are not added: each caps the same
// target, and half of 0.75 lb N, 0.375, already sits under the large-patch 0.5).
const RECLAIMED_N_FRACTION = 0.5;
const RECLAIMED_NITROGEN_NOTE_KEY = 'reclaimedNitrogen';

module.exports = { V13_TROUBLE_N_TARGETS, FUNGUS_NITROGEN_NOTE_KEY, RECLAIMED_N_FRACTION, RECLAIMED_NITROGEN_NOTE_KEY };
