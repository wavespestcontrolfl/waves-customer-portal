// Pure opportunity computation: is any scanned vendor price cheaper than the
// SiteOne baseline, on a normalized $/oz basis? No I/O — unit-tested.

const { normalizeQuantityToOz } = require('../product-costing');
const { deriveNormalizedUnitPrice } = require('./extract');

const DEFAULTS = {
  minSavingsPct: 0.02, // 2%
  minSavingsUsd: 1.0, // $1 on a baseline-size purchase
  excludeOutOfStock: true,
};

// Attach perOz to each candidate, drop unparseable / out-of-stock, sort cheapest first.
function rankCandidates(candidates, { excludeOutOfStock = true } = {}) {
  return (candidates || [])
    .map((c) => ({ ...c, perOz: deriveNormalizedUnitPrice(c.price, c.quantity) }))
    .filter((c) => c.perOz != null && c.perOz > 0)
    .filter((c) => !(excludeOutOfStock && c.availability_status === 'out_of_stock'))
    .sort((a, b) => a.perOz - b.perOz);
}

// baseline:   { price, quantity, vendor }   (SiteOne — what Adam pays today)
// candidates: [{ price, quantity, vendor, source_url, availability_status }]
function findOpportunity(baseline, candidates, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const basePerOz = deriveNormalizedUnitPrice(baseline && baseline.price, baseline && baseline.quantity);
  const baseSizeOz = baseline ? normalizeQuantityToOz(baseline.quantity) : null;
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

module.exports = { DEFAULTS, rankCandidates, findOpportunity };
