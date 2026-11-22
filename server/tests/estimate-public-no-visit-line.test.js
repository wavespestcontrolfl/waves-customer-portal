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
// The real engine, wrapped so one test can hand an inputs-only save the replay it needs.
jest.mock('../services/pricing-engine', () => {
  const actual = jest.requireActual('../services/pricing-engine');
  return { ...actual, generateEstimate: jest.fn(actual.generateEstimate) };
});

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
const { generateEstimate } = require('../services/pricing-engine');
const { PRICING_BASIS: UNIT_BAND_PRICING_BASIS, SIZE_BASIS: UNIT_BAND_SIZE_BASIS } = require('../services/pricing-engine/unit-band-pricing');

const SENT = '2026-11-20T16:00:00.000Z';
const recurringRow = (service) => ({ service, name: service, visitsPerYear: 6 });
// A sent home estimate. `services` are its recurring service keys; `oneTime` its one-time rows; `servedServices` are the
// recurring services of the price the customer is served (the send snapshot), the saved ones unless a test says otherwise.
// `servedPrice` adds fields to that served price.
// Each row gets its own id: the route keeps per-estimate memos, so two fixtures under one id would read each other's
// price state.
let rowSeq = 0;
function estimateRow({ services = ['pest_control'], servedServices = services, servedPrice = {}, oneTime = [], estimateData = {}, ...overrides } = {}) {
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
        frequencies: [{ key: 'quarterly', monthly: 42.3, annual: 507.6, perServiceTreatments: servedServices.map((service) => ({ label: service, service, displayPrice: 56.4, visitsPerYear: 6, monthly: 42.3, annual: 507.6 })) }],
        oneTimeBreakdown: { items: oneTime },
        ...servedPrice,
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

  test('the termite bait plan\'s own install charge is: it comes from the same measured perimeter', () => {
    const install = { service: 'termite_bait_installation', name: 'Termite bait installation', price: 650 };
    expect(serviceMixIsRemoteMeasured([recurringRow('termite_bait')], [install])).toBe(true);
    // The exact stored key only: an install row with a name and no key, and other termite work, are not on the list.
    expect(serviceMixIsRemoteMeasured([recurringRow('termite_bait')], [{ name: 'Termite bait installation', price: 650 }])).toBe(false);
    expect(serviceMixIsRemoteMeasured([recurringRow('termite_bait')], [{ service: 'termite_install', name: 'Termite install', price: 650 }])).toBe(false);
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

  test('a row counts by its stored service, compared whole: never by its name, never by a part of a key', () => {
    expect(serviceMixIsRemoteMeasured([{ service: ' Pest_Control ', name: 'Pest Control' }], [])).toBe(true);
    const noIdentity = [
      { name: 'Pest Control', visitsPerYear: 4 },
      { label: 'Lawn Care' },
      { key: 'pest_control', label: 'Pest Control' },
      { serviceKey: 'pest_control', name: 'Pest Control' },
      { service: null, name: 'Mosquito' },
      { service: '', key: 'pest_control', name: 'Pest Control' },
      { service: 'Pest Control' },
    ];
    for (const row of noIdentity) {
      const label = JSON.stringify(row);
      expect([label, serviceMixIsRemoteMeasured([row], [])]).toEqual([label, false]);
      expect([label, serviceMixIsRemoteMeasured([pest, row], [])]).toEqual([label, false]);
    }
    for (const key of ['lawn_care_plus', 'new_lawn_program', 'pest_control_commercial', 'mosquito_event', 'termite_bait_monitoring']) {
      expect([key, serviceMixIsRemoteMeasured([recurringRow(key)], [])]).toEqual([key, false]);
    }
    // A one-time row is read the same way: a key with no stored service is no identity.
    expect(serviceMixIsRemoteMeasured([pest], [{ key: 'one_time_pest', name: 'One-Time Pest Control', amount: 199 }])).toBe(false);
    // Each list is for its own kind of row: a plan key on a one-time row, or a one-time key on a plan row, is not on it.
    expect(serviceMixIsRemoteMeasured([], [{ service: 'pest_control', name: 'Pest Control', amount: 120 }])).toBe(false);
    expect(serviceMixIsRemoteMeasured([recurringRow('one_time_pest')], [])).toBe(false);
  });

  test('it fails closed on an estimate with no service row', () => {
    expect(serviceMixIsRemoteMeasured([], [])).toBe(false);
    expect(serviceMixIsRemoteMeasured(null, undefined)).toBe(false);
    expect(serviceMixIsRemoteMeasured([null, 'pest_control'], [null])).toBe(false);
  });

  test('the setup fee and discount rows are not services: they neither count nor block', () => {
    const notServices = [
      { service: 'waveguard_setup', name: 'WaveGuard Setup', amount: 99 },
      { service: 'one_time_adjustment', name: 'Discount', amount: -20 },
      { service: 'manual_discount', name: 'Manual discount', amount: -10 },
      { service: 'rodent_bundle_discount', name: 'Bundle discount', amount: -15 },
      { service: 'manual_discount', label: 'Neighbor discount', amount: -25, kind: 'discount' },
      {},
    ];
    expect(serviceMixIsRemoteMeasured([pest], notServices)).toBe(true);
    // Rows that are not services do not make an estimate with no service a measured one.
    expect(serviceMixIsRemoteMeasured([], notServices)).toBe(false);
    // A positive "other one-time services" remainder is real work nothing classified.
    expect(serviceMixIsRemoteMeasured([pest], [{ service: 'one_time_adjustment', name: 'Other one-time services', amount: 75 }])).toBe(false);
  });

  test('a row is a fee or a discount by its stored service, compared whole: never by its name, never by a part of a key', () => {
    // Setup work is work: a part of a key never makes a row a fee.
    for (const key of ['rodent_bait_setup', 'trap_only_setup', 'mosquito_misting_setup', 'waveguard_membership', 'service_credit']) {
      expect([key, serviceMixIsRemoteMeasured([pest, recurringRow(key)], [])]).toEqual([key, false]);
      expect([key, serviceMixIsRemoteMeasured([pest], [{ service: key, name: key, amount: 50 }])]).toEqual([key, false]);
    }
    // A fee name on a row with no stored service is a name.
    expect(serviceMixIsRemoteMeasured([pest], [{ name: 'WaveGuard Setup', amount: 99 }])).toBe(false);
    // A discount mark is not an identity: with another stored service, or with none.
    expect(serviceMixIsRemoteMeasured([pest], [{ service: 'german_roach', kind: 'discount', amount: -50 }])).toBe(false);
    expect(serviceMixIsRemoteMeasured([pest], [{ kind: 'discount', label: 'Neighbor discount', amount: -25 }])).toBe(false);
    expect(serviceMixIsRemoteMeasured([pest], [{ kind: 'discount', label: 'Rodent trapping', amount: 75 }])).toBe(false);
    // A row with a price and nothing else is a row nobody can identify.
    expect(serviceMixIsRemoteMeasured([pest], [{ amount: 120 }])).toBe(false);
    expect(serviceMixIsRemoteMeasured([pest, { mo: 40 }], [])).toBe(false);
    // A commercial row is never a measured home service, on either list.
    expect(serviceMixIsRemoteMeasured([{ ...pest, isCommercial: true }], [])).toBe(false);
    expect(serviceMixIsRemoteMeasured([pest], [{ service: 'one_time_pest', amount: 199, isCommercial: true }])).toBe(false);
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

  test('a one-time row of the served price can take the answer away', () => {
    const estData = { result: plan('pest_control') };
    expect(estimateIsRemoteMeasured(estData, { oneTimeBreakdown: { items: [{ service: 'one_time_pest', name: 'One-Time Pest', amount: 199 }] } })).toBe(true);
    expect(estimateIsRemoteMeasured(estData, { oneTimeBreakdown: { items: [{ service: 'german_roach', name: 'German Roach Cleanout Service', amount: 450 }] } })).toBe(false);
  });

  test('a saved plan row or raw engine line must store a listed service: a name is not an identity', () => {
    // A raw engine line reaches the page's rows with the key the page resolves from its name or from a part of its key.
    const line = (fields) => ({ monthly: 42, annual: 504, visitsPerYear: 4, ...fields });
    const lines = (...items) => ({ engineResult: { lineItems: items } });
    expect(estimateIsRemoteMeasured(lines(line({ service: 'pest_control', label: 'Pest Control' })), {})).toBe(true);
    expect(estimateIsRemoteMeasured(lines(line({ label: 'Pest Control' })), {})).toBe(false);
    expect(estimateIsRemoteMeasured(lines(line({ name: 'Quarterly lawn program' })), {})).toBe(false);
    expect(estimateIsRemoteMeasured(lines(line({ key: 'pest_control', label: 'Pest Control' })), {})).toBe(false);
    expect(estimateIsRemoteMeasured(lines(line({ service: 'lawn_aeration_plan', label: 'Aeration plan' })), {})).toBe(false);
    // One unidentified line beside a real plan row takes the answer away, in either saved shape.
    expect(estimateIsRemoteMeasured({ result: plan('pest_control'), engineResult: { lineItems: [line({ label: 'Lawn care' })] } }, {})).toBe(false);
    expect(estimateIsRemoteMeasured({ result: { ...plan('pest_control'), lineItems: [line({ label: 'Pest Control' })] } }, {})).toBe(false);
    // The same for a stored plan row, and for the nested results shape.
    expect(estimateIsRemoteMeasured({ result: { recurring: { services: [recurringRow('pest_control'), { name: 'Pest Control', mo: 40 }] } } }, {})).toBe(false);
    expect(estimateIsRemoteMeasured({ result: { ...plan('pest_control'), results: { recurring: { services: [{ name: 'Lawn Care', mo: 60 }] } } } }, {})).toBe(false);
    // A line that stores a listed one-time service is that service: its key holds a plan's name, and that is not a miss.
    const oneTimeLine = { service: 'one_time_pest', label: 'One-Time Pest Control', price: 199 };
    expect(estimateIsRemoteMeasured(
      { result: { ...plan('pest_control'), lineItems: [line({ service: 'pest_control' }), oneTimeLine] } },
      { oneTimeBreakdown: { items: [{ service: 'one_time_pest', label: 'One-Time Pest Control', amount: 199 }] } },
    )).toBe(true);
  });

  test('every saved row counts as it is stored, also one the page skips or drops', () => {
    const line = (fields) => ({ monthly: 42, annual: 504, visitsPerYear: 4, ...fields });
    const saved = (extra) => ({ result: { ...plan('pest_control'), ...extra } });
    expect(estimateIsRemoteMeasured(saved({}), {})).toBe(true);
    // A raw engine line with a recurring price and a key the page's readers do not know: they skip it.
    expect(estimateIsRemoteMeasured(saved({ lineItems: [line({ service: 'pest_control' }), line({ service: 'attic_dusting_plan', label: 'Attic dusting' })] }), {})).toBe(false);
    expect(estimateIsRemoteMeasured({ result: plan('pest_control'), engineResult: { lineItems: [line({ service: 'attic_dusting_plan' })] } }, {})).toBe(false);
    // Specialty work a plan includes at no charge: the page's one-time reader drops it.
    const included = { service: 'stinging_insect', name: 'Stinging Insect', price: 0, onProg: true };
    expect(estimateIsRemoteMeasured(saved({ specItems: [included] }), {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ oneTime: { items: [{ ...included, onProg: undefined, includedOnProgram: true }] } }), {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ results: { oneTime: { items: [{ service: 'german_roach', name: 'German Roach Cleanout Service', price: 0 }] } } }), {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ specItems: [{ name: 'Attic inspection' }] }), {})).toBe(false);
    // The same in every container a specialty row rides in.
    expect(estimateIsRemoteMeasured(saved({ oneTime: { specItems: [included] } }), {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ results: { oneTime: { specItems: [included] } } }), {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ quoteRequiredItems: [{ service: 'rodent_exclusion', name: 'Rodent Exclusion' }] }), {})).toBe(false);
    // A commercial row takes the answer away, also with a listed key.
    expect(estimateIsRemoteMeasured(saved({ oneTime: { items: [{ service: 'one_time_pest', name: 'One-Time Pest Control', price: 199, isCommercial: true }] } }), {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ lineItems: [{ service: 'pest_control', monthly: 40, isCommercial: true }] }), {})).toBe(false);
    // A listed one-time service, a fee, a discount and a blank row do not take the answer away.
    expect(estimateIsRemoteMeasured(saved({
      oneTime: { items: [{ service: 'one_time_pest', name: 'One-Time Pest Control', price: 199 }, { service: 'waveguard_setup', name: 'WaveGuard Setup', price: 99 }] },
      specItems: [{}],
      lineItems: [line({ service: 'pest_control' }), { service: 'manual_discount', label: 'Discount', price: -20 }, { service: 'one_time_pest', price: 199 }],
    }), {})).toBe(true);
  });

  test('a saved row with a key or a price and no stored service takes the answer away', () => {
    const saved = (extra) => ({ result: { ...plan('pest_control'), ...extra } });
    // The page resolves a plan from a raw line's key. A key is not a stored service.
    expect(estimateIsRemoteMeasured({ engineResult: { lineItems: [{ key: 'pest_control', monthly: 42 }] } }, {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ lineItems: [{ key: 'pest_control', monthly: 42 }] }), {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ lineItems: [{ key: 'rodent_bait', monthly: 35, annual: 420 }] }), {})).toBe(false);
    expect(estimateIsRemoteMeasured({ result: { recurring: { services: [recurringRow('pest_control'), { key: 'lawn_care', mo: 60 }] } } }, {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ oneTime: { items: [{ key: 'one_time_pest', price: 199 }] } }), {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ specItems: [{ price: 250 }] }), {})).toBe(false);
    // A fee name with no stored service is a name.
    expect(estimateIsRemoteMeasured(saved({ oneTime: { items: [{ name: 'WaveGuard Setup', price: 99 }] } }), {})).toBe(false);
    // The stored fee, a stored discount and an empty row stay out of the way.
    expect(estimateIsRemoteMeasured(saved({
      oneTime: { items: [{ service: 'waveguard_setup', name: 'WaveGuard Setup', price: 99 }, { service: 'manual_discount', label: 'Neighbor discount', price: -25 }] },
      lineItems: [{}, { service: '', name: '' }],
    }), {})).toBe(true);
  });

  test('stored pricing data nobody can read is no ground for the sentence', () => {
    const saved = (extra) => ({ result: { ...plan('pest_control'), ...extra } });
    const own = { result: plan('pest_control') };
    // An entry of a row list that is not a row: a bare key, a nested list, a number.
    const notRows = ['rodent_trapping', ['rodent_trapping'], 7, true];
    for (const entry of notRows) {
      const label = JSON.stringify(entry);
      expect([label, estimateIsRemoteMeasured(saved({ specItems: [entry] }), {})]).toEqual([label, false]);
      expect([label, estimateIsRemoteMeasured(saved({ lineItems: [{ service: 'pest_control', monthly: 42 }, entry] }), {})]).toEqual([label, false]);
      expect([label, estimateIsRemoteMeasured({ result: { recurring: { services: [recurringRow('pest_control'), entry] } } }, {})]).toEqual([label, false]);
      expect([label, estimateIsRemoteMeasured(own, { firstVisitFees: [entry] })]).toEqual([label, false]);
      expect([label, estimateIsRemoteMeasured(own, { oneTimeBreakdown: { items: [entry] } })]).toEqual([label, false]);
      expect([label, estimateIsRemoteMeasured(own, { services: [entry] })]).toEqual([label, false]);
      expect([label, estimateIsRemoteMeasured(own, { frequencies: [{ key: 'quarterly', perServiceTreatments: [entry] }] })]).toEqual([label, false]);
      expect([label, serviceMixIsRemoteMeasured([recurringRow('pest_control'), entry], [])]).toEqual([label, false]);
      expect([label, serviceMixIsRemoteMeasured([recurringRow('pest_control')], [entry])]).toEqual([label, false]);
    }
    // A row container that is there and is not a list.
    expect(estimateIsRemoteMeasured(saved({ lineItems: 'rodent_bait' }), {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ oneTime: { items: { 0: { service: 'one_time_pest', price: 199 } } } }), {})).toBe(false);
    expect(estimateIsRemoteMeasured(own, { firstVisitFees: { service: 'waveguard_setup' } })).toBe(false);
    expect(estimateIsRemoteMeasured(own, { frequencies: 'quarterly' })).toBe(false);
    expect(estimateIsRemoteMeasured(own, { frequencies: [{ key: 'quarterly', perServiceTreatments: 'rodent_bait' }] })).toBe(false);
    expect(estimateIsRemoteMeasured(own, { services: [{ key: 'pest_control', isRecurring: true, memberKeys: 'rodent_bait' }] })).toBe(false);
    // A fee field that is there and is not a row.
    expect(estimateIsRemoteMeasured(own, { setupFee: 'rodent_bait_setup' })).toBe(false);
    expect(estimateIsRemoteMeasured(own, { rodentBaitSetupFee: 199 })).toBe(false);
    // Absent is not unreadable: no container, an empty list, an absent entry, an absent fee.
    expect(estimateIsRemoteMeasured(saved({ specItems: [null], lineItems: [], oneTime: null, results: { oneTime: { items: [null] } } }), {
      firstVisitFees: [], setupFee: null, rodentBaitSetupFee: undefined, quoteRequiredItems: [null],
      services: [null, { key: 'pest_control', isRecurring: true, memberKeys: ['pest_control'], setupFee: null }], frequencies: [null],
    })).toBe(true);
    // The page's own plan reader cannot read an absent plan row. The rule then gives no answer, and does not throw.
    expect(estimateIsRemoteMeasured(saved({ lineItems: [null] }), {})).toBe(false);
    expect(estimateIsRemoteMeasured({ result: { recurring: { services: [recurringRow('pest_control'), null] } } }, {})).toBe(false);
  });

  test('a stored service at any depth of a saved result counts, also in a place no reader lists', () => {
    const saved = (extra) => ({ result: { ...plan('pest_control'), ...extra } });
    // A line nested in a line.
    expect(estimateIsRemoteMeasured(saved({ lineItems: [{ service: 'pest_control', monthly: 42, lineItems: [{ service: 'pest_control', monthly: 42 }] }] }), {})).toBe(true);
    expect(estimateIsRemoteMeasured(saved({ lineItems: [{ service: 'pest_control', monthly: 42, lineItems: [{ service: 'rodent_trapping', price: 400 }] }] }), {})).toBe(false);
    // The engine's notes about a service.
    expect(estimateIsRemoteMeasured(saved({ marginWarnings: [{ service: 'pest_control', message: 'Below floor' }] }), {})).toBe(true);
    expect(estimateIsRemoteMeasured(saved({ marginWarnings: [{ service: 'rodent_bait', message: 'Below floor' }] }), {})).toBe(false);
    // A container this rule does not name, in either saved shape.
    expect(estimateIsRemoteMeasured(saved({ addOnWork: { rows: [{ service: 'bed_bug', rooms: 2 }] } }), {})).toBe(false);
    expect(estimateIsRemoteMeasured({ result: plan('pest_control'), engineResult: { extras: [{ detail: { service: 'flea_package' } }] } }, {})).toBe(false);
    // A commercial mark at any depth.
    expect(estimateIsRemoteMeasured(saved({ addOnWork: { rows: [{ service: 'pest_control', isCommercial: true }] } }), {})).toBe(false);
    // A save with no result holds its rows itself: the same field counts there.
    expect(estimateIsRemoteMeasured({ ...plan('pest_control'), marginWarnings: [{ service: 'pest_control' }] }, {})).toBe(true);
    expect(estimateIsRemoteMeasured({ ...plan('pest_control'), marginWarnings: [{ service: 'rodent_bait' }] }, {})).toBe(false);
    expect(estimateIsRemoteMeasured({ result: { ...plan('pest_control'), marginWarnings: [{ service: 'rodent_bait' }] } }, {})).toBe(false);
    // Any other field of the saved estimate data, beside a saved result.
    expect(estimateIsRemoteMeasured({ result: plan('pest_control'), laterWork: [{ service: 'bed_bug' }] }, {})).toBe(false);
    // The frozen send snapshot is the price and scope as sent, not the saved estimate: the served price is read by its own rule.
    const sentWithRoach = { pricingBundle: { firstVisitFees: [{ service: 'pest_initial_roach' }] }, scope: { lines: [{ identity: { service: 'pest_initial_roach' } }] } };
    expect(estimateIsRemoteMeasured({ result: plan('pest_control'), sendSnapshot: sentWithRoach }, {})).toBe(true);
    expect(estimateIsRemoteMeasured({ ...plan('pest_control'), sendSnapshot: sentWithRoach }, {})).toBe(true);
    expect(estimateIsRemoteMeasured({ result: plan('pest_control'), sendSnapshot: sentWithRoach }, sentWithRoach.pricingBundle)).toBe(false);
  });

  test('a row the rule cannot read gives no answer and never throws', () => {
    const saved = (extra) => ({ result: { ...plan('pest_control'), ...extra } });
    // A stored service that is not text is an identity nobody can read.
    const notText = [{ toString: null }, { name: 'pest_control' }, ['pest_control'], 7, true];
    for (const service of notText) {
      const label = JSON.stringify(service);
      expect([label, estimateIsRemoteMeasured(saved({ extras: [{ detail: { service } }] }), {})]).toEqual([label, false]);
      expect([label, estimateIsRemoteMeasured({ result: plan('pest_control') }, { laterWork: [{ service }] })]).toEqual([label, false]);
      expect([label, serviceMixIsRemoteMeasured([{ ...recurringRow('pest_control'), service }], [])]).toEqual([label, false]);
    }
    // An adjustment row whose amount nobody can read is not a discount.
    const adjustment = (amount) => ({ oneTimeBreakdown: { items: [{ service: 'one_time_adjustment', name: 'Adjustment', amount }] } });
    for (const amount of [-20, 0, '-20', '0']) {
      expect([amount, estimateIsRemoteMeasured({ result: plan('pest_control') }, adjustment(amount))]).toEqual([amount, true]);
    }
    for (const amount of [75, '75', '', '  ', 'abc', NaN, Infinity, { toString: null }, [0], undefined, null]) {
      const label = String(JSON.stringify(amount));
      expect([label, estimateIsRemoteMeasured({ result: plan('pest_control') }, adjustment(amount))]).toEqual([label, false]);
    }
    // Every charge the row states counts: a blank amount does not hide a price.
    const adjustmentRow = (fields) => ({ oneTimeBreakdown: { items: [{ service: 'one_time_adjustment', name: 'Adjustment', ...fields }] } });
    expect(estimateIsRemoteMeasured({ result: plan('pest_control') }, adjustmentRow({ amount: '', price: 75 }))).toBe(false);
    expect(estimateIsRemoteMeasured({ result: plan('pest_control') }, adjustmentRow({ amount: -20, price: 75 }))).toBe(false);
    expect(estimateIsRemoteMeasured({ result: plan('pest_control') }, adjustmentRow({ amount: -20, price: -20 }))).toBe(true);
    expect(estimateIsRemoteMeasured({ result: plan('pest_control') }, adjustmentRow({ price: -5 }))).toBe(true);
    // A read that throws is caught: no answer, one warning.
    const logger = require('../services/logger');
    logger.warn.mockClear();
    const throwing = {};
    Object.defineProperty(throwing, 'service', { enumerable: true, get() { throw new Error('unreadable row'); } });
    expect(estimateIsRemoteMeasured(saved({ extras: [throwing] }), {})).toBe(false);
    expect(estimateIsRemoteMeasured({ result: plan('pest_control') }, { laterWork: [throwing] })).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0][0]).toContain('no-visit line rule could not read the estimate');
  });

  test('a dwelling unit priced from the bedroom count the caller gave is not measured, whatever its service key', () => {
    const band = { pricingBasis: UNIT_BAND_PRICING_BASIS, footprintSource: UNIT_BAND_SIZE_BASIS, footprintUsed: null };
    const saved = (extra) => ({ result: { ...plan('pest_control'), ...extra } });
    expect(UNIT_BAND_PRICING_BASIS).toBe('caller_stated_bedroom_count');
    // The mark on a stored plan row, a raw engine line and a one-time row.
    expect(estimateIsRemoteMeasured({ result: { recurring: { services: [{ ...recurringRow('pest_control'), ...band }] } } }, {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ lineItems: [{ service: 'pest_control', monthly: 40, ...band }] }), {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ oneTime: { items: [{ service: 'one_time_pest', price: 149, ...band }] } }), {})).toBe(false);
    // Each mark alone, also the unit-scope audit's size basis on a row that stores no service.
    expect(estimateIsRemoteMeasured(saved({ lineItems: [{ service: 'pest_control', monthly: 40, pricingBasis: UNIT_BAND_PRICING_BASIS }] }), {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ lineItems: [{ service: 'pest_control', monthly: 40, footprintSource: UNIT_BAND_SIZE_BASIS }] }), {})).toBe(false);
    expect(estimateIsRemoteMeasured(saved({ unitScope: { sizeBasis: UNIT_BAND_SIZE_BASIS } }), {})).toBe(false);
    expect(estimateIsRemoteMeasured({ result: plan('pest_control'), unitScopeAudit: { sizeBasis: UNIT_BAND_SIZE_BASIS } }, {})).toBe(false);
    // The served price carries the basis on its plan rows.
    const own = { result: plan('pest_control') };
    expect(estimateIsRemoteMeasured(own, { frequencies: [{ key: 'quarterly', perServiceTreatments: [{ service: 'pest_control', pricingBasis: UNIT_BAND_PRICING_BASIS }] }] })).toBe(false);
    expect(estimateIsRemoteMeasured(own, { oneTimeBreakdown: { items: [{ service: 'one_time_pest', amount: 149, pricingBasis: UNIT_BAND_PRICING_BASIS }] } })).toBe(false);
    // A row priced from the measured property keeps the answer, with its own basis or with none.
    for (const pricingBasis of ['TABLE_INTERPOLATION', 'PROGRAM_MINIMUM_MONTHLY', 'EXTRAPOLATED_ABOVE_TABLE_MAX', null, undefined]) {
      const label = String(pricingBasis);
      expect([label, estimateIsRemoteMeasured(saved({ lineItems: [{ service: 'pest_control', monthly: 40, pricingBasis, footprintSource: 'county' }] }), {
        frequencies: [{ key: 'quarterly', perServiceTreatments: [{ service: 'pest_control', pricingBasis }] }],
      })]).toEqual([label, true]);
    }
  });

  test('a saved amount is not a service row: the saved estimate must store one', () => {
    // The page's reader makes a termite bait install row from a saved amount. Alone, it grants nothing.
    expect(estimateIsRemoteMeasured({ result: { oneTime: { tmInstall: 1200 } } }, {})).toBe(false);
    expect(estimateIsRemoteMeasured({ result: { oneTime: { tmInstall: 1200, items: [] }, recurring: { services: [] } } }, {})).toBe(false);
    expect(estimateIsRemoteMeasured({ oneTime: { tmInstall: 1200 } }, {})).toBe(false);
    expect(estimateIsRemoteMeasured({ result: { membershipFee: 99 } }, {})).toBe(false);
    // Beside the stored plan row it belongs to, it is that plan's install charge.
    expect(estimateIsRemoteMeasured({ result: { ...plan('termite_bait'), oneTime: { tmInstall: 1200 } } }, {})).toBe(true);
    // A stored fee or discount row is not a service row either.
    expect(estimateIsRemoteMeasured({ result: { oneTime: { tmInstall: 1200, items: [{ service: 'waveguard_setup', price: 99 }] } } }, {})).toBe(false);
    // A stored one-time service row is one.
    expect(estimateIsRemoteMeasured({ result: { oneTime: { items: [{ service: 'one_time_pest', name: 'One-Time Pest Control', price: 199 }] } } }, {})).toBe(true);
  });

  test('an inputs-only save is read from its replayed engine result, raw rows included', () => {
    const inputsOnly = () => ({ engineInputs: { homeSqFt: 2000, lotSqFt: 8000, services: { pest: { frequency: 'quarterly' } } } });
    // The real engine: one pest control line.
    expect(estimateIsRemoteMeasured(inputsOnly(), {})).toBe(true);
    expect(estimateIsRemoteMeasured({ ...inputsOnly(), result: {} }, {})).toBe(true);
    // The engine adds a specialty line the plan includes at no charge: the page's one-time reader drops it.
    generateEstimate.mockImplementationOnce(() => ({
      lineItems: [
        { service: 'pest_control', name: 'Pest Control', monthly: 45, annual: 540, visitsPerYear: 4 },
        { service: 'stinging_insect', name: 'Stinging Insect', price: 0, includedOnProgram: true },
      ],
    }));
    expect(estimateIsRemoteMeasured(inputsOnly(), {})).toBe(false);
    // A replay that fails is no answer.
    generateEstimate.mockImplementationOnce(() => { throw new Error('engine down'); });
    expect(estimateIsRemoteMeasured(inputsOnly(), {})).toBe(false);
  });

  test('the served price never grants the answer by a one-time row either', () => {
    const servedOneTime = { oneTimeBreakdown: { items: [{ service: 'one_time_pest', name: 'One-Time Pest', amount: 199 }] } };
    expect(estimateIsRemoteMeasured({}, servedOneTime)).toBe(false);
    expect(estimateIsRemoteMeasured({ result: {} }, servedOneTime)).toBe(false);
    expect(estimateIsRemoteMeasured({ result: plan('pest_control') }, servedOneTime)).toBe(true);
  });

  test('a recurring service that only the price the customer is served lists takes the answer away', () => {
    const estData = { result: plan('pest_control', 'mosquito') };
    const cadence = (...keys) => ({ key: 'quarterly', perServiceTreatments: keys.map((service) => ({ service, label: service })) });
    const section = (key, extra = {}) => ({ key, isRecurring: true, memberKeys: [key], frequencies: [], ...extra });
    // Per-service rows of the price, any cadence.
    expect(estimateIsRemoteMeasured(estData, { frequencies: [cadence('pest_control', 'mosquito')] })).toBe(true);
    expect(estimateIsRemoteMeasured(estData, { frequencies: [cadence('pest_control', 'mosquito', 'rodent_bait')] })).toBe(false);
    expect(estimateIsRemoteMeasured(estData, { frequencies: [cadence('pest_control'), cadence('pest_control', 'rodent_bait')] })).toBe(false);
    // Cadence combinations the customer can pick.
    expect(estimateIsRemoteMeasured(estData, { frequencies: [cadence('pest_control', 'mosquito')], serviceCadenceCombos: [cadence('pest_control', 'mosquito')] })).toBe(true);
    expect(estimateIsRemoteMeasured(estData, { frequencies: [cadence('pest_control', 'mosquito')], serviceCadenceCombos: [cadence('pest_control', 'mosquito'), cadence('pest_control', 'rodent_bait')] })).toBe(false);
    // A per-service row with no stored service fails closed.
    expect(estimateIsRemoteMeasured(estData, { frequencies: [{ key: 'quarterly', perServiceTreatments: [{ label: 'Pest Control' }] }] })).toBe(false);
    // Sections: one per service, or one 'bundle' section that names its services in memberKeys.
    expect(estimateIsRemoteMeasured(estData, { services: [section('pest_control'), section('mosquito')] })).toBe(true);
    expect(estimateIsRemoteMeasured(estData, { services: [section('pest_control'), section('rodent_bait')] })).toBe(false);
    expect(estimateIsRemoteMeasured(estData, { services: [section('bundle', { memberKeys: ['pest_control', 'mosquito'] })] })).toBe(true);
    expect(estimateIsRemoteMeasured(estData, { services: [section('bundle', { memberKeys: ['pest_control', 'rodent_bait'] })] })).toBe(false);
    // A 'bundle' section that names no service, and a section with no key, fail closed.
    expect(estimateIsRemoteMeasured(estData, { services: [section('bundle', { memberKeys: [] })] })).toBe(false);
    expect(estimateIsRemoteMeasured(estData, { services: [{ label: 'Pest Control', isRecurring: true }] })).toBe(false);
    // A section's own cadence rows.
    expect(estimateIsRemoteMeasured(estData, { services: [section('pest_control', { frequencies: [cadence('pest_control', 'rodent_bait')] })] })).toBe(false);
    // A one-time section's key is a display category. Its rows are the one-time rows, which have their own list.
    expect(estimateIsRemoteMeasured(estData, { services: [section('pest_control'), { key: 'rodent', isRecurring: false, frequencies: [] }] })).toBe(true);
    expect(estimateIsRemoteMeasured(estData, {
      services: [section('pest_control'), { key: 'rodent', isRecurring: false, frequencies: [] }],
      oneTimeBreakdown: { items: [{ service: 'rodent_trapping', name: 'Rodent Trapping', amount: 400 }] },
    })).toBe(false);
  });

  test('a first-visit fee, a quote-required row or any stored service of the served price can take the answer away', () => {
    const estData = { result: plan('pest_control') };
    const setup = { service: 'waveguard_setup', amount: 99, label: 'WaveGuard setup', waivedWithPrepay: true };
    const roach = { service: 'pest_initial_roach', amount: 150, label: 'Cockroach Treatment Service', waivedWithPrepay: false };
    // The WaveGuard setup fee is a fee. A first-visit treatment is work.
    expect(estimateIsRemoteMeasured(estData, { firstVisitFees: [setup], setupFee: setup })).toBe(true);
    expect(estimateIsRemoteMeasured(estData, { firstVisitFees: [setup, roach], setupFee: setup })).toBe(false);
    expect(estimateIsRemoteMeasured(estData, { firstVisitFees: [{ label: 'Cockroach Treatment Service', amount: 150 }] })).toBe(false);
    expect(estimateIsRemoteMeasured(estData, { setupFee: roach })).toBe(false);
    expect(estimateIsRemoteMeasured(estData, { rodentBaitSetupFee: { service: 'rodent_bait_setup', amount: 199, label: 'Bait Station Setup' } })).toBe(false);
    expect(estimateIsRemoteMeasured(estData, { mistingInstallFee: { service: 'mosquito_misting_installation', amount: 2400 } })).toBe(false);
    // Quote-required rows, on the price and on its one-time breakdown.
    expect(estimateIsRemoteMeasured(estData, { quoteRequiredItems: [{ service: 'rodent_exclusion', name: 'Rodent Exclusion' }] })).toBe(false);
    expect(estimateIsRemoteMeasured(estData, { oneTimeBreakdown: { items: [], quoteRequiredItems: [{ name: 'Custom work' }] } })).toBe(false);
    // A section's own one-time rows and fee.
    const section = (extra) => ({ key: 'pest_control', isRecurring: true, memberKeys: ['pest_control'], ...extra });
    expect(estimateIsRemoteMeasured(estData, { services: [section({ setupFee: setup, oneTimeContribution: { items: [{ service: 'one_time_pest', amount: 199 }] } })] })).toBe(true);
    expect(estimateIsRemoteMeasured(estData, { services: [section({ oneTimeContribution: { items: [{ service: 'german_roach', amount: 450 }] } })] })).toBe(false);
    expect(estimateIsRemoteMeasured(estData, { services: [section({ setupFee: roach })] })).toBe(false);
    // A one-time section's rows, and a place this rule does not name.
    expect(estimateIsRemoteMeasured(estData, { services: [section({}), { key: 'pest_control', isRecurring: false, oneTimeContribution: { items: [{ service: 'flea_package', amount: 300 }] } }] })).toBe(false);
    expect(estimateIsRemoteMeasured(estData, { laterWork: { rows: [{ service: 'stinging_insect' }] } })).toBe(false);
    // A setup key in a plan row is work, not a fee.
    expect(estimateIsRemoteMeasured(estData, { frequencies: [{ key: 'quarterly', perServiceTreatments: [{ service: 'pest_control' }, { service: 'rodent_bait_setup' }] }] })).toBe(false);
    // Page copy rows hold display keys and no stored service.
    expect(estimateIsRemoteMeasured(estData, { frequencies: [{
      key: 'quarterly', perServiceTreatments: [{ service: 'pest_control' }],
      included: [{ key: 'pest_control', label: 'Pest Control' }], addOns: [{ key: 'interior_spray', label: 'Interior spray', preChecked: true }],
    }] })).toBe(true);
  });

  test('the served price never grants the answer: the saved estimate decides', () => {
    const served = { services: [{ key: 'pest_control', isRecurring: true, memberKeys: ['pest_control'] }], frequencies: [{ key: 'quarterly', perServiceTreatments: [{ service: 'pest_control' }] }] };
    expect(estimateIsRemoteMeasured({}, served)).toBe(false);
    expect(estimateIsRemoteMeasured({ result: plan('pest_control', 'rodent_bait') }, served)).toBe(false);
    expect(estimateIsRemoteMeasured({ result: plan('pest_control') }, served)).toBe(true);
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

  test('a service only the second saved shape or only the served price holds, and a one-time service off the list, carry none', async () => {
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

    // The saved result holds pest control and mosquito; the frozen price the customer is served also lists rodent bait.
    const servedRodent = await pageLoad(estimateRow({
      services: ['pest_control', 'mosquito'], servedServices: ['pest_control', 'mosquito', 'rodent_bait'],
    }));
    expect(servedRodent.status).toBe(200);
    expect(servedRodent.body.cta.terminalState).toBeNull();
    expect(servedRodent.body).not.toHaveProperty('noVisitLine');

    // The same frozen price with a first-visit cockroach treatment the saved rows do not hold; its setup fee alone is a fee.
    const frozen = { services: ['pest_control', 'mosquito'] };
    const setupFee = { service: 'waveguard_setup', amount: 99, label: 'WaveGuard setup', waivedWithPrepay: true };
    const servedSetupFee = await pageLoad(estimateRow({ ...frozen, servedPrice: { firstVisitFees: [setupFee], setupFee } }));
    expect(servedSetupFee.body.cta.terminalState).toBeNull();
    expect(servedSetupFee.body.noVisitLine).toBe(NO_VISIT_QUOTE_LINE);
    const servedRoachFee = await pageLoad(estimateRow({
      ...frozen,
      servedPrice: { firstVisitFees: [setupFee, { service: 'pest_initial_roach', amount: 150, label: 'Cockroach Treatment Service', waivedWithPrepay: false }], setupFee },
    }));
    expect(servedRoachFee.status).toBe(200);
    expect(servedRoachFee.body.cta.terminalState).toBeNull();
    expect(servedRoachFee.body).not.toHaveProperty('noVisitLine');

    // A dwelling unit priced from the bedroom count the caller gave stores the pest control key too.
    const bedroomBand = await pageLoad(estimateRow({
      estimateData: { result: { recurring: { services: [{ ...recurringRow('pest_control'), pricingBasis: UNIT_BAND_PRICING_BASIS, footprintSource: UNIT_BAND_SIZE_BASIS }] } } },
    }));
    expect(bedroomBand.status).toBe(200);
    expect(bedroomBand.body.cta.terminalState).toBeNull();
    expect(bedroomBand.body).not.toHaveProperty('noVisitLine');

    // A stored service nobody can read, in a field no reader lists: the page still loads, with no line.
    const unreadable = await pageLoad(estimateRow({ estimateData: { laterWork: [{ detail: { service: { toString: null } } }] } }));
    expect(unreadable.status).toBe(200);
    expect(unreadable.body.cta.terminalState).toBeNull();
    expect(unreadable.body).not.toHaveProperty('noVisitLine');

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
