// Real migrated PostgreSQL, synthetic records, deleted after every test.
// Runs in the existing DB-gated CI step or the owning worktree's private QA DB.
//
// Undo last manual payment (GATE_UNDO_MANUAL_PAYMENT). recordManualPayment is the REAL writer, so the marker, the ledger row, the
// follow-up stop and the closed admin bell are exactly what production writes; the unit suites mock all of that and cannot show
// that Undo reads it back. Committed rows (not one rolled-back transaction) because the double-click case needs two connections
// racing for the invoice row lock.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  // The receipt send lock opens its own unpooled session through db.client.
  Object.defineProperty(db, 'client', { get: () => db.connection.client });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

// The first test cold-loads the whole payment writer (invoice, Stripe, follow-up services).
jest.setTimeout(60000);

postgres('Undo last manual payment against migrated PostgreSQL', () => {
  let database;
  let recordManualPayment;
  let undoManualPayment;
  let describeManualPaymentUndo;
  const customerIds = [];
  const BELL_TITLE = 'Payment failed (synthetic undo)';

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    require('../models/db').connection = database;
    ({ recordManualPayment } = require('../services/invoice-manual-payment'));
    ({ undoManualPayment, describeManualPaymentUndo } = require('../services/invoice-manual-payment-undo'));
  });

  beforeEach(() => { process.env.GATE_UNDO_MANUAL_PAYMENT = 'true'; });

  afterEach(async () => {
    delete process.env.GATE_UNDO_MANUAL_PAYMENT;
    const ids = customerIds.splice(0);
    if (!ids.length) return;
    const invoiceIds = (await database('invoices').whereIn('customer_id', ids).pluck('id'));
    await database('meta_conversion_uploads').whereIn('invoice_id', invoiceIds).del();
    await database('audit_log').whereIn('resource_id', [...invoiceIds, ...ids]).del();
    await database('receipt_delivery_jobs').whereIn('invoice_id', invoiceIds).del();
    await database('messaging_audit_log').whereIn('invoice_id', invoiceIds.map(String)).del();
    await database('invoice_followup_sequences').whereIn('invoice_id', invoiceIds).del();
    await database('review_requests').whereIn('customer_id', ids).del();
    await database('activity_log').whereIn('customer_id', ids).del();
    await database('payments').whereIn('customer_id', ids).del();
    await database('notifications').where({ title: BELL_TITLE }).del();
    await database('invoices').whereIn('customer_id', ids).del();
    await database('customers').whereIn('id', ids).del();
  });

  afterAll(async () => { await database.destroy(); });

  // One messaging_audit_log row about the invoice (synthetic recipient), as messaging/audit.js writes it.
  const auditRow = (invoiceId, over = {}) => ({
    invoice_id: String(invoiceId), to_hash: 'synthetic', to_last4: '0000', audience: 'customer', purpose: 'billing', channel: 'sms', body_hash: 'synthetic', ...over,
  });

  async function makeInvoice(over = {}) {
    const [customer] = await database('customers')
      .insert({ first_name: 'Synthetic', last_name: 'Undo', phone: `+1555555${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`.slice(0, 12) })
      .returning('id');
    customerIds.push(customer.id);
    const [invoice] = await database('invoices').insert({
      token: randomUUID(),
      invoice_number: `INV-UNDO-${randomUUID().slice(0, 8)}`,
      customer_id: customer.id,
      status: 'viewed',
      subtotal: 100,
      total: 100,
      sent_at: new Date(Date.now() - 5 * 24 * 3600 * 1000),
      viewed_at: new Date(Date.now() - 4 * 24 * 3600 * 1000),
      notes: 'Seed note',
      ...over,
    }).returning('*');
    return invoice;
  }

  const record = (invoiceId, over = {}) => recordManualPayment(invoiceId, {
    method: 'check', reference: '1042', note: 'check in hand', recordedBy: 'Synthetic Office', sendReceipt: false, ...over,
  });
  // The payment id the confirm was shown (GET's payment.id): the newest marker's ledger row, or a stranger's id when the invoice has no marker.
  async function shownPaymentId(invoiceId) {
    const marker = await database('audit_log').where({ resource_id: invoiceId, action: 'invoice.manual_payment_recorded' }).orderBy('created_at', 'desc').first('metadata');
    return marker?.metadata.paymentId || randomUUID();
  }
  const undo = async (invoiceId, over = {}) => undoManualPayment(invoiceId, {
    reason: 'typed the wrong invoice', undoneBy: 'Synthetic Office', paymentId: await shownPaymentId(invoiceId), ...over,
  });
  const row = (invoiceId) => database('invoices').where({ id: invoiceId }).first();

  // Move the payment (invoice stamps, marker, ledger row) one day into the past, as if it were recorded yesterday.
  async function backdateOneDay(invoiceId) {
    await database('invoices').where({ id: invoiceId }).update({
      payment_recorded_at: database.raw("payment_recorded_at - interval '1 day'"),
      updated_at: database.raw("payment_recorded_at - interval '1 day'"),
    });
    await database('audit_log').where({ resource_id: invoiceId, action: 'invoice.manual_payment_recorded' }).update({ created_at: database.raw("created_at - interval '1 day'") });
    const customerId = (await row(invoiceId)).customer_id;
    await database('payments').where({ customer_id: customerId }).update({ created_at: database.raw("created_at - interval '1 day'") });
  }

  it('puts a same-day check payment back: collectible again, ledger kept as canceled, reminders re-armed, one activity row', async () => {
    const invoice = await makeInvoice();
    await database('invoice_followup_sequences').insert({
      invoice_id: invoice.id, customer_id: invoice.customer_id, status: 'active', step_index: 1, touches_sent: 1, next_touch_at: new Date(Date.now() + 3600 * 1000),
    });
    const [bell] = await database('notifications').insert({
      recipient_type: 'admin', category: 'payment', title: BELL_TITLE,
      metadata: JSON.stringify({ triggerKey: 'payment_failed', payload: { invoiceId: invoice.id } }),
    }).returning('id');

    await record(invoice.id);
    const paid = await row(invoice.id);
    expect(paid.status).toBe('paid');
    expect((await database('invoice_followup_sequences').where({ invoice_id: invoice.id }).first()).status).toBe('completed');
    expect((await database('notifications').where({ id: bell.id }).first()).done_by).toBe('payments');

    const result = await undo(invoice.id);

    expect(result.remindersRearmed).toBe(true);
    const after = await row(invoice.id);
    expect(after).toMatchObject({
      status: 'viewed', paid_at: null, payment_method: null, payment_reference: null, payment_recorded_by: null, payment_recorded_at: null, notes: 'Seed note',
    });
    const payments = await database('payments').where({ customer_id: invoice.customer_id });
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('canceled');
    expect(payments[0].metadata.manualPaymentUndo).toMatchObject({ reason: 'typed the wrong invoice', by: 'Synthetic Office', method: 'check', amount: 100 });
    // The step already sent stays sent: the row resumes at its stored step with a next touch.
    const sequence = await database('invoice_followup_sequences').where({ invoice_id: invoice.id }).first();
    expect(sequence).toMatchObject({ status: 'active', step_index: 1, touches_sent: 1 });
    expect(sequence.next_touch_at).not.toBeNull();
    expect((await database('notifications').where({ id: bell.id }).first())).toMatchObject({ done_at: null, done_by: null, resolution: null });
    const activity = await database('activity_log').where({ customer_id: invoice.customer_id, action: 'invoice_payment_undone' });
    expect(activity).toHaveLength(1);
    expect(activity[0].description).toContain('typed the wrong invoice');
    expect(activity[0].metadata.invoice_id).toBe(invoice.id);

    // The invoice is collectible again, so the same day's corrected entry records and undoes again.
    await record(invoice.id, { method: 'cash' });
    await expect(undo(invoice.id, { reason: 'second typo' })).resolves.toMatchObject({ payment: { method: 'cash' } });
  });

  it('a saved-card attempt declined BEFORE the payment was recorded does not block Undo', async () => {
    const invoice = await makeInvoice();
    // chargeInvoiceWithSavedCard's failed row: the same description prefix as a manual payment, but earlier and no money.
    await database('payments').insert({
      customer_id: invoice.customer_id, amount: 100, status: 'failed', payment_date: new Date(), created_at: new Date(Date.now() - 3600 * 1000),
      description: `Invoice ${invoice.invoice_number} — card on file (FAILED)`,
    });
    await record(invoice.id);
    await expect(undo(invoice.id)).resolves.toMatchObject({ payment: { method: 'check' } });
    expect((await database('payments').where({ customer_id: invoice.customer_id, status: 'failed' }))).toHaveLength(1);
  });

  it('reopens exactly the payment-failed bells this payment closed: by invoice, by a legacy payment intent, by a combined allocation', async () => {
    const invoice = await makeInvoice();
    const other = await makeInvoice({ status: 'paid', paid_at: new Date() });
    const bell = async (payload, over = {}) => (await database('notifications').insert({
      recipient_type: 'admin', category: 'payment', title: BELL_TITLE, metadata: JSON.stringify({ triggerKey: 'payment_failed', payload }), ...over,
    }).returning('id'))[0].id;
    // The failed attempts' ledger rows: the closer (and Undo) resolve a payment intent to its invoices through metadata.invoice_id.
    const attempt = (customerId, paymentIntent, invoiceId) => database('payments').insert({
      customer_id: customerId, amount: 100, status: 'failed', payment_date: new Date(), description: 'Card attempt (synthetic)',
      stripe_payment_intent_id: paymentIntent, metadata: JSON.stringify({ invoice_id: invoiceId }),
    });
    const suffix = randomUUID().slice(0, 8);
    await attempt(invoice.customer_id, `pi_legacy_${suffix}`, invoice.id);
    await attempt(invoice.customer_id, `pi_combined_${suffix}`, invoice.id);
    await attempt(other.customer_id, `pi_combined_${suffix}`, other.id);
    const byInvoice = await bell({ invoiceId: invoice.id });
    const legacy = await bell({ paymentIntentId: `pi_legacy_${suffix}` });
    const combined = await bell({ invoiceId: other.id, paymentIntentId: `pi_combined_${suffix}`, allocationInvoiceIds: [invoice.id, other.id] });
    // Closed by the payments closer for ANOTHER invoice, at the same time: not this payment's.
    const unrelated = await bell({ invoiceId: other.id }, { done_at: new Date(), done_by: 'payments', resolution: 'The invoice was paid' });
    const isOpen = async (id) => (await database('notifications').where({ id }).first()).done_at === null;

    await record(invoice.id);
    expect(await Promise.all([byInvoice, legacy, combined, unrelated].map(isOpen))).toEqual([false, false, false, false]);

    await undo(invoice.id);

    expect(await Promise.all([byInvoice, legacy, combined, unrelated].map(isOpen))).toEqual([true, true, true, false]);
    expect(await database('notifications').where({ id: byInvoice }).first()).toMatchObject({ done_by: null, resolution: null });
  });

  it('restores a draft to draft: an invoice that was never sent does not become sent', async () => {
    const invoice = await makeInvoice({ status: 'draft', sent_at: null, viewed_at: null });
    await record(invoice.id);
    await undo(invoice.id);
    expect((await row(invoice.id)).status).toBe('draft');
  });

  it.each([
    ['the day after it was recorded', 'too_late', (id) => backdateOneDay(id)],
    ['a receipt stamped on the invoice', 'receipt', (id) => database('invoices').where({ id }).update({ receipt_sent_at: new Date() })],
    ['a receipt queued for delivery', 'receipt', (id) => database('receipt_delivery_jobs').insert({ invoice_id: id, source: 'operator_send', status: 'queued' })],
    ['a review request enrolled by it', 'review_ask', async (id) => database('review_requests').insert({ customer_id: (await row(id)).customer_id, status: 'pending', token: randomUUID() })],
    ['a visit it closed out', 'visit_closed', (id) => database('audit_log').insert({
      actor_type: 'system', action: 'visit.completed_on_invoice_issued', resource_type: 'scheduled_services', resource_id: randomUUID(),
      metadata: JSON.stringify({ invoiceId: id, trigger: 'paid', closed: true }),
    })],
    ['a billing pause it cleared', 'billing_pause_cleared', async (id) => database('audit_log').insert({
      actor_type: 'system', action: 'customer.billing_pause_cleared', resource_type: 'customer', resource_id: (await row(id)).customer_id,
      metadata: JSON.stringify({ source: 'admin_record_payment' }),
    })],
    ['a second payment on the invoice', 'later_payment', async (id) => {
      const current = await row(id);
      await database('payments').insert({ customer_id: current.customer_id, amount: 5, status: 'paid', payment_date: new Date(), description: `Invoice ${current.invoice_number} — cash` });
    }],
    ['a later saved-card payment still processing', 'later_payment', async (id) => {
      const current = await row(id);
      await database('payments').insert({ customer_id: current.customer_id, amount: 100, status: 'processing', payment_date: new Date(), description: `Invoice ${current.invoice_number} — card on file` });
    }],
    ['a refund on the ledger row', 'payment_row', async (id) => database('payments').where({ customer_id: (await row(id)).customer_id }).update({ refund_amount: 10 })],
    ['an ad conversion upload', 'synced', (id) => database('meta_conversion_uploads').insert({ invoice_id: id, conversion_type: 'purchase', event_id: `synthetic-${id}`, event_name: 'Purchase' })],
    ['a receipt text a provider took', 'customer_message', (id) => database('messaging_audit_log').insert(auditRow(id, { provider: 'twilio', provider_message_id: `SMsynthetic${id.slice(0, 8)}`, sent_at: new Date() }))],
    ['a receipt text held for quiet hours (it can still send)', 'customer_message', (id) => database('messaging_audit_log').insert(auditRow(id, { blocked_code: 'QUIET_HOURS_HOLD' }))],
  ])('refuses and changes nothing after %s', async (_name, code, happen) => {
    const invoice = await makeInvoice();
    await record(invoice.id);
    await happen(invoice.id);
    const before = await row(invoice.id);

    await expect(undo(invoice.id)).rejects.toMatchObject({ statusCode: 409, code });

    expect(await row(invoice.id)).toEqual(before);
    expect(await database('activity_log').where({ customer_id: invoice.customer_id, action: 'invoice_payment_undone' })).toHaveLength(0);
  });

  it('a receipt text the pipeline refused for good (an opt-out) does not block Undo', async () => {
    const invoice = await makeInvoice();
    await record(invoice.id);
    await database('messaging_audit_log').insert(auditRow(invoice.id, { blocked_code: 'SMS_OPTED_OUT', blocked_reason: 'Customer opted out of texts' }));
    await undo(invoice.id);
    expect((await row(invoice.id)).status).not.toBe('paid');
  });

  it('refuses the Zelle reconciler\'s automatic settlement', async () => {
    const invoice = await makeInvoice();
    await record(invoice.id, { automated: true, recordedBy: 'zelle-notice-reconciler' });
    await database('receipt_delivery_jobs').where({ invoice_id: invoice.id }).del();
    await expect(undo(invoice.id)).rejects.toMatchObject({ statusCode: 409, code: 'not_recorded_by_office' });
  });

  it('refuses a Stripe payment', async () => {
    const invoice = await makeInvoice({ status: 'paid', paid_at: new Date(), payment_method: 'card', processor: 'stripe', stripe_payment_intent_id: 'pi_synthetic_undo' });
    await expect(undo(invoice.id)).rejects.toMatchObject({ statusCode: 409, code: 'not_manual_paid' });
  });

  it('refuses a payment recorded before the marker existed', async () => {
    const invoice = await makeInvoice({ status: 'paid', paid_at: new Date(), payment_method: 'cash', payment_recorded_at: new Date(), payment_recorded_by: 'Synthetic Office' });
    await expect(undo(invoice.id)).rejects.toMatchObject({ statusCode: 409, code: 'not_recorded_by_office' });
  });

  it('refuses an empty reason and a dark gate, and writes nothing', async () => {
    const invoice = await makeInvoice();
    await record(invoice.id);
    await expect(undo(invoice.id, { reason: '   ' })).rejects.toMatchObject({ statusCode: 400 });
    delete process.env.GATE_UNDO_MANUAL_PAYMENT;
    await expect(undo(invoice.id)).rejects.toMatchObject({ statusCode: 403 });
    expect((await row(invoice.id)).status).toBe('paid');
  });

  it('undoes once on a double click: the second caller waits on the lock, then finds it no longer paid', async () => {
    const invoice = await makeInvoice();
    await record(invoice.id);
    const results = await Promise.allSettled([undo(invoice.id), undo(invoice.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason).toMatchObject({ statusCode: 409 });
    expect(await database('activity_log').where({ customer_id: invoice.customer_id, action: 'invoice_payment_undone' })).toHaveLength(1);
  });

  it('refuses to undo while the payment\'s post-commit effects are still running, then undoes once they finish', async () => {
    const invoice = await makeInvoice();
    const FollowUps = require('../services/invoice-followups');
    const original = FollowUps.stopOnPayment;
    let release;
    let reached;
    const held = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { reached = resolve; });
    // Recording pauses AFTER its transaction committed, inside the reminder stop (the first post-commit effect).
    const spy = jest.spyOn(FollowUps, 'stopOnPayment').mockImplementation(async (...args) => { reached(); await held; return original.apply(FollowUps, args); });
    try {
      const recording = record(invoice.id);
      await entered;
      expect((await row(invoice.id)).status).toBe('paid');
      await expect(undo(invoice.id)).rejects.toMatchObject({ statusCode: 409, code: 'still_finishing', message: 'This payment is still finishing; try again in a minute.' });
      await expect(describeManualPaymentUndo(invoice.id)).resolves.toMatchObject({ eligible: false, code: 'still_finishing' });
      expect((await row(invoice.id)).status).toBe('paid');
      expect(await database('activity_log').where({ customer_id: invoice.customer_id, action: 'invoice_payment_undone' })).toHaveLength(0);
      release();
      await recording;
      await expect(undo(invoice.id)).resolves.toMatchObject({ remindersRearmed: true });
      expect((await row(invoice.id)).status).toBe('viewed');
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it('refuses a confirmation of a payment that is no longer the one on the invoice, and writes nothing', async () => {
    const invoice = await makeInvoice();
    await record(invoice.id);
    const shownA = await shownPaymentId(invoice.id);
    // Another operator undoes payment A and records payment B while the first operator's confirm stays open.
    await undo(invoice.id);
    await record(invoice.id, { method: 'cash' });
    const before = await row(invoice.id);

    await expect(undo(invoice.id, { paymentId: shownA })).rejects.toMatchObject({
      statusCode: 409, code: 'payment_changed', message: 'This invoice\'s payment changed since you opened this. Close and try again.',
    });

    expect(await row(invoice.id)).toEqual(before);
    expect((await row(invoice.id)).status).toBe('paid');
    expect(await database('payments').where({ customer_id: invoice.customer_id, status: 'paid' })).toHaveLength(1);
    expect(await database('activity_log').where({ customer_id: invoice.customer_id, action: 'invoice_payment_undone' })).toHaveLength(1);
  });

  it('refuses an undo that names no payment', async () => {
    const invoice = await makeInvoice();
    await record(invoice.id);
    await expect(undo(invoice.id, { paymentId: undefined })).rejects.toMatchObject({ statusCode: 400 });
    expect((await row(invoice.id)).status).toBe('paid');
  });

  // Receipt senders claim a receipt_delivery_jobs row (no invoice lock, no invoice foreign key) and then send. The claim lock
  // (lockInvoiceReceiptClaim) is what orders a claim against an Undo; these two cases hold it by hand to fix which side goes first.
  async function waitForBlockedAdvisoryLock() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await database.raw("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
      if (rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('nothing is waiting on an advisory lock');
  }

  it('a receipt send that meets an Undo holding the claim lock re-reads the reopened invoice and sends nothing', async () => {
    const { lockInvoiceReceiptClaim } = require('../services/receipt-delivery-queue');
    const { sendInvoiceReceipt } = require('../services/invoice-receipt-resend');
    const emailSpy = jest.spyOn(require('../services/invoice-email'), 'sendReceiptEmail').mockResolvedValue({ ok: true });
    const textSpy = jest.spyOn(require('../services/invoice'), 'sendReceipt').mockResolvedValue({ sent: true });
    const invoice = await makeInvoice();
    await record(invoice.id);
    const holder = await database.transaction();
    try {
      // What Undo does inside its transaction: take the claim lock, reopen the invoice. Not committed yet.
      await lockInvoiceReceiptClaim(holder, invoice.id);
      await holder('invoices').where({ id: invoice.id }).update({ status: 'viewed', paid_at: null });
      // The sender's own paid check reads the committed row (still paid), then blocks on the claim lock.
      const sending = sendInvoiceReceipt(invoice.id);
      await waitForBlockedAdvisoryLock();
      await holder.commit();
      await expect(sending).resolves.toMatchObject({ status: 409, body: { code: 'invoice_not_paid' } });
      expect(emailSpy).not.toHaveBeenCalled();
      expect(textSpy).not.toHaveBeenCalled();
      expect(await database('receipt_delivery_jobs').where({ invoice_id: invoice.id })).toHaveLength(0);
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
      emailSpy.mockRestore();
      textSpy.mockRestore();
    }
  });

  it('an Undo that meets a receipt claim committed first sees it and refuses with the receipt reason', async () => {
    const { lockInvoiceReceiptClaim } = require('../services/receipt-delivery-queue');
    const invoice = await makeInvoice();
    await record(invoice.id);
    const holder = await database.transaction();
    try {
      // What the sender does inside its claim transaction: take the claim lock, insert the claim row. Not committed yet.
      await lockInvoiceReceiptClaim(holder, invoice.id);
      await holder('receipt_delivery_jobs').insert({ invoice_id: invoice.id, source: 'operator_send', status: 'running', locked_by: 'operator:synthetic' });
      const undoing = undo(invoice.id);
      await waitForBlockedAdvisoryLock();
      await holder.commit();
      await expect(undoing).rejects.toMatchObject({ statusCode: 409, code: 'receipt' });
      expect((await row(invoice.id)).status).toBe('paid');
    } finally {
      if (!holder.isCompleted()) await holder.rollback();
    }
  });

  it('describes eligibility with the same rules, for the Invoices page', async () => {
    const invoice = await makeInvoice();
    await record(invoice.id);
    await expect(describeManualPaymentUndo(invoice.id)).resolves.toMatchObject({ eligible: true, payment: { id: await shownPaymentId(invoice.id), amount: 100, method: 'check' } });
    await database('invoices').where({ id: invoice.id }).update({ receipt_sent_at: new Date() });
    await expect(describeManualPaymentUndo(invoice.id)).resolves.toMatchObject({
      eligible: false, code: 'receipt', message: expect.stringContaining('on the day it was recorded, before any receipt or reminder'),
    });
  });
});
