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

  test('the visit Bill-To release also cancels the ordinary single-invoice checkout of an affected invoice, and refuses when it is in flight', async () => {
    const PayCombined = require('../services/pay-combined');
    const payerId = await payer();
    const open = await fixture({ link: 'record', invoice: { stripe_payment_intent_id: 'pi_single_open' } });
    const payerOwned = await fixture({ link: 'record', invoice: { stripe_payment_intent_id: 'pi_payer_own', payer_id: payerId } });
    const retrieve = jest.spyOn(StripeService, 'retrievePaymentIntent');
    const cancel = jest.spyOn(StripeService, 'cancelPaymentIntent').mockResolvedValue({});
    const piOf = (id, status) => ({ id, status, metadata: {} }); // ordinary checkout: no combined allocation

    // Money already confirming: the change is refused, nothing is cancelled.
    retrieve.mockImplementation(async (id) => piOf(id, 'processing'));
    expect(await PayCombined.releaseUnconfirmedCombinedSessionsForScheduledServices(mockPg, [open.visitId])).toEqual({ released: 0, inFlight: 1 });
    expect(cancel).not.toHaveBeenCalled();

    // Unconfirmed: cancelled (Stripe) and unstamped, so the pre-issued client secret is dead.
    retrieve.mockImplementation(async (id) => piOf(id, 'requires_payment_method'));
    expect(await PayCombined.releaseUnconfirmedCombinedSessionsForScheduledServices(mockPg, [open.visitId])).toEqual({ released: 1, inFlight: 0 });
    expect(cancel).toHaveBeenCalledWith('pi_single_open');
    expect(await invoiceRow(open.invoiceId)).toMatchObject({ stripe_payment_intent_id: null });

    // Already cancelled (a replay, or a cancel that raced us): only the stamp cleanup, no second Stripe call.
    await mockPg('invoices').where({ id: open.invoiceId }).update({ stripe_payment_intent_id: 'pi_single_open' });
    cancel.mockClear();
    retrieve.mockImplementation(async (id) => piOf(id, 'canceled'));
    expect(await PayCombined.releaseUnconfirmedCombinedSessionsForScheduledServices(mockPg, [open.visitId])).toEqual({ released: 1, inFlight: 0 });
    expect(cancel).not.toHaveBeenCalled();

    // A payer's own invoice keeps its checkout.
    retrieve.mockImplementation(async (id) => piOf(id, 'requires_payment_method'));
    expect(await PayCombined.releaseUnconfirmedCombinedSessionsForScheduledServices(mockPg, [payerOwned.visitId])).toEqual({ released: 0, inFlight: 0 });
    expect(await invoiceRow(payerOwned.invoiceId)).toMatchObject({ stripe_payment_intent_id: 'pi_payer_own' });

    // A failed Stripe cancel aborts the payer change rather than leaving a live secret.
    await mockPg('invoices').where({ id: open.invoiceId }).update({ stripe_payment_intent_id: 'pi_single_open' });
    cancel.mockRejectedValueOnce(new Error('payment_intent_unexpected_state'));
    await expect(PayCombined.releaseUnconfirmedCombinedSessionsForScheduledServices(mockPg, [open.visitId])).rejects.toThrow(/payer NOT changed/);
  });

  test('the customer-default and payer-activation releases cancel single checkouts only where the owner would move', async () => {
    const PayCombined = require('../services/pay-combined');
    const payerId = await payer();
    const unpinned = await fixture({ link: 'record', invoice: { stripe_payment_intent_id: 'pi_unpinned' } });
    const pinned = await fixture({ link: 'record', selfPayOverride: true, invoice: { stripe_payment_intent_id: 'pi_pinned' } });
    const cancel = jest.spyOn(StripeService, 'cancelPaymentIntent').mockResolvedValue({});
    jest.spyOn(StripeService, 'retrievePaymentIntent').mockImplementation(async (id) => ({ id, status: 'requires_payment_method', metadata: {} }));

    expect(await PayCombined.releaseUnconfirmedCombinedSessionsForCustomer(mockPg, pinned.customerId, { invalidateLinked: true })).toEqual({ released: 0, inFlight: 0 });
    expect(await invoiceRow(pinned.invoiceId)).toMatchObject({ stripe_payment_intent_id: 'pi_pinned' });

    expect(await PayCombined.releaseUnconfirmedCombinedSessionsForCustomers(mockPg, [unpinned.customerId], { invalidateLinked: true, payerId }))
      .toEqual({ released: 1, inFlight: 0 });
    expect(cancel).toHaveBeenCalledWith('pi_unpinned');
    expect(await invoiceRow(unpinned.invoiceId)).toMatchObject({ stripe_payment_intent_id: null });
    // Without the flag (merge and every other caller) a single checkout is left alone, as before.
    await mockPg('invoices').where({ id: unpinned.invoiceId }).update({ stripe_payment_intent_id: 'pi_unpinned' });
    cancel.mockClear();
    expect(await PayCombined.releaseUnconfirmedCombinedSessionsForCustomer(mockPg, unpinned.customerId)).toEqual({ released: 0, inFlight: 0 });
    expect(cancel).not.toHaveBeenCalled();
  });

  test('a queued invoice returns to its own scheduled time, and to now only when that time has passed', async () => {
    const payerId = await payer();
    const future = new Date(Date.now() + 3 * 86400e3);
    const past = new Date(Date.now() - 3600e3);
    const later = await fixture({ link: 'record', status: 'scheduled', invoice: { scheduled_send_at: future } });
    const overdue = await fixture({ link: 'record', status: 'scheduled', invoice: { scheduled_send_at: past } });
    await assignJobPayer(later.visitId, payerId);
    await assignJobPayer(overdue.visitId, payerId);
    expect(await invoiceRow(later.invoiceId)).toMatchObject({ status: 'draft', scheduled_send_at: null, scheduled_send_error: `payer_billed:${payerId}:queued:at=${future.toISOString()}` });
    await clearJobPayer(later.visitId);
    await clearJobPayer(overdue.visitId);
    const restored = await invoiceRow(later.invoiceId);
    expect(restored).toMatchObject({ status: 'scheduled', scheduled_send_error: null });
    expect(new Date(restored.scheduled_send_at).getTime()).toBe(future.getTime());
    const sooner = await invoiceRow(overdue.invoiceId);
    expect(sooner.status).toBe('scheduled');
    expect(new Date(sooner.scheduled_send_at).getTime()).toBeGreaterThan(past.getTime());
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the payer-activation prelock set covers every non-terminal linked invoice, processing and stamped included', async () => {
    const Linked = require('../services/visit-linked-invoice-withdrawal');
    const processing = await fixture({ link: 'record', status: 'processing' });
    const stamped = await fixture({ link: 'visit', status: 'sent', invoice: { scheduled_send_error: 'payer_billed:1' } });
    const paid = await fixture({ link: 'record', status: 'paid' });
    const open = await fixture({ link: 'visit', status: 'sent' });
    const ids = await Linked.linkedVisitIdsForCustomers(mockPg, [processing.customerId, stamped.customerId, paid.customerId, open.customerId]);
    // The fence locks the processing invoice's visit and the release locks the stamped one's, both
    // after the payer row would be taken FOR UPDATE: so both are locked before it. A paid one never is.
    expect(ids.sort()).toEqual([processing.visitId, stamped.visitId, open.visitId].sort());
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
    expect(await invoiceRow(queued.invoiceId)).toMatchObject({ status: 'draft', scheduled_send_at: null, scheduled_send_error: expect.stringMatching(new RegExp(`^payer_billed:${payerId}:queued:at=\\d{4}-`)) });
    expect(await invoiceRow(draft.invoiceId)).toMatchObject({ status: 'draft', scheduled_send_error: `payer_billed:${payerId}` });

    for (const f of [queued, draft]) await mockPg('customers').where({ id: f.customerId }).update({ payer_id: null });
    await Packets.reconcileWithdrawnPacketInvoices(mockPg, { customerId: queued.customerId });
    await Packets.reconcileWithdrawnPacketInvoices(mockPg, { customerId: draft.customerId });
    expect(await invoiceRow(queued.invoiceId)).toMatchObject({ status: 'scheduled', scheduled_send_error: null });
    expect((await invoiceRow(queued.invoiceId)).scheduled_send_at).not.toBeNull();
    expect(await invoiceRow(draft.invoiceId)).toMatchObject({ status: 'draft', scheduled_send_error: null });
  });

  test('an accepted-channel marker survives withdrawal and release, so a requeued invoice stays email-only (no second text)', async () => {
    const { BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED, SUMMARY_TEXT_CARRIED_ERROR } = require('../services/invoice-helpers');
    const payerId = await payer();
    for (const marker of [BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED, `${SUMMARY_TEXT_CARRIED_ERROR}: mailbox full: try later`]) {
      const { visitId, invoiceId } = await fixture({
        link: 'record', status: 'scheduled',
        invoice: { scheduled_send_at: new Date(Date.now() + 3600e3), scheduled_send_error: marker, sms_sent_at: new Date() },
      });
      const smsSentAt = (await invoiceRow(invoiceId)).sms_sent_at;
      await assignJobPayer(visitId, payerId);
      expect(await invoiceRow(invoiceId)).toMatchObject({ status: 'draft', scheduled_send_error: expect.stringMatching(new RegExp(`^payer_billed:${payerId}:queued:at=[^m]+:m=${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)) });
      await clearJobPayer(visitId);
      const back = await invoiceRow(invoiceId);
      expect(back).toMatchObject({ status: 'scheduled', scheduled_send_error: marker });
      expect(back.sms_sent_at).toEqual(smsSentAt);
    }
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a payer-to-payer move keeps the marker in the re-pointed stamp', async () => {
    const { BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED } = require('../services/invoice-helpers');
    const { visitId, invoiceId } = await fixture({
      link: 'record', status: 'scheduled',
      invoice: { scheduled_send_at: new Date(Date.now() + 3600e3), scheduled_send_error: BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED, sms_sent_at: new Date() },
    });
    const first = await payer();
    const second = await payer();
    await assignJobPayer(visitId, first);
    await mockPg('scheduled_services').where({ id: visitId }).update({ payer_id: second });
    await Packets.reconcileWithdrawnPacketInvoices(mockPg, { scheduledServiceId: visitId });
    expect(await invoiceRow(invoiceId)).toMatchObject({ scheduled_send_error: expect.stringMatching(new RegExp(`^payer_billed:${second}:queued:at=[^m]+:m=${BILLING_EMAIL_PENDING_AFTER_CHANNEL_ACCEPTED}$`)) });
  });

  test('the Bill-To fence only counts invoices whose effective owner the change would move', async () => {
    const payerId = await payer();
    const open = await fixture({ link: 'record', status: 'sending' });
    const pinned = await fixture({ link: 'record', status: 'sending', selfPayOverride: true });
    const ownPayer = await fixture({ link: 'record', status: 'sending', visitPayerId: await payer() });
    // A customer default payer change reaches an unpinned visit only.
    expect(await Packets.packetInvoiceSendInFlight({ customerId: open.customerId }, mockPg)).toBe(true);
    expect(await Packets.packetInvoiceSendInFlight({ customerId: pinned.customerId }, mockPg)).toBe(false);
    expect(await Packets.packetInvoiceSendInFlight({ customerId: ownPayer.customerId }, mockPg)).toBe(false);
    // …a payer activation reaches a visit that names that payer, and no other.
    await mockPg('scheduled_services').where({ id: ownPayer.visitId }).update({ payer_id: payerId });
    expect(await Packets.packetInvoiceSendInFlight({ payerId }, mockPg)).toBe(true);
    await mockPg('scheduled_services').where({ id: ownPayer.visitId }).update({ payer_id: await payer() });
    await mockPg('customers').where({ id: ownPayer.customerId }).update({ payer_id: payerId });
    expect(await Packets.packetInvoiceSendInFlight({ payerId }, mockPg)).toBe(false);
    // The visit's own Bill-To change always counts.
    expect(await Packets.packetInvoiceSendInFlight({ scheduledServiceId: pinned.visitId }, mockPg)).toBe(true);
  });

  test('inside a writer transaction the fence holds the candidate invoice and ownership rows to commit (committed fixture, second connection)', async () => {
    // The fixture must be committed for a second connection to see and lock it.
    const customerId = randomUUID();
    const visitId = randomUUID();
    const recordId = randomUUID();
    const invoiceId = randomUUID();
    const date = etDateString();
    await database('customers').insert({ id: customerId, first_name: 'Fixture', last_name: 'Locked', phone: '+12025550166', email: `${customerId}@example.invalid` });
    await database('scheduled_services').insert({ id: visitId, customer_id: customerId, service_type: 'Fixture General Pest Control', scheduled_date: date, status: 'completed' });
    await database('service_records').insert({ id: recordId, customer_id: customerId, scheduled_service_id: visitId, service_type: 'Fixture General Pest Control', service_date: date });
    await database('invoices').insert({ id: invoiceId, customer_id: customerId, invoice_number: `FIX-${invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'sent', total: 50, service_record_id: recordId });
    // mockPg is this test's own transaction; release it so the writer below is the only holder.
    const writer = await database.transaction();
    try {
      expect(await Packets.packetInvoiceSendInFlight({ scheduledServiceId: visitId }, writer)).toBe(false);
      const contender = await database.transaction();
      try {
        // A queue sender's claim flip or a saved-card claim must write or lock the invoice row.
        await expect(contender('invoices').where({ id: invoiceId }).forUpdate().noWait().first('id')).rejects.toMatchObject({ code: '55P03' });
      } finally { await contender.rollback(); }
      const contender2 = await database.transaction();
      try {
        // …and a Bill-To editor of the visit waits behind the shared ownership lock.
        await expect(contender2('scheduled_services').where({ id: visitId }).forNoKeyUpdate().noWait().first('id')).rejects.toMatchObject({ code: '55P03' });
      } finally { await contender2.rollback(); }
    } finally {
      await writer.rollback();
      await database('invoices').where({ id: invoiceId }).del();
      await database('service_records').where({ id: recordId }).del();
      await database('scheduled_services').where({ id: visitId }).del();
      await database('customers').where({ id: customerId }).del();
    }
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
