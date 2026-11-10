/**
 * Technician estimate tool, step 1, against migrated PostgreSQL (GATE_TECH_ESTIMATES): the real route, the real
 * shared estimate save in dry-run mode and the real pricing engine. Only the paid property lookup is mocked, with
 * a county-confirmed fixture. Every test runs in a transaction that is rolled back. Synthetic names only.
 *
 * Run: DATABASE_URL=postgres://localhost:5432/<migrated disposable db> \
 *   ~/.claude/bin/jest-slot --runInBand server/tests/tech-estimates-postgres.test.js
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(60000);

const mockCaller = { id: null, role: 'technician' };
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
// The route's `db` is the disposable connection of the running test (a rolled-back transaction).
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

postgres('POST /api/tech/estimates/price (migrated PostgreSQL)', () => {
  const { randomUUID } = require('node:crypto');
  const express = require('express');
  const lookupRoutes = require('../routes/property-lookup-v2');
  const { etDateString } = require('../utils/datetime-et');
  const router = require('../routes/tech-estimates');

  let database; let trx; let server; let baseUrl; let ids; let lookupSpy;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    const app = express();
    app.use(express.json());
    app.use('/api/tech/estimates', router);
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    await new Promise((resolve) => {
      server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
    });
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await database?.destroy();
  });

  // A county-confirmed single-family home (synthetic), the shape the lookup cache stores.
  const countyLookup = () => ({
    propertyRecord: {
      propertyType: 'Single Family',
      squareFootage: 1850,
      yearBuilt: 1998,
      stories: 1,
      _source: 'county',
      _parcel: { county: 'Sarasota', parcelId: '0000000001', lotSqft: 9200, landUseDescription: 'SINGLE FAMILY DETACHED' },
      _fieldEvidence: { squareFootage: { sourceType: 'county' } },
    },
    enriched: { propertyType: 'single_family' },
  });

  const customer = async (line1) => {
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Synthetic', last_name: 'Fixture', email: `${id}@example.invalid`, phone: `fixture-${id.slice(0, 8)}`,
      address_line1: line1, city: 'Test City', state: 'FL', zip: '00000', active: true, pipeline_stage: 'active_customer',
    });
    return id;
  };

  beforeEach(async () => {
    process.env.GATE_TECH_ESTIMATES = 'true';
    trx = await database.transaction();
    require('../models/db').connection = trx;
    const technicianId = randomUUID();
    await trx('technicians').insert({
      id: technicianId, name: 'Synthetic Tech', email: `${technicianId}@example.invalid`, role: 'technician',
      active: true, employment_status: 'active', can_create_estimates: true,
    });
    await trx('technician_capabilities').insert({
      technician_id: technicianId, service_category: 'general', capability_level: 'qualified', active: true, source: 'admin',
    });
    const routeCustomer = await customer('100 Test Lane');
    const otherCustomer = await customer('200 Test Lane');
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: routeCustomer, technician_id: technicianId, service_type: 'Quarterly Pest Control',
      status: 'pending', scheduled_date: etDateString(new Date()), window_start: '09:00', window_end: '10:00',
      estimated_duration_minutes: 30,
    });
    ids = { technicianId, routeCustomer, otherCustomer };
    mockCaller.id = technicianId;
    mockCaller.role = 'technician';
    lookupSpy = jest.spyOn(lookupRoutes, 'performPropertyLookup').mockImplementation(async () => countyLookup());
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    delete process.env.GATE_TECH_ESTIMATES;
    require('../models/db').connection = undefined;
    if (trx) await trx.rollback();
  });

  async function price(body) {
    const res = await fetch(`${baseUrl}/api/tech/estimates/price`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  // What a price preview must not change: every table the estimate save or its follow-ups could touch.
  const counts = async () => Object.fromEntries(await Promise.all(
    ['estimates', 'audit_log', 'activity_log', 'leads', 'customers', 'scheduled_services'].map(async (t) => [t, Number((await trx(t).count('* as n').first()).n)]),
  ));

  test('a technician with the switch on and a qualified general capability prices PEST for a customer on his route, and nothing is saved', async () => {
    const before = await counts();
    const res = await price({ customerId: ids.routeCustomer, services: ['PEST'] });
    expect(res.status).toBe(200);
    expect(res.body.monthlyTotal).toBeGreaterThan(0);
    expect(res.body.annualTotal).toBeGreaterThan(0);
    expect(res.body.lines.length).toBeGreaterThan(0);
    expect(res.body.facts.homeSqFt).toEqual({ value: 1850, source: 'lookup' });
    expect(JSON.stringify(res.body)).not.toMatch(/token|viewurl|estimate_?id|estimate_data|margin/i);
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(await counts()).toEqual(before);
  });

  test('every forged pricing key from the phone changes no number', async () => {
    const clean = await price({ customerId: ids.routeCustomer, services: ['PEST'] });
    const forged = await price({
      customerId: ids.routeCustomer,
      services: ['PEST'],
      manualDiscount: { type: 'PERCENT', value: 50, internalReason: 'x' },
      linePriceOverrides: { PEST: 1 },
      serviceSpecificDiscounts: [{ key: 'x', value: 10 }],
      operatorPriceAdjustment: { type: 'FIXED', value: 100, waiveSetupFee: true },
      moveId: randomUUID(),
      profile: { homeSqFt: 400, lotSqFt: 600 },
      options: { manualDiscount: { type: 'FIXED', value: 99 }, recurringCustomer: true, pestFreq: 12 },
      estimateData: { engineInputs: { services: { lawn: { tier: 'enhanced' } } }, inputs: { svcLawn: true } },
      engineInputs: { homeSqFt: 400 },
      customerEmail: 'forged@example.invalid',
      clientDraftId: randomUUID(),
      leadId: randomUUID(),
      groupWithEstimateId: randomUUID(),
      monthlyTotal: 1,
    });
    expect(forged).toEqual(clean);
    expect(clean.body.monthlyTotal).toBeGreaterThan(30);
  });

  test('a typed home size changes the price and sends the quote to the office first', async () => {
    const base = await price({ customerId: ids.routeCustomer, services: ['PEST'] });
    const edited = await price({ customerId: ids.routeCustomer, services: ['PEST'], facts: { homeSqFt: 4200, stories: 2 } });
    expect(edited.status).toBe(200);
    expect(edited.body.officeFirst.reasons).toEqual(expect.arrayContaining(['changed_fact:homeSqFt', 'changed_fact:stories']));
    expect(edited.body.annualTotal).not.toBe(base.body.annualTotal);
  });

  test('a new person is priced on the typed address (no customer row is read or written)', async () => {
    const before = await counts();
    const res = await price({
      prospect: { firstName: 'Sample', lastName: 'Person', phone: '(941) 555-0142', address: '300 Test Lane', city: 'Test City', zip: '00000' },
      services: ['PEST'],
    });
    expect(res.status).toBe(200);
    expect(res.body.monthlyTotal).toBeGreaterThan(0);
    expect(await counts()).toEqual(before);
  });

  test('an off-route customer is a 404 and nothing is looked up', async () => {
    const res = await price({ customerId: ids.otherCustomer, services: ['PEST'] });
    expect(res).toEqual({ status: 404, body: { error: 'Customer not found' } });
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  test('gate off, and the technician\'s switch off, are both 404 {enabled:false}', async () => {
    delete process.env.GATE_TECH_ESTIMATES;
    expect(await price({ customerId: ids.routeCustomer, services: ['PEST'] })).toEqual({ status: 404, body: { enabled: false } });
    process.env.GATE_TECH_ESTIMATES = 'true';
    await trx('technicians').where({ id: ids.technicianId }).update({ can_create_estimates: false });
    expect(await price({ customerId: ids.routeCustomer, services: ['PEST'] })).toEqual({ status: 404, body: { enabled: false } });
    expect(lookupSpy).not.toHaveBeenCalled();
  });
});
