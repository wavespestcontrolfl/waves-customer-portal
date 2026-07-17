const { priceLawnCare } = require('../services/pricing-engine');
const protocols = require('../config/protocols.json');

// Collected-margin reference target for recurring lawn (35% since 2026-06-17).
// Owner ruling 2026-07-17 ("forget all pricing floors"): the engine's 35% cost
// floor is DISARMED — every quote prices straight off the market bracket table
// and costFloorApplied is always false. This suite no longer enforces the
// target; it pins the disarmed behavior plus a ledger of the known, accepted
// below-target exposure (min observed collected margin 0.3152).
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
  const totalAtTenK = visits.reduce((sum, visit) => sum + Number(visit.material_cost || 0), 0);
  return totalAtTenK * (turfSqft / 10000);
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
// ruling 2026-07-17). Only the enhanced tier at 8,000+ sqft on the three
// premium-material tracks dips under 35%; bahia and the standard/premium
// tiers all clear the target on bracket pricing alone. Values are the
// engine's actual bracket prices against this suite's independent cost model.
const KNOWN_BELOW_TARGET_EXPOSURE = [
  { track: 'st_augustine', tier: 'enhanced', turfSqft: 8000, annual: 816, annualCost: 555.13, protocolMaterial: 291.88, margin: 0.3197 },
  { track: 'st_augustine', tier: 'enhanced', turfSqft: 10000, annual: 960, annualCost: 654.35, protocolMaterial: 364.85, margin: 0.3184 },
  { track: 'st_augustine', tier: 'enhanced', turfSqft: 12000, annual: 1104, annualCost: 753.57, protocolMaterial: 437.82, margin: 0.3174 },
  { track: 'st_augustine', tier: 'enhanced', turfSqft: 15000, annual: 1320, annualCost: 902.4, protocolMaterial: 547.28, margin: 0.3164 },
  { track: 'st_augustine', tier: 'enhanced', turfSqft: 20000, annual: 1680, annualCost: 1150.45, protocolMaterial: 729.7, margin: 0.3152 },
  { track: 'bermuda', tier: 'enhanced', turfSqft: 8000, annual: 828, annualCost: 551.77, protocolMaterial: 288.52, margin: 0.3336 },
  { track: 'bermuda', tier: 'enhanced', turfSqft: 10000, annual: 972, annualCost: 650.15, protocolMaterial: 360.65, margin: 0.3311 },
  { track: 'bermuda', tier: 'enhanced', turfSqft: 12000, annual: 1128, annualCost: 748.53, protocolMaterial: 432.78, margin: 0.3364 },
  { track: 'bermuda', tier: 'enhanced', turfSqft: 15000, annual: 1344, annualCost: 896.1, protocolMaterial: 540.98, margin: 0.3333 },
  { track: 'bermuda', tier: 'enhanced', turfSqft: 20000, annual: 1716, annualCost: 1142.05, protocolMaterial: 721.3, margin: 0.3345 },
  { track: 'zoysia', tier: 'enhanced', turfSqft: 8000, annual: 840, annualCost: 562.39, protocolMaterial: 299.14, margin: 0.3305 },
  { track: 'zoysia', tier: 'enhanced', turfSqft: 10000, annual: 984, annualCost: 663.42, protocolMaterial: 373.92, margin: 0.3258 },
  { track: 'zoysia', tier: 'enhanced', turfSqft: 12000, annual: 1140, annualCost: 764.45, protocolMaterial: 448.7, margin: 0.3294 },
  { track: 'zoysia', tier: 'enhanced', turfSqft: 15000, annual: 1356, annualCost: 916, protocolMaterial: 560.88, margin: 0.3245 },
  { track: 'zoysia', tier: 'enhanced', turfSqft: 20000, annual: 1740, annualCost: 1168.59, protocolMaterial: 747.84, margin: 0.3284 },
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
