// client/src/lib/measure-units.js
//
// Truck measures for what a tech enters on a completion (owner ruling
// 2026-09-27; every service 2026-09-29): nothing is in mL. A liquid is
// measured in tsp (the spoon set, 6 to the fl oz) under 1 fl oz, otherwise
// in fl oz or gal. The server keeps no tsp (shared/rate-units.json), so a
// tsp amount is sent as fl oz. The catalog keeps a label's own mL figure;
// completion forms never prefill or offer it.
export const TSP_PER_FL_OZ = 6;
const FL_OZ_PER_ML = 0.033814;

/** A unit whose base is mL: "ml", "mL/gal", "ml/inch dbh", "milliliters", "cc". */
export function isMlUnit(unit) {
  const base = String(unit || "").split("/")[0].trim().toLowerCase();
  return base === "ml" || base === "cc" || /^millilit(er|re)s?$/.test(base);
}

/**
 * Free text that states an amount in mL ("20 mL", "20ml", "5 cc",
 * "2 milliliters"), such as the injection record's dose. Mirrors
 * ML_AMOUNT_TEXT in server/services/tree-shrub-closeout.js.
 */
export function hasMlAmount(text) {
  return /(?:^|[^a-z])(?:ml|mls|milliliters?|millilitres?|cc)(?![a-z])/i.test(String(text || ""));
}

/** An mL amount in fl oz, at the three decimals the record keeps. */
export function mlToFlOz(amount) {
  const n = Number(amount);
  return Number.isFinite(n) ? Math.round(n * FL_OZ_PER_ML * 1000) / 1000 : amount;
}

/**
 * What /complete receives for an amount the tech entered. A tsp amount goes
 * as fl oz, rounded UP to the three decimals service_products.total_amount
 * keeps, so it reads back as the same spoons (½ tsp is 0.084, never 0.083,
 * which reads "0.083 fl oz"); it overstates by under 0.001 fl oz. A blank
 * tsp amount stays blank (never a 0 the server would refuse).
 */
export function submittedAmount(amount, unit) {
  if (unit === "tsp") {
    if (amount === "" || amount == null) return { totalAmount: amount, amountUnit: "fl_oz" };
    return { totalAmount: Math.ceil((Number(amount) / TSP_PER_FL_OZ) * 1000 - 1e-9) / 1000, amountUnit: "fl_oz" };
  }
  return { totalAmount: Number(amount), amountUnit: unit };
}
