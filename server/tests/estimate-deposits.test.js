let mockDbHandler = () => { throw new Error('db handler not configured'); };
const mockRetrievePaymentIntent = jest.fn();
const mockCreateEstimateDepositIntent = jest.fn();

jest.mock('../models/db', () => {
  const mock = jest.fn((...args) => mockDbHandler(...args));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
const mockRefundPaymentIntent = jest.fn();
const mockIsEstimateAcceptActive = jest.fn(() => true);

jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: (...args) => mockRetrievePaymentIntent(...args),
  createEstimateDepositIntent: (...args) => mockCreateEstimateDepositIntent(...args),
  refundPaymentIntent: (...args) => mockRefundPaymentIntent(...args),
}));
jest.mock('../routes/estimate-public', () => ({
  isEstimateAcceptActive: (...args) => mockIsEstimateAcceptActive(...args),
  buildPricingBundle: jest.fn(async () => ({})),
  resolveEstimateQuoteRequirement: jest.fn(() => ({ quoteRequired: false })),
  isStructuralOneTimeOnlyEstimate: jest.fn(() => false),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn(async () => ({ isExistingCustomer: false })),
}));
const mockTriggerNotification = jest.fn();
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...args) => mockTriggerNotification(...args),
}));

const {
  computeDepositAmount,
  createDepositIntentForEstimate,
  ensureDepositSatisfied,
  handleDepositIntentSucceeded,
  pendingDepositCredit,
  resolveDepositPolicy,
  _private: { depositIntentMatchesEstimate },
} = require('../services/estimate-deposits');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ESTIMATE_DEPOSIT_REQUIRED = 'true';
});
afterEach(() => {
  delete process.env.ESTIMATE_DEPOSIT_REQUIRED;
});

describe('computeDepositAmount — flat per service class, never a percentage', () => {
  it('recurring = $49, one-time = $99, regardless of job size', () => {
    expect(computeDepositAmount()).toBe(49);
    expect(computeDepositAmount({ oneTime: false })).toBe(49);
    expect(computeDepositAmount({ oneTime: true })).toBe(99);
  });

  it('reads constants.DEPOSIT (pricing_config-authoritative) and falls back to defaults on junk', () => {
    const { DEPOSIT } = require('../services/pricing-engine/constants');
    const original = { ...DEPOSIT };
    try {
      DEPOSIT.recurringAmount = 59;
      DEPOSIT.oneTimeAmount = 89;
      expect(computeDepositAmount({ oneTime: false })).toBe(59);
      expect(computeDepositAmount({ oneTime: true })).toBe(89);
      DEPOSIT.recurringAmount = 'junk';
      DEPOSIT.oneTimeAmount = -5;
      expect(computeDepositAmount({ oneTime: false })).toBe(49);
      expect(computeDepositAmount({ oneTime: true })).toBe(99);
    } finally {
      Object.assign(DEPOSIT, original);
    }
  });
});

describe('resolveDepositPolicy', () => {
  const estimate = { id: 'est-1', onetime_total: 280 };

  it('requires the deposit for new customers on any non-prepay acceptance', () => {
    const policy = resolveDepositPolicy({ estimate, paymentMethodPreference: 'pay_at_visit', membership: {} });
    expect(policy).toEqual({ enforced: true, required: true, slotRequired: false, exemptReason: null, amount: 49 });
    // No preference chosen yet (data fetch) — still the required path.
    expect(resolveDepositPolicy({ estimate, paymentMethodPreference: null, membership: {} }).required).toBe(true);
  });

  it('one-time accepts are REQUIRED at the heavier flat amount — not exempt', () => {
    const policy = resolveDepositPolicy({
      estimate,
      paymentMethodPreference: 'pay_at_visit',
      membership: {},
      oneTime: true,
    });
    expect(policy.required).toBe(true);
    expect(policy.amount).toBe(99);
  });

  it('prepay-annual is exempt (paying in full)', () => {
    const policy = resolveDepositPolicy({ estimate, paymentMethodPreference: 'prepay_annual', membership: {} });
    expect(policy.required).toBe(false);
    expect(policy.exemptReason).toBe('prepay_annual');
    expect(policy.slotRequired).toBe(false);
  });

  it('existing plan customers skip the deposit but must book an appointment', () => {
    const policy = resolveDepositPolicy({
      estimate,
      paymentMethodPreference: 'pay_at_visit',
      membership: { isExistingCustomer: true },
    });
    expect(policy.required).toBe(false);
    expect(policy.slotRequired).toBe(true);
    expect(policy.exemptReason).toBe('existing_plan_customer');
  });

  it('feature dark = nothing enforced', () => {
    delete process.env.ESTIMATE_DEPOSIT_REQUIRED;
    const policy = resolveDepositPolicy({ estimate, paymentMethodPreference: 'pay_at_visit', membership: {} });
    expect(policy.enforced).toBe(false);
    expect(policy.required).toBe(false);
    expect(policy.slotRequired).toBe(false);
  });
});

describe('depositIntentMatchesEstimate — the trust boundary', () => {
  const good = {
    status: 'succeeded',
    amount_received: 7000,
    metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1' },
  };

  it('accepts only a succeeded estimate_deposit PI pinned to THIS estimate', () => {
    expect(depositIntentMatchesEstimate(good, 'est-1')).toBe(true);
    expect(depositIntentMatchesEstimate({ ...good, status: 'processing' }, 'est-1')).toBe(false);
    expect(depositIntentMatchesEstimate({ ...good, metadata: { ...good.metadata, estimate_id: 'est-2' } }, 'est-1')).toBe(false);
    expect(depositIntentMatchesEstimate({ ...good, metadata: { purpose: 'invoice', estimate_id: 'est-1' } }, 'est-1')).toBe(false);
    expect(depositIntentMatchesEstimate({ ...good, amount_received: 0 }, 'est-1')).toBe(false);
    expect(depositIntentMatchesEstimate(null, 'est-1')).toBe(false);
  });
});

describe('ensureDepositSatisfied', () => {
  function depositsTable({ receivedTotal = 0, ledgerRow, upserts = [], statusUpdates = [] } = {}) {
    return {
      where(criteria) {
        if (criteria && criteria.stripe_payment_intent_id && criteria.status === 'pending') {
          return { update: async (payload) => { statusUpdates.push({ criteria, payload }); } };
        }
        if (criteria && criteria.stripe_payment_intent_id) {
          return { first: async () => ledgerRow };
        }
        return this;
      },
      whereIn() { return this; },
      sum() { return this; },
      first: async () => ({ total: receivedTotal }),
      insert(payload) {
        return { onConflict: () => ({ ignore: async () => { upserts.push(payload); } }) };
      },
    };
  }

  it('a webhook-recorded deposit satisfies without touching Stripe', async () => {
    mockDbHandler = () => depositsTable({ receivedTotal: 70 });
    const result = await ensureDepositSatisfied({ estimate: { id: 'est-1' } });
    expect(result).toEqual({ satisfied: true, receivedTotal: 70 });
    expect(mockRetrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('closes the webhook race via live PI verification and records it', async () => {
    const upserts = [];
    mockDbHandler = () => depositsTable({
      receivedTotal: 0,
      upserts,
      ledgerRow: { status: 'received', amount: '70.00' },
    });
    mockRetrievePaymentIntent.mockResolvedValue({
      id: 'pi_1', status: 'succeeded', amount_received: 7000,
      metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1' },
    });

    const result = await ensureDepositSatisfied({ estimate: { id: 'est-1' }, depositPaymentIntentId: 'pi_1' });
    expect(result.satisfied).toBe(true);
    expect(result.receivedTotal).toBe(70);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].stripe_payment_intent_id).toBe('pi_1');
  });

  it('a REFUNDED ledger row never satisfies, even though Stripe still says succeeded', async () => {
    mockDbHandler = () => depositsTable({
      receivedTotal: 0,
      ledgerRow: { status: 'refunded', amount: '70.00' },
    });
    mockRetrievePaymentIntent.mockResolvedValue({
      id: 'pi_refunded', status: 'succeeded', amount_received: 7000,
      metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1' },
    });

    const result = await ensureDepositSatisfied({ estimate: { id: 'est-1' }, depositPaymentIntentId: 'pi_refunded' });
    expect(result.satisfied).toBe(false);
  });

  it('a client-named PI for a DIFFERENT estimate never satisfies', async () => {
    mockDbHandler = () => depositsTable({ receivedTotal: 0 });
    mockRetrievePaymentIntent.mockResolvedValue({
      id: 'pi_2', status: 'succeeded', amount_received: 7000,
      metadata: { purpose: 'estimate_deposit', estimate_id: 'est-OTHER' },
    });
    const result = await ensureDepositSatisfied({ estimate: { id: 'est-1' }, depositPaymentIntentId: 'pi_2' });
    expect(result.satisfied).toBe(false);
  });

  it('Stripe retrieval failure fails closed', async () => {
    mockDbHandler = () => depositsTable({ receivedTotal: 0 });
    mockRetrievePaymentIntent.mockRejectedValue(new Error('stripe down'));
    const result = await ensureDepositSatisfied({ estimate: { id: 'est-1' }, depositPaymentIntentId: 'pi_3' });
    expect(result.satisfied).toBe(false);
  });
});

describe('createDepositIntentForEstimate', () => {
  it('creates the PI at the computed amount and tracks it pending', async () => {
    const upserts = [];
    mockDbHandler = () => ({
      insert(payload) { return { onConflict: () => ({ merge: async () => { upserts.push(payload); } }) }; },
    });
    mockCreateEstimateDepositIntent.mockResolvedValue({ id: 'pi_9', client_secret: 'cs_9' });

    const result = await createDepositIntentForEstimate({ id: 'est-1', onetime_total: 280, customer_email: 'x@y.com' });
    // Email is deliberately NOT passed — every PI create param must be
    // deterministic from (estimate, amount) or Stripe rejects idempotent
    // retries as key reuse with different parameters.
    expect(mockCreateEstimateDepositIntent).toHaveBeenCalledWith({
      estimateId: 'est-1', amountDollars: 49,
    });
    expect(result).toEqual({ clientSecret: 'cs_9', amount: 49, paymentIntentId: 'pi_9' });
    expect(upserts[0].status).toBe('pending');
  });

  it('one-time service class mints the heavier flat amount', async () => {
    mockDbHandler = () => ({
      insert() { return { onConflict: () => ({ merge: async () => {} }) }; },
    });
    mockCreateEstimateDepositIntent.mockResolvedValue({ id: 'pi_10', client_secret: 'cs_10' });
    const result = await createDepositIntentForEstimate({ id: 'est-1' }, { oneTime: true });
    expect(mockCreateEstimateDepositIntent).toHaveBeenCalledWith({
      estimateId: 'est-1', amountDollars: 99,
    });
    expect(result.amount).toBe(99);
  });

  it('returns null when Stripe is unconfigured', async () => {
    mockCreateEstimateDepositIntent.mockResolvedValue(null);
    expect(await createDepositIntentForEstimate({ id: 'est-1' })).toBeNull();
  });
});

describe('webhook + invoice credit', () => {
  // Stateful deposits-table fake: the claim-first refund discipline reads
  // and writes the SAME row across several queries, so the mock must carry
  // state. Conditional updates (status / whereIn) only land when the live
  // row matches — mirroring knex affected-row semantics.
  function statefulWebhookDb({ estimateRow, initialDepositRow = null, onEstimateRead = null }) {
    const state = {
      row: initialDepositRow ? { credited_amount: 0, refunded_amount: 0, ...initialDepositRow } : null,
      inserts: [],
      updates: [],
    };
    const handler = (table) => {
      if (table === 'estimates') {
        return { where: () => ({ first: async () => { if (onEstimateRead) onEstimateRead(state); return estimateRow; } }) };
      }
      if (table !== 'estimate_deposits') throw new Error(`unexpected table: ${table}`);
      const q = { criteria: {}, inStatuses: null };
      const chain = {
        where(c) { Object.assign(q.criteria, c); return chain; },
        whereIn(_col, vals) { q.inStatuses = vals; return chain; },
        first: async () => (state.row ? { ...state.row } : null),
        update: async (payload) => {
          if (!state.row) return 0;
          if (q.criteria.status && state.row.status !== q.criteria.status) return 0;
          if (q.inStatuses && !q.inStatuses.includes(state.row.status)) return 0;
          Object.assign(state.row, payload);
          state.updates.push({ criteria: { ...q.criteria }, inStatuses: q.inStatuses, payload });
          return 1;
        },
        insert(payload) {
          return {
            onConflict: () => ({
              ignore: async () => {
                if (!state.row) { state.row = { credited_amount: 0, refunded_amount: 0, ...payload }; state.inserts.push(payload); }
              },
              merge: async () => {
                if (!state.row) { state.row = { credited_amount: 0, refunded_amount: 0, ...payload }; state.inserts.push(payload); }
                else { Object.assign(state.row, payload); }
              },
            }),
          };
        },
      };
      return chain;
    };
    return { handler, state };
  }

  const succeededPi = {
    id: 'pi_1', amount_received: 7000,
    metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1' },
  };

  it('records an eligible deposit (monotonic: only pending rows advance)', async () => {
    mockIsEstimateAcceptActive.mockReturnValue(true);
    const { handler, state } = statefulWebhookDb({ estimateRow: { id: 'est-1', status: 'sent', onetime_total: 280 } });
    mockDbHandler = handler;

    const result = await handleDepositIntentSucceeded(succeededPi);
    expect(result.handled).toBe(true);
    expect(result.refunded).toBeUndefined();
    expect(state.row).toMatchObject({ estimate_id: 'est-1', amount: 70, status: 'received' });
    expect(mockRefundPaymentIntent).not.toHaveBeenCalled();
  });

  it('REFUNDS a stale deposit when the estimate is no longer acceptable — claim first, Stripe second, stamp third', async () => {
    mockIsEstimateAcceptActive.mockReturnValue(false);
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_1' });
    const { handler, state } = statefulWebhookDb({ estimateRow: { id: 'est-1', status: 'expired' } });
    mockDbHandler = handler;

    const result = await handleDepositIntentSucceeded(succeededPi);
    expect(result.refunded).toBe(true);
    expect(mockRefundPaymentIntent).toHaveBeenCalledWith('pi_1');
    // Row was claimed as 'refunding' BEFORE Stripe, terminal-stamped after.
    expect(state.inserts[0]).toMatchObject({ status: 'refunding' });
    expect(state.row).toMatchObject({ status: 'refunded', refunded_amount: 70 });
  });

  it('REFUNDS a surplus deposit when acceptance completed without it', async () => {
    mockIsEstimateAcceptActive.mockReturnValue(true);
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_2' });
    const { handler, state } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'accepted' },
      initialDepositRow: { id: 'd1', status: 'pending', amount: 70 },
    });
    mockDbHandler = handler;

    const result = await handleDepositIntentSucceeded(succeededPi);
    expect(result.refunded).toBe(true);
    expect(state.row.status).toBe('refunded');
  });

  it('NEVER refunds money an accept consumed mid-flight — the claim loses and the deposit stays received (P1 race)', async () => {
    mockIsEstimateAcceptActive.mockReturnValue(true);
    const { handler, state } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'accepted' },
      initialDepositRow: { id: 'd1', status: 'pending', amount: 70 },
      // Simulate the accept's live verification winning the race: the row
      // advances pending→received between the staleness decision and the
      // refund claim.
      onEstimateRead: (s) => { s.row.status = 'received'; },
    });
    mockDbHandler = handler;

    const result = await handleDepositIntentSucceeded(succeededPi);
    expect(result.handled).toBe(true);
    expect(result.replay).toBe(true);
    expect(mockRefundPaymentIntent).not.toHaveBeenCalled();
    expect(state.row.status).toBe('received');
  });

  it('replays of consumed or refunded deposits are no-ops', async () => {
    const { handler } = statefulWebhookDb({
      estimateRow: { id: 'est-1', status: 'sent' },
      initialDepositRow: { id: 'd1', status: 'credited' },
    });
    mockDbHandler = handler;
    const result = await handleDepositIntentSucceeded(succeededPi);
    expect(result.replay).toBe(true);
    expect(mockRefundPaymentIntent).not.toHaveBeenCalled();
  });

  it('a FAILED refund reverts the claim and THROWS so Stripe retries — money is never stranded', async () => {
    mockIsEstimateAcceptActive.mockReturnValue(false);
    mockRefundPaymentIntent.mockRejectedValue(new Error('stripe down'));
    const { handler, state } = statefulWebhookDb({ estimateRow: { id: 'est-1', status: 'expired' } });
    mockDbHandler = handler;

    await expect(handleDepositIntentSucceeded(succeededPi)).rejects.toThrow(/refund failed/);
    // The claim was reverted to pending — the webhook retry can re-claim.
    expect(state.row.status).toBe('pending');
  });

  it('pendingDepositCredit returns only the UNAPPLIED balance', async () => {
    mockDbHandler = () => ({
      where() { return this; },
      select: async () => [
        { id: 'd1', amount: '70.00', credited_amount: '0.00' },
        { id: 'd2', amount: '50.00', credited_amount: '30.00' },
      ],
    });
    const credit = await pendingDepositCredit('est-1');
    expect(credit.amount).toBe(90);
    expect(credit.lineItem.unit_price).toBe(-90);
  });

  it('no received rows (or fully consumed rows) = no credit', async () => {
    mockDbHandler = () => ({ where() { return this; }, select: async () => [] });
    expect(await pendingDepositCredit('est-1')).toBeNull();
    mockDbHandler = () => ({
      where() { return this; },
      select: async () => [{ id: 'd1', amount: '70.00', credited_amount: '70.00' }],
    });
    expect(await pendingDepositCredit('est-1')).toBeNull();
  });
});

describe('deposit reversal webhooks (refunds + disputes)', () => {
  const { handleDepositChargeReversed, handleDepositDisputeClosed } = require('../services/estimate-deposits');
  const logger = require('../services/logger');

  // updateResult mimics knex's affected-row count for the CONDITIONAL flip;
  // 0 = the row transitioned under us and the handler must re-read.
  function reversalDb({ row, updates = [], updateResult = 1 }) {
    return (table) => {
      if (table !== 'estimate_deposits') throw new Error(`unexpected table: ${table}`);
      return {
        where(criteria) {
          if (criteria && criteria.id) {
            return {
              update: async (payload) => {
                updates.push({ id: criteria.id, criteria, payload });
                return updateResult;
              },
            };
          }
          return { first: async () => row };
        },
      };
    };
  }

  it('unknown PI = not a deposit — webhook falls through to the payments path', async () => {
    mockDbHandler = reversalDb({ row: null });
    expect(await handleDepositChargeReversed('pi_x', 'charge.refunded')).toEqual({ handled: false });
    expect((await handleDepositChargeReversed(null, 'charge.refunded')).handled).toBe(false);
  });

  it('a received deposit flips to refunded (can never satisfy acceptance again)', async () => {
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', credited_amount: '0.00' },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded');
    expect(result.handled).toBe(true);
    expect(updates[0].payload.status).toBe('refunded');
  });

  it('an already-credited deposit flips AND flags for manual reconciliation', async () => {
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'credited', estimate_id: 'est-1', credited_amount: '70.00', credited_invoice_id: 'inv-1' },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'dispute.created');
    expect(result.handled).toBe(true);
    expect(updates[0].payload.status).toBe('refunded');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('manual reconciliation'),
      expect.objectContaining({ invoiceId: 'inv-1' }),
    );
  });

  it('replays of already-refunded deposits are no-ops', async () => {
    const updates = [];
    mockDbHandler = reversalDb({ row: { id: 'd1', status: 'refunded' }, updates });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded');
    expect(result.replay).toBe(true);
    expect(updates).toHaveLength(0);
  });

  it('the flip is CONDITIONAL on the state the alert decision used', async () => {
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', credited_amount: '0.00' },
      updates,
    });
    await handleDepositChargeReversed('pi_1', 'charge.refunded');
    expect(updates[0].criteria).toMatchObject({ id: 'd1', status: 'received', credited_amount: '0.00' });
  });

  it('unwinnable transition contention THROWS so Stripe retries the reversal', async () => {
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', credited_amount: '0.00' },
      updateResult: 0,
    });
    await expect(handleDepositChargeReversed('pi_1', 'charge.refunded'))
      .rejects.toThrow(/contention/);
  });

  it('dispute closed: lost is silent (row already refunded); won flags for manual restore', async () => {
    mockDbHandler = reversalDb({ row: { id: 'd1', status: 'refunded', estimate_id: 'est-1' } });
    expect((await handleDepositDisputeClosed('pi_1', 'lost')).handled).toBe(true);
    expect(logger.error).not.toHaveBeenCalled();
    expect((await handleDepositDisputeClosed('pi_1', 'won')).handled).toBe(true);
    expect(logger.error).toHaveBeenCalled();
    // Non-deposit PIs fall through to the payments path.
    mockDbHandler = reversalDb({ row: null });
    expect((await handleDepositDisputeClosed('pi_9', 'won')).handled).toBe(false);
  });

  it('the echo of OUR OWN remainder refund never flips a credited row or false-alarms', async () => {
    const updates = [];
    // Partially-credited row whose $29 remainder WE refunded and stamped.
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'credited', estimate_id: 'est-1', credited_amount: '70.00', refunded_amount: '29.00' },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded', { amountRefundedCents: 2900 });
    expect(result.replay).toBe(true);
    expect(updates).toHaveLength(0);
    expect(logger.error).not.toHaveBeenCalled();
    // A LARGER dashboard reversal on the same row is NOT an echo — it flips
    // and flags for manual reconciliation as before.
    const updates2 = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'credited', estimate_id: 'est-1', credited_amount: '70.00', refunded_amount: '29.00', credited_invoice_id: 'inv-1' },
      updates: updates2,
    });
    const bigger = await handleDepositChargeReversed('pi_1', 'charge.refunded', { amountRefundedCents: 9900 });
    expect(bigger.handled).toBe(true);
    expect(updates2[0].payload.status).toBe('refunded');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('refundUnconsumedDeposits — exempt-path sweep', () => {
  const { refundUnconsumedDeposits } = require('../services/estimate-deposits');

  // Stateful rows fake: claim (received→refunding), then terminal stamp.
  function sweepDb({ rows }) {
    const state = { rows: rows.map((r) => ({ credited_amount: 0, refunded_amount: 0, ...r })), updates: [] };
    const handler = (table) => {
      if (table !== 'estimate_deposits') throw new Error(`unexpected table: ${table}`);
      const q = { criteria: {} };
      const chain = {
        where(c) { Object.assign(q.criteria, c); return chain; },
        select: async () => (state.selectRows
          ? state.selectRows.map((r) => ({ ...r }))
          : state.rows.filter((r) => r.status === q.criteria.status).map((r) => ({ ...r }))),
        update: async (payload) => {
          const target = state.rows.find((r) => r.id === q.criteria.id);
          if (!target) return 0;
          if (q.criteria.status && target.status !== q.criteria.status) return 0;
          if (q.criteria.credited_amount !== undefined && String(target.credited_amount) !== String(q.criteria.credited_amount)) return 0;
          Object.assign(target, payload);
          state.updates.push({ criteria: { ...q.criteria }, payload });
          return 1;
        },
      };
      return chain;
    };
    return { handler, state };
  }

  it('refunds untouched deposits in full and partially-credited remainders partially', async () => {
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_1' });
    const { handler, state } = sweepDb({
      rows: [
        { id: 'd1', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00' },
        { id: 'd2', stripe_payment_intent_id: 'pi_b', status: 'received', amount: '99.00', credited_amount: '70.00' },
      ],
    });
    mockDbHandler = handler;

    const result = await refundUnconsumedDeposits({ estimateId: 'est-1', reason: 'exempt_accept:prepay_annual' });
    expect(result.refunded).toBe(78); // 49 + 29
    expect(mockRefundPaymentIntent).toHaveBeenCalledWith('pi_a', { amountCents: 4900 });
    expect(mockRefundPaymentIntent).toHaveBeenCalledWith('pi_b', { amountCents: 2900 });
    const d1 = state.rows.find((r) => r.id === 'd1');
    const d2 = state.rows.find((r) => r.id === 'd2');
    // Untouched money ends refunded; a partially-credited row keeps its
    // credit — only the remainder came back.
    expect(d1).toMatchObject({ status: 'refunded', refunded_amount: 49 });
    expect(d2).toMatchObject({ status: 'credited', refunded_amount: 29 });
  });

  it('a Stripe failure reverts the claim, raises the reconcile alert, and keeps sweeping', async () => {
    mockRefundPaymentIntent.mockRejectedValue(new Error('stripe down'));
    const { handler, state } = sweepDb({
      rows: [{ id: 'd1', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00' }],
    });
    mockDbHandler = handler;

    const result = await refundUnconsumedDeposits({ estimateId: 'est-1', reason: 'exempt_accept:prepay_annual' });
    expect(result.refunded).toBe(0);
    expect(state.rows[0].status).toBe('received');
    expect(mockTriggerNotification).toHaveBeenCalledWith('estimate_deposit_reconcile_needed', { estimateId: 'est-1' });
  });

  it('rows consumed mid-sweep are skipped — their claim simply loses', async () => {
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_1' });
    const { handler, state } = sweepDb({
      rows: [{ id: 'd1', stripe_payment_intent_id: 'pi_a', status: 'credited', amount: '49.00', credited_amount: '49.00' }],
    });
    // The select snapshot saw the row as received, but the live row was
    // consumed before the claim (an invoice consume won the race).
    state.selectRows = [{ id: 'd1', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00' }];
    mockDbHandler = handler;

    const result = await refundUnconsumedDeposits({ estimateId: 'est-1', reason: 'exempt_accept:prepay_annual' });
    expect(result.refunded).toBe(0);
    expect(mockRefundPaymentIntent).not.toHaveBeenCalled();
  });
});

describe('consumeDepositCredit — partial application tracking', () => {
  const { consumeDepositCredit } = require('../services/estimate-deposits');

  // updateResults maps row id → affected count, mimicking the CONDITIONAL
  // update; 0 = the row was flipped under us by a reversal webhook.
  function consumeDb({ rows, updates = [], updateResults = {} }) {
    return () => ({
      where(criteria) {
        if (criteria && criteria.id) {
          return {
            update: async (payload) => {
              updates.push({ id: criteria.id, criteria, payload });
              return updateResults[criteria.id] ?? 1;
            },
          };
        }
        return this;
      },
      orderBy() { return this; },
      select: async () => rows,
    });
  }

  it('allocates oldest-first; partial rows stay received with only the remainder available', async () => {
    const updates = [];
    mockDbHandler = consumeDb({
      rows: [
        { id: 'd1', amount: '50.00', credited_amount: '0.00' },
        { id: 'd2', amount: '70.00', credited_amount: '0.00' },
      ],
      updates,
    });

    // Apply $80: d1 fully consumed ($50, flips credited), d2 partially ($30, stays received).
    const allocated = await consumeDepositCredit({ estimateId: 'est-1', amount: 80, invoiceId: 'inv-1' });
    expect(allocated).toBe(80);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ id: 'd1', payload: { credited_amount: 50, status: 'credited', credited_invoice_id: 'inv-1' } });
    // Conditional on the exact state the allocation was computed from.
    expect(updates[0].criteria).toMatchObject({ id: 'd1', status: 'received', credited_amount: '0.00' });
    expect(updates[1].id).toBe('d2');
    expect(updates[1].payload.credited_amount).toBe(30);
    expect(updates[1].payload.status).toBeUndefined();
  });

  it('a row flipped to refunded mid-consume is NOT counted — allocated reflects only won rows', async () => {
    const updates = [];
    mockDbHandler = consumeDb({
      rows: [
        { id: 'd1', amount: '50.00', credited_amount: '0.00' },
        { id: 'd2', amount: '70.00', credited_amount: '0.00' },
      ],
      updates,
      // d2's conditional update loses (a reversal webhook flipped it).
      updateResults: { d2: 0 },
    });

    const allocated = await consumeDepositCredit({ estimateId: 'est-1', amount: 80, invoiceId: 'inv-1' });
    // Only d1's $50 was actually consumed — callers see the mismatch vs the
    // $80 they applied and roll the invoice back.
    expect(allocated).toBe(50);
  });

  it('zero/negative amounts are no-ops', async () => {
    mockDbHandler = () => { throw new Error('should not query'); };
    expect(await consumeDepositCredit({ estimateId: 'est-1', amount: 0, invoiceId: 'inv-1' })).toBe(0);
  });
});
