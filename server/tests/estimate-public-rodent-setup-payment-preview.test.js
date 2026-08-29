/**
 * The disclosed non-member rodent bait-station setup is invoiced UP FRONT
 * beside the first application by both accept paths (codex #3591 r33 P1) —
 * the pricing bundle exposes it as `rodentBaitSetupFee` so the payment
 * choice previews it as an invoice row and excludes it from the
 * after-completion extras. Kept OFF firstVisitFees (fee cards / breakdown
 * exclusions stay untouched) and omitted when nothing was disclosed.
 */
jest.mock('../models/db', () => jest.fn());

const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');
const { buildPricingBundle } = require('../routes/estimate-public');

function storedEstimate(id, engineInputs) {
  const result = mapV1ToLegacyShape(generateEstimate(engineInputs));
  return { id, status: 'draft', waveguard_tier: 'Bronze', estimate_data: { engineInputs, result } };
}

describe('pricing bundle — rodentBaitSetupFee', () => {
  test('a non-member rodent quote exposes the frozen setup as an up-front row, not a first-visit fee', async () => {
    const inputs = { homeSqFt: 2000, lotSqFt: 8000, services: { rodentBait: { frequency: 'quarterly' } } };
    const stored = storedEstimate('estimate-rodent-setup', inputs);
    // The mapper carries the engine's setup line in result.specItems — one of
    // the containers frozenRodentBaitSetupAmount scans.
    const setupRow = (stored.estimate_data.result.specItems || []).find((it) => it.service === 'rodent_bait_setup');
    expect(setupRow).toBeTruthy();
    const bundle = await buildPricingBundle(stored);
    expect(bundle.rodentBaitSetupFee).toEqual({
      service: 'rodent_bait_setup',
      amount: Math.round(Number(setupRow.price ?? setupRow.amount) * 100) / 100,
      label: 'Bait Station Setup',
      waivedWithPrepay: false,
    });
    expect((bundle.firstVisitFees || []).some((f) => f.service === 'rodent_bait_setup')).toBe(false);
  });

  test('a pest quote carries no rodentBaitSetupFee key at all', async () => {
    const bundle = await buildPricingBundle(storedEstimate('estimate-pest-only', {
      homeSqFt: 2000, services: { pest: { frequency: 'quarterly' } },
    }));
    expect('rodentBaitSetupFee' in bundle).toBe(false);
  });
});
