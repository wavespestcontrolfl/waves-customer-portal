process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// WDO + pre-treatment termite certificates are FDACS paper compliance
// documents (AGENTS.md): no AI narrative, no Ask bar. GET /:token/data must
// classify the estimate from the RAW normalized one-time rows unioned with
// the pricing bundle — alignOneTimeChoiceBreakdown (show_one_time_option)
// replaces raw rows with the synthetic one-time choice and can drop the WDO
// row, which would let intelligence + askChips render on the certificate
// surface (pre-push codex P1 on #3704).
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  gates: {},
}));
jest.mock('../services/property-lookup/lookup-cache', () => ({
  getCachedLookup: jest.fn().mockResolvedValue(null),
}));
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

const express = require('express');
const db = require('../models/db');
const estimatePublicRouter = require('../routes/estimate-public');

let dbRows = {};
function chainFor(result) {
  const chain = {
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    whereRaw: jest.fn(() => chain),
    andWhere: jest.fn(() => chain),
    orWhere: jest.fn(() => chain),
    orWhereRaw: jest.fn(() => chain),
    leftJoin: jest.fn(() => chain),
    select: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    first: jest.fn().mockResolvedValue(result),
    update: jest.fn().mockResolvedValue(1),
    insert: jest.fn().mockResolvedValue([1]),
  };
  return chain;
}
db.mockImplementation((table) => chainFor(dbRows[table]));

function estimateRow(overrides = {}) {
  return {
    id: 'est-regulated-1',
    token: 'regulatedsurfacetoken',
    status: 'sent',
    sent_at: null,
    viewed_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester',
    customer_phone: null,
    customer_email: null,
    address: '123 Trust Ln, Bradenton, FL 34203',
    satellite_url: null,
    waveguard_tier: 'Bronze',
    bill_by_invoice: false,
    monthly_total: 88,
    annual_total: 1056,
    onetime_total: 125,
    estimate_data: {
      sendSnapshot: {
        pricingBundle: {
          frequencies: [{ key: 'quarterly', label: 'Quarterly', monthly: 88, annual: 1056 }],
          waveGuardTier: 'Bronze',
          anchorOneTimePrice: 125,
          source: 'send_snapshot_fixture',
        },
      },
      result: {
        recurring: { discount: 0, services: [{ name: 'Pest Control', mo: 88 }] },
        oneTime: { items: [{ service: 'wdo_inspection', name: 'WDO Inspection', price: 125 }], membershipFee: 0 },
      },
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

describe('GET /:token/data — regulated certificate surface', () => {
  beforeEach(() => { dbRows = {}; });

  test.each([false, true])('pest plan + WDO row (show_one_time_option=%s) ships no intelligence and no ask chips', async (showOneTimeOption) => {
    dbRows = { estimates: estimateRow({ show_one_time_option: showOneTimeOption }) };
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/regulatedsurfacetoken/data`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.estimate.intelligence ?? body.intelligence ?? null).toBeNull();
      expect(body.pricing.askChips).toEqual([]);
      // The React page consumes this ahead of its own row-based derivation.
      expect(body.estimate.regulatedCertificateSurface).toBe(true);
    });
  });

  test('a standalone termite inspection is not a certificate surface', async () => {
    const base = estimateRow();
    // Own token: the route keeps per-token state across requests, so reusing
    // the WDO token would replay the certificate surface here.
    dbRows = { estimates: estimateRow({
      id: 'est-termite-inspection-1',
      token: 'termiteinspectiontoken',
      estimate_data: {
        ...base.estimate_data,
        result: {
          ...base.estimate_data.result,
          oneTime: { items: [{ service: 'termite_inspection', name: 'Termite Inspection Service', price: 125 }], membershipFee: 0 },
        },
      },
    }) };
    await withServer(async (baseUrl) => {
      const body = await (await fetch(`${baseUrl}/estimates/termiteinspectiontoken/data`)).json();
      expect(body.pricing.askChips.length).toBeGreaterThan(0);
      expect('regulatedCertificateSurface' in body.estimate).toBe(false);
    });
  });
});
