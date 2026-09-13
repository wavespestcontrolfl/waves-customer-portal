// Real migrated PostgreSQL column/types, isolated schema, rollback-only fixtures.
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  db.raw = (...args) => mockPg.raw(...args);
  Object.defineProperty(db, 'fn', { get: () => mockPg.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: (gate) => gate === 'composerReceiptLinks',
  gateEnvValue: () => false,
}));
jest.mock('../services/messaging/validators/consent', () => ({
  loadContactState: jest.fn(async () => ({})),
  checkConsentForPurpose: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  loadSuppressionState: jest.fn(async (_input, contactState) => contactState),
  checkSuppression: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  checkLineType: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/validators/identity', () => ({
  validateRequiredIds: jest.fn(() => ({ ok: true })),
  validateIdentityTrust: jest.fn(() => ({ ok: true })),
  resolveTrustLevel: jest.fn(() => 'phone_provided_unverified'),
}));
jest.mock('../services/messaging/validators/voice', () => ({
  validateNoCustomerEmoji: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/compliance-contact-checks', () => ({
  checkContactCompliance: jest.fn(() => ({ ok: true })),
}));
jest.mock('../services/messaging/audit', () => ({
  persistAudit: jest.fn(async () => ({ id: 'audit-1' })),
}));
jest.mock('../services/messaging/providers/twilio-sms', () => ({
  sendViaTwilio: jest.fn(async () => ({ sent: true, deliveryOutcome: 'accepted', providerMessageId: 'SM-real' })),
}));

const { randomUUID } = require('node:crypto');
const migration = require('../models/migrations/20260907000020_invoice_receipt_sms_delivery');
const { buildReceiptLink, immediateOnlyLinkSendCheck } = require('../services/composer-customer-links');
const { loadPaymentForInvoice } = require('../services/receipt-payment');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { sendViaTwilio } = require('../services/messaging/providers/twilio-sms');
const { loadContactState } = require('../services/messaging/validators/consent');
const connection = process.env.RECEIPT_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const sentAt = '2026-08-30T15:00:00Z';
const sid = `SM${'a'.repeat(32)}`;
let database;
let mockPg;
let customerId;
jest.setTimeout(60000);

postgres('receipt SMS delivery evidence on PostgreSQL', () => {
  beforeAll(() => {
    if (!/^\/(waves_qa_[a-f0-9]{32}|waves_test)$/.test(new URL(connection).pathname)) throw new Error('Use a dedicated Waves QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    customerId = randomUUID();
    mockPg = await database.transaction();
    const schema = `receipt_qa_${randomUUID().replaceAll('-', '')}`;
    await mockPg.raw('CREATE SCHEMA ??', [schema]);
    await mockPg.raw('SET LOCAL search_path TO ??, public', [schema]);
    // Copy schema only, never application data. LIKE retains real column
    // types/defaults/CHECKs, without foreign keys to unrelated fixtures.
    for (const table of ['invoices', 'payments', 'messaging_audit_log', 'sms_log']) {
      await mockPg.raw('CREATE TABLE ?? (LIKE ?? INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', [`${schema}.${table}`, `public.${table}`]);
    }
    await migration.up(mockPg);
    loadContactState.mockResolvedValue({ customer: { id: customerId, phone: '+19415550100' }, prefs: {} });
    sendViaTwilio.mockResolvedValue({ sent: true, deliveryOutcome: 'accepted', provider: 'twilio', providerMessageId: sid, sentAt });
  });
  afterEach(async () => { await mockPg?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function invoice(fields = {}) {
    const row = { id: randomUUID(), customer_id: customerId, token: randomUUID().replaceAll('-', '').repeat(2), invoice_number: `QA-${randomUUID().slice(0, 8)}`, status: 'paid', total: 85, paid_at: sentAt, created_at: sentAt, ...fields };
    await mockPg('invoices').insert(row);
    return row;
  }
  async function audit(fields = {}) {
    await mockPg('messaging_audit_log').insert({ id: randomUUID(), customer_id: customerId, to_hash: 'a'.repeat(64), to_last4: '0100', body_hash: 'b'.repeat(64), audience: 'customer', purpose: 'payment_receipt', channel: 'sms', provider: 'twilio', provider_message_id: sid, sent_at: sentAt, metadata: { original_message_type: 'receipt' }, ...fields });
  }
  const receiptStamp = async (id) => (await mockPg('invoices').where({ id }).first('receipt_sms_sent_at')).receipt_sms_sent_at;

  test('backfills exact classic and combined invoices; shared visit evidence cannot qualify a sibling', async () => {
    const serviceRecordId = randomUUID();
    const classic = await invoice();
    const combined = await invoice({ service_record_id: serviceRecordId, status: 'refunded' });
    const sibling = await invoice({ service_record_id: serviceRecordId });
    await audit({ invoice_id: classic.id });
    await audit({ purpose: 'appointment', metadata: { original_message_type: 'service_complete_paid_receipt', invoice_id: combined.id, service_record_id: serviceRecordId } });
    await audit({ purpose: 'appointment', metadata: { original_message_type: 'service_complete_paid_receipt', service_record_id: serviceRecordId } });
    await migration.up(mockPg);
    expect(await receiptStamp(classic.id)).toEqual(new Date(sentAt));
    expect(await receiptStamp(combined.id)).toEqual(new Date(sentAt));
    expect(await receiptStamp(sibling.id)).toBeNull();
  });

  test('backfills a delivered quiet-hours replay through its exact queued invoice; an unsent queue stays unavailable', async () => {
    const delivered = await invoice();
    const held = await invoice();
    const queueId = randomUUID();
    for (const [id, target] of [[queueId, delivered], [randomUUID(), held]]) {
      await mockPg('sms_log').insert({ id, customer_id: customerId, direction: 'outbound', from_phone: '+19415550199', to_phone: '+19415550100', message_type: 'service_complete_paid_receipt', status: 'scheduled', metadata: { stamp_receipt_invoice_id: target.id } });
    }
    await audit({ purpose: 'appointment', metadata: { original_message_type: 'service_complete_paid_receipt', scheduled_sms_log_id: queueId } });
    await migration.up(mockPg);
    expect(await receiptStamp(delivered.id)).toEqual(new Date(sentAt));
    expect(await receiptStamp(held.id)).toBeNull();
  });

  test('email, push, suppression, failed/blocked texts, wrong customers and payer billing cannot create evidence', async () => {
    const cases = [
      { channel: 'email' }, { provider: 'push', provider_message_id: 'push:delivered' },
      { provider_message_id: 'owner-silence' }, { provider_message_id: null },
      { blocked_code: 'SUPPRESSED_OPT_OUT' }, { sent_at: null }, { customer_id: randomUUID() },
      { metadata: { original_message_type: 'invoice_thank_you' } },
    ];
    const ids = [];
    for (const fields of cases) {
      const row = await invoice({ receipt_sent_at: sentAt });
      ids.push(row.id);
      await audit({ invoice_id: row.id, ...fields });
    }
    const payer = await invoice({ payer_id: 1 });
    ids.push(payer.id);
    await audit({ invoice_id: payer.id });
    await migration.up(mockPg);
    expect(await mockPg('invoices').whereIn('id', ids).whereNotNull('receipt_sms_sent_at')).toHaveLength(0);
    expect((await buildReceiptLink([customerId])).url).toBeNull();
  });

  test('live accepted receipt writes the fact once and immediately becomes available; a generic SMS cannot', async () => {
    const row = await invoice();
    const input = { to: '+19415550100', body: 'Synthetic receipt', channel: 'sms', audience: 'customer', customerId, invoiceId: row.id, purpose: 'payment_receipt', metadata: { original_message_type: 'receipt' }, operatorInitiated: true };
    expect((await buildReceiptLink([customerId])).url).toBeNull();
    await sendCustomerMessage({ ...input, purpose: 'conversational' });
    expect(await receiptStamp(row.id)).toBeNull();
    await sendCustomerMessage(input);
    expect(await receiptStamp(row.id)).toEqual(new Date(sentAt));
    expect((await buildReceiptLink([customerId])).url).toContain(`/receipt/${row.token}`);
    sendViaTwilio.mockResolvedValueOnce({ sent: true, deliveryOutcome: 'accepted', provider: 'twilio', providerMessageId: sid, sentAt: '2026-08-31T15:00:00Z' });
    await sendCustomerMessage(input);
    expect(await receiptStamp(row.id)).toEqual(new Date(sentAt));
  });

  test('live combined delivery stamps only its settled self-pay invoice and customer', async () => {
    const paid = await invoice();
    const unpaid = await invoice({ status: 'sent' });
    const payer = await invoice({ payer_id: 1 });
    const otherCustomer = await invoice({ customer_id: randomUUID() });
    for (const row of [paid, unpaid, payer, otherCustomer]) {
      await sendCustomerMessage({ to: '+19415550100', body: 'Synthetic completion receipt', channel: 'sms', audience: 'customer', customerId, invoiceId: row.id, purpose: 'appointment', operatorInitiated: true, metadata: { original_message_type: 'service_complete_paid_receipt', scheduled_sms_log_id: randomUUID() } });
    }
    expect(await receiptStamp(paid.id)).toEqual(new Date(sentAt));
    for (const row of [unpaid, payer, otherCustomer]) expect(await receiptStamp(row.id)).toBeNull();
  });

  test('selects by actual settlement across every texted receipt, and skips a refund without a payment record', async () => {
    await invoice({ receipt_sms_sent_at: sentAt });
    const refunded = await invoice({ status: 'refunded', paid_at: null, receipt_sms_sent_at: sentAt, created_at: '2026-07-01T15:00:00Z' });
    const brokenRefund = await invoice({ status: 'refunded', paid_at: null, receipt_sms_sent_at: sentAt, created_at: '2026-09-02T15:00:00Z' });
    await mockPg('payments').insert({ id: randomUUID(), customer_id: customerId, amount: 85, refund_amount: 85, status: 'refunded', payment_date: '2026-09-01', metadata: JSON.stringify({ invoice_id: refunded.id }), created_at: '2026-09-01T15:00:00Z' });
    expect(await loadPaymentForInvoice(brokenRefund.id, customerId)).toBeNull();
    expect((await buildReceiptLink([customerId])).receipt.id).toBe(refunded.id);
  });

  test('migration up/down is repeatable and retains an existing SMS fact and permanent token', async () => {
    const row = await invoice({ receipt_sms_sent_at: sentAt });
    await audit({ invoice_id: row.id, sent_at: '2026-09-01T15:00:00Z' });
    await migration.up(mockPg);
    expect(await receiptStamp(row.id)).toEqual(new Date(sentAt));
    await migration.down(mockPg);
    await migration.down(mockPg);
    expect(await mockPg.schema.hasColumn('invoices', 'receipt_sms_sent_at')).toBe(false);
    await migration.up(mockPg);
    expect((await mockPg('invoices').where({ id: row.id }).first()).token).toBe(row.token);
    expect(await receiptStamp(row.id)).toEqual(new Date('2026-09-01T15:00:00Z'));
  });

  test('legacy receipt payment linkage resolves PI, charge and manual rows within the invoice customer', async () => {
    for (const field of ['stripe_payment_intent_id', 'stripe_charge_id', 'description']) {
      const key = `qa_${randomUUID()}`;
      const row = await invoice(field === 'description' ? {} : { [field]: key });
      const payment = { id: randomUUID(), customer_id: customerId, amount: 85, status: 'refunded', payment_date: '2026-09-01', created_at: sentAt, [field]: field === 'description' ? `Invoice ${row.invoice_number} — cash` : key };
      await mockPg('payments').insert(payment);
      await mockPg('payments').insert({ ...payment, id: randomUUID(), customer_id: randomUUID(), created_at: '2026-09-01T15:00:00Z' });
      expect((await loadPaymentForInvoice(row.id, customerId, { stripePaymentIntentId: row.stripe_payment_intent_id, stripeChargeId: row.stripe_charge_id, invoiceNumber: row.invoice_number })).id).toBe(payment.id);
    }
  });

  test('a payment lookup failure rejects the latest-receipt request instead of selecting an older paid invoice', async () => {
    await invoice({ receipt_sms_sent_at: sentAt });
    await invoice({ status: 'refunded', paid_at: null, receipt_sms_sent_at: sentAt, created_at: '2026-07-01T15:00:00Z' });
    // Fault only this transaction's isolated payment table. The real helper
    // must propagate the SQL failure, never report a confirmed missing row.
    await mockPg.schema.alterTable('payments', (table) => table.renameColumn('metadata', 'unavailable_metadata'));
    await expect(buildReceiptLink([customerId], customerId)).rejects.toMatchObject({ code: '42703' });
  });

  test('raw receipt payment URLs are immediate-only according to the persisted invoice status', async () => {
    const row = await invoice();
    const url = `https://portal.wavespestcontrol.com/pay/${row.token}`;
    for (const status of ['paid', 'processing', 'sent', 'refunded']) {
      await mockPg('invoices').where({ id: row.id }).update({ status });
      expect(await immediateOnlyLinkSendCheck(url)).toEqual(['paid', 'processing'].includes(status)
        ? { present: true, label: 'Receipt' }
        : { present: false });
    }
  });
});
