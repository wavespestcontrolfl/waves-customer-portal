/**
 * A payer assigned to a visit withdraws the invoices that ride that visit WITHOUT a combined-visit
 * packet (a post-completion invoice minted from the service record alone, or one linked straight to
 * the visit) from the homeowner, by the same withdrawal the packet path uses. Real PostgreSQL, every
 * test inside a rolled-back transaction. Synthetic names only.
 */
jest.mock('../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const knex = require('knex');
const express = require('express');
const { randomUUID } = require('crypto');
const { etDateString } = require('../utils/datetime-et');
const Packets = require('../services/visit-completion-packets');
const StripeService = require('../services/stripe');
const { assertInvoiceCollectible } = require('../services/invoice-helpers');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg;
jest.setTimeout(60000);

postgres('payer assignment withdraws visit-linked invoices with no packet', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    mockPg = database;
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    sendCustomerMessage.mockReset();
    mockPg = await database.transaction();
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  async function payer(active = true) {
    const [row] = await mockPg('payers').insert({ display_name: 'Fixture Property Management', ap_email: `${randomUUID()}@example.invalid`, active }).returning('id');
    return row.id;
  }

  // customer + a completed visit + its service record + one invoice riding the visit.
  async function fixture({ link = 'record', status = 'sent', visitPayerId = null, customerPayerId = null, selfPayOverride = false, invoice = {} } = {}) {
    const customerId = randomUUID();
    const visitId = randomUUID();
    const recordId = randomUUID();
    const invoiceId = randomUUID();
    const date = etDateString();
    await mockPg('customers').insert({
      id: customerId, first_name: 'Fixture', last_name: 'Linked', phone: '+12025550177',
      email: `${customerId}@example.invalid`, property_type: 'residential', payer_id: customerPayerId,
    });
    await mockPg('scheduled_services').insert({
      id: visitId, customer_id: customerId, service_type: 'Fixture General Pest Control', scheduled_date: date,
      window_start: '09:00', window_end: '10:00', status: 'completed', payer_id: visitPayerId, self_pay_override: selfPayOverride,
    });
    await mockPg('service_records').insert({
      id: recordId, customer_id: customerId, scheduled_service_id: visitId, service_type: 'Fixture General Pest Control', service_date: date,
    });
    await mockPg('invoices').insert({
      id: invoiceId, customer_id: customerId, invoice_number: `FIX-${invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''),
      status, total: 120, subtotal: 120,
      // The shape a post-completion mint writes: the record link only, no visit link, no payer.
      ...(link === 'record' ? { service_record_id: recordId } : { scheduled_service_id: visitId }),
      ...invoice,
    });
    return { customerId, visitId, recordId, invoiceId, date };
  }

  const invoiceRow = (id) => mockPg('invoices').where({ id }).first();

  // The job Bill-To route's own sequence: fence, write the payer, reconcile, withdraw.
  async function assignJobPayer(visitId, payerId) {
    await mockPg('scheduled_services').where({ id: visitId }).forNoKeyUpdate().first('id');
    if (await Packets.packetInvoiceSendInFlight({ scheduledServiceId: visitId }, mockPg)) throw new Error('invoice_send_in_flight');
    await mockPg('scheduled_services').where({ id: visitId }).update({ payer_id: payerId, self_pay_override: false });
    await Packets.reconcileWithdrawnPacketInvoices(mockPg, { scheduledServiceId: visitId });
    return Packets.withdrawPacketInvoicesForOwner(mockPg, { scheduledServiceId: visitId });
  }
  async function clearJobPayer(visitId) {
    await mockPg('scheduled_services').where({ id: visitId }).update({ payer_id: null });
    return Packets.reconcileWithdrawnPacketInvoices(mockPg, { scheduledServiceId: visitId });
  }

  async function withServer(fn) {
    const app = express();
    app.use(express.json());
    app.use('/api/pay', require('../routes/pay-v2'));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    const server = await new Promise((resolve, reject) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      listening.once('error', reject);
    });
    try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
  }
  const postSetup = (baseUrl, token) => fetch(`${baseUrl}/api/pay/${token}/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });

  test('a service-record-only invoice is refused by assertInvoiceCollectible and the pay-v2 setup path once a payer is assigned to its visit', async () => {
    const { visitId, invoiceId } = await fixture({ link: 'record' });
    const payerId = await payer();
    const mint = jest.spyOn(StripeService, 'createInvoicePaymentIntent').mockResolvedValue({
      clientSecret: 'cs_fixture', paymentIntentId: 'pi_fixture', amount: 120, baseAmount: 120, status: 'requires_payment_method',
    });
    const before = await invoiceRow(invoiceId);
    // The shape the bug lives in: no visit link, no payer, still collectible.
    expect(before).toMatchObject({ scheduled_service_id: null, payer_id: null, status: 'sent', scheduled_send_error: null });
    expect(() => assertInvoiceCollectible(before)).not.toThrow();
    await withServer(async (baseUrl) => {
      expect((await postSetup(baseUrl, before.token)).status).toBe(200);
      expect(mint).toHaveBeenCalledTimes(1);
    });

    expect(await assignJobPayer(visitId, payerId)).toEqual([invoiceId]);

    const after = await invoiceRow(invoiceId);
    expect(after).toMatchObject({ status: 'sent', payer_id: null, scheduled_send_error: `payer_billed:${payerId}` });
    expect(() => assertInvoiceCollectible(after)).toThrow(/third-party payer/);
    await withServer(async (baseUrl) => {
      const res = await postSetup(baseUrl, after.token);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/third-party payer/);
      expect(mint).toHaveBeenCalledTimes(1); // no second PaymentIntent
    });
  });

  test('the combined-session release fence reaches a service-record-only invoice; money already in flight refuses', async () => {
    const PayCombined = require('../services/pay-combined');
    const { visitId, invoiceId } = await fixture({ link: 'record', invoice: { stripe_payment_intent_id: 'pi_combo_fixture' } });
    const piOf = (status) => ({ id: 'pi_combo_fixture', status, metadata: { combined_allocation: `${invoiceId}:12000` } });
    const retrieve = jest.spyOn(StripeService, 'retrievePaymentIntent').mockResolvedValue(piOf('requires_payment_method'));
    const cancel = jest.spyOn(StripeService, 'cancelPaymentIntent').mockResolvedValue({});

    // A bank debit already moving is reported, never cancelled.
    retrieve.mockResolvedValue(piOf('processing'));
    expect(await PayCombined.releaseUnconfirmedCombinedSessionsForScheduledServices(mockPg, [visitId])).toEqual({ released: 0, inFlight: 1 });
    expect(cancel).not.toHaveBeenCalled();

    // An unconfirmed combined session is cancelled and unstamped before the payer change.
    retrieve.mockResolvedValue(piOf('requires_payment_method'));
    expect(await PayCombined.releaseUnconfirmedCombinedSessionsForScheduledServices(mockPg, [visitId])).toEqual({ released: 1, inFlight: 0 });
    expect(cancel).toHaveBeenCalledWith('pi_combo_fixture');
    expect(await invoiceRow(invoiceId)).toMatchObject({ stripe_payment_intent_id: null });
  });

  test('a directly linked invoice is withdrawn the same way', async () => {
    const { visitId, invoiceId } = await fixture({ link: 'visit' });
    const payerId = await payer();
    expect(await assignJobPayer(visitId, payerId)).toEqual([invoiceId]);
    const after = await invoiceRow(invoiceId);
    expect(after).toMatchObject({ payer_id: null, scheduled_send_error: `payer_billed:${payerId}` });
    expect(() => assertInvoiceCollectible(after)).toThrow(/third-party payer/);
  });

  test('a self-pay visit is unchanged', async () => {
    const { visitId, invoiceId } = await fixture({ link: 'record' });
    const before = await invoiceRow(invoiceId);
    expect(await Packets.withdrawPacketInvoicesForOwner(mockPg, { scheduledServiceId: visitId })).toEqual([]);
    expect(await Packets.reconcileWithdrawnPacketInvoices(mockPg, { scheduledServiceId: visitId })).toBe(0);
    expect(await invoiceRow(invoiceId)).toEqual(before);
    expect(() => assertInvoiceCollectible(before)).not.toThrow();
  });

  test('paid, void and refunded invoices are untouched', async () => {
    const payerId = await payer();
    for (const status of ['paid', 'void', 'refunded', 'prepaid', 'processing']) {
      const { visitId, invoiceId } = await fixture({ link: 'record', status });
      const before = await invoiceRow(invoiceId);
      expect(await assignJobPayer(visitId, payerId)).toEqual([]);
      expect(await invoiceRow(invoiceId)).toEqual(before);
    }
  });

  test('a visit paid for by its customer default payer is withdrawn through the customer scope; a self-pay pin blocks it', async () => {
    const payerId = await payer();
    const open = await fixture({ link: 'record' });
    const pinned = await fixture({ link: 'record', selfPayOverride: true });
    for (const f of [open, pinned]) {
      await mockPg('customers').where({ id: f.customerId }).update({ payer_id: payerId });
    }
    expect(await Packets.withdrawPacketInvoicesForOwner(mockPg, { customerId: open.customerId })).toEqual([open.invoiceId]);
    expect(await invoiceRow(open.invoiceId)).toMatchObject({ scheduled_send_error: `payer_billed:${payerId}` });
    // The visit pinned to self-pay keeps its homeowner invoice.
    expect(await Packets.withdrawPacketInvoicesForOwner(mockPg, { customerId: pinned.customerId })).toEqual([]);
    expect(await invoiceRow(pinned.invoiceId)).toMatchObject({ scheduled_send_error: null });
  });

  test('activating a payer withdraws the invoices of the visits and customers that reference it; an inactive payer withdraws nothing', async () => {
    const payerId = await payer(false);
    const byVisit = await fixture({ link: 'record', visitPayerId: payerId });
    const byCustomer = await fixture({ link: 'visit', customerPayerId: payerId });
    expect(await Packets.withdrawPacketInvoicesForOwner(mockPg, { payerId })).toEqual([]);
    await mockPg('payers').where({ id: payerId }).update({ active: true });
    expect((await Packets.withdrawPacketInvoicesForOwner(mockPg, { payerId })).sort()).toEqual([byVisit.invoiceId, byCustomer.invoiceId].sort());
    // …and deactivating releases them again.
    await mockPg('payers').where({ id: payerId }).update({ active: false });
    expect(await Packets.reconcileWithdrawnPacketInvoices(mockPg, { payerId })).toBe(2);
    expect(await invoiceRow(byVisit.invoiceId)).toMatchObject({ scheduled_send_error: null });
    expect(await invoiceRow(byCustomer.invoiceId)).toMatchObject({ scheduled_send_error: null });
  });

  test('the payer service activation path withdraws a record-only invoice end to end, and deactivation releases it', async () => {
    const Payers = require('../services/payer');
    const payerId = await payer(false);
    const { invoiceId } = await fixture({ link: 'record', customerPayerId: payerId });
    expect(await invoiceRow(invoiceId)).toMatchObject({ scheduled_send_error: null });
    expect((await Payers.updatePayer(payerId, { active: true })).payer).toMatchObject({ active: true });
    expect(await invoiceRow(invoiceId)).toMatchObject({ payer_id: null, scheduled_send_error: `payer_billed:${payerId}` });
    expect((await Payers.updatePayer(payerId, { active: false })).payer).toMatchObject({ active: false });
    expect(await invoiceRow(invoiceId)).toMatchObject({ scheduled_send_error: null });
  });

  test('removing the payer releases a withdrawn invoice: the stamp clears and paused dunning resumes', async () => {
    const { visitId, invoiceId, customerId } = await fixture({ link: 'record' });
    const payerId = await payer();
    await mockPg('invoice_followup_sequences').insert({ invoice_id: invoiceId, customer_id: customerId, status: 'active', next_touch_at: new Date() });
    await assignJobPayer(visitId, payerId);
    expect(await mockPg('invoice_followup_sequences').where({ invoice_id: invoiceId }).first())
      .toMatchObject({ status: 'paused', paused_reason: 'payer_billed', next_touch_at: null });

    expect(await clearJobPayer(visitId)).toBe(1);

    const released = await invoiceRow(invoiceId);
    expect(released).toMatchObject({ status: 'sent', scheduled_send_error: null });
    expect(() => assertInvoiceCollectible(released)).not.toThrow();
    expect(await mockPg('invoice_followup_sequences').where({ invoice_id: invoiceId }).first())
      .toMatchObject({ status: 'active', paused_reason: null });
  });

  test('a queued invoice leaves the send queue on withdrawal and returns to it on release; a plain draft stays a draft', async () => {
    const queued = await fixture({ link: 'record', status: 'scheduled', invoice: { scheduled_send_at: new Date(Date.now() + 3600e3) } });
    const draft = await fixture({ link: 'record', status: 'draft' });
    const payerId = await payer();
    for (const f of [queued, draft]) await mockPg('customers').where({ id: f.customerId }).update({ payer_id: payerId });

    await Packets.withdrawPacketInvoicesForOwner(mockPg, { customerId: queued.customerId });
    await Packets.withdrawPacketInvoicesForOwner(mockPg, { customerId: draft.customerId });
    expect(await invoiceRow(queued.invoiceId)).toMatchObject({ status: 'draft', scheduled_send_at: null, scheduled_send_error: `payer_billed:${payerId}:queued` });
    expect(await invoiceRow(draft.invoiceId)).toMatchObject({ status: 'draft', scheduled_send_error: `payer_billed:${payerId}` });

    for (const f of [queued, draft]) await mockPg('customers').where({ id: f.customerId }).update({ payer_id: null });
    await Packets.reconcileWithdrawnPacketInvoices(mockPg, { customerId: queued.customerId });
    await Packets.reconcileWithdrawnPacketInvoices(mockPg, { customerId: draft.customerId });
    expect(await invoiceRow(queued.invoiceId)).toMatchObject({ status: 'scheduled', scheduled_send_error: null });
    expect((await invoiceRow(queued.invoiceId)).scheduled_send_at).not.toBeNull();
    expect(await invoiceRow(draft.invoiceId)).toMatchObject({ status: 'draft', scheduled_send_error: null });
  });

  test('moving the visit to a different payer re-points the stamp instead of releasing it', async () => {
    const { visitId, invoiceId } = await fixture({ link: 'record' });
    const first = await payer();
    const second = await payer();
    await assignJobPayer(visitId, first);
    await mockPg('scheduled_services').where({ id: visitId }).update({ payer_id: second });
    await Packets.reconcileWithdrawnPacketInvoices(mockPg, { scheduledServiceId: visitId });
    expect(await invoiceRow(invoiceId)).toMatchObject({ scheduled_send_error: `payer_billed:${second}` });
  });

  test('assigning a payer sends no customer message and writes no alert', async () => {
    const { visitId, customerId } = await fixture({ link: 'record' });
    const payerId = await payer();
    const counts = async () => ({
      sms: Number((await mockPg('sms_log').where({ customer_id: customerId }).count('* as n').first()).n),
      email: Number((await mockPg('email_messages').where({ recipient_id: customerId }).count('* as n').first()).n),
      alerts: Number((await mockPg('dispatch_alerts').count('* as n').first()).n),
    });
    const before = await counts();
    await assignJobPayer(visitId, payerId);
    await clearJobPayer(visitId);
    expect(await counts()).toEqual(before);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an invoice mid-send or mid-charge refuses the Bill-To change; the fence is scoped to the visit', async () => {
    const sending = await fixture({ link: 'record', status: 'sending' });
    const clean = await fixture({ link: 'record' });
    expect(await Packets.packetInvoiceSendInFlight({ scheduledServiceId: sending.visitId }, mockPg)).toBe(true);
    expect(await Packets.packetInvoiceSendInFlight({ customerId: sending.customerId }, mockPg)).toBe(true);
    expect(await Packets.packetInvoiceSendInFlight({ scheduledServiceId: clean.visitId }, mockPg)).toBe(false);

    // An unresolved saved-card attempt on an otherwise quiet invoice.
    await mockPg('stripe_invoice_charge_attempts').insert({
      invoice_id: clean.invoiceId, stripe_payment_method_id: 'pm_fixture', idempotency_key: `fixture_${randomUUID()}`, status: 'claimed',
    });
    expect(await Packets.packetInvoiceSendInFlight({ scheduledServiceId: clean.visitId }, mockPg)).toBe(true);
    await expect(assignJobPayer(clean.visitId, await payer())).rejects.toThrow('invoice_send_in_flight');
    // Nothing was written by the refused assignment.
    expect(await mockPg('scheduled_services').where({ id: clean.visitId }).first('payer_id')).toMatchObject({ payer_id: null });
  });

  test('a restored (unvoided) invoice whose visit was handed to a payer while it sat void comes back withdrawn', async () => {
    const InvoiceService = require('../services/invoice');
    const { visitId, invoiceId } = await fixture({ link: 'record', status: 'void' });
    const payerId = await payer();
    // Void is terminal: the assignment leaves it alone.
    expect(await assignJobPayer(visitId, payerId)).toEqual([]);
    expect(await invoiceRow(invoiceId)).toMatchObject({ status: 'void', scheduled_send_error: null });
    const restored = await InvoiceService.unvoidInvoice(invoiceId);
    expect(restored).toBeTruthy();
    const after = await invoiceRow(invoiceId);
    expect(after.status).not.toBe('void');
    expect(after.scheduled_send_error).toBe(`payer_billed:${payerId}`);
    expect(() => assertInvoiceCollectible(after)).toThrow(/third-party payer/);
  });

  test('the canonical linkage resolver is exported and agrees with the withdrawal scope', async () => {
    const { linkedScheduledServiceId } = require('../services/invoice');
    const record = await fixture({ link: 'record' });
    const direct = await fixture({ link: 'visit' });
    expect(await linkedScheduledServiceId(await invoiceRow(record.invoiceId), mockPg)).toBe(record.visitId);
    expect(await linkedScheduledServiceId(await invoiceRow(direct.invoiceId), mockPg)).toBe(direct.visitId);
  });

  test('a series of visits is withdrawn by visit id list', async () => {
    const Linked = require('../services/visit-linked-invoice-withdrawal');
    const a = await fixture({ link: 'visit' });
    const b = await fixture({ link: 'record' });
    const payerId = await payer();
    await mockPg('scheduled_services').whereIn('id', [a.visitId, b.visitId]).update({ payer_id: payerId });
    expect(await Linked.linkedInvoiceChargeInFlight(mockPg, { scheduledServiceIds: [a.visitId, b.visitId] })).toBe(false);
    expect((await Linked.withdrawLinkedInvoicesForOwner(mockPg, { scheduledServiceIds: [a.visitId, b.visitId] })).sort()).toEqual([a.invoiceId, b.invoiceId].sort());
    await mockPg('scheduled_services').whereIn('id', [a.visitId, b.visitId]).update({ payer_id: null });
    expect(await Linked.reconcileLinkedInvoices(mockPg, { scheduledServiceIds: [a.visitId, b.visitId] })).toBe(2);
  });
});
