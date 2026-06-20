// Pure opportunity computation: is any scanned vendor price cheaper than the
// SiteOne baseline, on a normalized $/oz basis? No I/O — unit-tested.

const { deriveNormalizedUnitPrice, quantityToOz } = require('./extract');

const DEFAULTS = {
  minSavingsPct: 0.02, // 2%
  minSavingsUsd: 1.0, // $1 on a baseline-size purchase
  excludeUnavailable: true,
};

// Availability states that aren't buyable now — never the basis for a savings
// alert. limited / unknown stay eligible (limited is buyable; unknown can't be
// proven unavailable).
const UNAVAILABLE = new Set(['out_of_stock', 'backorder']);

// Attach perOz to each candidate, drop unparseable / out-of-stock / non-USD,
// sort cheapest first. A raw extractor offer can carry a non-USD currency; its
// amount must NOT be ranked as USD against the USD SiteOne baseline.
function rankCandidates(candidates, { excludeUnavailable = true } = {}) {
  return (candidates || [])
    .filter((c) => !c.currency || String(c.currency).toUpperCase() === 'USD')
    .map((c) => ({ ...c, perOz: deriveNormalizedUnitPrice(c.price, c.quantity) }))
    .filter((c) => c.perOz != null && c.perOz > 0)
    .filter((c) => !(excludeUnavailable && isUnavailable(c)))
    .sort((a, b) => a.perOz - b.perOz);
}

// The two field names a candidate may carry availability under: `availability`
// straight off the extractor (extract.js) or `availability_status` once it's a
// /report-shaped candidate. Tolerate both so a raw extractor offer can't slip an
// unbuyable (sold-out / backordered) item into the ranking.
function isUnavailable(c) {
  return UNAVAILABLE.has(c.availability_status) || UNAVAILABLE.has(c.availability);
}

// baseline:   { price, quantity, vendor }   (SiteOne — what Adam pays today)
// candidates: [{ price, quantity, vendor, source_url, availability_status|availability }]
function findOpportunity(baseline, candidates, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const basePerOz = deriveNormalizedUnitPrice(baseline && baseline.price, baseline && baseline.quantity);
  const baseSizeOz = baseline ? quantityToOz(baseline.quantity) : null;
  const ranked = rankCandidates(candidates, cfg);

  const result = {
    isOpportunity: false,
    baseline: baseline ? { ...baseline, perOz: basePerOz } : null,
    best: null,
    ranked,
    savingsPerOz: 0,
    savingsPct: 0,
    estSavingsOnBaseline: null,
  };

  if (basePerOz == null || !ranked.length) return result;

  const best = ranked[0];
  result.best = best;
  if (best.perOz < basePerOz) {
    const savingsPerOz = basePerOz - best.perOz;
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
  DEFAULTS, UNAVAILABLE, isUnavailable, rankCandidates, findOpportunity,
};
