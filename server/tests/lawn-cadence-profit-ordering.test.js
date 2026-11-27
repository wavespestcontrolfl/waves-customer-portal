const { priceLawnCare } = require('../services/pricing-engine');

// Profit-ordering envelope for the 2026-08-07 lawn cadence frequency discount
// (-4% 9x / -8% 12x off the 6x per-application anchor; codex #3274 r1+r2).
//
// The discount was sized so annual profit RISES with frequency
// (12x > 9x > 6x) at every bracket cell the caps BIND on. That claim holds
// exactly — attribution measured per track by diffing this branch against
// unmodified origin/main (codex #3274 r2, after r1's measurement invoked
// priceLawnCare with the track on the property object where it is ignored
// and silently measured St. Augustine four times):
//
// - The discount ADDS sag (9x earning under 6x) nowhere at any bracket
//   cell, on any track. Its only added sag is the 18k–20k interpolation
//   tail (independent per-column rounding) on st_augustine and zoysia.
//   Bermuda and bahia gain ZERO sag anywhere 500–30,000 sqft.
// - The bermuda 5,500–5,745 and zoysia 5,500–5,577 inversions PRE-DATE the
//   discount: identical profits on origin/main (bermuda 5,500: 9x $207.34
//   vs 6x $219.71 both sides — the caps do not bind those cells, so the
//   migration never touches them). They are the ≥5,500 continuation of the
//   long-standing small-lawn shape the migration header scopes out.
// - Above LAWN_TABLE_MAX_SQFT (20k) the discount does not apply at all
//   (owner ruling 2026-08-07 on #3274: custom-quote territory, matching
//   industry practice). Extrapolated 9x/12x lookups carry a per-app
//   PARITY FLOOR against the extrapolated 6x anchor (skipping the caps
//   alone would leak the discount through the slope, which derives from
//   the discounted 15k/20k anchor cells), restoring 12x > 9x > 6x profit
//   ordering everywhere above the table — the extrapolated envelopes
//   below are pinned at ZERO sag.
//
// This suite PINS those envelopes per track. If a grid or cost-model change
// widens one, the numbers here must be re-measured and re-accepted
// deliberately — never loosened to make a red build green.
const TABLE_MAX_SQFT = 20000;
const SWEEP_MAX_SQFT = 30000;

// Bracket cells in the discount's binding range (>= 5,500 sqft per the
// 20260807120000 migration): the sizing claim is cell-exact here. Lookups
// at a row return the cell itself, no interpolation.
const BINDING_CELL_SIZES = [5500, 6000, 6500, 7000, 7500, 8000, 9000, 10000, 11000, 12000, 15000, 20000];

// Cells where 9x <= 6x PRE-DATES the discount (verified identical on
// origin/main; the caps do not bind these cells). Everywhere else in the
// binding range the ordering must be strict.
const PRE_EXISTING_CELL_INVERSIONS = { bermuda: [5500], zoysia: [5500] };

// Accepted 9x-under-6x envelopes, measured 2026-08-07 against the shipped
// grid + DENSE default cost model (bounds carry small headroom over the
// sampled maxima; ranges are where sag is ALLOWED, not where it must occur).
const SAG_ENVELOPE = {
  st_augustine: { table: { max: 4.75, ranges: [[18000, TABLE_MAX_SQFT]] }, extrapolatedMax: 0 },
  bermuda: { table: { max: 15, ranges: [[5500, 5750]] }, extrapolatedMax: 0 }, // pre-existing region only
  zoysia: { table: { max: 5.25, ranges: [[5500, 5750], [18000, TABLE_MAX_SQFT]] }, extrapolatedMax: 0 },
  bahia: { table: { max: 0, ranges: [] }, extrapolatedMax: 0 },
};
const TRACKS = Object.keys(SAG_ENVELOPE);

// legacy: the grid a quote saved before the one lawn price lane (2026-11-26) was sold on, each grass's own rows. The envelopes
// above were measured on it and still pin it. New quotes are pinned in the last block of this file.
function profitsAt(track, lawnSqFt, { legacy = true } = {}) {
  // track rides the OPTIONS object — priceLawnCare ignores grassType on the
  // property (codex #3274 r2: passing it there measured the default
  // St. Augustine curve for every "track").
  // includeHiddenTiers: the envelope spans the full 6/9/12 ladder — the 6x
  // leg is hidden for new sales (owner directive 2026-09-24) but remains the
  // cadence-discount anchor this ordering is measured against.
  const result = priceLawnCare({ lawnSqFt }, { tier: 'standard', track, includeHiddenTiers: true, legacyLawnOneLane: legacy });
  const byVisits = {};
  for (const tier of result.tiers) {
    byVisits[tier.visits] = tier.annual - tier.costFloorDetails.annualCost;
  }
  return byVisits;
}

describe('lawn cadence frequency discount — profit ordering envelope', () => {
  it.each(TRACKS)('%s: sanity — tracks price differently (the r2 regression guard)', (track) => {
    // Guards the r2 bug class itself: if the track option stopped reaching
    // the engine, every track would collapse onto the default curve and
    // bermuda/zoysia/bahia would all equal st_augustine.
    if (track === 'st_augustine') return;
    const p = profitsAt(track, 12000);
    const ref = profitsAt('st_augustine', 12000);
    expect(p[6]).not.toBe(ref[6]);
  });

  it.each(TRACKS)('%s: profit rises with frequency at every binding bracket cell (pre-existing inversions exempt)', (track) => {
    const exempt = new Set(PRE_EXISTING_CELL_INVERSIONS[track] || []);
    for (const sqft of BINDING_CELL_SIZES) {
      const p = profitsAt(track, sqft);
      expect(p[12]).toBeGreaterThan(p[9]);
      if (!exempt.has(sqft)) {
        expect(p[9]).toBeGreaterThan(p[6]);
      }
    }
  });

  it.each(TRACKS)('%s: 12x never earns under 9x at any size', (track) => {
    for (let sqft = 500; sqft <= SWEEP_MAX_SQFT; sqft += 97) {
      const p = profitsAt(track, sqft);
      expect(p[12]).toBeGreaterThanOrEqual(p[9]);
    }
  });

  it.each(TRACKS)('%s: 9x sag inside the table stays inside the accepted envelope', (track) => {
    const { max, ranges } = SAG_ENVELOPE[track].table;
    for (let sqft = 5500; sqft <= TABLE_MAX_SQFT; sqft += 13) {
      const p = profitsAt(track, sqft);
      const sag = p[6] - p[9];
      if (sag <= 0) continue;
      expect(sag).toBeLessThanOrEqual(max);
      expect(ranges.some(([lo, hi]) => sqft >= lo && sqft <= hi)).toBe(true);
    }
  });

  it.each(TRACKS)('%s: extrapolated 9x sag stays inside the accepted envelope', (track) => {
    const { extrapolatedMax } = SAG_ENVELOPE[track];
    for (let sqft = TABLE_MAX_SQFT + 1; sqft <= SWEEP_MAX_SQFT; sqft += 13) {
      const p = profitsAt(track, sqft);
      expect(p[6] - p[9]).toBeLessThanOrEqual(extrapolatedMax);
    }
  });
});

// One lawn price lane (owner 2026-11-26 "make these one type of grass", new quotes only): a new bermuda or zoysia plan prices from
// the St. Augustine rows while its cost stays its own grass's (the products differ). Measured 2026-11-27 on the shipped grid + DENSE
// default cost model, sampled every 13 sq ft (bounds carry small headroom over the sampled maxima):
// - bermuda: 9x earns at most $4.08 a year under 6x at 18,076-19,896 sq ft (6x is the hidden anchor, not sold), and 12x earns at
//   most $2.17 a year under 9x at 2,216-2,346 sq ft (both sold). Nowhere else.
// - zoysia: 9x earns at most $12.92 a year under 6x at 16,113-20,000 sq ft (6x not sold), the 20,000 cell by $3.25; 12x never
//   earns under 9x.
// - st_augustine and bahia read their own rows as before: the envelopes above stand for them unchanged.
// - Above the table (20,000 sq ft) every track keeps zero sag.
// Owner-acknowledged with the margin ledger of waveguard-pricing-exposure.test.js. Re-measure deliberately; never loosen to go green.
const NEW_QUOTE_ENVELOPE = {
  st_augustine: { exemptCells: [], twelveUnderNine: { max: 0, ranges: [] }, table: SAG_ENVELOPE.st_augustine.table },
  bermuda: { exemptCells: [], twelveUnderNine: { max: 2.25, ranges: [[2200, 2350]] }, table: { max: 4.25, ranges: [[18000, TABLE_MAX_SQFT]] } },
  zoysia: { exemptCells: [20000], twelveUnderNine: { max: 0, ranges: [] }, table: { max: 13, ranges: [[16000, TABLE_MAX_SQFT]] } },
  bahia: { exemptCells: [], twelveUnderNine: { max: 0, ranges: [] }, table: SAG_ENVELOPE.bahia.table },
};
const NEW_QUOTE = { legacy: false };

describe('lawn cadence profit ordering — new quotes on the one lawn price lane', () => {
  it.each(TRACKS)('%s: 12x earns over 9x at every binding cell; 9x over 6x outside the measured exemptions', (track) => {
    const exempt = new Set(NEW_QUOTE_ENVELOPE[track].exemptCells);
    for (const sqft of BINDING_CELL_SIZES) {
      const p = profitsAt(track, sqft, NEW_QUOTE);
      expect(p[12]).toBeGreaterThan(p[9]);
      if (!exempt.has(sqft)) expect(p[9]).toBeGreaterThan(p[6]);
    }
  });

  it.each(TRACKS)('%s: 12x earns under 9x only inside the measured envelope', (track) => {
    const { max, ranges } = NEW_QUOTE_ENVELOPE[track].twelveUnderNine;
    for (let sqft = 500; sqft <= SWEEP_MAX_SQFT; sqft += 13) {
      const p = profitsAt(track, sqft, NEW_QUOTE);
      const gap = p[9] - p[12];
      if (gap <= 0) continue;
      expect(gap).toBeLessThanOrEqual(max);
      expect(ranges.some(([lo, hi]) => sqft >= lo && sqft <= hi)).toBe(true);
    }
  });

  it.each(TRACKS)('%s: 9x sag inside the table stays inside the measured envelope', (track) => {
    const { max, ranges } = NEW_QUOTE_ENVELOPE[track].table;
    for (let sqft = 5500; sqft <= TABLE_MAX_SQFT; sqft += 13) {
      const p = profitsAt(track, sqft, NEW_QUOTE);
      const sag = p[6] - p[9];
      if (sag <= 0) continue;
      expect(sag).toBeLessThanOrEqual(max);
      expect(ranges.some(([lo, hi]) => sqft >= lo && sqft <= hi)).toBe(true);
    }
  });

  it.each(TRACKS)('%s: no 9x sag above the table', (track) => {
    for (let sqft = TABLE_MAX_SQFT + 1; sqft <= SWEEP_MAX_SQFT; sqft += 13) {
      const p = profitsAt(track, sqft, NEW_QUOTE);
      expect(p[6] - p[9]).toBeLessThanOrEqual(0);
    }
  });

  it('a new bermuda or zoysia plan collects the St. Augustine price; its cost stays its own grass', () => {
    for (const sqft of [3000, 8000, 12000]) {
      const plan = (track) => priceLawnCare({ lawnSqFt: sqft }, { tier: 'enhanced', track });
      for (const track of ['bermuda', 'zoysia']) {
        expect(plan(track).annual).toBe(plan('st_augustine').annual);
        expect(plan(track).track).toBe(track);
      }
    }
  });
});
