process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// GET /:token/data carries the server's guarantee decision
// (estimate-followup-copy.js estimateMakesNoGuaranteeClaim): termite work
// carries no guarantee of any kind (owner ruling), so an estimate with a
// termite lane (bait, foam, trenching, pre-slab, Bora-Care, WDO), or one whose
// lanes can't be classified, ships noGuaranteeClaims: true. The React page and
// proposal document read it wherever they'd make an estimate-wide guarantee
// claim. Absent otherwise, so every other response stays byte-identical.
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => sql);
  return mock;
});
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  isEnabled: jest.fn(() => false),
  gateEnvValue: jest.fn(() => false),
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
    id: 'est-noguarantee-1',
    token: 'noguaranteetoken',
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

describe('GET /:token/data — noGuaranteeClaims', () => {
  beforeEach(() => { dbRows = {}; });

  async function dataFor(row) {
    dbRows = { estimates: row };
    return withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/estimates/${row.token}/data`);
      expect(res.status).toBe(200);
      return res.json();
    });
  }

  test('a pest-only plan carries no flag (its guarantee claims stand)', async () => {
    const base = estimateRow();
    const body = await dataFor(estimateRow({
      id: 'est-pest-only', token: 'pestonlyplantoken', onetime_total: 0,
      estimate_data: { ...base.estimate_data, result: { ...base.estimate_data.result, oneTime: { items: [], membershipFee: 0 } } },
    }));
    expect(body.estimate).not.toHaveProperty('noGuaranteeClaims');
  });

  test('pest + a WDO inspection (a termite lane) is flagged', async () => {
    const body = await dataFor(estimateRow({ id: 'est-pest-wdo', token: 'pestwdoinspectiontoken' }));
    expect(body.estimate.noGuaranteeClaims).toBe(true);
  });

  test('termite bait monitoring is flagged', async () => {
    const base = estimateRow();
    const body = await dataFor(estimateRow({
      id: 'est-termite-bait', token: 'termitebaittoken', onetime_total: 0, monthly_total: 45, annual_total: 540,
      estimate_data: {
        ...base.estimate_data,
        result: { recurring: { discount: 0, services: [{ name: 'Termite Bait Monitoring', mo: 45 }] }, oneTime: { items: [], membershipFee: 0 } },
      },
    }));
    expect(body.estimate.noGuaranteeClaims).toBe(true);
  });
});
