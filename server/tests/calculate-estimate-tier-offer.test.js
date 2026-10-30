// POST /calculate-estimate attaches the linked member's current services at
// the tier the quote moves them to (GATE_WAVEGUARD_EXTEND_PICK, owner
// 2026-10-30 option B), scoped by the same property evidence the save uses.
// The list is read-only and best-effort: a failure leaves it off and the
// quote still prices. Handler invoked off the router stack (repo has no
// supertest); the account reads are mocked.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/pricing-engine', () => ({
  ...jest.requireActual('../services/pricing-engine'),
  needsSync: () => false,
}));
jest.mock('../services/area-addon-limits', () => ({
  attachQuoteAreaAddOnHistory: async (_db, v1Input) => v1Input,
}));
jest.mock('../services/pricing-engine/trusted-catalog-pricing', () => ({
  withTrustedCatalogPricing: async (v1Input) => v1Input,
}));
const mockStreetScope = { estimateStreet: '100 sample st', customerPrimaryStreet: '100 sample st' };
jest.mock('../services/waveguard-existing-services', () => ({
  ...jest.requireActual('../services/waveguard-existing-services'),
  resolveCustomerQualifyingEvidence: jest.fn(async () => ({
    tierKeys: ['pest_control', 'lawn_care'],
    setupWaiverKeys: ['pest_control', 'lawn_care'],
    groupedEstimate: false,
    perPropertyStreetScope: mockStreetScope,
  })),
}));
jest.mock('../services/estimate-membership-context', () => ({
  ...jest.requireActual('../services/estimate-membership-context'),
  currentServiceTierOffer: jest.fn(),
}));

const { currentServiceTierOffer } = require('../services/estimate-membership-context');
const router = require('../routes/property-lookup-v2');

const OFFER = {
  fromTierLabel: 'Silver',
  tierLabel: 'Gold',
  tierDiscountPct: 15,
  services: [{ key: 'pest_control', label: 'Pest Control', currentPerVisit: 120, newPerVisit: 113.33, marginPct: 52.9 }],
};

function invoke(body, techRole = 'admin') {
  const layer = router.stack.find((l) => l.route?.path === '/calculate-estimate' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); },
    };
    handler({ body, techRole }, res);
  });
}

const quote = (options = {}) => ({
  profile: { homeSqFt: 2000, lotSqFt: 8000, stories: 1, propertyType: 'Single Family' },
  selectedServices: ['MOSQUITO'],
  options: { address: '100 Sample St, Parrish, FL 34219', mosquitoProgram: 'monthly12', ...options },
});

beforeEach(() => currentServiceTierOffer.mockReset());

test('a linked member gets the tick list, built from this quote under the save\'s property scope', async () => {
  currentServiceTierOffer.mockResolvedValue(OFFER);
  const { status, payload } = await invoke(quote({ existingCustomerId: 'cust-1' }));
  expect(status).toBe(200);
  expect(payload.currentServiceTierOffer).toEqual(OFFER);
  const [, args] = currentServiceTierOffer.mock.calls[0];
  expect(args).toMatchObject({ customerId: 'cust-1', groupedEstimate: false, perPropertyStreetScope: mockStreetScope });
  // The offer is computed from this very quote's priced services.
  expect(args.estData.result.recurring.services.map((svc) => svc.service)).toContain('mosquito');
});

test('a technician gets no tick list: it carries contracted prices and margins (admin only, like customer-spend)', async () => {
  currentServiceTierOffer.mockResolvedValue(OFFER);
  const { status, payload } = await invoke(quote({ existingCustomerId: 'cust-1' }), 'technician');
  expect(status).toBe(200);
  expect(payload).not.toHaveProperty('currentServiceTierOffer');
  expect(currentServiceTierOffer).not.toHaveBeenCalled();
});

test('a lead gets no tick list, and a failed list still returns the quote', async () => {
  const lead = await invoke(quote());
  expect(lead.status).toBe(200);
  expect(lead.payload).not.toHaveProperty('currentServiceTierOffer');
  expect(currentServiceTierOffer).not.toHaveBeenCalled();

  currentServiceTierOffer.mockRejectedValue(new Error('db down'));
  const failed = await invoke(quote({ existingCustomerId: 'cust-1' }));
  expect(failed.status).toBe(200);
  expect(failed.payload).not.toHaveProperty('currentServiceTierOffer');
  expect(failed.payload.recurring.services.length).toBeGreaterThan(0);
});
