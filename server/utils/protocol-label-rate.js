'use strict';

// A protocol line may carry its product label's own per-gallon rate for THIS pest (lineMeta.labelRatePerGallon:
// { amount, unit, use, epa }), where the catalog row holds the label's rate for another pest (Tekko Pro: 1 fl oz per
// gallon in the catalog for fleas and flying insects, 2 for cockroaches). The rate belongs to one registered product,
// so it applies only when the product the line resolved to carries the same EPA registration number: a fuzzy name or
// alias match to another formulation keeps its own catalog rate. Every surface that doses or prefills the line (the
// job card's tank calculator, the completion product defaults, the completion actions) reads it through here.
//
// A line may also mix BELOW the label's dilution (weakerMix: true): the flea card's Tekko Pro at 0.66, because its shared
// tank goes out at more water per area. There the catalog rate is the stronger one, so two more checks apply:
//   - the card rate governs only while it is at or under the top of the row's own per-gallon catalog band. A row whose
//     band is weaker keeps its band;
//   - a row with another or no registration number gets no rate at all (labelRateHeld): neither the card's, which is not
//     verified for that product, nor the catalog's stronger one. The tank calculator withholds the dose and the close-out
//     starts the rate blank. The same holds for a row whose catalog rate cannot be compared with the card's (not per
//     gallon in the card's unit, or not a plain number or band).

function normalizeEpa(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/\s+/g, '');
}

function sameRegistration(declared, product) {
  const epa = normalizeEpa(declared?.epa);
  return Boolean(epa) && normalizeEpa(product?.epa_reg_number ?? product?.epaRegNumber) === epa;
}

function catalogUnit(product) {
  return String(product?.default_unit ?? product?.defaultUnit ?? '').toLowerCase().replace(/\s+/g, '');
}

// The top of the product's catalog default_rate band ("1" -> 1, "0.25-1.5" -> 1.5) when the catalog keeps it per gallon in this
// unit ("fl_oz/gal"), else null. The whole string must be a number or a band, as in the tank calculator (job-card.js
// perGallonRate): "1/2" is not read as 1.
function catalogPerGallonTop(product, unit) {
  if (catalogUnit(product) !== `${String(unit).toLowerCase()}/gal`) return null;
  const band = String(product?.default_rate ?? product?.defaultRate ?? '').trim().match(/^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/);
  if (!band) return null;
  const lo = Number(band[1]);
  const hi = band[2] != null ? Number(band[2]) : lo;
  return lo > 0 ? Math.max(lo, hi) : null;
}

// { amount, unit } when the line declares a label rate for this product, else null.
function labelUseRate(meta, product) {
  const declared = meta?.labelRatePerGallon;
  const amount = Number(declared?.amount);
  if (!(amount > 0) || !Number.isFinite(amount) || !declared?.unit) return null;
  if (!sameRegistration(declared, product)) return null;
  if (declared.weakerMix === true) {
    const top = catalogPerGallonTop(product, declared.unit);
    if (top == null || amount > top) return null;
  }
  return { amount, unit: String(declared.unit) };
}

// The spray volume the line's label rate is stated over, in gallons per 1,000 sq ft (labelRatePerGallon.carrierGalPer1000),
// when the line's label rate applies to this product; else null. A per-gallon rate is a label amount per area only at that
// volume: Tekko Pro on cockroaches is 2 fl oz per gallon at 1 gallon per 1,000 sq ft, so a sprayer that puts out 2 gallons
// per 1,000 sq ft would put down twice the label amount from the same mix.
function labelRateCarrier(meta, product) {
  if (!labelUseRate(meta, product)) return null;
  const carrier = Number(meta?.labelRatePerGallon?.carrierGalPer1000);
  return carrier > 0 && Number.isFinite(carrier) ? carrier : null;
}

// Why a weaker-mix line gives this row no rate at all, or null: 'registration' (another or no EPA number) or 'catalog_rate'
// (the row's catalog rate cannot be compared with the card's).
function labelRateHeld(meta, product) {
  const declared = meta?.labelRatePerGallon;
  if (declared?.weakerMix !== true) return null;
  if (!sameRegistration(declared, product)) return 'registration';
  return catalogPerGallonTop(product, declared.unit) == null ? 'catalog_rate' : null;
}

// The reason the tank search shows for a held line.
function labelRateHoldText(meta, product) {
  const held = labelRateHeld(meta, product);
  if (!held) return null;
  return held === 'registration'
    ? `The card's rate is for EPA ${meta.labelRatePerGallon.epa}. This product's registration number is not that one: read the bottle's label before mixing`
    : "This product's catalog rate cannot be checked against the card's rate: read the bottle's label before mixing";
}

// The completion form reads its per-gallon prefill and its review ceiling from the catalog's default_rate band
// (client/src/lib/product-rate-prefill.js). For a line with a label rate, both become that rate, but only when the
// catalog keeps the band in the same per-gallon unit ("fl_oz/gal"); any other unit is left unchanged.
function completionRateFields(meta, product) {
  // A held weaker-mix line starts blank, with no ceiling and whatever the catalog unit, so the tech reads the bottle and enters
  // what went out. The client clears the row's per-1,000 rate too (protocol-completion-defaults.js labelUseProduct).
  if (labelRateHeld(meta, product)) return { defaultRate: '', labelUseRate: true };
  const rate = labelUseRate(meta, product);
  if (!rate) return null;
  if (catalogUnit(product) !== `${rate.unit.toLowerCase()}/gal`) return null;
  // labelUseRate tells the client the band is the card's own (client/src/lib/protocol-completion-defaults.js). A line another
  // booked card shares (sharedRate, completion-product-defaults.js labelRateFor) has no one rate: the rate starts blank, so the
  // tech enters what went out and no single ceiling applies.
  return { defaultRate: meta.sharedRate ? '' : String(rate.amount), labelUseRate: true };
}

// A line may declare its tank's own rate inside the catalog band (tankRatePerGallon: the bed bug card's Antapex at 20 g per
// gallon, where the catalog band is 10-30). The completion form starts a per-gallon rate at the bottom of the band, so the
// card's rate goes along as the START of the rate: the band's top stays the review ceiling. Only when the catalog keeps the
// band per gallon in the card's unit and the card's rate is not above its top (the job card's rule for a declared rate,
// job-card.js protocolBand). A line with a label rate has its own fields (completionRateFields); a line another booked
// card shares (sharedRate) has no one rate.
function cardStartRateFields(meta, product) {
  if (!meta || meta.labelRatePerGallon || meta.sharedRate) return null;
  const amount = Number(meta.tankRatePerGallon?.amount);
  const unit = meta.tankRatePerGallon?.unit;
  if (!(amount > 0) || !Number.isFinite(amount) || !unit) return null;
  const top = catalogPerGallonTop(product, unit);
  if (top == null || amount > top) return null;
  return { cardStartRate: amount };
}

module.exports = { labelUseRate, labelRateCarrier, labelRateHeld, labelRateHoldText, completionRateFields, cardStartRateFields, normalizeEpa };
