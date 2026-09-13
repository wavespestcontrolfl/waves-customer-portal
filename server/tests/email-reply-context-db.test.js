// Synthetic PostgreSQL fixtures only; discovered by CI's serial DB-gated step.
const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');
const knex = require('knex');
let mockDb;
jest.mock('../models/db', () => new Proxy((...args) => mockDb(...args), {
  get: (_, key) => typeof mockDb[key] === 'function' ? mockDb[key].bind(mockDb) : mockDb[key],
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { assembleEmailReplyContext } = require('../services/email/email-reply-context');
const canonicalAggregator = require('../services/context-aggregator');
const mailboxAddress = 'contact@wavespestcontrol.com';
const now = new Date('2035-01-15T16:00:00Z');
jest.setTimeout(30000);

suite('email reply context PostgreSQL contract', () => {
  let database, customer, inbound, aggregator;
  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const ci = process.env.CI === 'true' && url.hostname === 'localhost' && url.pathname === '/waves_test';
    if (!ci && !(process.env.WAVES_DATABASE_ENVIRONMENT === 'test' && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname))) {
      throw new Error('Select the task-owned synthetic development database');
    }
    database = knex({ client: 'pg', connection: url.href, pool: { min: 0, max: 1 } });
  });
  beforeEach(async () => {
    mockDb = await database.transaction();
    [customer] = await mockDb('customers').insert({ id: randomUUID(), first_name: 'Synthetic',
      phone: '+15555550123', email: `fixture-${randomUUID()}@example.test`,
      active: true, pipeline_stage: 'active_customer' }).returning('*');
    [inbound] = await mockDb('emails').insert({ gmail_id: randomUUID(), gmail_thread_id: randomUUID(),
      from_address: customer.email, to_address: mailboxAddress, customer_id: customer.id,
      authentication_results: 'mx.google.com; dkim=pass header.d=example.test',
      received_at: now, body_text: 'When is our next service?', label_ids: JSON.stringify(['INBOX']) }).returning('*');
    aggregator = { getContextForCustomer: jest.fn(async () => ({ known: true })) };
  });
  afterEach(async () => { await mockDb?.rollback(); });
  afterAll(async () => { await database?.destroy(); });
  const assemble = (email, options = {}) => assembleEmailReplyContext(email, { database: mockDb, aggregator, mailboxAddress, now, ...options });

  test('normalizes exact email matching and rejects a shared address before context lookup', async () => {
    await mockDb('customers').where('id', customer.id).update({ email: ` ${customer.email.toUpperCase()} ` });
    const result = await assemble(inbound);
    expect(result).toMatchObject({ ok: true, identity: { customerId: customer.id } });
    expect(aggregator.getContextForCustomer).toHaveBeenCalledTimes(1);
    await mockDb('customers').insert({ first_name: 'Other Synthetic', phone: '+15555550124',
      email: customer.email, active: true, pipeline_stage: 'active_customer' });
    aggregator.getContextForCustomer.mockClear();
    expect(await assemble(inbound)).toMatchObject({ ok: false, reason: 'identity_ambiguous' });
    expect(aggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test.each([{ active: false }, { deleted_at: now }])('withholds inactive/deleted customer facts: %p', async (change) => {
    await mockDb('customers').where('id', customer.id).update(change);
    expect(await assemble(inbound)).toMatchObject({ ok: false });
    expect(aggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test.each([null, 'mx.google.com; dkim=fail header.d=example.test', 'mx.google.com; dkim=pass header.d=attacker.test'])('withholds facts for unauthenticated sender: %p', async (authentication_results) => {
    expect(await assemble({ ...inbound, authentication_results })).toMatchObject({ ok: false });
    expect(aggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('an inactive duplicate does not hide the sole active customer', async () => {
    await mockDb('customers').insert({ first_name: 'Archived Synthetic', phone: '+15555550124',
      email: customer.email, active: false, deleted_at: now });
    expect(await assemble(inbound)).toMatchObject({ ok: true, identity: { customerId: customer.id } });
  });

  test('refuses a conflicting linked customer and preserves SQL parameter binding', async () => {
    expect(await assemble({ ...inbound, customer_id: randomUUID() })).toMatchObject({ ok: false, reason: 'identity_conflict' });
    expect(await assemble({ ...inbound, from_address: "nobody' OR 1=1 --@example.test" })).toMatchObject({ ok: false });
    expect(aggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('withholds customer-wide facts when multiple active properties make the target ambiguous', async () => {
    await mockDb('customer_properties').insert([100, 200].map((number) => ({
      customer_id: customer.id, active: true, address_line1: `${number} Synthetic Street`,
    })));
    expect(await assemble(inbound)).toMatchObject({ ok: false });
    expect(aggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('thread selection excludes other participants, drafts, and future replies before limiting', async () => {
    const base = { gmail_thread_id: inbound.gmail_thread_id, received_at: new Date(now - 60000),
      from_address: customer.email, to_address: mailboxAddress, customer_id: customer.id };
    await mockDb('emails').insert([
      { ...base, gmail_id: randomUUID(), body_text: 'Valid earlier question', label_ids: JSON.stringify(['INBOX']) },
      { ...base, gmail_id: randomUUID(), from_address: mailboxAddress, to_address: customer.email, body_text: 'Valid earlier answer', label_ids: JSON.stringify(['SENT']) },
      { ...base, gmail_id: randomUUID(), from_address: 'other@example.test', body_text: 'OTHER CUSTOMER SECRET', label_ids: JSON.stringify(['INBOX']) },
      { ...base, gmail_id: randomUUID(), body_text: 'UNSENT DRAFT', label_ids: JSON.stringify(['DRAFT']) },
      { ...base, gmail_id: randomUUID(), body_text: 'FUTURE REPLY', received_at: new Date(now.getTime() + 60000), label_ids: JSON.stringify(['INBOX']) },
    ]);
    const result = await assemble(inbound);
    const text = JSON.stringify(result);
    expect(result.ok).toBe(true);
    expect(text).toContain('Valid earlier question');
    expect(text).toContain('Valid earlier answer');
    expect(text).toContain('When is our next service?');
    for (const secret of ['OTHER CUSTOMER SECRET', 'UNSENT DRAFT', 'FUTURE REPLY']) expect(text).not.toContain(secret);
    expect(await mockDb('emails').where('id', inbound.id).first('is_read', 'auto_action')).toEqual({ is_read: false, auto_action: null });
  });

  test('canonical context keeps net invoice balances, archived estimates and cancelled visits honest', async () => {
    await mockDb('invoices').insert({ customer_id: customer.id, token: randomUUID(), invoice_number: randomUUID().slice(0, 24),
      total: 100, credit_applied: 25, status: 'sent', due_date: '2035-01-20' });
    const [payer] = await mockDb('payers').insert({ display_name: 'Synthetic Third-party Payer' }).returning('id');
    await mockDb('invoices').insert({ customer_id: customer.id, payer_id: payer.id, token: randomUUID(),
      invoice_number: randomUUID().slice(0, 24), total: 900, status: 'sent', due_date: '2035-01-20' });
    await mockDb('estimates').insert({ customer_id: customer.id, status: 'sent', archived_at: now, monthly_total: 999 });
    await mockDb('scheduled_services').insert([
      { customer_id: customer.id, scheduled_date: '2035-01-20', service_type: 'Cancelled Synthetic Service', status: 'cancelled' },
      { customer_id: customer.id, scheduled_date: '2035-01-21', service_type: 'Confirmed Synthetic Service', status: 'confirmed' },
    ]);
    await mockDb('service_records').insert({ customer_id: customer.id, service_date: '2035-01-14',
      service_type: 'Completed Synthetic Service', status: 'completed' });
    const result = await assemble(inbound, { aggregator: canonicalAggregator });
    expect(result.ok).toBe(true);
    expect(result.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'outstanding_balance', status: 'present', value: 75 }),
      expect.objectContaining({ key: 'open_invoice', value: expect.objectContaining({ amountDue: 75 }) }),
      expect.objectContaining({ key: 'payer_billed_invoice', status: 'present', value: true }),
      expect.objectContaining({ key: 'pending_estimate', status: 'absent' }),
      expect.objectContaining({ key: 'upcoming_visit', value: expect.objectContaining({ type: 'Confirmed Synthetic Service' }) }),
      expect.objectContaining({ key: 'last_completed_visit', value: expect.objectContaining({ type: 'Completed Synthetic Service' }) }),
    ]));
    expect(JSON.stringify(result)).not.toContain('Cancelled Synthetic Service');
    expect(result.timeline.find((event) => event.type === 'upcoming_visit').at).toBe('2035-01-21T05:00:00.000Z');
    expect(result.timeline.some((event) => event.type === 'open_invoice')).toBe(false);
  });

  test('an unavailable thread preserves the enclosing transaction and the triggering question', async () => {
    await mockDb.schema.alterTable('emails', (table) => table.renameColumn('body_text', 'fixture_hidden_body'));
    const result = await assemble(inbound);
    expect(result).toMatchObject({ ok: true, untrusted: { emailThread: { status: 'unavailable' } } });
    expect(result.factsBlock).toContain('When is our next service?');
    expect(await mockDb('customers').where('id', customer.id).first('id')).toEqual({ id: customer.id });
  });
});
