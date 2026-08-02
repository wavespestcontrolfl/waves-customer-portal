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

    expect(res).toMatchObject({ resumed: false, reason: 'settled_before_pause_cycle' });
    expect(mockState.updates).toHaveLength(0);
  });

  test('a settlement within clock-skew of the pause anchor still clears (the true race)', async () => {
    // The pause timestamp IS the attempt anchor; one second of slop is
    // integer-second flooring plus NTP drift, nothing more.
    mockState.customer = { ...PAUSED, service_paused_at: '2026-05-02T12:00:01Z' };

    const res = await maybeResumeBillingPauseOnPayment('cust-1', {
      paymentIntentId: 'pi_race',
      settledAt: new Date('2026-05-02T12:00:00Z'),
    });

    expect(res).toMatchObject({ resumed: true });
  });

  test('a payment FIVE MINUTES before the failure cycle does not clear its pause', async () => {
    // 09:56 payment, 10:00 exhaustion: the failure superseded it. Skew
    // tolerance must never widen into a race window.
    mockState.customer = { ...PAUSED, service_paused_at: '2026-05-02T10:00:00Z' };

    const res = await maybeResumeBillingPauseOnPayment('cust-1', {
      paymentIntentId: 'pi_pre_cycle',
      settledAt: new Date('2026-05-02T09:56:00Z'),
    });

    expect(res).toMatchObject({ resumed: false, reason: 'settled_before_pause_cycle' });
  });

  test('a payment HALF AN HOUR before the failure cycle does not clear its pause', async () => {
    // The reviewer's case: pay at 09:30, final retry fails at 10:00 — the
    // exhaustion supersedes that payment, however late its webhook arrives.
    mockState.customer = { ...PAUSED, service_paused_at: '2026-05-02T10:00:00Z' };

    const res = await maybeResumeBillingPauseOnPayment('cust-1', {
      paymentIntentId: 'pi_before_cycle',
      settledAt: new Date('2026-05-02T09:30:00Z'),
    });

    expect(res).toMatchObject({ resumed: false, reason: 'settled_before_pause_cycle' });
    expect(mockState.updates).toHaveLength(0);
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
    const before = cronSrc.slice(Math.max(0, pauseIdx - 3600), pauseIdx);
    // ONE atomic statement: the veto lives in the UPDATE's own predicate
    // (whereNotExists), so no settled-and-committed payment can slip
    // between a separate check and the write.
    expect(before).toContain('whereNotExists');
    expect(before).toContain('attemptStartedAt');
    // 'paid' ONLY — a 'processing' ACH row is accepted, not settled, and can
    // still bounce.
    expect(before).toMatch(/'payments\.status', 'paid'/);
    expect(before).not.toMatch(/whereIn\('status'/);
    // WHEN it settled must be Stripe's clock for webhook-recorded rows: a
    // delayed redelivery of a days-old success touches its row NOW, so
    // local write times lie. Stamped rows compare metadata.settled_event_at;
    // only unstamped (synchronous local) recordings fall back to created_at.
    expect(before).toContain("settled_event_at')::timestamptz >= ?");
    // event.created is integer seconds — the anchor floors to the second so
    // a same-second settlement cannot compare as earlier and slip the veto.
    expect(before).toContain('Math.floor(attemptStartedAt.getTime() / 1000) * 1000');
    // The pause timestamp IS the attempt anchor — that is what makes the
    // clear's ordering guard exact causality instead of a heuristic window.
    expect(before).toContain('const pausedAt = attemptStartedAt;');
    expect(before).toMatch(/\[attemptAnchor\]/);
    expect(before).toMatch(/settled_event_at'\) IS NULL/);
    expect(before).not.toContain("orWhere('payments.updated_at'");
    // The veto mirrors the auto-clear's eligibility: a no-show fee and
    // payer/statement money never clear a pause, so they must not veto one.
    expect(before).toContain("IS DISTINCT FROM 'card_hold_no_show_fee'");
    expect(before).toContain("whereNull('payments.statement_id')");
    expect(before).toMatch(/payer_id'\) IS NULL/);
    // The paused-email fires only when the UPDATE actually matched.
    const after = cronSrc.slice(pauseIdx, pauseIdx + 900);
    expect(after).toContain('if (!pausedRows)');
    expect(after).toContain('sendMembershipPaused');
  });

  test('every downstream message distinguishes applied / settlement-veto / error', () => {
    // "A payment settled" and "the write blew up" demand OPPOSITE operator
    // reactions — conflating them hides an infrastructure failure behind a
    // reassuring message. Three distinct states, defaulting to 'error' so a
    // throw cannot masquerade as a veto.
    const pauseIdx = cronSrc.indexOf("service_pause_reason: 'autopay_final_failure'");
    const block = cronSrc.slice(Math.max(0, pauseIdx - 4200), pauseIdx + 4200);
    expect(block).toContain("let pauseOutcome = 'error';");
    expect(block).toContain("pauseOutcome = 'settlement_veto';");
    expect(block).toContain("pauseOutcome = 'applied';");
    expect(block).toContain("PAUSE WRITE FAILED");
    expect(block).toContain("service_paused: pauseOutcome === 'applied'");
    expect(block).not.toContain('service_paused: true');
    expect(block).toContain('pause_outcome: pauseOutcome');
  });
});

describe('off-Stripe payment paths honor the same contract', () => {
  const fs = require('fs');
  const path = require('path');

  test('record-payment and reconcile both dispatch the clear — never for payer-funded invoices', () => {
    for (const [file, marker] of [
      ['admin-invoices.js', "source: 'admin_record_payment'"],
      ['admin-payments-reconcile.js', "source: 'admin_payment_reconcile'"],
    ]) {
      const rs = fs.readFileSync(path.join(__dirname, '..', 'routes', file), 'utf8');
      const idx = rs.indexOf('maybeResumeBillingPauseOnPayment');
      expect(idx).toBeGreaterThan(-1);
      const around = rs.slice(Math.max(0, idx - 1400), idx + 700);
      expect(around).toContain(marker);
      // The payer's tender proves nothing about the homeowner's card.
      expect(around).toMatch(/if \(!(updatedInvoice|invoice)\.payer_id\)/);
      expect(around).toContain('settledAt');
    }
  });

  test('the Customer 360 cash paths (annual prepay, credit prepayment) dispatch the clear too', () => {
    // Every path money enters the ledger honors the one contract — the
    // banner's promise must be true from the same screen it renders on.
    const rs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-customers.js'), 'utf8');
    expect(rs).toContain("source: 'customer360_annual_prepay',");
    expect(rs).toContain("source: 'account_credit_prepayment',");
    // Adjustments move no cash and must not clear anything.
    const idx = rs.indexOf("source: 'account_credit_prepayment',");
    const before = rs.slice(Math.max(0, idx - 900), idx);
    expect(before).toContain("if (kind === 'prepayment')");
  });

  test('reconcile passes the Stripe charge\'s own settlement time when it has one', () => {
    const rs = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-payments-reconcile.js'), 'utf8');
    expect(rs).toContain('settledAt: chargeDetails?.created ? new Date(chargeDetails.created * 1000) : new Date()');
  });

  test('both webhook ledger paths stamp payer ownership', () => {
    const ws = fs.readFileSync(path.join(__dirname, '..', 'routes', 'stripe-webhook.js'), 'utf8');
    expect(ws).toContain('...(lockedInvoice.payer_id ? { payer_id: lockedInvoice.payer_id } : {})');
    expect(ws).toContain('...(invoice?.payer_id ? { payer_id: invoice.payer_id } : {})');
    // And the flip BACKFILLS payer_id for processing rows that predate the
    // stamp, so pre-deploy in-flight ACH cannot veto as homeowner money.
    expect(ws).toContain("'{payer_id}', to_jsonb(?::text)");
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

  test('no qualifying LEDGER row, no clear — Stripe success alone is not settled customer money', () => {
    // Quarantined mismatches and orphaned duplicates never write a customer
    // payments row; a disputed payment's row is no longer status='paid'.
    // The gate reads the same exclusions as billing-cron's pause veto, so
    // the two sides of the race share one source of truth.
    const helperStart = src.indexOf('async function maybeAutoClearBillingPauseForIntent');
    const helperEnd = src.indexOf('async function', helperStart + 10);
    const helper = src.slice(helperStart, helperEnd);
    expect(helper).toMatch(/stripe_payment_intent_id: paymentIntent\.id, status: 'paid'/);
    // Merge-safe ownership: the ledger row's customer_id outranks frozen PI
    // metadata for invoice-less money.
    expect(helper).toContain("ledgerRow.customer_id || paymentIntent?.metadata?.waves_customer_id");
    expect(helper).toContain("whereNull('statement_id')");
    expect(helper).toContain("IS DISTINCT FROM 'card_hold_no_show_fee'");
    expect(helper).toMatch(/payer_id'\) IS NULL/);
    expect(helper).toContain('if (!ledgerRow) return;');
  });

  test('the dispatch helper skips non-arrears money and resolves invoice-first', () => {
    const helperStart = src.indexOf('async function maybeAutoClearBillingPauseForIntent');
    expect(helperStart).toBeGreaterThan(-1);
    const helper = src.slice(helperStart, src.indexOf('async function', helperStart + 10));
    // Statement = payer money; deposit and no-show fee are not balance payments.
    expect(helper).toContain('waves_statement_id');
    expect(helper).toContain('estimate_deposit');
    expect(helper).toContain('card_hold_no_show_fee');
    // Invoice authority, payer-billed yields NOTHING (no metadata fallthrough),
    // metadata only when no invoice matched at all.
    expect(helper).toMatch(/invoice\.payer_id \? null : invoice\.customer_id/);
    expect(helper).toContain('ledgerRow.customer_id || paymentIntent?.metadata?.waves_customer_id');
    // The settlement moment rides along for the ordering guard.
    expect(helper).toContain('settledAt');
    expect(helper).toContain('eventCreated');
  });

  test('both webhook paid-writes stamp Stripe\'s settlement moment into metadata', () => {
    // The cron's veto compares metadata.settled_event_at — Stripe's clock —
    // because the row's own write times lie under delayed redelivery.
    const flipIdx = src.indexOf('const paymentUpdates = {');
    expect(flipIdx).toBeGreaterThan(-1);
    const flip = src.slice(flipIdx, flipIdx + 2600);
    expect(flip).toContain("status: 'paid'");
    expect(flip).toContain('updated_at: new Date()');
    expect(flip).toContain("'{settled_event_at}'");
    // Parameterized, never interpolated.
    expect(flip).toContain('to_jsonb(?::text)');

    const insertIdx = src.indexOf("payment_state: 'paid',");
    const insert = src.slice(insertIdx, insertIdx + 600);
    expect(insert).toContain('settled_event_at: eventCreated');
  });
});
