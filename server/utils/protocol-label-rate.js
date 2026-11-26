'use strict';

// A protocol line may carry its product label's own per-gallon rate for THIS pest (lineMeta.labelRatePerGallon:
// { amount, unit, use, epa }), where the catalog row holds the label's rate for another pest (Tekko Pro: 1 fl oz per
// gallon in the catalog for fleas and flying insects, 2 for cockroaches). The rate belongs to one registered product,
// so it applies only when the product the line resolved to carries the same EPA registration number: a fuzzy name or
// alias match to another formulation keeps its own catalog rate. Every surface that doses or prefills the line (the
// job card's tank calculator, the completion product defaults, the completion actions) reads it through here.

function normalizeEpa(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/\s+/g, '');
}

// { amount, unit } when the line declares a label rate for this product, else null.
function labelUseRate(meta, product) {
  const declared = meta?.labelRatePerGallon;
  const amount = Number(declared?.amount);
  if (!(amount > 0) || !declared?.unit) return null;
  const epa = normalizeEpa(declared.epa);
  if (!epa || normalizeEpa(product?.epa_reg_number ?? product?.epaRegNumber) !== epa) return null;
  return { amount, unit: String(declared.unit) };
}

// The completion form reads its per-gallon prefill and its review ceiling from the catalog's default_rate band
// (client/src/lib/product-rate-prefill.js). For a line with a label rate, both become that rate, but only when the
// catalog keeps the band in the same per-gallon unit ("fl_oz/gal"); any other unit is left unchanged.
function completionRateFields(meta, product) {
  const rate = labelUseRate(meta, product);
  if (!rate) return null;
  const unit = String(product?.default_unit ?? product?.defaultUnit ?? '').toLowerCase().replace(/\s+/g, '');
  if (unit !== `${rate.unit.toLowerCase()}/gal`) return null;
  // labelUseRate tells the client the band is the card's own (client/src/lib/protocol-completion-defaults.js). A line another
  // booked card shares (sharedRate, completion-product-defaults.js labelRateFor) has no one rate: the rate starts blank, so the
  // tech enters what went out and no single ceiling applies.
  return { defaultRate: meta.sharedRate ? '' : String(rate.amount), labelUseRate: true };
}

module.exports = { labelUseRate, completionRateFields, normalizeEpa };
