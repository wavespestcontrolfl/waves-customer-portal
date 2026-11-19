// CI's DB-gated pass runs this against PostgreSQL: the new_customer conversion
// collector (services/ads/data-manager.js) — one event per NEW customer, never
// an existing customer's add-on ask — and the completed-job collector's limit.
// Fixture tables live in a unique schema dropped after the suite.
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
  const tables = ['leads', 'customers', 'service_records', 'scheduled_services', 'services', 'lead_sources',
    'google_ads_conversion_uploads', 'meta_conversion_uploads', 'estimates', 'estimate_actuals', 'invoices'];

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

  test('the first win decides: when it came after a paid visit, a later win of an older lead takes no credit', async () => {
    const c = await customer({ member_since: null });
    // A paid visit on Nov 5. The first win (Nov 12) is a lead opened after that visit...
    await database('service_records').insert({ id: randomUUID(), customer_id: c.id, service_date: '2026-11-05', status: 'completed' });
    await lead(c, {
      first_contact_at: new Date('2026-11-10T12:00:00Z'), created_at: new Date('2026-11-10T12:00:00Z'),
      converted_at: new Date('2026-11-12T15:00:00Z'),
    });
    // ...and a lead opened before the visit wins later, on Nov 20. It passes the
    // visit check alone, but it is not the customer's first win.
    await lead(c, {
      first_contact_at: new Date('2026-10-20T12:00:00Z'), created_at: new Date('2026-10-20T12:00:00Z'),
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

  test('an upload run pages until it holds `limit` sendable customers, listing at most `limit` skipped ones', async () => {
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
    // An upload run returns at most `limit` sendable ones, plus at most `limit`
    // unsendable ones before them (reported as skipped), so the uploader's own
    // history read stays bounded however much was sent before.
    expect(tx(await collect({ limit: 1, sendableTransactionIds: notSent([ids[0]]) }))).toEqual([ids[0], ids[1]]);
    expect(tx(await collect({ limit: 1, sendableTransactionIds: notSent([ids[0], ids[1]]) }))).toEqual([ids[0], ids[2]]);
    expect(tx(await collect({ limit: 1, sendableTransactionIds: notSent(ids) }))).toEqual([ids[0]]);
    expect(tx(await collect({ limit: 2, sendableTransactionIds: notSent(ids) }))).toEqual([ids[0], ids[1]]);
    // The database page is a full page whatever the limit: one read, not one per customer.
    const pages = [];
    const all = async (batch) => { pages.push(batch.length); return new Set(batch.map((x) => x.transactionId)); };
    expect(tx(await collect({ limit: 1, sendableTransactionIds: all }))).toEqual([ids[0]]);
    expect(pages).toEqual([3]);
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

  test('a merge never sends the acquisition again: a sent row under the surviving customer counts, on both platforms', async () => {
    const { existingSent } = require('../services/ads/meta-data-manager')._private;
    const retired = await customer({ member_since: null });
    const kept = await customer({ member_since: null, email: 'pat.two@example.com' });
    const won = await lead(retired);
    const sentAs = `waves_new_customer:${retired.id}`;
    const keptId = `waves_new_customer:${kept.id}`;
    await database('google_ads_conversion_uploads').insert({
      conversion_type: 'new_customer', transaction_id: sentAs, event_name: 'New customer', event_timestamp: won.converted_at,
      status: 'sent', validate_only: false, customer_id: retired.id, lead_id: won.id,
    });
    await database('meta_conversion_uploads').insert({
      conversion_type: 'new_customer', event_id: sentAs, event_name: 'Purchase', status: 'sent', customer_id: retired.id, lead_id: won.id,
    });
    // A merge repoints every customer_id column, then retires the losing row.
    for (const table of ['leads', 'google_ads_conversion_uploads', 'meta_conversion_uploads']) {
      await database(table).where({ customer_id: retired.id }).update({ customer_id: kept.id });
    }
    await database('customers').where({ id: retired.id }).update({ deleted_at: new Date() });

    const candidates = await collect();
    expect(candidates.map((x) => x.transactionId)).toEqual([keptId]);
    expect((await _private.existingUploads('new_customer', candidates)).get(keptId)).toMatchObject({ transaction_id: sentAs, status: 'sent' });
    expect([...await _private.uploadableTransactionIds('new_customer', candidates, false)]).toEqual([]);
    expect([...await existingSent('new_customer', candidates)]).toEqual([keptId]);
    // The surviving customer's own failed attempt does not lift the block.
    await database('google_ads_conversion_uploads').insert({
      conversion_type: 'new_customer', transaction_id: keptId, event_name: 'New customer', event_timestamp: won.converted_at,
      status: 'failed', validate_only: false, customer_id: kept.id, lead_id: won.id,
    });
    expect([...await _private.uploadableTransactionIds('new_customer', candidates, false)]).toEqual([]);

    // Only a row that skips the upload counts: after a failed send it goes again.
    await database('google_ads_conversion_uploads').update({ status: 'failed' });
    await database('meta_conversion_uploads').update({ status: 'failed' });
    expect([...await _private.uploadableTransactionIds('new_customer', candidates, false)]).toEqual([keptId]);
    expect([...await existingSent('new_customer', candidates)]).toEqual([]);

    // Other conversions are one per event, not per customer or lead: a sent job
    // never blocks the next one.
    await database('google_ads_conversion_uploads').insert({
      conversion_type: 'completed_job_revenue', transaction_id: 'waves_completed_job:first', event_name: 'Job', event_timestamp: new Date(), status: 'sent', customer_id: kept.id, lead_id: won.id,
    });
    await database('meta_conversion_uploads').insert({
      conversion_type: 'completed_job_revenue', event_id: 'waves_completed_job:first', event_name: 'Purchase', status: 'sent', customer_id: kept.id, lead_id: won.id,
    });
    const nextJob = { conversionType: 'completed_job_revenue', transactionId: 'waves_completed_job:next', customerId: kept.id, leadId: won.id };
    expect((await _private.existingUploads('completed_job_revenue', [nextJob])).size).toBe(0);
    expect((await existingSent('completed_job_revenue', [nextJob])).size).toBe(0);
  });

  test("a merge that commits mid-run never sends the acquisition again: the row left under the retired id counts through its lead's customer, on both platforms", async () => {
    const { existingSent } = require('../services/ads/meta-data-manager')._private;
    const retired = await customer({ member_since: null });
    const kept = await customer({ member_since: null, email: 'pat.two@example.com' });
    const won = await lead(retired);
    // The run collected the retired customer, the merge then committed (lead
    // moved, customer retired), and the run then wrote its rows under the retired id.
    await database('leads').where({ id: won.id }).update({ customer_id: kept.id });
    await database('customers').where({ id: retired.id }).update({ deleted_at: new Date() });
    const sentAs = `waves_new_customer:${retired.id}`;
    await database('google_ads_conversion_uploads').insert({
      conversion_type: 'new_customer', transaction_id: sentAs, event_name: 'New customer', event_timestamp: won.converted_at,
      status: 'sent', validate_only: false, customer_id: retired.id, lead_id: won.id,
    });
    await database('meta_conversion_uploads').insert({
      conversion_type: 'new_customer', event_id: sentAs, event_name: 'Purchase', status: 'sent', customer_id: retired.id, lead_id: won.id,
    });

    const keptId = `waves_new_customer:${kept.id}`;
    const blocked = async () => {
      const candidates = await collect();
      expect(candidates.map((x) => x.transactionId)).toEqual([keptId]);
      expect([...await _private.uploadableTransactionIds('new_customer', candidates, false)]).toEqual([]);
      expect([...await existingSent('new_customer', candidates)]).toEqual([keptId]);
      return candidates;
    };
    await blocked();
    // The survivor's own, earlier win is its first win now: another lead, still blocked.
    const earlier = await lead(kept, { email: 'pat.two@example.com', converted_at: new Date('2026-11-11T15:00:00Z') });
    const candidates = await blocked();
    expect(candidates[0].leadId).toBe(earlier.id);
    // Only a row that skips the upload counts: after a failed send it goes again.
    await database('google_ads_conversion_uploads').update({ status: 'failed' });
    await database('meta_conversion_uploads').update({ status: 'failed' });
    expect([...await _private.uploadableTransactionIds('new_customer', candidates, false)]).toEqual([keptId]);
    expect([...await existingSent('new_customer', candidates)]).toEqual([]);
  });

  test('completed jobs: the limit counts jobs, so every lead of a picked job is read and a test-record lead is never cut', async () => {
    const c = await customer({ member_since: '2026-01-01' });
    const job = async (date, leads) => {
      const estimateId = randomUUID();
      const serviceRecordId = randomUUID();
      await database('estimates').insert({ id: estimateId, estimate_data: JSON.stringify({}) });
      await database('service_records').insert({ id: serviceRecordId, customer_id: c.id, service_date: date, status: 'completed' });
      await database('invoices').insert({ id: randomUUID(), service_record_id: serviceRecordId, status: 'paid', total: 180 });
      await database('estimate_actuals').insert({
        id: randomUUID(), estimate_id: estimateId, customer_id: c.id, service_record_id: serviceRecordId, service_line: 'pest', service_date: date,
      });
      for (const fields of leads) await lead(null, { estimate_id: estimateId, ...fields });
      return serviceRecordId;
    };
    // The newest job has nine ordinary leads and one on the owner's cell.
    const tested = await job('2026-11-17', [
      ...Array.from({ length: 9 }, (_, i) => ({ email: `pat${i}@example.com`, phone: `+1941555020${i}` })),
      { email: null, phone: OWNER_CELL },
    ]);
    await job('2026-11-10', [{}]);
    const out = await _private.collectCandidates('completed_job_revenue', { ...RANGE, limit: 1 });
    expect(out.map((x) => x.transactionId)).toEqual([`waves_completed_job:${tested}`]);
    expect(_private.skipReason(out[0])).toBe('internal_test');
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

  test("a free assessment's booking and service record together are not a prior visit; a paid record is", async () => {
    // Snapshot path: no catalog link, judged by service_type.
    const bySnapshot = await customer({ member_since: null });
    const visit1 = randomUUID();
    await database('scheduled_services').insert({
      id: visit1, customer_id: bySnapshot.id, status: 'completed', service_type: 'Waves Assessment',
      scheduled_date: '2026-10-20', completed_at: new Date('2026-10-20T15:00:00Z'),
    });
    await database('service_records').insert({
      id: randomUUID(), customer_id: bySnapshot.id, status: 'completed', service_date: '2026-10-20',
      service_type: 'Waves Assessment', scheduled_service_id: visit1,
    });
    await lead(bySnapshot);
    // Catalog path: the booking's service is the assessment, whatever the snapshots say.
    const byCatalog = await customer({ member_since: null });
    const serviceId = randomUUID();
    await database('services').insert({ id: serviceId, service_key: 'lawn_inspection', name: 'Waves Assessment' });
    const visit2 = randomUUID();
    await database('scheduled_services').insert({
      id: visit2, customer_id: byCatalog.id, service_id: serviceId, status: 'completed', service_type: 'Lawn check',
      scheduled_date: '2026-10-21', completed_at: new Date('2026-10-21T15:00:00Z'),
    });
    await database('service_records').insert({
      id: randomUUID(), customer_id: byCatalog.id, status: 'completed', service_date: '2026-10-21',
      service_type: 'Lawn check', scheduled_service_id: visit2,
    });
    await lead(byCatalog);
    // A paid visit's record (imported history, no booking) is a prior visit.
    const paid = await customer({ member_since: null });
    await database('service_records').insert({
      id: randomUUID(), customer_id: paid.id, status: 'completed', service_date: '2026-10-22', service_type: 'General Pest Control',
    });
    await lead(paid);
    const out = await collect();
    expect(out.map((x) => x.transactionId).sort()).toEqual(
      [`waves_new_customer:${bySnapshot.id}`, `waves_new_customer:${byCatalog.id}`].sort(),
    );
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
