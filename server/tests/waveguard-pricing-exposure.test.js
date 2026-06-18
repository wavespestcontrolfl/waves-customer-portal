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

function protocolAnnualMaterialAtSize(track, tier, turfSqft) {
  const protocolTier = PROTOCOL_TIER_BY_PRICING_TIER[tier];
  const visits = protocols.lawn[track].visits.filter((visit) => visit.tiers?.[protocolTier]);
  const totalAtTenK = visits.reduce((sum, visit) => sum + Number(visit.material_cost || 0), 0);
  return totalAtTenK * (turfSqft / 10000);
}

function annualCostWithProtocolMaterial(track, tier, turfSqft, selectedTier) {
  const details = selectedTier.costFloorDetails;
  return protocolAnnualMaterialAtSize(track, tier, turfSqft)
    + Number(details.annualLabor || 0)
    + Number(details.annualDrive || 0)
    + Number(details.annualEquipment || 0)
    + Number(details.annualCallbackReserve || 0)
    + Number(details.annualAdmin || 0);
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
          const annualCost = annualCostWithProtocolMaterial(track, tier, turfSqft, selectedTier);
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
});
