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
    req.technician = { id: mockCaller.id, role: mockCaller.role, name: 'Synthetic Tech' };
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

// Step 4: the provider layer. Nothing leaves the machine: the text provider is a stub, the short link is a pass-through, and the
// follow-up enrolment is a stub. The shared sender, claim, schema and bell are real.
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/short-url', () => ({ ...jest.requireActual('../services/short-url'), shortenOrPassthrough: jest.fn(async (url) => url) }));
jest.mock('../services/automation-runner', () => ({ ...jest.requireActual('../services/automation-runner'), enrollCustomer: jest.fn(async () => null) }));

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

  describe('the office bell for a held estimate', () => {
    const bells = (estimateId) => trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`tech-estimate-office-first:${estimateId}`]);
    const HELD = () => ({ customerId: ids.routeCustomer, services: ['PEST'], facts: { homeSqFt: 4200, stories: 2 } });

    test('a held create writes one open bell row for the estimate; a quote he may send himself writes none', async () => {
      const clean = await priceThenCreate({ customerId: ids.routeCustomer, services: ['PEST'] });
      expect(clean.saved.body.officeFirst.required).toBe(false);
      expect(await bells(clean.saved.body.id)).toEqual([]);

      const { saved } = await priceThenCreate(HELD());
      expect(saved.status).toBe(200);
      const rows = await bells(saved.body.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({
        category: 'estimate', title: 'Estimates — check Synthetic\'s estimate for Synthetic Fixture',
        body: 'The technician changed the home size, so it waits for your check before it goes.',
        link: `/admin/estimates?estimateId=${saved.body.id}`, done_at: null,
      }));
      expect(rows[0].metadata).toEqual(expect.objectContaining({
        area: 'Estimates', severity: 'needs-you', who: 'person', doneWhen: 'estimate_sent_or_closed', estimateId: saved.body.id,
        subject: { type: 'estimate', id: saved.body.id }, technicianId: ids.technicianId,
      }));
      expect(JSON.stringify(saved.body)).not.toMatch(/waits for your check|notification/i);
    });

    test('a retry, and a second raise for the same estimate, add no row (even after the row is closed)', async () => {
      const body = HELD();
      const { preview, saved } = await priceThenCreate(body);
      const again = await create({ ...body, clientDraftId: saved.body.id, digest: preview.body.digest });
      expect(again.status).toBe(200);
      expect(await bells(saved.body.id)).toHaveLength(1);

      const { ringOfficeFirst } = require('../services/tech-estimate-office-bell');
      const estimate = await estimateRow(saved.body.id);
      const raise = () => ringOfficeFirst({ estimate, detailed: ['changed_fact:homeSqFt'], technician: { id: ids.technicianId, name: 'Synthetic Tech' } });
      await raise();
      expect(await bells(saved.body.id)).toHaveLength(1);
      // A closed row still holds the key: the estimate never rings twice.
      await bells(saved.body.id).update({ done_at: new Date(), done_by: 'test', resolution: 'done' });
      await raise();
      expect(await bells(saved.body.id)).toHaveLength(1);
    });

    test.each([
      ['sent', { status: 'sent', sent_at: new Date() }, 'Estimate was sent'],
      ['archived', { archived_at: new Date() }, 'Estimate was archived'],
    ])('the row closes itself when the estimate is %s (the real sweep, the real predicate)', async (_label, patch, resolution) => {
      const { saved } = await priceThenCreate(HELD());
      const { runAdminAlertRelevanceSweep } = require('../services/admin-alert-relevance');
      // Still a draft: the sweep leaves it open.
      await runAdminAlertRelevanceSweep();
      expect((await bells(saved.body.id))[0].done_at).toBeNull();
      await trx('estimates').where({ id: saved.body.id }).update(patch);
      await runAdminAlertRelevanceSweep();
      const [row] = await bells(saved.body.id);
      expect(row).toEqual(expect.objectContaining({ done_by: 'relevance', resolution }));
      expect(row.done_at).toBeInstanceOf(Date);
    });
  });

  describe('send from the phone (the real shared sender, a stubbed provider)', () => {
    const sendTool = require('../services/tech-estimate-send');
    const ownerAlerts = require('../services/owner-alerts');
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    const INSIDE = new Date('2026-03-10T15:00:00.000Z'); // 11:00 AM ET
    const OUTSIDE = new Date('2026-03-10T03:00:00.000Z'); // 11:00 PM ET the evening before
    const PHONE = '+19415550142';
    const bells = (estimateId) => trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`tech-estimate-office-first:${estimateId}`]);
    const auditRows = (action) => trx('audit_log').where({ action });
    let ownerSpy;

    async function send(id, body = {}) {
      const res = await fetch(`${baseUrl}/api/tech/estimates/${id}/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }
    // A saved clean draft with a textable number (a route customer's, or a new person's).
    async function draft(body = { customerId: ids.routeCustomer, services: ['PEST'] }) {
      const { saved } = await priceThenCreate(body);
      expect(saved.status).toBe(200);
      await trx('estimates').where({ id: saved.body.id }).update({ customer_phone: PHONE });
      return saved.body.id;
    }

    const IN_APP = ['GATE_OPS_DIGESTS_IN_APP', 'GATE_AGENT_ACTIVITY'];
    const savedEnv = {};
    beforeEach(() => {
      // The quiet owner line is an Activity row: it needs the two gates that switch the Activity feed on.
      for (const key of IN_APP) { savedEnv[key] = process.env[key]; process.env[key] = 'true'; }
      sendTool._private.clock.now = () => INSIDE;
      sendCustomerMessage.mockReset();
      sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM-synthetic-accepted' });
      ownerSpy = jest.spyOn(ownerAlerts, 'recordOwnerAlert');
    });
    afterEach(() => {
      sendTool._private.clock.now = () => new Date();
      for (const key of IN_APP) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
    });

    test('a clean draft for a route customer goes out through the real shared sender: sent, stamped, one audit event, one owner line', async () => {
      const id = await draft();
      const before = await counts();
      const res = await send(id);
      expect(res.status).toBe(200);
      const row = await estimateRow(id);
      expect(res.body).toEqual({ id, status: 'sent', sentAt: row.sent_at.toISOString() });
      expect(row.status).toBe('sent');
      expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`${row.token}|http|9415550142`));
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(sendCustomerMessage.mock.calls[0][0]).toMatchObject({
        to: PHONE, channel: 'sms', audience: 'customer', customerId: ids.routeCustomer, estimateId: id, entryPoint: 'tech_estimate_send',
        metadata: { original_message_type: 'estimate_sent' },
      });
      expect(sendCustomerMessage.mock.calls[0][0].consentBasis).toBeUndefined();
      const tool = await trx('tech_estimates').where({ estimate_id: id }).first();
      expect(tool.sent_by_technician_at).toBeInstanceOf(Date);
      expect(tool.text_request_confirmed_at).toBeNull();
      const audits = await auditRows('tech_estimate.sent');
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits[0])).not.toMatch(/9415550142/);
      expect(ownerSpy).toHaveBeenCalledTimes(1);
      expect(await ownerSpy.mock.results[0].value).toMatchObject({ ok: true });
      const lines = await trx('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'ownerAlert' = 'tech-estimate-sent'");
      expect(lines).toHaveLength(1);
      expect(lines[0].title).toBe('Estimates — look over the estimate to Synthetic Fixture');
      expect(lines[0].body).toBe('Synthetic texted this estimate from the route.');
      expect(JSON.stringify(lines[0])).not.toMatch(/9415550142|\$\d/);
      expect((await counts()).audit_log).toBe(before.audit_log + 1);
      expect(await bells(id)).toEqual([]);
    });

    test('the same estimate again is 409 already_sent and the provider was called once in total', async () => {
      const id = await draft();
      expect((await send(id)).status).toBe(200);
      expect(await send(id)).toEqual({ status: 409, body: { error: 'This estimate was already sent.', code: 'already_sent' } });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(await auditRows('tech_estimate.sent')).toHaveLength(1);
    });

    test('a second tap while the first is still sending is 409 already_sent, and the provider is called once', async () => {
      const id = await draft();
      let second;
      sendCustomerMessage.mockImplementation(async () => {
        // The first request is inside the provider call: its claim (status sending) is committed.
        expect((await estimateRow(id)).status).toBe('sending');
        second = await send(id);
        return { sent: true, providerMessageId: 'SM-synthetic-accepted' };
      });
      expect((await send(id)).status).toBe(200);
      expect(second).toEqual({ status: 409, body: { error: 'This estimate was already sent.', code: 'already_sent' } });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    });

    test('a held estimate is 409 office_first from the stored row: no claim, no provider call, still a draft', async () => {
      const { saved } = await priceThenCreate({ customerId: ids.routeCustomer, services: ['PEST'], facts: { homeSqFt: 4200, stories: 2 } });
      await trx('estimates').where({ id: saved.body.id }).update({ customer_phone: PHONE });
      const res = await send(saved.body.id, { askedForText: true, office_first_reasons: [] });
      expect(res).toEqual({ status: 409, body: { error: 'The office checks this one first.', code: 'office_first' } });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect((await estimateRow(saved.body.id)).status).toBe('draft');
      expect((await read(`/${saved.body.id}`)).body.canSend).toBe(false);
    });

    test('another technician\'s estimate is a 404 and sends nothing', async () => {
      const id = await draft();
      const other = randomUUID();
      await trx('technicians').insert({ id: other, name: 'Other Tech', email: `${other}@example.invalid`, role: 'technician', active: true, employment_status: 'active', can_create_estimates: true });
      mockCaller.id = other;
      expect(await send(id)).toEqual({ status: 404, body: { error: 'Estimate not found' } });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect((await estimateRow(id)).status).toBe('draft');
    });

    test('a new person: no confirmation is 400 and sends nothing; with it, the stored time is the consent time the provider layer got', async () => {
      const id = await draft({ prospect: PROSPECT, services: ['PEST'] });
      expect((await estimateRow(id)).customer_id).toBeNull();
      expect(await send(id, {})).toEqual({ status: 400, body: { error: 'Confirm that the person asked for the estimate by text.', code: 'needs_text_request' } });
      expect(await send(id, { askedForText: 'yes' })).toMatchObject({ status: 400 });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect((await trx('tech_estimates').where({ estimate_id: id }).first()).text_request_confirmed_at).toBeNull();

      expect((await send(id, { askedForText: true })).status).toBe(200);
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      const input = sendCustomerMessage.mock.calls[0][0];
      const tool = await trx('tech_estimates').where({ estimate_id: id }).first();
      expect(input).toMatchObject({ audience: 'lead', entryPoint: 'tech_estimate_send', consentBasis: { status: 'transactional_allowed', source: 'tech_estimate_on_site_request' } });
      expect(tool.text_request_confirmed_at.getTime()).toBe(INSIDE.getTime());
      expect(new Date(input.consentBasis.capturedAt).getTime()).toBe(tool.text_request_confirmed_at.getTime());
      expect(tool.sent_by_technician_at).toBeInstanceOf(Date);
      expect((await auditRows('tech_estimate.sent'))[0].metadata).toEqual(expect.objectContaining({ new_person: true }));
    });

    test('outside 8 AM to 8 PM ET: 409 outside_hours, nothing sent or claimed, and the same draft sends inside the window', async () => {
      const id = await draft();
      sendTool._private.clock.now = () => OUTSIDE;
      expect(await send(id)).toEqual({ status: 409, body: { error: 'Texts go out between 8 AM and 8 PM. Send it then, or ask the office.', code: 'outside_hours' } });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect((await estimateRow(id)).status).toBe('draft');
      expect((await read(`/${id}`)).body.canSend).toBe(true);
      sendTool._private.clock.now = () => INSIDE;
      expect((await send(id)).status).toBe(200);
    });

    test('the window holding the text at its edge puts the draft back, still his to send', async () => {
      const id = await draft();
      sendCustomerMessage.mockResolvedValueOnce({ sent: false, code: 'QUIET_HOURS_HOLD', reason: 'Automated SMS is limited to 8:00 AM-8:00 PM ET', retryable: true, deferred: true });
      expect((await send(id)).body.code).toBe('outside_hours');
      expect((await estimateRow(id)).status).toBe('draft');
      expect(await bells(id)).toEqual([]);
      expect((await send(id)).status).toBe(200);
    });

    test('a rule refused the text (opt-out): office_sends, parked as send_failed, ONE bell the sweep keeps open, never retried from the phone', async () => {
      const id = await draft();
      sendCustomerMessage.mockResolvedValue({ sent: false, code: 'SMS_OPTED_OUT', reason: 'Recipient opted out of SMS', terminal: true });
      expect(await send(id)).toEqual({ status: 422, body: { error: 'The text did not go. The office will send it.', code: 'office_sends' } });
      const row = await estimateRow(id);
      expect(row.status).toBe('send_failed');
      expect(row.last_send_error).toBe('tech_send_not_sent');
      const rows = await bells(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({ category: 'estimate', done_at: null, link: `/admin/estimates?estimateId=${id}` }));
      expect(rows[0].metadata).toEqual(expect.objectContaining({ doneWhen: 'estimate_sent_or_closed', severity: 'needs-you' }));
      // A second tap does not text again and does not ring again.
      expect(await send(id)).toEqual({ status: 409, body: { error: 'The text did not go. The office will send it.', code: 'office_sends' } });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(await bells(id)).toHaveLength(1);
      expect(await auditRows('tech_estimate.sent')).toHaveLength(0);
      // The sweep leaves it open while the estimate is unsent, and closes it once the office sends it.
      const { runAdminAlertRelevanceSweep } = require('../services/admin-alert-relevance');
      await runAdminAlertRelevanceSweep();
      expect((await bells(id))[0].done_at).toBeNull();
      await trx('estimates').where({ id }).update({ status: 'sent', sent_at: new Date() });
      await runAdminAlertRelevanceSweep();
      expect((await bells(id))[0]).toEqual(expect.objectContaining({ done_by: 'relevance', resolution: 'Estimate was sent' }));
    });

    test('an uncertain provider outcome is a 502, parked, one bell, and no second text', async () => {
      const id = await draft();
      sendCustomerMessage.mockResolvedValue({ sent: false, code: 'PROVIDER_FAILURE', reason: 'timeout' });
      expect(await send(id)).toEqual({ status: 502, body: { error: 'The text did not go. The office will send it.', code: 'office_sends' } });
      expect((await estimateRow(id)).last_send_error).toBe('tech_send_uncertain');
      expect(await bells(id)).toHaveLength(1);
      expect((await send(id)).status).toBe(409);
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    });

    test('a draft with no mobile number is 422 office_sends: nothing claimed or sent, and the office is told once', async () => {
      const id = await draft();
      await trx('estimates').where({ id }).update({ customer_phone: null });
      expect(await send(id)).toEqual({ status: 422, body: { error: 'This estimate has no mobile number. Ask the office to send it.', code: 'office_sends' } });
      expect((await estimateRow(id)).status).toBe('draft');
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      await send(id);
      expect(await bells(id)).toHaveLength(1);
    });

    test('an engine-review (yellow) draft the office has not acknowledged is the office\'s: the sender\'s own gate, not skipped by the claim', async () => {
      const id = await draft();
      const row = await estimateRow(id);
      const data = typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : row.estimate_data;
      await trx('estimates').where({ id }).update({ estimate_data: JSON.stringify({ ...data, estimatorEngine: { ...(data.estimatorEngine || {}), lane: 'yellow' } }) });
      expect((await send(id)).body.code).toBe('office_sends');
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect((await estimateRow(id)).status).toBe('draft');
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

    test('the send columns go down and up (both are guarded no-ops when repeated)', async () => {
      const sendColumns = require('../models/migrations/20261109140000_tech_estimates_send');
      const has = async () => [await trx.schema.hasColumn('tech_estimates', 'text_request_confirmed_at'), await trx.schema.hasColumn('tech_estimates', 'sent_by_technician_at')];
      expect(await has()).toEqual([true, true]);
      await sendColumns.up(trx);
      await sendColumns.down(trx);
      expect(await has()).toEqual([false, false]);
      await sendColumns.down(trx);
      await sendColumns.up(trx);
      await sendColumns.up(trx);
      expect(await has()).toEqual([true, true]);
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
