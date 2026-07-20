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
const KNOWN_BELOW_TARGET_EXPOSURE = [
  { track: 'st_augustine', tier: 'standard', turfSqft: 8000, annual: 564, annualCost: 371.41, protocolMaterial: 178.91, margin: 0.3415 },
  { track: 'st_augustine', tier: 'standard', turfSqft: 10000, annual: 648, annualCost: 433.64, protocolMaterial: 223.64, margin: 0.3308 },
  { track: 'st_augustine', tier: 'standard', turfSqft: 12000, annual: 744, annualCost: 495.86, protocolMaterial: 268.36, margin: 0.3335 },
  { track: 'st_augustine', tier: 'standard', turfSqft: 15000, annual: 876, annualCost: 589.2, protocolMaterial: 335.45, margin: 0.3274 },
  { track: 'st_augustine', tier: 'standard', turfSqft: 20000, annual: 1092, annualCost: 744.77, protocolMaterial: 447.27, margin: 0.318 },
  { track: 'zoysia', tier: 'standard', turfSqft: 8000, annual: 564, annualCost: 404.95, protocolMaterial: 212.45, margin: 0.282 },
  { track: 'zoysia', tier: 'standard', turfSqft: 10000, annual: 672, annualCost: 475.56, protocolMaterial: 265.56, margin: 0.2923 },
  { track: 'zoysia', tier: 'standard', turfSqft: 12000, annual: 756, annualCost: 546.18, protocolMaterial: 318.68, margin: 0.2775 },
  { track: 'zoysia', tier: 'standard', turfSqft: 15000, annual: 900, annualCost: 652.1, protocolMaterial: 398.35, margin: 0.2754 },
  { track: 'zoysia', tier: 'standard', turfSqft: 20000, annual: 1140, annualCost: 828.63, protocolMaterial: 531.13, margin: 0.2731 },
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
