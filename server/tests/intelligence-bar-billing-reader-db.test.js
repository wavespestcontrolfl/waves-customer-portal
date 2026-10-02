/**
 * W9 billing readers against real Postgres. The reader derives no money state of its own: an invoice's balance
 * is stated only when the payment paths' own fences pass (assertInvoiceCollectible and the read-only
 * assertNoInvoiceChargeReconciliationPending), and the fence's outcome decides. Also: a same-surname customer's
 * invoices never appear, pagination is exact, the readers write nothing, and a technician gets no tool.
 * Synthetic data only; no model, provider or network call.
 */
const crypto = require('crypto');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const databaseUrl = process.env.IB_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('billing readers (get_customer_invoices, get_invoice_detail)', () => {
  let db; let registry; let execute; let etDateString;
  const originalEnv = { ...process.env };
  const uid = () => crypto.randomUUID();
  const digits = () => String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  const day = (offset) => etDateString(new Date(Date.now() + offset * 86400000));
  const run = crypto.randomBytes(3).toString('hex');
  const SURNAME = `Quillfeather${run}`;
  let A; let B; let H; let E; let G; let Z; let Y; let X; let D2; let W2; let V; let U; let L; let M; let N; let T; let R2;
  const inv = {};
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
  const by = (result, key) => result.invoices.find((i) => i.id === inv[key].id);

  async function snapshot() {
    const ids = [A, B, H, E, G];
    return {
      invoices: await db('invoices').whereIn('customer_id', ids).select('id', 'status', 'total', 'credit_applied', 'updated_at').orderBy('id'),
      payments: await db('payments').whereIn('customer_id', ids).count('* as n').first(),
      attempts: await db('stripe_invoice_charge_attempts').count('* as n').first(),
      orphans: await db('stripe_orphan_charges').count('* as n').first(),
      notifications: await db('notifications').count('* as n').first(),
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
    ({ etDateString } = require('../utils/datetime-et'));

    A = await customer(`Thessaly${run}`, SURNAME, { account_credits: 25 });
    B = await customer(`Orville${run}`, SURNAME);
    H = await customer('Marguerite', `Holdout${run}`);
    // Terminal invoices: paid by a recorded manual payment (linked by the portal's description rule), and void.
    const paid = await invoice('paid', A, { total: 120, status: 'paid', paid_at: new Date(), due_date: day(-30), payment_method: 'check',
      payment_reference: 'CHK-1001', payment_recorded_by: 'Synthetic Operator', payment_recorded_at: new Date() });
    await db('payments').insert({ customer_id: A, payment_date: day(-29), amount: 120, status: 'paid', description: `Invoice ${paid.invoice_number} — check (CHK-1001)` });
    await invoice('voided', A, { total: 77, status: 'void' });
    await invoice('processing', A, { total: 55, status: 'processing', payment_method: 'us_bank_account' });
    // Ordinary collectible invoices.
    const credited = await invoice('credited', A, { total: 150, credit_applied: 50, due_date: day(15) });
    await db('payment_plans').insert({ customer_id: A, invoice_id: credited.id, total_balance: 100, payment_amount: 25, payment_frequency: 'weekly', plan_start_date: day(0), next_payment_date: day(7) });
    await invoice('draft', A, { total: 40, status: 'draft', due_date: null });
    await invoice('archived', A, { total: 33, archived_at: new Date() });
    for (let n = 0; n < 4; n += 1) await invoice(`fill${n}`, A, { total: 10 + n, due_date: day(20 + n) });
    // A submitted saved-card attempt with no result: the fence holds the invoice (a payment plan rides on it).
    const open = await invoice('open', A, { total: 200, status: 'overdue', due_date: day(-12), stripe_payment_intent_id: `pi_open_${run}` });
    await db('stripe_invoice_charge_attempts').insert({ invoice_id: open.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-open-${run}`, status: 'claimed', amount: 200, submitted_at: new Date() });
    await db('payment_plans').insert({ customer_id: A, invoice_id: open.id, total_balance: 200, payment_amount: 50, payment_frequency: 'monthly', plan_start_date: day(0), next_payment_date: day(30) });
    // An ambiguous attempt, an unresolved orphan charge, and a failed row flagged ambiguous (the fence's three holds).
    const amb = await invoice('amb', A, { total: 45 });
    await db('stripe_invoice_charge_attempts').insert({ invoice_id: amb.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-amb-${run}`, status: 'ambiguous', amount: 45, submitted_at: new Date(),
      error_message: 'declined for synthetic.person@example.com' });
    const orphan = await invoice('orphan', A, { total: 60, due_date: day(5) });
    await db('stripe_orphan_charges').insert({ stripe_payment_intent_id: `pi_orphan_${run}`, customer_id: A, invoice_id: orphan.id, amount: 60, source: 'invoice_payment_webhook', original_db_error: 'synthetic ledger failure' });
    const failAmb = await invoice('failamb', A, { total: 65 });
    await db('payments').insert({ customer_id: A, payment_date: day(0), amount: 65, status: 'failed', processor: 'stripe', description: 'Connection failure',
      failure_reason: 'declined for jane.doe@example.com card 4242 4242 4242 4242', metadata: json({ invoice_id: failAmb.id, ambiguous_outcome: true }) });
    // The same failed row once a DIFFERENT payment superseded it is no longer fenced.
    const failSup = await invoice('failsup', A, { total: 66 });
    const [replacement] = await db('payments').insert({ customer_id: A, payment_date: day(0), amount: 66, status: 'paid', description: 'Replacement', metadata: json({}) }).returning('id');
    await db('payments').insert({ customer_id: A, payment_date: day(-1), amount: 66, status: 'failed', processor: 'stripe', description: 'Connection failure, reconciled',
      superseded_by_payment_id: replacement.id || replacement, metadata: json({ invoice_id: failSup.id, ambiguous_outcome: true }) });
    // A saved-card ambiguity parks the invoice as `processing` and leaves the attempt; an ordinary processing invoice is an ACH in flight.
    Y = await customer(`Parked${run}`, `Processing${run}`);
    await invoice('y_ach', Y, { total: 90, status: 'processing', payment_method: 'us_bank_account' });
    const parked = await invoice('y_parked', Y, { total: 35, status: 'processing' });
    await db('stripe_invoice_charge_attempts').insert({ invoice_id: parked.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-parked-${run}`, status: 'claimed', amount: 35, submitted_at: new Date() });
    // An ordinary ACH debit in flight: its attempt stays unresolved while the PaymentIntent is processing, and a
    // `processing` payments row records it. A received deposit not yet applied to its invoice (the third pay-path fence).
    X = await customer(`Bank${run}`, `Debit${run}`);
    // Bank tender evidence: x_ach_sent from its payments row (metadata.payment_method), x_ach_proc from the invoice's payment_method.
    for (const [key, status, extra, tender] of [['x_ach_sent', 'sent', {}, { payment_method: 'us_bank_account' }], ['x_ach_proc', 'processing', { payment_method: 'us_bank_account' }, {}]]) {
      const row = await invoice(key, X, { total: 60, status, stripe_payment_intent_id: `pi_ach_${key}_${run}`, ...extra });
      await db('stripe_invoice_charge_attempts').insert({ invoice_id: row.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-${key}-${run}`, status: 'ambiguous', amount: 60,
        stripe_payment_intent_id: `pi_ach_${key}_${run}`, submitted_at: new Date() });
      await db('payments').insert({ customer_id: X, payment_date: day(0), amount: 60, status: 'processing', processor: 'stripe', stripe_payment_intent_id: `pi_ach_${key}_${run}`,
        description: 'ACH in flight', metadata: json({ invoice_id: row.id, ...tender }) });
    }
    // A processing CARD intent (chargeInvoiceWithSavedCard maps every non-succeeded intent to processing), or a tender nobody recorded, is not an ACH.
    V = await customer(`Card${run}`, `Incomplete${run}`);
    const vCard = await invoice('v_card', V, { total: 25, status: 'processing', payment_method: 'card', stripe_payment_intent_id: `pi_v_card_${run}` });
    await invoice('v_unknown', V, { total: 26, status: 'processing' });
    const vSent = await invoice('v_sent_card', V, { total: 27, stripe_payment_intent_id: `pi_v_sent_${run}` });
    for (const [row, pi] of [[vCard, `pi_v_card_${run}`], [vSent, `pi_v_sent_${run}`]]) {
      await db('stripe_invoice_charge_attempts').insert({ invoice_id: row.id, stripe_payment_method_id: 'pm_card_synth', idempotency_key: `k-${pi}`, status: 'ambiguous', amount: 25, stripe_payment_intent_id: pi, submitted_at: new Date() });
      await db('payments').insert({ customer_id: V, payment_date: day(0), amount: 25, status: 'processing', processor: 'stripe', payment_method_type: 'card', stripe_payment_intent_id: pi, description: 'Card intent incomplete', metadata: json({ invoice_id: row.id }) });
    }
    // Bank tender evidence from the attempt alone: its payment method is a us_bank_account; the processing row records no tender.
    U = await customer(`Attempt${run}`, `Tender${run}`);
    await db('payment_methods').insert({ customer_id: U, method_type: 'us_bank_account', stripe_payment_method_id: `pm_bank_${run}` });
    const uRow = await invoice('u_attempt_tender', U, { total: 33, stripe_payment_intent_id: `pi_u_${run}` });
    await db('stripe_invoice_charge_attempts').insert({ invoice_id: uRow.id, stripe_payment_method_id: `pm_bank_${run}`, idempotency_key: `k-u-${run}`, status: 'ambiguous', amount: 33, stripe_payment_intent_id: `pi_u_${run}`, submitted_at: new Date() });
    await db('payments').insert({ customer_id: U, payment_date: day(0), amount: 33, status: 'processing', processor: 'stripe', stripe_payment_intent_id: `pi_u_${run}`, description: 'In flight', metadata: json({ invoice_id: uRow.id }) });
    // An email and a PAN-like number in EVERY free-text column the readers select (each sized to its column).
    const LEAK = 'x@y.example 4111 1111 1111 1111'; const MID = 'a@b.co 4111111111111'; const TINY = 'a@b.co';
    L = await customer(MID, MID);
    const [leakPayer] = await db('payers').insert({ display_name: LEAK }).returning('id');
    const [leakMethod] = await db('payment_methods').insert({ customer_id: L, method_type: MID, card_brand: MID, stripe_payment_method_id: `pm_leak_${run}` }).returning('id');
    const leakInvoice = await invoice('l_leak', L, { total: 20, title: LEAK, service_type: LEAK, discount_label: LEAK, payment_reference: LEAK, payment_recorded_by: LEAK, payment_method: MID,
      line_items: JSON.stringify([{ description: LEAK, name: LEAK, category: LEAK, quantity: 1, unit_price: 20, amount: 20 }]) });
    await db('invoices').where({ id: leakInvoice.id }).update({ invoice_number: `L${run}-LEAK` });
    await db('payments').insert({ customer_id: L, payer_id: leakPayer.id || leakPayer, payment_method_id: leakMethod.id || leakMethod, payment_date: day(0), amount: 5, status: 'paid', processor: TINY, card_brand: MID,
      payment_method_type: MID, refund_status: MID, metadata: json({ invoice_id: leakInvoice.id, payment_method: LEAK }) });
    await db('payment_plans').insert({ customer_id: L, invoice_id: leakInvoice.id, total_balance: 20, payment_amount: 5, payment_frequency: MID, status: MID, plan_start_date: day(0), next_payment_date: day(7) });
    // Digit-heavy record ids must survive the egress scrubber (it would read 16 digits as a card number).
    N = '98765432-9876-4987-8987-987654321098';
    // Fixed ids survive in the scratch database between runs: clear the previous run's rows first.
    await db('invoices').where({ customer_id: N }).del();
    await db('customers').where({ id: N }).del();
    await db('customers').insert({ id: N, first_name: `Numeric${run}`, last_name: `Ids${run}`, phone: `+1555${digits()}1`.slice(0, 12), address_line1: '100 Example Court' });
    await invoice('n_numeric', N, { id: '12345678-1234-4123-8123-123456789012', total: 12 });
    // An annual prepay invoice linked only from the term side (annual_prepay_terms.prepay_invoice_id; invoices.annual_prepay_term_id is NULL).
    T = await customer(`Prepay${run}`, `TermSide${run}`);
    const prepayInvoice = await invoice('t_prepay', T, { total: 600, status: 'paid', paid_at: new Date() });
    const [term] = await db('annual_prepay_terms').insert({ customer_id: T, prepay_invoice_id: prepayInvoice.id, status: 'active', term_start: day(-30), term_end: day(335), prepay_amount: 600 }).returning('id');
    inv.prepayTermId = term.id || term;
    // Conflicting tender evidence: the invoice says bank, its processing payments row says card. And sibling rows that
    // would crowd this invoice's own payment out of a limited history.
    R2 = await customer(`Mixed${run}`, `Tender${run}`);
    const mixed = await invoice('r2_mixed', R2, { total: 44, payment_method: 'us_bank_account', stripe_payment_intent_id: `pi_r2_mixed_${run}` });
    await db('stripe_invoice_charge_attempts').insert({ invoice_id: mixed.id, stripe_payment_method_id: 'pm_r2', idempotency_key: `k-r2-${run}`, status: 'ambiguous', amount: 44, stripe_payment_intent_id: `pi_r2_mixed_${run}`, submitted_at: new Date() });
    await db('payments').insert({ customer_id: R2, payment_date: day(0), amount: 44, status: 'processing', processor: 'stripe', payment_method_type: 'card', stripe_payment_intent_id: `pi_r2_mixed_${run}`, description: 'Card row', metadata: json({ invoice_id: mixed.id }) });
    const flood = await invoice('r2_flood', R2, { total: 15, status: 'paid', paid_at: new Date(), stripe_payment_intent_id: `pi_r2_flood_${run}` });
    await db('payments').insert({ customer_id: R2, payment_date: day(-9), amount: 15, status: 'paid', processor: 'stripe', stripe_payment_intent_id: `pi_r2_flood_${run}`, description: 'Own payment', metadata: json({ invoice_id: flood.id }), created_at: new Date(Date.now() - 86400e3) });
    await db.batchInsert('payments', Array.from({ length: 55 }, (_, n) => ({ customer_id: R2, payment_date: day(-1), amount: 1, status: 'paid', processor: 'stripe', stripe_payment_intent_id: `pi_r2_flood_${run}`,
      description: `Sibling share ${n}`, metadata: json({ invoice_id: uid() }) })), 55);
    // More payment plans than the history shows.
    M = await customer(`Plans${run}`, `Many${run}`);
    const manyPlans = await invoice('m_plans', M, { total: 70 });
    await db('payment_plans').insert(Array.from({ length: 7 }, (_, n) => ({ customer_id: M, invoice_id: manyPlans.id, total_balance: 70, payment_amount: 10, payment_frequency: 'monthly', status: 'cancelled', plan_start_date: day(-n - 1), next_payment_date: day(7) })));
    // ACH evidence accounts for the attempt only: an unresolved orphan charge, or a failed row flagged ambiguous, still holds.
    W2 = await customer(`Mixed${run}`, `Holds${run}`);
    for (const key of ['w2_orphan', 'w2_failamb', 'w2_dbfail']) {
      const row = await invoice(key, W2, { total: 40, stripe_payment_intent_id: `pi_${key}_${run}` });
      await db('payments').insert({ customer_id: W2, payment_date: day(0), amount: 40, status: 'processing', processor: 'stripe', stripe_payment_intent_id: `pi_${key}_${run}`, description: 'ACH in flight', metadata: json({ invoice_id: row.id }) });
      if (key !== 'w2_dbfail') {
        await db('stripe_invoice_charge_attempts').insert({ invoice_id: row.id, stripe_payment_method_id: 'pm_synth', idempotency_key: `k-${key}-${run}`, status: 'ambiguous', amount: 40, stripe_payment_intent_id: `pi_${key}_${run}`, submitted_at: new Date() });
      }
    }
    await db('stripe_orphan_charges').insert([
      { stripe_payment_intent_id: `pi_other_orphan_${run}`, customer_id: W2, invoice_id: inv.w2_orphan.id, amount: 40, source: 'invoice_payment_webhook', original_db_error: 'synthetic' },
      { stripe_payment_intent_id: `pi_w2_dbfail_${run}`, customer_id: W2, invoice_id: inv.w2_dbfail.id, amount: 40, source: 'invoice_payment_webhook', original_db_error: 'synthetic' },
    ]);
    await db('payments').insert({ customer_id: W2, payment_date: day(0), amount: 40, status: 'failed', processor: 'stripe', description: 'Connection failure', metadata: json({ invoice_id: inv.w2_failamb.id, ambiguous_outcome: true }) });
    D2 = await customer(`Deposit${run}`, `Pending${run}`);
    const [estimate] = await db('estimates').insert({ customer_id: D2 }).returning('id');
    const estimateId = estimate.id || estimate;
    await db('estimate_deposits').insert({ estimate_id: estimateId, amount: 50, status: 'received', stripe_payment_intent_id: `pi_dep_${run}` });
    await invoice('d2_pending', D2, { total: 200, notes: `Auto-generated from accepted estimate #${estimateId}` });
    await invoice('d2_plain', D2, { total: 30 });
    // Same-surname neighbour with loud sentinels, and a dispute-hold customer.
    await invoice('b_open', B, { total: 999.99, title: `SENTINEL-B-${run}`, status: 'overdue', due_date: day(-40) });
    await invoice('b_paid', B, { total: 55.55, status: 'paid', title: `SENTINEL-B-PAID-${run}` });
    await invoice('h_open', H, { total: 80 });
    await db('collections_flags').insert({ customer_id: H, flag: 'collection_hold', reason: 'dispute on call: synthetic' });
    // Overlapping subsets (a payer-billed draft and a sent payer invoice), and a Bill-To withdrawn after the invoice was sent.
    E = await customer(`Overlap${run}`, `Sorter${run}`);
    const [payer] = await db('payers').insert({ display_name: `Synthetic Payer ${run}` }).returning('id');
    const payerId = payer.id || payer;
    await invoice('e_self', E, { total: 100 });
    await invoice('e_draft', E, { total: 40, status: 'draft', due_date: null });
    await invoice('e_payer_draft', E, { total: 30, status: 'draft', due_date: null, payer_id: payerId });
    await invoice('e_payer_sent', E, { total: 20, payer_id: payerId });
    await invoice('e_withdrawn', E, { total: 25, scheduled_send_error: `payer_billed:${payerId}` });
    // Credit reconciliation read as one snapshot.
    Z = await customer(`Credit${run}`, `Snapshot${run}`, { account_credits: 10 });
    await db('customer_credit_ledger').insert({ customer_id: Z, delta: 10, balance_after: 10, source: 'manual', note: 'Synthetic grant' });
    // An attached PaymentIntent (a payment started, outcome not confirmed here), shared by two combined siblings.
    await invoice('z_attached', Z, { total: 80, stripe_payment_intent_id: `pi_attached_${run}` });
    await invoice('z_sibling', Z, { total: 20, stripe_payment_intent_id: `pi_attached_${run}` });
    await invoice('z_plain', Z, { total: 15 });
    // Recorded payments listed beside a collectible invoice: payer-funded, dispute alias, waves alias, more than the read bound.
    G = await customer(`Listed${run}`, `Payments${run}`);
    const gPayer = await invoice('g_payer', G, { total: 300, status: 'paid', paid_at: new Date() });
    await db('payments').insert({ customer_id: G, payer_id: payerId, payment_date: day(-1), amount: 300, status: 'paid', description: 'Synthetic payer settlement', metadata: json({ invoice_id: gPayer.id }) });
    const gAlias = await invoice('g_alias', G, { total: 150, status: 'overdue' });
    await db('payments').insert([
      { customer_id: G, payment_date: day(-5), amount: 150, status: 'disputed', processor: 'stripe', card_brand: 'visa', description: 'Stripe card payment', metadata: json({ dispute_invoice_id: gAlias.id }) },
      { customer_id: G, payment_date: day(-4), amount: 10, status: 'paid', processor: 'stripe', description: 'Stripe card payment', metadata: json({ waves_invoice_id: gAlias.id }) },
    ]);
    // The tender: live payment_methods join, then the payment's own snapshot, then metadata.payment_method, then the processor.
    const [liveMethod] = await db('payment_methods').insert({ customer_id: G, method_type: 'us_bank_account', card_brand: null, stripe_payment_method_id: `pm_live_${run}` }).returning('id');
    const gMethod = await invoice('g_method', G, { total: 10, status: 'paid', paid_at: new Date() });
    await db('payments').insert([
      { customer_id: G, payment_date: day(-6), amount: 1, status: 'paid', processor: 'stripe', payment_method_id: liveMethod.id || liveMethod, payment_method_type: 'card', description: 'live join', metadata: json({ invoice_id: gMethod.id, payment_method: 'check' }) },
      { customer_id: G, payment_date: day(-6), amount: 2, status: 'paid', processor: 'stripe', payment_method_type: 'ach_snapshot', description: 'snapshot', metadata: json({ invoice_id: gMethod.id, payment_method: 'check' }) },
      { customer_id: G, payment_date: day(-6), amount: 3, status: 'paid', processor: 'stripe', description: 'metadata tender', metadata: json({ invoice_id: gMethod.id, payment_method: 'zelle' }) },
      { customer_id: G, payment_date: day(-6), amount: 4, status: 'paid', processor: 'stripe', description: 'processor only', metadata: json({ invoice_id: gMethod.id }) },
    ]);
    // Legacy / card-on-file rows carry no invoice metadata: linked by the invoice's PaymentIntent or charge id. A combined sibling's row (explicit other invoice_id, same PaymentIntent) is not this invoice's.
    await invoice('g_legacy', G, { total: 70, status: 'paid', paid_at: new Date(), stripe_payment_intent_id: `pi_legacy_${run}`, stripe_charge_id: `ch_legacy_${run}` });
    await db('payments').insert([
      { customer_id: G, payment_date: day(-3), amount: 70, status: 'refunded', refund_amount: 20, refund_status: 'succeeded', processor: 'stripe', stripe_payment_intent_id: `pi_legacy_${run}`, description: 'Card on file', metadata: json({}) },
      { customer_id: G, payment_date: day(-3), amount: 5, status: 'paid', processor: 'stripe', stripe_charge_id: `ch_legacy_${run}`, description: 'Charge-linked', metadata: json({}) },
      { customer_id: G, payment_date: day(-3), amount: 999, status: 'paid', processor: 'stripe', stripe_payment_intent_id: `pi_legacy_${run}`, description: 'Sibling share', metadata: json({ invoice_id: uid() }) },
    ]);
    // A payer statement settles ONE payments row (customer_id NULL, statement_id) for every invoice on it.
    const [statement] = await db('payer_statements').insert({ payer_id: payerId, period_start: day(-30), period_end: day(-1), status: 'paid', terms_snapshot: 'net_30',
      subtotal: 900, total: 900, invoice_count: 3, token: crypto.randomBytes(16).toString('hex'), paid_at: new Date() }).returning('id');
    inv.statementId = statement.id || statement;
    await invoice('g_stmt', G, { total: 300, status: 'paid', paid_at: new Date(), payer_statement_id: inv.statementId });
    await db('payments').insert({ customer_id: null, payer_id: payerId, statement_id: inv.statementId, payment_date: day(-1), amount: 900, status: 'paid', processor: 'stripe',
      description: `Payer statement S-${inv.statementId} settlement (ach)`, metadata: json({ statement_id: inv.statementId, payer_id: payerId, source: 'synthetic' }) });
    const gBulk = await invoice('g_bulk', G, { total: 90 });
    await db.batchInsert('payments', Array.from({ length: 51 }, (_, n) => ({ customer_id: G, payment_date: day(-1), amount: 5, status: 'failed', processor: 'stripe',
      description: `Synthetic failed ${n}`, metadata: json({ invoice_id: gBulk.id }) })), 51);
  }, 60000);

  afterAll(async () => {
    if (db) await db.destroy();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  test('a collectible invoice states its balance; the fence-held and terminal ones state a reason and no balance', async () => {
    const list = await read('get_customer_invoices', { customer_id: A, include_archived: true, limit: 50 });
    expect(list.error).toBeUndefined();
    expect(by(list, 'credited')).toMatchObject({ total: 150, credit_applied: 50, amount_due_after_credit: 100, collectible: true, balance_due: 100, needs_reconciliation: false, overdue: false });
    expect(by(list, 'draft')).toMatchObject({ collectible: true, balance_due: 40 });
    expect(by(list, 'archived')).toMatchObject({ archived: true, collectible: true, balance_due: 33 });
    expect(by(list, 'failsup')).toMatchObject({ collectible: true, balance_due: 66 });
    // Terminal statuses report the status and no balance.
    expect(by(list, 'paid')).toMatchObject({ status: 'paid', collectible: false, balance_due: null, needs_reconciliation: false, reason: expect.stringMatching(/already paid/) });
    expect(by(list, 'voided')).toMatchObject({ status: 'void', collectible: false, balance_due: null, reason: expect.stringMatching(/void/) });
    expect(by(list, 'processing')).toMatchObject({ collectible: false, balance_due: null, reason: expect.stringMatching(/already processing/) });
    // The fence's three holds: an unresolved attempt, an ambiguous attempt, an unrecorded charge, a failed row flagged ambiguous.
    for (const key of ['open', 'amb', 'orphan', 'failamb']) {
      expect(by(list, key)).toMatchObject({ collectible: false, balance_due: null, needs_reconciliation: true, overdue: null });
      expect(by(list, key).reason).toMatch(/needs reconciliation — check the Invoices page/);
      expect(by(list, key).reason).not.toMatch(/pi_/);
    }
    expect(by(list, 'open')).toMatchObject({ has_active_payment_plan: true });
    // Nothing that reads as owed leaves a held invoice: not the amount due, not the plan's installment or balance.
    expect(by(list, 'open').payment_plan).toMatchObject({ payment_amount: null, total_balance: null, payment_frequency: 'monthly', amounts_withheld: expect.any(String) });
    expect(by(list, 'credited').payment_plan).toMatchObject({ payment_amount: 25, total_balance: 100, payment_frequency: 'weekly' });
    for (const key of ['paid', 'voided', 'processing', 'open', 'amb', 'orphan', 'failamb']) {
      expect(by(list, key)).toMatchObject({ amount_due_after_credit: null, balance_due: null });
      expect(by(list, key).total).toBeGreaterThan(0);
    }
    expect(list.invoices.every((i) => 'dispute_hold' in i && 'annual_prepay' in i && 'archived' in i)).toBe(true);
    // No derived receipt fields remain on an item.
    for (const field of ['amount_paid', 'payment_recorded', 'unreconciled_stripe_charges']) expect(by(list, 'paid')).not.toHaveProperty(field);
  });

  test('the outcome of the fences decides: the read-only stripe fence is the one called, and a check that cannot run holds the balance', async () => {
    const stripe = require('../services/stripe');
    const spy = jest.spyOn(stripe, 'assertNoInvoiceChargeReconciliationPending').mockResolvedValue(undefined);
    try {
      // Fence passes -> collectible, even for the invoice the real fence holds.
      const list = await read('get_customer_invoices', { customer_id: A, limit: 50 });
      expect(by(list, 'amb')).toMatchObject({ collectible: true, balance_due: 45 });
      expect(spy).toHaveBeenCalledWith(inv.amb.id, expect.anything(), { readOnly: true });
      // ... on the call's snapshot connection, not the pool.
      expect(spy.mock.calls.find(([id]) => id === inv.amb.id)[1]).not.toBe(db);
      // An attached PaymentIntent still holds it: the reader cannot confirm that outcome.
      expect(by(list, 'open')).toMatchObject({ collectible: false, balance_due: null });
      // Terminal invoices never reach the second fence.
      expect(spy.mock.calls.some(([id]) => id === inv.paid.id)).toBe(false);
      // The fence cannot run -> not collectible, with the reconcile pointer, never an exact balance.
      spy.mockRejectedValue(new Error('connection terminated'));
      const down = await read('get_customer_invoices', { customer_id: A, limit: 50 });
      expect(by(down, 'credited')).toMatchObject({ collectible: false, balance_due: null, needs_reconciliation: true });
      expect(by(down, 'credited').reason).toMatch(/payment-state check could not be completed — needs reconciliation/);
      expect(down.account_summary.total_due).toBe(0);
      const detail = await read('get_invoice_detail', { invoice_id: inv.credited.id });
      expect(detail.invoice).toMatchObject({ collectible: false, balance_due: null, needs_reconciliation: true });
    } finally { spy.mockRestore(); }
    const stripeDown = jest.spyOn(stripe, 'assertNoInvoiceChargeReconciliationPending').mockRejectedValue(Object.assign(new Error('Invoice has an unresolved Stripe charge pi_secret123'), { code: 'STRIPE_CHARGED_DB_FAILED', reconciliationRequired: true }));
    try {
      const held = await read('get_invoice_detail', { invoice_id: inv.credited.id });
      expect(held.invoice.reason).toMatch(/Stripe charged this invoice and the portal has not recorded it — needs reconciliation — check the Invoices page/);
      expect(json(held)).not.toContain('pi_secret123');
    } finally { stripeDown.mockRestore(); }
  });

  test('account summary: total_due adds up only collectible invoices; reconciliation and other holds are counted apart', async () => {
    const { account_summary: summary } = await read('get_customer_invoices', { customer_id: A });
    // credited 100 + draft 40 + fillers 10+11+12+13 + failsup 66 (archived excluded; open, amb, orphan, failamb held by the fence; paid, void, processing terminal).
    expect(summary).toMatchObject({ total_due: 252, needs_reconciliation_count: 4, not_yet_sent_due: 40, overdue_count: 0, outstanding_count: 11 });
    // The one overdue invoice is held by the fence, so it is not counted as overdue (never a raw status count).
    expect(summary.dispute_hold).toMatchObject({ active: false });
    expect(summary.unknown).toMatch(/4 invoice\(s\) \(unpaid or processing\) need reconciliation and are NOT in total_due/);
    expect(summary).toMatchObject({ credit_balance: 25 });
    for (const field of ['complete', 'unreconciled_stripe_charges', 'unresolved_charge_attempts']) expect(summary).not.toHaveProperty(field);
    // A customer with nothing held states its total with no warning.
    const b = await read('get_customer_invoices', { customer_id: B });
    expect(b.account_summary.total_due).toBe(999.99);
    expect(b.account_summary.unknown).toBeUndefined();
  });

  test('a processing invoice is a bank payment in flight only when the charge fence is clear; a parked saved-card ambiguity needs reconciliation, in the list, the detail and the summary', async () => {
    const list = await read('get_customer_invoices', { customer_id: Y, limit: 50 });
    expect(by(list, 'y_ach')).toMatchObject({ collectible: false, needs_reconciliation: false, balance_due: null, amount_due_after_credit: null, reason: expect.stringMatching(/already processing/) });
    expect(by(list, 'y_parked')).toMatchObject({ collectible: false, needs_reconciliation: true, balance_due: null, amount_due_after_credit: null });
    expect(by(list, 'y_parked').reason).toMatch(/saved-card charge is in progress or awaiting reconciliation — needs reconciliation — check the Invoices page/);
    expect(list.account_summary.processing).toMatchObject({ count: 2, bank_payment_in_flight: 1, needs_reconciliation: 1 });
    expect(list.account_summary.needs_reconciliation_count).toBe(1);
    expect(list.account_summary.unknown).toMatch(/1 invoice\(s\) \(unpaid or processing\) need reconciliation/);
    const detail = await read('get_invoice_detail', { invoice_id: inv.y_parked.id });
    expect(detail.invoice).toMatchObject({ needs_reconciliation: true, balance_due: null, amount_due_after_credit: null });
    expect((await read('get_invoice_detail', { invoice_id: inv.y_ach.id })).invoice.needs_reconciliation).toBe(false);
    // An ordinary processing invoice is all in flight.
    const a = await read('get_customer_invoices', { customer_id: A });
    expect(a.account_summary.processing).toMatchObject({ count: 1, bank_payment_in_flight: 1, needs_reconciliation: 0 });
  });

  test('payer-billed and withdrawn invoices are not collectible from the customer (the payment paths\' own predicate), held back and not in total_due', async () => {
    const result = await read('get_customer_invoices', { customer_id: E, limit: 50 });
    // Only the self-pay invoices count: self 100 + draft 40. A payer-billed draft, a sent payer invoice and a withdrawn Bill-To are held back.
    expect(result.account_summary).toMatchObject({ total_due: 140, not_yet_sent_due: 40, presented_self_pay_due: 100, needs_reconciliation_count: 0 });
    expect(result.account_summary).not.toHaveProperty('payer_billed_due');
    expect(result.account_summary.unknown).toMatch(/3 unpaid invoice\(s\) are not collectible from this customer/);
    expect(by(result, 'e_withdrawn')).toMatchObject({ payer_billed: true, collectible: false, balance_due: null, needs_reconciliation: false });
    expect(by(result, 'e_withdrawn').reason).toMatch(/billed to a third-party payer and is no longer payable here/);
    expect(by(result, 'e_payer_sent')).toMatchObject({ payer_billed: true, collectible: false, balance_due: null, amount_due_after_credit: null });
    expect(by(result, 'e_payer_sent').reason).toMatch(/billed to a third-party payer/);
    expect(by(result, 'e_self')).toMatchObject({ payer_billed: false, collectible: true, balance_due: 100 });
  });

  test('a received estimate deposit not yet applied to its invoice holds the balance (the pay paths\' deposit-settlement fence)', async () => {
    const list = await read('get_customer_invoices', { customer_id: D2, limit: 50 });
    expect(by(list, 'd2_pending')).toMatchObject({ collectible: false, balance_due: null, amount_due_after_credit: null, needs_reconciliation: true });
    expect(by(list, 'd2_pending').reason).toMatch(/estimate deposit has been received and is not yet applied to this invoice — needs reconciliation — check the Invoices page/);
    expect(by(list, 'd2_plain')).toMatchObject({ collectible: true, balance_due: 30 });
    expect(list.account_summary).toMatchObject({ total_due: 30, needs_reconciliation_count: 1 });
    const detail = await read('get_invoice_detail', { invoice_id: inv.d2_pending.id });
    expect(detail.invoice).toMatchObject({ collectible: false, balance_due: null, needs_reconciliation: true });
  });

  test('an ordinary ACH debit in flight (unresolved attempt + a processing payments row) is a bank payment processing, not a reconciliation defect', async () => {
    const list = await read('get_customer_invoices', { customer_id: X, limit: 50 });
    for (const key of ['x_ach_sent', 'x_ach_proc']) {
      expect(by(list, key)).toMatchObject({ collectible: false, balance_due: null, amount_due_after_credit: null, needs_reconciliation: false, bank_payment_processing: true });
      expect(by(list, key).reason).toMatch(/bank payment is processing on this invoice \(an ACH debit in flight\)/);
    }
    // Counted under bank_payment_in_flight (the sent one is not even in the processing status), never as needing reconciliation.
    expect(list.account_summary.processing).toMatchObject({ count: 1, bank_payment_in_flight: 2, needs_reconciliation: 0 });
    expect(list.account_summary.needs_reconciliation_count).toBe(0);
    // The parked card ambiguity (an attempt with no PaymentIntent) is still a reconciliation defect.
    const parked = await read('get_invoice_detail', { invoice_id: inv.y_parked.id });
    expect(parked.invoice).toMatchObject({ needs_reconciliation: true, bank_payment_processing: false });
  });

  test('a summary that cannot be complete is null with a warning, never a partial number', async () => {
    const InvoiceService = require('../services/invoice');
    const original = InvoiceService.list.bind(InvoiceService);
    const fake = (count) => jest.spyOn(InvoiceService, 'list').mockImplementation(async (params) => {
      if (params.status === 'unpaid' && params.limit === 100) {
        return { total: count, invoices: Array.from({ length: Math.min(100, count - params.offset) }, () => ({ id: uid(), status: 'sent', total: 10, credit_applied: 0 })) };
      }
      return original(params);
    });
    let spy = fake(5000);
    try {
      spy.mockClear();
      const { account_summary: summary } = await read('get_customer_invoices', { customer_id: E, limit: 5 });
      for (const field of ['total_due', 'not_yet_sent_due', 'presented_self_pay_due', 'needs_reconciliation_count']) expect(summary[field]).toBeNull();
      expect(summary.outstanding_count).toBe(5000);
      expect(summary.unknown).toMatch(/null \(unknown\), not zero/);
      // Stopped at the first page: the total proved the fence cap was exceeded (no ten-page crawl).
      expect(spy.mock.calls.filter(([params]) => params.status === 'unpaid' && params.limit === 100)).toHaveLength(1);
    } finally { spy.mockRestore(); }
    spy = fake(150);
    try {
      const { account_summary: summary } = await read('get_customer_invoices', { customer_id: E, limit: 5 });
      expect(summary.total_due).toBeNull();
      expect(summary.unknown).toMatch(/More than 100 unpaid invoices to check for reconciliation/);
    } finally { spy.mockRestore(); }
  });

  test('overdue_count counts collectible overdue invoices only', async () => {
    const b = await read('get_customer_invoices', { customer_id: B });
    expect(b.account_summary.overdue_count).toBe(1);
    expect(by(b, 'b_open')).toMatchObject({ overdue: true, collectible: true });
    const a = await read('get_customer_invoices', { customer_id: A });
    expect(by(a, 'open')).toMatchObject({ overdue: null, collectible: false });
    expect(a.account_summary.overdue_count).toBe(0);
  });

  test('each call runs in ONE read-only REPEATABLE READ snapshot: a commit mid-call is invisible to every read', async () => {
    const InvoiceService = require('../services/invoice');
    const original = InvoiceService.list.bind(InvoiceService);
    let flipped = false;
    const modes = new Set();
    // After the page is read, another connection pays the invoice and commits: the rest of the call must not see it.
    const spy = jest.spyOn(InvoiceService, 'list').mockImplementation(async (params) => {
      const result = await original(params);
      const { rows: [mode] } = await params.database.raw("select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only");
      modes.add(`${mode.isolation}/${mode.read_only}/${params.database.isTransaction}`);
      if (!flipped && params.limit !== 100) {
        flipped = true;
        await db('invoices').where({ id: inv.credited.id }).update({ status: 'paid', credit_applied: 150 });
      }
      return result;
    });
    try {
      const list = await read('get_customer_invoices', { customer_id: A, limit: 50 });
      expect(by(list, 'credited')).toMatchObject({ status: 'sent', credit_applied: 50, collectible: true, balance_due: 100 });
      expect(list.account_summary.total_due).toBe(252);
      // Every list read ran on the call's one connection: a read-only REPEATABLE READ transaction.
      expect([...modes]).toEqual(['repeatable read/on/true']);
      expect(new Set(spy.mock.calls.map(([params]) => params.database)).size).toBe(1);
    } finally {
      spy.mockRestore();
      await db('invoices').where({ id: inv.credited.id }).update({ status: 'sent', credit_applied: 50 });
    }
    // The next call sees the restored state like any other.
    expect(by(await read('get_customer_invoices', { customer_id: A, limit: 50 }), 'credited')).toMatchObject({ collectible: true, balance_due: 100 });
  });

  test('an invoice that changed hands during the read is unavailable: left out of the list, the totals and the detail, never shown under the old header', async () => {
    const payCombined = require('../services/pay-combined');
    const original = payCombined.memberCollectionPending;
    const spy = jest.spyOn(payCombined, 'memberCollectionPending').mockImplementation(async (invoice, options) => (
      String(invoice.id) === String(inv.credited.id) ? { reason: 'customer_changed' } : original(invoice, options)));
    try {
      const list = await read('get_customer_invoices', { customer_id: A, limit: 50 });
      expect(by(list, 'credited')).toBeUndefined();
      expect(list.unavailable_invoices).toEqual([{ id: inv.credited.id, reason: 'this record changed hands during the read; ask again' }]);
      expect(list.account_summary.total_due).toBe(152);
      expect(list.account_summary.unknown).toMatch(/1 invoice\(s\) changed hands during the read/);
      expect(list.unknowns.join(' ')).toMatch(/changed hands during the read/);
      const detail = await read('get_invoice_detail', { invoice_id: inv.credited.id });
      expect(detail).toMatchObject({ code: 'record_unavailable' });
      expect(detail.error).toMatch(/changed hands during the read; ask again/);
      expect(json(detail)).not.toContain('Synthetic credited');
    } finally { spy.mockRestore(); }
  });

  test('card numbers are masked whatever the separator, Luhn-valid or not; ISO dates, UUIDs and amounts are left alone', async () => {
    const Q = await customer(`Cards${run}`, `Masked${run}`);
    const masked = ['4111.1111.1111.1111', '4111/1111/1111/1111', '4111 1111 1111 1111', '4111_1111_1111_1111', '4111-1111.1111/1111', '4111111111111111', '378282246310005', '1234567890123', '1234 5678 9012 3456 78'];
    for (const [n, number] of masked.entries()) await invoice(`q_card_${n}`, Q, { total: 5, title: `Paid with ${number} thanks` });
    await invoice('q_kept', Q, { total: 5, title: 'Visit 2026-10-02 14:05:10 invoice 12.50 id 12345678-1234-4123-8123-123456789012 ok' });
    const text = json(await read('get_customer_invoices', { customer_id: Q, limit: 50 }));
    expect(text).not.toMatch(/4111|378282|1234567890123|1234 5678/);
    expect((text.match(/Paid with \[number\] thanks/g) || []).length).toBe(masked.length);
    expect(text).toContain('Visit 2026-10-02 14:05:10 invoice 12.50 id 12345678-1234-4123-8123-123456789012 ok');
  });

  test('a dispute hold is stated for that customer only, and a failed per-invoice lookup is unknown (null), never false', async () => {
    const held = await read('get_customer_invoices', { customer_id: H });
    expect(held.account_summary.dispute_hold.active).toBe(true);
    expect(held.invoices[0].dispute_hold).toBe(true);
    expect((await read('get_invoice_detail', { invoice_id: inv.h_open.id })).dispute_hold.active).toBe(true);
    const other = await read('get_customer_invoices', { customer_id: A });
    expect(other.invoices.every((i) => i.dispute_hold === false)).toBe(true);
    const hold = require('../services/collections/collection-hold');
    const spy = jest.spyOn(hold, 'collectionHoldInvoiceIds').mockRejectedValueOnce(new Error('synthetic lookup failure'));
    try {
      const result = await read('get_customer_invoices', { customer_id: A, limit: 50 });
      expect(result.invoices.every((i) => i.dispute_hold === null)).toBe(true);
      expect(result.unknowns.join(' ')).toMatch(/per-invoice dispute hold could not be read/);
    } finally { spy.mockRestore(); }
  });

  test('invoice detail: the fence decides the balance; recorded payments are informational rows with no received verdict', async () => {
    const paid = await read('get_invoice_detail', { invoice_id: inv.paid.id });
    expect(paid.invoice).toMatchObject({ status: 'paid', collectible: false, balance_due: null, payment_method: 'check', payment_reference: 'CHK-1001' });
    expect(paid.recorded_payments).toEqual([expect.objectContaining({ amount: 120, status: 'paid', method: 'check', refunded_amount: 0 })]);
    expect(paid.recorded_payments_note).toMatch(/no verdict/);
    const held = await read('get_invoice_detail', { invoice_id: inv.open.id });
    expect(held.invoice).toMatchObject({ collectible: false, balance_due: null, needs_reconciliation: true, overdue: null });
    expect(held.invoice.reason).toMatch(/needs reconciliation — check the Invoices page/);
    expect(held.payment_plan.active).toMatchObject({ payment_amount: null, total_balance: null, payment_frequency: 'monthly' });
    expect(held.invoice).toMatchObject({ amount_due_after_credit: null, total: 200 });
    expect(paid.invoice).toMatchObject({ amount_due_after_credit: null, total: 120 });
    const ok = await read('get_invoice_detail', { invoice_id: inv.credited.id });
    expect(ok.invoice).toMatchObject({ collectible: true, balance_due: 100, amount_due_after_credit: 100, credit_applied: 50 });
    expect(ok.recorded_payments).toEqual([]);
    expect(ok.line_items[0]).toMatchObject({ category: 'service' });
    // Neither tool carries a receipt verdict anywhere.
    const text = json([paid, held, ok, await read('get_customer_invoices', { customer_id: A, limit: 50 })]);
    for (const word of ['"received"', 'payment_summary', 'payments_timeline', 'stripe_unreconciled_charge', '"payment_recorded"', '"amount_paid"']) expect(text).not.toContain(word);
  });

  test('recorded payments: a payer-funded row names the payer, the dispute and waves aliases are listed, and the read bound is flagged', async () => {
    const funded = await read('get_invoice_detail', { invoice_id: inv.g_payer.id });
    expect(funded.recorded_payments).toEqual([expect.objectContaining({ amount: 300, funded_by_payer: { id: expect.any(Number), name: `Synthetic Payer ${run}` } })]);
    const alias = await read('get_invoice_detail', { invoice_id: inv.g_alias.id });
    expect(alias.recorded_payments.map((p) => p.status).sort()).toEqual(['disputed', 'paid']);
    expect(alias.recorded_payments.find((p) => p.status === 'disputed')).toMatchObject({ amount: 150, method: 'stripe visa' });
    expect(alias.invoice).toMatchObject({ collectible: true, balance_due: 150 });
    const stmt = await read('get_invoice_detail', { invoice_id: inv.g_stmt.id });
    expect(stmt.recorded_payments).toEqual([expect.objectContaining({ amount: null, status: 'paid', funded_by_payer: { id: expect.any(Number), name: `Synthetic Payer ${run}` },
      statement_level: { statement_id: String(inv.statementId), statement_amount: 900, applies_to: expect.stringMatching(/not this invoice alone/) } })]);
    const legacy = await read('get_invoice_detail', { invoice_id: inv.g_legacy.id });
    expect(legacy.recorded_payments.map((p) => p.amount).sort((a, b) => a - b)).toEqual([5, 70]);
    expect(legacy.recorded_payments.find((p) => p.amount === 70)).toMatchObject({ status: 'refunded', refunded_amount: 20, refund_status: 'succeeded' });
    const methods = (await read('get_invoice_detail', { invoice_id: inv.g_method.id })).recorded_payments;
    const methodOf = (amount) => methods.find((p) => p.amount === amount).method;
    expect([1, 2, 3, 4].map(methodOf)).toEqual(['us_bank_account', 'ach_snapshot', 'zelle', 'stripe']);
    const bulk = await read('get_invoice_detail', { invoice_id: inv.g_bulk.id });
    expect(bulk.recorded_payments).toHaveLength(50);
    expect(bulk.unknowns.join(' ')).toMatch(/More payment rows are tied to this invoice than were read/);
  });

  test('an invoice with an attached PaymentIntent holds its balance (a payment was started; the reader does not call Stripe); so does every combined sibling', async () => {
    const list = await read('get_customer_invoices', { customer_id: Z, limit: 50 });
    for (const key of ['z_attached', 'z_sibling']) {
      expect(by(list, key)).toMatchObject({ collectible: false, balance_due: null, needs_reconciliation: true, overdue: null });
      expect(by(list, key).reason).toBe('a payment was started on this invoice and its outcome is not confirmed here — check the Invoices page');
    }
    expect(by(list, 'z_plain')).toMatchObject({ collectible: true, balance_due: 15 });
    expect(list.account_summary).toMatchObject({ total_due: 15, needs_reconciliation_count: 2 });
    const detail = await read('get_invoice_detail', { invoice_id: inv.z_sibling.id });
    expect(detail.invoice).toMatchObject({ collectible: false, balance_due: null, needs_reconciliation: true });
    expect(json(detail)).not.toContain(`pi_attached_${run}`);
  });

  test('egress: an email and a PAN-like number seeded in every free-text column the readers select never appear in any result', async () => {
    const list = await read('get_customer_invoices', { customer_id: L, limit: 50 });
    const detail = await read('get_invoice_detail', { invoice_id: inv.l_leak.id });
    const text = json([list, detail]);
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/4111/);
    expect(text).toContain('[email]');
    expect(text).toContain('[number]');
    // The fields really were read (so the test proves the scrubber, not an empty projection).
    expect(detail.line_items[0]).toMatchObject({ description: expect.stringContaining('[email]'), category: expect.stringContaining('[email]') });
    expect(detail.invoice.payment_reference).toContain('[email]');
    expect(detail.recorded_payments[0].funded_by_payer.name).toContain('[email]');
    expect(detail.payment_plan.active).toBeNull();
    expect(detail.payment_plan.history[0].payment_frequency).toContain('[email]');
  });

  test('egress keeps digit-heavy record ids intact, so a listed id works in the follow-up read', async () => {
    const list = await read('get_customer_invoices', { customer_id: N });
    expect(list.customer.id).toBe(N);
    expect(list.invoices[0].id).toBe('12345678-1234-4123-8123-123456789012');
    const detail = await read('get_invoice_detail', { invoice_id: list.invoices[0].id });
    expect(detail.error).toBeUndefined();
    expect(detail.invoice.id).toBe('12345678-1234-4123-8123-123456789012');
    expect(detail.customer.id).toBe(N);
  });

  test('conflicting tender evidence (invoice bank, payment row card) is never bank processing', async () => {
    const list = await read('get_customer_invoices', { customer_id: R2, limit: 50 });
    expect(by(list, 'r2_mixed')).toMatchObject({ collectible: false, needs_reconciliation: true, bank_payment_processing: false });
    expect(list.account_summary.processing.bank_payment_in_flight).toBe(0);
    // A processing-status invoice with a card row and a bank invoice method conflicts too.
    expect(by(await read('get_customer_invoices', { customer_id: Y, limit: 50 }), 'y_ach')).toMatchObject({ bank_payment_processing: true });
  });

  test('sibling rows that name other invoices are excluded before the history limit', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.r2_flood.id });
    expect(detail.recorded_payments.map((p) => p.amount)).toEqual([15]);
    expect(detail.unknowns.join(' ')).not.toMatch(/More payment rows/);
  });

  test('annual prepay linkage resolves through the term\'s prepay_invoice_id when the invoice has no term id of its own', async () => {
    const list = await read('get_customer_invoices', { customer_id: T });
    expect(by(list, 't_prepay').annual_prepay).toMatchObject({ role: 'prepay_invoice', term_id: inv.prepayTermId, term_status: 'active' });
    const detail = await read('get_invoice_detail', { invoice_id: inv.t_prepay.id });
    expect(detail.annual_prepay).toMatchObject({ role: 'prepay_invoice', term_id: inv.prepayTermId, term_status: 'active', prepay_amount: 600 });
    expect((await read('get_invoice_detail', { invoice_id: inv.credited.id })).annual_prepay).toBeNull();
  });

  test('payment-plan history is bounded with a truncation flag and an unknown warning', async () => {
    const detail = await read('get_invoice_detail', { invoice_id: inv.m_plans.id });
    expect(detail.payment_plan.history).toHaveLength(5);
    expect(detail.payment_plan.history_truncated).toBe(true);
    expect(detail.unknowns.join(' ')).toMatch(/more than 5 payment plans/);
    const single = await read('get_invoice_detail', { invoice_id: inv.credited.id });
    expect(single.payment_plan.history_truncated).toBe(false);
  });

  test('every verdict, held ones included, projects the facts from a fresh read of the invoice', async () => {
    const InvoiceService = require('../services/invoice');
    const original = InvoiceService.list.bind(InvoiceService);
    // The list hands back an older snapshot: the invoice has since been paid.
    const spy = jest.spyOn(InvoiceService, 'list').mockImplementation(async (params) => {
      const result = await original(params);
      if (params.limit === 100 || params.customerId !== A) return result;
      return { ...result, invoices: result.invoices.map((row) => (String(row.id) === String(inv.paid.id) ? { ...row, status: 'sent', credit_applied: 0, total: 999 } : row)) };
    });
    try {
      const item = by(await read('get_customer_invoices', { customer_id: A, limit: 50 }), 'paid');
      expect(item).toMatchObject({ status: 'paid', total: 120, collectible: false, balance_due: null, amount_due_after_credit: null });
      expect(item.reason).toMatch(/already paid/);
    } finally { spy.mockRestore(); }
  });

  test('bank_payment_processing needs bank-tender evidence: a processing card intent, or an unknown tender, needs reconciliation ("a card payment did not complete")', async () => {
    const list = await read('get_customer_invoices', { customer_id: V, limit: 50 });
    // Fence clear and no bank tender (nothing recorded): the card-incomplete reason. With an unresolved attempt the fence's own reason leads.
    expect(by(list, 'v_unknown')).toMatchObject({ collectible: false, balance_due: null, needs_reconciliation: true, bank_payment_processing: false, reason: 'a card payment did not complete — check the Invoices page' });
    expect(by(list, 'v_card')).toMatchObject({ collectible: false, balance_due: null, needs_reconciliation: true, bank_payment_processing: false });
    expect(by(list, 'v_card').reason).toMatch(/unconfirmed outcome \(Stripe may have charged it\) — needs reconciliation — check the Invoices page/);
    // A non-processing invoice whose attempt and processing row are a card is no bank debit either.
    expect(by(list, 'v_sent_card')).toMatchObject({ collectible: false, needs_reconciliation: true, bank_payment_processing: false });
    expect(list.account_summary.processing).toMatchObject({ count: 2, bank_payment_in_flight: 0, needs_reconciliation: 2 });
    expect(list.account_summary.needs_reconciliation_count).toBe(3);
    const byAttempt = await read('get_customer_invoices', { customer_id: U, limit: 50 });
    expect(by(byAttempt, 'u_attempt_tender')).toMatchObject({ bank_payment_processing: true, needs_reconciliation: false });
    // The same classifier the pay paths use reads the invoice: a bank-tender processing invoice stays in flight.
    const rcof = require('../services/recurring-card-on-file');
    expect(rcof.classifySavedMethodChargeInvoice({ status: 'processing', payment_method: 'us_bank_account' })).toBe('bank_processing');
    expect(rcof.classifySavedMethodChargeInvoice(inv.v_card)).toBe('card_incomplete');
    expect(by(await read('get_customer_invoices', { customer_id: Y, limit: 50 }), 'y_ach')).toMatchObject({ bank_payment_processing: true, needs_reconciliation: false });
  });

  test('every invoice fact comes from the row the fence re-read, so the breakdown agrees with the balance (list and detail)', async () => {
    const payCombined = require('../services/pay-combined');
    const base = await db('invoices').where({ id: inv.credited.id }).first();
    const original = payCombined.memberCollectionPending;
    const spy = jest.spyOn(payCombined, 'memberCollectionPending').mockImplementation(async (invoice, options) => (
      String(invoice.id) === String(base.id) ? { row: { ...base, credit_applied: 0, total: 150, title: 'Refreshed title' } } : original(invoice, options)));
    try {
      const item = by(await read('get_customer_invoices', { customer_id: A, limit: 50 }), 'credited');
      expect(item).toMatchObject({ total: 150, credit_applied: 0, balance_due: 150, amount_due_after_credit: 150, title: 'Refreshed title' });
      expect(item.payment_plan).toMatchObject({ payment_amount: 25 });
      const detail = await read('get_invoice_detail', { invoice_id: inv.credited.id });
      expect(detail.invoice).toMatchObject({ total: 150, credit_applied: 0, balance_due: 150, title: 'Refreshed title' });
      expect(detail.discounts.account_credit_applied).toBe(0);
    } finally { spy.mockRestore(); }
  });

  test('ACH evidence never clears an unrelated hold: an orphan charge, an ambiguous failed row or a charged-but-unrecorded intent stays needs_reconciliation', async () => {
    const list = await read('get_customer_invoices', { customer_id: W2, limit: 50 });
    for (const key of ['w2_orphan', 'w2_failamb', 'w2_dbfail']) {
      expect(by(list, key)).toMatchObject({ collectible: false, balance_due: null, needs_reconciliation: true, bank_payment_processing: false });
    }
    expect(list.account_summary).toMatchObject({ needs_reconciliation_count: 3, total_due: 0 });
    expect(list.account_summary.processing.bank_payment_in_flight).toBe(0);
  });

  test('the amount and the attached-intent hold come from the row the collection fence re-read, not the older listed row', async () => {
    const payCombined = require('../services/pay-combined');
    const base = await db('invoices').where({ id: inv.credited.id }).first();
    const original = payCombined.memberCollectionPending;
    let freshRow = { ...base, credit_applied: 0 };
    const spy = jest.spyOn(payCombined, 'memberCollectionPending').mockImplementation(async (invoice, options) => (
      String(invoice.id) === String(base.id) ? { row: freshRow } : original(invoice, options)));
    try {
      expect(by(await read('get_customer_invoices', { customer_id: A, limit: 50 }), 'credited')).toMatchObject({ collectible: true, balance_due: 150, amount_due_after_credit: 150 });
      freshRow = { ...base, stripe_payment_intent_id: `pi_late_${run}` };
      const held = await read('get_invoice_detail', { invoice_id: inv.credited.id });
      expect(held.invoice).toMatchObject({ collectible: false, balance_due: null, amount_due_after_credit: null, needs_reconciliation: true });
      const summary = (await read('get_customer_invoices', { customer_id: A, limit: 1 })).account_summary;
      expect(summary.total_due).toBe(152);
    } finally { spy.mockRestore(); }
  });

  test('a failed credit read keeps its own reason: the invoice warnings are appended, never overwrite it', async () => {
    const CustomerCredit = require('../services/customer-credit');
    const spy = jest.spyOn(CustomerCredit, 'getBalance').mockRejectedValue(new Error('credit lookup failed'));
    try {
      const { account_summary: summary } = await read('get_customer_invoices', { customer_id: D2, limit: 5 });
      expect(summary).toMatchObject({ credit_balance: null, credit_ledger_sum: null, credit_matches_ledger: null });
      expect(summary.unknown).toMatch(/account credit balance could not be read; say it is unknown/);
      expect(summary.unknown).toMatch(/1 invoice\(s\) \(unpaid or processing\) need reconciliation/);
    } finally { spy.mockRestore(); }
  });

  test('credit_matches_ledger compares one snapshot: a ledger write committing between the reads cannot cause a false mismatch', async () => {
    const CustomerCredit = require('../services/customer-credit');
    const original = CustomerCredit.getBalance;
    const spy = jest.spyOn(CustomerCredit, 'getBalance').mockImplementation(async (...args) => {
      const balance = await original(...args);
      // A grant commits on another connection after the balance was read.
      await db('customer_credit_ledger').insert({ customer_id: Z, delta: 5, balance_after: 15, source: 'manual', note: 'Concurrent grant' });
      await db('customers').where({ id: Z }).update({ account_credits: 15 });
      return balance;
    });
    try {
      const during = await read('get_customer_invoices', { customer_id: Z, limit: 1 });
      expect(during.account_summary).toMatchObject({ credit_balance: 10, credit_ledger_sum: 10, credit_matches_ledger: true });
    } finally { spy.mockRestore(); }
    const after = await read('get_customer_invoices', { customer_id: Z, limit: 1 });
    expect(after.account_summary).toMatchObject({ credit_balance: 15, credit_ledger_sum: 15, credit_matches_ledger: true });
  });

  test('no card number, full email or invoice token leaves either tool', async () => {
    const outputs = [];
    for (const key of ['open', 'paid', 'amb', 'failamb', 'orphan', 'credited']) outputs.push(json(await read('get_invoice_detail', { invoice_id: inv[key].id })));
    outputs.push(json(await read('get_customer_invoices', { customer_id: A, include_archived: true, limit: 50 })));
    const all = outputs.join('\n');
    expect(all).not.toMatch(/example\.com/);
    expect(all).not.toMatch(/4242/);
    expect(all).not.toMatch(/@/);
    for (const token of tokens) expect(all).not.toContain(token);
    expect(all).not.toMatch(/client_secret/);
  });

  test('same-surname isolation: the neighbour\'s invoices never appear, by id or name', async () => {
    const aIds = await db('invoices').where({ customer_id: A }).pluck('id');
    const results = [
      await read('get_customer_invoices', { customer_id: A, include_archived: true, limit: 50 }),
      await read('get_customer_invoices', { customer_name: `Thessaly${run}`, include_archived: true, limit: 50 }),
    ];
    for (const result of results) {
      expect(result.customer.id).toBe(A);
      const text = json(result);
      expect(text).not.toContain(inv.b_open.id);
      expect(text).not.toContain('SENTINEL-B');
      expect(text).not.toContain('999.99');
      expect(result.invoices.every((i) => aIds.includes(i.id))).toBe(true);
    }
    expect(json(await read('get_customer_invoices', { customer_id: B }))).not.toContain(inv.open.id);
  });

  test('a shared surname is ambiguous (candidates, no invoices); a conflicting selector is refused; there is no phone selector', async () => {
    const ambiguous = await read('get_customer_invoices', { customer_name: SURNAME });
    expect(ambiguous).toMatchObject({ ambiguous: true });
    expect(ambiguous.invoices).toBeUndefined();
    expect(ambiguous.candidates.map((c) => c.id).sort()).toEqual([A, B].sort());
    expect(await read('get_customer_invoices', { customer_id: A, customer_name: `Orville${run}` })).toMatchObject({ code: 'selector_conflict' });
    expect(await read('get_customer_invoices', { customer_id: uid() })).toMatchObject({ code: 'record_unavailable' });
    expect(await read('get_customer_invoices', {})).toMatchObject({ code: 'selector_required' });
    const phoneA = (await db('customers').where({ id: A }).first('phone')).phone;
    expect((await read('get_customer_invoices', { phone: phoneA })).error).toBeDefined();
  });

  test('task scope: another customer\'s invoice or id is refused even with its exact id', async () => {
    const scoped = { readCustomerIds: [A] };
    expect(await read('get_invoice_detail', { invoice_id: inv.b_open.id }, scoped)).toMatchObject({ code: 'target_clarification_required' });
    expect(await read('get_customer_invoices', { customer_id: B }, scoped)).toMatchObject({ code: 'target_clarification_required' });
    expect((await read('get_invoice_detail', { invoice_id: inv.open.id }, scoped)).invoice.id).toBe(inv.open.id);
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
  });

  test('both readers write nothing (the read-only fence releases and promotes no claim)', async () => {
    const before = await snapshot();
    await read('get_customer_invoices', { customer_id: A, include_archived: true, limit: 50 });
    for (const key of ['open', 'paid', 'orphan', 'amb', 'credited', 'draft']) await read('get_invoice_detail', { invoice_id: inv[key].id });
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
