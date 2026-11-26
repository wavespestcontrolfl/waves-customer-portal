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

// The top of a catalog default_rate band ("1" -> 1, "0.25-1.5" -> 1.5), or null.
function catalogBandTop(product) {
  const parts = String(product?.default_rate ?? product?.defaultRate ?? '').split('-').map((part) => parseFloat(part)).filter((n) => Number.isFinite(n) && n > 0);
  return parts.length ? parts[parts.length - 1] : null;
}

// The completion form reads its per-gallon prefill and its review ceiling from the catalog's default_rate band
// (client/src/lib/product-rate-prefill.js: the band's low end prefills, its top is the ceiling). For a line with a label
// rate, only when the catalog keeps the band in the same per-gallon unit ("fl_oz/gal"); any other unit is left unchanged:
//   - a card rate above the catalog band (Tekko Pro at 2 on the cockroach card) becomes both the prefill and the ceiling;
//   - a card rate below it (Tekko Pro at 0.66 in the flea card's shared tank, sprayed at more water per area) is the
//     prefill only. The ceiling stays the catalog's label top, so the label's own dilution is not reviewed as above label.
function completionRateFields(meta, product) {
  const rate = labelUseRate(meta, product);
  if (!rate) return null;
  const unit = String(product?.default_unit ?? product?.defaultUnit ?? '').toLowerCase().replace(/\s+/g, '');
  if (unit !== `${rate.unit.toLowerCase()}/gal`) return null;
  // labelUseRate tells the client the band is the card's own (client/src/lib/protocol-completion-defaults.js). A line another
  // booked card shares (sharedRate, completion-product-defaults.js labelRateFor) has no one rate: the rate starts blank, so the
  // tech enters what went out and no single ceiling applies.
  if (meta.sharedRate) return { defaultRate: '', labelUseRate: true };
  const top = catalogBandTop(product);
  return { defaultRate: top != null && rate.amount < top ? `${rate.amount}-${top}` : String(rate.amount), labelUseRate: true };
}

module.exports = { labelUseRate, completionRateFields, normalizeEpa };
