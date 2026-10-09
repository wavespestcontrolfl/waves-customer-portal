/**
 * The target of a spot fungicide or insecticide row on the lawn Fast Complete sheet (owner 2026-10-09).
 *
 * Why: the lawn "What to expect" line reads CURATIVE ("works on the problem") only from a tagged target, a named issue or a
 * finding-to-product tie (service-report/lawn-expectations.js isCurative); with none of them a spot fungicide or insecticide
 * applied to a found problem printed the protective "nothing changes visibly" line. The full form sets the tag from its picker
 * (service_products.targets, the controlled vocabulary in config/treatment-target-vocabulary.js); the sheet sent none.
 *
 * ONE source for "what was this spot for": the trouble-area type (lawn-trouble-areas.js troubleTypeFor, confirmed by the server's
 * staged sets) decides, and the target follows it. A target is stored only when it agrees with that type:
 *   chinch      the row is a chinch rung the server confirms (Arena always, a shared rung such as Talak when the chinch entry
 *               opened it): the target is "Southern chinch bugs" with no tap.
 *   take_all    the month's take-all fungicide: only the optional "Take-all root rot" (the program treats mapped take-all
 *               areas preventively, so this module never sets it on its own).
 *   fungus      a fungicide row: any fungicide target of the vocabulary except take-all.
 *   other_insect an insecticide row: any insect target except chinch.
 * The closed lists come from TARGET_CLASS_BY_NAME (lawn-expectations config), the table the expectations engine reads, so a name
 * the engine does not know can never be offered or stored. Technician surface and the record only: the customer sentences are the
 * existing approved ones (the expectations rows, the product card's purpose line).
 *
 * Fail closed: when the staged sets cannot be read nothing is stored. All of it is behind GATE_LAWN_SPOT_TARGET (dark; live only
 * while the treatment guide is): with the gate off nothing here is read and the completion stores the row's own tags as before.
 */
const logger = require('./logger');
const { TARGET_CLASS_BY_NAME, FAMILY } = require('../config/lawn-expectations');

const CHINCH_TARGET = 'Southern chinch bugs';
const TAKE_ALL_TARGET = 'Take-all root rot';

// The vocabulary names of one family that a spot row of that catalog category may carry.
const namesOf = (family) => Object.entries(TARGET_CLASS_BY_NAME).filter(([, cls]) => cls && cls.family === family).map(([name]) => name);
const FUNGICIDE_NAMES = Object.freeze(namesOf(FAMILY.FUNGICIDE));
const INSECTICIDE_NAMES = Object.freeze(namesOf(FAMILY.INSECTICIDE));
const NAMES_BY_CATEGORY = Object.freeze({ fungicide: FUNGICIDE_NAMES, insecticide: INSECTICIDE_NAMES });

// The trouble-area type a target stands for (the same ids as lawn-trouble-areas TYPES).
function typeOfTarget(target) {
  if (target === CHINCH_TARGET) return 'chinch';
  if (target === TAKE_ALL_TARGET) return 'take_all';
  if (FUNGICIDE_NAMES.includes(target)) return 'fungus';
  if (INSECTICIDE_NAMES.includes(target)) return 'other_insect';
  return null;
}

const categoryOf = (value) => String(value || '').trim().toLowerCase();
const isTargetCategory = (category) => Object.prototype.hasOwnProperty.call(NAMES_BY_CATEGORY, category);

/**
 * The target a spot row is stored with, given the server's trouble type for it: `[]` or `[name]`. `requested` is what the sheet sent.
 * Pure. A chinch row always carries the chinch target (the type says what the spot is for); any other type stores the requested name
 * only when it is on the category's closed list AND stands for that same type.
 */
function targetsFor({ category, type, requested }) {
  const cat = categoryOf(category);
  if (!isTargetCategory(cat)) return [];
  if (type === 'chinch') return [CHINCH_TARGET];
  const name = typeof requested === 'string' ? requested.trim() : '';
  if (!name || !NAMES_BY_CATEGORY[cat].includes(name)) return [];
  return typeOfTarget(name) === type ? [name] : [];
}

/** `{ spotTargets }` for the context while GATE_LAWN_SPOT_TARGET is live, else `{}` (no key at all). */
const contextKey = (live = () => require('../config/feature-gates').lawnSpotTargetLive()) => (live() ? { spotTargets: contextBlock() } : {});

/**
 * The context block the sheet reads (technician surface): the closed lists and the two names the server ties to a type.
 * `{ v: 1, fungicide: [...], insecticide: [...], chinch, takeAll }`.
 */
function contextBlock() {
  return { v: 1, fungicide: [...FUNGICIDE_NAMES], insecticide: [...INSECTICIDE_NAMES], chinch: CHINCH_TARGET, takeAll: TAKE_ALL_TARGET };
}

const lowerId = (value) => String(value || '').toLowerCase();
const ownTags = (row) => (Array.isArray(row?.targets) ? row.targets : []);

/**
 * The stored targets for a completion's rows: `{ of(row) }`, where `of` answers the tags a row is stored with. For a spot fungicide
 * or insecticide row of a Lawn Fast Complete completion (a `lawnFast` block, GATE_LAWN_SPOT_TARGET live) that is the server's verdict
 * (`[]` or `[name]`); for every other row it is the row's own tags, exactly as before. The staged sets are read once, only when a
 * candidate row exists. The sheet's `troubleType` / `targetFind` are hints: the server's `confirm()` sets decide (troubleTypeFor).
 * `catalog` is the completion's catalog map, `canonicalId` and `inferMethod` the completion's own functions.
 */
async function resolveForCompletion({ rows, lawnFast, catalog, canonicalId, inferMethod, serviceLine, confirm, live = () => require('../config/feature-gates').lawnSpotTargetLive() }) {
  const verdict = new Map();
  const result = { of: (row) => verdict.get(lowerId(row?.productId)) || ownTags(row) };
  if (lawnFast == null || !live()) return result;
  const product = (row) => catalog.get(canonicalId(row.productId)) || {};
  const candidates = (Array.isArray(rows) ? rows : []).filter((row) => row && row.productId
    && isTargetCategory(categoryOf(product(row).category)) && inferMethod(product(row), row, serviceLine) === 'spot_treatment');
  if (!candidates.length) return result;
  let sets = null;
  try {
    sets = await confirm();
  } catch (err) {
    logger.warn(`[lawn-spot-target] staged sets unavailable: no target stored (${err?.code || err?.name || 'Error'})`);
  }
  const { troubleTypeFor } = require('./lawn-trouble-areas');
  for (const row of candidates) {
    const id = lowerId(row.productId);
    const category = product(row).category;
    const type = !sets ? null : troubleTypeFor({
      category, hint: row.troubleType || (row.targetFind === 'chinch' ? 'chinch' : null), takeAll: sets.takeAll.has(id), chinch: sets.chinch.has(id), chinchOnly: sets.chinchOnly.has(id),
    });
    verdict.set(id, targetsFor({ category, type, requested: ownTags(row).find((tag) => typeof tag === 'string') }));
  }
  return result;
}

module.exports = {
  CHINCH_TARGET,
  TAKE_ALL_TARGET,
  FUNGICIDE_NAMES,
  INSECTICIDE_NAMES,
  typeOfTarget,
  targetsFor,
  contextBlock,
  contextKey,
  resolveForCompletion,
};
