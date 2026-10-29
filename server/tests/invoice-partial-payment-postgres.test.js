// Real migrated PostgreSQL, synthetic records, deleted after every test.
// Runs in the existing DB-gated CI step or the owning worktree's private QA DB.
//
// Partial payments, the writer (GATE_PARTIAL_PAYMENTS, owner 2026-10-29). recordManualPayment and undoManualPayment are the REAL
// writers: the unit suites mock the tables and cannot show that the markers, the ledger rows and amount_paid agree. Committed rows
// (cleaned up after every test) so the writers' own transactions and locks run as in production.
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

postgres('Partial payments against migrated PostgreSQL', () => {
  let database;
  let recordManualPayment;
  let undoManualPayment;
  let describeManualPaymentUndo;
  let InvoiceService;
  let invoiceAmountDue;
  const customerIds = [];

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
    InvoiceService = require('../services/invoice');
    ({ invoiceAmountDue } = require('../services/invoice-helpers'));
  });

  beforeEach(() => {
    process.env.GATE_PARTIAL_PAYMENTS = 'true';
    process.env.GATE_UNDO_MANUAL_PAYMENT = 'true';
  });

  afterEach(async () => {
    delete process.env.GATE_PARTIAL_PAYMENTS;
    delete process.env.GATE_UNDO_MANUAL_PAYMENT;
    const ids = customerIds.splice(0);
    if (!ids.length) return;
    const invoiceIds = (await database('invoices').whereIn('customer_id', ids).pluck('id'));
    await database('audit_log').whereIn('resource_id', [...invoiceIds, ...ids]).del();
    await database('receipt_delivery_jobs').whereIn('invoice_id', invoiceIds).del();
    await database('invoice_followup_sequences').whereIn('invoice_id', invoiceIds).del();
    await database('payment_plans').whereIn('customer_id', ids).del();
    await database('activity_log').whereIn('customer_id', ids).del();
    await database('payments').whereIn('customer_id', ids).del();
    await database('payment_methods').whereIn('customer_id', ids).del();
    await database('invoices').whereIn('customer_id', ids).del();
    await database('customers').whereIn('id', ids).del();
  });

  afterAll(async () => { await database.destroy(); });

  async function makeCustomer(over = {}) {
    const [customer] = await database('customers')
      .insert({ first_name: 'Synthetic', last_name: 'Part', phone: `+1555555${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`.slice(0, 12), ...over })
      .returning('id');
    customerIds.push(customer.id);
    return customer.id;
  }

  async function makeInvoice(over = {}) {
    const customerId = over.customer_id || await makeCustomer();
    const [invoice] = await database('invoices').insert({
      token: randomUUID(),
      invoice_number: `INV-PART-${randomUUID().slice(0, 8)}`,
      status: 'viewed',
      subtotal: 100,
      total: 100,
      sent_at: new Date(Date.now() - 5 * 24 * 3600 * 1000),
      viewed_at: new Date(Date.now() - 4 * 24 * 3600 * 1000),
      notes: 'Seed note',
      ...over,
      customer_id: customerId,
    }).returning('*');
    return invoice;
  }

  // Like the Invoices page: an amount travels with the amount owed the page showed (read now, unless the case pins one).
  const record = async (invoiceId, over = {}) => {
    const seen = over.amountCents != null && over.owedCentsSeen === undefined
      ? { owedCentsSeen: Math.round(invoiceAmountDue(await database('invoices').where({ id: invoiceId }).first()) * 100) } : {};
    return recordManualPayment(invoiceId, {
      method: 'check', reference: '1042', note: 'check in hand', recordedBy: 'Synthetic Office', sendReceipt: false, ...seen, ...over,
    });
  };
  const row = (invoiceId) => database('invoices').where({ id: invoiceId }).first();
  async function shownPaymentId(invoiceId) {
    const description = await describeManualPaymentUndo(invoiceId);
    return description.payment?.id || randomUUID();
  }
  const undo = async (invoiceId, over = {}) => undoManualPayment(invoiceId, {
    reason: 'typed the wrong amount', undoneBy: 'Synthetic Office', paymentId: await shownPaymentId(invoiceId), ...over,
  });
  async function refusalOf(promise) {
    try { await promise; } catch (err) { return err; }
    throw new Error('expected a refusal');
  }
  const seedSequence = (invoice) => database('invoice_followup_sequences').insert({
    invoice_id: invoice.id, customer_id: invoice.customer_id, status: 'active', step_index: 1, touches_sent: 1, next_touch_at: new Date(Date.now() + 3600 * 1000),
  });

  it('the same part payment submitted twice at once records once: the second meets $60 owed, not the $100 the page showed', async () => {
    const invoice = await makeInvoice();
    const results = await Promise.allSettled([
      record(invoice.id, { amountCents: 4000, owedCentsSeen: 10000 }),
      record(invoice.id, { amountCents: 4000, owedCentsSeen: 10000 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused.reason).toMatchObject({ statusCode: 409 });
    expect(refused.reason.message).toMatch(/changed to \$60\.00/);
    expect(Number((await row(invoice.id)).amount_paid)).toBe(40);
    expect(await database('payments').where({ customer_id: invoice.customer_id })).toHaveLength(1);
  });

  it('Undo of a part waits while a saved-card charge for the rest is unresolved (a crash can roll the invoice back but keep the claim)', async () => {
    const invoice = await makeInvoice();
    await record(invoice.id, { amountCents: 4000 });
    await database('stripe_invoice_charge_attempts').insert({
      invoice_id: invoice.id, stripe_payment_method_id: 'pm_synthetic', idempotency_key: `synthetic-${invoice.id}`, status: 'ambiguous',
      submitted_at: new Date(),
    });
    try {
      const err = await refusalOf(undo(invoice.id));
      expect(err).toMatchObject({ statusCode: 409, code: 'card_charge_pending' });
      expect(Number((await row(invoice.id)).amount_paid)).toBe(40);
      expect((await describeManualPaymentUndo(invoice.id)).code).toBe('card_charge_pending');
    } finally {
      await database('stripe_invoice_charge_attempts').where({ invoice_id: invoice.id }).del();
    }
  });

  it('a part payment adds to amount_paid and leaves the invoice open: same status, reminders running, one ledger row, no receipt', async () => {
    const invoice = await makeInvoice();
    await seedSequence(invoice);

    const out = await record(invoice.id, { amountCents: 4000 });

    expect(out.partial).toEqual({ amount: 40, remaining: 60 });
    expect(out.receipt).toBeNull();
    const after = await row(invoice.id);
    expect(after.status).toBe('viewed');
    expect(Number(after.amount_paid)).toBe(40);
    expect(Number(after.total)).toBe(100);
    expect(after.paid_at).toBeNull();
    expect(after.payment_method).toBeNull();
    expect(after.payment_recorded_at).not.toBeNull();
    expect(after.payment_recorded_by).toBe('Synthetic Office');
    expect(after.notes).toMatch(/^Seed note\n\[\d{4}-\d{2}-\d{2}\] CHECK 1042: check in hand$/);
    expect(invoiceAmountDue(after)).toBe(60);
    // Reminders continue for the remainder; nothing was sent or queued.
    expect((await database('invoice_followup_sequences').where({ invoice_id: invoice.id }).first()).status).toBe('active');
    expect(after.receipt_sent_at).toBeNull();
    expect(await database('receipt_delivery_jobs').where({ invoice_id: invoice.id })).toHaveLength(0);
    // One paid ledger row for the part, linked to the invoice; both markers for Undo.
    const payments = await database('payments').where({ customer_id: invoice.customer_id });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ status: 'paid', processor: null });
    expect(Number(payments[0].amount)).toBe(40);
    expect(payments[0].metadata).toEqual({ invoice_id: invoice.id, partial_payment: true });
    const markers = await database('audit_log').where({ resource_id: invoice.id }).whereIn('action', ['invoice.manual_payment_recorded', 'invoice.manual_payment_effects_done']);
    expect(markers.map((m) => m.action).sort()).toEqual(['invoice.manual_payment_effects_done', 'invoice.manual_payment_recorded']);
    expect(markers.find((m) => m.action === 'invoice.manual_payment_recorded').metadata).toMatchObject({ partial: true, amount: 40, paymentId: payments[0].id });
    expect(await database('activity_log').where({ customer_id: invoice.customer_id, action: 'invoice_part_payment_recorded' })).toHaveLength(1);
  });

  it('a second part equal to the remainder flips the invoice paid, zeroes amount_paid, and the receipt reads the whole bill', async () => {
    const invoice = await makeInvoice();
    await seedSequence(invoice);
    await record(invoice.id, { amountCents: 4000 });

    // The page's default amount is what is still owed: the whole balance, today's paid flip.
    const out = await record(invoice.id, { amountCents: 6000, method: 'cash', reference: undefined, note: undefined });

    expect(out.partial).toBeUndefined();
    const paid = await row(invoice.id);
    expect(paid.status).toBe('paid');
    expect(Number(paid.amount_paid)).toBe(0);
    expect(Number(paid.total)).toBe(100);
    expect(paid.payment_method).toBe('cash');
    expect((await database('invoice_followup_sequences').where({ invoice_id: invoice.id }).first()).status).toBe('completed');
    // Two ledger rows: the part and the remainder. Together the whole bill; cash received is not double counted.
    const payments = await database('payments').where({ customer_id: invoice.customer_id }).orderBy('created_at', 'asc');
    expect(payments.map((p) => Number(p.amount))).toEqual([40, 60]);
    expect(payments.every((p) => p.status === 'paid')).toBe(true);
    expect(payments[1].metadata).toMatchObject({ invoice_id: invoice.id, completes_part_payments: true, amount_paid_before: 40 });
    // The receipt's figure: the whole bill, not only the last part.
    expect(invoiceAmountDue(paid)).toBe(100);
    expect(await InvoiceService.receiptAmountFor(paid)).toBe('100.00');
  });

  it('Undo of a part restores amount_paid and the invoice columns, cancels only that ledger row, and re-arms nothing', async () => {
    const invoice = await makeInvoice();
    await seedSequence(invoice);
    await record(invoice.id, { amountCents: 4000 });
    const before = await row(invoice.id);

    const described = await describeManualPaymentUndo(invoice.id);
    expect(described).toMatchObject({ eligible: true, payment: { amount: 40, method: 'check', part: true } });

    const result = await undo(invoice.id);

    expect(result.payment).toMatchObject({ amount: 40, method: 'check' });
    const after = await row(invoice.id);
    expect(after.status).toBe('viewed');
    expect(Number(after.amount_paid)).toBe(0);
    expect(after).toMatchObject({ payment_recorded_at: null, payment_recorded_by: null, notes: 'Seed note' });
    expect(before.notes).not.toBe('Seed note');
    const payments = await database('payments').where({ customer_id: invoice.customer_id });
    expect(payments).toHaveLength(1);
    expect(payments[0].status).toBe('canceled');
    expect(payments[0].metadata.manualPaymentUndo).toMatchObject({ amount: 40, part: true, method: 'check' });
    // The part stopped nothing, so nothing is re-armed: the sequence was never touched.
    expect((await database('invoice_followup_sequences').where({ invoice_id: invoice.id }).first()).status).toBe('active');
    expect(invoiceAmountDue(after)).toBe(100);
    // Once undone it is not offered or undone again.
    expect((await describeManualPaymentUndo(invoice.id)).eligible).toBe(false);
    const again = await refusalOf(undoManualPayment(invoice.id, { reason: 'again', paymentId: result.payment.id }));
    expect(again.statusCode).toBe(409);
  });

  it('Undo of the final payment of a part-paid invoice reopens it with the earlier part still on it', async () => {
    const invoice = await makeInvoice();
    await seedSequence(invoice);
    await record(invoice.id, { amountCents: 4000 });
    await record(invoice.id, { amountCents: 6000, method: 'cash' });
    expect((await row(invoice.id)).status).toBe('paid');

    const described = await describeManualPaymentUndo(invoice.id);
    expect(described).toMatchObject({ eligible: true, payment: { amount: 60, method: 'cash', part: false } });
    await undo(invoice.id);

    const reopened = await row(invoice.id);
    expect(reopened.status).toBe('viewed');
    expect(Number(reopened.amount_paid)).toBe(40);
    expect(reopened).toMatchObject({ paid_at: null, payment_method: null });
    expect(invoiceAmountDue(reopened)).toBe(60);
    const payments = await database('payments').where({ customer_id: invoice.customer_id }).orderBy('created_at', 'asc');
    expect(payments.map((p) => [Number(p.amount), p.status])).toEqual([[40, 'paid'], [60, 'canceled']]);
    // The reminder sequence is back on its stored step.
    expect((await database('invoice_followup_sequences').where({ invoice_id: invoice.id }).first()).status).toBe('active');
    // The invoice was edited by the Undo itself, so the earlier part is no longer the last thing that happened to it.
    const earlier = await describeManualPaymentUndo(invoice.id);
    expect(earlier).toMatchObject({ eligible: false, code: 'too_late' });
  });

  it('an invoice with a part payment on it answers Undo only for the part, and refuses once the customer opened a payment page', async () => {
    const invoice = await makeInvoice();
    await record(invoice.id, { amountCents: 2500 });
    await database('invoices').where({ id: invoice.id }).update({ stripe_payment_intent_id: 'pi_synthetic_open' });

    const described = await describeManualPaymentUndo(invoice.id);
    expect(described).toMatchObject({ eligible: false, code: 'payment_session' });
    const err = await refusalOf(undoManualPayment(invoice.id, { reason: 'x', paymentId: randomUUID() }));
    expect(err.statusCode).toBe(409);
    expect(Number((await row(invoice.id)).amount_paid)).toBe(25);
  });

  it('refuses a part for an Auto Pay customer and writes nothing', async () => {
    const customerId = await makeCustomer({ autopay_enabled: true });
    await database('payment_methods').insert({
      customer_id: customerId, processor: 'stripe', is_default: true, autopay_enabled: true, method_type: 'card',
      stripe_payment_method_id: `pm_synthetic_${randomUUID().slice(0, 8)}`, exp_month: '12', exp_year: '2099', card_brand: 'visa', last_four: '4242',
    });
    const invoice = await makeInvoice({ customer_id: customerId });

    const err = await refusalOf(record(invoice.id, { amountCents: 4000 }));

    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('This customer is on Auto Pay, so a part payment cannot be recorded on this invoice yet. Nothing was recorded.');
    const after = await row(invoice.id);
    expect(Number(after.amount_paid)).toBe(0);
    expect(after.payment_recorded_at).toBeNull();
    expect(await database('payments').where({ customer_id: customerId })).toHaveLength(0);
    // The same customer can still pay the whole balance by hand.
    const full = await record(invoice.id, { amountCents: 10000 });
    expect(full.invoice.status).toBe('paid');
  });

  it('refuses a part on an invoice with a payment plan, with the gate off, and for more than is owed', async () => {
    const withPlan = await makeInvoice();
    await database('payment_plans').insert({
      customer_id: withPlan.customer_id, invoice_id: withPlan.id, total_balance: 100, payment_amount: 25, payment_frequency: 'monthly',
      plan_start_date: '2030-01-01', next_payment_date: '2030-02-01', status: 'active',
    });
    const planErr = await refusalOf(record(withPlan.id, { amountCents: 4000 }));
    expect(planErr).toMatchObject({ statusCode: 409 });
    expect(planErr.message).toMatch(/payment plan/);

    const plain = await makeInvoice();
    process.env.GATE_PARTIAL_PAYMENTS = 'false';
    expect((await refusalOf(record(plain.id, { amountCents: 4000 }))).message).toMatch(/Part payments are not turned on/);
    process.env.GATE_PARTIAL_PAYMENTS = 'true';
    expect((await refusalOf(record(plain.id, { amountCents: 10001 }))).message).toBe('That is more than the $100.00 still owed on this invoice. Nothing was recorded.');
    for (const invoice of [withPlan, plain]) {
      expect(Number((await row(invoice.id)).amount_paid)).toBe(0);
      expect(await database('payments').where({ customer_id: invoice.customer_id })).toHaveLength(0);
    }
  });

  it('an invoice with a part payment cannot be voided or have its amounts edited, and no Zelle notice matches it', async () => {
    const invoice = await makeInvoice();
    const sibling = await makeInvoice({ customer_id: invoice.customer_id, total: 60, subtotal: 60 });
    await record(invoice.id, { amountCents: 4000 });

    const voidErr = await refusalOf(InvoiceService.voidInvoice(invoice.id));
    expect(voidErr.message).toMatch(/^Cannot void an invoice with a part payment on it/);
    const editErr = await refusalOf(InvoiceService.update(invoice.id, { line_items: [{ description: 'Service', quantity: 1, unit_price: 120 }] }));
    expect(editErr.message).toMatch(/part payment on it, so its amounts cannot be edited/);
    expect((await row(invoice.id)).status).toBe('viewed');

    // The remainder is $60, the same as the sibling invoice: only the untouched invoice matches a $60 notice.
    const { openSelfPayInvoicesByAmountDue } = require('../services/open-balance');
    const matches = (await openSelfPayInvoicesByAmountDue(6000)).map((r) => r.id);
    expect(matches).toContain(sibling.id);
    expect(matches).not.toContain(invoice.id);
    // And the writer refuses the reconciler by itself.
    const auto = await refusalOf(recordManualPayment(invoice.id, {
      method: 'zelle', automated: true, requireSelfPay: true, expectedAmountCents: 6000, sendReceipt: false,
    }));
    expect(auto.statusCode).toBe(409);
    expect(auto.message).toMatch(/Zelle notice cannot settle it by itself/);
  });
});
