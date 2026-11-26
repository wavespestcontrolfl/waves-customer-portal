// POST /calculate-estimate for a REOPENED estimate (options.reviseEstimateId): a retained flea line of a delivered estimate previews as
// sent unless the operator changed what moves its price, so the preview shows the number the save persists (owner ruling 2026-11-26
// "whole home"). Handler invoked off the router stack; the db and catalog pricing are mocked.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
let mockStored = null;
jest.mock('../models/db', () => jest.fn(() => {
  const b = {};
  b.where = jest.fn(() => b);
  b.first = jest.fn(async () => mockStored);
  return b;
}));
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
jest.mock('../services/waveguard-existing-services', () => ({
  ...jest.requireActual('../services/waveguard-existing-services'),
  resolveCustomerQualifyingEvidence: jest.fn(async () => ({
    tierKeys: [], setupWaiverKeys: [], groupedEstimate: true, perPropertyStreetScope: null,
  })),
}));
jest.mock('../services/estimate-membership-context', () => ({
  ...jest.requireActual('../services/estimate-membership-context'),
  currentServiceTierOffer: jest.fn(),
}));
jest.mock('../services/customer-moves', () => {
  class MoveError extends Error {
    constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
  }
  return { MoveError, verifyMoveForEstimate: jest.fn(async () => ({ id: 'move-1' })) };
});

const router = require('../routes/property-lookup-v2');

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

const ESTIMATE_ID = '5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const quote = (profile, options = {}) => ({
  profile: { homeSqFt: 3000, lotSqFt: 7500, stories: 2, propertyType: 'Single Family', ...profile },
  selectedServices: ['FLEA'],
  options: { address: '40 Sample Road, Venice, FL 34285', existingCustomerId: 'cust-1', ...options },
});
const fleaPrice = (payload) => [...(payload.oneTime?.items || []), ...(payload.oneTime?.specItems || [])]
  .find((item) => item.service === 'flea_package')?.price;

// A $342 flea package sent before 2026-11-26 on a two-story 3,000 sq ft home (unstamped row: ground-floor basis).
const legacyRow = { service: 'flea_package', name: 'Flea Elimination Package — 2 visits', price: 342, total: 342, footprintUsed: 1500 };
const sentLegacy = (extra = {}) => ({
  status: 'sent', sent_at: '2026-11-20T12:00:00Z',
  estimate_data: JSON.stringify({ engineResult: { lineItems: [legacyRow] }, result: { oneTime: { items: [legacyRow] } } }),
  ...extra,
});

beforeEach(() => { jest.clearAllMocks(); mockStored = null; });

test('an unreopened preview prices today\'s rule ($390); reopening a delivered legacy quote with no size change previews the sent $342', async () => {
  expect(fleaPrice((await invoke(quote({}))).payload)).toBe(390);
  mockStored = sentLegacy();
  expect(fleaPrice((await invoke(quote({}, { reviseEstimateId: ESTIMATE_ID }))).payload)).toBe(342);
});

test('an explicit size change on the reopened quote previews today\'s rule ($390), the number the save persists', async () => {
  mockStored = sentLegacy();
  expect(fleaPrice((await invoke(quote({ stories: 1 }, { reviseEstimateId: ESTIMATE_ID }))).payload)).toBe(390);
  expect(fleaPrice((await invoke(quote({ homeSqFt: 3200 }, { reviseEstimateId: ESTIMATE_ID }))).payload)).toBeGreaterThan(342);
});

test('an unsent draft, a technician, or a malformed id previews today\'s rule', async () => {
  mockStored = sentLegacy({ status: 'draft', sent_at: null });
  expect(fleaPrice((await invoke(quote({}, { reviseEstimateId: ESTIMATE_ID }))).payload)).toBe(390);
  mockStored = sentLegacy();
  expect(fleaPrice((await invoke(quote({}, { reviseEstimateId: ESTIMATE_ID }), 'technician')).payload)).toBe(390);
  expect(fleaPrice((await invoke(quote({}, { reviseEstimateId: 'not-a-uuid' }))).payload)).toBe(390);
});
