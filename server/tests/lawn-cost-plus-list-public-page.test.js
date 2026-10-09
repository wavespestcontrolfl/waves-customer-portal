// GATE_LAWN_COST_PLUS_LIST on the customer estimate page (buildPricingBundle):
// a saved cost-plus quote shows the list price as the anchor and the
// floor-stopped price as what the customer pays, and a later gate or knob
// change does not move a quote that was already sent.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const { buildPricingBundle } = require('../routes/estimate-public');
const { generateEstimate } = require('../services/pricing-engine');
const { LAWN_PRICING_V2 } = require('../services/pricing-engine/constants');

const GATE = 'GATE_LAWN_COST_PLUS_LIST';
const SENT = { status: 'sent', sent_at: new Date('2026-10-01T12:00:00Z'), viewed_at: null };
const inputs = (services) => ({
  homeSqFt: 2000,
  stories: 1,
  lotSqFt: 10000,
  propertyType: 'single_family',
  features: { shrubs: 'moderate', trees: 'moderate', complexity: 'standard' },
  measuredTurfSf: 4500,
  paymentMethod: 'card',
  services,
});
const LAWN = { track: 'st_augustine', tier: 'enhanced', lawnFreq: 9 };
const FOUR = { pest: { frequency: 'quarterly' }, lawn: LAWN, treeShrub: { tier: 'enhanced' }, mosquito: { tier: 'silver' } };

let seq = 0;
async function pageLawnRow(engineInputs, engineResult, tier) {
  seq += 1;
  const bundle = await buildPricingBundle(
    { id: `cost-plus-${seq}`, token: 't', waveguard_tier: tier, ...SENT, estimate_data: { engineInputs, engineResult } },
    { monthlyBilled: false },
  );
  const row = bundle.frequencies[0].perServiceTreatments.find((r) => r.service === 'lawn_care');
  return { bundle, row };
}

let priorGate;
let liveCostPlus;
beforeEach(() => {
  priorGate = process.env[GATE];
  liveCostPlus = JSON.parse(JSON.stringify(LAWN_PRICING_V2.costPlusList));
  process.env[GATE] = 'true';
});
afterEach(() => {
  LAWN_PRICING_V2.costPlusList = liveCostPlus;
  if (priorGate === undefined) delete process.env[GATE];
  else process.env[GATE] = priorGate;
});

describe('a saved cost-plus quote on the customer estimate page', () => {
  test('one service: the customer pays the list price, $77 a visit', async () => {
    const engineInputs = inputs({ lawn: LAWN });
    const { row } = await pageLawnRow(engineInputs, generateEstimate(engineInputs), 'Bronze');
    expect(row.perTreatment).toBe(77);
    expect(row.displayPrice).toBe(77);
  });

  test('Platinum: the anchor is the list price and the 20% discount stops at the 35% floor', async () => {
    const engineInputs = inputs(FOUR);
    const { bundle, row } = await pageLawnRow(engineInputs, generateEstimate(engineInputs), 'Platinum');
    expect(bundle.combinedRecurring.waveGuardTierLabel).toBe('Platinum');
    expect(row.perTreatment).toBe(77);
    // 20% off would be $61.60; the floor is $584.71 a year = $64.97 a visit.
    expect(row.displayPrice).toBe(64.97);
    expect(row.monthly).toBe(48.73);
  });

  test('a later gate-off or knob edit does not move the sent quote', async () => {
    const engineInputs = inputs(FOUR);
    const saved = generateEstimate(engineInputs);
    delete process.env[GATE];
    LAWN_PRICING_V2.costPlusList.listMargin = 0.6;
    const { row } = await pageLawnRow(engineInputs, saved, 'Platinum');
    expect(row.perTreatment).toBe(77);
    expect(row.displayPrice).toBe(64.97);
  });
});
