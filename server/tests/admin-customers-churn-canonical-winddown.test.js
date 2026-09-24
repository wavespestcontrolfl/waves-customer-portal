/**
 * ADMIN-BUG-R10 structural fix (Codex round 3 on PR #4684, findings 1/3/4) —
 * customer-lifecycle-guard.js's churn/archive wind-down now delegates
 * entirely to cancellation-processor.js's own canonical operation
 * (disarmCustomerBillingFields + disarmPaymentRails, extracted from its
 * churnWrite/disarmPaymentRails closures) plus admin-cancellation.js's
 * findPendingPrepayInvoice, instead of a hand-rolled subset. Three things
 * that subset missed:
 *
 *  1. payment_methods.autopay_enabled and payments.next_retry_at
 *     (StripeService.charge() picks the default card by the payment-
 *     method's OWN autopay_enabled flag, independent of the customer row)
 *     stayed armed.
 *  2. The guard/wind-down ran only on an actual stage TRANSITION (oldStage
 *     !== 'churned'), so a pre-fix residue row (already churned, still
 *     billing-live) never self-healed on a later re-save of the same stage.
 *  3. A payment_pending annual-prepay term with an unpaid, still-payable
 *     invoice was invisible to the guard — paying that invoice later
 *     re-activates the term with no live guard left to catch it.
 *
 * Real Postgres (clone of waves_audit_tpl via DATABASE_URL).
 */
const { randomUUID } = require('crypto');
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-customers');

jest.setTimeout(30000);

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/customers', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

const isoDaysAhead = (n) => new Date(Date.now() + n * 24 * 3600 * 1000).toISOString().slice(0, 10);

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('churn wind-down delegates to the canonical cancellation-processor operation (real PG)', () => {
  afterAll(async () => { await db.destroy(); });

  test('a repeated Churned save on a pre-fix residue row disarms payment_methods and payments too', async () => {
    const customerId = randomUUID();
    await db('customers').insert({
      id: customerId, first_name: 'ResidueRepro', last_name: 'Customer',
      phone: '9415550301', email: `residue-repro-${customerId}@example.com`,
      // Already 'churned' — the pre-fix residue shape: label present, billing live.
      pipeline_stage: 'churned', churned_at: '2026-08-01', churn_reason: 'moved',
      active: true, autopay_enabled: true, monthly_rate: 89,
      billing_mode: 'monthly_membership', next_charge_date: isoDaysAhead(10),
    });
    const paymentMethodId = randomUUID();
    await db('payment_methods').insert({
      id: paymentMethodId, customer_id: customerId, autopay_enabled: true, is_default: true,
    });
    const paymentId = randomUUID();
    await db('payments').insert({
      id: paymentId, customer_id: customerId, payment_date: isoDaysAhead(-5), amount: 89,
      status: 'failed', next_retry_at: new Date(Date.now() + 3 * 24 * 3600 * 1000),
    });
    // Deliberately no scheduled_services / annual_prepay_terms rows — the
    // repair must trigger from the persisted billing state, not a visit/term.

    const status = await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/${customerId}/stage`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: 'churned' }),
      });
      return res.status;
    });
    // The guard/disarm (this fix) runs and commits BEFORE the route's own
    // customer_interactions note insert, whose admin_user_id is this test
    // harness's non-UUID 'admin-1' technicianId — a pre-existing harness
    // artifact unrelated to this fix (same caveat the original ADMIN-BUG-R10
    // repro documented): that insert 500s AFTER the repair already
    // committed, so accept either a clean 200 or that harness 500 and assert
    // on the actual persisted state either way.
    expect([200, 500]).toContain(status);

    const customer = await db('customers').where({ id: customerId })
      .first('active', 'autopay_enabled', 'next_charge_date', 'pipeline_stage');
    const paymentMethod = await db('payment_methods').where({ id: paymentMethodId }).first('autopay_enabled');
    const payment = await db('payments').where({ id: paymentId }).first('next_retry_at');

    expect(customer.pipeline_stage).toBe('churned');
    expect(customer.active).toBe(false);
    expect(customer.autopay_enabled).toBe(false);
    expect(customer.next_charge_date).toBeNull();
    expect(paymentMethod.autopay_enabled).toBe(false);
    expect(payment.next_retry_at).toBeNull();
  });

  test('an unpaid payment_pending prepay invoice refuses churn (would re-activate coverage if paid)', async () => {
    const customerId = randomUUID();
    await db('customers').insert({
      id: customerId, first_name: 'PendingInvoiceRepro', last_name: 'Customer',
      phone: '9415550302', email: `pending-invoice-repro-${customerId}@example.com`,
      pipeline_stage: 'active_customer', active: true, monthly_rate: 0,
    });
    const invoiceId = randomUUID();
    await db('invoices').insert({
      id: invoiceId, token: `tok-${invoiceId}`, invoice_number: `INV-${invoiceId.slice(0, 8)}`,
      customer_id: customerId, status: 'sent',
    });
    await db('annual_prepay_terms').insert({
      id: randomUUID(), customer_id: customerId, status: 'payment_pending',
      prepay_invoice_id: invoiceId, term_start: isoDaysAhead(1), term_end: isoDaysAhead(366),
    });
    // No scheduled_services row — the pending-invoice guard alone must refuse.

    const status = await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/customers/${customerId}/stage`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: 'churned' }),
      });
      return res.status;
    });
    expect(status).toBe(409);
    const customer = await db('customers').where({ id: customerId }).first('pipeline_stage');
    expect(customer.pipeline_stage).toBe('active_customer');
  });
});
