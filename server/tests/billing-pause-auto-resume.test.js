/**
 * Automatic billing-pause clear on payment (owner ruling 2026-08-01:
 * "billing goes back to normal once they pay").
 *
 * Contract, mirroring the manual resume-service endpoint:
 *   - only 'autopay_final_failure' pauses auto-clear — a pause an operator
 *     set by hand stays until a human clears it
 *   - compare-and-swap on the exact pause read, so a newer pause applied
 *     between read and write is never wiped
 *   - clear + timeline note + critical audit event share one transaction
 *   - NEVER throws — a bookkeeping failure must not bubble into the webhook
 */
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockState = {
  customer: null,
  storedPausedAt: undefined,
  updates: [],
  interactions: [],
  auditEvents: [],
  auditShouldFail: false,
  customerReadShouldFail: false,
  rolledBack: false,
};

jest.mock('../services/audit-log', () => ({
  recordAuditEvent: jest.fn(async (event) => {
    if (mockState.auditShouldFail) throw new Error('audit exploded');
    mockState.auditEvents.push(event);
  }),
}));

jest.mock('../models/db', () => {
  const builder = (table) => {
    const q = { _table: table, _where: {}, _null: [] };
    q.where = (criteria) => { Object.assign(q._where, criteria); return q; };
    q.whereNull = (col) => { q._null.push(col); return q; };
    q.first = async () => {
      if (mockState.customerReadShouldFail) throw new Error('db read exploded');
      if (table !== 'customers' || !mockState.customer) return null;
      if (q._null.includes('deleted_at') && mockState.customer.deleted_at) return null;
      return mockState.customer;
    };
    q.update = async (patch) => {
      mockState.updates.push({ table, where: { ...q._where }, nullChecks: [...q._null], patch });
      if (table === 'customers') {
        const stored = mockState.storedPausedAt === undefined
          ? mockState.customer?.service_paused_at
          : mockState.storedPausedAt;
        if ('service_paused_at' in q._where && q._where.service_paused_at !== stored) return 0;
      }
      return 1;
    };
    q.insert = async (row) => { mockState.interactions.push(row); return [1]; };
    return q;
  };
  const db = jest.fn(builder);
  db.transaction = async (fn) => {
    try {
      return await fn(jest.fn(builder));
    } catch (err) {
      mockState.rolledBack = true;
      mockState.updates = mockState.updates.filter((u) => u.table !== 'customers');
      mockState.interactions = [];
      mockState.auditEvents = [];
      throw err;
    }
  };
  return db;
});

const { maybeResumeBillingPauseOnPayment, AUTO_CLEARABLE_REASON } = require('../services/billing-pause');

beforeEach(() => {
  mockState.customer = null;
  mockState.storedPausedAt = undefined;
  mockState.updates = [];
  mockState.interactions = [];
  mockState.auditEvents = [];
  mockState.auditShouldFail = false;
  mockState.customerReadShouldFail = false;
  mockState.rolledBack = false;
});

const PAUSED = {
  id: 'cust-1',
  service_paused_at: '2026-05-02T12:00:00Z',
  service_pause_reason: 'autopay_final_failure',
};

describe('maybeResumeBillingPauseOnPayment', () => {
  test('clears an autopay_final_failure pause when a payment settles', async () => {
    mockState.customer = { ...PAUSED };

    const res = await maybeResumeBillingPauseOnPayment('cust-1', { paymentIntentId: 'pi_1', settledAt: new Date('2026-07-01T12:00:00Z') });

    expect(res).toMatchObject({ resumed: true });
    const update = mockState.updates.find((u) => u.table === 'customers');
    expect(update.patch).toEqual({ service_paused_at: null, service_pause_reason: null });
    // CAS on THIS pause, not merely "some pause".
    expect(update.where).toMatchObject({ id: 'cust-1', service_paused_at: PAUSED.service_paused_at });
  });

  test('a MANUAL pause never auto-clears — a payment does not overrule a human', async () => {
    mockState.customer = { ...PAUSED, service_pause_reason: 'owner_hold_pending_dispute' };

    const res = await maybeResumeBillingPauseOnPayment('cust-1', { paymentIntentId: 'pi_1', settledAt: new Date('2026-07-01T12:00:00Z') });

    expect(res).toMatchObject({ resumed: false, reason: 'manual_pause' });
    expect(mockState.updates).toHaveLength(0);
    expect(mockState.interactions).toHaveLength(0);
  });

  test('a pause reapplied between read and write is NOT wiped', async () => {
    mockState.customer = { ...PAUSED };
    mockState.storedPausedAt = '2026-06-01T09:00:00Z';

    const res = await maybeResumeBillingPauseOnPayment('cust-1', { settledAt: new Date('2026-07-01T12:00:00Z') });

    expect(res).toMatchObject({ resumed: false, reason: 'pause_changed' });
    expect(mockState.interactions).toHaveLength(0);
    expect(mockState.auditEvents).toHaveLength(0);
  });

  test('writes the system audit event inside the transaction, carrying the PI', async () => {
    mockState.customer = { ...PAUSED };

    await maybeResumeBillingPauseOnPayment('cust-1', { paymentIntentId: 'pi_42', source: 'stripe_webhook', settledAt: new Date('2026-07-01T12:00:00Z') });

    expect(mockState.auditEvents).toHaveLength(1);
    expect(mockState.auditEvents[0]).toMatchObject({
      actor_type: 'system',
      // UUID column — a string actor here fails the INSERT in prod and the
      // never-throw catch would hide it forever.
      actor_id: null,
      action: 'customer.billing_pause_cleared',
      resource_type: 'customer',
      resource_id: 'cust-1',
      critical: true,
    });
    expect(mockState.auditEvents[0].metadata).toMatchObject({
      trigger: 'payment_succeeded',
      source: 'stripe_webhook',
      payment_intent_id: 'pi_42',
    });
    expect(mockState.auditEvents[0].trx).toBeTruthy();
    // Timeline note claims only what the action guarantees — the #3148 rule.
    expect(mockState.interactions[0].subject).toBe('Billing pause cleared');
    expect(mockState.interactions[0].body).toContain('automatically');
    expect(mockState.interactions[0].body).toContain('other billing guards');
    expect(mockState.interactions[0].body).toContain('not back-billed');
  });

  test('NEVER throws — a failed audit rolls back the clear and returns an error result', async () => {
    mockState.customer = { ...PAUSED };
    mockState.auditShouldFail = true;

    await expect(maybeResumeBillingPauseOnPayment('cust-1', { settledAt: new Date('2026-07-01T12:00:00Z') })).resolves.toMatchObject({ resumed: false, reason: 'error' });

    // The pause stays — the manual button covers it.
    expect(mockState.rolledBack).toBe(true);
    expect(mockState.updates.filter((u) => u.table === 'customers')).toHaveLength(0);
  });

  test('NEVER throws — even the initial read failing resolves to an error result', async () => {
    mockState.customerReadShouldFail = true;
    await expect(maybeResumeBillingPauseOnPayment('cust-1', { settledAt: new Date('2026-07-01T12:00:00Z') })).resolves.toMatchObject({ resumed: false, reason: 'error' });
  });

  test('not-paused and missing-customer are quiet no-ops', async () => {
    mockState.customer = { id: 'cust-1', service_paused_at: null };
    expect(await maybeResumeBillingPauseOnPayment('cust-1', { settledAt: new Date('2026-07-01T12:00:00Z') })).toMatchObject({ resumed: false, reason: 'not_paused' });

    mockState.customer = null;
    expect(await maybeResumeBillingPauseOnPayment('cust-1', { settledAt: new Date('2026-07-01T12:00:00Z') })).toMatchObject({ resumed: false, reason: 'not_paused' });

    expect(await maybeResumeBillingPauseOnPayment(null)).toMatchObject({ resumed: false, reason: 'no_customer' });
  });

  test('a DELAYED webhook for a success older than the pause does NOT clear it', async () => {
    // The pause was applied 2026-05-02; this success settled back in April —
    // its failures-to-come are exactly what created the pause. Redelivery of
    // the old event must not clear it.
    mockState.customer = { ...PAUSED };

    const res = await maybeResumeBillingPauseOnPayment('cust-1', {
      paymentIntentId: 'pi_old',
      settledAt: new Date('2026-04-20T12:00:00Z'),
    });

    expect(res).toMatchObject({ resumed: false, reason: 'pause_newer_than_payment' });
    expect(mockState.updates).toHaveLength(0);
  });

  test('refuses to clear without a settlement time — fail toward the pause staying', async () => {
    mockState.customer = { ...PAUSED };

    expect(await maybeResumeBillingPauseOnPayment('cust-1')).toMatchObject({ resumed: false, reason: 'no_settlement_time' });
    expect(await maybeResumeBillingPauseOnPayment('cust-1', { settledAt: new Date('nope') })).toMatchObject({ resumed: false, reason: 'no_settlement_time' });
    expect(mockState.updates).toHaveLength(0);
  });

  test('the auto-clearable reason is pinned to the ladder-exhaustion value billing-cron writes', () => {
    expect(AUTO_CLEARABLE_REASON).toBe('autopay_final_failure');
  });
});

describe('stripe-webhook wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'stripe-webhook.js'), 'utf8');

  test('handlePaymentIntentSucceeded calls the auto-clear after the non-arrears early returns', () => {
    const fnStart = src.indexOf('async function handlePaymentIntentSucceeded');
    expect(fnStart).toBeGreaterThan(-1);
    const callIdx = src.indexOf('maybeResumeBillingPauseOnPayment', fnStart);
    expect(callIdx).toBeGreaterThan(fnStart);
    // After the statement / deposit / no-show routes (which are not the
    // customer's arrears money) but before the ledger-routing branches.
    const between = src.slice(fnStart, callIdx);
    expect(between).toContain('waves_statement_id');
    expect(between).toContain('estimate_deposit');
    expect(between).toContain('card_hold_no_show_fee');
    expect(between).toContain('findInvoiceForPaymentIntent');
    const callBlock = src.slice(callIdx - 1200, callIdx + 500);
    // Invoice owner FIRST — customer merges repoint invoices while stale PI
    // metadata stays tied to the merged-away row.
    const invoiceIdx = callBlock.indexOf('invoiceForTenderGuard.customer_id');
    const metadataIdx = callBlock.indexOf('waves_customer_id');
    expect(invoiceIdx).toBeGreaterThan(-1);
    expect(metadataIdx).toBeGreaterThan(invoiceIdx);
    // The settlement moment rides along for the ordering guard.
    expect(callBlock).toContain('settledAt');
    expect(callBlock).toContain('eventCreated');
  });

  test('a payer-billed invoice never resumes the homeowner — and never falls through to metadata', () => {
    // The builder/AP payer supplied the tender, not the homeowner whose dead
    // card caused the pause. When an invoice matched, it answers the
    // question — stale PI metadata must not sneak the homeowner back in.
    const fnStart = src.indexOf('async function handlePaymentIntentSucceeded');
    const callIdx = src.indexOf('maybeResumeBillingPauseOnPayment', fnStart);
    const callBlock = src.slice(callIdx - 1200, callIdx);
    expect(callBlock).toMatch(/invoiceForTenderGuard\.payer_id \? null : invoiceForTenderGuard\.customer_id/);
    // Metadata only when NO invoice matched at all.
    expect(callBlock).toMatch(/: \(paymentIntent\.metadata\?\.waves_customer_id \|\| null\)/);
  });
});
