/**
 * Technician estimate tool, step 1 (GATE_TECH_ESTIMATES): setup + list-price preview, nothing saved.
 * Synthetic people and addresses only. The property lookup, the pricing-constants sync and the
 * customer evidence are mocked (no paid call, no database); the pricing engine itself is real.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

const mockCaller = { id: 'tech-1', role: 'technician' };
const mockState = { switchOn: true, queries: [], writes: [], customers: [], onRoute: new Set(), caps: [] };

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
    const builder = {
      _id: null,
      where(w) { if (w && typeof w === 'object' && w.id) builder._id = w.id; return builder; },
      select() { return builder; },
      limit() { return builder; },
      async first() {
        if (table === 'technicians') return { can_create_estimates: mockState.switchOn };
        if (table === 'customers') return mockState.customers.find((c) => c.id === builder._id);
        return undefined;
      },
      then(resolve, reject) { return Promise.resolve(table === 'customers' ? mockState.customers : []).then(resolve, reject); },
      insert() { mockState.writes.push(table); return builder; },
      update() { mockState.writes.push(table); return builder; },
    };
    return builder;
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
jest.mock('../services/waveguard-existing-services', () => ({
  ...jest.requireActual('../services/waveguard-existing-services'),
  resolveCustomerQualifyingEvidence: jest.fn(async () => ({ tierKeys: ['pest'], setupWaiverKeys: [] })),
  isActivePlanCustomer: jest.fn(async () => true),
}));
// The pricing constants come from the code, never from the database.
jest.mock('../services/pricing-engine', () => ({
  ...jest.requireActual('../services/pricing-engine'),
  needsSync: () => false,
  syncConstantsFromDB: jest.fn(),
}));

const express = require('express');
const lookupRoutes = require('../routes/property-lookup-v2');
const persistence = require('../services/admin-estimate-persistence');
const { technicianMayReach } = require('../middleware/technician-scope');
const router = require('../routes/tech-estimates');

const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
const OFF_ROUTE_ID = '00000000-0000-4000-8000-0000000000c2';
const LOOKUP = {
  homeSqFt: 2000, lotSqFt: 9000, stories: 1, propertyType: 'single_family', footprintSqFt: 1800,
  pool: 'NO', poolCage: 'NO', shrubDensity: 'MODERATE', treeDensity: 'MODERATE', landscapeComplexity: 'MODERATE',
};
const PROSPECT = { firstName: 'Sample', lastName: 'Person', phone: '(941) 555-0142', address: '200 Example Ave', city: 'Sampletown', zip: '34202' };

let server; let baseUrl; let lookupSpy; let recomputeSpy;
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
    onRoute: new Set([CUSTOMER_ID]),
    caps: [
      { service_category: 'general', state: 'qualified' }, { service_category: 'mosquito', state: 'qualified' },
      { service_category: 'rodent', state: 'review_required' }, { service_category: 'termite', state: 'off' },
      { service_category: 'lawn', state: 'qualified' },
    ],
    customers: [
      { id: CUSTOMER_ID, address_line1: '100 Sample St', address_line2: null, city: 'Sampletown', state: 'FL', zip: '34202' },
      { id: OFF_ROUTE_ID, address_line1: '200 Example Ave', address_line2: null, city: 'Sampletown', state: 'FL', zip: '34202' },
    ],
  });
  lookupSpy = jest.spyOn(lookupRoutes, 'performPropertyLookup').mockImplementation(async () => ({ enriched: { ...LOOKUP } }));
  recomputeSpy = jest.spyOn(persistence, 'serverRecomputeFromEstimateData');
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
const sentRequest = () => recomputeSpy.mock.calls[0][0].engineRequest;
const fakeRecompute = (onetimeTotal, lineItems = []) => ({
  recomputed: true,
  serverResult: { recurring: { services: [] }, oneTime: { items: [], specItems: [] } },
  serverTotals: { monthlyTotal: 0, annualTotal: 0, onetimeTotal },
  rawEngineResult: { lineItems },
});

describe('the guard', () => {
  test.each([['GET', '/setup'], ['POST', '/price']])('gate off: %s %s answers 404 {enabled:false} before any read', async (method, path) => {
    delete process.env.GATE_TECH_ESTIMATES;
    const res = await call(method, path, method === 'POST' ? { customerId: CUSTOMER_ID, services: ['PEST'] } : undefined);
    expect(res).toEqual({ status: 404, body: { enabled: false } });
    expect(mockState.queries).toEqual([]);
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test.each([['GET', '/setup'], ['POST', '/price']])('technician switch off: %s %s answers 404 before any customer read', async (method, path) => {
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

describe('POST /price: who and which services', () => {
  test('a customer who is not on his route is a 404, the same as an unknown id, and nothing is looked up', async () => {
    for (const customerId of [OFF_ROUTE_ID, '00000000-0000-4000-8000-0000000000ff']) {
      const res = await price({ customerId, services: ['PEST'] });
      expect(res).toEqual({ status: 404, body: { error: 'Customer not found' } });
    }
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(recomputeSpy).not.toHaveBeenCalled();
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

  test('a new person is priced on the typed address through the declared lookup caller', async () => {
    const res = await price({ prospect: PROSPECT, services: ['PEST'] });
    expect(res.status).toBe(200);
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(lookupSpy.mock.calls[0][0]).toBe('200 Example Ave, Sampletown, FL 34202');
    expect(lookupSpy.mock.calls[0][1]).toEqual({ prioritizeAccuracy: true });
    expect(sentRequest().options.existingCustomerId).toBeUndefined();
  });
});

describe('POST /price: list price only', () => {
  const KNOBS = {
    manualDiscount: { type: 'PERCENT', value: 50 },
    linePriceOverrides: { PEST: 1 },
    serviceSpecificDiscounts: [{ key: 'x', value: 10 }],
    operatorPriceAdjustment: { type: 'FIXED', value: 100, waiveSetupFee: true },
    moveId: '00000000-0000-4000-8000-0000000000aa',
    waiveSetupFee: true,
    profile: { homeSqFt: 100, lotSqFt: 100, footprint: 100 },
    options: { manualDiscount: { type: 'FIXED', value: 99 }, recurringCustomer: true, pestFreq: 12, initialRoachPriceOverride: 1, priorQualifyingServices: ['lawn'] },
    estimateData: { operatorPriceAdjustment: { value: 90 } },
  };

  test('every pricing knob from the phone is ignored; the request is server-built and the price is the list price', async () => {
    const clean = await price({ customerId: CUSTOMER_ID, services: ['PEST'] });
    recomputeSpy.mockClear();
    const sent = await price({ customerId: CUSTOMER_ID, services: ['PEST'], ...KNOBS });
    expect(sent).toEqual(clean);
    expect(clean.body.monthlyTotal).toBeGreaterThan(0);
    const request = sentRequest();
    expect(Object.keys(request).sort()).toEqual(['options', 'profile', 'selectedServices']);
    expect(Object.keys(request.options).sort()).toEqual([
      'address', 'existingCustomerId', 'mosquitoProgram', 'pestFreq', 'termiteBaitSystem',
      'termiteMonitoringTier', 'termiteOwnership', 'termiteScope',
    ]);
    expect(request.options).toEqual(expect.objectContaining({ pestFreq: 4, existingCustomerId: CUSTOMER_ID, address: '100 Sample St, Sampletown, FL 34202' }));
    expect(request.profile.homeSqFt).toBe(2000);
    expect(request.selectedServices).toEqual(['PEST']);
    expect(JSON.stringify(recomputeSpy.mock.calls[0][0])).not.toMatch(/manualDiscount|linePriceOverrides|serviceSpecific|operatorPriceAdjustment|moveId|waiveSetupFee|dethatch|areaAddOn/i);
    expect(recomputeSpy.mock.calls[0][1]).toEqual({
      priorQualifyingServices: ['pest'], setupWaiverPriorQualifyingServices: [], recurringCustomer: true,
    });
  });

  test('a response carries no token, view link or estimate id, and nothing is written', async () => {
    const res = await price({ customerId: CUSTOMER_ID, services: ['PEST', 'MOSQUITO'] });
    expect(Object.keys(res.body).sort()).toEqual(['annualTotal', 'facts', 'lines', 'monthlyTotal', 'officeFirst', 'oneTimeTotal']);
    expect(JSON.stringify(res.body)).not.toMatch(/token|viewurl|estimate_?id|margin|cost/i);
    expect(res.body.lines.map((l) => l.label)).toEqual(expect.arrayContaining(['Pest Control', 'Mosquito']));
    expect(mockState.writes).toEqual([]);
  });
});

describe('POST /price: measured facts and the office-first verdict', () => {
  test('a fact equal to the lookup is not a change; unknown fact keys are ignored', async () => {
    const res = await price({ customerId: CUSTOMER_ID, services: ['PEST'], facts: { homeSqFt: 2000, color: 'red', discount: 5 } });
    expect(res.body.officeFirst).toEqual({ required: false, reasons: [] });
    expect(res.body.facts.homeSqFt).toEqual({ value: 2000, source: 'lookup' });
  });

  test('a changed measured fact is priced on the edited value and sent to the office first', async () => {
    const base = await price({ customerId: CUSTOMER_ID, services: ['PEST'] });
    recomputeSpy.mockClear();
    const res = await price({ customerId: CUSTOMER_ID, services: ['PEST'], facts: { homeSqFt: 3400, stories: 2 } });
    expect(res.body.officeFirst).toEqual({ required: true, reasons: ['changed_fact:homeSqFt', 'changed_fact:stories'] });
    expect(res.body.facts.homeSqFt).toEqual({ value: 3400, source: 'technician' });
    expect(res.body.facts.lotSqFt).toEqual({ value: 9000, source: 'lookup' });
    expect(sentRequest().profile).toEqual(expect.objectContaining({ homeSqFt: 3400, stories: 2, footprint: 1700, storiesSource: 'manual' }));
    expect(res.body.monthlyTotal).not.toBe(base.body.monthlyTotal);
  });

  test('a fact outside sane bounds is a 400', async () => {
    for (const facts of [{ homeSqFt: -5 }, { homeSqFt: 'big' }, { stories: 9 }, { lotSqFt: 12.5 }]) {
      expect((await price({ customerId: CUSTOMER_ID, services: ['PEST'], facts })).status).toBe(400);
    }
  });

  test('one-time over $1,000 holds; exactly $1,000 does not', async () => {
    recomputeSpy.mockResolvedValueOnce(fakeRecompute(1000.01));
    expect((await price({ customerId: CUSTOMER_ID, services: ['PEST'] })).body.officeFirst).toEqual({ required: true, reasons: ['one_time_over_limit'] });
    recomputeSpy.mockResolvedValueOnce(fakeRecompute(1000));
    expect((await price({ customerId: CUSTOMER_ID, services: ['PEST'] })).body.officeFirst).toEqual({ required: false, reasons: [] });
  });

  test('a commercial property or a custom-quote line needs office pricing', async () => {
    lookupSpy.mockImplementation(async () => ({ enriched: { ...LOOKUP, propertyType: 'commercial', isCommercial: true } }));
    expect((await price({ customerId: CUSTOMER_ID, services: ['PEST'] })).body.officeFirst.reasons).toContain('needs_office_pricing');
    lookupSpy.mockImplementation(async () => ({ enriched: { ...LOOKUP } }));
    recomputeSpy.mockResolvedValueOnce(fakeRecompute(0, [{ service: 'pest_control', requiresCustomQuote: true }]));
    expect((await price({ customerId: CUSTOMER_ID, services: ['PEST'] })).body.officeFirst.reasons).toEqual(['needs_office_pricing']);
  });

  test('a typed address that is a customer off his route goes to the office; his own customer or an admin does not', async () => {
    const typed = { ...PROSPECT, address: '200 Example Avenue' };
    expect((await price({ prospect: typed, services: ['PEST'] })).body.officeFirst).toEqual({ required: true, reasons: ['office_review_address'] });
    mockState.onRoute.add(OFF_ROUTE_ID);
    expect((await price({ prospect: typed, services: ['PEST'] })).body.officeFirst.required).toBe(false);
    mockState.onRoute.delete(OFF_ROUTE_ID);
    mockCaller.role = 'admin';
    expect((await price({ prospect: typed, services: ['PEST'] })).body.officeFirst.required).toBe(false);
  });
});

describe('POST /price: refusals store nothing', () => {
  test('an engine that cannot price answers 422 and nothing is written', async () => {
    recomputeSpy.mockResolvedValueOnce({ recomputed: false, reason: 'ENGINE_ERROR' });
    const res = await price({ customerId: CUSTOMER_ID, services: ['PEST'] });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body)).toEqual(['error']);
    expect(mockState.writes).toEqual([]);
  });

  test('a failed lookup answers 502 without a price', async () => {
    lookupSpy.mockRejectedValueOnce(new Error('provider down'));
    const res = await price({ customerId: CUSTOMER_ID, services: ['PEST'] });
    expect(res.status).toBe(502);
    expect(recomputeSpy).not.toHaveBeenCalled();
  });
});

describe('the technician allow-list', () => {
  test('admits exactly the two tool routes and nothing else under /api/tech/estimates', () => {
    expect(technicianMayReach('GET', '/api/tech/estimates/setup')).toBe(true);
    expect(technicianMayReach('POST', '/api/tech/estimates/price')).toBe(true);
    for (const [method, path] of [
      ['POST', '/api/tech/estimates/setup'], ['GET', '/api/tech/estimates/price'], ['PUT', '/api/tech/estimates/price'],
      ['GET', '/api/tech/estimates'], ['POST', '/api/tech/estimates'], ['GET', '/api/tech/estimates/mine'],
      ['POST', '/api/tech/estimates/price/extra'], ['GET', '/api/tech/estimates/setup/x'], ['POST', '/api/tech/estimates/send'],
    ]) {
      expect(technicianMayReach(method, path)).toBe(false);
    }
  });
});
