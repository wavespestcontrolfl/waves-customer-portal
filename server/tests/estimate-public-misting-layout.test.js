process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ESTIMATE_DOC_PIN_SECRET = 'test-doc-pin-secret';

// GATE_MISTING_LAYOUT_DESIGNER (step 3): GET /:token/data carries `mistingLayout` (the saved sketch
// and counts for the estimate document's "Proposed misting layout" section) on the document render
// pass only, with both gates on, a saved layout and a misting system in the estimate. Everywhere
// else the key is absent and the response is as before.
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
  mosquitoMistingLive: jest.fn(() => process.env.GATE_MOSQUITO_MISTING === 'true'),
  mistingLayoutDesignerLive: jest.fn(() => process.env.GATE_MISTING_LAYOUT_DESIGNER === 'true'),
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
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/layout.png') }));
jest.mock('../config', () => ({ ...jest.requireActual('../config'), s3: { bucket: 'test-bucket', region: 'us-east-1' } }));
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
    // Awaiting a builder yields the rows (customer_properties is read as a list).
    then: Array.isArray(result) ? (resolve, reject) => Promise.resolve(result).then(resolve, reject) : undefined,
  };
  return chain;
}
db.mockImplementation((table) => chainFor(dbRows[table]));

function estimateRow({ services, overrides = {} }) {
  return {
    id: 'est-misting-layout', token: 'mistinglayouttoken', status: 'sent', sent_at: null, viewed_at: null,
    customer_id: 'cust-synthetic-1',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester', customer_phone: null, customer_email: null, category: 'RESIDENTIAL',
    address: '123 Trust Ln, Bradenton, FL 34203', satellite_url: null, waveguard_tier: 'Silver', bill_by_invoice: false,
    service_interest: 'Lawn',
    monthly_total: 42.3, annual_total: 507.6, onetime_total: 0,
    estimate_data: {
      result: { recurring: { services: services.map((s) => ({ service: s, name: s, visitsPerYear: 6 })) } },
      sendSnapshot: { pricingBundle: {
        combinedRecurring: { waveGuardDiscountPct: 0 },
        frequencies: [{
          key: 'quarterly', monthly: 42.3, annual: 507.6,
          perServiceTreatments: services.map((s) => ({ label: s, service: s, displayPrice: 56.4, visitsPerYear: 6, monthly: 42.3 })),
        }],
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
const getData = (baseUrl, query = '') => fetch(`${baseUrl}/estimates/mistinglayouttoken/data${query}`).then((r) => r.json());

const LAYOUT_ROW = {
  estimate_id: 'est-misting-layout', snapshot_s3_key: 'service-photos/misting-layouts/est-misting-layout/1-aa-layout.png',
  address: '123 Trust Ln, Bradenton, FL 34203', nozzle_count: 14, eave_count: 10, fence_count: 4, riser_count: 2, linear_ft: 131.5,
  zones: [{ kind: 'pool' }], pump: { x: 1, y: 2 },
};
const PROPERTIES = [{ id: 'prop-a', customer_id: 'cust-synthetic-1', active: true, is_primary: true }];
const GATES = ['GATE_MOSQUITO_MISTING', 'GATE_MISTING_LAYOUT_DESIGNER'];
const gatesOn = () => GATES.forEach((g) => { process.env[g] = 'true'; });

afterEach(() => { GATES.forEach((g) => { delete process.env[g]; }); });

describe('GET /:token/data — misting layout section (GATE_MISTING_LAYOUT_DESIGNER)', () => {
  const rows = (services = ['mosquito_misting'], inputs = { services: { mosquitoMisting: true } }) => ({
    estimates: (() => {
      const row = estimateRow({ services });
      row.estimate_data = { ...row.estimate_data, engineInputs: inputs };
      return row;
    })(),
    misting_layouts: LAYOUT_ROW,
    customer_turf_profiles: null,
    customer_properties: PROPERTIES,
    customers: { lawn_type: null },
  });

  test('the document render pass carries the signed sketch link and the counts', async () => {
    gatesOn();
    dbRows = rows();
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl, '?mode=pdf');
      expect(body.error).toBeUndefined();
      expect(body.mistingLayout).toEqual({
        imageUrl: 'https://signed.example/layout.png',
        address: '123 Trust Ln, Bradenton, FL 34203',
        counts: { nozzles: 14, eave: 10, fence: 4, risers: 2, linearFt: 131.5, zones: 1, pump: true },
      });
    });
  });

  test('a normal page load never carries it, even with a saved layout and both gates on', async () => {
    gatesOn();
    dbRows = rows();
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(body.estimate).toBeDefined();
      expect(body).not.toHaveProperty('mistingLayout');
    });
  });

  test.each(GATES)('%s off: the render pass has no key', async (gate) => {
    gatesOn();
    delete process.env[gate];
    dbRows = rows();
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl, '?mode=pdf');
      expect(body.estimate).toBeDefined();
      expect(body).not.toHaveProperty('mistingLayout');
    });
  });

  test('no saved layout, or no misting system in the estimate: no key', async () => {
    gatesOn();
    dbRows = { ...rows(), misting_layouts: undefined };
    await withServer(async (baseUrl) => {
      expect(await getData(baseUrl, '?mode=pdf')).not.toHaveProperty('mistingLayout');
    });
    dbRows = rows(['lawn_care'], { services: { lawn: true } });
    await withServer(async (baseUrl) => {
      expect(await getData(baseUrl, '?mode=pdf')).not.toHaveProperty('mistingLayout');
    });
  });
});
