/**
 * W9 billing readers against real Postgres: balances equal the Invoices
 * page's canonical numbers, an attempt is never "received", the paid invoice
 * is, a same-surname customer's invoices never appear, pagination is exact,
 * the readers write nothing, and a technician gets no tool. Synthetic data
 * only; no model, provider or network call.
 */
const crypto = require('crypto');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const databaseUrl = process.env.IB_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('billing readers (get_customer_invoices, get_invoice_detail)', () => {
  let db; let registry; let execute; let helpers; let etDateString;
  const originalEnv = { ...process.env };
  const uid = () => crypto.randomUUID();
  const digits = () => String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  const day = (offset) => etDateString(new Date(Date.now() + offset * 86400000));
  const run = crypto.randomBytes(3).toString('hex');
  const SURNAME = `Quillfeather${run}`;
  let A; let B; let H; let C; let D; let E; let F; let G; let P;
  const inv = {}; // seeded invoices by key
  const tokens = [];

  async function customer(first, last, extra = {}) {
    const id = uid();
    await db('customers').insert({ id, first_name: first, last_name: last, phone: `+1555${digits()}0`.slice(0, 12), address_line1: '100 Example Court', ...extra });
    return id;
  }
  async function invoice(key, customerId, fields) {
    const id = uid();
    const token = crypto.randomBytes(16).toString('hex');
    tokens.push(token);
    const row = {
      id, token, invoice_number: `QA${run}-${key}`.toUpperCase(), customer_id: customerId, title: `Synthetic ${key}`,
      subtotal: fields.total, total: fields.total, status: 'sent', due_date: day(10), line_items: JSON.stringify([
        { description: `Service ${key}`, quantity: 1, unit_price: fields.total, amount: fields.total, category: 'service' },
      ]), ...fields,
    };
    await db('invoices').insert(row);
    inv[key] = { ...row };
    return row;
  }
  const admin = { role: 'admin', context: 'platform', actionContext: { isAdmin: true } };
  const read = (name, input, actionContext = {}) => execute(name, input, { ...admin, actionContext: { isAdmin: true, ...actionContext } });
  const json = (value) => JSON.stringify(value);

  async function snapshot() {
    const q = (table) => db(table).whereIn('customer_id', [A, B, H, C, D, E, F]).count('* as n').first();
    return {
      invoices: await db('invoices').whereIn('customer_id', [A, B, H, C, D, E, F]).select('id', 'status', 'total', 'credit_applied', 'updated_at').orderBy('id'),
      payments: await q('payments'), attempts: await db('stripe_invoice_charge_attempts').count('* as n').first(),
      ledger: await q('customer_credit_ledger'), notifications: await db('notifications').count('* as n').first(),
      credits: await db('customers').whereIn('id', [A, B, H, C, D, E, F]).select('id', 'account_credits').orderBy('id'),
    };
  }

  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    const ciDatabase = process.env.CI === 'true' && parsed.hostname === 'localhost' && parsed.pathname === '/waves_test';
    if (!ciDatabase && !/^\/waves_ib_platform_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('An isolated IB development database is required');
    Object.assign(process.env, { DATABASE_URL: databaseUrl, NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(32).toString('hex'), GATE_IB_PLATFORM: 'true' });
    db = require('../models/db');
    registry = require('../services/intelligence-bar/action-registry');
    execute = (name, input, scope) => registry.execute(name, input, { role: scope.role, context: scope.context, actionContext: scope.actionContext });
    helpers = require('../services/invoice-helpers');
    ({ etDateString } = require('../utils/datetime-et'));

    A = await customer(`Thessaly${run}`, SURNAME, { account_credits: 25 });
    B = await customer(`Orville${run}`, SURNAME);
    H = await customer('Marguerite', `Holdout${run}`);
    // Paid by a recorded manual payment (linked by the portal's description rule).
    const paid = await invoice('paid', A, { total: 120, status: 'paid', paid_at: new Date(), due_date: day(-30), payment_method: 'check',
      payment_reference: 'CHK-1001', payment_recorded_by: 'Synthetic Operator', payment_recorded_at: new Date() });
    await db('payments').insert({ customer_id: A, payment_date: day(-29), amount: 120, status: 'paid', description: `Invoice ${paid.invoice_number} — check (CHK-1001)` });
    // Paid by a Stripe charge: a succeeded attempt AND the ledger row carrying the same PaymentIntent.
    const paidCard = await invoice('paidcard', A, { total: 90, status: 'paid', paid_at: new Date(), due_date: day(-20), stripe_payment_intent_id: `pi_paid_${run}` });
    await db('stripe_invoice_charge_attempts').insert({ invoice_id: paidCard.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-paid-${run}`,
      status: 'succeeded', stripe_payment_intent_id: `pi_paid_${run}`, amount: 90, resolved_at: new Date(), submitted_at: new Date() });
    await db('payments').insert({ customer_id: A, payment_date: day(-19), amount: 90, status: 'paid', processor: 'stripe',
      stripe_payment_intent_id: `pi_paid_${run}`, description: 'Stripe card payment', metadata: JSON.stringify({ invoice_id: paidCard.id }) });
    // Open and overdue: a failed attempt, an in-flight (claimed, submitted) attempt, a processing payment row, a failed payment row.
    const open = await invoice('open', A, { total: 200, status: 'overdue', due_date: day(-12), stripe_payment_intent_id: `pi_open_${run}` });
    await db('stripe_invoice_charge_attempts').insert([
      { invoice_id: open.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-open-failed-${run}`, status: 'failed', amount: 200,
        error_message: 'Your card was declined for synthetic.person@example.com', decline_code: 'card_declined', resolved_at: new Date(), created_at: new Date(Date.now() - 3600e3) },
      { invoice_id: open.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-open-claimed-${run}`, status: 'claimed', amount: 200, submitted_at: new Date() },
    ]);
    await db('payments').insert([
      { customer_id: A, payment_date: day(-1), amount: 200, status: 'processing', processor: 'stripe', stripe_payment_intent_id: `pi_open_${run}`, description: 'ACH in flight', metadata: JSON.stringify({ invoice_id: open.id }) },
      { customer_id: A, payment_date: day(-2), amount: 200, status: 'failed', processor: 'stripe', description: 'Card declined', failure_reason: 'declined for jane.doe@example.com card 4242 4242 4242 4242', metadata: JSON.stringify({ invoice_id: open.id }) },
    ]);
    await db('payment_plans').insert({ customer_id: A, invoice_id: open.id, total_balance: 200, payment_amount: 50, payment_frequency: 'monthly', plan_start_date: day(0), next_payment_date: day(30) });
    // Applied credit: owes total minus credit.
    const credited = await invoice('credited', A, { total: 150, credit_applied: 50, due_date: day(15) });
    await db('customer_credit_ledger').insert([
      { customer_id: A, delta: 75, balance_after: 75, source: 'manual', note: 'Goodwill credit' },
      { customer_id: A, delta: -50, balance_after: 25, source: 'invoice_application', invoice_id: credited.id, note: 'Applied to invoice' },
    ]);
    await invoice('draft', A, { total: 40, status: 'draft', due_date: null });
    await invoice('archived', A, { total: 33, archived_at: new Date() });
    await invoice('orphan', A, { total: 60, due_date: day(5) });
    await db('stripe_orphan_charges').insert({ stripe_payment_intent_id: `pi_orphan_${run}`, customer_id: A, invoice_id: inv.orphan.id, amount: 60, source: 'invoice_payment_webhook', original_db_error: 'synthetic ledger failure' });
    await invoice('voided', A, { total: 77, status: 'void' });
    // Pagination filler so A has more than one page at a small limit.
    for (let n = 0; n < 4; n += 1) await invoice(`fill${n}`, A, { total: 10 + n, due_date: day(20 + n) });
    // Same-surname neighbour with loud sentinels, and a dispute-hold customer.
    await invoice('b_open', B, { total: 999.99, title: `SENTINEL-B-${run}`, status: 'overdue', due_date: day(-40) });
    await invoice('b_paid', B, { total: 55.55, status: 'paid', title: `SENTINEL-B-PAID-${run}` });
    // A combined payment: one PaymentIntent, one payments row per invoice, each with its own metadata.invoice_id.
    C = await customer(`Combined${run}`, `Settler${run}`);
    const pi = `pi_comb_${run}`;
    await invoice('c1', C, { total: 70, status: 'paid', paid_at: new Date(), stripe_payment_intent_id: pi });
    await invoice('c2', C, { total: 30, status: 'paid', paid_at: new Date(), stripe_payment_intent_id: pi });
    for (const [key, amount] of [['c1', 70], ['c2', 30]]) {
      await db('payments').insert({ customer_id: C, payment_date: day(-1), amount, status: 'paid', processor: 'stripe', stripe_payment_intent_id: pi,
        description: `Invoice ${inv[key].invoice_number} (combined balance payment)`, metadata: JSON.stringify({ invoice_id: inv[key].id, combined_payment: true }) });
    }
    // A provisional ACH residual (cash not arrived yet) on a third invoice, keyed "<pi>:<invoice id>".
    await invoice('c3', C, { total: 45, status: 'processing' });
    await db('stripe_orphan_charges').insert({ stripe_payment_intent_id: `pi_ach_${run}:${inv.c3.id}`, customer_id: C, invoice_id: inv.c3.id, amount: 45,
      source: 'combined_pay_processing', original_db_error: 'synthetic provisional residual' });
    // Saved-card payments that were later refunded and disputed, and a saved-bank (ACH) orphan that may still be pending.
    D = await customer(`Reversal${run}`, `Ledger${run}`);
    const refunded = await invoice('d_ref', D, { total: 50, status: 'refunded', stripe_payment_intent_id: `pi_ref_${run}` });
    const disputed = await invoice('d_dis', D, { total: 60, status: 'paid', paid_at: new Date(), stripe_payment_intent_id: `pi_dis_${run}` });
    for (const [row, status, refund] of [[refunded, 'refunded', 50], [disputed, 'disputed', 0]]) {
      await db('stripe_invoice_charge_attempts').insert({ invoice_id: row.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-${row.id}`,
        status: 'succeeded', stripe_payment_intent_id: row.stripe_payment_intent_id, amount: row.total, resolved_at: new Date(), submitted_at: new Date() });
      await db('payments').insert({ customer_id: D, payment_date: day(-3), amount: row.total, status, refund_amount: refund, processor: 'stripe',
        stripe_payment_intent_id: row.stripe_payment_intent_id, description: 'Stripe card payment', metadata: JSON.stringify({ invoice_id: row.id }) });
    }
    await invoice('d_ach', D, { total: 25, due_date: day(5) });
    await db('stripe_orphan_charges').insert({ stripe_payment_intent_id: `pi_bank_${run}`, customer_id: D, invoice_id: inv.d_ach.id, amount: 25,
      source: 'invoice_card_on_file', original_db_error: 'synthetic ledger failure' });
    // Overlapping subsets (a payer-billed draft) and a credit-only settlement (a succeeded attempt with no PaymentIntent).
    E = await customer(`Overlap${run}`, `Sorter${run}`);
    const [payer] = await db('payers').insert({ display_name: `Synthetic Payer ${run}` }).returning('id');
    const payerId = payer.id || payer;
    await invoice('e_self', E, { total: 100 });
    await invoice('e_draft', E, { total: 40, status: 'draft', due_date: null });
    await invoice('e_payer_draft', E, { total: 30, status: 'draft', due_date: null, payer_id: payerId });
    await invoice('e_payer_sent', E, { total: 20, payer_id: payerId });
    const creditPaid = await invoice('e_credit', E, { total: 80, status: 'paid', paid_at: new Date(), credit_applied: 80 });
    await db('stripe_invoice_charge_attempts').insert({ invoice_id: creditPaid.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-credit-${run}`,
      status: 'succeeded', amount: 0, credit_applied_delta: 80, credit_applied_total: 80, resolved_at: new Date(), submitted_at: new Date() });
    // More attempts than the timeline reads: the newest (an unresolved charge) must survive and the summary must not claim "none".
    F = await customer(`Bounded${run}`, `History${run}`);
    const busy = await invoice('f_busy', F, { total: 70 });
    const attemptRows = [];
    for (let n = 0; n < 51; n += 1) {
      attemptRows.push({ invoice_id: busy.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-busy-${run}-${n}`, status: 'failed', amount: 70,
        error_message: 'declined', resolved_at: new Date(), created_at: new Date(Date.now() - (100 - n) * 3600e3) });
    }
    attemptRows.push({ invoice_id: busy.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-busy-${run}-claimed`, status: 'claimed', amount: 70, submitted_at: new Date() });
    await db('stripe_invoice_charge_attempts').insert(attemptRows);
    // One declined saved-card attempt leaves a payments row AND an attempt row sharing the idempotency key; an open invoice whose attached PaymentIntent has no recorded outcome.
    const dup = await invoice('f_dup', F, { total: 25 });
    await db('stripe_invoice_charge_attempts').insert({ invoice_id: dup.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `inv_card_on_file_${dup.id}_x${run}`,
      status: 'failed', amount: 25, error_message: 'declined', decline_code: 'card_declined', resolved_at: new Date() });
    await db('payments').insert({ customer_id: F, payment_date: day(0), amount: 25, status: 'failed', processor: 'stripe', description: `Invoice ${dup.invoice_number} — card on file (FAILED)`,
      failure_reason: 'declined', metadata: JSON.stringify({ invoice_id: dup.id, source: 'card_on_file_failed_attempt', idempotency_key: `inv_card_on_file_${dup.id}_x${run}` }) });
    await invoice('f_pi', F, { total: 20, stripe_payment_intent_id: `pi_attached_${run}` });
    // Round-1 review findings: payer-funded settlements, dispute alias linkage, an unsubmitted claimed attempt.
    G = await customer(`Findings${run}`, `Reviewed${run}`);
    const [funder] = await db('payers').insert({ display_name: `Synthetic Funder ${run}` }).returning('id');
    const funderId = funder.id || funder;
    // Legacy shape: a settlement keyed to the homeowner through customer_id + metadata.invoice_id on a payer-billed invoice.
    const gPayer = await invoice('g_payer', G, { total: 400, status: 'paid', paid_at: new Date(), payer_id: funderId });
    await db('payments').insert({ customer_id: G, payment_date: day(-1), amount: 400, status: 'paid', description: 'Synthetic payer settlement', metadata: json({ invoice_id: gPayer.id }) });
    // A self-billed invoice whose payment row carries metadata.payer_id, and one carrying the payments.payer_id column.
    const gPayerMeta = await invoice('g_payer_meta', G, { total: 300, status: 'paid', paid_at: new Date() });
    await db('payments').insert({ customer_id: G, payment_date: day(-1), amount: 300, status: 'paid', description: 'Synthetic payer meta', metadata: json({ invoice_id: gPayerMeta.id, payer_id: String(funderId) }) });
    const gPayerCol = await invoice('g_payer_col', G, { total: 200, status: 'paid', paid_at: new Date() });
    await db('payments').insert({ customer_id: G, payer_id: funderId, payment_date: day(-1), amount: 200, status: 'paid', description: 'Synthetic payer column', metadata: json({ invoice_id: gPayerCol.id }) });
    // A disputed card-on-file payment on a reopened invoice: the webhook cleared the invoice's Stripe ids and left only dispute_invoice_id.
    const gDispute = await invoice('g_dispute', G, { total: 150, status: 'overdue', due_date: day(-3) });
    await db('payments').insert({ customer_id: G, payment_date: day(-5), amount: 150, status: 'disputed', processor: 'stripe', stripe_payment_intent_id: `pi_gd_${run}`,
      description: 'Stripe card payment', metadata: json({ dispute_invoice_id: gDispute.id }) });
    const gAlias = await invoice('g_alias', G, { total: 60, status: 'paid', paid_at: new Date() });
    await db('payments').insert({ customer_id: G, payment_date: day(-5), amount: 60, status: 'paid', processor: 'stripe', stripe_payment_intent_id: `pi_ga_${run}`,
      description: 'Stripe card payment', metadata: json({ waves_invoice_id: gAlias.id }) });
    // A claimed attempt that was never submitted to Stripe: still unconfirmed, never "not received".
    const gClaim = await invoice('g_claim', G, { total: 35 });
    await db('stripe_invoice_charge_attempts').insert({ invoice_id: gClaim.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-gclaim-${run}`, status: 'claimed', amount: 35 });
    // A saved-bank charge in flight: a processing payments row (PaymentIntent, no key) and a claimed attempt row (key + same PaymentIntent).
    const gBank = await invoice('g_bank', G, { total: 55, status: 'sent' });
    await db('payments').insert({ customer_id: G, payment_date: day(0), amount: 55, status: 'processing', processor: 'stripe', stripe_payment_intent_id: `pi_gb_${run}`,
      description: 'Saved bank payment', metadata: json({ invoice_id: gBank.id }) });
    await db('stripe_invoice_charge_attempts').insert({ invoice_id: gBank.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-gbank-${run}`, status: 'claimed', amount: 55,
      stripe_payment_intent_id: `pi_gb_${run}`, submitted_at: new Date() });
    // A saved-card DB failure: a succeeded attempt and an invoice_card_on_file orphan for the SAME PaymentIntent are one charge.
    const gBoth = await invoice('g_both', G, { total: 45, status: 'paid', paid_at: new Date(), stripe_payment_intent_id: `pi_both_${run}` });
    await db('stripe_invoice_charge_attempts').insert({ invoice_id: gBoth.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-gboth-${run}`, status: 'succeeded', amount: 45,
      stripe_payment_intent_id: `pi_both_${run}`, resolved_at: new Date(), submitted_at: new Date() });
    await db('stripe_orphan_charges').insert({ stripe_payment_intent_id: `pi_both_${run}`, customer_id: G, invoice_id: gBoth.id, amount: 45, source: 'invoice_card_on_file', original_db_error: 'synthetic ledger failure' });
    // More payment rows than the reader keeps: whether a payment was recorded is unknown.
    P = await customer(`Bulk${run}`, `Payments${run}`);
    const bulk = await invoice('p_bulk', P, { total: 90 });
    await db.batchInsert('payments', Array.from({ length: 501 }, (_, n) => ({ customer_id: P, payment_date: day(-1), amount: 5, status: 'failed', processor: 'stripe',
      description: `Synthetic failed ${n}`, metadata: json({ invoice_id: bulk.id }) })), 100);
    await invoice('h_open', H, { total: 80 });
    await db('collections_flags').insert({ customer_id: H, flag: 'collection_hold', reason: 'dispute on call: synthetic' });
  }, 60000);

  afterAll(async () => {
    if (db) await db.destroy();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  // ─── the oracle: the Invoices page's own stats SQL, scoped to one customer ───
  async function pageOracle(customerId) {
    const open = ['paid', 'prepaid', 'processing', 'void', 'refunded', 'canceled', 'cancelled'];
    const marks = open.map(() => '?').join(',');
    const { rows: [r] } = await db.raw(`
      SELECT COUNT(*) FILTER (WHERE status NOT IN (${marks})) AS outstanding,
             COUNT(*) FILTER (WHERE status NOT IN (${marks}) AND (status = 'overdue' OR due_date < ?)) AS overdue,
             COALESCE(SUM(GREATEST(total - COALESCE(credit_applied, 0), 0)) FILTER (WHERE status NOT IN (${marks})), 0) AS total_outstanding
        FROM invoices WHERE customer_id = ? AND archived_at IS NULL`, [...open, ...open, day(0), ...open, customerId]);
    return { outstanding: Number(r.outstanding), overdue: Number(r.overdue), total: Number(r.total_outstanding) };
  }

  test('account summary equals the Invoices page numbers and the canonical amount-due helper', async () => {
    const result = await read('get_customer_invoices', { customer_id: A });
    expect(result.error).toBeUndefined();
    const oracle = await pageOracle(A);
    expect(result.account_summary).toMatchObject({ total_due: oracle.total, outstanding_count: oracle.outstanding, overdue_count: oracle.overdue, complete: true });
    // The same total by the shared helper over the raw rows (open, credited, draft, orphan, fillers; not archived, paid or void).
    const rows = await db('invoices').where({ customer_id: A }).whereNull('archived_at').whereNotIn('status', helpers.INVOICE_UNCOLLECTIBLE_STATUSES);
    const byHelper = rows.reduce((sum, row) => sum + Math.round(helpers.invoiceAmountDue(row) * 100), 0) / 100;
    expect(result.account_summary.total_due).toBe(byHelper);
    // 200 open + 100 credited (150 - 50) + 40 draft + 60 orphan + 10+11+12+13 fillers.
    expect(result.account_summary.total_due).toBe(446);
    expect(result.account_summary.not_yet_sent_due).toBe(40);
    expect(result.account_summary.overdue_count).toBe(1);
    expect(result.account_summary.dispute_hold).toMatchObject({ active: false });
    const credited = result.invoices.find((i) => i.id === inv.credited.id);
    expect(credited).toMatchObject({ total: 150, credit_applied: 50, amount_due_after_credit: 100, balance_due: 100 });
  });

  test('account credit comes from the ledger and is checked against it', async () => {
    const { account_summary: summary } = await read('get_customer_invoices', { customer_id: A });
    expect(summary).toMatchObject({ credit_balance: 25, credit_ledger_sum: 25, credit_matches_ledger: true });
  });

  test('per-invoice fields: settled invoices owe nothing, the archived one is flagged, plan and hold are stated', async () => {
    const result = await read('get_customer_invoices', { customer_id: A, include_archived: true, limit: 50 });
    const by = (key) => result.invoices.find((i) => i.id === inv[key].id);
    expect(by('paid')).toMatchObject({ status: 'paid', balance_due: 0, amount_paid: 120, payment_recorded: true, overdue: false });
    expect(by('voided')).toMatchObject({ status: 'void', balance_due: 0, overdue: false });
    expect(by('archived')).toMatchObject({ archived: true, balance_due: 33 });
    expect(by('open')).toMatchObject({ status: 'overdue', balance_due: 200, overdue: true, has_active_payment_plan: true, payment_recorded: false, amount_paid: 0 });
    expect(by('open').payment_plan).toMatchObject({ payment_amount: 50, payment_frequency: 'monthly', total_balance: 200 });
    expect(by('open').due_date).toBe(inv.open.due_date);
    expect(by('draft')).toMatchObject({ status: 'draft', balance_due: 40 });
    expect(result.invoices.every((i) => 'dispute_hold' in i && 'annual_prepay' in i && 'archived' in i)).toBe(true);
    const hidden = await read('get_customer_invoices', { customer_id: A, limit: 50 });
    expect(hidden.invoices.some((i) => i.id === inv.archived.id)).toBe(false);
  });

  test('a dispute hold is stated, for that customer only', async () => {
    const held = await read('get_customer_invoices', { customer_id: H });
    expect(held.account_summary.dispute_hold.active).toBe(true);
    expect(held.invoices[0].dispute_hold).toBe(true);
    const detail = await read('get_invoice_detail', { invoice_id: inv.h_open.id });
    expect(detail.dispute_hold.active).toBe(true);
    const other = await read('get_customer_invoices', { customer_id: A });
    expect(other.invoices.every((i) => i.dispute_hold === false)).toBe(true);
  });

  test('failed, in-flight and processing attempts are attempts with their state, never received', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.open.id });
    expect(detail.error).toBeUndefined();
    const timeline = detail.payments_timeline;
    expect(timeline.some((e) => e.received === true)).toBe(false);
    const failedCharge = timeline.find((e) => e.type === 'stripe_charge_attempt' && e.state === 'failed');
    expect(failedCharge).toMatchObject({ received: false, decline_code: 'card_declined' });
    const inFlight = timeline.find((e) => e.type === 'stripe_charge_attempt' && e.state === 'claimed');
    expect(inFlight).toMatchObject({ received: false, state_label: expect.stringMatching(/processing/) });
    // A submitted-but-unresolved charge may already have charged the customer: its note never says "Not received".
    expect(inFlight.state_note).toMatch(/receipt unconfirmed/);
    expect(inFlight.state_note).toMatch(/do not retry/i);
    expect(inFlight.state_note).not.toMatch(/Not received/);
    const processing = timeline.find((e) => e.type === 'payment_attempt' && e.status === 'processing');
    expect(processing).toMatchObject({ received: false });
    const failedRow = timeline.find((e) => e.type === 'payment_attempt' && e.status === 'failed');
    expect(failedRow).toMatchObject({ received: false });
    expect(timeline.some((e) => e.type === 'recorded_payment')).toBe(false);
    expect(detail.payment_summary).toMatchObject({ received: false, recorded_payments_net: 0, attempts_in_flight_or_unknown: 2, attempts_failed_or_canceled: 2 });
    // The submitted-but-unresolved charge may already have succeeded: unconfirmed, not "not received".
    expect(detail.payment_summary).toMatchObject({ payments_pending: 1, attempts_unknown_outcome: 1 });
    expect(detail.payment_summary.statement).toMatch(/^Payment receipt is not confirmed/);
    expect(detail.payment_summary.statement).not.toMatch(/^No payment has been received/);
    expect(detail.payment_summary.statement).toMatch(/do not retry the charge/);
    expect(detail.invoice).toMatchObject({ status: 'overdue', balance_due: 200, overdue: true });
    expect(detail.payment_plan.active).toMatchObject({ payment_amount: 50, payment_frequency: 'monthly' });
    expect(detail.payment_plan.installments).toMatch(/unknown here/);
    expect(detail.unknowns.join(' ')).toMatch(/PaymentIntent/);
  });

  test('the manually paid invoice is received: recorded payment with method, reference and date', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.paid.id });
    expect(detail.payment_summary).toMatchObject({ received: true, recorded_payments_net: 120, stripe_succeeded_not_in_ledger: 0 });
    expect(detail.payment_summary.statement).toMatch(/^Payment was received/);
    const manual = detail.payments_timeline.find((e) => e.type === 'recorded_payment');
    expect(manual).toMatchObject({ received: true, status: 'paid', amount: 120, method: 'check', reference: 'CHK-1001', recorded_by: 'Synthetic Operator', linked_by: 'description', source: 'manual' });
    expect(manual.payment_date).toBe(day(-29));
    expect(detail.payments_timeline.filter((e) => e.type !== 'recorded_payment')).toEqual([]);
  });

  test('the card-paid invoice is received by the ledger and by the succeeded Stripe attempt, counted once', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.paidcard.id });
    expect(detail.payment_summary).toMatchObject({ received: true, recorded_payments_net: 90, stripe_succeeded_not_in_ledger: 0 });
    const recorded = detail.payments_timeline.find((e) => e.type === 'recorded_payment');
    expect(recorded).toMatchObject({ received: true, source: 'stripe', linked_by: 'metadata.invoice_id' });
    const attempt = detail.payments_timeline.find((e) => e.type === 'stripe_charge_attempt');
    expect(attempt).toMatchObject({ state: 'succeeded', received: true, ledger_recorded: true });
    const list = await read('get_customer_invoices', { customer_id: A, limit: 50 });
    expect(list.invoices.find((i) => i.id === inv.paidcard.id)).toMatchObject({ amount_paid: 90, balance_due: 0, payment_recorded: true });
  });

  test('a Stripe charge the ledger never recorded is received per Stripe and flagged for reconciling', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.orphan.id });
    const orphan = detail.payments_timeline.find((e) => e.type === 'stripe_unreconciled_charge');
    expect(orphan).toMatchObject({ received: true, ledger_recorded: false, amount: 60 });
    expect(detail.payment_summary).toMatchObject({ received: true, recorded_payments_net: 0, stripe_succeeded_not_in_ledger: 1, unreconciled_stripe_charges: 1 });
    expect(detail.payment_summary.statement).toMatch(/needs reconciling/);
  });

  test('a combined payment counts each invoice\'s own share, never a sibling\'s (shared PaymentIntent)', async () => {
    for (const [key, share] of [['c1', 70], ['c2', 30]]) {
      const detail = await read('get_invoice_detail', { invoice_id: inv[key].id });
      const recorded = detail.payments_timeline.filter((e) => e.type === 'recorded_payment');
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ amount: share, net_received: share, linked_by: 'metadata.invoice_id' });
      expect(detail.payment_summary).toMatchObject({ received: true, recorded_payments_net: share });
    }
    const list = await read('get_customer_invoices', { customer_id: C, limit: 50 });
    expect(list.invoices.find((i) => i.id === inv.c1.id).amount_paid).toBe(70);
    expect(list.invoices.find((i) => i.id === inv.c2.id).amount_paid).toBe(30);
    expect(list.invoices.find((i) => i.id === inv.c1.id).unknown).toBeUndefined();
  });

  test('a provisional ACH residual is a processing attempt, not received; processing invoices owe nothing yet', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.c3.id });
    const provisional = detail.payments_timeline.find((e) => e.type === 'stripe_unreconciled_charge');
    expect(provisional).toMatchObject({ received: false, unconfirmed: true, source: 'combined_pay_processing' });
    expect(provisional.state).toMatch(/processing/);
    expect(provisional.stripe_payment_intent_id).toBe(`pi_ach_${run}`);
    expect(detail.payment_summary).toMatchObject({ received: false, unreconciled_stripe_charges: 0, stripe_succeeded_not_in_ledger: 0, attempts_in_flight_or_unknown: 1, payments_pending: 1, attempts_unknown_outcome: 0 });
    expect(detail.payment_summary.statement).toMatch(/^No payment has been received/);
    expect(detail.payment_summary.statement).toMatch(/still processing \(not received yet\)/);
    expect(detail.invoice).toMatchObject({ status: 'processing', balance_due: 0 });
    const { account_summary: summary } = await read('get_customer_invoices', { customer_id: C });
    expect(summary).toMatchObject({ total_due: 0, outstanding_count: 0, processing: { count: 1, amount: 45 } });
  });

  test('a refunded or disputed card payment matches its historical attempt: no phantom unreconciled charge, a dispute is not paid', async () => {
    const refunded = await read('get_invoice_detail', { invoice_id: inv.d_ref.id });
    expect(refunded.payment_summary).toMatchObject({ received: true, recorded_payments_net: 0, stripe_succeeded_not_in_ledger: 0 });
    expect(refunded.payment_summary.statement).toMatch(/\$50\.00 refunded/);
    expect(refunded.payments_timeline.find((e) => e.type === 'stripe_charge_attempt')).toMatchObject({ ledger_recorded: true, ledger_state: 'refunded' });
    const disputed = await read('get_invoice_detail', { invoice_id: inv.d_dis.id });
    const attempt = disputed.payments_timeline.find((e) => e.type === 'stripe_charge_attempt');
    expect(attempt).toMatchObject({ state: 'succeeded', received: false, ledger_recorded: true, ledger_state: 'disputed' });
    expect(attempt.state_note).toMatch(/dispute/);
    expect(disputed.payments_timeline.find((e) => e.type === 'recorded_payment')).toMatchObject({ status: 'disputed', received: false });
    expect(disputed.payment_summary).toMatchObject({ received: false, disputed_payments: 1, stripe_succeeded_not_in_ledger: 0 });
    expect(disputed.payment_summary.statement).toMatch(/not counted as received/);
    expect(disputed.payment_summary.statement).toMatch(/Say the payment evidence is unknown/);
  });

  test('an orphan from a saved-bank charge is unconfirmed, never received (it can still be a pending ACH payment)', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.d_ach.id });
    const orphan = detail.payments_timeline.find((e) => e.type === 'stripe_unreconciled_charge');
    expect(orphan).toMatchObject({ received: false, unconfirmed: true, source: 'invoice_card_on_file', stripe_payment_intent_id: `pi_bank_${run}` });
    expect(orphan.state_note).toMatch(/not confirmed received/i);
    expect(detail.payment_summary).toMatchObject({ received: false, unreconciled_stripe_charges: 0, attempts_in_flight_or_unknown: 1, attempts_unknown_outcome: 1 });
    expect(detail.payment_summary.statement).toMatch(/^Payment receipt is not confirmed/);
    expect(detail.payment_summary.statement).toMatch(/do not retry the charge/);
  });

  test('overlapping subsets: the presented personal balance excludes the union, so nothing is subtracted twice', async () => {
    const { account_summary: summary } = await read('get_customer_invoices', { customer_id: E });
    // 100 + 40 draft + 30 payer-billed draft + 20 payer-billed sent = 190; drafts 70, payer-billed 50, overlap 30.
    expect(summary).toMatchObject({ total_due: 190, not_yet_sent_due: 70, payer_billed_due: 50, presented_self_pay_due: 100 });
    expect(summary.basis).toMatch(/never subtract/);
    const oracle = await pageOracle(E);
    expect(summary.total_due).toBe(oracle.total);
  });

  test('a credit-only settlement (succeeded attempt, no PaymentIntent) is not a Stripe charge and not a payment received', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.e_credit.id });
    const attempt = detail.payments_timeline.find((e) => e.type === 'stripe_charge_attempt');
    expect(attempt).toMatchObject({ state: 'succeeded', received: false, settled_by: 'account_credit' });
    expect(attempt.ledger_recorded).toBeUndefined();
    expect(detail.payment_summary).toMatchObject({ received: false, stripe_succeeded_not_in_ledger: 0, settled_by_account_credit: 1, attempts_in_flight_or_unknown: 0 });
    expect(detail.payment_summary.statement).toMatch(/^Settled by account credit, not by a payment/);
    expect(detail.invoice).toMatchObject({ status: 'paid', credit_applied: 80, balance_due: 0 });
  });

  test('truncated evidence never becomes a definitive "no payment": the newest rows are kept and the summary says it is incomplete', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.f_busy.id });
    const attempts = detail.payments_timeline.filter((e) => e.type === 'stripe_charge_attempt');
    expect(attempts).toHaveLength(50);
    expect(attempts.some((e) => e.state === 'claimed')).toBe(true);
    expect(detail.payment_summary.evidence_complete).toBe(false);
    expect(detail.payment_summary.statement).toMatch(/^Payment evidence is incomplete/);
    expect(detail.payment_summary.statement).not.toMatch(/^No payment has been received/);
    expect(detail.unknowns.join(' ')).toMatch(/more rows than were read/);
    const complete = await read('get_invoice_detail', { invoice_id: inv.open.id });
    expect(complete.payment_summary.evidence_complete).toBe(true);
  });

  test('one declined attempt written to two tables is counted once; both rows stay in the timeline', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.f_dup.id });
    expect(detail.payments_timeline.filter((e) => ['payment_attempt', 'stripe_charge_attempt'].includes(e.type))).toHaveLength(2);
    expect(detail.payment_summary).toMatchObject({ received: false, attempts_failed_or_canceled: 1, attempts_in_flight_or_unknown: 0 });
    expect(detail.payment_summary.statement).toMatch(/1 failed or canceled attempt\(s\)/);
    expect(detail.payment_summary.statement).toMatch(/^No payment has been received/);
  });

  test('an attached PaymentIntent with no recorded outcome is unconfirmed, not "no payment"', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.f_pi.id });
    expect(detail.payment_summary).toMatchObject({ received: false, attached_intent_outcome_unknown: true });
    expect(detail.payment_summary.statement).toMatch(/^Payment receipt is not confirmed/);
    expect(detail.payment_summary.statement).toMatch(/do not say it was not paid/);
    const plain = await read('get_invoice_detail', { invoice_id: inv.e_self.id });
    expect(plain.payment_summary.attached_intent_outcome_unknown).toBe(false);
    expect(plain.payment_summary.statement).toMatch(/^No payment has been received/);
  });

  test('review: a claimed attempt with no recorded submission is still unconfirmed, not "not received"', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.g_claim.id });
    const attempt = detail.payments_timeline.find((e) => e.type === 'stripe_charge_attempt');
    expect(attempt).toMatchObject({ state: 'claimed', received: false });
    expect(attempt.state_note).toMatch(/receipt unconfirmed/);
    expect(attempt.state_note).not.toMatch(/Not received/);
    expect(detail.payment_summary.statement).toMatch(/^Payment receipt is not confirmed/);
  });

  test('review: money a third-party payer settled is not the customer\'s payment (invoice payer, metadata.payer_id, payments.payer_id)', async () => {
    for (const key of ['g_payer', 'g_payer_meta', 'g_payer_col']) {
      const detail = await read('get_invoice_detail', { invoice_id: inv[key].id });
      expect(detail.payments_timeline.some((e) => e.received === true)).toBe(false);
      expect(detail.payments_timeline.some((e) => e.type === 'recorded_payment')).toBe(false);
      const entry = detail.payments_timeline.find((e) => e.type === 'payer_payment');
      expect(entry).toMatchObject({ received: false, received_from_customer: false, payer_funded: true, funded_by: { kind: 'third_party_payer', name: `Synthetic Funder ${run}` } });
      expect(detail.payment_summary).toMatchObject({ received: false, recorded_payments_net: 0, payer_funded_payments: 1 });
      expect(detail.payment_summary.statement).toMatch(/^No payment has been received from the customer/);
      expect(detail.payment_summary.statement).toMatch(new RegExp(`Synthetic Funder ${run}`));
      expect(detail.payment_summary.statement).not.toMatch(/^Payment was received/);
    }
    const list = await read('get_customer_invoices', { customer_id: G, limit: 50 });
    for (const key of ['g_payer', 'g_payer_meta', 'g_payer_col']) {
      const item = list.invoices.find((i) => i.id === inv[key].id);
      expect(item).toMatchObject({ payer_funded_payments: 1, payment_recorded: false });
      expect(item.amount_paid).not.toBe(inv[key].total);
      expect(item.unknown.join(' ')).toMatch(/third-party payer/);
    }
  });

  test('review: a disputed payment is found through metadata.dispute_invoice_id, and waves_invoice_id links a paid one', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.g_dispute.id });
    const entry = detail.payments_timeline.find((e) => e.status === 'disputed');
    expect(entry).toMatchObject({ received: false, linked_by: 'metadata.dispute_invoice_id' });
    expect(detail.payment_summary).toMatchObject({ received: false, disputed_payments: 1 });
    expect(detail.payment_summary.statement).toMatch(/disputed payment/);
    const alias = await read('get_invoice_detail', { invoice_id: inv.g_alias.id });
    expect(alias.payments_timeline.find((e) => e.type === 'recorded_payment')).toMatchObject({ received: true, linked_by: 'metadata.waves_invoice_id' });
    expect(alias.payment_summary).toMatchObject({ received: true, recorded_payments_net: 60 });
  });

  test('review: one saved-bank charge written as a processing payment and a claimed attempt is one pending payment', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.g_bank.id });
    expect(detail.payments_timeline.filter((e) => ['payment_attempt', 'stripe_charge_attempt'].includes(e.type))).toHaveLength(2);
    expect(detail.payment_summary).toMatchObject({ received: false, attempts_in_flight_or_unknown: 1, payments_pending: 1, attempts_unknown_outcome: 0 });
    expect(detail.payment_summary.statement).toMatch(/1 payment\(s\) still processing/);
    expect(detail.payment_summary.statement).not.toMatch(/unknown outcome/);
  });

  test('review: a succeeded attempt and an orphan row for one PaymentIntent are one charge, not a second unknown outcome', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.g_both.id });
    expect(detail.payment_summary).toMatchObject({ received: true, stripe_succeeded_not_in_ledger: 1, attempts_unknown_outcome: 0, attempts_in_flight_or_unknown: 0 });
    expect(detail.payment_summary.statement).not.toMatch(/unknown outcome/);
  });

  test('review: the invoice detail guards the balance of an unreconciled charge the same way the list does', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.orphan.id });
    expect(detail.invoice).toMatchObject({ balance_due: null, portal_recorded_balance_due: 60 });
    expect(detail.unknowns.join(' ')).toMatch(/not money owed/);
    const plain = await read('get_invoice_detail', { invoice_id: inv.open.id });
    expect(plain.invoice.balance_due).toBe(200);
    expect(plain.invoice).not.toHaveProperty('portal_recorded_balance_due');
  });

  test('review: a failed per-invoice hold lookup is unknown (null), never false', async () => {
    const hold = require('../services/collections/collection-hold');
    const spy = jest.spyOn(hold, 'collectionHoldInvoiceIds').mockRejectedValueOnce(new Error('synthetic lookup failure'));
    try {
      const result = await read('get_customer_invoices', { customer_id: G, limit: 50 });
      expect(result.invoices.length).toBeGreaterThan(0);
      expect(result.invoices.every((i) => i.dispute_hold === null)).toBe(true);
      expect(result.unknowns.join(' ')).toMatch(/per-invoice dispute hold could not be read/);
    } finally { spy.mockRestore(); }
    const ok = await read('get_customer_invoices', { customer_id: G, limit: 50 });
    expect(ok.invoices.every((i) => i.dispute_hold === false)).toBe(true);
  });

  test('review: truncated payment evidence makes payment_recorded unknown (null), not a boolean from the retained rows', async () => {
    const list = await read('get_customer_invoices', { customer_id: P });
    const item = list.invoices.find((i) => i.id === inv.p_bulk.id);
    expect(item).toMatchObject({ payment_recorded: null, amount_paid: null });
    expect(item.unknown.join(' ')).toMatch(/exceeded the read bound/);
    const normal = await read('get_customer_invoices', { customer_id: A, limit: 50 });
    expect(normal.invoices.find((i) => i.id === inv.open.id).payment_recorded).toBe(false);
  });

  test('review: the list surfaces an unresolved orphan charge: balance and payment state unknown, do not collect or retry', async () => {
    const list = await read('get_customer_invoices', { customer_id: A, limit: 50 });
    const item = list.invoices.find((i) => i.id === inv.orphan.id);
    expect(item).toMatchObject({ unreconciled_stripe_charges: 1, balance_due: null, amount_paid: null, payment_recorded: null });
    expect(item.unknown.join(' ')).toMatch(/Do not collect or retry/);
    expect(list.account_summary.unreconciled_stripe_charges).toBe(1);
    expect(list.account_summary.unknown).toMatch(/Do not collect or retry/);
    // Detail agrees: Stripe-confirmed received, ledger needs reconciling.
    const detail = await read('get_invoice_detail', { invoice_id: inv.orphan.id });
    expect(detail.payment_summary.unreconciled_stripe_charges).toBe(1);
    // Unaffected invoices keep their numbers.
    expect(list.invoices.find((i) => i.id === inv.open.id)).toMatchObject({ unreconciled_stripe_charges: 0, balance_due: 200 });
    const noOrphans = await read('get_customer_invoices', { customer_id: B });
    expect(noOrphans.account_summary.unreconciled_stripe_charges).toBe(0);
  });

  test('applied credit: lines, discounts and the credit movement stay separate from payments', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.credited.id });
    expect(detail.invoice).toMatchObject({ total: 150, credit_applied: 50, amount_due_after_credit: 100, balance_due: 100 });
    expect(detail.line_items).toEqual([expect.objectContaining({ description: 'Service credited', amount: 150, is_discount: false })]);
    expect(detail.discounts.account_credit_applied).toBe(50);
    const credit = detail.payments_timeline.find((e) => e.type === 'credit_movement');
    expect(credit).toMatchObject({ delta: -50, direction: 'applied_to_invoice', source: 'invoice_application', received: false });
    expect(detail.payments_timeline.some((e) => e.received === true)).toBe(false);
    expect(detail.payment_summary.received).toBe(false);
  });

  test('no card number, full email or invoice token leaves either tool', async () => {
    const outputs = [];
    for (const key of ['open', 'paid', 'paidcard', 'orphan', 'credited']) outputs.push(json(await read('get_invoice_detail', { invoice_id: inv[key].id })));
    outputs.push(json(await read('get_customer_invoices', { customer_id: A, include_archived: true, limit: 50 })));
    const all = outputs.join('\n');
    expect(all).not.toMatch(/example\.com/);
    expect(all).not.toMatch(/4242/);
    expect(all).not.toMatch(/@/);
    expect(all).toMatch(/\[email\]/);
    for (const token of tokens) expect(all).not.toContain(token);
    expect(all).not.toMatch(/client_secret/);
  });

  test('same-surname isolation: the neighbour\'s invoices never appear, by id, name or phone', async () => {
    const phoneA = (await db('customers').where({ id: A }).first('phone')).phone;
    const aIds = await db('invoices').where({ customer_id: A }).pluck('id');
    const results = [
      await read('get_customer_invoices', { customer_id: A, include_archived: true, limit: 50 }),
      await read('get_customer_invoices', { phone: phoneA, include_archived: true, limit: 50 }),
      await read('get_customer_invoices', { customer_name: `Thessaly${run}`, include_archived: true, limit: 50 }),
    ];
    for (const result of results) {
      expect(result.customer.id).toBe(A);
      const text = json(result);
      expect(text).not.toContain(inv.b_open.id);
      expect(text).not.toContain(inv.b_paid.id);
      expect(text).not.toContain(`SENTINEL-B`);
      expect(text).not.toContain('999.99');
      expect(result.invoices.every((i) => aIds.includes(i.id))).toBe(true);
    }
    const b = await read('get_customer_invoices', { customer_id: B });
    expect(b.account_summary.total_due).toBe(999.99);
    expect(json(b)).not.toContain(inv.open.id);
  });

  test('a shared surname is ambiguous (candidates, no invoices); a conflicting selector is refused', async () => {
    const ambiguous = await read('get_customer_invoices', { customer_name: SURNAME });
    expect(ambiguous).toMatchObject({ ambiguous: true });
    expect(ambiguous.invoices).toBeUndefined();
    expect(ambiguous.candidates.map((c) => c.id).sort()).toEqual([A, B].sort());
    expect(await read('get_customer_invoices', { customer_id: A, customer_name: `Orville${run}` })).toMatchObject({ code: 'selector_conflict' });
    expect(await read('get_customer_invoices', { customer_id: uid() })).toMatchObject({ code: 'record_unavailable' });
  });

  test('task scope: another customer\'s invoice or id is refused even with its exact id', async () => {
    const scoped = { readCustomerIds: [A] };
    expect(await read('get_invoice_detail', { invoice_id: inv.b_open.id }, scoped)).toMatchObject({ code: 'target_clarification_required' });
    expect(await read('get_customer_invoices', { customer_id: B }, scoped)).toMatchObject({ code: 'target_clarification_required' });
    expect((await read('get_invoice_detail', { invoice_id: inv.open.id }, scoped)).invoice.id).toBe(inv.open.id);
    // A customer id that does not own the invoice reads as unavailable, never as the other customer's data.
    const wrongOwner = await read('get_invoice_detail', { invoice_id: inv.b_open.id, customer_id: A });
    expect(wrongOwner).toMatchObject({ code: 'record_unavailable' });
    expect(json(wrongOwner)).not.toContain('999.99');
    expect(await read('get_invoice_detail', { invoice_id: uid() })).toMatchObject({ code: 'record_unavailable' });
  });

  test('pagination covers every invoice exactly once with has_more and next_offset', async () => {
    const expected = await db('invoices').where({ customer_id: A }).whereNull('archived_at').pluck('id');
    const seen = [];
    let offset = 0; let guard = 0; let pages = 0;
    for (;;) {
      const page = await read('get_customer_invoices', { customer_id: A, limit: 3, offset });
      pages += 1;
      expect(page.returned_count).toBeLessThanOrEqual(3);
      expect(page.total_matching).toBe(expected.length);
      seen.push(...page.invoices.map((i) => i.id));
      if (!page.has_more) { expect(page.next_offset).toBeNull(); break; }
      expect(page.next_offset).toBe(offset + page.returned_count);
      offset = page.next_offset;
      guard += 1;
      expect(guard).toBeLessThan(20);
    }
    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual([...expected].sort());
    const overdueOnly = await read('get_customer_invoices', { customer_id: A, status: 'overdue' });
    expect(overdueOnly.invoices.map((i) => i.id)).toEqual([inv.open.id]);
    expect(overdueOnly.account_summary.total_due).toBe(446);
  });

  test('both readers write nothing', async () => {
    const before = await snapshot();
    await read('get_customer_invoices', { customer_id: A, include_archived: true, limit: 50 });
    for (const key of ['open', 'paid', 'orphan', 'credited', 'draft']) await read('get_invoice_detail', { invoice_id: inv[key].id });
    await read('get_customer_invoices', { customer_id: H });
    expect(await snapshot()).toEqual(before);
  });

  test('a technician has neither tool and cannot force a call', async () => {
    for (const context of ['tech', 'customers', 'platform']) {
      const names = registry.initialTools(context, { role: 'technician' }).map((t) => t.name);
      expect(names).not.toContain('get_customer_invoices');
      expect(names).not.toContain('get_invoice_detail');
    }
    const techScope = { role: 'technician', context: 'tech', techContext: { techId: 'tech-1' } };
    for (const [name, input] of [['get_customer_invoices', { customer_id: A }], ['get_invoice_detail', { invoice_id: inv.open.id }]]) {
      expect(await registry.execute(name, input, techScope)).toMatchObject({ code: 'permission_denied' });
      expect(await registry.execute(name, input, { role: 'admin', context: 'tech' })).toMatchObject({ code: 'permission_denied' });
    }
  });
});
