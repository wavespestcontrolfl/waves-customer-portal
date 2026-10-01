/**
 * Cockroach `work_completed` derived from the visit's recorded product rows.
 *
 * Owner ruling 2026-09-26 (report-completion-sync plan Step 2): the tech no
 * longer taps "Work completed today" chips on the cockroach Complete Service
 * form — the products the tech recorded ARE the work record. The field stays
 * on the typed schema as `autoFilled: true` (hidden from the form, the Tree &
 * Shrub `treatments_completed` precedent) and complete-scheduled-service.js
 * fills it from the SUBMITTED product rows before the typed snapshot freezes.
 * Everything downstream (the report's "What we did", Today's Result, treatment
 * / re-entry evidence, trace eligibility, the AI writer's typed prompt) keeps
 * reading the same chip vocabulary it always read, and the public report
 * payload shape does not change.
 *
 * Pure: no DB, no I/O. Every line traces to a recorded row fact; an
 * unrecognised product yields NO chip — never a claim without a recorded fact.
 *
 *   bait            row method bait_placement, a bait/gel catalog category, or
 *                   the Advion gel-bait name  → "Bait placement"
 *   IGR             an IGR catalog category, a growth-regulator active
 *                   (hydroprene, pyriproxyfen, methoprene, novaluron), or the
 *                   Gentrol / Tekko name      → "Insect growth regulator"
 *   dust            "dust" in the product name / category → "Dust application"
 *   Alpine          the Alpine name / dinotefuran active → "Crack & crevice
 *                   treatment" (+ "Exterior perimeter treatment" when the
 *                   row's application AREA is an exterior chip; an exterior
 *                   row whose method is not a spot/crack method reads
 *                   perimeter only)
 *   other pesticide with an exterior application area → "Exterior perimeter"
 *                   (only when nothing above matched)
 *
 * A row keeps every action it matches: a combination product does more than
 * one job (Vendetta Plus is a bait carrying pyriproxyfen, an IGR → "Bait
 * placement" and "Insect growth regulator").
 *
 * Exterior evidence is the row's application AREA (a controlled chip the tech
 * picks), never the stored method: the completion path stores 'perimeter_spray'
 * as the DEFAULT method for any methodless pest product, so the method alone is
 * a guess, not a recorded fact.
 */

const { isExteriorApplicationArea } = require('./pest-report-expectations');

// The chip labels the cockroach form's `work_completed` field offers.
const DERIVED_WORK_CHIPS = Object.freeze({
  bait: 'Bait placement',
  igr: 'Insect growth regulator',
  crack: 'Crack & crevice treatment',
  dust: 'Dust application',
  exterior: 'Exterior perimeter treatment',
});
const DERIVED_WORK_ORDER = Object.freeze(['bait', 'igr', 'crack', 'dust', 'exterior']);

// Rows that are not a roach treatment at all: adjuvants, nutrients, other
// pest classes' devices (rodent / termite / mole stations, glue and traps).
const NOT_ROACH_TREATMENT_RE = /adjuvant|surfactant|wetting|fertiliz|herbicide|fungicide|biostim|nutrient|rodent|mole\b|termite|station|cartridge|monitor|glue|trap/i;
const BAIT_ROW_RE = /\bbait\b|\bgel\b/i;
const BAIT_NAME_RE = /gel bait|(?:cockroach|roach) gel/i;
const IGR_ROW_RE = /\bigr\b|growth regulator/i;
const IGR_ACTIVE_RE = /hydroprene|pyriproxyfen|methoprene|novaluron|kinoprene/i;
const IGR_NAME_RE = /\bgentrol\b|\btekko\b/i;
const DUST_ROW_RE = /\bdust\b/i;
const ALPINE_ROW_RE = /\balpine\b|dinotefuran/i;
const SPOT_METHOD_RE = /^(?:spot_treatment|crack_crevice|crack_and_crevice|void_injection)$/;
const PESTICIDE_CLASS_RE = /pestic|insectic|[a-z]*cide\b/i;

/**
 * One product row → derived work keys.
 * @param {{ name?: string, category?: string, productType?: string,
 *   activeIngredient?: string, method?: string, applicationArea?: string }} row
 * @returns {string[]} keys of DERIVED_WORK_CHIPS
 */
function workKeysForProductRow(row = {}) {
  const name = String(row.name || '').trim();
  const category = String(row.category || '').trim();
  const productType = String(row.productType || '').trim();
  const activeIngredient = String(row.activeIngredient || '').trim();
  if (!name && !category) return [];
  const method = String(row.method || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const identity = `${name} ${category} ${productType}`;
  if (NOT_ROACH_TREATMENT_RE.test(identity)) return [];
  const exterior = isExteriorApplicationArea(row.applicationArea);
  const classText = `${category} ${productType}`;
  const keys = [];
  if (method === 'bait_placement' || BAIT_ROW_RE.test(classText) || BAIT_NAME_RE.test(name)) keys.push('bait');
  if (IGR_ROW_RE.test(classText) || IGR_ACTIVE_RE.test(activeIngredient) || IGR_NAME_RE.test(name)) keys.push('igr');
  if (DUST_ROW_RE.test(identity)) keys.push('dust');
  if (ALPINE_ROW_RE.test(`${name} ${activeIngredient}`)) {
    if (!exterior) keys.push('crack');
    else keys.push(...(SPOT_METHOD_RE.test(method) ? ['crack', 'exterior'] : ['exterior']));
  }
  if (keys.length) return keys;
  // Any other pesticide row speaks only through a recorded exterior area.
  return exterior && PESTICIDE_CLASS_RE.test(classText) ? ['exterior'] : [];
}

/**
 * Work chips (the form's option labels, canonical order, de-duplicated)
 * derived from a visit's product rows. Empty for a null / empty / all-unknown
 * set — the caller then leaves the field absent.
 * @param {Array<Object>} rows see workKeysForProductRow
 * @returns {string[]}
 */
function deriveCockroachWorkChips(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const keys = new Set();
  for (const row of rows) for (const key of workKeysForProductRow(row)) keys.add(key);
  return DERIVED_WORK_ORDER.filter((key) => keys.has(key)).map((key) => DERIVED_WORK_CHIPS[key]);
}

module.exports = {
  DERIVED_WORK_CHIPS,
  workKeysForProductRow,
  deriveCockroachWorkChips,
};
