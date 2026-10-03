// Customer merge x visit-linked invoices in flight (PostgreSQL; real executeMerge). The loser's
// visit-linked invoices move under the winner and resolve through the winner's default payer; one that
// would move to a payer while its send is in flight defers the merge BEFORE the FK sweep, whichever payers
// the two records carry. Synthetic rows only, removed afterwards.
const { randomUUID } = require('node:crypto');
const knex = require('knex');

let mockDatabase;
jest.mock('../models/db', () => {
  const target = function db() {};
  return new Proxy(target, {
    apply: (_t, _this, args) => mockDatabase(...args),
    get: (_t, prop) => {
      const value = mockDatabase[prop];
      return typeof value === 'function' ? value.bind(mockDatabase) : value;
    },
  });
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));

const dedupe = require('../services/customer-dedupe');
const { etDateString } = require('../utils/datetime-et');

const connection = process.env.APP_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
jest.setTimeout(120000);

postgres('customer merge defers on a linked invoice that would move to a payer while sending (PostgreSQL)', () => {
  const created = { customers: new Set(), payers: new Set() };

  beforeAll(async () => {
    const target = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    mockDatabase = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
  });
  afterAll(async () => {
    if (!mockDatabase) return;
    const customers = [...created.customers];
    const best = async (fn) => { try { await fn(); } catch { /* cleanup only */ } };
    await best(() => mockDatabase('customer_merge_journal').whereIn('winner_customer_id', customers).del());
    await best(() => mockDatabase('invoices').whereIn('customer_id', customers).del());
    await best(() => mockDatabase('service_records').whereIn('customer_id', customers).del());
    await best(() => mockDatabase('scheduled_services').whereIn('customer_id', customers).del());
    await best(() => mockDatabase('customer_activity_events').whereIn('customer_id', customers).del());
    await best(() => mockDatabase('customers').whereIn('id', customers).del());
    await best(() => mockDatabase('payers').whereIn('id', [...created.payers]).del());
    await mockDatabase.destroy();
  });

  async function payer(active) {
    const [row] = await mockDatabase('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active }).returning('id');
    created.payers.add(row.id);
    return row.id;
  }
  async function customer(label, phone, payerId = null) {
    const id = randomUUID();
    created.customers.add(id);
    await mockDatabase('customers').insert({ id, first_name: 'Synthetic', last_name: label, phone, payer_id: payerId });
    return id;
  }
  async function linkedInvoice(customerId, status, { selfPay = false } = {}) {
    const visitId = randomUUID();
    const recordId = randomUUID();
    const invoiceId = randomUUID();
    const date = etDateString();
    await mockDatabase('scheduled_services').insert({ id: visitId, customer_id: customerId, service_type: 'Fixture General Pest Control', scheduled_date: date, status: 'completed', self_pay_override: selfPay });
    await mockDatabase('service_records').insert({ id: recordId, customer_id: customerId, scheduled_service_id: visitId, service_type: 'Fixture General Pest Control', service_date: date });
    await mockDatabase('invoices').insert({ id: invoiceId, customer_id: customerId, invoice_number: `QA-${invoiceId.slice(0, 8)}`, token: `tok-${invoiceId}`, status, total: 80, service_record_id: recordId });
    return invoiceId;
  }
  const phone = () => `+1999556${String(Math.floor(Math.random() * 9000) + 1000)}`;

  test('an active winner payer absorbing a payerless loser refuses while the loser\'s linked invoice is sending, and merges (withdrawing it) once it is not', async () => {
    const p = phone();
    const winnerId = await customer('Winner', p, await payer(true));
    const loserId = await customer('Loser', p);
    const invoiceId = await linkedInvoice(loserId, 'sending');

    await expect(dedupe.executeMerge({ winnerId, loserId, performedBy: 'test:merge-fence' })).rejects.toThrow(/being sent/);
    // Nothing moved: the invoice is still the loser's, still sending, unstamped.
    expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({ customer_id: loserId, status: 'sending', scheduled_send_error: null });
    expect(await mockDatabase('customers').where({ id: loserId }).first('deleted_at')).toMatchObject({ deleted_at: null });

    await mockDatabase('invoices').where({ id: invoiceId }).update({ status: 'sent' });
    const result = await dedupe.executeMerge({ winnerId, loserId, performedBy: 'test:merge-fence' });
    expect(result.journalId).toBeTruthy();
    const merged = await mockDatabase('invoices').where({ id: invoiceId }).first();
    expect(merged.customer_id).toBe(winnerId);
    expect(merged.scheduled_send_error).toMatch(/^payer_billed:/);
  });

  test('a blank winner inheriting the loser\'s active payer refuses while the loser\'s linked invoice is sending', async () => {
    const p = phone();
    const winnerId = await customer('Winner', p);
    const loserId = await customer('Loser', p, await payer(true));
    const invoiceId = await linkedInvoice(loserId, 'sending');
    await expect(dedupe.executeMerge({ winnerId, loserId, performedBy: 'test:merge-fence' })).rejects.toThrow(/being sent/);
    expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({ customer_id: loserId, status: 'sending', scheduled_send_error: null });
  });

  test('a payerless loser\'s sending invoice on a self-pay-pinned visit does not block a merge into a payer-linked winner (its owner does not move)', async () => {
    const p = phone();
    const winnerId = await customer('Winner', p, await payer(true));
    const loserId = await customer('Loser', p);
    const invoiceId = await linkedInvoice(loserId, 'sending', { selfPay: true });
    const result = await dedupe.executeMerge({ winnerId, loserId, performedBy: 'test:merge-fence' });
    expect(result.journalId).toBeTruthy();
    expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({ customer_id: winnerId, status: 'sending', scheduled_send_error: null });
  });

  test('records on two DIFFERENT payers (an inactive loser payer included) never reach the sweep: the merge refuses first and nothing moves', async () => {
    const p = phone();
    const winnerId = await customer('Winner', p, await payer(true));
    const loserId = await customer('Loser', p, await payer(false));
    const invoiceId = await linkedInvoice(loserId, 'sending');
    await expect(dedupe.executeMerge({ winnerId, loserId, performedBy: 'test:merge-fence' })).rejects.toThrow(/different third-party payers/);
    expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({ customer_id: loserId, status: 'sending', scheduled_send_error: null });
  });

  test('control: two self-pay records (no payer on either side) merge with a sending linked invoice untouched', async () => {
    const p = phone();
    const winnerId = await customer('Winner', p);
    const loserId = await customer('Loser', p);
    const invoiceId = await linkedInvoice(loserId, 'sending');
    await dedupe.executeMerge({ winnerId, loserId, performedBy: 'test:merge-fence' });
    expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({ customer_id: winnerId, status: 'sending', scheduled_send_error: null });
  });

  test('control: both records on the SAME active payer merge with a sending linked invoice (its owner does not move)', async () => {
    const p = phone();
    const shared = await payer(true);
    const winnerId = await customer('Winner', p, shared);
    const loserId = await customer('Loser', p, shared);
    const invoiceId = await linkedInvoice(loserId, 'sending');
    await dedupe.executeMerge({ winnerId, loserId, performedBy: 'test:merge-fence' });
    expect(await mockDatabase('invoices').where({ id: invoiceId }).first()).toMatchObject({ customer_id: winnerId, status: 'sending' });
  });
});
