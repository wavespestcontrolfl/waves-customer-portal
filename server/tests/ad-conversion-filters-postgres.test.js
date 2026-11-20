// CI's DB-gated pass runs this against PostgreSQL: the conversion collectors'
// junk-lead, test-record and opt-out rules (services/ads/data-manager.js).
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
// Opted-out emails for the consent tests (the real lists live in the DB).
const mockSuppressedEmails = new Set();
jest.mock('../services/ads/ad-audience-consent', () => ({
  loadMarketingSuppression: async () => ({
    invalidPhones: new Set(),
    isSuppressed: (x) => !!(x && x.email && mockSuppressedEmails.has(String(x.email).toLowerCase())),
  }),
  normPhone: (p) => String(p || '').replace(/\D/g, '').slice(-10) || null,
}));

const { _private } = require('../services/ads/data-manager');
const { INTERNAL_TEST_CUSTOMER_IDS } = require('../services/internal-test-customers');

const RANGE = { since: '2026-11-01', endDate: '2026-11-30' };
// A fictional owner cell: the test-record rule reads ADAM_PHONE only.
const OWNER_CELL = '+19415550177';

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('conversion collectors on PostgreSQL: junk leads, test records, opt-outs', () => {
  let database;
  const schema = `ad_conv_filters_${randomUUID().replaceAll('-', '')}`;
  const tables = ['leads', 'customers', 'service_records', 'lead_sources', 'estimates', 'estimate_actuals', 'invoices',
    'customer_merge_journal'];

  const savedOwnerPhone = process.env.ADAM_PHONE;
  beforeAll(async () => {
    process.env.ADAM_PHONE = OWNER_CELL;
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 2 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    mockConn = database;
  });
  afterEach(async () => {
    mockSuppressedEmails.clear();
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
      status: 'qualified',
      is_qualified: true,
      first_name: 'Pat',
      last_name: 'Sample',
      email: 'pat@example.com',
      phone: '+19415550100',
      first_contact_at: new Date('2026-11-10T12:00:00Z'),
      created_at: new Date('2026-11-10T12:00:00Z'),
      ...fields,
    };
    await database('leads').insert(row);
    return row;
  }
  // A merge's journal row alone, with the loser's snapshot: what a run sees when
  // the merge commits after the run read its candidates.
  async function journal(loser, winner) {
    await database('customer_merge_journal').insert({
      id: randomUUID(), winner_customer_id: winner.id, loser_customer_id: loser.id, loser_snapshot: JSON.stringify(loser),
      tier: 'manual', performed_by: 'test', created_at: new Date(Date.now() - 2 * 3600000),
    });
  }
  // A merge as customer-dedupe records it: the journal row, the loser's leads
  // moved, its email cleared and phone retired, the loser retired.
  async function merge(loser, winner) {
    await journal(loser, winner);
    await database('leads').where({ customer_id: loser.id }).update({ customer_id: winner.id });
    await database('customers').where({ id: loser.id })
      .update({ email: null, phone: `merged-${loser.id.slice(0, 8)}`, deleted_at: new Date() });
  }
  // A completed, paid job on `owner`, with its estimate's leads.
  async function job(owner, date, leads) {
    const estimateId = randomUUID();
    const serviceRecordId = randomUUID();
    await database('estimates').insert({ id: estimateId, estimate_data: JSON.stringify({}) });
    await database('service_records').insert({ id: serviceRecordId, customer_id: owner.id, service_date: date, status: 'completed' });
    await database('invoices').insert({ id: randomUUID(), service_record_id: serviceRecordId, status: 'paid', total: 180 });
    await database('estimate_actuals').insert({
      id: randomUUID(), estimate_id: estimateId, customer_id: owner.id, service_record_id: serviceRecordId, service_line: 'pest', service_date: date,
    });
    for (const [leadCustomer, fields] of leads) await lead(leadCustomer, { estimate_id: estimateId, ...fields });
    return serviceRecordId;
  }
  const qualified = () => _private.collectCandidates('qualified_lead', RANGE);
  // A quote-wizard repeat run: its own lead row, marked with the original's id.
  const repeatOf = (root, fields) => lead(null, {
    lead_type: 'quote_wizard', status: 'won', extracted_data: JSON.stringify({ duplicate_of_lead_id: root.id }), ...fields,
  });

  test('a qualified lead later marked junk or non-engaged is not collected, whatever its case or spacing', async () => {
    const c = await customer();
    const real = await lead(c);
    for (const status of [' Spam ', 'DUPLICATE', 'disqualified', 'handled', 'cancelled']) await lead(c, { status });
    expect((await qualified()).map((x) => x.leadId)).toEqual([real.id]);
  });

  test('a won quote-wizard repeat of a won lead is one conversion on the same estimate, and two on another estimate', async () => {
    // One sale: the original and its repeat are both won on one estimate.
    const c = await customer();
    const estimate = randomUUID();
    const original = await lead(c, { status: 'won', estimate_id: estimate });
    await repeatOf(original, { customer_id: c.id, estimate_id: estimate });
    // Two sales: the repeat was won on a different estimate.
    const c2 = await customer({ email: 'pat.two@example.com', phone: '+19415550111' });
    const contact2 = { email: 'pat.two@example.com', phone: '+19415550111' };
    const original2 = await lead(c2, { status: 'won', estimate_id: randomUUID(), ...contact2 });
    const repeat2 = await repeatOf(original2, { customer_id: c2.id, estimate_id: randomUUID(), ...contact2 });
    expect((await qualified()).map((x) => x.leadId).sort()).toEqual([original.id, original2.id, repeat2.id].sort());
  });

  test('a won repeat yields to an open original that qualified on its own; an unqualified or junk original holds nothing', async () => {
    // Each deal is one person, with their own contact.
    const deal = async (n, originalFields) => {
      const contact = { email: `pat.deal${n}@example.com`, phone: `+1941555030${n}` };
      const c = await customer(contact);
      const original = await lead(c, { ...contact, ...originalFields });
      return { original, repeat: await repeatOf(original, { customer_id: c.id, ...contact }) };
    };
    // The estimate went out on the original (is_qualified), it stays open, and the repeat wins.
    const held = await deal(1, { status: 'estimate_sent', is_qualified: true });
    const unqualified = await deal(2, { status: 'new', is_qualified: false });
    const junk = await deal(3, { status: 'disqualified', is_qualified: true });
    expect((await qualified()).map((x) => x.leadId).sort())
      .toEqual([held.original.id, unqualified.repeat.id, junk.repeat.id].sort());
  });

  // The row order of a job's leads is the plan's, so the owner-cell lead goes in first and last.
  test.each([['first'], ['last']])('completed jobs: the limit counts jobs, so every lead of a picked job is read and a test-record lead (inserted %s) is never cut', async (position) => {
    const c = await customer({ member_since: '2026-01-01' });
    // The newest job has nine ordinary leads and one on the owner's cell.
    const ordinary = Array.from({ length: 9 }, (_, i) => [null, { email: `pat${i}@example.com`, phone: `+1941555020${i}` }]);
    const ownerCell = [null, { email: null, phone: OWNER_CELL }];
    const tested = await job(c, '2026-11-17', position === 'first' ? [ownerCell, ...ordinary] : [...ordinary, ownerCell]);
    await job(c, '2026-11-10', [[null, {}]]);
    const out = await _private.collectCandidates('completed_job_revenue', { ...RANGE, limit: 1 });
    expect(out.map((x) => x.transactionId)).toEqual([`waves_completed_job:${tested}`]);
    expect(_private.skipReason(out[0])).toBe('internal_test');
  });

  // The estimate lead belongs to another customer, and the lead keeps an older email than that customer's.
  test.each([
    ['a customer merged into it', async (other) => {
      await merge(await customer({ email: 'optout@example.com' }), other);
      mockSuppressedEmails.add('optout@example.com');
    }],
    ['its current email', async (other) => {
      mockSuppressedEmails.add(other.email);
    }],
  ])("a completed job's estimate lead counts an opt-out on its own customer: %s", async (_label, optOut) => {
    const owner = await customer({ member_since: '2026-01-01', email: 'job.owner@example.com' });
    const other = await customer({ member_since: '2026-01-01', email: 'pat.other@example.com' });
    await optOut(other);
    const serviceRecordId = await job(owner, '2026-11-17', [[other, { email: 'pat.older@example.com', phone: '+19415550222' }]]);
    const [found] = await _private.collectCandidates('completed_job_revenue', RANGE);
    expect(found).toMatchObject({ transactionId: `waves_completed_job:${serviceRecordId}`, email: null, phone: null, consentSuppressed: true });
  });

  test("an opt-out on a merged-away customer's cleared email strips the survivor's lead; an undone merge does not", async () => {
    const retired = await customer({ email: 'optout@example.com' });
    const kept = await customer({ email: 'pat.two@example.com' });
    await lead(kept, { email: 'pat.two@example.com' });
    mockSuppressedEmails.add('optout@example.com');
    expect((await qualified())[0]).toMatchObject({ email: 'pat.two@example.com' });
    // The opted-out email survives only in the journal's snapshot.
    await merge(retired, kept);
    expect((await qualified())[0]).toMatchObject({ email: null, phone: null, consentSuppressed: true });
    await database('customer_merge_journal').update({ undone_at: new Date() });
    expect((await qualified())[0]).toMatchObject({ email: 'pat.two@example.com' });
  });

  // The run read the lead before the merge committed: the lead still names the retired customer.
  test.each([
    ['opt-out on its current email', { email: 'optout@example.com' }, { email: null, phone: null, consentSuppressed: true }],
    ['test-record mark on its current phone', { phone: OWNER_CELL }, { internalTest: true }],
  ])("a lead read before its customer's merge counts the survivor's %s", async (_label, survivorFields, expected) => {
    mockSuppressedEmails.add('optout@example.com');
    const retired = await customer({ email: 'pat.three@example.com', phone: '+19415550133' });
    const survivor = await customer({ email: 'pat.two@example.com', phone: '+19415550144', ...survivorFields });
    await lead(retired, { email: 'pat.three@example.com', phone: '+19415550133' });
    expect((await qualified())[0]).toMatchObject({ email: 'pat.three@example.com', internalTest: false });
    await journal(retired, survivor);
    expect((await qualified())[0]).toMatchObject(expected);
  });

  // A test record merged into a real customer survives only in the journal: its id and its cleared contact.
  test.each([
    ['on the owner cell', { phone: OWNER_CELL }],
    ['with a test-record id', { id: INTERNAL_TEST_CUSTOMER_IDS[0] }],
  ])("a test record %s merged into a customer makes that customer's lead a test record", async (_label, fields) => {
    const retired = await customer({ email: 'pat.three@example.com', ...fields });
    const kept = await customer({ email: 'pat.two@example.com' });
    await lead(kept, { email: 'pat.two@example.com' });
    expect((await qualified())[0]).toMatchObject({ internalTest: false });
    await merge(retired, kept);
    expect((await qualified())[0]).toMatchObject({ internalTest: true });
  });
});
