process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// GATE_ESTIMATE_LAWN_LIMITS: GET /:token/data carries `lawnLimits` (the "What we can and can't
// fix" block) on a recurring lawn estimate only, and the legacy server-rendered page prints
// the same copy. With the gate off, or on a pest-only estimate, the response is as before.
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
const { buildLawnLimits } = require('../services/estimate-lawn-limits');

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
    id: 'est-lawn-limits', token: 'lawnlimitstoken', status: 'sent', sent_at: null, viewed_at: null,
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
const getData = (baseUrl) => fetch(`${baseUrl}/estimates/lawnlimitstoken/data`).then((r) => r.json());

const PROFILE = { active: true, grass_type: 'st_augustine', other_grasses: ['carpetgrass', 'dallisgrass'], virus_streaks_suspected: true };
const PROPERTIES = [{ id: 'prop-a', customer_id: 'cust-synthetic-1', active: true, is_primary: true }];

afterEach(() => { delete process.env.GATE_ESTIMATE_LAWN_LIMITS; });

describe('GET /:token/data — lawn limits (GATE_ESTIMATE_LAWN_LIMITS)', () => {
  beforeEach(() => { dbRows = { estimates: estimateRow({ services: ['lawn_care'] }), customer_turf_profiles: PROFILE, customer_properties: PROPERTIES, customers: { lawn_type: null } }; });

  test('gate off: no lawnLimits key', async () => {
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(body.error).toBeUndefined();
      expect(body.estimate).toBeDefined();
      expect(body).not.toHaveProperty('lawnLimits');
    });
  });

  test('gate on, lawn estimate: the fixed paragraph plus a line per flag, no prices', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(body.lawnLimits).toEqual(buildLawnLimits({ otherGrasses: ['carpetgrass', 'dallisgrass'], virusStreaksSuspected: true }));
      expect(body.lawnLimits.paragraphs.map((p) => p.key)).toEqual(['always', 'carpetgrass', 'dallisgrass', 'virus_streaks']);
      expect(JSON.stringify(body.lawnLimits)).not.toMatch(/\$|\d/);
    });
  });

  test('gate on, lawn estimate, no flags set: the fixed paragraph alone', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    dbRows = { ...dbRows, customer_turf_profiles: { ...PROFILE, other_grasses: null, virus_streaks_suspected: null } };
    await withServer(async (baseUrl) => {
      expect((await getData(baseUrl)).lawnLimits.paragraphs.map((p) => p.key)).toEqual(['always']);
    });
  });

  test('gate on, bermuda lawn: no lawnLimits key', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    dbRows = { ...dbRows, customer_turf_profiles: { ...PROFILE, grass_type: 'bermuda' } };
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(body.estimate).toBeDefined();
      expect(body).not.toHaveProperty('lawnLimits');
    });
  });

  test('gate on, inactive profile: the fixed paragraph only', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    // The fake database does not run the active filter, so an inactive-only customer is no row.
    dbRows = { ...dbRows, customer_turf_profiles: undefined };
    await withServer(async (baseUrl) => {
      expect((await getData(baseUrl)).lawnLimits.paragraphs.map((p) => p.key)).toEqual(['always']);
    });
  });

  test('gate on, several properties and the estimate names none: the fixed paragraph only', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    dbRows = { ...dbRows, customer_properties: [...PROPERTIES, { id: 'prop-b', customer_id: 'cust-synthetic-1', active: true, is_primary: false }] };
    await withServer(async (baseUrl) => {
      expect((await getData(baseUrl)).lawnLimits.paragraphs.map((p) => p.key)).toEqual(['always']);
    });
  });

  test('gate on, pest-only estimate: no lawnLimits key', async () => {
    process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true';
    dbRows = { ...dbRows, estimates: estimateRow({ services: ['pest_control'] }) };
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(body.estimate).toBeDefined();
      expect(body).not.toHaveProperty('lawnLimits');
    });
  });
});

describe('GET /:token/data — a terminal estimate prints only its stored block', () => {
  const STORED = buildLawnLimits({ otherGrasses: ['bahiagrass'] });
  const accepted = (stored) => {
    const row = estimateRow({ services: ['lawn_care'], overrides: { status: 'accepted', accepted_at: new Date().toISOString(), price_locked_at: new Date().toISOString() } });
    if (stored) row.estimate_data = { ...row.estimate_data, lawnLimitsAtAccept: stored };
    return row;
  };
  beforeEach(() => { process.env.GATE_ESTIMATE_LAWN_LIMITS = 'true'; });

  test('accepted with a stored block: the stored block, whatever the profile says now', async () => {
    dbRows = { estimates: accepted(STORED), customer_turf_profiles: PROFILE, customer_properties: PROPERTIES, customers: { lawn_type: null } };
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(body.estimate).toBeDefined();
      expect(body.lawnLimits).toEqual(STORED);
    });
  });

  test('accepted before this shipped (nothing stored): no block, even though the live profile has flags', async () => {
    dbRows = { estimates: accepted(null), customer_turf_profiles: PROFILE, customer_properties: PROPERTIES, customers: { lawn_type: null } };
    await withServer(async (baseUrl) => {
      const body = await getData(baseUrl);
      expect(body.estimate).toBeDefined();
      expect(body).not.toHaveProperty('lawnLimits');
    });
  });

  test('an open estimate still follows the live flags', async () => {
    dbRows = { estimates: estimateRow({ services: ['lawn_care'] }), customer_turf_profiles: PROFILE, customer_properties: PROPERTIES, customers: { lawn_type: null } };
    await withServer(async (baseUrl) => {
      expect((await getData(baseUrl)).lawnLimits.paragraphs.map((p) => p.key)).toEqual(['always', 'carpetgrass', 'dallisgrass', 'virus_streaks']);
    });
  });
});

describe('legacy server-rendered page — lawn limits', () => {
  const { renderPage } = estimatePublicRouter;
  const estimate = () => ({ id: 'est-ssr-1', status: 'sent', customerName: 'Pat Tester', address: '123 Trust Ln, Bradenton, FL 34203', monthlyTotal: 42.3, annualTotal: 507.6, onetimeTotal: 0, quoteRequired: false });
  const data = () => ({ result: { recurring: { services: [{ service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 6, mo: 42.3, annual: 507.6 }] } } });

  test('no lawnLimits option: no block (the page as before)', () => {
    const html = renderPage('ssr-token-1', estimate(), data());
    expect(html).not.toContain('data-lawn-limits');
    expect(html).not.toContain('can&#39;t fix');
  });

  test('the page script attests the block: the hash with a block, empty without, sent with both accepts', () => {
    const block = buildLawnLimits({ otherGrasses: ['bermudagrass'] });
    const withBlock = renderPage('ssr-token-3', estimate(), data(), null, { lawnLimits: block });
    expect(withBlock).toContain(`const LAWN_LIMITS_HASH = ${JSON.stringify(require('../services/estimate-lawn-limits').lawnLimitsHash(block))};`);
    expect(renderPage('ssr-token-4', estimate(), data())).toContain('const LAWN_LIMITS_HASH = "";');
    expect(withBlock.match(/payload\.lawnLimitsHash = LAWN_LIMITS_HASH/g)).toHaveLength(2);
    expect(withBlock).toContain("data.code === 'LAWN_LIMITS_STALE'");
  });

  test('with the option: the heading and every paragraph, escaped', () => {
    const html = renderPage('ssr-token-2', estimate(), data(), null, { lawnLimits: buildLawnLimits({ otherGrasses: ['bermudagrass'], virusStreaksSuspected: true }) });
    expect(html).toContain('data-lawn-limits="true"');
    expect(html).toContain('What we can and can&#39;t fix');
    expect(html).toContain('data-lawn-limit="always"');
    expect(html).toContain('data-lawn-limit="bermudagrass"');
    expect(html).toContain('data-lawn-limit="virus_streaks"');
    expect(html).toContain('Bermudagrass is creeping into your St. Augustine.');
  });
});
