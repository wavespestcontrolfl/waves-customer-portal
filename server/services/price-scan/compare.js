// Pure opportunity computation: is any scanned vendor DELIVERED price (price + shipping)
// cheaper than the SiteOne baseline, on a normalized $/oz basis? No I/O — unit-tested.
//
// Landed price = sticker price + shipping.amount (see shipping-rules.js). Ranking, the
// savings figures and the isOpportunity gate all use landed prices on both sides, so a
// cheaper sticker price that loses after shipping is NOT an opportunity. `perOz` stays the
// STICKER $/oz (backward compatible); `landedPerOz` is the delivered basis. An 'estimated'
// shipping basis may still win — it stays labelled on best.shipping for every consumer.

const { deriveNormalizedUnitPrice, quantityToOz } = require('./extract');
const { shippingFor } = require('./shipping-rules');

const DEFAULTS = {
  minSavingsPct: 0.02, // 2%
  minSavingsUsd: 1.0, // $1 on a baseline-size purchase
  excludeUnavailable: true,
};

// Availability states that aren't buyable now — never the basis for a savings
// alert. limited / unknown stay eligible (limited is buyable; unknown can't be
// proven unavailable).
const UNAVAILABLE = new Set(['out_of_stock', 'backorder']);

const round2 = (n) => Math.round(Number(n) * 100) / 100;

// A shipping object the caller already attached ({ amount, basis }) wins; otherwise the
// vendor's rule is looked up from the candidate's own host (source_url / website / url) or,
// failing any host, its display name. `free_shipping` / `freeShipping` is the adapter's
// per-item "ships free" flag (used only by flagged-free vendors).
function shippingOfCandidate(c) {
  if (c && c.shipping && Number.isFinite(Number(c.shipping.amount)) && c.shipping.basis) {
    return { amount: round2(c.shipping.amount), basis: c.shipping.basis, note: c.shipping.note || '' };
  }
  return shippingFor({
    vendor: c,
    vendorName: c && typeof c.vendor === 'string' ? c.vendor : undefined,
    price: c && c.price,
    quantity: c && c.quantity,
    freeShipping: !!(c && (c.free_shipping === true || c.freeShipping === true)),
    hazmat: !!(c && (c.hazmat_shipping === true || c.hazmat === true)),
  });
}

// Attach perOz (sticker), shipping, landedPrice and landedPerOz to each candidate, drop
// unparseable / out-of-stock / non-USD, sort cheapest DELIVERED first. A raw extractor
// offer can carry a non-USD currency; its amount must NOT be ranked as USD against the USD
// SiteOne baseline.
function rankCandidates(candidates, { excludeUnavailable = true } = {}) {
  return (candidates || [])
    .filter((c) => !c.currency || String(c.currency).toUpperCase() === 'USD')
    .map((c) => {
      const perOz = deriveNormalizedUnitPrice(c.price, c.quantity);
      const shipping = shippingOfCandidate(c);
      const landedPrice = round2(Number(c.price) + shipping.amount);
      return { ...c, perOz, shipping, landedPrice, landedPerOz: deriveNormalizedUnitPrice(landedPrice, c.quantity) };
    })
    .filter((c) => c.perOz != null && c.perOz > 0 && c.landedPerOz != null && c.landedPerOz > 0)
    .filter((c) => !(excludeUnavailable && isUnavailable(c)))
    .sort((a, b) => a.landedPerOz - b.landedPerOz);
}

// The two field names a candidate may carry availability under: `availability`
// straight off the extractor (extract.js) or `availability_status` once it's a
// /report-shaped candidate. Tolerate both so a raw extractor offer can't slip an
// unbuyable (sold-out / backordered) item into the ranking.
function isUnavailable(c) {
  return UNAVAILABLE.has(c.availability_status) || UNAVAILABLE.has(c.availability);
}

// baseline:   { price, quantity, vendor, shipping? }   (SiteOne — what Adam pays today;
//             shipping defaults to SiteOne's rule: free)
// candidates: [{ price, quantity, vendor, source_url, availability_status|availability }]
function findOpportunity(baseline, candidates, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const baseShipping = baseline
    ? shippingOfCandidate({ vendor: 'SiteOne', vendor_host: 'siteone.com', ...baseline })
    : null;
  const baseLanded = baseline && baseShipping ? round2(Number(baseline.price) + baseShipping.amount) : null;
  // Sticker $/oz is kept on baseline.perOz (backward compatible); the comparison uses landed.
  const basePerOzSticker = deriveNormalizedUnitPrice(baseline && baseline.price, baseline && baseline.quantity);
  const basePerOz = baseLanded != null ? deriveNormalizedUnitPrice(baseLanded, baseline.quantity) : null;
  const baseSizeOz = baseline ? quantityToOz(baseline.quantity) : null;
  const ranked = rankCandidates(candidates, cfg);

  const result = {
    isOpportunity: false,
    baseline: baseline
      ? { ...baseline, perOz: basePerOzSticker, shipping: baseShipping, landedPrice: baseLanded, landedPerOz: basePerOz }
      : null,
    best: null,
    ranked,
    savingsPerOz: 0,
    savingsPct: 0,
    estSavingsOnBaseline: null,
  };

  if (basePerOz == null || !ranked.length) return result;

  const best = ranked[0];
  result.best = best;
  if (best.landedPerOz < basePerOz) {
    const savingsPerOz = basePerOz - best.landedPerOz;
    const savingsPct = savingsPerOz / basePerOz;
    const estSavingsOnBaseline = baseSizeOz
      ? Math.round(savingsPerOz * baseSizeOz * 100) / 100
      : null;
    result.savingsPerOz = Math.round(savingsPerOz * 1e6) / 1e6;
    result.savingsPct = Math.round(savingsPct * 1e4) / 1e4;
    result.estSavingsOnBaseline = estSavingsOnBaseline;
    result.isOpportunity = savingsPct >= cfg.minSavingsPct
      && (estSavingsOnBaseline == null || estSavingsOnBaseline >= cfg.minSavingsUsd);
  }
  return result;
}

module.exports = {
  shippingOfCandidate, DEFAULTS, UNAVAILABLE, isUnavailable, rankCandidates, findOpportunity,
};
