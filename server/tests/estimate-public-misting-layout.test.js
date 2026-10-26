process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ESTIMATE_DOC_PIN_SECRET = 'test-doc-pin-secret';

// GATE_MISTING_LAYOUT_DESIGNER: GET /:token/data carries `mistingLayout` (the saved sketch, the counts and the
// geometry the customer page animates the spray from) on a normal page load and on the document render pass,
// with both gates on, a saved layout, a misting system in the estimate and a layout drawn for the estimate's
// address. Everywhere else the key is absent and the response is as before.
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
  zones: [{ kind: 'pool', x: 600, y: 480, radiusFt: 6.5, label: 'staff note' }], pump: { x: 1, y: 2, checks: { outlet: true, level: true, dry: true, stucco: true } },
  center_lat: 27.4989, center_lng: -82.5748, zoom: 20, map_width: 1280, map_height: 960,
  lines: [
    { id: 'staff-line-7', kind: 'eave', points: [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 250 }] },
    { id: 'staff-line-8', kind: 'bed', points: [{ x: 10, y: 10 }, { x: 'bad', y: 20 }] },
  ],
  nozzles: [{ x: 120, y: 100, kind: 'eave', lineIndex: 0, aim: 45 }, { x: 200, y: 100, kind: 'eave', lineIndex: 0, aim: null, createdBy: 'staff-9' }],
  risers: [{ x: 50, y: 60, source: 'bed', lineIndex: 1 }, { x: 70, y: 80 }],
  created_by: 'staff-9', updated_by: 'staff-9',
};
const GEOMETRY = {
  center: { lat: 27.4989, lng: -82.5748 },
  zoom: 20,
  mapWidth: 1280,
  mapHeight: 960,
  lines: [{ kind: 'eave', points: [{ x: 100, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 250 }] }],
  nozzles: [{ x: 120, y: 100, kind: 'eave', lineIndex: 0, aim: 45 }, { x: 200, y: 100, kind: 'eave', lineIndex: 0 }],
  risers: [{ x: 50, y: 60, source: 'bed', lineIndex: 1 }, { x: 70, y: 80 }],
  pump: { x: 1, y: 2 },
  zones: [{ kind: 'pool', x: 600, y: 480, radiusFt: 6.5 }],
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

  test('the document render pass carries the signed sketch link, the counts and the geometry', async () => {
    gatesOn();
    dbRows = rows();
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl, '?mode=pdf');
      expect(body.error).toBeUndefined();
      expect(body.mistingLayout).toEqual({
        imageUrl: 'https://signed.example/layout.png',
        revision: expect.stringMatching(/^[0-9a-f]{16}$/),
        address: '123 Trust Ln, Bradenton, FL 34203',
        counts: { nozzles: 14, eave: 10, fence: 4, risers: 2, linearFt: 131.5, zones: 1, pump: true },
        geometry: GEOMETRY,
      });
    });
  });

  test('a normal page load carries the same block', async () => {
    gatesOn();
    dbRows = rows();
    await withServer(async (baseUrl) => {
      const page = await getData(baseUrl);
      const pdf = await getData(baseUrl, '?mode=pdf');
      expect(page.estimate).toBeDefined();
      expect(page.mistingLayout).toEqual(pdf.mistingLayout);
      expect(page.mistingLayout.imageUrl).toBe('https://signed.example/layout.png');
      expect(page.mistingLayout.geometry).toEqual(GEOMETRY);
    });
  });

  test('the public block holds no S3 key, staff id, line id, label or price', async () => {
    gatesOn();
    dbRows = rows();
    await withServer(async (baseUrl) => {
      const text = JSON.stringify((await getData(baseUrl)).mistingLayout);
      expect(text).not.toContain('service-photos');
      expect(text).not.toContain('1-aa-layout');
      expect(text).not.toContain('staff-');
      expect(text).not.toContain('staff note');
      expect(text).not.toMatch(/price|amount|snapshot_s3_key|createdBy|created_by/i);
    });
  });

  test('the pump spot checklist stays staff-only: the public pump is {x, y} and "checks" never appears', async () => {
    gatesOn();
    dbRows = rows();
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(body.mistingLayout.geometry.pump).toEqual({ x: 1, y: 2 });
      expect(JSON.stringify(body.mistingLayout)).not.toMatch(/checks|outlet|stucco/);
      const pdf = await getData(baseUrl, '?mode=pdf');
      expect(JSON.stringify(pdf.mistingLayout)).not.toMatch(/checks|outlet|stucco/);
    });
  });

  test.each(GATES)('%s off: neither the page load nor the render pass has the key', async (gate) => {
    gatesOn();
    delete process.env[gate];
    dbRows = rows();
    await withServer(async (baseUrl) => {
      for (const query of ['', '?mode=pdf']) {
        const body = await getData(baseUrl, query);
        expect(body.estimate).toBeDefined();
        expect(body).not.toHaveProperty('mistingLayout');
      }
    });
  });

  test('no saved layout, or no misting system in the estimate: no key', async () => {
    gatesOn();
    dbRows = { ...rows(), misting_layouts: undefined };
    await withServer(async (baseUrl) => {
      expect(await getData(baseUrl)).not.toHaveProperty('mistingLayout');
      expect(await getData(baseUrl, '?mode=pdf')).not.toHaveProperty('mistingLayout');
    });
    dbRows = rows(['lawn_care'], { services: { lawn: true } });
    await withServer(async (baseUrl) => {
      expect(await getData(baseUrl)).not.toHaveProperty('mistingLayout');
      expect(await getData(baseUrl, '?mode=pdf')).not.toHaveProperty('mistingLayout');
    });
  });

  test('a layout drawn for another address is not carried on either path', async () => {
    gatesOn();
    dbRows = { ...rows(), misting_layouts: { ...LAYOUT_ROW, address: '999 Other Rd, Bradenton, FL 34203' } };
    await withServer(async (baseUrl) => {
      expect(await getData(baseUrl)).not.toHaveProperty('mistingLayout');
      expect(await getData(baseUrl, '?mode=pdf')).not.toHaveProperty('mistingLayout');
    });
  });
});
