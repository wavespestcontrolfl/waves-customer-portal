/**
 * Technician estimate tool, steps 1 and 2a, against migrated PostgreSQL (GATE_TECH_ESTIMATES): the real route, the real
 * shared estimate save (dry run for the preview, a real save for the create) and the real pricing engine. Only the paid property lookup is mocked, with
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

postgres('the technician estimate tool (migrated PostgreSQL)', () => {
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
  async function create(body) {
    const res = await fetch(`${baseUrl}/api/tech/estimates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  async function read(path) {
    const res = await fetch(`${baseUrl}/api/tech/estimates${path}`);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }
  // The phone's two steps: price it, then save that price with a retry key.
  async function priceThenCreate(body, over = {}) {
    const preview = await price(body);
    const saved = await create({ ...body, clientDraftId: randomUUID(), digest: preview.body.digest, ...over });
    return { preview, saved };
  }
  const PROSPECT = { firstName: 'Sample', lastName: 'Person', phone: '(941) 555-0142', address: '300 Test Lane', city: 'Test City', zip: '00000' };
  const estimateRow = (id) => trx('estimates').where({ id }).first();
  // What a price preview must not change: every table the estimate save or its follow-ups could touch.
  const counts = async () => Object.fromEntries(await Promise.all(
    ['estimates', 'tech_estimates', 'audit_log', 'activity_log', 'leads', 'customers', 'scheduled_services'].map(async (t) => [t, Number((await trx(t).count('* as n').first()).n)]),
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

  test('each of the six services comes back as its own priced engine line (an admin may quote all six)', async () => {
    mockCaller.role = 'admin';
    for (const key of ['PEST', 'OT_PEST', 'MOSQUITO', 'OT_MOSQUITO', 'RODENT_BAIT', 'TERMITE_BAIT']) {
      const res = await price({ customerId: ids.routeCustomer, services: [key] });
      expect([key, res.status]).toEqual([key, 200]);
      expect(res.body.lines.length).toBeGreaterThan(0);
      expect(res.body.monthlyTotal + res.body.oneTimeTotal).toBeGreaterThan(0);
    }
    // All six together: still one whole quote.
    const all = await price({ customerId: ids.routeCustomer, services: ['PEST', 'OT_PEST', 'MOSQUITO', 'OT_MOSQUITO', 'RODENT_BAIT', 'TERMITE_BAIT'] });
    expect(all.status).toBe(200);
    expect(all.body.lines.length).toBeGreaterThanOrEqual(6);
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

  describe('save a draft and read his own', () => {
    test('price, then create with the digest: one draft, one tool row, one audit event, at the previewed price', async () => {
      const before = await counts();
      const { preview, saved } = await priceThenCreate({ customerId: ids.routeCustomer, services: ['PEST'] });
      expect(preview.body.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(saved.status).toBe(200);
      const after = await counts();
      expect(after.estimates).toBe(before.estimates + 1);
      expect(after.tech_estimates).toBe(before.tech_estimates + 1);
      expect(after.audit_log).toBe(before.audit_log + 1);
      expect(after.leads).toBe(before.leads);
      expect(after.customers).toBe(before.customers);
      expect(after.scheduled_services).toBe(before.scheduled_services);
      const row = await estimateRow(saved.body.id);
      expect(row).toEqual(expect.objectContaining({
        status: 'draft', created_by_technician_id: ids.technicianId, pricing_authority: 'SERVER', customer_id: ids.routeCustomer,
      }));
      expect(Number(row.monthly_total)).toBe(preview.body.monthlyTotal);
      expect(Number(row.annual_total)).toBe(preview.body.annualTotal);
      expect(Number(row.onetime_total)).toBe(preview.body.oneTimeTotal);
      expect(saved.body).toEqual({
        id: row.id, status: 'draft', lines: preview.body.lines, monthlyTotal: preview.body.monthlyTotal, annualTotal: preview.body.annualTotal,
        oneTimeTotal: preview.body.oneTimeTotal, facts: preview.body.facts, officeFirst: preview.body.officeFirst,
      });
      expect(JSON.stringify(saved.body)).not.toContain(row.token);
      expect(await trx('tech_estimates').where({ estimate_id: row.id }).first()).toEqual(expect.objectContaining({
        technician_id: ids.technicianId, office_first_reasons: [],
      }));
      const events = await trx('audit_log').where({ action: 'tech_estimate.created', resource_id: row.id });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(expect.objectContaining({ actor_type: 'technician', actor_id: ids.technicianId, resource_type: 'estimates' }));
      expect(Object.keys(events[0].metadata).sort()).toEqual(['customer_id', 'estimate_id', 'office_first', 'technician_id']);
    });

    test('a retry with the same draft id writes nothing more and answers the same estimate', async () => {
      const body = { customerId: ids.routeCustomer, services: ['PEST'] };
      const { preview, saved } = await priceThenCreate(body);
      const afterFirst = await counts();
      const again = await create({ ...body, clientDraftId: saved.body.id, digest: preview.body.digest });
      expect(again.status).toBe(200);
      expect(again.body).toEqual(saved.body);
      expect(await counts()).toEqual(afterFirst);
    });

    test('the same draft id from another login is refused and writes nothing', async () => {
      const body = { customerId: ids.routeCustomer, services: ['PEST'] };
      const { preview, saved } = await priceThenCreate(body);
      const afterFirst = await counts();
      const otherId = randomUUID();
      await trx('technicians').insert({ id: otherId, name: 'Synthetic Other', email: `${otherId}@example.invalid`, role: 'technician', active: true, employment_status: 'active', can_create_estimates: true });
      mockCaller.id = otherId;
      mockCaller.role = 'admin';
      const stolen = await create({ ...body, clientDraftId: saved.body.id, digest: preview.body.digest });
      expect(stolen).toEqual({ status: 422, body: { error: 'The office needs to price this one.', code: 'office_prices' } });
      expect(await counts()).toEqual(afterFirst);
    });

    test('a digest that is not the current price is 409 price_changed and writes nothing', async () => {
      const before = await counts();
      const { saved } = await priceThenCreate({ customerId: ids.routeCustomer, services: ['PEST'] }, { digest: 'b'.repeat(64) });
      expect(saved).toEqual({ status: 409, body: { error: 'The price changed. Price it again.', code: 'price_changed' } });
      expect(await counts()).toEqual(before);
    });

    test('a typed fact is priced, stored as a detailed reason, and shown to the phone as the same code', async () => {
      const { saved } = await priceThenCreate({ customerId: ids.routeCustomer, services: ['PEST'], facts: { homeSqFt: 4200, stories: 2 } });
      expect(saved.status).toBe(200);
      expect(saved.body.officeFirst).toEqual({ required: true, reasons: ['changed_fact:homeSqFt', 'changed_fact:stories'] });
      expect((await trx('tech_estimates').where({ estimate_id: saved.body.id }).first()).office_first_reasons)
        .toEqual(['changed_fact:homeSqFt', 'changed_fact:stories']);
    });

    test('Sold by = the creator for an active W-2 technician', async () => {
      await trx('technicians').where({ id: ids.technicianId }).update({ employment_type: 'w2' });
      const { saved } = await priceThenCreate({ customerId: ids.routeCustomer, services: ['PEST'] });
      const row = await estimateRow(saved.body.id);
      expect(row).toEqual(expect.objectContaining({ sold_by_technician_id: ids.technicianId, sold_by_source: 'creator', sold_by_lead_id: null }));
      expect(row.sold_by_set_at).toBeInstanceOf(Date);
    });

    test.each([
      ['a 1099 technician', { employment_type: '1099' }, 'technician'],
      ['an inactive W-2 technician', { employment_type: 'w2', active: false }, 'technician'],
      ['a technician with no employment type', {}, 'technician'],
      ['an admin login, even on a W-2 technician row', { employment_type: 'w2' }, 'admin'],
    ])('%s gets no Sold by', async (_label, patch, role) => {
      if (Object.keys(patch).length) await trx('technicians').where({ id: ids.technicianId }).update(patch);
      mockCaller.role = role;
      const { saved } = await priceThenCreate({ customerId: ids.routeCustomer, services: ['PEST'] });
      expect(saved.status).toBe(200);
      expect(await estimateRow(saved.body.id)).toEqual(expect.objectContaining({ sold_by_technician_id: null, sold_by_source: null }));
    });

    test('the list and the read show his own estimates only', async () => {
      const mine = await priceThenCreate({ customerId: ids.routeCustomer, services: ['PEST'] });
      const otherId = randomUUID();
      await trx('technicians').insert({ id: otherId, name: 'Synthetic Other', email: `${otherId}@example.invalid`, role: 'technician', active: true, employment_status: 'active', can_create_estimates: true });
      await trx('technician_capabilities').insert({ technician_id: otherId, service_category: 'general', capability_level: 'qualified', active: true, source: 'admin' });
      mockCaller.id = otherId;
      const theirs = await priceThenCreate({ prospect: PROSPECT, services: ['PEST'] });
      expect(theirs.saved.status).toBe(200);
      mockCaller.id = ids.technicianId;

      const list = await read('');
      expect(list.status).toBe(200);
      expect(list.body.estimates.map((e) => e.id)).toEqual([mine.saved.body.id]);
      expect(list.body.estimates[0]).toEqual(expect.objectContaining({
        status: 'draft', sentAt: null, acceptedAt: null, who: 'Synthetic Fixture', addressLine: '100 Test Lane',
        monthlyTotal: mine.saved.body.monthlyTotal, officeFirst: { required: false, reasons: [] },
      }));
      expect(JSON.stringify(list.body)).not.toMatch(/token|estimate_data|margin/i);

      const one = await read(`/${mine.saved.body.id}`);
      expect(one.body.lines).toEqual(mine.saved.body.lines);
      expect(await read(`/${theirs.saved.body.id}`)).toEqual(await read(`/${randomUUID()}`));
      expect((await read(`/${theirs.saved.body.id}`)).status).toBe(404);
      // A new person's own list row names him.
      mockCaller.id = otherId;
      expect((await read('')).body.estimates[0]).toEqual(expect.objectContaining({ who: 'Sample Person', addressLine: '300 Test Lane' }));
    });

    test('an archived estimate is left out of his list', async () => {
      const { saved } = await priceThenCreate({ customerId: ids.routeCustomer, services: ['PEST'] });
      await trx('estimates').where({ id: saved.body.id }).update({ archived_at: new Date() });
      expect((await read('')).body.estimates).toEqual([]);
      expect((await read(`/${saved.body.id}`)).status).toBe(404);
    });

    test('a new person whose phone is a customer\'s goes to the office first, and the phone sees only office_review', async () => {
      await trx('customers').where({ id: ids.otherCustomer }).update({ phone: '+19415550142' });
      const { preview, saved } = await priceThenCreate({ prospect: PROSPECT, services: ['PEST'] });
      // The preview already shows the verdict the save stores.
      expect(preview.body.officeFirst).toEqual({ required: true, reasons: ['office_review'] });
      expect(saved.body.officeFirst).toEqual({ required: true, reasons: ['office_review'] });
      expect((await trx('tech_estimates').where({ estimate_id: saved.body.id }).first()).office_first_reasons).toEqual(['phone_matches_customer']);
    });
  });

  describe('the two migrations', () => {
    const techEstimates = require('../models/migrations/20261109130000_tech_estimates');
    const soldByCreator = require('../models/migrations/20261109130100_sold_by_creator');
    // A refused statement aborts a transaction: run it in a savepoint and report whether it was refused.
    const refused = async (work) => {
      try { await trx.transaction(work); return false; } catch { return true; }
    };

    test('tech_estimates goes down and up (both are guarded no-ops when repeated)', async () => {
      await techEstimates.up(trx);
      await techEstimates.down(trx);
      expect(await trx.schema.hasTable('tech_estimates')).toBe(false);
      await techEstimates.down(trx);
      await techEstimates.up(trx);
      expect(await trx.schema.hasTable('tech_estimates')).toBe(true);
      const { rows } = await trx.raw("SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_tech_estimates_technician_created'");
      expect(rows[0].indexdef).toMatch(/technician_id, created_at DESC/);
    });

    test('the Sold by down refuses while a creator row exists, restores the old two checks without one, and up widens again', async () => {
      const estimateId = randomUUID();
      await trx('estimates').insert({ id: estimateId, token: randomUUID().replaceAll('-', ''), customer_name: 'Synthetic Fixture', status: 'draft', sold_by_technician_id: ids.technicianId, sold_by_source: 'creator' });
      await expect(soldByCreator.down(trx)).rejects.toThrow(/Sold by = creator/);
      await trx('estimates').where({ id: estimateId }).update({ sold_by_technician_id: null, sold_by_source: null });
      await soldByCreator.down(trx);
      expect(await refused((sp) => sp('estimates').where({ id: estimateId }).update({ sold_by_technician_id: ids.technicianId, sold_by_source: 'creator' }))).toBe(true);
      expect(await refused((sp) => sp('estimates').where({ id: estimateId }).update({ sold_by_technician_id: ids.technicianId, sold_by_source: 'office' }))).toBe(false);
      await trx('estimates').where({ id: estimateId }).update({ sold_by_technician_id: null, sold_by_source: null });
      await soldByCreator.up(trx);
      await soldByCreator.up(trx);
      expect(await refused((sp) => sp('estimates').where({ id: estimateId }).update({ sold_by_technician_id: ids.technicianId, sold_by_source: 'creator' }))).toBe(false);
      // creator needs a seller; the other values keep their rules
      expect(await refused((sp) => sp('estimates').where({ id: estimateId }).update({ sold_by_technician_id: null, sold_by_source: 'creator' }))).toBe(true);
      expect(await refused((sp) => sp('estimates').where({ id: estimateId }).update({ sold_by_technician_id: ids.technicianId, sold_by_source: 'cleared' }))).toBe(true);
      expect(await refused((sp) => sp('estimates').where({ id: estimateId }).update({ sold_by_technician_id: ids.technicianId, sold_by_source: 'nobody' }))).toBe(true);
    });
  });
});
