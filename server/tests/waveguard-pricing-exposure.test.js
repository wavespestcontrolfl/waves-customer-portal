const { priceLawnCare } = require('../services/pricing-engine');
const protocols = require('../config/protocols.json');

// Collected-margin reference target for recurring lawn (35% since 2026-06-17).
// Owner ruling 2026-07-17 ("forget all pricing floors"): the engine's 35% cost
// floor is DISARMED — every quote prices straight off the market bracket table
// and costFloorApplied is always false. This suite no longer enforces the
// target; it pins the disarmed behavior plus a ledger of the known, accepted
// below-target exposure (min observed collected margin 0.2731).
const TARGET_COLLECTED_MARGIN = 0.35;
const TRACKS = ['st_augustine', 'bermuda', 'zoysia', 'bahia'];
const TIERS = ['standard', 'enhanced', 'premium'];
const TURF_SIZES = [3000, 4500, 8000, 10000, 12000, 15000, 20000];

const PROTOCOL_TIER_BY_PRICING_TIER = {
  standard: 'bronze',
  enhanced: 'enhanced',
  premium: 'premium',
};

// Independent restatement of the owner-approved lawn cost model. Do NOT
// import these from the engine or its constants — this test audits the
// engine's prices against the real cost basis, so expected and actual must
// not share a source (reading the engine's own costFloorDetails let an
// engine that understated its labor cost lower this test's bar in lockstep).
// $35/hr loaded labor is the business-wide rate (CLAUDE.md); the minute and
// reserve figures are the owner-approved Lawn V2 cost model.
const COST_BASIS = {
  laborRateLoaded: 35,          // $/hr loaded (equipment included in labor)
  laborMinutesBase: 12,         // per-visit mobilization
  laborMinutesPer1000Sqft: 2.5, // on-turf minutes per 1,000 sqft
  driveMinutesDense: 5,         // this suite prices DENSE routes
  callbackReservePerVisit: 2,   // $ per visit (no maintenance/pressure adders here)
  equipmentReservePerVisit: 0,  // included in loaded labor rate
  adminAnnual: 51,              // $ per plan-year
};
const VISITS_BY_TIER = { standard: 6, enhanced: 9, premium: 12 };

function protocolAnnualMaterialAtSize(track, tier, turfSqft) {
  const protocolTier = PROTOCOL_TIER_BY_PRICING_TIER[tier];
  const visits = protocols.lawn[track].visits.filter((visit) => visit.tiers?.[protocolTier]);
  // material_cost = scheduled apps (this audit's 10,000 sqft basis);
  // conditional_cost = the spot-treatment reserve (¼ gated fungicide/
  // insecticide, ⅛ herbicide spot), derived from the protocol's inline
  // line costs, which are reference-lawn (~4,500 sqft) quantities — e.g.
  // the $8.68 LESCO 24-0-11 line buys 12.8 lb, covering ~4,100 sqft at the
  // protocol's own 0.75 lb N/1K rate. Scale reserves to this audit's 10K
  // basis before joining the material term. Both components are funded by
  // LAWN_MATERIAL_BUDGETS as of 2026-07-16.
  const RESERVE_REFERENCE_SQFT = 4500;
  const totalAtTenK = visits.reduce(
    (sum, visit) =>
      sum
      + Number(visit.material_cost || 0)
      + Number(visit.conditional_cost || 0) * (10000 / RESERVE_REFERENCE_SQFT),
    0,
  );
  // Tier flags cover more calendar slots than the sold cadence delivers
  // (silver flags 8 slots, sold standard = 6 visits). Normalize the same
  // way the budgets and lawn-cost-floor-shared's
  // protocolMaterialBudgetAtReferenceSqft do: average the flagged slots,
  // multiply by the SOLD visit count — the customer only receives (and
  // the price only funds) the sold visits.
  const soldVisits = VISITS_BY_TIER[tier];
  const normalizedAtTenK = (totalAtTenK / visits.length) * soldVisits;
  return normalizedAtTenK * (turfSqft / 10000);
}

function independentNonMaterialAnnualCost(tier, turfSqft) {
  const visits = VISITS_BY_TIER[tier];
  const turfK = turfSqft / 1000;
  const laborMinutesPerVisit =
    COST_BASIS.laborMinutesBase + COST_BASIS.laborMinutesPer1000Sqft * turfK;
  const annualLabor = (COST_BASIS.laborRateLoaded * laborMinutesPerVisit / 60) * visits;
  const annualDrive = (COST_BASIS.laborRateLoaded * COST_BASIS.driveMinutesDense / 60) * visits;
  const annualEquipment = COST_BASIS.equipmentReservePerVisit * visits;
  const annualCallbackReserve = COST_BASIS.callbackReservePerVisit * visits;
  return annualLabor + annualDrive + annualEquipment + annualCallbackReserve
    + COST_BASIS.adminAnnual;
}

function annualCostWithProtocolMaterial(track, tier, turfSqft) {
  return protocolAnnualMaterialAtSize(track, tier, turfSqft)
    + independentNonMaterialAnnualCost(tier, turfSqft);
}

// Known, accepted below-target exposure with the cost floor disarmed (owner
// ruling 2026-07-17), on the #2812 reserve-folded protocol cost data. The
// fold's sold-cadence normalization moved the exposure: enhanced tiers now
// clear 35%, while STANDARD (6-app) st_augustine and zoysia at 8,000+ sqft
// dip under — zoysia standard runs ~27-29% (min 0.2731 at 20k). Values are
// the engine's actual bracket prices against this suite's independent cost
// model; the engine's own folded cost view agrees within a few dollars.
//
// EXPANDED 2026-08-07 (owner directive, lawn cadence frequency discount):
// 9x/12x now carry a -4%/-8% per-application discount off the 6x anchor, which
// adds 15 enhanced/premium entries at 8,000+ sqft — the sizes where the old
// columns had converged and the discount therefore bites. Two things the owner
// accepted when sizing it: the WORST margin is unchanged at 0.2731 (zoysia
// standard 20k — a 6x cell the discount does not touch), and every new entry
// lands in a 0.295-0.3460 band, i.e. above the pre-existing floor. Absolute
// annual profit still RISES with frequency at every bracket the caps bind on,
// which is the invariant that sized the discount; collected margin PERCENTAGE
// falling on the higher cadences is the expected trade and is report-only.
// 2026-10-23 (lawn v13 Advion mole cricket bait): the June and July spot reserves (protocols.json conditional_cost) gained the Advion Insect
// Granule bait line: 3 lb per 1,000 sq ft at $166.01 per 25 lb ($6.64 per lb), 4% of the 4,500 sq ft reference lawn baited in June and 2% new
// areas in July, a quarter reserved as for the other gated insecticides ($0.90 June, $0.45 July). That is the largest clean share that adds NO
// new below-target cell (5% pushes St. Augustine enhanced 15,000 sq ft under 0.35). Every cell below was already below target; each moves by
// cents (margin down by at most 0.003).
const KNOWN_BELOW_TARGET_EXPOSURE = [
  { track: 'st_augustine', tier: 'standard', turfSqft: 8000, annual: 564, annualCost: 372.21, protocolMaterial: 179.71, margin: 0.3401 },
  { track: 'st_augustine', tier: 'standard', turfSqft: 10000, annual: 648, annualCost: 434.64, protocolMaterial: 224.64, margin: 0.3293 },
  { track: 'st_augustine', tier: 'standard', turfSqft: 12000, annual: 744, annualCost: 497.06, protocolMaterial: 269.56, margin: 0.3319 },
  { track: 'st_augustine', tier: 'standard', turfSqft: 15000, annual: 876, annualCost: 590.7, protocolMaterial: 336.95, margin: 0.3257 },
  { track: 'st_augustine', tier: 'standard', turfSqft: 20000, annual: 1092, annualCost: 746.77, protocolMaterial: 449.27, margin: 0.3161 },
  { track: 'st_augustine', tier: 'enhanced', turfSqft: 20000, annual: 1572, annualCost: 1038.66, protocolMaterial: 617.91, margin: 0.3393 },
  { track: 'st_augustine', tier: 'premium', turfSqft: 10000, annual: 1188, annualCost: 780.94, protocolMaterial: 411.94, margin: 0.3426 },
  { track: 'st_augustine', tier: 'premium', turfSqft: 12000, annual: 1368, annualCost: 898.33, protocolMaterial: 494.33, margin: 0.3433 },
  { track: 'st_augustine', tier: 'premium', turfSqft: 15000, annual: 1608, annualCost: 1074.41, protocolMaterial: 617.91, margin: 0.3318 },
  { track: 'st_augustine', tier: 'premium', turfSqft: 20000, annual: 2004, annualCost: 1367.88, protocolMaterial: 823.88, margin: 0.3174 },
  { track: 'zoysia', tier: 'standard', turfSqft: 8000, annual: 564, annualCost: 405.75, protocolMaterial: 213.25, margin: 0.2806 },
  { track: 'zoysia', tier: 'standard', turfSqft: 10000, annual: 672, annualCost: 476.56, protocolMaterial: 266.56, margin: 0.2908 },
  { track: 'zoysia', tier: 'standard', turfSqft: 12000, annual: 756, annualCost: 547.38, protocolMaterial: 319.88, margin: 0.276 },
  { track: 'zoysia', tier: 'standard', turfSqft: 15000, annual: 900, annualCost: 653.6, protocolMaterial: 399.85, margin: 0.2738 },
  { track: 'zoysia', tier: 'standard', turfSqft: 20000, annual: 1140, annualCost: 830.63, protocolMaterial: 533.13, margin: 0.2714 },
  { track: 'zoysia', tier: 'enhanced', turfSqft: 8000, annual: 804, annualCost: 543.46, protocolMaterial: 280.21, margin: 0.3241 },
  { track: 'zoysia', tier: 'enhanced', turfSqft: 10000, annual: 960, annualCost: 639.76, protocolMaterial: 350.26, margin: 0.3336 },
  { track: 'zoysia', tier: 'enhanced', turfSqft: 12000, annual: 1080, annualCost: 736.06, protocolMaterial: 420.31, margin: 0.3185 },
  { track: 'zoysia', tier: 'enhanced', turfSqft: 15000, annual: 1296, annualCost: 880.51, protocolMaterial: 525.39, margin: 0.3206 },
  { track: 'zoysia', tier: 'enhanced', turfSqft: 20000, annual: 1632, annualCost: 1121.26, protocolMaterial: 700.51, margin: 0.313 },
  { track: 'zoysia', tier: 'premium', turfSqft: 8000, annual: 1032, annualCost: 707.61, protocolMaterial: 373.61, margin: 0.3143 },
  { track: 'zoysia', tier: 'premium', turfSqft: 10000, annual: 1236, annualCost: 836.01, protocolMaterial: 467.01, margin: 0.3236 },
  { track: 'zoysia', tier: 'premium', turfSqft: 12000, annual: 1380, annualCost: 964.41, protocolMaterial: 560.41, margin: 0.3012 },
  { track: 'zoysia', tier: 'premium', turfSqft: 15000, annual: 1656, annualCost: 1157.01, protocolMaterial: 700.51, margin: 0.3013 },
  { track: 'zoysia', tier: 'premium', turfSqft: 20000, annual: 2088, annualCost: 1478.02, protocolMaterial: 934.02, margin: 0.2921 },
];

describe('WaveGuard lawn pricing exposure', () => {
  it('prices every combination off the market bracket with the cost floor disarmed; below-target margins match the known-exposure ledger (owner 2026-07-17)', () => {
    const floorApplications = [];
    const bracketMismatches = [];
    const belowTarget = [];

    for (const track of TRACKS) {
      for (const tier of TIERS) {
        for (const turfSqft of TURF_SIZES) {
          const priced = priceLawnCare(
            { turfSf: turfSqft, routeDensity: 'DENSE', features: {} },
            { track, tier, includeHiddenTiers: true }
          );
          const selectedTier = priced.tiers.find((row) => row.tier === tier);

          // Disarmed-floor pins: the cost floor never lifts a price, and every
          // quote is the market bracket price verbatim.
          if (selectedTier.costFloorApplied !== false) {
            floorApplications.push({ track, tier, turfSqft, costFloorApplied: selectedTier.costFloorApplied });
          }
          if (selectedTier.annual !== selectedTier.marketAnnual) {
            bracketMismatches.push({ track, tier, turfSqft, annual: selectedTier.annual, marketAnnual: selectedTier.marketAnnual });
          }

          const annualCost = annualCostWithProtocolMaterial(track, tier, turfSqft);
          const margin = selectedTier.annual > 0
            ? (selectedTier.annual - annualCost) / selectedTier.annual
            : 0;

          if (margin + 0.0001 < TARGET_COLLECTED_MARGIN) {
            belowTarget.push({
              track,
              tier,
              turfSqft,
              annual: selectedTier.annual,
              annualCost: Number(annualCost.toFixed(2)),
              protocolMaterial: Number(protocolAnnualMaterialAtSize(track, tier, turfSqft).toFixed(2)),
              margin: Number(margin.toFixed(4)),
            });
          }
        }
      }
    }

    expect(floorApplications).toEqual([]);
    expect(bracketMismatches).toEqual([]);
    // Exposure ledger: any NEW combo dropping below target (or an existing one
    // getting worse) fails here and needs an owner-acknowledged ledger update.
    expect(belowTarget).toEqual(KNOWN_BELOW_TARGET_EXPOSURE);
  });

  it("engine's declared non-material cost components match the independent cost model", () => {
    // Guards the other direction: if the engine starts understating its own
    // labor/drive/reserve costs (which inflates its internal margin view and
    // its now report-only cost-basis figures — floors disarmed per owner
    // 2026-07-17), this diverges from the independent restatement even while
    // the exposure ledger above still matches.
    const failures = [];

    for (const track of TRACKS) {
      for (const tier of TIERS) {
        for (const turfSqft of TURF_SIZES) {
          const priced = priceLawnCare(
            { turfSf: turfSqft, routeDensity: 'DENSE', features: {} },
            { track, tier, includeHiddenTiers: true }
          );
          const details = priced.tiers.find((row) => row.tier === tier).costFloorDetails;
          const engineNonMaterial =
            Number(details.annualLabor || 0)
            + Number(details.annualDrive || 0)
            + Number(details.annualEquipment || 0)
            + Number(details.annualCallbackReserve || 0)
            + Number(details.annualAdmin || 0);
          const independent = independentNonMaterialAnnualCost(tier, turfSqft);

          // Rounding tolerance only — per-component roundMoney can move the
          // sum by cents, never dollars.
          if (Math.abs(engineNonMaterial - independent) > 0.25) {
            failures.push({
              track,
              tier,
              turfSqft,
              engineNonMaterial: Number(engineNonMaterial.toFixed(2)),
              independent: Number(independent.toFixed(2)),
            });
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
