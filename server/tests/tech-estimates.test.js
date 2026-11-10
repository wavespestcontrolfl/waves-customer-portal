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
  switchOn: true, queries: [], writes: [], customers: [], onRoute: new Set(), caps: [],
  // step 2a: his tool rows, the transaction's writes, and the wheres the own-reads ran
  own: [], inserts: [], toolRow: null, conflict: false, wheres: [], trx: null,
};

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => {
    req.technician = { id: mockCaller.id, role: mockCaller.role };
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
        if (args[0] && typeof args[0] === 'object' && args[0].id) builder._id = args[0].id;
        if (args[0] === 't.technician_id') filters.technician = args[1];
        if (args[0] === 'e.id') filters.id = args[1];
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
        return undefined;
      },
      then(resolve, reject) {
        const rows = table === 'customers' ? mockState.customers : table === 'tech_estimates as t' ? builder.rows() : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
      insert() { mockState.writes.push(table); return builder; },
      update() { mockState.writes.push(table); return builder; },
    };
    return builder;
  };
  dbFn.raw = (sql) => ({ raw: sql });
  // The create's one transaction: the fake trx records the tool row and answers the retry reads.
  dbFn.transaction = async (work) => {
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
jest.mock('../services/technician-visit-scope', () => ({
  technicianServicesCustomer: jest.fn(async (req, id) => req.techRole === 'admin' || mockState.onRoute.has(id)),
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
const knownCaller = require('../utils/known-caller-phone');
const { technicianMayReach } = require('../middleware/technician-scope');
const { PEST_SERVICES, _private: { ENGINE_SERVICES } } = require('../services/tech-estimate-price');
const router = require('../routes/tech-estimates');

const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
const UNIT_CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c3';
const PROSPECT = { firstName: 'Sample', lastName: 'Person', phone: '(941) 555-0142', address: '200 Example Ave', city: 'Sampletown', zip: '34202' };
const OFFICE_REFUSAL = { error: 'The office needs to price this one.', code: 'office_prices' };
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
function saved({ reused = false, status = 'draft', warning = null } = {}) {
  const base = prepared({ monthly: 37.33, annual: 448, oneTime: 99 }).estimate;
  return {
    reused,
    memberLinkageWarning: warning,
    estimate: { ...base, id: ESTIMATE_ID, status, customer_id: CUSTOMER_ID, monthly_total: '37.33', annual_total: '448.00', onetime_total: '99.00', estimate_data: JSON.parse(base.estimate_data) },
  };
}

let server; let baseUrl; let lookupSpy; let saveSpy; let creditSpy; let auditSpy; let phoneSpy;
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
    onRoute: new Set([CUSTOMER_ID, UNIT_CUSTOMER_ID]),
    caps: [
      { service_category: 'general', state: 'qualified' }, { service_category: 'mosquito', state: 'qualified' },
      { service_category: 'rodent', state: 'review_required' }, { service_category: 'termite', state: 'off' },
      { service_category: 'lawn', state: 'qualified' },
    ],
    customers: [
      { id: CUSTOMER_ID, address_line1: '100 Sample St', address_line2: null, city: 'Sampletown', state: 'FL', zip: '34202' },
      { id: UNIT_CUSTOMER_ID, address_line1: '300 Sample St', address_line2: 'Apt 4', city: 'Sampletown', state: 'FL', zip: '34202' },
    ],
  });
  lookupSpy = jest.spyOn(lookupRoutes, 'performPropertyLookup').mockImplementation(async () => lookupOf());
  saveSpy = jest.spyOn(persistence, 'createOrReuseAdminEstimate').mockImplementation(async (arg) => (arg.dryRun ? prepared() : saved()));
  creditSpy = jest.spyOn(soldBy, 'creditCreator').mockImplementation(async (_trx, estimate) => ({ ...estimate, sold_by_source: 'creator' }));
  auditSpy = jest.spyOn(auditLog, 'recordAuditEvent').mockResolvedValue(null);
  phoneSpy = jest.spyOn(knownCaller, 'findKnownCallerCustomer').mockResolvedValue(null);
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
    const res = await call(method, path, method === 'POST' ? { customerId: CUSTOMER_ID, services: ['PEST'] } : undefined);
    expect(res).toEqual({ status: 404, body: { enabled: false } });
    expect(mockState.queries).toEqual([]);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test.each(GUARDED)('technician switch off: %s %s answers 404 before any customer read', async (method, path) => {
    mockState.switchOn = false;
    const res = await call(method, path, method === 'POST' ? { customerId: CUSTOMER_ID, services: ['PEST'] } : undefined);
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
  test('a customer who is not on his route is a 404, the same as an unknown id, and nothing is looked up', async () => {
    for (const customerId of ['00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-0000000000ff']) {
      const res = await price({ customerId, services: ['PEST'] });
      expect(res).toEqual({ status: 404, body: { error: 'Customer not found' } });
    }
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  test('a service outside his Qualified categories is refused before the paid lookup', async () => {
    for (const key of ['RODENT_BAIT', 'TERMITE_BAIT', 'LAWN', 'TRENCHING']) {
      expect((await price({ customerId: CUSTOMER_ID, services: ['PEST', key] })).status).toBe(400);
    }
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test('exactly one of customerId and prospect; a prospect needs name, phone, address and ZIP', async () => {
    expect((await price({ services: ['PEST'] })).status).toBe(400);
    expect((await price({ customerId: CUSTOMER_ID, prospect: PROSPECT, services: ['PEST'] })).status).toBe(400);
    expect((await price({ prospect: { ...PROSPECT, zip: '' }, services: ['PEST'] })).status).toBe(400);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test('a new person is looked up on the typed address through the declared caller', async () => {
    const res = await price({ prospect: PROSPECT, services: ['PEST'] });
    expect(res.status).toBe(200);
    expect(lookupSpy.mock.calls[0][0]).toBe('200 Example Ave, Sampletown, FL 34202');
    expect(lookupSpy.mock.calls[0][1]).toEqual({ prioritizeAccuracy: true });
  });

  test.each([
    ['the county does not confirm the home', () => lookupOf(countyRecord({ _fieldEvidence: { squareFootage: { sourceType: 'ai' } } }))],
    ['a condo', () => lookupOf(countyRecord({ propertyType: 'Condo' }))],
    ['no property record', () => lookupOf(null)],
    ['a commercial property', () => lookupOf(countyRecord(), { propertyType: 'commercial', isCommercial: true })],
    ['no profile at all', () => ({ propertyRecord: countyRecord() })],
  ])('%s: 422 office_prices, no number, nothing priced', async (_label, make) => {
    lookupSpy.mockImplementation(async () => make());
    const res = await price({ customerId: CUSTOMER_ID, services: ['PEST'] });
    expect(res).toEqual({ status: 422, body: OFFICE_REFUSAL });
    expect(saveSpy).not.toHaveBeenCalled();
  });

  test('a unit address: 422 office_prices before the save', async () => {
    const res = await price({ customerId: UNIT_CUSTOMER_ID, services: ['PEST'] });
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

describe('POST /price: the body the tool builds for the save', () => {
  const FORGED = FORGED_KEYS;

  test('a route customer: exactly the expected keys, nothing from the phone, dry run on live pricing', async () => {
    const res = await price({ customerId: CUSTOMER_ID, services: ['PEST', 'MOSQUITO'], ...FORGED });
    expect(res.status).toBe(200);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    const arg = saveSpy.mock.calls[0][0];
    expect(Object.keys(arg).sort()).toEqual(['body', 'database', 'dryRun', 'requireLivePricing', 'technician', 'technicianId']);
    expect(arg.dryRun).toBe(true);
    expect(arg.requireLivePricing).toBe(true);
    expect(arg.technicianId).toBe('tech-1');
    expect(Object.keys(arg.body).sort()).toEqual(['address', 'billByInvoice', 'customerId', 'estimateData', 'showOneTimeOption']);
    expect(arg.body).toEqual(expect.objectContaining({ customerId: CUSTOMER_ID, address: '100 Sample St, Sampletown, FL 34202', showOneTimeOption: false, billByInvoice: false }));
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
    const res = await price({ customerId: CUSTOMER_ID, services: ['PEST'], facts: { homeSqFt: 1850, color: 'red', discount: 5 } });
    expect(res.body.officeFirst).toEqual({ required: false, reasons: [] });
    expect(res.body.facts).toEqual({
      homeSqFt: { value: 1850, source: 'lookup' }, lotSqFt: { value: 9200, source: 'lookup' }, stories: { value: 1, source: 'lookup' },
    });
    expect(Object.keys(savedBody().estimateData.inputs)).not.toContain('_homeSqFtEdited');
  });

  test('a changed fact is priced on the typed value, marked as typed by a person, and sent to the office first', async () => {
    const res = await price({ customerId: CUSTOMER_ID, services: ['PEST'], facts: { homeSqFt: 2600, lotSqFt: 12000, stories: 2 } });
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
    await price({ customerId: CUSTOMER_ID, services: ['PEST'] });
    expect(savedInputs().storiesSource).toBe('estimated');
    await price({ customerId: CUSTOMER_ID, services: ['PEST'], facts: { stories: 1 } });
    expect(saveSpy.mock.calls[1][0].body.estimateData.engineInputs).toEqual(expect.objectContaining({ stories: 1, storiesSource: 'lookup' }));
  });

  test('a termite perimeter rides services.termite.measurements, only with the termite line', async () => {
    mockState.caps = ['general', 'termite'].map((c) => ({ service_category: c, state: 'qualified' }));
    const res = await price({ customerId: CUSTOMER_ID, services: ['TERMITE_BAIT'], facts: { perimeterLF: 220 } });
    expect(savedInputs().services.termite).toEqual(expect.objectContaining({ measurements: { perimeterLF: 220 } }));
    expect(reasons(res)).toEqual(['changed_fact:perimeterLF']);
    expect(res.body.facts.perimeterLF).toEqual({ value: 220, source: 'technician' });
    expect(savedBody().estimateData.inputs.termitePerimeterLF).toBe('220');
    saveSpy.mockClear();
    const without = await price({ customerId: CUSTOMER_ID, services: ['PEST'], facts: { perimeterLF: 220 } });
    expect(reasons(without)).toEqual([]);
    expect(savedInputs().services.termite).toBeUndefined();
  });

  test('a fact outside sane bounds is a 400', async () => {
    for (const facts of [{ homeSqFt: -5 }, { homeSqFt: 'big' }, { stories: 9 }, { lotSqFt: 12.5 }, { perimeterLF: 5 }]) {
      expect((await price({ customerId: CUSTOMER_ID, services: ['PEST'], facts })).status).toBe(400);
    }
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

describe('POST /price: the answer and the office-first reasons', () => {
  test('one-time over $1,000 holds; exactly $1,000 does not', async () => {
    saveSpy.mockResolvedValueOnce(prepared({ oneTime: 1000.01 }));
    expect(reasons(await price({ customerId: CUSTOMER_ID, services: ['PEST'] }))).toEqual(['one_time_over_limit']);
    saveSpy.mockResolvedValueOnce(prepared({ oneTime: 1000 }));
    expect(reasons(await price({ customerId: CUSTOMER_ID, services: ['PEST'] }))).toEqual([]);
  });

  test.each([
    ['a line that needs manual review', { service: 'pest_control', requiresManualReview: true }],
    ['a low-confidence line', { service: 'pest_control', pricingConfidence: 'LOW' }],
    ['a heuristic-turf line', { service: 'pest_control', turfBasis: 'lotFallback' }],
  ])('%s is office_review', async (_label, line) => {
    saveSpy.mockResolvedValueOnce(prepared({ lines: [line] }));
    expect(reasons(await price({ customerId: CUSTOMER_ID, services: ['PEST'] }))).toEqual(['office_review']);
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
    const res = await price({ customerId: CUSTOMER_ID, services: ['PEST'] });
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
    expect(await price({ customerId: CUSTOMER_ID, services: ['PEST'] })).toEqual({ status: 422, body: OFFICE_REFUSAL });
  });

  test('never a partial quote: a chosen service with no engine line of its own is office_prices', async () => {
    // Two services chosen, the engine answered with the pest line only.
    saveSpy.mockResolvedValueOnce(prepared({ lines: [{ service: 'pest_control', pricingConfidence: 'HIGH' }] }));
    expect(await price({ customerId: CUSTOMER_ID, services: ['PEST', 'MOSQUITO'] })).toEqual({ status: 422, body: OFFICE_REFUSAL });
    saveSpy.mockResolvedValueOnce(prepared({ lines: [{ service: 'pest_control' }, { service: 'mosquito' }] }));
    expect((await price({ customerId: CUSTOMER_ID, services: ['PEST', 'MOSQUITO'] })).status).toBe(200);
  });

  test('a 4xx from the save is office_prices and its own message is never echoed', async () => {
    saveSpy.mockRejectedValueOnce(Object.assign(new Error('Customer 123 has an open move'), { statusCode: 409 }));
    const res = await price({ customerId: CUSTOMER_ID, services: ['PEST'] });
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
    const res = await price({ customerId: CUSTOMER_ID, services: ['PEST'] });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.code).toBeUndefined();
  });

  test('a failed lookup answers 502 without a price', async () => {
    lookupSpy.mockRejectedValueOnce(new Error('provider down'));
    const res = await price({ customerId: CUSTOMER_ID, services: ['PEST'] });
    expect(res.status).toBe(502);
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Step 2a: save the draft

const create = (body) => call('POST', '', { ...body, clientDraftId: DRAFT_ID, digest: DIGEST });
const realSaves = () => saveSpy.mock.calls.filter(([arg]) => !arg.dryRun);
const realSave = () => realSaves()[0][0];
const nothingWritten = () => {
  expect(mockState.inserts).toEqual([]);
  expect(creditSpy).not.toHaveBeenCalled();
  expect(auditSpy).not.toHaveBeenCalled();
};

describe('POST /api/tech/estimates: what the create hands the shared save', () => {
  test('the same save as the preview, not a dry run, on live pricing, tied to the phone\'s digest, inside our transaction', async () => {
    const res = await create({ customerId: CUSTOMER_ID, services: ['PEST', 'MOSQUITO'], ...FORGED_KEYS });
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
    expect(Object.keys(arg.body).sort()).toEqual(['address', 'billByInvoice', 'clientDraftId', 'customerId', 'estimateData', 'showOneTimeOption']);
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
    const res = await call('POST', '', { customerId: CUSTOMER_ID, services: ['PEST'], clientDraftId: DRAFT_ID, digest: DIGEST, ...over });
    expect(res.status).toBe(400);
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    nothingWritten();
  });

  test('the same guards as the preview run first: off-route customer 404, unit address 422, no draft written', async () => {
    expect((await create({ customerId: '00000000-0000-4000-8000-0000000000ff', services: ['PEST'] })).status).toBe(404);
    expect(await create({ customerId: UNIT_CUSTOMER_ID, services: ['PEST'] })).toEqual({ status: 422, body: OFFICE_REFUSAL });
    saveSpy.mockImplementationOnce(async () => prepared({ lines: [] }));
    expect(await create({ customerId: CUSTOMER_ID, services: ['PEST'] })).toEqual({ status: 422, body: OFFICE_REFUSAL });
    expect(realSaves()).toEqual([]);
    nothingWritten();
  });
});

describe('POST /api/tech/estimates: refusals from the save', () => {
  const realSaveRejects = (error) => saveSpy.mockImplementation(async (arg) => { if (arg.dryRun) return prepared(); throw error; });

  test('a changed price is 409 price_changed, and nothing is credited, audited or stored', async () => {
    realSaveRejects(Object.assign(new Error('The estimate price or options changed. Review a fresh estimate before saving.'), { statusCode: 409 }));
    expect(await create({ customerId: CUSTOMER_ID, services: ['PEST'] })).toEqual({
      status: 409, body: { error: 'The price changed. Price it again.', code: 'price_changed' },
    });
    nothingWritten();
  });

  test('any other 4xx from the save is office_prices and its message is never echoed (same id from another login included)', async () => {
    realSaveRejects(Object.assign(new Error('This draft was already saved with different inputs. Customer 123.'), { statusCode: 409 }));
    const res = await create({ customerId: CUSTOMER_ID, services: ['PEST'] });
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
    const res = await create({ customerId: CUSTOMER_ID, services: ['PEST'] });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.code).toBeUndefined();
    nothingWritten();
  });
});

describe('POST /api/tech/estimates: the answer and what is recorded', () => {
  test('the answer is field by field from the stored row: no token, view URL, estimate data or costs', async () => {
    const res = await create({ customerId: CUSTOMER_ID, services: ['PEST'] });
    expect(res.body).toEqual({
      id: ESTIMATE_ID,
      status: 'draft',
      lines: [{ label: 'Pest Control', monthly: 37.33, annual: 448 }, { label: 'WaveGuard setup fee', oneTime: 99 }],
      monthlyTotal: 37.33,
      annualTotal: 448,
      oneTimeTotal: 99,
      facts: expect.any(Object),
      officeFirst: { required: false, reasons: [] },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/token|viewurl|view_url|estimate-secret|estimate_data|margin|cost|drift|client_preview|digest/i);
  });

  test('one tool row with the detailed reasons, one credit, one audit event with ids only', async () => {
    await create({ customerId: CUSTOMER_ID, services: ['PEST'], facts: { homeSqFt: 2600 } });
    expect(mockState.inserts).toHaveLength(1);
    expect(mockState.inserts[0]).toEqual({
      table: 'tech_estimates',
      row: { estimate_id: ESTIMATE_ID, technician_id: 'tech-1', office_first_reasons: JSON.stringify(['changed_fact:homeSqFt']) },
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
    await create({ customerId: CUSTOMER_ID, services: ['PEST'] });
    expect(phoneSpy).not.toHaveBeenCalled();
  });

  test('an admin login is saved and audited but never credited as the seller', async () => {
    mockCaller.role = 'admin';
    const res = await create({ customerId: CUSTOMER_ID, services: ['PEST'] });
    expect(res.status).toBe(200);
    expect(creditSpy).not.toHaveBeenCalled();
    expect(auditSpy).toHaveBeenCalledTimes(1);
  });

  test('a retry: the same estimate and the stored reasons, no second tool row, credit or audit event', async () => {
    saveSpy.mockImplementation(async (arg) => (arg.dryRun ? prepared() : saved({ reused: true })));
    mockState.toolRow = { office_first_reasons: ['one_time_over_limit', 'member_address'] };
    const res = await create({ customerId: CUSTOMER_ID, services: ['PEST'] });
    expect(res.body.id).toBe(ESTIMATE_ID);
    expect(res.body.officeFirst).toEqual({ required: true, reasons: ['one_time_over_limit', 'office_review'] });
    nothingWritten();
  });

  test('an id that is not his tool estimate (reused, but no tool row of his) is refused', async () => {
    saveSpy.mockImplementation(async (arg) => (arg.dryRun ? prepared() : saved({ reused: true })));
    mockState.toolRow = null;
    expect(await create({ customerId: CUSTOMER_ID, services: ['PEST'] })).toEqual({ status: 422, body: OFFICE_REFUSAL });
    nothingWritten();
  });

  test('a lost insert race answers from the winner\'s row', async () => {
    mockState.conflict = true;
    mockState.toolRow = { office_first_reasons: [] };
    const res = await create({ customerId: CUSTOMER_ID, services: ['PEST'] });
    expect(res.status).toBe(200);
    expect(creditSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();
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
  test('admits exactly the five tool routes and nothing else under /api/tech/estimates', () => {
    for (const [method, path] of [
      ['GET', '/api/tech/estimates/setup'], ['POST', '/api/tech/estimates/price'], ['POST', '/api/tech/estimates'],
      ['GET', '/api/tech/estimates'], ['GET', `/api/tech/estimates/${UUID}`],
    ]) {
      expect([method, path, technicianMayReach(method, path)]).toEqual([method, path, true]);
    }
    for (const [method, path] of [
      ['POST', '/api/tech/estimates/setup'], ['GET', '/api/tech/estimates/price'], ['PUT', '/api/tech/estimates/price'],
      ['PUT', '/api/tech/estimates'], ['DELETE', '/api/tech/estimates'], ['PATCH', `/api/tech/estimates/${UUID}`],
      ['PUT', `/api/tech/estimates/${UUID}`], ['DELETE', `/api/tech/estimates/${UUID}`], ['POST', `/api/tech/estimates/${UUID}`],
      ['GET', '/api/tech/estimates/mine'], ['GET', `/api/tech/estimates/${UUID}/send`], ['POST', `/api/tech/estimates/${UUID}/send`],
      ['POST', '/api/tech/estimates/price/extra'], ['GET', '/api/tech/estimates/setup/x'], ['POST', '/api/tech/estimates/send'],
    ]) {
      expect([method, path, technicianMayReach(method, path)]).toEqual([method, path, false]);
    }
  });
});
