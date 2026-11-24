'use strict';

// Taurus SC (EPA 53883-279): the concentration of one application, 'high' (0.06%) or 'low' (0.03%).
//
// One rule for the yearly label count (server/services/taurus-yearly-count.js, on a saved compliance-ledger
// row) and the close-out warning (client/src/lib/taurus-yearly-limit.js, on a row being entered, or a reopened
// recap's recorded row), so the two never read the same application differently.
//
// Owner ruling 2026-11-19, "A": the house mix is 1.6 fl oz per 4-gal tank = 0.4 fl oz/gal = 0.03%. Before it
// the owner mixed 3.2 fl oz per 4 gal (0.06%). In order:
//   1. A recorded dilution decides, on any date. Only an explicit percentage ("0.06%") is a dilution: the
//      ledger column is text, and other text ("0.4 fl oz/gal", a range, a bare number) is not read as one.
//   2. Else a per-gallon rate (a volume of product per gal, or per 100 gal) decides: above 0.4 fl oz/gal is
//      0.06%. Before the ruling a rate at or under 0.4 is 0.03% only while the recorded amount of product is
//      not above the house mix: the old close-out sheets seeded a per-gallon rate from the catalog, not from
//      the tank (the old Fast Complete sheet saved its 4 fl oz house total with a 0.2 fl oz/gal spot rate).
//   3. Else, before the ruling: 0.06%, the owner's mix then.
//   4. Else an amount of product above the 1.6 fl oz house mix (the recorded amount, or a bare volume rate
//      that is the tank amount) is the old 0.06% tank: one 4-gal tank per home.

// The first application date counted at 0.03% unless the row says otherwise (the ruling took effect 11-19).
const TAURUS_LOW_RATE_SINCE = '2026-11-20';
// 1.6 fl oz per 4 gal: the house concentration and the house amount.
const LOW_RATE_MAX_FL_OZ_PER_GAL = 0.4;
const HOUSE_TAURUS_FL_OZ = 1.6;
const HIGH_DILUTION_PERCENT = 0.06;
const TSP_PER_FL_OZ = 6;
// Float slack for converted amounts (9.6 tsp is 1.5999999999999999 fl oz).
const FL_OZ_EPSILON = 1e-6;
// A value is saved to 3 decimals in its own unit: quantity_applied decimal(8,3) (0.0125 gal is saved as 0.013 gal,
// 1.664 fl oz), and a rate through service_products.application_rate decimal(8,3), which the recap copies to the
// ledger. A value within half its last stored decimal of the house mix is the house mix, at entry and once saved.
const STORED_DECIMALS = { amount: 3, rate: 3 };

// fl oz in one unit of a liquid amount of product: the volume units the completion API accepts
// (shared/rate-units.json: oz, fl_oz, ml, gal), at the factors of server/services/inventory-units.js, and the
// close-out sheet's tsp. Any other unit (g, lb, each) is no fl oz amount.
const FL_OZ_PER_UNIT = { oz: 1, fl_oz: 1, floz: 1, gal: 128, ml: 0.033814, tsp: 1 / TSP_PER_FL_OZ };

const unitKey = (unit) => String(unit ?? '').trim().toLowerCase().replace(/[\s.]+/g, '_');
const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * An amount of product in fl oz; 0 when it is not a positive volume. A missing unit is no volume unless
 * `nullUnitIsFlOz` (the close-out rows, whose amount box is in fl oz).
 */
function flOzAmount(value, unit, { nullUnitIsFlOz = false } = {}) {
  const n = positive(value);
  if (n == null) return 0;
  if (unit == null) return nullUnitIsFlOz ? n : 0;
  const factor = FL_OZ_PER_UNIT[unitKey(unit)];
  return factor ? n * factor : 0;
}

/** A per-gallon rate ("<volume>/gal" or "<volume>/100gal") in fl oz of product per gallon; null for any other. */
function flOzPerGal(value, unit) {
  const match = /^([a-z_]+)\/(100)?gal$/.exec(unitKey(unit));
  const factor = match ? FL_OZ_PER_UNIT[match[1]] : null;
  const n = positive(value);
  return factor && n != null ? (n * factor) / (match[2] ? 100 : 1) : null;
}

/** A fl oz (or oz) per gallon unit: the unit the house Taurus row's 0.4 seed is written in. */
const isFlOzPerGalUnit = (unit) => /^(fl_oz|floz|oz)\/gal$/.test(unitKey(unit));

/** An explicit percentage dilution ("0.06%", "0.1 %") as a number; null for any other text. */
function dilutionPercent(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(String(text ?? ''));
  return match ? positive(match[1]) : null;
}

/** Whether a fl oz amount is the 1.6 fl oz house mix. */
const isHouseTaurusFlOz = (flOz) => Math.abs(flOz - HOUSE_TAURUS_FL_OZ) < FL_OZ_EPSILON;
/** Whether an amount of product is more than the house mix, beyond the ledger's rounding of that column in its unit. */
function aboveHouse(value, unit, { decimals, nullUnitIsFlOz = false }) {
  const flOz = flOzAmount(value, unit, { nullUnitIsFlOz });
  const flOzPerUnit = (unit == null ? null : FL_OZ_PER_UNIT[unitKey(unit)]) || 1;
  return flOz - HOUSE_TAURUS_FL_OZ > 0.5 * 10 ** -decimals * flOzPerUnit + FL_OZ_EPSILON;
}

/**
 * @param {object} application
 * @param {*} [application.dilution]    the recorded dilution (text)
 * @param {*} [application.rate]        the recorded application rate, with its rateUnit
 * @param {*} [application.amount]      the recorded amount of product, with its amountUnit
 * @param {boolean} [application.beforeRuling]  dated before TAURUS_LOW_RATE_SINCE
 * @param {boolean} [application.nullAmountUnitIsFlOz]  an amount with no unit is fl oz (see flOzAmount)
 * @returns {'high'|'low'}
 */
function taurusConcentration({
  dilution, rate, rateUnit, amount, amountUnit, beforeRuling = false, nullAmountUnitIsFlOz = false,
} = {}) {
  const percent = dilutionPercent(dilution);
  if (percent != null) return percent >= HIGH_DILUTION_PERCENT ? 'high' : 'low';
  const amountAboveHouse = aboveHouse(amount, amountUnit, { decimals: STORED_DECIMALS.amount, nullUnitIsFlOz: nullAmountUnitIsFlOz });
  const perGal = flOzPerGal(rate, rateUnit);
  if (perGal != null) {
    if (perGal - LOW_RATE_MAX_FL_OZ_PER_GAL > FL_OZ_EPSILON) return 'high';
    return beforeRuling && amountAboveHouse ? 'high' : 'low';
  }
  if (beforeRuling) return 'high';
  return amountAboveHouse || aboveHouse(rate, rateUnit, { decimals: STORED_DECIMALS.rate }) ? 'high' : 'low';
}

module.exports = {
  TAURUS_LOW_RATE_SINCE,
  LOW_RATE_MAX_FL_OZ_PER_GAL,
  HOUSE_TAURUS_FL_OZ,
  HIGH_DILUTION_PERCENT,
  FL_OZ_PER_UNIT,
  flOzAmount,
  flOzPerGal,
  isFlOzPerGalUnit,
  dilutionPercent,
  isHouseTaurusFlOz,
  taurusConcentration,
};
