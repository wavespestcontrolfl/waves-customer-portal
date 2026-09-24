/**
 * Audit repro r2-prepay-switch-and-term-lifecycle-1 (P1/money):
 *
 * An ESTIMATE-origin on-site prepay switch deliberately skips the
 * setup_fee_claims ledger record (admin-schedule.js:17106-17118, codex #3591
 * r38 P1) because a later void/refund re-mints the superseded accept invoice
 * WITH its "Bait Station Setup" line. But the very first payment of that
 * prepay runs syncTermForInvoicePayment's payment_pending -> active branch
 * (annual-prepay-renewals.js:2848-2866), which calls
 * InvoiceService.retireRodentSetupObligationForRevivedPrepay unconditionally
 * and ledgers exactly the claim the switch refused to write. On refund the
 * cancel branch then restores the setup TWICE: the re-minted accept invoice
 * carries the $99 line AND restoreRetiredSetupFeeClaimForPrepay stamps the
 * series root with pending_setup_fee=99 (consumed by the next completion).
 *
 * Runs only against a private waves_audit_* Postgres clone:
 *   createdb -h localhost -T waves_audit_tpl waves_audit_<slug>
 *   DATABASE_URL=postgres://wavespestcontrol@localhost:5432/waves_audit_<slug> \
 *     NODE_ENV=test npx jest --runInBand tests/audit-repro/r2-prepay-switch-and-term-lifecycle-1.test.js
 *
 * Written to assert the CORRECT behaviour — it FAILS on current code.
 */
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref', 'destroy']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn', 'client']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/invoice-followups', () => ({
  stopSequence: jest.fn(async () => undefined),
  resumeSequence: jest.fn(async () => undefined),
  scheduleForInvoice: jest.fn(async () => undefined),
}));
// The restore's Stripe reconciliation probe is a network-facing guard; the
// production tests stub it the same way.
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined),
  chargeInvoiceWithSavedCard: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: jest.fn(() => false),
}));
// admin-customers pulls the whole admin router graph; only the advisory lock
// helper is needed and the lifecycle tests stub it identically.
jest.mock('../routes/admin-customers', () => ({
  _private: { lockAndAssertNoAnnualPrepayOverlap: jest.fn(async () => {}) },
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: false, blocked: true, code: 'test' })),
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ suppressed: true })) }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn(async () => ({ sent: 0 })) }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(), loadTemplateByKey: jest.fn(async () => null), activeSuppressionFor: jest.fn(async () => null),
}));

const knex = require('knex');
const { randomUUID } = require('crypto');

const connection = process.env.DATABASE_URL;
const postgres = connection && /\/waves_audit_/.test(connection) ? describe : describe.skip;
let mockPg;
jest.setTimeout(90000);

const SETUP_LINE = 'Bait Station Setup — one-time setup fee';

function addMonths(dateStr, months) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

async function seed() {
  const { etDateString } = require('../utils/datetime-et');
  const today = etDateString();
  const f = {
    customerId: randomUUID(),
    estimateId: randomUUID(),
    rootId: randomUUID(),
    acceptInvoiceId: randomUUID(),
    prepayInvoiceId: randomUUID(),
    termId: randomUUID(),
    acceptClaimId: randomUUID(),
  };
  await mockPg('customers').insert({
    id: f.customerId, first_name: 'Fixture', last_name: 'Switch', phone: '+12025550177',
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false,
    billing_mode: 'annual_prepay',
  });
  // The accepted estimate the series and the term point at (FK targets only).
  await mockPg('estimates').insert({ id: f.estimateId, status: 'accepted' }).catch(async () => {
    await mockPg('estimates').insert({ id: f.estimateId });
  });
  // Rodent bait series root booked from the accepted estimate (per-application).
  await mockPg('scheduled_services').insert({
    id: f.rootId, customer_id: f.customerId, service_type: 'Rodent Bait Stations',
    scheduled_date: addMonths(today, 1), window_start: '09:00', window_end: '10:00', status: 'pending',
    estimated_price: 128, source_estimate_id: f.estimateId, pending_setup_fee: null,
  });
  // INV-A: the accept invoice the switch CAS-voided, superseded-by marker on
  // the notes, both lines intact (admin-schedule prepay-switch).
  await mockPg('invoices').insert({
    id: f.acceptInvoiceId, token: randomUUID(), invoice_number: `AUD-${f.acceptInvoiceId.slice(0, 8)}`,
    customer_id: f.customerId, scheduled_service_id: f.rootId, title: 'Rodent Bait Stations — First Application',
    status: 'void', total: 227, subtotal: 227,
    notes: `Auto-generated from accepted estimate #${f.estimateId}.\n[prepay-switch-superseded-by:${f.prepayInvoiceId}]`,
    line_items: JSON.stringify([
      { description: 'First service application', quantity: 1, unit_price: 128, amount: 128 },
      { description: SETUP_LINE, quantity: 1, unit_price: 99, amount: 99, category: 'Setup fee' },
    ]),
    due_date: today,
  });
  // The standard accept ledgers its own claim on INV-A (estimate-public.js:11938).
  await mockPg('setup_fee_claims').insert({
    id: f.acceptClaimId, invoice_id: f.acceptInvoiceId, scheduled_service_id: f.rootId, amount: 99, estimate_id: f.estimateId,
  });
  // P: the switch-minted prepay, its own setup line, NO claim record
  // (estimate-origin lane), unpaid at mint.
  await mockPg('invoices').insert({
    id: f.prepayInvoiceId, token: randomUUID(), invoice_number: `AUD-${f.prepayInvoiceId.slice(0, 8)}`,
    customer_id: f.customerId, scheduled_service_id: f.rootId, title: 'Rodent Bait Stations — Annual Prepay',
    status: 'sent', total: 585.4, subtotal: 585.4,
    line_items: JSON.stringify([
      { description: 'Rodent Bait Stations - Annual Prepay', quantity: 1, unit_price: 486.4, amount: 486.4 },
      { description: SETUP_LINE, quantity: 1, unit_price: 99, amount: 99, category: 'Setup fee' },
    ]),
    due_date: today,
  });
  await mockPg('annual_prepay_terms').insert({
    id: f.termId, customer_id: f.customerId, source_estimate_id: f.estimateId, prepay_invoice_id: f.prepayInvoiceId,
    plan_label: 'Rodent Bait Stations Annual Prepay', monthly_rate: 40.53, prepay_amount: 486.4,
    term_start: today, term_end: addMonths(today, 12), status: 'payment_pending',
    coverage_service_type: 'Rodent Bait Stations', coverage_visit_count: 4, coverage_cadence: 'quarterly',
    prior_billing_mode: 'per_application',
  });
  await mockPg('invoices').where({ id: f.prepayInvoiceId }).update({ annual_prepay_term_id: f.termId });
  return f;
}

async function cleanup(f) {
  if (!f) return;
  const invIds = (await mockPg('invoices').where({ customer_id: f.customerId }).select('id')).map((r) => r.id);
  await mockPg('invoices').whereIn('id', invIds).update({ annual_prepay_term_id: null, annual_prepay_covered_term_id: null }).catch(() => {});
  await mockPg('setup_fee_claims').whereIn('invoice_id', invIds).del().catch(() => {});
  await mockPg('setup_fee_claims').where({ scheduled_service_id: f.rootId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('annual_prepay_terms').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('scheduled_services').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
  await mockPg('estimates').where({ id: f.estimateId }).del().catch(() => {});
}

async function liveSetupLineInvoices(customerId) {
  const rows = await mockPg('invoices')
    .where({ customer_id: customerId })
    .whereNotIn('status', ['void', 'cancelled', 'canceled', 'refunded'])
    .select('id', 'invoice_number', 'status', 'line_items', 'notes');
  return rows.filter((r) => {
    const lines = typeof r.line_items === 'string' ? JSON.parse(r.line_items) : (r.line_items || []);
    return lines.some((li) => /setup fee/i.test(String(li.description || '')));
  });
}

postgres('r2-prepay-switch-and-term-lifecycle-1: estimate-origin switch prepay — pay then refund', () => {
  let f;
  beforeAll(async () => {
    process.env.GATE_ONSITE_PREPAY_SWITCH = 'true';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    require('../services/annual-prepay-renewals').resetCachesForTests?.();
  });
  afterAll(async () => { await cleanup(f); if (mockPg) await mockPg.destroy(); });

  test('first payment must NOT ledger a setup claim for the estimate-origin switch prepay; refund must restore the $99 setup exactly once', async () => {
    f = await seed();
    const Renewals = require('../services/annual-prepay-renewals');

    // --- Step 1: customer pays P in person → payment_pending → active.
    const paidAt = new Date();
    await mockPg('invoices').where({ id: f.prepayInvoiceId }).update({ status: 'paid', paid_at: paidAt, payment_recorded_at: paidAt, payment_method: 'cash' });
    await Renewals.syncTermForInvoicePayment({ id: f.prepayInvoiceId, status: 'paid', paid_at: paidAt });

    const termAfterPay = await mockPg('annual_prepay_terms').where({ id: f.termId }).first('status');
    expect(termAfterPay.status).toBe('active');

    const prepayClaimAfterPay = await mockPg('setup_fee_claims').where({ invoice_id: f.prepayInvoiceId }).first();
    // The r38 rule: an estimate-origin switch prepay never acquires a ledger
    // record — the superseded accept invoice's re-mint IS the restore path.
    // (On current code a {invoice_id: P, scheduled_service_id: R, amount: 99}
    // row is inserted here by retireRodentSetupObligationForRevivedPrepay.)
    const step1Violation = prepayClaimAfterPay ? { claimOnPrepay: prepayClaimAfterPay } : null;

    // --- Step 2: weeks later the operator refunds P → cancel branch.
    await mockPg('invoices').where({ id: f.prepayInvoiceId }).update({ status: 'refunded', paid_at: null });
    await Renewals.syncTermForInvoicePayment({ id: f.prepayInvoiceId, status: 'refunded', paid_at: null });

    const termAfterRefund = await mockPg('annual_prepay_terms').where({ id: f.termId }).first('status');
    expect(termAfterRefund.status).toBe('cancelled');

    const restoredSetupInvoices = await liveSetupLineInvoices(f.customerId);
    const root = await mockPg('scheduled_services').where({ id: f.rootId }).first('pending_setup_fee');
    const stamp = root.pending_setup_fee != null ? Number(root.pending_setup_fee) : null;
    const setupObligations = restoredSetupInvoices.length + (stamp > 0 ? 1 : 0);

    // Expected: exactly ONE collectible $99 setup after the refund — the
    // re-minted accept invoice's line. A pending_setup_fee stamp on the root
    // beside it is a second $99 the next completion will mint.
    expect({
      step1Violation,
      liveSetupInvoices: restoredSetupInvoices.map((r) => ({ invoice_number: r.invoice_number, status: r.status })),
      rootPendingSetupFee: stamp,
      setupObligations,
    }).toEqual({
      step1Violation: null,
      liveSetupInvoices: [expect.objectContaining({ status: expect.any(String) })],
      rootPendingSetupFee: null,
      setupObligations: 1,
    });
  });

  test('codex P1: dispute-lost -> dispute-won (revival) -> staff-refund must not permanently drop the setup obligation', async () => {
    f = await seed();
    const Renewals = require('../services/annual-prepay-renewals');
    const InvoiceService = require('../services/invoice');

    // --- Cycle 1: pay P, then refund it (identical to the test above) —
    // restoreSwitchSupersededInvoicesForPrepay re-mints the superseded
    // accept invoice (INV-A') carrying the $99 setup line; no claim exists
    // yet because the switch never wrote one and this is the FIRST payment.
    const paidAt = new Date();
    await mockPg('invoices').where({ id: f.prepayInvoiceId }).update({ status: 'paid', paid_at: paidAt, payment_recorded_at: paidAt, payment_method: 'cash' });
    await Renewals.syncTermForInvoicePayment({ id: f.prepayInvoiceId, status: 'paid', paid_at: paidAt });
    await mockPg('invoices').where({ id: f.prepayInvoiceId }).update({ status: 'refunded', paid_at: null });
    await Renewals.syncTermForInvoicePayment({ id: f.prepayInvoiceId, status: 'refunded', paid_at: null });

    const beforeRevival = await liveSetupLineInvoices(f.customerId);
    expect(beforeRevival).toHaveLength(1); // INV-A' (the marker re-mint), live.
    const restoredInvoiceId = beforeRevival[0].id;

    // --- Cycle 2: the prepay is REVIVED (dispute won, or simply re-paid) —
    // exactly the two calls annual-prepay-renewals.js's revival branches run,
    // in the same order (retireRodentSetupObligationForRevivedPrepay THEN
    // _retireSwitchRestoredInvoicesForRevivedPrepay), against the same
    // connection the real sync uses (not a fresh transaction, so both see
    // each other's writes exactly as production does).
    await mockPg('invoices').where({ id: f.prepayInvoiceId }).update({ status: 'paid', paid_at: new Date(), payment_recorded_at: new Date() });
    await InvoiceService.retireRodentSetupObligationForRevivedPrepay(mockPg, f.prepayInvoiceId);
    await InvoiceService._retireSwitchRestoredInvoicesForRevivedPrepay(mockPg, f.prepayInvoiceId);

    // The revival must have voided the now-duplicate restored invoice AND
    // ledgered a claim on P — otherwise the setup obligation is now nowhere
    // (this is exactly the P1: on current code neither happens together).
    const restoredInvoiceAfterRevival = await mockPg('invoices').where({ id: restoredInvoiceId }).first('status');
    expect(restoredInvoiceAfterRevival.status).toBe('void');
    const claimOnPrepayAfterRevival = await mockPg('setup_fee_claims').where({ invoice_id: f.prepayInvoiceId }).first();
    expect(claimOnPrepayAfterRevival).toMatchObject({ scheduled_service_id: f.rootId, amount: '99.00' });

    // --- Cycle 3: staff refunds the revived prepay AGAIN. The marker path
    // is now permanently spent (restoreSwitchSupersededInvoicesForPrepay's
    // own `existing` guard refuses to re-mint a second restore for the same
    // superseded invoice), so the claims path — now that cycle 2 ledgered a
    // record — must be the one that brings the setup back.
    await mockPg('invoices').where({ id: f.prepayInvoiceId }).update({ status: 'refunded', paid_at: null });
    await InvoiceService.restoreSwitchSupersededInvoicesForPrepay(f.prepayInvoiceId, mockPg);
    await InvoiceService.restoreRetiredSetupFeeClaimForPrepay(f.prepayInvoiceId, mockPg, {
      sourceEstimateId: f.estimateId, customerId: f.customerId, coverageServiceType: 'Rodent Bait Stations',
    });

    const liveInvoicesAfterSecondRefund = await liveSetupLineInvoices(f.customerId);
    const rootAfterSecondRefund = await mockPg('scheduled_services').where({ id: f.rootId }).first('pending_setup_fee');
    const stampAfterSecondRefund = rootAfterSecondRefund.pending_setup_fee != null ? Number(rootAfterSecondRefund.pending_setup_fee) : null;
    const obligationsAfterSecondRefund = liveInvoicesAfterSecondRefund.length + (stampAfterSecondRefund > 0 ? 1 : 0);

    // Exactly ONE collectible setup after the second refund — restored this
    // time via the claims-ledger stamp on the root, since the marker re-mint
    // can never fire again for this superseded invoice. Zero would be the
    // P1 bug (obligation silently dropped); two would be the double-bill.
    expect(obligationsAfterSecondRefund).toBe(1);
    expect(stampAfterSecondRefund).toBe(99);
  });

  test('codex P0: a SECOND superseded invoice with no setup line must not hide the setup-bearing sibling', async () => {
    // resolveSupersededInvoices can void more than one invoice for the same
    // switch (matches on the visit set OR the whole estimate-scoped AR) —
    // every voided row gets the SAME [prepay-switch-superseded-by:P] marker.
    // An unordered single-row read could pick the application-only sibling
    // and never see the one that actually carries the $99 setup line.
    f = await seed();
    const { etDateString } = require('../utils/datetime-et');
    const applicationOnlySiblingId = randomUUID();
    await mockPg('invoices').insert({
      id: applicationOnlySiblingId, token: randomUUID(), invoice_number: `AUD-${applicationOnlySiblingId.slice(0, 8)}`,
      customer_id: f.customerId, scheduled_service_id: f.rootId, title: 'Rodent Bait Stations — Second Visit',
      status: 'void', total: 128, subtotal: 128,
      notes: `Auto-generated from accepted estimate #${f.estimateId}.\n[prepay-switch-superseded-by:${f.prepayInvoiceId}]`,
      line_items: JSON.stringify([
        { description: 'First service application', quantity: 1, unit_price: 128, amount: 128 },
      ]),
      due_date: etDateString(),
    });

    const InvoiceService = require('../services/invoice');
    const paidAt = new Date();
    await mockPg('invoices').where({ id: f.prepayInvoiceId }).update({ status: 'paid', paid_at: paidAt, payment_recorded_at: paidAt, payment_method: 'cash' });
    // Call the exact function under test directly (same signature the
    // revival/first-payment sync uses) so this asserts the fix itself,
    // independent of which of the two siblings Postgres happens to return
    // first with no ORDER BY.
    const out = await InvoiceService.retireRodentSetupObligationForRevivedPrepay(mockPg, f.prepayInvoiceId);
    expect(out).toBeNull();
    const claimOnPrepay = await mockPg('setup_fee_claims').where({ invoice_id: f.prepayInvoiceId }).first();
    expect(claimOnPrepay).toBeUndefined();

    await mockPg('invoices').where({ id: applicationOnlySiblingId }).del().catch(() => {});
  });
});
