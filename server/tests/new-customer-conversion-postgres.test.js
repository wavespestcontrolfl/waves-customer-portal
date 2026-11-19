// CI's DB-gated pass runs this against PostgreSQL: the new_customer conversion
// collector (services/ads/data-manager.js) — one event per NEW customer, never
// an existing customer's add-on ask. Fixture tables live in a unique schema
// dropped after the suite.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.fn = { now: () => mockConn.fn.now() };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Opted-out emails and wrong numbers for the consent tests (the real lists live in the DB).
const mockSuppressedEmails = new Set();
const mockInvalidPhones = new Set();
jest.mock('../services/ads/ad-audience-consent', () => ({
  loadMarketingSuppression: async () => ({
    invalidPhones: new Set(mockInvalidPhones),
    isSuppressed: (x) => !!(x && x.email && mockSuppressedEmails.has(String(x.email).toLowerCase())),
  }),
  normPhone: (p) => String(p || '').replace(/\D/g, '').slice(-10) || null,
}));

const { _private } = require('../services/ads/data-manager');

const RANGE = { since: '2026-11-01', endDate: '2026-11-30' };
// A fictional owner cell: the test-record rule reads ADAM_PHONE only.
const OWNER_CELL = '+19415550177';

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('new_customer conversion collector on PostgreSQL', () => {
  let database;
  const schema = `new_customer_${randomUUID().replaceAll('-', '')}`;
  const tables = ['leads', 'customers', 'service_records', 'scheduled_services', 'services', 'lead_sources'];

  const savedOwnerPhone = process.env.ADAM_PHONE;
  beforeAll(async () => {
    process.env.ADAM_PHONE = OWNER_CELL;
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    mockConn = database;
  });
  afterEach(async () => {
    mockSuppressedEmails.clear();
    mockInvalidPhones.clear();
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.??', [schema, table]);
  });
  afterAll(async () => {
    if (savedOwnerPhone === undefined) delete process.env.ADAM_PHONE; else process.env.ADAM_PHONE = savedOwnerPhone;
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  async function customer(fields = {}) {
    const row = { id: randomUUID(), first_name: 'Pat', last_name: 'Sample', email: 'pat@example.com', phone: '+19415550100', ...fields };
    await database('customers').insert(row);
    return row;
  }
  async function lead(customerRow, fields = {}) {
    const row = {
      id: randomUUID(),
      customer_id: customerRow ? customerRow.id : null,
      status: 'won',
      first_name: 'Pat',
      last_name: 'Sample',
      email: 'pat@example.com',
      phone: '+19415550100',
      first_contact_at: new Date('2026-11-10T12:00:00Z'),
      created_at: new Date('2026-11-10T12:00:00Z'),
      converted_at: new Date('2026-11-12T15:00:00Z'),
      ...fields,
    };
    await database('leads').insert(row);
    return row;
  }
  const collect = (opts = {}) => _private.collectCandidates('new_customer', { ...RANGE, ...opts });

  test('a brand-new customer counts once: customer-scoped id, converted time, $3,500', async () => {
    const c = await customer({ member_since: '2026-11-12' });
    await lead(c);
    const out = await collect();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      conversionType: 'new_customer',
      transactionId: `waves_new_customer:${c.id}`,
      eventTimestamp: '2026-11-12T15:00:00.000Z',
      conversionValue: 3500,
    });
    expect(_private.skipReason(out[0])).toBeNull();
  });

  test('an existing customer (member_since long before first contact) is not new business', async () => {
    const c = await customer({ member_since: '2025-03-01' });
    await lead(c);
    expect(await collect()).toHaveLength(0);
  });

  test('an existing customer with a completed visit before first contact is not new business', async () => {
    const c = await customer({ member_since: null });
    await database('service_records').insert({ id: randomUUID(), customer_id: c.id, service_date: '2026-06-01', status: 'completed' });
    await lead(c);
    expect(await collect()).toHaveLength(0);
  });

  test('a first visit AFTER first contact, or a stamp within the slack days, still counts as new', async () => {
    const c = await customer({ member_since: '2026-11-08' }); // 2 days before first contact: inside the slack
    await database('service_records').insert({ id: randomUUID(), customer_id: c.id, service_date: '2026-11-14', status: 'completed' });
    await lead(c);
    expect(await collect()).toHaveLength(1);
  });

  test('an open lead with no conversion is not a new customer', async () => {
    const c = await customer({ member_since: null });
    await lead(c, { status: 'new', converted_at: null });
    expect(await collect()).toHaveLength(0);
  });

  test('status won with no converted_at falls back to the customer member_since date', async () => {
    const c = await customer({ member_since: '2026-11-13' });
    await lead(c, { converted_at: null });
    const out = await collect();
    expect(out).toHaveLength(1);
    expect(out[0].eventTimestamp.startsWith('2026-11-13')).toBe(true);
  });

  test('an event outside the window is not collected', async () => {
    const c = await customer({ member_since: '2026-09-12' });
    await lead(c, { first_contact_at: new Date('2026-09-10T12:00:00Z'), converted_at: new Date('2026-09-12T15:00:00Z') });
    expect(await collect()).toHaveLength(0);
  });

  test('a lead with no linked customer is not collected (no customer id to count once)', async () => {
    await lead(null);
    expect(await collect()).toHaveLength(0);
  });

  test('two won leads of one customer collapse to one event', async () => {
    const c = await customer({ member_since: '2026-11-12' });
    await lead(c);
    await lead(c, { converted_at: new Date('2026-11-14T15:00:00Z') });
    expect(await collect()).toHaveLength(1);
  });

  test('a win later marked lost, disqualified or duplicate is not collected (status decides, not converted_at)', async () => {
    for (const status of ['lost', 'disqualified', 'duplicate']) {
      const c = await customer({ member_since: '2026-11-12' });
      await lead(c, { status });
    }
    expect(await collect()).toHaveLength(0);
  });

  test('an archived customer is not collected, even with a live won lead', async () => {
    const c = await customer({ member_since: '2026-11-12', deleted_at: new Date('2026-11-15T12:00:00Z') });
    await lead(c);
    expect(await collect()).toHaveLength(0);
  });

  test('the window runs Eastern midnight to Eastern midnight, whatever the session time zone', async () => {
    const lateLastDay = await customer({ member_since: null }); // Nov 30, 11:30 PM EST
    await lead(lateLastDay, { converted_at: new Date('2026-12-01T04:30:00Z') });
    const lateDayBefore = await customer({ member_since: null }); // Oct 31, 10:00 PM EDT
    await lead(lateDayBefore, {
      first_contact_at: new Date('2026-10-30T12:00:00Z'),
      created_at: new Date('2026-10-30T12:00:00Z'),
      converted_at: new Date('2026-11-01T02:00:00Z'),
    });
    const out = await collect();
    expect(out.map((c) => c.transactionId)).toEqual([`waves_new_customer:${lateLastDay.id}`]);
  });

  test('the limit counts customers, not lead rows', async () => {
    const newest = await customer({ member_since: null });
    await lead(newest, { converted_at: new Date('2026-11-20T15:00:00Z') });
    await lead(newest, { converted_at: new Date('2026-11-19T15:00:00Z') });
    const older = await customer({ member_since: null });
    await lead(older, { converted_at: new Date('2026-11-12T15:00:00Z') });
    const out = await collect({ limit: 2 });
    expect(out.map((c) => c.transactionId).sort()).toEqual(
      [`waves_new_customer:${newest.id}`, `waves_new_customer:${older.id}`].sort(),
    );
  });

  test("the acquisition is the customer's first win: its time and click id, not a later add-on's", async () => {
    const c = await customer({ member_since: null });
    await lead(c, { converted_at: new Date('2026-11-20T15:00:00Z'), gclid: 'g-addon' });
    await lead(c, { converted_at: new Date('2026-11-12T15:00:00Z'), gclid: 'g-first' });
    const out = await collect();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ eventTimestamp: '2026-11-12T15:00:00.000Z', gclid: 'g-first' });
  });

  test('a first win before the window means no event, even with a later win inside it', async () => {
    const c = await customer({ member_since: null });
    await lead(c, {
      first_contact_at: new Date('2026-09-28T12:00:00Z'), created_at: new Date('2026-09-28T12:00:00Z'),
      converted_at: new Date('2026-10-01T15:00:00Z'),
    });
    await lead(c, {
      first_contact_at: new Date('2026-11-18T12:00:00Z'), created_at: new Date('2026-11-18T12:00:00Z'),
      converted_at: new Date('2026-11-20T15:00:00Z'),
    });
    expect(await collect()).toHaveLength(0);
  });

  test('a prospect stamped member_since at its first form is still new when a later call wins', async () => {
    const c = await customer({ member_since: '2026-11-01' });
    await lead(c, {
      status: 'lost', converted_at: null,
      first_contact_at: new Date('2026-11-01T14:00:00Z'), created_at: new Date('2026-11-01T14:00:00Z'),
    });
    await lead(c, {
      first_contact_at: new Date('2026-11-20T14:00:00Z'), created_at: new Date('2026-11-20T14:00:00Z'),
      converted_at: new Date('2026-11-22T15:00:00Z'),
    });
    const out = await collect();
    expect(out.map((x) => x.eventTimestamp)).toEqual(['2026-11-22T15:00:00.000Z']);
  });

  test('an upload run pages until it holds `limit` sendable customers', async () => {
    const ids = [];
    for (const day of ['20', '18', '16']) {
      const c = await customer({ member_since: null });
      await lead(c, { converted_at: new Date(`2026-11-${day}T15:00:00Z`) });
      ids.push(`waves_new_customer:${c.id}`);
    }
    // sendable = what the destination would send now (here: not already sent).
    const notSent = (sent) => async (batch) => new Set(batch.map((x) => x.transactionId).filter((id) => !sent.includes(id)));
    const tx = (out) => out.map((x) => x.transactionId);
    // Readiness (no sendable check) reads one page.
    expect(tx(await collect({ limit: 1 }))).toEqual([ids[0]]);
    // An upload run returns the unsendable ones too, and at most `limit` sendable ones.
    expect(tx(await collect({ limit: 1, sendableTransactionIds: notSent([ids[0]]) }))).toEqual([ids[0], ids[1]]);
    expect(tx(await collect({ limit: 1, sendableTransactionIds: notSent([ids[0], ids[1]]) }))).toEqual(ids);
    expect(tx(await collect({ limit: 1, sendableTransactionIds: notSent(ids) }))).toEqual(ids);
  });

  test('a newest test record takes no slot from an older sendable customer', async () => {
    const test = await customer({ member_since: null, phone: OWNER_CELL });
    await lead(test, { phone: OWNER_CELL, converted_at: new Date('2026-11-20T15:00:00Z') });
    const real = await customer({ member_since: null });
    await lead(real, { converted_at: new Date('2026-11-18T15:00:00Z') });
    const sendable = async (batch) => new Set(batch.filter((x) => !_private.skipReason(x)).map((x) => x.transactionId));
    const out = await collect({ limit: 1, sendableTransactionIds: sendable });
    expect(out.map((x) => [x.transactionId, _private.skipReason(x)])).toEqual([
      [`waves_new_customer:${test.id}`, 'internal_test'],
      [`waves_new_customer:${real.id}`, null],
    ]);
  });

  test('a completed booking before the lead is an existing customer; a free assessment is not', async () => {
    const booked = await customer({ member_since: null });
    await database('scheduled_services').insert({
      id: randomUUID(), customer_id: booked.id, status: 'completed', service_type: 'General Pest Control',
      scheduled_date: '2026-06-01', completed_at: null,
    });
    await lead(booked);
    const assessed = await customer({ member_since: null });
    await database('scheduled_services').insert({
      id: randomUUID(), customer_id: assessed.id, status: 'completed', service_type: 'Waves Assessment',
      scheduled_date: '2026-10-20', completed_at: new Date('2026-10-20T15:00:00Z'),
    });
    await lead(assessed);
    const out = await collect();
    expect(out.map((x) => x.transactionId)).toEqual([`waves_new_customer:${assessed.id}`]);
  });

  test('a later lead with no converted_at never takes a time before it existed', async () => {
    const c = await customer({ member_since: '2026-11-01' });
    await lead(c, {
      first_contact_at: new Date('2026-11-01T14:00:00Z'), created_at: new Date('2026-11-01T14:00:00Z'),
      converted_at: new Date('2026-11-12T15:00:00Z'), gclid: 'g-first',
    });
    await lead(c, {
      first_contact_at: new Date('2026-11-20T14:00:00Z'), created_at: new Date('2026-11-20T14:00:00Z'),
      converted_at: null, gclid: 'g-addon',
    });
    const out = await collect();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ eventTimestamp: '2026-11-12T15:00:00.000Z', gclid: 'g-first' });
  });

  test("an opted-out email on the customer's deleted or open lead strips the upload", async () => {
    const c = await customer({ member_since: null });
    await lead(c);
    await lead(c, { status: 'new', converted_at: null, email: 'old-address@example.com', deleted_at: new Date('2026-11-14T12:00:00Z') });
    mockSuppressedEmails.add('old-address@example.com');
    const out = await collect();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ consentSuppressed: true, email: null, phone: null });
  });

  test("a deleted lead's phone never replaces a wrong number", async () => {
    const c = await customer({ member_since: null, phone: null });
    await lead(c, { phone: '+19415550111' });
    await lead(c, { status: 'lost', phone: '+19415550122', deleted_at: new Date('2026-11-14T12:00:00Z') });
    mockInvalidPhones.add('9415550111');
    const out = await collect();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ email: 'pat@example.com', phone: null });
  });

  test('a live open lead named Shakedown Test makes the customer a test record', async () => {
    const c = await customer({ member_since: null });
    await lead(c);
    await lead(c, { status: 'new', converted_at: null, first_name: 'Shakedown', last_name: 'Test' });
    const out = await collect();
    expect(out.map((x) => _private.skipReason(x))).toEqual(['internal_test']);
  });

  test('a deleted lead on the owner cell does not make a real customer a test record', async () => {
    const c = await customer({ member_since: null });
    await lead(c);
    await lead(c, { status: 'new', converted_at: null, phone: OWNER_CELL, deleted_at: new Date('2026-11-14T12:00:00Z') });
    const out = await collect();
    expect(out.map((x) => _private.skipReason(x))).toEqual([null]);
  });

  test('a lead on the owner cell is collected and skipped as a test record', async () => {
    const c = await customer({ member_since: '2026-11-12', phone: OWNER_CELL, email: 'x@example.com' });
    await lead(c, { phone: OWNER_CELL, email: 'x@example.com' });
    const out = await collect();
    expect(out.map((x) => _private.skipReason(x))).toEqual(['internal_test']);
  });
});
