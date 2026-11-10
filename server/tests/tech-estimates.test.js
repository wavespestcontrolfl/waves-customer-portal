/**
 * Technician estimate tool, steps 1 and 2a (GATE_TECH_ESTIMATES): setup, list-price preview, save a draft, read his
 * own. Synthetic people and addresses only. The property lookup and the estimate save are mocked (no paid call, no
 * database): these tests pin what the tool BUILDS for the save and what it ANSWERS from the result. The real save, real
 * engine and real schema are in tech-estimates-postgres.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

const mockCaller = { id: 'tech-1', role: 'technician' };
const mockState = {
  switchOn: true, queries: [], writes: [], visits: [], caps: [],
  // `customers` answers the bell's name lookup (lookupCustomerName) and nothing on the price path.
  customers: [],
  // step 2a: his tool rows, the transaction's writes, and the wheres the own-reads ran
  own: [], inserts: [], toolRow: null, conflict: false, wheres: [], trx: null,
  // step 4: the send's scripted transaction, the writes outside it, and the row the answer re-reads
  sendScript: null, updates: [], fresh: null,
};

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: mockCaller.id, role: mockCaller.role, name: 'Taylor Example' };
    req.technicianId = mockCaller.id;
    req.techRole = mockCaller.role;
    return next();
  },
}));
jest.mock('../models/db', () => {
  const dbFn = (table) => {
    mockState.queries.push(table);
    const filters = {};
    const builder = {
      _id: null,
      where(...args) {
        mockState.wheres.push([table, ...args]);
        if (args[0] && typeof args[0] === 'object') builder._where = args[0];
        if (args[0] && typeof args[0] === 'object' && args[0].id) builder._id = args[0].id;
        else if (args[0] === 'scheduled_services.id') builder._id = args[1];
        if (args[0] === 't.technician_id') filters.technician = args[1];
        if (args[0] === 'e.id' || args[0] === 't.estimate_id') filters.id = args[1];
        return builder;
      },
      select() { return builder; },
      join() { return builder; },
      leftJoin() { return builder; },
      whereNull() { return builder; },
      orderBy() { return builder; },
      limit() { return builder; },
      rows() { return mockState.own.filter((r) => (!filters.technician || r.technician_id === filters.technician) && (!filters.id || r.id === filters.id)); },
      async first() {
        if (table === 'technicians') return { can_create_estimates: mockState.switchOn };
        if (table === 'customers') return mockState.customers.find((c) => c.id === builder._id);
        if (table === 'tech_estimates as t') return builder.rows()[0];
        if (table === 'estimates') return mockState.fresh;
        // The visit read: the row for that id, and only inside the caller's scope (see the visit-scope mock below).
        if (table === 'scheduled_services') return mockState.visits.find((v) => v.id === builder._id && (!builder._tech || v.technician_id === builder._tech));
        return undefined;
      },
      then(resolve, reject) {
        const rows = table === 'customers' ? mockState.customers : table === 'tech_estimates as t' ? builder.rows() : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
      insert() { mockState.writes.push(table); return builder; },
      update(patch) { mockState.writes.push(table); mockState.updates.push({ table, where: builder._where, patch }); return builder; },
    };
    return builder;
  };
  dbFn.raw = (sql) => ({ raw: sql });
  // The create's one transaction: the fake trx records the tool row and answers the retry reads.
  dbFn.transaction = async (work) => {
    if (mockState.sendScript) return work(mockState.sendScript.trx);
    const trx = (table) => {
      const builder = {
        where() { return builder; },
        async first() { return table === 'tech_estimates' ? mockState.toolRow : undefined; },
        insert(row) { mockState.inserts.push({ table, row }); return builder; },
        onConflict() { return builder; },
        ignore() { return builder; },
        returning() { return Promise.resolve(mockState.conflict ? [] : [{ estimate_id: mockState.inserts[mockState.inserts.length - 1].row.estimate_id }]); },
      };
      return builder;
    };
    mockState.trx = trx;
    return work(trx);
  };
  return dbFn;
});
// The portal's own read scope for a technician, reduced to what it decides here: his assignment only (an admin is unscoped).
jest.mock('../services/technician-visit-scope', () => ({
  technicianCurrentVisitFilter: jest.fn((req, q) => { q._tech = req.techRole === 'admin' ? null : req.technicianId; return q; }),
}));
jest.mock('../services/technician-capabilities', () => ({
  ...jest.requireActual('../services/technician-capabilities'),
  listCapabilities: jest.fn(async () => mockState.caps),
}));

const express = require('express');
const lookupRoutes = require('../routes/property-lookup-v2');
const persistence = require('../services/admin-estimate-persistence');
const soldBy = require('../services/estimate-sold-by');
const auditLog = require('../services/audit-log');
const NotificationService = require('../services/notification-service');
const knownCaller = require('../utils/known-caller-phone');
const { technicianMayReach } = require('../middleware/technician-scope');
const { PEST_SERVICES, _private: { ENGINE_SERVICES } } = require('../services/tech-estimate-price');
const router = require('../routes/tech-estimates');

const sharedCap = require('../middleware/public-llm-shared-cap');
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
const VISIT_ID = '00000000-0000-4000-8000-0000000000a1';
const UNIT_VISIT_ID = '00000000-0000-4000-8000-0000000000a3';
const SECOND_HOME_VISIT_ID = '00000000-0000-4000-8000-0000000000a4';
const OTHER_TECH_VISIT_ID = '00000000-0000-4000-8000-0000000000a5';
// A visit row as the tool reads it: the customer's primary address, and a stamped service address when the visit is
// at another of the customer's properties.
const visitRow = (id, over = {}) => ({
  id, technician_id: 'tech-1', customer_id: CUSTOMER_ID,
  service_address_line1: null, service_address_line2: null, service_address_city: null, service_address_state: null, service_address_zip: null,
  customer_address_line1: '100 Sample St', customer_address_line2: null, customer_city: 'Sampletown', customer_state: 'FL', customer_zip: '34202',
  customer_first_name: 'Casey', customer_last_name: 'Sample', customer_phone: '(941) 555-0111', customer_email: 'casey.sample@example.invalid',
  ...over,
});
const PROSPECT = { firstName: 'Sample', lastName: 'Person', phone: '(941) 555-0142', address: '200 Example Ave', city: 'Sampletown', zip: '34202' };
const OFFICE_REFUSAL = { error: 'The office needs to price this one.', code: 'office_prices' };
const ALREADY_SAVED = { error: 'This estimate was already saved. Find it in My estimates.', code: 'already_saved' };
const SENTINEL = 'PHONE_SENTINEL';
const ESTIMATE_ID = '00000000-0000-4000-8000-0000000000e1';
const DRAFT_ID = '3f2b8c1e-5d4a-4b6f-8a21-0c9d7e6f5a43';
const DIGEST = 'a'.repeat(64);

// A county-matched single-family record (synthetic; the shape the lookup cache stores).
function countyRecord(over = {}) {
  return {
    propertyType: 'Single Family',
    squareFootage: 1850,
    yearBuilt: 1998,
    stories: 1,
    _source: 'county',
    _parcel: { county: 'Sarasota', parcelId: '0000000001', lotSqft: 9200, landUseDescription: 'SINGLE FAMILY DETACHED' },
    _fieldEvidence: { squareFootage: { sourceType: 'county' } },
    ...over,
  };
}
const lookupOf = (record = countyRecord(), enriched = { propertyType: 'single_family' }) => ({ propertyRecord: record, enriched });

// A canned dry-run result, the shape createOrReuseAdminEstimate returns (extra keys prove nothing leaks).
function prepared({ monthly = 37.33, annual = 448, oneTime = 99, authority = 'SERVER', lines, warning = null, result } = {}) {
  // Default: one clean engine line for each service the tool offers (judgePrepared wants a line per chosen service).
  const engineLines = lines || ['pest_control', 'one_time_pest', 'mosquito', 'one_time_mosquito', 'rodent_bait', 'termite_bait']
    .map((service) => ({ service, pricingConfidence: 'HIGH' }));
  return {
    dryRun: true,
    memberLinkageWarning: warning,
    estimate: {
      id: 'estimate-secret-id', token: 'secret-token', view_url: 'https://example.invalid/e/secret-token', status: 'draft',
      pricing_authority: authority, monthly_total: monthly, annual_total: annual, onetime_total: oneTime,
      client_preview_price: 1, server_computed_price: 2, pricing_drift: 3,
      estimate_data: JSON.stringify({
        engineResult: { lineItems: engineLines },
        result: result || {
          recurring: { services: [{ name: 'Pest Control', mo: monthly, annualAfterDiscount: annual }] },
          oneTime: { items: [], specItems: [], membershipFee: oneTime },
        },
        costs: { margin: 0.5 },
      }),
    },
  };
}

// What the real (not dry) save returns: the stored row (numeric columns as pg gives them) with its token, and the
// flags. Extra keys prove nothing leaks.
function saved({ reused = false, status = 'draft', warning = null, customerName = null } = {}) {
  const base = prepared({ monthly: 37.33, annual: 448, oneTime: 99 }).estimate;
  return {
    reused,
    memberLinkageWarning: warning,
    estimate: { ...base, id: ESTIMATE_ID, status, customer_id: CUSTOMER_ID, customer_name: customerName, monthly_total: '37.33', annual_total: '448.00', onetime_total: '99.00', estimate_data: JSON.parse(base.estimate_data) },
  };
}

let server; let baseUrl; let lookupSpy; let saveSpy; let capSpy; let creditSpy; let auditSpy; let phoneSpy; let bellSpy;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/tech/estimates', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  process.env.GATE_TECH_ESTIMATES = 'true';
  mockCaller.role = 'technician';
  Object.assign(mockState, {
    switchOn: true,
    queries: [],
    writes: [],
    own: [],
    inserts: [],
    toolRow: null,
    conflict: false,
    wheres: [],
    trx: null,
    sendScript: null,
    updates: [],
    fresh: null,
    caps: [
      { service_category: 'general', state: 'qualified' }, { service_category: 'mosquito', state: 'qualified' },
      { service_category: 'rodent', state: 'review_required' }, { service_category: 'termite', state: 'off' },
      { service_category: 'lawn', state: 'qualified' },
    ],
    customers: [
      { id: CUSTOMER_ID, first_name: 'Casey', last_name: 'Sample' },
    ],
    visits: [
      visitRow(VISIT_ID),
      visitRow(UNIT_VISIT_ID, { customer_address_line1: '300 Sample St', customer_address_line2: 'Apt 4' }),
      visitRow(SECOND_HOME_VISIT_ID, {
        service_address_line1: '900 Second Home Rd', service_address_city: 'Othertown', service_address_state: 'FL', service_address_zip: '34203',
      }),
      visitRow(OTHER_TECH_VISIT_ID, { technician_id: 'tech-2' }),
    ],
  });
  lookupSpy = jest.spyOn(lookupRoutes, 'performPropertyLookup').mockImplementation(async () => lookupOf());
  capSpy = jest.spyOn(sharedCap, 'consumeSharedDailyCap').mockResolvedValue({ allowed: true });
  saveSpy = jest.spyOn(persistence, 'createOrReuseAdminEstimate').mockImplementation(async (arg) => (arg.dryRun ? prepared() : saved()));
  creditSpy = jest.spyOn(soldBy, 'creditCreator').mockImplementation(async (_trx, estimate) => ({ ...estimate, sold_by_source: 'creator' }));
  auditSpy = jest.spyOn(auditLog, 'recordAuditEvent').mockResolvedValue(null);
  phoneSpy = jest.spyOn(knownCaller, 'findKnownCallerCustomer').mockResolvedValue(null);
  // The bell: the real compose rules run (they throw under test); only the write behind them is stubbed.
  bellSpy = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue({ id: 'bell-1' });
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.GATE_TECH_ESTIMATES;
});

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}/api/tech/estimates${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const price = (body) => call('POST', '/price', body);
const savedBody = () => saveSpy.mock.calls[0][0].body;
const savedInputs = () => savedBody().estimateData.engineInputs;
const reasons = (res) => res.body.officeFirst.reasons;

describe('the guard', () => {
  const GUARDED = [['GET', '/setup'], ['POST', '/price'], ['POST', ''], ['GET', ''], ['GET', `/${ESTIMATE_ID}`]];
  test.each(GUARDED)('gate off: %s %s answers 404 {enabled:false} before any read', async (method, path) => {
    delete process.env.GATE_TECH_ESTIMATES;
    const res = await call(method, path, method === 'POST' ? { visitId: VISIT_ID, services: ['PEST'] } : undefined);
    expect(res).toEqual({ status: 404, body: { enabled: false } });
    expect(mockState.queries).toEqual([]);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test.each(GUARDED)('technician switch off: %s %s answers 404 before any customer read', async (method, path) => {
    mockState.switchOn = false;
    const res = await call(method, path, method === 'POST' ? { visitId: VISIT_ID, services: ['PEST'] } : undefined);
    expect(res).toEqual({ status: 404, body: { enabled: false } });
    expect(mockState.queries).toEqual(['technicians']);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test('an admin passes without a switch', async () => {
    mockCaller.role = 'admin';
    mockState.switchOn = false;
    const res = await call('GET', '/setup');
    expect(res.status).toBe(200);
    expect(res.body.services.map((s) => s.key)).toEqual(['PEST', 'OT_PEST', 'MOSQUITO', 'OT_MOSQUITO', 'RODENT_BAIT', 'TERMITE_BAIT']);
    expect(mockState.queries).toEqual([]);
  });
});

describe('GET /setup', () => {
  test('a technician gets only the pest lines whose job type is Qualified for him', async () => {
    const res = await call('GET', '/setup');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      oneTimeHoldDollars: 1000,
      services: [
        { key: 'PEST', label: 'Recurring pest control', category: 'general' },
        { key: 'OT_PEST', label: 'One-time pest control', category: 'general' },
        { key: 'MOSQUITO', label: 'Mosquito program', category: 'mosquito' },
        { key: 'OT_MOSQUITO', label: 'One-time mosquito treatment', category: 'mosquito' },
      ],
    });
  });
});

describe('the engine service table', () => {
  const PROFILE = { homeSqFt: 1850, lotSqFt: 9200, stories: 1, propertyType: 'single_family' };
  // The office tool's own defaults for these six lines (EstimateToolViewV2 options).
  const OFFICE_DEFAULTS = {
    pestFreq: 4, mosquitoProgram: 'monthly12', termiteBaitSystem: 'trelona', termiteMonitoringTier: 'basic',
    termiteScope: 'bait_monitoring_no_warranty', termiteOwnership: 'own',
  };

  test.each(Object.keys(ENGINE_SERVICES))('%s equals what the translator emits with the office defaults', (key) => {
    const { translateV2CallToV1Input } = lookupRoutes;
    const { services } = translateV2CallToV1Input(PROFILE, [key], OFFICE_DEFAULTS);
    expect(JSON.parse(JSON.stringify(services))).toEqual(JSON.parse(JSON.stringify(ENGINE_SERVICES[key].services)));
  });

  test('covers exactly the offered services, and the table cannot be edited', () => {
    expect(Object.keys(ENGINE_SERVICES)).toEqual(PEST_SERVICES.map((s) => s.key));
    expect(Object.isFrozen(ENGINE_SERVICES.PEST.services.pest)).toBe(true);
  });
});

describe('POST /price: who, which services, and the county-confirmed home', () => {
  test('a visit that is not his is a 404, the same as an unknown id or a bad id, and nothing is looked up', async () => {
    for (const visitId of [OTHER_TECH_VISIT_ID, '00000000-0000-4000-8000-0000000000ff', 'not-an-id']) {
      const res = await price({ visitId, services: ['PEST'] });
      expect(res).toEqual({ status: 404, body: { error: 'Visit not found' } });
    }
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  test('a bare customer id is not a way in: a customer is quoted through a visit of his', async () => {
    expect((await price({ customerId: CUSTOMER_ID, services: ['PEST'] })).status).toBe(400);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test('a visit at the customer\'s second home prices THAT house: the stamped service address is looked up and saved', async () => {
    const res = await price({ visitId: SECOND_HOME_VISIT_ID, services: ['PEST'] });
    expect(res.status).toBe(200);
    expect(lookupSpy.mock.calls[0][0]).toBe('900 Second Home Rd, Othertown, FL 34203');
    expect(savedBody()).toEqual(expect.objectContaining({ customerId: CUSTOMER_ID, address: '900 Second Home Rd, Othertown, FL 34203' }));
    expect(savedBody().estimateData.inputs.address).toBe('900 Second Home Rd, Othertown, FL 34203');
  });

  test('an admin may quote any visit', async () => {
    mockCaller.role = 'admin';
    expect((await price({ visitId: OTHER_TECH_VISIT_ID, services: ['PEST'] })).status).toBe(200);
  });

  test('a service outside his Qualified categories is refused before the paid lookup', async () => {
    for (const key of ['RODENT_BAIT', 'TERMITE_BAIT', 'LAWN', 'TRENCHING']) {
      expect((await price({ visitId: VISIT_ID, services: ['PEST', key] })).status).toBe(400);
    }
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test('exactly one of a visit and a new person; a new person needs name, phone, address and ZIP', async () => {
    expect((await price({ services: ['PEST'] })).status).toBe(400);
    expect((await price({ visitId: VISIT_ID, prospect: PROSPECT, services: ['PEST'] })).status).toBe(400);
    expect((await price({ prospect: { ...PROSPECT, zip: '' }, services: ['PEST'] })).status).toBe(400);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test('a new person is looked up on the typed address through the declared caller', async () => {
    const res = await price({ prospect: PROSPECT, services: ['PEST'] });
    expect(res.status).toBe(200);
    expect(lookupSpy.mock.calls[0][0]).toBe('200 Example Ave, Sampletown, FL 34202');
    // The free cache read comes first; here it answers, so there is no second call.
    expect(lookupSpy.mock.calls[0][1]).toEqual({ cacheOnly: true, persist: false });
    expect(lookupSpy).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['the county does not confirm the home', () => lookupOf(countyRecord({ _fieldEvidence: { squareFootage: { sourceType: 'ai' } } }))],
    ['a condo', () => lookupOf(countyRecord({ propertyType: 'Condo' }))],
    ['no property record', () => lookupOf(null)],
    ['a commercial property', () => lookupOf(countyRecord(), { propertyType: 'commercial', isCommercial: true })],
    ['no profile at all', () => ({ propertyRecord: countyRecord() })],
  ])('%s: 422 office_prices, no number, nothing priced', async (_label, make) => {
    lookupSpy.mockImplementation(async () => make());
    const res = await price({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res).toEqual({ status: 422, body: OFFICE_REFUSAL });
    expect(saveSpy).not.toHaveBeenCalled();
  });

  test('a unit address: 422 office_prices before the save', async () => {
    const res = await price({ visitId: UNIT_VISIT_ID, services: ['PEST'] });
    expect(res).toEqual({ status: 422, body: OFFICE_REFUSAL });
    expect(saveSpy).not.toHaveBeenCalled();
    const typed = await price({ prospect: { ...PROSPECT, address: '200 Example Ave #5' }, services: ['PEST'] });
    expect(typed.body).toEqual(OFFICE_REFUSAL);
  });
});

// Every pricing knob a phone might forge: none may reach the save.
const FORGED_KEYS = {
  manualDiscount: { type: 'PERCENT', value: 50, note: SENTINEL },
  linePriceOverrides: { PEST: SENTINEL },
  serviceSpecificDiscounts: [{ key: SENTINEL }],
  operatorPriceAdjustment: { type: 'FIXED', value: 100, waiveSetupFee: true, note: SENTINEL },
  moveId: SENTINEL,
  profile: { homeSqFt: 100, note: SENTINEL },
  options: { manualDiscount: SENTINEL, recurringCustomer: true, pestFreq: 12 },
  estimateData: { engineInputs: { note: SENTINEL }, inputs: { svcLawn: true, note: SENTINEL } },
  engineInputs: { note: SENTINEL },
  customerEmail: `${SENTINEL}@example.invalid`,
  leadId: SENTINEL,
  clientDraftId: SENTINEL,
  groupWithEstimateId: SENTINEL,
  customerName: SENTINEL,
  customerPhone: SENTINEL,
  waveguardTier: SENTINEL,
  monthlyTotal: 1,
};

describe('POST /price: the paid lookup budget', () => {
  // A cache miss, then the live answer.
  const missThenLive = () => lookupSpy.mockImplementation(async (_address, options) => (options.cacheOnly ? null : lookupOf()));

  test('an address in the cache is free: no budget is spent and no live lookup runs', async () => {
    expect((await price({ visitId: VISIT_ID, services: ['PEST'] })).status).toBe(200);
    expect(capSpy).not.toHaveBeenCalled();
    expect(lookupSpy).toHaveBeenCalledTimes(1);
  });

  test('a cache miss spends ONE unit of this technician\'s own daily budget, then looks the address up live', async () => {
    missThenLive();
    expect((await price({ visitId: VISIT_ID, services: ['PEST'] })).status).toBe(200);
    expect(capSpy).toHaveBeenCalledTimes(1);
    expect(capSpy).toHaveBeenCalledWith({ bucket: 'tech-estimate-lookup:tech-1', defaultMax: 30, failClosed: true });
    expect(lookupSpy.mock.calls.map((call) => call[1])).toEqual([{ cacheOnly: true, persist: false }, { prioritizeAccuracy: true }]);
  });

  test('over the budget: 429 daily_limit, no live lookup, nothing priced', async () => {
    missThenLive();
    capSpy.mockResolvedValueOnce({ allowed: false });
    const res = await price({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('daily_limit');
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  test('a refused request never spends budget: a visit that is not his, a service he may not quote', async () => {
    missThenLive();
    await price({ visitId: OTHER_TECH_VISIT_ID, services: ['PEST'] });
    await price({ visitId: VISIT_ID, services: ['TERMITE_BAIT'] });
    expect(capSpy).not.toHaveBeenCalled();
  });
});

describe('POST /price: the body the tool builds for the save', () => {
  const FORGED = FORGED_KEYS;

  test('a route customer: exactly the expected keys, nothing from the phone, dry run on live pricing', async () => {
    const res = await price({ visitId: VISIT_ID, services: ['PEST', 'MOSQUITO'], ...FORGED });
    expect(res.status).toBe(200);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const arg = saveSpy.mock.calls[0][0];
    expect(Object.keys(arg).sort()).toEqual(['body', 'database', 'dryRun', 'requireLivePricing', 'technician', 'technicianId']);
    expect(arg.dryRun).toBe(true);
    expect(arg.requireLivePricing).toBe(true);
    expect(arg.technicianId).toBe('tech-1');
    expect(Object.keys(arg.body).sort()).toEqual(['address', 'billByInvoice', 'customerEmail', 'customerId', 'customerName', 'customerPhone', 'estimateData', 'showOneTimeOption']);
    expect(arg.body).toEqual(expect.objectContaining({ customerId: CUSTOMER_ID, address: '100 Sample St, Sampletown, FL 34202', showOneTimeOption: false, billByInvoice: false }));
    // The contact on the estimate is the visit's customer, read on the server: never what the phone sent.
    expect(arg.body).toEqual(expect.objectContaining({ customerName: 'Casey Sample', customerPhone: '(941) 555-0111', customerEmail: 'casey.sample@example.invalid' }));
    expect(Object.keys(arg.body.estimateData).sort()).toEqual(['engineInputs', 'inputs']);
    expect(Object.keys(arg.body.estimateData.inputs).sort()).toEqual([
      'address', 'customerId', 'homeSqFt', 'lotSqFt', 'pestFreq', 'propertyType', 'stories', 'svcMosquito', 'svcPest',
    ]);
    expect(arg.body.estimateData.inputs).toEqual(expect.objectContaining({ homeSqFt: '1850', lotSqFt: '9200', stories: '1', svcPest: true, svcMosquito: true, pestFreq: '4' }));
    expect(JSON.stringify(arg.body)).not.toMatch(new RegExp(`${SENTINEL}|manualDiscount|linePriceOverrides|serviceSpecific|operatorPriceAdjustment|moveId|waiveSetupFee|clientDraftId|leadId`, 'i'));
    expect(savedInputs().services).toEqual({ pest: { frequency: 'quarterly', roachType: 'none' }, mosquito: { tier: 'monthly12' } });
    expect(savedInputs()).toEqual(expect.objectContaining({ homeSqFt: 1850, lotSqFt: 9200, isCommercial: false, category: 'RESIDENTIAL' }));
    expect(res.body.officeFirst).toEqual({ required: false, reasons: [] });
  });

  test('a customer with no usable contact: a number the save would refuse, or a blank name or email, is left off', async () => {
    mockState.visits[0] = visitRow(VISIT_ID, { customer_first_name: ' ', customer_last_name: null, customer_phone: '(141) 555-0111', customer_email: '' });
    expect((await price({ visitId: VISIT_ID, services: ['PEST'] })).status).toBe(200);
    expect(Object.keys(savedBody()).sort()).toEqual(['address', 'billByInvoice', 'customerId', 'estimateData', 'showOneTimeOption']);
  });

  test('a new person: name and phone from the typed person only', async () => {
    await price({ prospect: PROSPECT, services: ['PEST'], ...FORGED });
    expect(Object.keys(savedBody()).sort()).toEqual(['address', 'billByInvoice', 'customerName', 'customerPhone', 'estimateData', 'showOneTimeOption']);
    expect(savedBody()).toEqual(expect.objectContaining({ customerName: 'Sample Person', customerPhone: '+19415550142' }));
    expect(Object.keys(savedBody().estimateData.inputs)).not.toContain('customerId');
    expect(JSON.stringify(savedBody())).not.toContain(SENTINEL);
  });
});

describe('POST /price: measured facts', () => {
  test('a fact equal to the county figure is not a change; unknown fact keys are ignored', async () => {
    const res = await price({ visitId: VISIT_ID, services: ['PEST'], facts: { homeSqFt: 1850, color: 'red', discount: 5 } });
    expect(res.body.officeFirst).toEqual({ required: false, reasons: [] });
    expect(res.body.facts).toEqual({
      homeSqFt: { value: 1850, source: 'lookup' }, lotSqFt: { value: 9200, source: 'lookup' }, stories: { value: 1, source: 'lookup' },
    });
    expect(Object.keys(savedBody().estimateData.inputs)).not.toContain('_homeSqFtEdited');
  });

  test('a changed fact is priced on the typed value, marked as typed by a person, and sent to the office first', async () => {
    const res = await price({ visitId: VISIT_ID, services: ['PEST'], facts: { homeSqFt: 2600, lotSqFt: 12000, stories: 2 } });
    expect(reasons(res)).toEqual(['changed_fact:homeSqFt', 'changed_fact:lotSqFt', 'changed_fact:stories']);
    expect(res.body.officeFirst.required).toBe(true);
    expect(res.body.facts.homeSqFt).toEqual({ value: 2600, source: 'technician' });
    expect(savedInputs()).toEqual(expect.objectContaining({ homeSqFt: 2600, lotSqFt: 12000, stories: 2, storiesSource: 'lookup' }));
    expect(savedBody().estimateData.inputs).toEqual(expect.objectContaining({
      homeSqFt: '2600', lotSqFt: '12000', stories: '2', _homeSqFtEdited: true, _lotSqFtEdited: true, _storiesEdited: true,
    }));
  });

  test('a stories count a person typed replaces the AI estimate and its evidence', async () => {
    const guess = countyRecord({ stories: 2, _storiesEvidence: { basis: 'inferred', confidence: 'low', sourceUrl: 'x', sourceType: 'listing' } });
    lookupSpy.mockImplementation(async () => lookupOf(guess));
    await price({ visitId: VISIT_ID, services: ['PEST'] });
    expect(savedInputs().storiesSource).toBe('estimated');
    await price({ visitId: VISIT_ID, services: ['PEST'], facts: { stories: 1 } });
    expect(saveSpy.mock.calls[1][0].body.estimateData.engineInputs).toEqual(expect.objectContaining({ stories: 1, storiesSource: 'lookup' }));
  });

  test('a termite perimeter rides services.termite.measurements, only with the termite line', async () => {
    mockState.caps = ['general', 'termite'].map((c) => ({ service_category: c, state: 'qualified' }));
    const res = await price({ visitId: VISIT_ID, services: ['TERMITE_BAIT'], facts: { perimeterLF: 220 } });
    expect(savedInputs().services.termite).toEqual(expect.objectContaining({ measurements: { perimeterLF: 220 } }));
    expect(reasons(res)).toEqual(['changed_fact:perimeterLF']);
    expect(res.body.facts.perimeterLF).toEqual({ value: 220, source: 'technician' });
    expect(savedBody().estimateData.inputs.termitePerimeterLF).toBe('220');
    saveSpy.mockClear();
    const without = await price({ visitId: VISIT_ID, services: ['PEST'], facts: { perimeterLF: 220 } });
    expect(reasons(without)).toEqual([]);
    expect(savedInputs().services.termite).toBeUndefined();
  });

  test('a fact outside sane bounds is a 400', async () => {
    for (const facts of [{ homeSqFt: -5 }, { homeSqFt: 'big' }, { stories: 9 }, { lotSqFt: 12.5 }, { perimeterLF: 5 }]) {
      expect((await price({ visitId: VISIT_ID, services: ['PEST'], facts })).status).toBe(400);
    }
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

describe('POST /price: the answer and the office-first reasons', () => {
  test('one-time over $1,000 holds; exactly $1,000 does not', async () => {
    saveSpy.mockResolvedValueOnce(prepared({ oneTime: 1000.01 }));
    expect(reasons(await price({ visitId: VISIT_ID, services: ['PEST'] }))).toEqual(['one_time_over_limit']);
    saveSpy.mockResolvedValueOnce(prepared({ oneTime: 1000 }));
    expect(reasons(await price({ visitId: VISIT_ID, services: ['PEST'] }))).toEqual([]);
  });

  test.each([
    ['a line that needs manual review', { service: 'pest_control', requiresManualReview: true }],
    ['a low-confidence line', { service: 'pest_control', pricingConfidence: 'LOW' }],
    ['a heuristic-turf line', { service: 'pest_control', turfBasis: 'lotFallback' }],
  ])('%s is office_review', async (_label, line) => {
    saveSpy.mockResolvedValueOnce(prepared({ lines: [line] }));
    expect(reasons(await price({ visitId: VISIT_ID, services: ['PEST'] }))).toEqual(['office_review']);
  });

  test('an address that belongs to an unlinked member is office_review and says nothing else', async () => {
    saveSpy.mockResolvedValueOnce(prepared({ warning: { customerId: 'member-id-secret', customerName: 'Another Member', waveguardTier: 'Gold', message: 'secret message' } }));
    const res = await price({ prospect: PROSPECT, services: ['PEST'] });
    expect(res.body.officeFirst).toEqual({ required: true, reasons: ['office_review'] });
    expect(JSON.stringify(res.body)).not.toMatch(/member|secret|Gold|Another/);
  });

  test('reason codes come in a fixed order and are the only ones the phone sees', async () => {
    saveSpy.mockResolvedValueOnce(prepared({ oneTime: 2000, lines: [{ service: 'pest_control', requiresManualReview: true }], warning: { message: 'x' } }));
    const res = await price({ prospect: PROSPECT, services: ['PEST'], facts: { homeSqFt: 2200 } });
    expect(reasons(res)).toEqual(['changed_fact:homeSqFt', 'one_time_over_limit', 'office_review']);
  });

  test('the totals are the prepared estimate\'s own columns, with a digest of the engine result; nothing from the row leaks; nothing is written', async () => {
    const res = await price({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res.body).toEqual({
      lines: [{ label: 'Pest Control', monthly: 37.33, annual: 448 }, { label: 'WaveGuard setup fee', oneTime: 99 }],
      monthlyTotal: 37.33, annualTotal: 448, oneTimeTotal: 99,
      facts: expect.any(Object), officeFirst: { required: false, reasons: [] },
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(JSON.stringify(res.body)).not.toMatch(/token|viewurl|view_url|estimate_?id|estimate-secret|estimate_data|margin|cost|drift|client_preview/i);
    expect(mockState.writes).toEqual([]);
  });
});

describe('POST /price: refusals', () => {
  test.each([
    ['the price is not the server\'s', () => prepared({ authority: 'CLIENT_FALLBACK' })],
    ['there is no engine line', () => prepared({ lines: [] })],
    ['the engine could not price a line (quote required)', () => prepared({ lines: [{ service: 'pest_control', quoteRequired: true }] })],
    ['a line needs a quote', () => prepared({ lines: [{ service: 'pest_control', requiresQuote: true }] })],
  ])('%s: 422 office_prices', async (_label, make) => {
    saveSpy.mockResolvedValueOnce(make());
    expect(await price({ visitId: VISIT_ID, services: ['PEST'] })).toEqual({ status: 422, body: OFFICE_REFUSAL });
  });

  test('never a partial quote: a chosen service with no engine line of its own is office_prices', async () => {
    // Two services chosen, the engine answered with the pest line only.
    saveSpy.mockResolvedValueOnce(prepared({ lines: [{ service: 'pest_control', pricingConfidence: 'HIGH' }] }));
    expect(await price({ visitId: VISIT_ID, services: ['PEST', 'MOSQUITO'] })).toEqual({ status: 422, body: OFFICE_REFUSAL });
    saveSpy.mockResolvedValueOnce(prepared({ lines: [{ service: 'pest_control' }, { service: 'mosquito' }] }));
    expect((await price({ visitId: VISIT_ID, services: ['PEST', 'MOSQUITO'] })).status).toBe(200);
  });

  test('a 4xx from the save is office_prices and its own message is never echoed', async () => {
    saveSpy.mockRejectedValueOnce(Object.assign(new Error('Customer 123 has an open move'), { statusCode: 409 }));
    const res = await price({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res).toEqual({ status: 422, body: OFFICE_REFUSAL });
  });

  test('a bad typed phone is the technician\'s own typo: 400 with its message', async () => {
    saveSpy.mockRejectedValueOnce(Object.assign(new Error('That phone number cannot receive texts. Correct the phone before saving.'), { statusCode: 400, code: 'INVALID_PHONE' }));
    const res = await price({ prospect: PROSPECT, services: ['PEST'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone/);
  });

  test('a server error from the save stays a server error', async () => {
    saveSpy.mockRejectedValueOnce(Object.assign(new Error('Live pricing configuration is unavailable.'), { statusCode: 503 }));
    const res = await price({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.code).toBeUndefined();
  });

  test('a failed lookup answers 502 without a price', async () => {
    lookupSpy.mockRejectedValueOnce(new Error('provider down'));
    const res = await price({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res.status).toBe(502);
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step 2a: save the draft

const create = (body) => call('POST', '', { ...body, clientDraftId: DRAFT_ID, digest: DIGEST });
// The fingerprint the save stores for a request sent through `create`.
const fingerprintOf = (body) => require('../services/tech-estimate-save')._private.requestFingerprint(body, DIGEST);
const realSaves = () => saveSpy.mock.calls.filter(([arg]) => !arg.dryRun);
const realSave = () => realSaves()[0][0];
const nothingWritten = () => {
  expect(mockState.inserts).toEqual([]);
  expect(creditSpy).not.toHaveBeenCalled();
  expect(auditSpy).not.toHaveBeenCalled();
};

describe('POST /api/tech/estimates: what the create hands the shared save', () => {
  test('the same save as the preview, not a dry run, on live pricing, tied to the phone\'s digest, inside our transaction', async () => {
    const res = await create({ visitId: VISIT_ID, services: ['PEST', 'MOSQUITO'], ...FORGED_KEYS });
    expect(res.status).toBe(200);
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(saveSpy.mock.calls[0][0].dryRun).toBe(true);
    const arg = realSave();
    expect(Object.keys(arg).sort()).toEqual(['body', 'database', 'expectedEngineResultDigest', 'requireLivePricing', 'technician', 'technicianId']);
    expect(arg.requireLivePricing).toBe(true);
    expect(arg.expectedEngineResultDigest).toBe(DIGEST);
    expect(arg.technicianId).toBe('tech-1');
    expect(arg.database).toBe(mockState.trx);
    // The preview's body plus the retry key, and nothing else: no forged key reaches the save.
    expect(Object.keys(arg.body).sort()).toEqual(['address', 'billByInvoice', 'clientDraftId', 'customerEmail', 'customerId', 'customerName', 'customerPhone', 'estimateData', 'showOneTimeOption']);
    expect(arg.body.clientDraftId).toBe(DRAFT_ID);
    expect({ ...arg.body, clientDraftId: undefined }).toEqual({ ...saveSpy.mock.calls[0][0].body, clientDraftId: undefined });
    expect(JSON.stringify(arg.body)).not.toMatch(new RegExp(`${SENTINEL}|manualDiscount|linePriceOverrides|serviceSpecific|operatorPriceAdjustment|moveId|waiveSetupFee|leadId|groupWithEstimateId`, 'i'));
    expect(Object.keys(arg.body.estimateData).sort()).toEqual(['engineInputs', 'inputs']);
  });

  test('a new person: name and phone from the typed person only', async () => {
    await create({ prospect: PROSPECT, services: ['PEST'], ...FORGED_KEYS });
    expect(Object.keys(realSave().body).sort()).toEqual(['address', 'billByInvoice', 'clientDraftId', 'customerName', 'customerPhone', 'estimateData', 'showOneTimeOption']);
    expect(realSave().body).toEqual(expect.objectContaining({ customerName: 'Sample Person', customerPhone: '+19415550142' }));
    expect(JSON.stringify(realSave().body)).not.toContain(SENTINEL);
  });

  test.each([
    ['no draft id', { clientDraftId: undefined }],
    ['a draft id that is not a UUID', { clientDraftId: 'not-a-uuid' }],
    ['a UUID that is not version 4', { clientDraftId: '3f2b8c1e-5d4a-1b6f-8a21-0c9d7e6f5a43' }],
    ['a draft id that is a number', { clientDraftId: 5 }],
    ['no digest', { digest: undefined }],
    ['a short digest', { digest: 'abc123' }],
    ['a digest with a non-hex letter', { digest: `${'a'.repeat(63)}z` }],
    ['a digest that is a list', { digest: [DIGEST] }],
  ])('%s: 400 before any lookup or save', async (_label, over) => {
    const res = await call('POST', '', { visitId: VISIT_ID, services: ['PEST'], clientDraftId: DRAFT_ID, digest: DIGEST, ...over });
    expect(res.status).toBe(400);
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    nothingWritten();
  });

  test('a bare customer id is a 400 and nothing is saved: a customer is saved through a visit of his', async () => {
    const res = await create({ customerId: CUSTOMER_ID, services: ['PEST'] });
    expect(res.status).toBe(400);
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    nothingWritten();
  });

  test('the same guards as the preview run first: a visit that is not his 404, unit address 422, no draft written', async () => {
    expect((await create({ visitId: OTHER_TECH_VISIT_ID, services: ['PEST'] })).status).toBe(404);
    expect(await create({ visitId: UNIT_VISIT_ID, services: ['PEST'] })).toEqual({ status: 422, body: OFFICE_REFUSAL });
    saveSpy.mockImplementationOnce(async () => prepared({ lines: [] }));
    expect(await create({ visitId: VISIT_ID, services: ['PEST'] })).toEqual({ status: 422, body: OFFICE_REFUSAL });
    expect(realSaves()).toEqual([]);
    nothingWritten();
  });
});

describe('POST /api/tech/estimates: refusals from the save', () => {
  const realSaveRejects = (error) => saveSpy.mockImplementation(async (arg) => { if (arg.dryRun) return prepared(); throw error; });

  test('a changed price is 409 price_changed, and nothing is credited, audited or stored', async () => {
    realSaveRejects(Object.assign(new Error('The estimate price or options changed. Review a fresh estimate before saving.'), { statusCode: 409 }));
    expect(await create({ visitId: VISIT_ID, services: ['PEST'] })).toEqual({
      status: 409, body: { error: 'The price changed. Price it again.', code: 'price_changed' },
    });
    nothingWritten();
  });

  test('any other 4xx from the save is office_prices and its message is never echoed (same id from another login included)', async () => {
    realSaveRejects(Object.assign(new Error('This draft was already saved with different inputs. Customer 123.'), { statusCode: 409 }));
    const res = await create({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res).toEqual({ status: 422, body: OFFICE_REFUSAL });
    expect(JSON.stringify(res.body)).not.toMatch(/draft|123/);
    nothingWritten();
  });

  test('a bad typed phone is the technician\'s typo: 400 with its message', async () => {
    realSaveRejects(Object.assign(new Error('That phone number cannot receive texts. Correct the phone before saving.'), { statusCode: 400, code: 'INVALID_PHONE' }));
    const res = await create({ prospect: PROSPECT, services: ['PEST'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phone/);
  });

  test('a server error stays a server error', async () => {
    realSaveRejects(Object.assign(new Error('Live pricing configuration is unavailable.'), { statusCode: 503 }));
    const res = await create({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.code).toBeUndefined();
    nothingWritten();
  });

  // The portal's REAL error handler (middleware/errors.js) logs the message and the stack of whatever a route forwards,
  // and a database error's message holds the SQL of the save with its values. The tool forwards a copy without them.
  test('a database error reaches the portal\'s error handler with its code, the technician id and the stack frames, and no value of the save', async () => {
    const logger = require('../services/logger');
    const app = express();
    app.use(express.json());
    app.use('/api/tech/estimates', router);
    app.use(require('../middleware/errors').errorHandler);
    const real = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    try {
      const dbError = Object.assign(
        new Error('insert into "estimates" ("customer_name", "customer_phone", "address") values (\'Sample Person\', \'+19415550142\', \'200 Example Ave\') - duplicate key'),
        { code: '23505' },
      );
      realSaveRejects(dbError);
      logger.error.mockClear();
      const res = await fetch(`http://127.0.0.1:${real.address().port}/api/tech/estimates`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospect: PROSPECT, services: ['PEST'], clientDraftId: DRAFT_ID, digest: DIGEST }),
      });
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).not.toMatch(/Sample|5550142|Example Ave|insert into/);
      expect(logger.error).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(logger.error.mock.calls[0]);
      expect(logged).toContain('[tech-estimates] create failed for technician tech-1 (23505)');
      expect(logged).toMatch(/\\n\s+at /);
      expect(logged).not.toMatch(/Sample|5550142|Example Ave|insert into|duplicate key/);
    } finally {
      await new Promise((r) => real.close(r));
    }
  });

  test('an error with no code is named by its class', async () => {
    const logger = require('../services/logger');
    realSaveRejects(new TypeError('Cannot read properties of undefined (reading \'Sample Person\')'));
    const res = await create({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('[tech-estimates] create failed for technician tech-1 (TypeError)');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('Sample Person');
  });
});

describe('POST /api/tech/estimates: the answer and what is recorded', () => {
  test('the answer is field by field from the stored row: no token, view URL, estimate data or costs', async () => {
    const res = await create({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res.body).toEqual({
      id: ESTIMATE_ID,
      status: 'draft',
      lines: [{ label: 'Pest Control', monthly: 37.33, annual: 448 }, { label: 'WaveGuard setup fee', oneTime: 99 }],
      monthlyTotal: 37.33,
      annualTotal: 448,
      oneTimeTotal: 99,
      officeFirst: { required: false, reasons: [] },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/token|viewurl|view_url|estimate-secret|estimate_data|margin|cost|drift|client_preview|digest|fingerprint/i);
  });

  test('one tool row with the detailed reasons, one credit, one audit event with ids only', async () => {
    await create({ visitId: VISIT_ID, services: ['PEST'], facts: { homeSqFt: 2600 } });
    expect(mockState.inserts).toHaveLength(1);
    expect(mockState.inserts[0]).toEqual({
      table: 'tech_estimates',
      row: {
        estimate_id: ESTIMATE_ID, technician_id: 'tech-1', office_first_reasons: JSON.stringify(['changed_fact:homeSqFt']),
        request_fingerprint: fingerprintOf({ visitId: VISIT_ID, services: ['PEST'], facts: { homeSqFt: 2600 } }),
      },
    });
    expect(typeof mockState.inserts[0].row.office_first_reasons).toBe('string');
    expect(creditSpy).toHaveBeenCalledTimes(1);
    expect(creditSpy.mock.calls[0][0]).toBe(mockState.trx);
    expect(creditSpy.mock.calls[0][2]).toEqual({ technicianId: 'tech-1' });
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0][0]).toEqual({
      actor_type: 'technician',
      actor_id: 'tech-1',
      action: 'tech_estimate.created',
      resource_type: 'estimates',
      resource_id: ESTIMATE_ID,
      metadata: { estimate_id: ESTIMATE_ID, technician_id: 'tech-1', customer_id: CUSTOMER_ID, office_first: true },
      critical: true,
      trx: mockState.trx,
    });
  });

  test('the server keeps every detailed reason; the phone sees only the three codes', async () => {
    saveSpy.mockImplementation(async (arg) => {
      if (!arg.dryRun) return saved();
      return prepared({ oneTime: 2000, lines: [{ service: 'pest_control', requiresManualReview: true }], warning: { message: 'x', customerName: 'Another Member' } });
    });
    phoneSpy.mockResolvedValue({ id: 'someone-else-id' });
    const res = await create({ prospect: PROSPECT, services: ['PEST'], facts: { homeSqFt: 2200 } });
    expect(JSON.parse(mockState.inserts[0].row.office_first_reasons)).toEqual([
      'changed_fact:homeSqFt', 'one_time_over_limit', 'engine_review', 'member_address', 'phone_matches_customer',
    ]);
    expect(res.body.officeFirst).toEqual({ required: true, reasons: ['changed_fact:homeSqFt', 'one_time_over_limit', 'office_review'] });
    expect(JSON.stringify(res.body)).not.toMatch(/engine_review|member_address|phone_matches|someone-else|Another/);
    expect(phoneSpy.mock.calls[0][1]).toBe('+19415550142');
    expect(auditSpy.mock.calls[0][0].metadata.office_first).toBe(true);
  });

  test('a phone match alone holds the quote for the office, under the one code; a customer is never phone-matched', async () => {
    phoneSpy.mockResolvedValue({ id: 'x' });
    const res = await create({ prospect: PROSPECT, services: ['PEST'] });
    expect(res.body.officeFirst).toEqual({ required: true, reasons: ['office_review'] });
    phoneSpy.mockClear();
    await create({ visitId: VISIT_ID, services: ['PEST'] });
    expect(phoneSpy).not.toHaveBeenCalled();
  });

  test('an admin login is saved and audited but never credited as the seller', async () => {
    mockCaller.role = 'admin';
    const res = await create({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res.status).toBe(200);
    expect(creditSpy).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });

  test('a retry: the same estimate and the stored reasons, no second tool row, credit or audit event', async () => {
    saveSpy.mockImplementation(async (arg) => (arg.dryRun ? prepared() : saved({ reused: true })));
    mockState.toolRow = { office_first_reasons: ['one_time_over_limit', 'member_address'], request_fingerprint: fingerprintOf({ visitId: VISIT_ID, services: ['PEST'] }) };
    const res = await create({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res.body.id).toBe(ESTIMATE_ID);
    expect(res.body.officeFirst).toEqual({ required: true, reasons: ['one_time_over_limit', 'office_review'] });
    nothingWritten();
  });

  test('a retry beside the first attempt with ANOTHER request is 409 already_saved', async () => {
    saveSpy.mockImplementation(async (arg) => (arg.dryRun ? prepared() : saved({ reused: true })));
    mockState.toolRow = { office_first_reasons: [], request_fingerprint: fingerprintOf({ visitId: VISIT_ID, services: ['PEST', 'MOSQUITO'] }) };
    expect(await create({ visitId: VISIT_ID, services: ['PEST'] })).toEqual({ status: 409, body: ALREADY_SAVED });
    nothingWritten();
  });

  test('an id that is not his tool estimate (reused, but no tool row of his) is refused', async () => {
    saveSpy.mockImplementation(async (arg) => (arg.dryRun ? prepared() : saved({ reused: true })));
    mockState.toolRow = null;
    expect(await create({ visitId: VISIT_ID, services: ['PEST'] })).toEqual({ status: 422, body: OFFICE_REFUSAL });
    nothingWritten();
  });

  test('a lost insert race answers from the winner\'s row', async () => {
    mockState.conflict = true;
    mockState.toolRow = { office_first_reasons: [], request_fingerprint: fingerprintOf({ visitId: VISIT_ID, services: ['PEST'] }) };
    const res = await create({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res.status).toBe(200);
    expect(creditSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
  });
});

// A create that already committed (the phone lost the first answer) is answered from the stored rows, before anything is
// looked up, priced or saved again.
describe('POST /api/tech/estimates: a retry of a saved create', () => {
  const BODY = { visitId: VISIT_ID, services: ['PEST'] };
  // His stored tool estimate under the draft id, as the join returns it (pg numerics as strings).
  const storedRow = (over = {}) => ({
    id: DRAFT_ID, technician_id: 'tech-1', status: 'draft', monthly_total: '37.33', annual_total: '448.00', onetime_total: '99.00',
    estimate_data: saved().estimate.estimate_data, token: 'secret-token',
    office_first_reasons: ['one_time_over_limit', 'member_address'], request_fingerprint: fingerprintOf(BODY), ...over,
  });
  const rebuiltNothing = () => {
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(phoneSpy).not.toHaveBeenCalled();
    expect(bellSpy).not.toHaveBeenCalled();
    nothingWritten();
  };

  test('the stored estimate is the answer, field by field, and nothing is looked up, priced, saved or rung', async () => {
    mockState.own = [storedRow()];
    const res = await create(BODY);
    expect(res).toEqual({
      status: 200,
      body: {
        id: DRAFT_ID,
        status: 'draft',
        lines: [{ label: 'Pest Control', monthly: 37.33, annual: 448 }, { label: 'WaveGuard setup fee', oneTime: 99 }],
        monthlyTotal: 37.33,
        annualTotal: 448,
        oneTimeTotal: 99,
        officeFirst: { required: true, reasons: ['one_time_over_limit', 'office_review'] },
      },
    });
    expect(mockState.wheres).toContainEqual(['tech_estimates as t', 't.estimate_id', DRAFT_ID]);
    expect(mockState.wheres).toContainEqual(['tech_estimates as t', 't.technician_id', 'tech-1']);
    rebuiltNothing();
  });

  test('it answers even when the quote could not be rebuilt now (the visit left his route, the service closed to him)', async () => {
    mockState.own = [storedRow({ request_fingerprint: fingerprintOf({ visitId: OTHER_TECH_VISIT_ID, services: ['PEST'] }) })];
    expect((await create({ visitId: OTHER_TECH_VISIT_ID, services: ['PEST'] })).status).toBe(200);
    mockState.caps = [];
    mockState.own = [storedRow()];
    expect((await create(BODY)).status).toBe(200);
    rebuiltNothing();
  });

  test.each([
    ['other services', { ...BODY, services: ['PEST', 'MOSQUITO'] }],
    ['a typed fact', { ...BODY, facts: { homeSqFt: 2600 } }],
    ['another visit', { ...BODY, visitId: OTHER_TECH_VISIT_ID }],
    ['a new person', { prospect: PROSPECT, services: ['PEST'] }],
  ])('the same draft id with %s is 409 already_saved, before any lookup', async (_label, body) => {
    mockState.own = [storedRow()];
    expect(await create(body)).toEqual({ status: 409, body: ALREADY_SAVED });
    rebuiltNothing();
  });

  test('another price digest is another request', async () => {
    mockState.own = [storedRow()];
    expect(await call('POST', '', { ...BODY, clientDraftId: DRAFT_ID, digest: 'b'.repeat(64) })).toEqual({ status: 409, body: ALREADY_SAVED });
    rebuiltNothing();
  });

  test('a stored row without a fingerprint matches no request', async () => {
    mockState.own = [storedRow({ request_fingerprint: null })];
    expect(await create(BODY)).toEqual({ status: 409, body: ALREADY_SAVED });
    rebuiltNothing();
  });

  test('another login\'s estimate under that id is not his retry: the create goes on to the save, which decides', async () => {
    mockState.own = [storedRow({ technician_id: 'tech-2' })];
    expect((await create(BODY)).status).toBe(200);
    expect(realSaves()).toHaveLength(1);
  });

  test('the first attempt commits while this one is working: a refusal from the rebuild or the save becomes the stored answer', async () => {
    // The save refuses with a changed price, but by then his estimate is stored.
    saveSpy.mockImplementation(async (arg) => {
      if (arg.dryRun) return prepared();
      mockState.own = [storedRow()];
      throw Object.assign(new Error('The estimate price or options changed. Review a fresh estimate before saving.'), { statusCode: 409 });
    });
    const res = await create(BODY);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(DRAFT_ID);
    expect(bellSpy).not.toHaveBeenCalled();
    nothingWritten();
  });

  test('a server error is never turned into a stored answer', async () => {
    saveSpy.mockImplementation(async (arg) => {
      if (arg.dryRun) return prepared();
      mockState.own = [storedRow()];
      throw Object.assign(new Error('Live pricing configuration is unavailable.'), { statusCode: 503 });
    });
    expect((await create(BODY)).status).toBeGreaterThanOrEqual(500);
  });
});

describe('the request fingerprint', () => {
  const { requestFingerprint } = require('../services/tech-estimate-save')._private;
  const of = (body, digest = DIGEST) => requestFingerprint(body, digest);
  const BASE = { visitId: VISIT_ID, services: ['PEST', 'MOSQUITO'], facts: { homeSqFt: 2600 } };

  test('the same request gives the same 64-character hash; order, case, spacing and keys the tool does not read change nothing', () => {
    expect(of(BASE)).toMatch(/^[0-9a-f]{64}$/);
    expect(of({ facts: { homeSqFt: '2600 ' }, services: ['MOSQUITO', 'PEST', 'PEST'], visitId: VISIT_ID.toUpperCase(), ...FORGED_KEYS, clientDraftId: 'x' })).toBe(of(BASE));
    expect(of({ prospect: { ...PROSPECT, [SENTINEL]: 1 }, services: ['PEST'] })).toBe(of({ prospect: PROSPECT, services: ['PEST'] }));
  });

  test.each([
    ['another visit', { ...BASE, visitId: OTHER_TECH_VISIT_ID }],
    ['another service list', { ...BASE, services: ['PEST'] }],
    ['another fact value', { ...BASE, facts: { homeSqFt: 2601 } }],
    ['another fact', { ...BASE, facts: { lotSqFt: 2600 } }],
    ['no facts', { ...BASE, facts: undefined }],
    ['a new person', { prospect: PROSPECT, services: BASE.services, facts: BASE.facts }],
  ])('%s is another request', (_label, body) => {
    expect(of(body)).not.toBe(of(BASE));
  });

  test('each typed field of a new person counts, and so does the digest', () => {
    const person = (over) => of({ prospect: { ...PROSPECT, ...over }, services: ['PEST'] });
    for (const key of ['firstName', 'lastName', 'phone', 'address', 'city', 'zip']) expect(person({ [key]: 'other' })).not.toBe(person({}));
    expect(of(BASE, 'b'.repeat(64))).not.toBe(of(BASE));
  });

  test('a malformed body never throws', () => {
    for (const body of [{}, { services: 'PEST', facts: [1], prospect: 'x', visitId: { a: 1 } }, { services: [{}, null, 5], facts: { homeSqFt: {} }, prospect: [] }]) {
      expect(of(body)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 2b: one bell for a held estimate

describe('POST /api/tech/estimates: the office bell for a held estimate', () => {
  const HELD = { visitId: VISIT_ID, services: ['PEST'], facts: { homeSqFt: 2600 } };
  const ring = () => bellSpy.mock.calls.map(([category, headline, why, opts]) => ({ category, headline, why, opts }));

  test('a held create rings ONE bell with the eight parts, after the transaction', async () => {
    const res = await create(HELD);
    expect(res.status).toBe(200);
    expect(bellSpy).toHaveBeenCalledTimes(1);
    const [{ category, headline, why, opts }] = ring();
    expect(category).toBe('estimate');
    expect(headline).toBe('Estimates — check Taylor\'s estimate for Casey Sample');
    expect(headline.length).toBeLessThanOrEqual(60);
    expect(why).toBe('The technician changed the home size, so it waits for your check before it goes.');
    expect(why.length).toBeLessThanOrEqual(110);
    expect(opts).toMatchObject({
      bell: true,
      dedupeKey: `tech-estimate-office-first:${ESTIMATE_ID}`,
      link: `/admin/estimates?estimateId=${ESTIMATE_ID}`,
      metadata: { area: 'Estimates', severity: 'needs-you', who: 'person', doneWhen: 'estimate_sent_or_closed', subject: { type: 'estimate', id: ESTIMATE_ID }, estimateId: ESTIMATE_ID },
    });
    expect(opts.dedupeOpenOnly).toBeUndefined();
    expect(opts.detail).toMatch(/home size/);
    // The transaction had already returned: the bell is not part of it.
    expect(bellSpy.mock.invocationCallOrder[0]).toBeGreaterThan(auditSpy.mock.invocationCallOrder[0]);
  });

  test('nothing from the bell reaches the technician\'s answer', async () => {
    const res = await create(HELD);
    expect(JSON.stringify(res.body)).not.toMatch(/waits for your check|check Taylor|estimateId=|tech-estimate-office-first|bell/i);
  });

  test.each([
    ['a changed fact', ['changed_fact:lotSqFt', 'one_time_over_limit', 'engine_review'], 'The technician changed the lot size, so it waits for your check before it goes.'],
    ['the first changed fact in the tool\'s order', ['changed_fact:stories', 'changed_fact:homeSqFt'], 'The technician changed the home size, so it waits for your check before it goes.'],
    ['a one-time job over the limit', ['one_time_over_limit', 'engine_review', 'member_address'], 'A one-time job over $1,000 waits for your check before it goes.'],
    ['an engine line to review', ['engine_review', 'member_address'], 'The price needs your check before it goes.'],
    ['a member address', ['member_address'], 'This may be a current customer, so check who it is before it goes.'],
    ['a phone that matches a customer', ['phone_matches_customer'], 'This may be a current customer, so check who it is before it goes.'],
  ])('why for %s', async (_label, detailed, expected) => {
    const ringOffice = require('../services/tech-estimate-office-bell').ringOfficeFirst;
    await ringOffice({ estimate: saved().estimate, detailed, technician: { id: 'tech-1', name: 'Taylor Example' } });
    expect(ring()[0].why).toBe(expected);
    expect(expected.length).toBeLessThanOrEqual(110);
    // The full list is in the detail, in words.
    expect(ring()[0].opts.detail).not.toMatch(/_/);
  });

  test('a long name still fits the 60-character headline', async () => {
    saveSpy.mockImplementation(async (arg) => (arg.dryRun ? prepared() : saved({ customerName: 'Bartholomew Montgomery-Featherstonehaugh III' })));
    await create(HELD);
    expect(ring()[0].headline.length).toBeLessThanOrEqual(60);
    expect(ring()[0].headline).toMatch(/^Estimates — check Taylor's estimate for Bartholomew/);
  });

  test('a quote the technician may send himself rings nothing', async () => {
    const res = await create({ visitId: VISIT_ID, services: ['PEST'] });
    expect(res.body.officeFirst.required).toBe(false);
    expect(bellSpy).not.toHaveBeenCalled();
  });

  test('a retry rings nothing', async () => {
    saveSpy.mockImplementation(async (arg) => (arg.dryRun ? prepared() : saved({ reused: true })));
    mockState.toolRow = { office_first_reasons: ['changed_fact:homeSqFt'], request_fingerprint: fingerprintOf(HELD) };
    const res = await create(HELD);
    expect(res.status).toBe(200);
    expect(res.body.officeFirst.required).toBe(true);
    expect(bellSpy).not.toHaveBeenCalled();
  });

  test('a lost insert race rings nothing (the winner rings)', async () => {
    mockState.conflict = true;
    mockState.toolRow = { office_first_reasons: ['changed_fact:homeSqFt'], request_fingerprint: fingerprintOf(HELD) };
    expect((await create(HELD)).status).toBe(200);
    expect(bellSpy).not.toHaveBeenCalled();
  });

  test('a save the office refuses rings nothing', async () => {
    saveSpy.mockImplementation(async (arg) => { if (arg.dryRun) return prepared(); throw Object.assign(new Error('x'), { statusCode: 409 }); });
    expect((await create(HELD)).status).toBe(422);
    expect(bellSpy).not.toHaveBeenCalled();
  });

  test('a bell that cannot be raised never fails the create: 200, the same answer, one log line with ids only', async () => {
    const quiet = await create(HELD);
    bellSpy.mockClear();
    bellSpy.mockRejectedValue(Object.assign(new Error('db down for Casey Sample 941-555-0142'), { code: 'ECONNRESET' }));
    const logger = require('../services/logger');
    logger.warn.mockClear();
    const res = await create(HELD);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(quiet.body);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0][0];
    expect(line).toContain(ESTIMATE_ID);
    expect(line).not.toMatch(/Casey|941|db down/);
  });
});

// ---------------------------------------------------------------------------
// His own estimates

describe('GET /api/tech/estimates and /:id', () => {
  const ROW = {
    id: ESTIMATE_ID, technician_id: 'tech-1', created_at: '2026-11-09T15:00:00.000Z', status: 'sent', sent_at: '2026-11-09T16:00:00.000Z',
    accepted_at: null, who: 'Sample Person', address: '100 Sample St, Sampletown, FL 34202',
    monthly_total: '37.33', annual_total: '448.00', onetime_total: '99.00', office_first_reasons: ['changed_fact:stories', 'engine_review'],
    // columns the shaper must never copy
    token: 'secret-token', customer_phone: '+19415550142', estimate_data: { result: { recurring: { services: [{ name: 'Pest Control', mo: 37.33, annualAfterDiscount: 448 }] }, oneTime: {} }, costs: { margin: 0.5 } },
  };
  const OTHER = { ...ROW, id: '00000000-0000-4000-8000-0000000000e2', technician_id: 'tech-2' };
  const SHAPE = {
    id: ESTIMATE_ID, createdAt: '2026-11-09T15:00:00.000Z', status: 'sent', sentAt: '2026-11-09T16:00:00.000Z', acceptedAt: null,
    who: 'Sample Person', addressLine: '100 Sample St', monthlyTotal: 37.33, annualTotal: 448, oneTimeTotal: 99,
    officeFirst: { required: true, reasons: ['changed_fact:stories', 'office_review'] },
    canSend: false,
    needsTextRequest: true,
  };

  test('the list holds his rows only, in the fixed shape, with no token, phone, data or detailed reason', async () => {
    mockState.own = [ROW, OTHER];
    const res = await call('GET', '');
    expect(res).toEqual({ status: 200, body: { estimates: [SHAPE] } });
    expect(JSON.stringify(res.body)).not.toMatch(/token|phone|estimate_data|margin|engine_review|tech-2/i);
    expect(mockState.wheres).toContainEqual(['tech_estimates as t', 't.technician_id', 'tech-1']);
    expect(mockState.writes).toEqual([]);
  });

  test('an admin login also sees only its own', async () => {
    mockCaller.role = 'admin';
    mockState.own = [ROW, { ...OTHER, technician_id: 'tech-1', id: '00000000-0000-4000-8000-0000000000e3' }, { ...OTHER }];
    const res = await call('GET', '');
    expect(res.body.estimates.map((e) => e.id)).toEqual([ESTIMATE_ID, '00000000-0000-4000-8000-0000000000e3']);
  });

  test('one of his estimates adds its lines', async () => {
    mockState.own = [ROW];
    const res = await call('GET', `/${ESTIMATE_ID}`);
    expect(res).toEqual({ status: 200, body: { ...SHAPE, lines: [{ label: 'Pest Control', monthly: 37.33, annual: 448 }] } });
    expect(JSON.stringify(res.body)).not.toMatch(/token|phone|estimate_data|margin/i);
  });

  test('another technician\'s estimate, an unknown id and a non-UUID are the same 404', async () => {
    mockState.own = [OTHER];
    const answers = [];
    for (const id of [OTHER.id, '00000000-0000-4000-8000-0000000000ff', 'not-a-uuid']) answers.push(await call('GET', `/${id}`));
    expect(answers.map((a) => a.status)).toEqual([404, 404, 404]);
    expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
  });

  test('/setup is still the setup read, not an id', async () => {
    expect((await call('GET', '/setup')).body.enabled).toBe(true);
  });
});

describe('the technician allow-list', () => {
  const UUID = '00000000-0000-4000-8000-0000000000e1';
  test('admits exactly the six tool routes and nothing else under /api/tech/estimates', () => {
    for (const [method, path] of [
      ['GET', '/api/tech/estimates/setup'], ['POST', '/api/tech/estimates/price'], ['POST', '/api/tech/estimates'],
      ['GET', '/api/tech/estimates'], ['GET', `/api/tech/estimates/${UUID}`], ['POST', `/api/tech/estimates/${UUID}/send`],
    ]) {
      expect([method, path, technicianMayReach(method, path)]).toEqual([method, path, true]);
    }
    for (const [method, path] of [
      ['POST', '/api/tech/estimates/setup'], ['GET', '/api/tech/estimates/price'], ['PUT', '/api/tech/estimates/price'],
      ['PUT', '/api/tech/estimates'], ['DELETE', '/api/tech/estimates'], ['PATCH', `/api/tech/estimates/${UUID}`],
      ['PUT', `/api/tech/estimates/${UUID}`], ['DELETE', `/api/tech/estimates/${UUID}`], ['POST', `/api/tech/estimates/${UUID}`],
      ['GET', '/api/tech/estimates/mine'], ['GET', `/api/tech/estimates/${UUID}/send`], ['PUT', `/api/tech/estimates/${UUID}/send`], ['POST', '/api/tech/estimates/not-a-uuid/send'], ['POST', `/api/tech/estimates/${UUID}/send/x`],
      ['POST', '/api/tech/estimates/price/extra'], ['GET', '/api/tech/estimates/setup/x'], ['POST', '/api/tech/estimates/send'],
    ]) {
      expect([method, path, technicianMayReach(method, path)]).toEqual([method, path, false]);
    }
  });
});

// ---------------------------------------------------------------------------
// Step 4: POST /:id/send. The shared sender, the transaction and the bell are scripted: these tests pin what the route
// DECIDES from the stored row and what it hands the sender. The real sender, claim and schema are in the Postgres suite.
describe('POST /api/tech/estimates/:id/send', () => {
  const sendRoutes = require('../routes/admin-estimates');
  const sendTool = require('../services/tech-estimate-send');
  const ownerAlerts = require('../services/owner-alerts');
  const INSIDE = new Date('2026-03-10T15:00:00.000Z'); // 11:00 AM ET
  const OUTSIDE = new Date('2026-03-10T03:00:00.000Z'); // 11:00 PM ET the evening before
  const NEW_PERSON_PHONE = '+19415550142';
  let senderSpy; let ownerSpy;

  // The stored row the send locks: the estimate's columns plus the tool row's reasons.
  const sendRow = (over = {}) => ({
    id: ESTIMATE_ID, status: 'draft', customer_id: CUSTOMER_ID, customer_name: 'Casey Sample', customer_phone: NEW_PERSON_PHONE,
    archived_at: null, price_locked_at: null, estimate_group_id: null, pricing_authority: 'SERVER', token: 'secret-token',
    estimate_data: {}, tool_reasons: [], monthly_total: '37.33', annual_total: '448.00', onetime_total: '0', ...over,
  });
  // A scripted transaction: every builder method chains; first() answers the locked row, returning() the claim.
  function script(row, { claim = true } = {}) {
    const calls = [];
    const trx = (table) => {
      const builder = new Proxy({}, {
        get: (_target, name) => {
          if (name === 'then') return undefined;
          return (...args) => {
            calls.push({ table, name, args });
            if (name === 'first') return Promise.resolve(row);
            if (name === 'returning') return Promise.resolve(claim && row ? [{ ...row, status: 'sending' }] : []);
            return builder;
          };
        },
      });
      return builder;
    };
    mockState.sendScript = { trx, calls };
    return calls;
  }
  const send = (body = {}, id = ESTIMATE_ID) => call('POST', `/${id}/send`, body);
  const sent = () => ({ sent: true, channels: { sms: { ok: true, real: true } }, sentChannels: ['sms'], failedChannels: [] });
  const claimWrites = (calls) => calls.filter((c) => c.table === 'estimates' && c.name === 'update');
  const toolWrites = (calls) => calls.filter((c) => c.table === 'tech_estimates' && c.name === 'update');

  beforeEach(() => {
    sendTool._private.clock.now = () => INSIDE;
    senderSpy = jest.spyOn(sendRoutes, 'sendEstimateNow').mockImplementation(async () => sent());
    ownerSpy = jest.spyOn(ownerAlerts, 'recordOwnerAlert').mockResolvedValue({ ok: true });
    mockState.fresh = { status: 'sent', sent_at: '2026-03-10T15:00:01.000Z' };
  });
  afterEach(() => { sendTool._private.clock.now = () => new Date(); });

  describe('refusals are decided from the stored row and send nothing', () => {
    test('only his own tool estimate: the lookup is keyed to the login, and another login\'s estimate, an unknown id and a non-UUID are the same 404', async () => {
      const calls = script(null);
      const answers = [await send({}), await send({}, 'not-a-uuid')];
      expect(answers.map((a) => a.status)).toEqual([404, 404]);
      expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
      expect(answers[0].body).toEqual({ error: 'Estimate not found' });
      expect(calls.find((c) => c.name === 'where').args[0]).toEqual({ 't.estimate_id': ESTIMATE_ID, 't.technician_id': 'tech-1' });
      expect(senderSpy).not.toHaveBeenCalled();
    });

    test('an archived estimate is a 404', async () => {
      script(sendRow({ archived_at: '2026-03-01T00:00:00Z' }));
      expect((await send()).status).toBe(404);
      expect(senderSpy).not.toHaveBeenCalled();
    });

    test('a stored office-first reason is 409 office_first whatever the request says; the sender is never reached and nothing is claimed', async () => {
      const calls = script(sendRow({ tool_reasons: ['changed_fact:homeSqFt'] }));
      const res = await send({ askedForText: true, officeFirst: false, office_first_reasons: [], reasons: [] });
      expect(res).toEqual({ status: 409, body: { error: 'The office checks this one first.', code: 'office_first' } });
      expect(senderSpy).not.toHaveBeenCalled();
      expect(claimWrites(calls)).toEqual([]);
      expect(mockState.updates).toEqual([]);
    });

    test.each(['sent', 'scheduled', 'sending', 'viewed', 'accepted', 'declined', 'expired'])('a %s estimate is 409 already_sent', async (status) => {
      script(sendRow({ status }));
      expect(await send()).toEqual({ status: 409, body: { error: 'This estimate was already sent.', code: 'already_sent' } });
      expect(senderSpy).not.toHaveBeenCalled();
    });

    test('a send the app parked (send_failed) is the office\'s: 409 office_sends', async () => {
      script(sendRow({ status: 'send_failed' }));
      expect(await send()).toEqual({ status: 409, body: { error: 'The text did not go. The office will send it.', code: 'office_sends' } });
      expect(senderSpy).not.toHaveBeenCalled();
    });

    test.each([['no phone', null], ['an impossible number', '+10115550142']])('%s is 422 office_sends and the office hears of it', async (_label, phone) => {
      script(sendRow({ customer_phone: phone }));
      expect(await send()).toEqual({ status: 422, body: { error: 'This estimate has no mobile number. Ask the office to send it.', code: 'office_sends' } });
      expect(senderSpy).not.toHaveBeenCalled();
      expect(bellSpy).toHaveBeenCalledTimes(1);
    });

    test('a grouped, price-locked or unfinished-earlier-send estimate is the office\'s', async () => {
      for (const over of [
        { estimate_group_id: 'g-1' }, { price_locked_at: '2026-03-01T00:00:00Z' },
        { estimate_data: { manualSendAttempts: [{ key: 'k', startedAt: '2026-03-01T00:00:00Z' }] } },
      ]) {
        script(sendRow(over));
        expect((await send()).body.code).toBe('office_sends');
      }
      expect(senderSpy).not.toHaveBeenCalled();
    });

    test('outside 8 AM to 8 PM ET: 409 outside_hours, nothing claimed, nothing sent, the office not bothered', async () => {
      sendTool._private.clock.now = () => OUTSIDE;
      const calls = script(sendRow());
      expect(await send()).toEqual({ status: 409, body: { error: 'Texts go out between 8 AM and 8 PM. Send it then, or ask the office.', code: 'outside_hours' } });
      expect(senderSpy).not.toHaveBeenCalled();
      expect(claimWrites(calls)).toEqual([]);
      expect(bellSpy).not.toHaveBeenCalled();
    });

    test('a second tap that loses the claim to the first answers already_sent and never reaches the sender', async () => {
      script(sendRow(), { claim: false });
      expect((await send()).body).toEqual({ error: 'This estimate was already sent.', code: 'already_sent' });
      expect(senderSpy).not.toHaveBeenCalled();
    });
  });

  describe('what the sender is handed', () => {
    test('a new person needs askedForText exactly true; anything else is 400 needs_text_request', async () => {
      script(sendRow({ customer_id: null }));
      for (const body of [{}, { askedForText: false }, { askedForText: 'true' }, { askedForText: 1 }, null]) {
        expect(await send(body)).toEqual({ status: 400, body: { error: 'Confirm that the person asked for the estimate by text.', code: 'needs_text_request' } });
      }
      expect(senderSpy).not.toHaveBeenCalled();
      expect(mockState.sendScript.calls.some((c) => c.name === 'update')).toBe(false);
    });

    test('a new person who confirmed: the stored time is the consent time the sender gets, and sms is the only channel', async () => {
      const calls = script(sendRow({ customer_id: null }));
      const res = await send({ askedForText: true, sendMethod: 'email', scheduledAt: '2030-01-01', acknowledgeEngineReview: true });
      expect(res.status).toBe(200);
      const [estimateArg, method, options] = senderSpy.mock.calls[0];
      expect(method).toBe('sms');
      expect(estimateArg.status).toBe('sending');
      expect(Object.keys(options).sort()).toEqual(['now', 'techEstimateSend']);
      expect(options.techEstimateSend).toEqual({ consentCapturedAt: INSIDE.toISOString() });
      const [stored] = toolWrites(calls);
      expect(stored.args[0]).toEqual({ text_request_confirmed_at: INSIDE });
      // the claim happens before the stored time and before the sender
      expect(calls.findIndex((c) => c.table === 'estimates' && c.name === 'update')).toBeLessThan(calls.indexOf(stored));
    });

    test('a customer on his route needs no confirmation (askedForText is ignored) and hands the sender no consent time', async () => {
      const calls = script(sendRow());
      expect((await send({ askedForText: false })).status).toBe(200);
      expect((await send({})).status).toBe(200);
      for (const [, method, options] of senderSpy.mock.calls) {
        expect(method).toBe('sms');
        expect(options.techEstimateSend).toEqual({});
      }
      expect(toolWrites(calls).filter((c) => 'text_request_confirmed_at' in c.args[0])).toEqual([]);
    });

    test('an admin login sends only its own tool estimate too', async () => {
      mockCaller.role = 'admin';
      const calls = script(sendRow());
      await send();
      expect(calls.find((c) => c.name === 'where').args[0]['t.technician_id']).toBe('tech-1');
    });

    test('the claim goes draft to sending as sms with the office send\'s hold predicates', async () => {
      const calls = script(sendRow());
      await send();
      const claim = calls.filter((c) => c.table === 'estimates');
      expect(claim.find((c) => c.name === 'where').args[0]).toEqual({ id: ESTIMATE_ID, status: 'draft' });
      expect(claim.filter((c) => c.name === 'whereNull').map((c) => c.args[0]).sort()).toEqual(['archived_at', 'estimate_group_id', 'price_locked_at']);
      expect(claim.filter((c) => c.name === 'whereRaw').length).toBeGreaterThanOrEqual(5);
      expect(claim.find((c) => c.name === 'update').args[0]).toMatchObject({ status: 'sending', send_method: 'sms' });
    });
  });

  describe('outcomes', () => {
    test('sent: the answer is { id, status, sentAt } only, one audit event, one quiet owner line, and the stamp', async () => {
      const calls = script(sendRow());
      const res = await send({});
      expect(res).toEqual({ status: 200, body: { id: ESTIMATE_ID, status: 'sent', sentAt: '2026-03-10T15:00:01.000Z' } });
      expect(JSON.stringify(res.body)).not.toMatch(/token|http|941|monthly|annual|lines/i);
      expect(auditSpy).toHaveBeenCalledTimes(1);
      expect(auditSpy.mock.calls[0][0]).toMatchObject({
        actor_type: 'technician', actor_id: 'tech-1', action: 'tech_estimate.sent', resource_type: 'estimates', resource_id: ESTIMATE_ID,
        metadata: { estimate_id: ESTIMATE_ID, technician_id: 'tech-1', customer_id: CUSTOMER_ID, new_person: false },
      });
      expect(JSON.stringify(auditSpy.mock.calls[0][0])).not.toMatch(/941|secret-token|Casey/);
      expect(toolWrites(calls).some((c) => c.args[0].sent_by_technician_at)).toBe(true);
      expect(ownerSpy).toHaveBeenCalledTimes(1);
      const [kind, fields] = ownerSpy.mock.calls[0];
      expect(kind).toBe('tech-estimate-sent');
      expect(fields.action).toMatch(/Taylor/);
      expect(fields.action).toMatch(/Casey Sample/);
      expect(JSON.stringify(fields)).not.toMatch(/9415550142|\(941\)|\$|secret-token/);
      expect(bellSpy).not.toHaveBeenCalled();
      expect(mockState.updates).toEqual([]);
    });

    test('held by the window at its edge: 409 outside_hours, the draft goes back, the office is not told', async () => {
      script(sendRow());
      senderSpy.mockResolvedValue({ sent: false, channels: { sms: { ok: false, code: 'QUIET_HOURS_HOLD', error: 'x' } }, sentChannels: [], failedChannels: ['sms'] });
      const res = await send();
      expect(res).toEqual({ status: 409, body: { error: 'Texts go out between 8 AM and 8 PM. Send it then, or ask the office.', code: 'outside_hours' } });
      expect(mockState.updates).toEqual([{ table: 'estimates', where: { id: ESTIMATE_ID, status: 'sending' }, patch: expect.objectContaining({ status: 'draft', send_method: null }) }]);
      expect(bellSpy).not.toHaveBeenCalled();
      expect(auditSpy).not.toHaveBeenCalled();
      expect(ownerSpy).not.toHaveBeenCalled();
    });

    test.each([
      ['a rule refused it (opt-out, landline)', { sent: false, channels: { sms: { ok: false, error: 'opted out' } }, sentChannels: [], failedChannels: ['sms'] }, null, 422, 'tech_send_not_sent'],
      ['the provider outcome is uncertain', { sent: false, channels: { sms: { ok: false, uncertain: true, error: 'timeout' } }, sentChannels: [], failedChannels: ['sms'] }, null, 502, 'tech_send_uncertain'],
      ['the sender refused before any handoff', null, Object.assign(new Error('County records could not confirm this house number'), { statusCode: 409 }), 422, 'tech_send_not_sent'],
      ['the sender broke', null, new Error('boom'), 502, 'tech_send_uncertain'],
    ])('%s: office_sends, parked for the office, the office bell rings once, nothing retried', async (_label, result, error, status, code) => {
      script(sendRow());
      if (error) senderSpy.mockRejectedValue(error); else senderSpy.mockResolvedValue(result);
      const res = await send();
      expect(res).toEqual({ status, body: { error: 'The text did not go. The office will send it.', code: 'office_sends' } });
      expect(senderSpy).toHaveBeenCalledTimes(1);
      expect(mockState.updates).toEqual([{ table: 'estimates', where: { id: ESTIMATE_ID, status: 'sending' }, patch: expect.objectContaining({ status: 'send_failed', last_send_error: code }) }]);
      expect(bellSpy).toHaveBeenCalledTimes(1);
      expect(bellSpy.mock.calls[0][0]).toBe('estimate');
      expect(bellSpy.mock.calls[0][3]).toMatchObject({ bell: true, dedupeKey: `tech-estimate-office-first:${ESTIMATE_ID}` });
      expect(auditSpy).not.toHaveBeenCalled();
      expect(ownerSpy).not.toHaveBeenCalled();
    });

    test('a bookkeeping failure after the text went never turns the answer into an error', async () => {
      script(sendRow());
      auditSpy.mockRejectedValue(new Error('audit down'));
      ownerSpy.mockRejectedValue(new Error('alert down'));
      expect((await send()).status).toBe(200);
    });
  });

  describe('his own reads show canSend', () => {
    const ROW = {
      id: ESTIMATE_ID, technician_id: 'tech-1', created_at: '2026-11-09T15:00:00.000Z', status: 'draft', sent_at: null, accepted_at: null,
      who: 'Sample Person', address: '100 Sample St, Sampletown, FL 34202', monthly_total: '37.33', annual_total: '448.00', onetime_total: '0',
      office_first_reasons: [], estimate_data: { result: { recurring: { services: [] }, oneTime: {} } },
    };
    test('true for his draft with no stored reason; false for a held draft or one already sent', async () => {
      mockState.own = [
        ROW, { ...ROW, id: '00000000-0000-4000-8000-0000000000e2', office_first_reasons: ['engine_review'] },
        { ...ROW, id: '00000000-0000-4000-8000-0000000000e3', status: 'sent' },
      ];
      const list = await call('GET', '');
      expect(list.body.estimates.map((e) => e.canSend)).toEqual([true, false, false]);
      expect((await call('GET', `/${ESTIMATE_ID}`)).body.canSend).toBe(true);
    });

    test('needsTextRequest is true for a new person and false for a customer, and the customer id is never returned', async () => {
      mockState.own = [ROW, { ...ROW, id: '00000000-0000-4000-8000-0000000000e2', customer_id: CUSTOMER_ID }];
      const list = await call('GET', '');
      expect(list.body.estimates.map((e) => e.needsTextRequest)).toEqual([true, false]);
      expect(JSON.stringify(list.body)).not.toContain(CUSTOMER_ID);
    });
  });
});
