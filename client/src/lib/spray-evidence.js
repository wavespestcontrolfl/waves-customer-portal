// client/src/lib/spray-evidence.js
//
// "Was something sprayed?" for a visit being completed: the evidence that keeps a bait-station or
// inspection visit's re-entry countdown, so the stepper seeds are asked for with applicationsRecorded=1
// (GET /admin/dispatch/:id/reentry-defaults). Moved out of the Complete Service form (SchedulePage.jsx)
// unchanged so the Fast Complete sheets ask the server the same question the form does. It mirrors the
// server's isSprayApplicationMethod and isNonBaitPesticideProduct (service-report/service-line-configs.js).
//
// A product counts when its application method is set and not a bait placement, station check or trunk
// injection, OR its identity is a non-bait pesticide: a pesticide-class category or catalog type, an EPA
// registration number on the catalog row, or a listed active ingredient (even under the defaulted
// station_check the panel gives a methodless termite product: codex inline r10 on #3516). Bait, station,
// cartridge and monitor families never count by identity. A protocol action counts when it applied a
// treatment that leaves a dry-down.
const NON_SPRAY_METHODS = ['bait_placement', 'station_check', 'trunk_injection'];
const BAIT_FAMILY_RE = /bait|station|cartridge|monitor/i;
const PESTICIDE_CLASS_RE = /pestic|termitic|insectic|herbic|fungic|rodentic/i;

const methodKeyOf = (method) => String(method || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');

/** A method that is set and is not a bait placement, station check or trunk injection. */
export function hasSprayMethod(method) {
  const key = methodKeyOf(method);
  return !!key && !NON_SPRAY_METHODS.includes(key);
}

/** { category, name, activeIngredient, productType, epaRegNumber }: a non-bait pesticide by identity. */
export function isNonBaitPesticide({ category, name, activeIngredient, productType, epaRegNumber } = {}) {
  if (BAIT_FAMILY_RE.test(`${category || ''} ${productType || ''} ${name || ''}`)) return false;
  return PESTICIDE_CLASS_RE.test(`${category || ''} ${productType || ''}`)
    || !!String(epaRegNumber || '').trim()
    || !!String(activeIngredient || '').trim();
}

/** A protocol action's scope: it applied a treatment that leaves a dry-down. */
export const actionShowsSpray = (scope) => scope?.treatmentApplied === true && scope?.dryDown !== false;

/**
 * `products`: [{ method, category, name, activeIngredient, productType, epaRegNumber }];
 * `actionScopes`: the scope ({ treatmentApplied, dryDown }) of each protocol action recorded.
 */
export function sprayEvidence({ products = [], actionScopes = [] } = {}) {
  return products.some((product) => hasSprayMethod(product?.method) || isNonBaitPesticide(product))
    || actionScopes.some(actionShowsSpray);
}

/** The full form's selected product, with the catalog row's type and EPA number found by product id. */
export function sprayProductFromSelection(selected, catalog) {
  const catalogRow = (catalog || []).find((row) => String(row.id) === String(selected?.productId)) || {};
  return {
    method: selected?.applicationMethod || selected?.method,
    category: selected?.category,
    name: selected?.name,
    activeIngredient: selected?.activeIngredient,
    productType: catalogRow.product_type,
    epaRegNumber: catalogRow.epa_reg_number,
  };
}

/**
 * A Fast Complete sheet row ({ name, product: the catalog row it was added from }) at the method it
 * will be recorded with. A sheet's catalog may lack product_type or epa_reg_number: what it does not
 * carry cannot count.
 */
export function sprayProductFromRow(row, method) {
  const product = row?.product || {};
  return {
    method,
    category: product.category,
    name: row?.name || product.name,
    activeIngredient: product.active_ingredient,
    productType: product.product_type,
    epaRegNumber: product.epa_reg_number,
  };
}

/** Whether the rows on a sheet show spray evidence; `methodOf(row)` is the method each is recorded with. */
export const rowsShowSpray = (rows, methodOf) => sprayEvidence({ products: rows.map((row) => sprayProductFromRow(row, methodOf(row))) });
