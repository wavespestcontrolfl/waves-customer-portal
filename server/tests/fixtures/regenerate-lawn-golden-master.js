/**
 * Regenerate the lawn-pricing golden-master fixture.
 *
 * Run ONLY when a lawn-pricing change is intentional, then review the JSON diff
 * before committing:
 *   node server/tests/fixtures/regenerate-lawn-golden-master.js
 *
 * The matrix here is the contract — keep it in sync with any new dimension the
 * engine grows (e.g. a new track or tier).
 */
const fs = require('fs');
const path = require('path');
const { priceLawnCare } = require('../../services/pricing-engine');

const tracks = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];
const tiers = ['standard', 'enhanced', 'premium'];
const cases = [];

function add(label, property, options) {
  const r = priceLawnCare(property, options);
  cases.push({
    label,
    in: { property, options },
    out: {
      perApp: r.perApp, annual: r.annual, monthly: r.monthly, freq: r.frequency,
      tier: r.tier, track: r.track, pricingBasis: r.pricingBasis, pricingSource: r.pricingSource,
      pricingVersion: r.pricingVersion, customQuoteFlag: r.customQuoteFlag, marginFloorOk: r.marginFloorOk,
      marketMonthly: r.marketMonthly, marketAnnual: r.marketAnnual,
    },
  });
}

// Core grid: 4 tracks × 5 sqft × 3 sold tiers, DENSE. Sun/shade is not a
// pricing input, so the matrix has no shade dimension.
for (const t of tracks) {
  for (const sq of [3000, 4250, 6000, 8000, 12000]) {
    for (const tier of tiers) {
      add(`${t}/${tier}/${sq}/DENSE`, { turfSf: sq }, { track: t, tier });
    }
  }
}
// Route-density sweep.
for (const rd of ['NORMAL', 'LOOSE', 'SPARSE']) {
  add(`st_augustine/enhanced/4250/${rd}`, { turfSf: 4250, routeDensity: rd }, { track: 'st_augustine', tier: 'enhanced' });
}
// Edges: below table minimum, and above table maximum (custom-quote / extrapolation).
add('st_augustine/enhanced/2500/DENSE-tiny', { turfSf: 2500 }, { track: 'st_augustine', tier: 'enhanced' });
add('st_augustine/enhanced/22000/DENSE-overmax', { turfSf: 22000 }, { track: 'st_augustine', tier: 'enhanced' });

const out = path.join(__dirname, 'lawn-pricing-golden-master.json');
fs.writeFileSync(out, JSON.stringify(cases, null, 2) + '\n');
console.log(`Wrote ${cases.length} cases to ${out}`);
