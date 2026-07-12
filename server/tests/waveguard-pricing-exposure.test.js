const { priceLawnCare } = require('../services/pricing-engine');
const protocols = require('../config/protocols.json');

// Collected-margin policy floor for recurring lawn (lowered 45% → 35% on
// 2026-06-17 per owner directive; the protocol-material basis here runs a hair
// above the engine's cost-floor basis, min observed 0.3515).
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

describe('WaveGuard lawn pricing exposure', () => {
  it('keeps every sold grass/cadence/size combination at or above the collected margin target', () => {
    const failures = [];

    for (const track of TRACKS) {
      for (const tier of TIERS) {
        for (const turfSqft of TURF_SIZES) {
          const priced = priceLawnCare(
            { turfSf: turfSqft, routeDensity: 'DENSE', features: {} },
            { track, tier, includeHiddenTiers: true }
          );
          const selectedTier = priced.tiers.find((row) => row.tier === tier);
          const annualCost = annualCostWithProtocolMaterial(track, tier, turfSqft);
          const margin = selectedTier.annual > 0
            ? (selectedTier.annual - annualCost) / selectedTier.annual
            : 0;

          if (margin + 0.0001 < TARGET_COLLECTED_MARGIN) {
            failures.push({
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

    expect(failures).toEqual([]);
  });

  it("engine's declared non-material cost components match the independent cost model", () => {
    // Guards the other direction: if the engine starts understating its own
    // labor/drive/reserve costs (which inflates its internal margin view and
    // lowers its cost-derived floors), this diverges from the independent
    // restatement even while the margin test above still clears.
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
