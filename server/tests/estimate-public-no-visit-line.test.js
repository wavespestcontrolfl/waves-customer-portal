process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ESTIMATE_DOC_PIN_SECRET = 'test-doc-pin-secret';

// The "no visit needed" line on the customer estimate page (owner 2026-11-22, option B): GET /:token/data carries
// `noVisitLine`, the owner's exact sentence, only on the page load of an open home estimate whose every service Waves
// prices from the measured home and yard alone (an exact list of programs). In every other case the key is absent. The page prints the words
// under the satellite photo; who gets them is decided here, by the same home rule as the estimate email.
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
// A staff preview needs a staff Bearer the route verifies: the fake accepts one token and nothing else. The query
// parameter alone must never be enough.
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  verifyStaffBearer: jest.fn(async (req) => (req.headers.authorization === 'Bearer staff-ok' ? { id: 'tech-1', role: 'admin' } : null)),
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
db.mockImplementation((table) => chainFor(dbRows[table]));

const { NO_VISIT_QUOTE_LINE, noVisitLinePageBlock } = require('../services/estimate-no-visit-line');
const { serviceMixIsRemoteMeasured, estimateIsRemoteMeasured } = estimatePublicRouter;

const SENT = '2026-11-20T16:00:00.000Z';
const recurringRow = (service) => ({ service, name: service, visitsPerYear: 6 });
// A sent home estimate. `services` are its recurring service keys; `oneTime` its one-time rows. Each row gets its own id:
// the route keeps per-estimate memos, so two fixtures under one id would read each other's price state.
let rowSeq = 0;
function estimateRow({ services = ['pest_control'], oneTime = [], estimateData = {}, ...overrides } = {}) {
  rowSeq += 1;
  return {
    id: `est-no-visit-line-${rowSeq}`, token: 'novisitlinetoken', status: 'sent', sent_at: null, viewed_at: null,
    customer_id: 'cust-synthetic-1',
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    customer_name: 'Pat Tester', customer_phone: null, customer_email: null, category: 'RESIDENTIAL',
    address: '123 Trust Ln, Bradenton, FL 34203', satellite_url: null, waveguard_tier: 'Silver', bill_by_invoice: false,
    service_interest: 'Pest Control',
    monthly_total: 42.3, annual_total: 507.6, onetime_total: 0,
    estimate_data: {
      deliveryState: { firstDeliveredAt: SENT, lastDeliveredAt: SENT },
      // One-time rows sit where an estimate saves them (result.oneTime) and in the price snapshot made from them.
      result: {
        recurring: { services: services.map(recurringRow) },
        ...(oneTime.length ? { oneTime: { items: oneTime, total: oneTime.reduce((sum, item) => sum + item.amount, 0) } } : {}),
      },
      sendSnapshot: { pricingBundle: {
        combinedRecurring: { waveGuardDiscountPct: 0 },
        frequencies: [{ key: 'quarterly', monthly: 42.3, annual: 507.6, perServiceTreatments: services.map((service) => ({ label: service, service, displayPrice: 56.4, visitsPerYear: 6, monthly: 42.3, annual: 507.6 })) }],
        oneTimeBreakdown: { items: oneTime },
      } },
      ...estimateData,
    },
    ...overrides,
  };
}
const tables = (estimate) => ({
  estimates: estimate,
  customer_turf_profiles: null,
  customer_properties: [{ id: 'prop-a', customer_id: 'cust-synthetic-1', active: true, is_primary: true }],
  customers: { lawn_type: null },
});

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
async function pageLoad(estimate, query = '') {
  dbRows = tables(estimate);
  return withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/estimates/novisitlinetoken/data${query}`);
    return { status: res.status, body: await res.json() };
  });
}

describe('serviceMixIsRemoteMeasured: is every service on the estimate priced from the measured home and yard alone', () => {
  const pest = recurringRow('pest_control');
  const lawn = recurringRow('lawn_care');
  const oneTimePest = { service: 'one_time_pest', name: 'One-Time Pest Control', amount: 199 };

  test('the recurring pest, lawn, tree and shrub, mosquito and termite bait plans are, alone or together', () => {
    for (const key of ['pest_control', 'lawn_care', 'tree_shrub', 'mosquito', 'termite_bait']) {
      expect([key, serviceMixIsRemoteMeasured([recurringRow(key)], [])]).toEqual([key, true]);
    }
    expect(serviceMixIsRemoteMeasured([pest, lawn, recurringRow('mosquito')], [])).toBe(true);
  });

  test('the general one-time pest, lawn and mosquito services are, alone or beside a plan', () => {
    for (const service of ['one_time_pest', 'one_time_lawn', 'one_time_mosquito', 'ONE_TIME_PEST']) {
      expect([service, serviceMixIsRemoteMeasured([], [{ service, name: 'One-time service', amount: 150 }])]).toEqual([service, true]);
      expect([service, serviceMixIsRemoteMeasured([pest], [{ service, name: 'One-time service', amount: 150 }])]).toEqual([service, true]);
    }
  });

  test('a recurring service off the list is not, and it takes the whole estimate with it', () => {
    const offList = [
      'rodent', 'rodent_bait', 'mosquito_misting', 'foam_recurring', 'termite_trenching', 'pre_slab_termiticide',
      // A palm injection shows under tree and shrub on the page, but its price needs a confirmed diagnosis.
      'palm_injection',
      // Rows of a termite bait plan that are not the plan itself.
      'termite_station_rental', 'termite_bond_10yr',
      'commercial_pest', 'commercial_lawn', 'some_new_service',
    ];
    for (const key of offList) {
      expect([key, serviceMixIsRemoteMeasured([recurringRow(key)], [])]).toEqual([key, false]);
      expect([key, serviceMixIsRemoteMeasured([pest, recurringRow(key)], [])]).toEqual([key, false]);
    }
    expect(serviceMixIsRemoteMeasured([{ ...pest, isCommercial: true }], [])).toBe(false);
  });

  test('a one-time service off the list is not: its category on the page does not count', () => {
    const offList = [
      // These read as pest control on the page. Their price comes from rooms, an infestation or a nest, not the home's size.
      { service: 'bed_bug', name: 'Bed Bug Treatment', amount: 900 },
      { service: 'german_roach', name: 'German Roach Cleanout Service', amount: 450 },
      { service: 'flea_package', name: 'Flea Elimination Package', amount: 300 },
      { service: 'stinging_insect', name: 'Stinging Insect', amount: 180 },
      { service: 'pest_initial_roach', name: 'Initial Roach Service', amount: 150 },
      // These read as lawn care or tree and shrub on the page.
      { service: 'top_dressing', name: 'Top Dressing', amount: 600 },
      { service: 'palm_injection', name: 'Palm Injection', amount: 240 },
      { service: 'wdo_inspection', name: 'WDO Inspection', amount: 150 },
      { service: 'rodent_exclusion', name: 'Rodent Exclusion', amount: 900 },
      { service: 'rodent_trapping', name: 'Rodent Trapping', amount: 400 },
      { service: 'trenching', name: 'Termite Trenching', amount: 1200 },
      { service: 'bora_care', name: 'Bora-Care Treatment', amount: 800 },
      { service: 'foam_drill', name: 'Termite Foam Service', amount: 400 },
      { service: 'trap_only_rodent', name: 'Trap Only', amount: 250 },
      { service: 'mosquito_misting_installation', name: 'Misting System Installation', amount: 3000 },
      { service: 'area_addon', name: 'Garage', addOnKey: 'garage', amount: 20 },
      // A service row with a name and no key: nothing says which program it is.
      { name: 'One-Time Pest Control', amount: 199 },
      { service: 'custom_job', name: 'Attic work', amount: 500 },
    ];
    for (const item of offList) {
      const label = item.service || item.name;
      expect([label, serviceMixIsRemoteMeasured([pest], [item])]).toEqual([label, false]);
      expect([label, serviceMixIsRemoteMeasured([], [oneTimePest, item])]).toEqual([label, false]);
    }
  });

  test('it fails closed on an estimate with no service row', () => {
    expect(serviceMixIsRemoteMeasured([], [])).toBe(false);
    expect(serviceMixIsRemoteMeasured(null, undefined)).toBe(false);
    expect(serviceMixIsRemoteMeasured([null, 'pest_control'], [null])).toBe(false);
  });

  test('setup, discount and membership rows are not services: they neither count nor block', () => {
    const notServices = [
      { service: 'waveguard_setup', name: 'WaveGuard Setup', amount: 99 },
      { service: 'one_time_adjustment', name: 'Discount', amount: -20 },
      { service: 'manual_discount', name: 'Manual discount', amount: -10 },
    ];
    expect(serviceMixIsRemoteMeasured([pest], notServices)).toBe(true);
    expect(serviceMixIsRemoteMeasured([pest, { service: 'waveguard_membership', name: 'WaveGuard Membership' }], [])).toBe(true);
    // Rows that are not services do not make an estimate with no service a measured one.
    expect(serviceMixIsRemoteMeasured([], notServices)).toBe(false);
    // A positive "other one-time services" remainder is real work nothing classified.
    expect(serviceMixIsRemoteMeasured([pest], [{ service: 'one_time_adjustment', name: 'Other one-time services', amount: 75 }])).toBe(false);
  });
});

describe('estimateIsRemoteMeasured: the rule reads every saved shape of the estimate', () => {
  const plan = (...keys) => ({ recurring: { services: keys.map(recurringRow) } });

  test('one saved shape, and two that agree, are read as they are', () => {
    expect(estimateIsRemoteMeasured({ result: plan('pest_control') }, {})).toBe(true);
    expect(estimateIsRemoteMeasured({ engineResult: plan('pest_control', 'lawn_care') }, {})).toBe(true);
    expect(estimateIsRemoteMeasured({ result: plan('pest_control'), engineResult: plan('pest_control') }, {})).toBe(true);
  });

  test('a service that only the second saved shape holds still counts', () => {
    expect(estimateIsRemoteMeasured({ result: plan('pest_control'), engineResult: plan('pest_control', 'rodent_bait') }, {})).toBe(false);
    expect(estimateIsRemoteMeasured({ result: plan('pest_control', 'rodent_bait'), engineResult: plan('pest_control') }, {})).toBe(false);
  });

  test('the price snapshot\'s one-time rows count', () => {
    const estData = { result: plan('pest_control') };
    expect(estimateIsRemoteMeasured(estData, { oneTimeBreakdown: { items: [{ service: 'one_time_pest', name: 'One-Time Pest', amount: 199 }] } })).toBe(true);
    expect(estimateIsRemoteMeasured(estData, { oneTimeBreakdown: { items: [{ service: 'german_roach', name: 'German Roach Cleanout Service', amount: 450 }] } })).toBe(false);
  });

  test('an authored proposal\'s rows count, and an estimate with nothing to read fails closed', () => {
    const proposal = { enabled: true, programs: [{ name: 'Quarterly pest control', service: 'pest_control' }] };
    expect(estimateIsRemoteMeasured({ result: plan('pest_control'), proposal }, {})).toBe(false);
    expect(estimateIsRemoteMeasured({}, {})).toBe(false);
    expect(estimateIsRemoteMeasured(undefined, undefined)).toBe(false);
  });
});

describe('GET /:token/data: noVisitLine', () => {
  test('an open home estimate for a remotely measured service carries the owner\'s exact sentence', async () => {
    const { status, body } = await pageLoad(estimateRow());
    expect(status).toBe(200);
    expect(body.estimate.serviceCategory).toBe('pest_control');
    expect(body.cta.terminalState).toBeNull();
    expect(body.noVisitLine).toBe('We measure your home and yard from county records and satellite images, so most quotes need no visit.');
    expect(body.noVisitLine).toBe(NO_VISIT_QUOTE_LINE);
  });

  test('a bundle of remotely measured services carries it; a bundle with one on-site service does not', async () => {
    const remote = await pageLoad(estimateRow({ services: ['pest_control', 'mosquito'] }));
    expect(remote.body.estimate.serviceCategory).toBe('bundle');
    expect(remote.body.noVisitLine).toBe(NO_VISIT_QUOTE_LINE);

    const mixed = await pageLoad(estimateRow({ services: ['pest_control', 'rodent_bait'] }));
    expect(mixed.body.estimate.serviceCategory).toBe('bundle');
    expect(mixed.body.cta.terminalState).toBeNull();
    expect(mixed.body).not.toHaveProperty('noVisitLine');
  });

  test('a service only the second saved shape holds, and a one-time service off the list, carry none', async () => {
    const secondShape = await pageLoad(estimateRow({
      estimateData: { engineResult: { recurring: { services: [recurringRow('pest_control'), recurringRow('rodent_bait')] } } },
    }));
    expect(secondShape.status).toBe(200);
    expect(secondShape.body.cta.terminalState).toBeNull();
    expect(secondShape.body).not.toHaveProperty('noVisitLine');

    const roach = await pageLoad(estimateRow({ oneTime: [{ service: 'german_roach', name: 'German Roach Cleanout Service', amount: 450, price: 450 }] }));
    expect(roach.status).toBe(200);
    expect(roach.body.cta.terminalState).toBeNull();
    expect(roach.body).not.toHaveProperty('noVisitLine');

    // The general one-time pest service is on the list, so the same estimate with that row keeps the line.
    const oneTimePest = await pageLoad(estimateRow({ oneTime: [{ service: 'one_time_pest', name: 'One-Time Pest Control', amount: 199, price: 199 }] }));
    expect(oneTimePest.body.cta.terminalState).toBeNull();
    expect(oneTimePest.body.noVisitLine).toBe(NO_VISIT_QUOTE_LINE);
  });

  test('a service priced from what a technician measured on site carries none', async () => {
    const { status, body } = await pageLoad(estimateRow({ services: ['rodent_bait'] }));
    expect(status).toBe(200);
    expect(body.estimate.serviceCategory).toBe('rodent');
    expect(body.cta.terminalState).toBeNull();
    expect(body).not.toHaveProperty('noVisitLine');
  });

  test('the estimate email\'s home rule decides: a commercial estimate, a condo and a commercial mark carry none', async () => {
    const notHome = [
      estimateRow({ category: 'COMMERCIAL' }),
      estimateRow({ category: null }),
      estimateRow({ waveguard_tier: 'commercial' }),
      estimateRow({ estimateData: { property: { property_type: 'condo' } } }),
      estimateRow({ estimateData: { commercialEstimatedPricing: true } }),
    ];
    for (const estimate of notHome) {
      const { status, body } = await pageLoad(estimate);
      expect(status).toBe(200);
      expect(body.estimate).toBeDefined();
      expect(body).not.toHaveProperty('noVisitLine');
    }
  });

  test('an estimate that is not open carries none: accepted, declined, and one that needs a new quote', async () => {
    for (const status of ['accepted', 'declined']) {
      const closed = await pageLoad(estimateRow({ status }));
      expect(closed.status).toBe(200);
      expect(closed.body.cta.terminalState).toBe(status);
      expect(closed.body).not.toHaveProperty('noVisitLine');
    }
    // A lawn plan on a retired schedule: every service on it is remotely measured, but the page tells the customer to
    // call Waves for a new quote, so it does not also say that quotes need no visit.
    const requote = await pageLoad(estimateRow({ services: ['lawn_care'], service_interest: 'Lawn' }));
    expect(requote.status).toBe(200);
    expect(requote.body.estimate.serviceCategory).toBe('lawn_care');
    expect(requote.body.cta.terminalState).toBe('quote_required');
    expect(requote.body).not.toHaveProperty('noVisitLine');
  });

  test('the document render pass carries none: the line is the page\'s, not the emailed document\'s', async () => {
    const estimate = estimateRow();
    const page = await pageLoad(estimate);
    expect(page.body.noVisitLine).toBe(NO_VISIT_QUOTE_LINE);
    const pdf = await pageLoad(estimate, '?mode=pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.body.estimate).toBeDefined();
    expect(pdf.body).not.toHaveProperty('noVisitLine');
  });
});

describe('noVisitLinePageBlock: the page asks the estimate email\'s home rule', () => {
  const HOME = { id: 'est-1', category: 'RESIDENTIAL', estimate_data: { result: { recurring: { services: [{ service: 'pest_control' }] } } } };

  test('a home estimate gets { noVisitLine }; a commercial one, a condo and a proposal get no key', () => {
    expect(noVisitLinePageBlock(HOME)).toEqual({ noVisitLine: NO_VISIT_QUOTE_LINE });
    expect(noVisitLinePageBlock({ ...HOME, category: 'COMMERCIAL' })).toEqual({});
    expect(noVisitLinePageBlock({ ...HOME, estimate_data: { property: { property_type: 'condo' } } })).toEqual({});
    expect(noVisitLinePageBlock({ ...HOME, estimate_data: { proposal: { enabled: true } } })).toEqual({});
  });

  test('a row that cannot be read gets no key and no error', () => {
    const unreadable = { id: 'est-2', category: 'RESIDENTIAL' };
    Object.defineProperty(unreadable, 'estimate_data', { enumerable: true, get() { throw new Error('unreadable'); } });
    expect(noVisitLinePageBlock(unreadable)).toEqual({});
    expect(noVisitLinePageBlock(null)).toEqual({});
  });
});
