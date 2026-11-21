process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ESTIMATE_DOC_PIN_SECRET = 'test-doc-pin-secret';

// Roof points on the customer estimate (owner ruling 2026-11-20, choice 4A): GET /:token/data carries `roofPoints` only
// when a frozen copy exists for the estimate's latest handoff, staff have not hidden it now, and the estimate is still at
// the address it was sent for. In every other case the response is byte-identical to an estimate that never had points.
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../services/estimate-proposal-billing', () => ({
  ...jest.requireActual('../services/estimate-proposal-billing'),
  resolveProposalBillingContext: jest.fn(async () => ({ billsPerApplication: true, livePricing: null })),
}));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn((gate) => gate === 'estimateDocPdf'),
  mosquitoMistingLive: jest.fn(() => false),
  mistingLayoutDesignerLive: jest.fn(() => false),
  gateEnvValue: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({ getCachedLookup: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn().mockResolvedValue(null),
  publicMembershipView: jest.fn((snapshot) => snapshot ?? null),
}));
jest.mock('../services/estimate-deposits', () => ({
  ensureDepositSatisfied: jest.fn(),
  resolveDepositPolicyForEstimate: jest.fn().mockResolvedValue({ enforced: false, required: false, slotRequired: false }),
  computeDepositAmount: jest.fn(() => 0),
  pendingDepositCredit: jest.fn(),
  consumeDepositCredit: jest.fn(),
  refundUnconsumedDeposits: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

jest.setTimeout(60000);
const express = require('express');
const db = require('../models/db');
const estimatePublicRouter = require('../routes/estimate-public');

let dbRows = {};
function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereNotIn: jest.fn(() => chain),
    whereNotNull: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain),
    orWhere: jest.fn(() => chain),
    orWhereRaw: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    first: jest.fn().mockResolvedValue(Array.isArray(result) ? result[0] : result),
    update: jest.fn(async () => 1),
    insert: jest.fn().mockResolvedValue([1]),
    then: Array.isArray(result) ? (resolve, reject) => Promise.resolve(result).then(resolve, reject) : undefined,
  };
  return chain;
}
// roof_entry_reads answers by its where clauses: the hide check asks for a hidden read of the estimate.
function readsChain(rows = []) {
  let where = {};
  const chain = {
    where: (w) => { where = { ...where, ...w }; return chain; },
    first: async () => rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)),
  };
  return chain;
}
db.mockImplementation((table) => (table === 'roof_entry_reads' ? readsChain(dbRows[table]) : chainFor(dbRows[table])));

const ADDRESS = '123 Trust Ln, Bradenton, FL 34203';
const SENT = '2026-11-20T16:00:00.000Z';
function estimateRow(overrides = {}) {
  return {
    id: 'est-roof-points', token: 'roofpointstoken', status: 'sent', sent_at: null, viewed_at: null,
    customer_id: 'cust-synthetic-1',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester', customer_phone: null, customer_email: null, category: 'RESIDENTIAL',
    address: ADDRESS, satellite_url: null, waveguard_tier: 'Silver', bill_by_invoice: false,
    service_interest: 'Lawn',
    monthly_total: 42.3, annual_total: 507.6, onetime_total: 0,
    estimate_data: {
      deliveryState: { firstDeliveredAt: SENT, lastDeliveredAt: SENT },
      result: { recurring: { services: [{ service: 'lawn_care', name: 'lawn_care', visitsPerYear: 6 }] } },
      sendSnapshot: { pricingBundle: {
        combinedRecurring: { waveGuardDiscountPct: 0 },
        frequencies: [{ key: 'quarterly', monthly: 42.3, annual: 507.6, perServiceTreatments: [{ label: 'lawn_care', service: 'lawn_care', displayPrice: 56.4, visitsPerYear: 6, monthly: 42.3 }] }],
        oneTimeBreakdown: { items: [] },
      } },
    },
    ...overrides,
  };
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/estimates', estimatePublicRouter);
  app.use((err, _req, res, _next) => { res.status(err.status || 500).json({ error: err.message }); });
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}
const getText = (baseUrl, query = '') => fetch(`${baseUrl}/estimates/roofpointstoken/data${query}`).then((r) => r.text());

// These fields differ between any two requests: the row's own expiry and the answer's time stamp are built from the
// clock, and the ask token is signed per request with a one-second time stamp.
const VOLATILE = ['.estimate.expiresAt', '.estimate.askToken', '.meta.generatedAt'];
function diffPaths(a, b, path = '') {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((k) => diffPaths(a[k], b[k], `${path}.${k}`));
  }
  return a === b || VOLATILE.includes(path) ? [] : [path];
}

const SNAPSHOT = {
  imageUrl: 'https://example.test/aerial.jpg',
  imageYear: 2025,
  pins: [{ n: 1, x: 0.25, y: 0.4, type: 'roof_returns_and_valleys', label: 'Roof return, front left', action: 'seal' }],
};
const POINT = { estimate_id: 'est-roof-points', read_id: 'read-1', address: ADDRESS, snapshot: SNAPSHOT, delivered_at: new Date(SENT) };
const READ = { id: 'read-1', estimate_id: 'est-roof-points', status: 'done', tech_pins: [{}], hide_on_estimate: false };
const base = (extra = {}) => ({
  estimates: estimateRow(extra.estimate),
  customer_turf_profiles: null,
  customer_properties: [{ id: 'prop-a', customer_id: 'cust-synthetic-1', active: true, is_primary: true }],
  customers: { lawn_type: null },
  ...extra.tables,
});

describe('GET /:token/data: roofPoints', () => {
  test('a frozen, visible copy rides the page load as { imageUrl, imageYear, pins }', async () => {
    dbRows = base({ tables: { estimate_roof_points: POINT, roof_entry_reads: [READ] } });
    await withServer(async (baseUrl) => {
      const body = JSON.parse(await getText(baseUrl));
      expect(body.estimate).toBeDefined();
      expect(body.roofPoints).toEqual(SNAPSHOT);
    });
  });

  test('a copy from an older handoff than the estimate\'s latest leaves the response byte-identical', async () => {
    let none;
    dbRows = base();
    await withServer(async (baseUrl) => { none = await getText(baseUrl); });
    const stale = { ...POINT, delivered_at: new Date('2026-11-19T16:00:00.000Z') };
    dbRows = base({ tables: { estimate_roof_points: stale, roof_entry_reads: [READ] } });
    await withServer(async (baseUrl) => { expect(diffPaths(JSON.parse(await getText(baseUrl)), JSON.parse(none))).toEqual([]); });
  });

  test('hidden now, a moved address, and no frozen copy all leave the response byte-identical', async () => {
    let none;
    dbRows = base();
    await withServer(async (baseUrl) => { none = await getText(baseUrl); });
    expect(none).not.toContain('roofPoints');

    dbRows = base({ tables: { estimate_roof_points: POINT, roof_entry_reads: [{ ...READ, hide_on_estimate: true }] } });
    await withServer(async (baseUrl) => { expect(diffPaths(JSON.parse(await getText(baseUrl)), JSON.parse(none))).toEqual([]); });

    // Hidden on a later read of the estimate that has no points: the copy's own read is not hidden, the estimate is.
    dbRows = base({ tables: { estimate_roof_points: POINT, roof_entry_reads: [READ, { ...READ, id: 'read-2', tech_pins: null, hide_on_estimate: true }] } });
    await withServer(async (baseUrl) => { expect(diffPaths(JSON.parse(await getText(baseUrl)), JSON.parse(none))).toEqual([]); });

    dbRows = base({ estimate: { address: '99 Other Road, Sarasota, FL 34232' }, tables: { estimate_roof_points: POINT, roof_entry_reads: [READ] } });
    await withServer(async (baseUrl) => {
      const moved = JSON.parse(await getText(baseUrl));
      expect(moved.estimate).toBeDefined();
      expect(moved).not.toHaveProperty('roofPoints');
    });
  });

  test('the public block holds only the photo link, the year and the numbered points', async () => {
    dbRows = base({ tables: { estimate_roof_points: { ...POINT, snapshot: { ...SNAPSHOT, staffNote: 'x' } }, roof_entry_reads: [READ] } });
    await withServer(async (baseUrl) => {
      const body = JSON.parse(await getText(baseUrl));
      expect(Object.keys(body.roofPoints).sort()).toEqual(['imageUrl', 'imageYear', 'pins']);
      expect(Object.keys(body.roofPoints.pins[0]).sort()).toEqual(['action', 'label', 'n', 'type', 'x', 'y']);
    });
  });
});
