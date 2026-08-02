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
  lockedReads: [],
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
    q.forUpdate = () => { mockState.lockedReads.push(table); return q; };
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
  mockState.lockedReads = [];
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

  test('a pause applied SECONDS after the settlement (the race) still clears', async () => {
    // The clear runs after the webhook's durable writes, so the cron's pause
    // can legitimately postdate settledAt by seconds. The ladder is
    // day-spaced, so an hour of slack cannot admit a stale redelivery.
    mockState.customer = { ...PAUSED, service_paused_at: '2026-05-02T12:00:30Z' };

    const res = await maybeResumeBillingPauseOnPayment('cust-1', {
      paymentIntentId: 'pi_race',
      settledAt: new Date('2026-05-02T12:00:00Z'),
    });

    expect(res).toMatchObject({ resumed: true });
  });

  test('refuses to clear without a settlement time — fail toward the pause staying', async () => {
    mockState.customer = { ...PAUSED };

    expect(await maybeResumeBillingPauseOnPayment('cust-1')).toMatchObject({ resumed: false, reason: 'no_settlement_time' });
    expect(await maybeResumeBillingPauseOnPayment('cust-1', { settledAt: new Date('nope') })).toMatchObject({ resumed: false, reason: 'no_settlement_time' });
    expect(mockState.updates).toHaveLength(0);
  });

  test('the pause read takes a ROW LOCK inside the transaction', async () => {
    // An unlocked read races billing-cron's in-flight pause UPDATE: it sees
    // the pre-pause row, answers not_paused, and the cron commits its pause
    // after this webhook finishes — stranding a customer who just paid.
    // FOR UPDATE makes the read wait for any concurrent pause write.
    mockState.customer = { ...PAUSED };

    await maybeResumeBillingPauseOnPayment('cust-1', { paymentIntentId: 'pi_1', settledAt: new Date('2026-07-01T12:00:00Z') });

    expect(mockState.lockedReads).toContain('customers');
  });

  test('the auto-clearable reason is pinned to the ladder-exhaustion value billing-cron writes', () => {
    expect(AUTO_CLEARABLE_REASON).toBe('autopay_final_failure');
  });
});

describe('billing-cron pause write — concurrent-settlement guard', () => {
  const fs = require('fs');
  const path = require('path');
  const cronSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'billing-cron.js'), 'utf8');

  test('the final-failure pause is vetoed by a payment that settled during the attempt', () => {
    // The other half of the race: the success webhook can run BEFORE the
    // pause exists (nothing to clear), then the pause lands and strands a
    // customer who just paid. The write site must check for a settlement
    // since the attempt began, and the veto must ALSO suppress the
    // "membership paused" email — telling a customer who just paid that
    // they are paused would be false.
    const pauseIdx = cronSrc.indexOf("service_pause_reason: 'autopay_final_failure'");
    expect(pauseIdx).toBeGreaterThan(-1);
    const before = cronSrc.slice(Math.max(0, pauseIdx - 1600), pauseIdx);
    // ONE atomic statement: the veto lives in the UPDATE's own predicate
    // (whereNotExists), so no settled-and-committed payment can slip
    // between a separate check and the write.
    expect(before).toContain('whereNotExists');
    expect(before).toContain('attemptStartedAt');
    // 'paid' ONLY — a 'processing' ACH row is accepted, not settled, and can
    // still bounce; and settlement can be an in-place status flip, so BOTH
    // timestamps count.
    expect(before).toMatch(/'payments\.status', 'paid'/);
    expect(before).not.toMatch(/whereIn\('status'/);
    expect(before).toContain("orWhere('payments.updated_at'");
    // The paused-email fires only when the UPDATE actually matched.
    const after = cronSrc.slice(pauseIdx, pauseIdx + 900);
    expect(after).toContain('if (!pausedRows)');
    expect(after).toContain('sendMembershipPaused');
  });

  test('every downstream message tells the truth about whether the pause applied', () => {
    // After a veto, the office SMS / health alert / autopay log claiming
    // "service paused" would send an operator chasing state that does not
    // exist. All of them key off pauseApplied now.
    const pauseIdx = cronSrc.indexOf("service_pause_reason: 'autopay_final_failure'");
    const block = cronSrc.slice(pauseIdx, pauseIdx + 4000);
    expect(block).toContain("pauseApplied ? 'Service paused until card is updated.'");
    expect(block).toContain("pauseApplied ? 'Service auto-paused.'");
    expect(block).toContain('service_paused: pauseApplied');
    expect(block).not.toContain('service_paused: true');
    expect(block).toContain("pauseApplied ? ', service paused'");
  });
});

describe('stripe-webhook wiring', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'stripe-webhook.js'), 'utf8');

  test('the auto-clear runs at the DISPATCH level, AFTER the handler\'s durable writes', () => {
    // Clearing before the paid row exists loses the race where billing-cron
    // pauses in between and this event never fires again — so the call sits
    // after handlePaymentIntentSucceeded completes, not inside it.
    const caseIdx = src.indexOf("case 'payment_intent.succeeded':");
    expect(caseIdx).toBeGreaterThan(-1);
    const caseBlock = src.slice(caseIdx, src.indexOf('break;', caseIdx));
    const handlerCall = caseBlock.indexOf('handlePaymentIntentSucceeded');
    const clearCall = caseBlock.indexOf('maybeAutoClearBillingPauseForIntent');
    expect(handlerCall).toBeGreaterThan(-1);
    expect(clearCall).toBeGreaterThan(handlerCall);
    // And NOT inside the handler any more.
    const fnStart = src.indexOf('async function handlePaymentIntentSucceeded');
    const fnEnd = src.indexOf('async function handlePaymentIntentFailed');
    expect(src.slice(fnStart, fnEnd)).not.toContain('maybeResumeBillingPauseOnPayment');
  });

  test('an infrastructure failure PROPAGATES so Stripe redelivers — business no-ops stay silent', () => {
    // The webhook's idempotency lane records the error and 500s, Stripe
    // retries, the reclaim path re-runs the clear. Swallowing the error
    // would strand the pause behind a processed event forever.
    const helperStart = src.indexOf('async function maybeAutoClearBillingPauseForIntent');
    const helperEnd = src.indexOf('async function', helperStart + 10);
    const helper = src.slice(helperStart, helperEnd);
    expect(helper).toMatch(/if \(result\?\.reason === 'error'\) \{\s*\n\s*throw new Error/);
    // And no catch-all swallowing it before the dispatcher sees it.
    expect(helper).not.toContain('catch');
  });

  test('the dispatch helper skips non-arrears money and resolves invoice-first', () => {
    const helperStart = src.indexOf('async function maybeAutoClearBillingPauseForIntent');
    expect(helperStart).toBeGreaterThan(-1);
    const helper = src.slice(helperStart, helperStart + 2200);
    // Statement = payer money; deposit and no-show fee are not balance payments.
    expect(helper).toContain('waves_statement_id');
    expect(helper).toContain('estimate_deposit');
    expect(helper).toContain('card_hold_no_show_fee');
    // Invoice authority, payer-billed yields NOTHING (no metadata fallthrough),
    // metadata only when no invoice matched at all.
    expect(helper).toMatch(/invoice\.payer_id \? null : invoice\.customer_id/);
    expect(helper).toMatch(/: \(paymentIntent\?\.metadata\?\.waves_customer_id \|\| null\)/);
    // The settlement moment rides along for the ordering guard.
    expect(helper).toContain('settledAt');
    expect(helper).toContain('eventCreated');
  });

  test('the ACH processing->paid flip stamps updated_at for the cron race guard', () => {
    // knex never auto-touches updated_at; without this stamp the cron's veto
    // guard is blind to an in-place ACH settlement.
    const idx = src.indexOf('const paymentUpdates = {');
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 700);
    expect(block).toContain("status: 'paid'");
    expect(block).toContain('updated_at: new Date()');
  });
});
