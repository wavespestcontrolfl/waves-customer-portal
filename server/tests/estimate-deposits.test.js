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
const mockLoadExistingRecurringQualifyingRows = jest.fn(async () => []);
jest.mock('../services/waveguard-existing-services', () => ({
  loadExistingRecurringQualifyingRows: (...args) => mockLoadExistingRecurringQualifyingRows(...args),
}));
const mockResolveForInvoice = jest.fn(async () => ({ payerId: null }));
jest.mock('../services/payer', () => ({
  resolveForInvoice: (...args) => mockResolveForInvoice(...args),
}));

const {
  assessDepositFollowUpEligibility,
  computeDepositAmount,
  createDepositIntentForEstimate,
  ensureDepositSatisfied,
  handleDepositIntentSucceeded,
  pendingDepositCredit,
  resolveDepositPolicy,
  resolveDepositPolicyForEstimate,
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

  it('one-time UNINVOICED accepts must book — no invoice at accept means the roll-forward needs source_estimate_id (P1)', () => {
    const policy = resolveDepositPolicy({
      estimate,
      paymentMethodPreference: 'pay_at_visit',
      membership: {},
      oneTime: true,
      oneTimeUninvoiced: true,
    });
    expect(policy.required).toBe(true);
    expect(policy.slotRequired).toBe(true);
    // Invoice-mode one-time accepts credit their first invoice inside the
    // accept transaction — no booking needed for the money to come back.
    expect(resolveDepositPolicy({
      estimate,
      paymentMethodPreference: 'pay_at_visit',
      membership: {},
      oneTime: true,
    }).slotRequired).toBe(false);
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

describe('resolveDepositPolicyForEstimate — live plan-customer fallback (P2)', () => {
  const linkedEstimate = { id: 'est-1', customer_id: 'cust-9', onetime_total: 280 };

  it('exempts a legacy customer-linked estimate whose CURRENT services qualify (no membershipSnapshot)', async () => {
    mockLoadExistingRecurringQualifyingRows.mockResolvedValueOnce([{ id: 'svc-1' }]);
    const policy = await resolveDepositPolicyForEstimate({
      estimate: linkedEstimate,
      paymentMethodPreference: 'pay_at_visit',
      membership: { isExistingCustomer: false },
    });
    expect(mockLoadExistingRecurringQualifyingRows).toHaveBeenCalledWith(expect.anything(), 'cust-9');
    expect(policy.required).toBe(false);
    expect(policy.exemptReason).toBe('existing_plan_customer');
    expect(policy.slotRequired).toBe(true);
  });

  it('no qualifying services or a failed lookup = deposit stays required (fail-closed)', async () => {
    mockLoadExistingRecurringQualifyingRows.mockResolvedValueOnce([]);
    expect((await resolveDepositPolicyForEstimate({
      estimate: linkedEstimate,
      membership: {},
    })).required).toBe(true);
    mockLoadExistingRecurringQualifyingRows.mockRejectedValueOnce(new Error('db down'));
    expect((await resolveDepositPolicyForEstimate({
      estimate: linkedEstimate,
      membership: {},
    })).required).toBe(true);
  });

  it('no linked customer = no live lookup; snapshot exemption short-circuits it', async () => {
    const policy = await resolveDepositPolicyForEstimate({
      estimate: { id: 'est-1', onetime_total: 280 },
      membership: {},
    });
    expect(policy.required).toBe(true);
    await resolveDepositPolicyForEstimate({
      estimate: linkedEstimate,
      membership: { isExistingCustomer: true },
    });
    expect(mockLoadExistingRecurringQualifyingRows).not.toHaveBeenCalled();
  });
});

describe('resolveDepositPolicyForEstimate — third-party payer exemption', () => {
  const linkedEstimate = { id: 'est-1', customer_id: 'cust-9', onetime_total: 280 };

  it('exempts a would-be-required deposit when the customer resolves to a payer', async () => {
    mockResolveForInvoice.mockResolvedValueOnce({ payerId: 42 });
    const policy = await resolveDepositPolicyForEstimate({
      estimate: linkedEstimate,
      paymentMethodPreference: 'pay_at_visit',
      membership: { isExistingCustomer: false },
    });
    expect(mockResolveForInvoice).toHaveBeenCalledWith({ customerId: 'cust-9', scheduledServiceId: null });
    expect(policy.required).toBe(false);
    expect(policy.exemptReason).toBe('payer_billed');
    // Only the deposit gate is dropped — slotRequired stays as the base policy
    // computed it (false here for a non-oneTimeUninvoiced accept).
    expect(policy.slotRequired).toBe(false);
  });

  it('threads the estimate-linked scheduled service as the payer scope (per-job payer)', async () => {
    mockResolveForInvoice.mockResolvedValueOnce({ payerId: 7 });
    await resolveDepositPolicyForEstimate({
      estimate: { id: 'est-1', customer_id: 'cust-9', onetime_total: 280, estimate_data: JSON.stringify({ scheduled_service_id: 'ss-55' }) },
      membership: { isExistingCustomer: false },
    });
    expect(mockResolveForInvoice).toHaveBeenCalledWith({ customerId: 'cust-9', scheduledServiceId: 'ss-55' });
  });

  it('an explicit committed-appointment scheduledServiceId overrides the estimate link', async () => {
    mockResolveForInvoice.mockResolvedValueOnce({ payerId: 7 });
    await resolveDepositPolicyForEstimate({
      estimate: { id: 'est-1', customer_id: 'cust-9', onetime_total: 280, estimate_data: JSON.stringify({ scheduled_service_id: 'ss-55' }) },
      membership: { isExistingCustomer: false },
      scheduledServiceId: 'ss-committed',
    });
    expect(mockResolveForInvoice).toHaveBeenCalledWith({ customerId: 'cust-9', scheduledServiceId: 'ss-committed' });
  });

  it('does NOT override an already-exempt existing-plan policy (keeps its slot gate)', async () => {
    // policy.required is already false (existing plan) → payer check never runs,
    // so the existing_plan_customer booking gate (slotRequired:true) is preserved.
    const policy = await resolveDepositPolicyForEstimate({
      estimate: linkedEstimate,
      membership: { isExistingCustomer: true },
    });
    expect(policy.required).toBe(false);
    expect(policy.exemptReason).toBe('existing_plan_customer');
    expect(policy.slotRequired).toBe(true);
    expect(mockResolveForInvoice).not.toHaveBeenCalled();
  });

  it('a payer lookup miss/error leaves the deposit required (fail-safe direction)', async () => {
    mockResolveForInvoice.mockResolvedValueOnce({ payerId: null });
    expect((await resolveDepositPolicyForEstimate({
      estimate: linkedEstimate, membership: {},
    })).required).toBe(true);
    mockResolveForInvoice.mockRejectedValueOnce(new Error('db down'));
    expect((await resolveDepositPolicyForEstimate({
      estimate: linkedEstimate, membership: {},
    })).required).toBe(true);
  });

  it('no linked customer = no payer lookup', async () => {
    await resolveDepositPolicyForEstimate({
      estimate: { id: 'est-1', onetime_total: 280 },
      membership: {},
    });
    expect(mockResolveForInvoice).not.toHaveBeenCalled();
  });
});

describe('assessDepositFollowUpEligibility — payer-billed skips the nudge (P1)', () => {
  it('never sends a deposit-abandonment SMS to a payer-billed estimate', async () => {
    const estimate = { id: 'est-1', status: 'sent', customer_id: 'cust-9', estimate_data: '{}', bill_by_invoice: false };
    mockDbHandler = (table) => {
      if (table === 'estimates') return { where: () => ({ first: async () => estimate }) };
      if (table === 'scheduled_services') { const ss = {}; ['where', 'whereIn', 'whereNotNull', 'orderBy', 'select'].forEach((m) => { ss[m] = () => ss; }); ss.first = async () => null; return ss; }
      throw new Error(`unexpected table ${table}`);
    };
    mockResolveForInvoice.mockResolvedValueOnce({ payerId: 42 });
    const result = await assessDepositFollowUpEligibility('est-1');
    expect(result).toEqual({ eligible: false, reason: 'payer_billed' });
    // Strict (throwOnError) so an unverifiable payer status skips the SMS.
    expect(mockResolveForInvoice).toHaveBeenCalledWith({ customerId: 'cust-9', scheduledServiceId: null, throwOnError: true });
  });

  it('fails closed — an errored payer lookup skips the nudge (no SMS)', async () => {
    const estimate = { id: 'est-1', status: 'sent', customer_id: 'cust-9', estimate_data: '{}', bill_by_invoice: false };
    mockDbHandler = (table) => {
      if (table === 'estimates') return { where: () => ({ first: async () => estimate }) };
      if (table === 'scheduled_services') { const ss = {}; ['where', 'whereIn', 'whereNotNull', 'orderBy', 'select'].forEach((m) => { ss[m] = () => ss; }); ss.first = async () => null; return ss; }
      throw new Error(`unexpected table ${table}`);
    };
    mockResolveForInvoice.mockRejectedValueOnce(new Error('payer db down'));
    const result = await assessDepositFollowUpEligibility('est-1');
    expect(result).toEqual({ eligible: false, reason: 'eligibility_unverified' });
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
  // receivedTotals: sequence of ledger sums per call — the live-PI path
  // re-sums AFTER marking the PI received, so the second value models the
  // freshly recorded money. Last value repeats.
  function depositsTable({ receivedTotal = 0, receivedTotals = null, ledgerRow, upserts = [], statusUpdates = [] } = {}) {
    const totals = Array.isArray(receivedTotals) ? [...receivedTotals] : null;
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
      // receivedDepositTotal reads rows and nets refunded_amount out of each;
      // one synthetic row carries the modeled total.
      select: async () => {
        const total = totals ? (totals.length > 1 ? totals.shift() : totals[0]) : receivedTotal;
        return total > 0 ? [{ amount: total, refunded_amount: 0 }] : [];
      },
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
    // One shared table: the totals sequence must advance across db() calls.
    const table = depositsTable({
      receivedTotals: [0, 70],
      upserts,
      ledgerRow: { status: 'received', amount: '70.00' },
    });
    mockDbHandler = () => table;
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

  it('the recorded total must MEET the resolved policy amount — $49 never unlocks a $99 one-time accept', async () => {
    mockDbHandler = () => depositsTable({ receivedTotal: 49 });
    const result = await ensureDepositSatisfied({ estimate: { id: 'est-1' }, requiredAmount: 99 });
    expect(result).toEqual({ satisfied: false, receivedTotal: 49 });
    expect(mockRetrievePaymentIntent).not.toHaveBeenCalled();

    mockDbHandler = () => depositsTable({ receivedTotal: 99 });
    expect((await ensureDepositSatisfied({ estimate: { id: 'est-1' }, requiredAmount: 99 })).satisfied).toBe(true);
    // The heavier deposit always covers a switch BACK to the lighter class.
    mockDbHandler = () => depositsTable({ receivedTotal: 99 });
    expect((await ensureDepositSatisfied({ estimate: { id: 'est-1' }, requiredAmount: 49 })).satisfied).toBe(true);
  });

  it('a live PI top-up counts the WHOLE ledger toward the required amount', async () => {
    const table = depositsTable({
      receivedTotals: [49, 148],
      ledgerRow: { status: 'received', amount: '99.00' },
    });
    mockDbHandler = () => table;
    mockRetrievePaymentIntent.mockResolvedValue({
      id: 'pi_topup', status: 'succeeded', amount_received: 9900,
      metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1' },
    });
    const result = await ensureDepositSatisfied({
      estimate: { id: 'est-1' }, depositPaymentIntentId: 'pi_topup', requiredAmount: 99,
    });
    expect(result).toEqual({ satisfied: true, receivedTotal: 148 });
  });

  it('a live-verified PI below the required amount still fails closed', async () => {
    const table = depositsTable({
      receivedTotals: [0, 49],
      ledgerRow: { status: 'received', amount: '49.00' },
    });
    mockDbHandler = () => table;
    mockRetrievePaymentIntent.mockResolvedValue({
      id: 'pi_light', status: 'succeeded', amount_received: 4900,
      metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1' },
    });
    const result = await ensureDepositSatisfied({
      estimate: { id: 'est-1' }, depositPaymentIntentId: 'pi_light', requiredAmount: 99,
    });
    expect(result).toEqual({ satisfied: false, receivedTotal: 49 });
  });
});

describe('createDepositIntentForEstimate', () => {
  // ledgerRows feed receivedDepositTotal — the intent charges only the
  // missing slice of the policy amount. terminalCount feeds the retry
  // generation (count of refunded/refunding/failed rows).
  function intentDb({ ledgerRows = [], upserts = [], terminalCount = 0 } = {}) {
    return () => ({
      where() { return this; },
      whereIn() { return this; },
      count() { return this; },
      first: async () => ({ n: terminalCount }),
      select: async () => ledgerRows.map((r) => ({ ...r })),
      insert(payload) { return { onConflict: () => ({ merge: async () => { upserts.push(payload); } }) }; },
    });
  }

  it('creates the PI at the computed amount and tracks it pending', async () => {
    const upserts = [];
    mockDbHandler = intentDb({ upserts });
    mockCreateEstimateDepositIntent.mockResolvedValue({ id: 'pi_9', client_secret: 'cs_9' });

    const result = await createDepositIntentForEstimate({ id: 'est-1', onetime_total: 280, customer_email: 'x@y.com' });
    // Email is deliberately NOT passed — every PI create param must be
    // deterministic from (estimate, amount) or Stripe rejects idempotent
    // retries as key reuse with different parameters.
    expect(mockCreateEstimateDepositIntent).toHaveBeenCalledWith({
      estimateId: 'est-1', amountDollars: 49, retryGeneration: 0,
    });
    expect(result).toEqual({
      clientSecret: 'cs_9', amount: 49, paymentIntentId: 'pi_9', requiredAmount: 49, receivedTotal: 0,
    });
    expect(upserts[0].status).toBe('pending');
  });

  it('one-time service class mints the heavier flat amount', async () => {
    mockDbHandler = intentDb({});
    mockCreateEstimateDepositIntent.mockResolvedValue({ id: 'pi_10', client_secret: 'cs_10' });
    const result = await createDepositIntentForEstimate({ id: 'est-1' }, { oneTime: true });
    expect(mockCreateEstimateDepositIntent).toHaveBeenCalledWith({
      estimateId: 'est-1', amountDollars: 99, retryGeneration: 0,
    });
    expect(result.amount).toBe(99);
  });

  it('charges only the MISSING amount after a mode switch — $49 paid + one-time selected = $50 top-up (P2)', async () => {
    mockDbHandler = intentDb({ ledgerRows: [{ amount: '49.00', refunded_amount: '0.00' }] });
    mockCreateEstimateDepositIntent.mockResolvedValue({ id: 'pi_topup', client_secret: 'cs_t' });
    const result = await createDepositIntentForEstimate({ id: 'est-1' }, { oneTime: true });
    expect(mockCreateEstimateDepositIntent).toHaveBeenCalledWith({
      estimateId: 'est-1', amountDollars: 50, retryGeneration: 0,
    });
    expect(result).toMatchObject({ amount: 50, requiredAmount: 99, receivedTotal: 49 });
  });

  it('an already-covering ledger mints NOTHING — switch back to the lighter class owes $0', async () => {
    mockDbHandler = intentDb({ ledgerRows: [{ amount: '99.00', refunded_amount: '0.00' }] });
    const result = await createDepositIntentForEstimate({ id: 'est-1' }, { oneTime: false });
    expect(mockCreateEstimateDepositIntent).not.toHaveBeenCalled();
    expect(result).toEqual({ alreadySatisfied: true, amount: 0, requiredAmount: 49, receivedTotal: 99 });
  });

  it('partially refunded money does not count toward the missing amount', async () => {
    // $99 paid but $50 already refunded from the dashboard — only $49 is
    // really held, so a one-time policy needs a $50 top-up.
    mockDbHandler = intentDb({ ledgerRows: [{ amount: '99.00', refunded_amount: '50.00' }] });
    mockCreateEstimateDepositIntent.mockResolvedValue({ id: 'pi_t2', client_secret: 'cs_t2' });
    const result = await createDepositIntentForEstimate({ id: 'est-1' }, { oneTime: true });
    expect(mockCreateEstimateDepositIntent).toHaveBeenCalledWith({
      estimateId: 'est-1', amountDollars: 50, retryGeneration: 0,
    });
    expect(result.receivedTotal).toBe(49);
  });

  it('terminal ledger rows bump the retry generation — a refunded deposit never blocks a replacement PI (P1)', async () => {
    // The customer's first $49 deposit was refunded (stale/dispute). The
    // bare estimate+amount idempotency key would make Stripe replay the
    // old refunded PI within its window; the terminal-row count joins the
    // key so the retry mints a fresh intent.
    mockDbHandler = intentDb({ terminalCount: 1 });
    mockCreateEstimateDepositIntent.mockResolvedValue({ id: 'pi_retry', client_secret: 'cs_r' });
    const result = await createDepositIntentForEstimate({ id: 'est-1' });
    expect(mockCreateEstimateDepositIntent).toHaveBeenCalledWith({
      estimateId: 'est-1', amountDollars: 49, retryGeneration: 1,
    });
    expect(result.paymentIntentId).toBe('pi_retry');
  });

  it('returns null when Stripe is unconfigured', async () => {
    mockDbHandler = intentDb({});
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
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', amount: '49.00', credited_amount: '0.00' },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded');
    expect(result.handled).toBe(true);
    expect(updates[0].payload.status).toBe('refunded');
  });

  it('a PARTIAL dashboard refund keeps the row live — the remainder still satisfies and credits (P2)', async () => {
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', amount: '99.00', credited_amount: '0.00', refunded_amount: null },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded', { amountRefundedCents: 5000 });
    expect(result.handled).toBe(true);
    // No status flip — only the cumulative refund is recorded; $49 stays
    // available for the gate and for invoice credit.
    expect(updates[0].payload.status).toBeUndefined();
    expect(updates[0].payload.refunded_amount).toBe(50);
    expect(logger.error).not.toHaveBeenCalled();

    // A SECOND partial refund grows the cumulative record; covering the full
    // amount flips the row terminal.
    const updates2 = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'received', estimate_id: 'est-1', amount: '99.00', credited_amount: '0.00', refunded_amount: '50.00' },
      updates: updates2,
    });
    await handleDepositChargeReversed('pi_1', 'charge.refunded', { amountRefundedCents: 9900 });
    expect(updates2[0].payload).toMatchObject({ status: 'refunded', refunded_amount: 99 });
  });

  it('an already-credited deposit flips AND flags for manual reconciliation', async () => {
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'credited', estimate_id: 'est-1', amount: '70.00', credited_amount: '70.00', credited_invoice_id: 'inv-1' },
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

  it('warning_closed restores like won — the inquiry ended with the funds still ours (P2)', async () => {
    mockDbHandler = reversalDb({ row: { id: 'd1', status: 'refunded', estimate_id: 'est-1' } });
    expect((await handleDepositDisputeClosed('pi_1', 'warning_closed')).handled).toBe(true);
    expect(logger.error).toHaveBeenCalled();
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
      row: { id: 'd1', status: 'credited', estimate_id: 'est-1', amount: '99.00', credited_amount: '70.00', refunded_amount: '29.00', credited_invoice_id: 'inv-1' },
      updates: updates2,
    });
    const bigger = await handleDepositChargeReversed('pi_1', 'charge.refunded', { amountRefundedCents: 9900 });
    expect(bigger.handled).toBe(true);
    expect(updates2[0].payload.status).toBe('refunded');
    expect(logger.error).toHaveBeenCalled();
  });

  it('an echo landing MID-refund stamps the refund terminal state — a partial credit survives (P1)', async () => {
    // $99 deposit, $70 credited to an invoice, our $29 remainder refund is
    // between the Stripe call and the terminal stamp. The echo must finish
    // the job the refunder started: keep the credit, record the remainder —
    // NOT flip to plain refunded (which would erase a credit the invoice
    // still carries and suppress the reconcile trail).
    const updates = [];
    mockDbHandler = reversalDb({
      row: { id: 'd1', status: 'refunding', estimate_id: 'est-1', amount: '99.00', credited_amount: '70.00', refunded_amount: '0.00' },
      updates,
    });
    const result = await handleDepositChargeReversed('pi_1', 'charge.refunded', { amountRefundedCents: 2900 });
    expect(result.handled).toBe(true);
    expect(updates[0].criteria).toMatchObject({ id: 'd1', status: 'refunding' });
    expect(updates[0].payload).toMatchObject({ status: 'credited', refunded_amount: 29 });
    expect(logger.error).not.toHaveBeenCalled();

    // Zero-credit in-flight refund (stale deposit) — plain refunded with the
    // full amount recorded so later echoes register as replays.
    const updates2 = [];
    mockDbHandler = reversalDb({
      row: { id: 'd2', status: 'refunding', estimate_id: 'est-1', amount: '49.00', credited_amount: '0.00', refunded_amount: '0.00' },
      updates: updates2,
    });
    await handleDepositChargeReversed('pi_2', 'charge.refunded');
    expect(updates2[0].payload).toMatchObject({ status: 'refunded', refunded_amount: 49 });
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

describe('sweepTerminalEstimateDeposits — decline/expiry lifecycle refunds (P1)', () => {
  const { sweepTerminalEstimateDeposits } = require('../services/estimate-deposits');

  // First query (aliased join) finds estimates holding stranded money;
  // the per-estimate refund then runs the standard sweep queries.
  function terminalSweepDb({ strandedEstimateIds = [], rows = [] }) {
    return (table) => {
      if (table === 'estimate_deposits as ed') {
        const chain = {
          join: () => chain,
          where: () => chain,
          whereIn: () => chain,
          distinct: async () => strandedEstimateIds.map((id) => ({ estimate_id: id })),
        };
        return chain;
      }
      if (table !== 'estimate_deposits') throw new Error(`unexpected table: ${table}`);
      const q = { criteria: {} };
      const chain = {
        where(c) { Object.assign(q.criteria, c); return chain; },
        select: async () => rows
          .filter((r) => r.status === q.criteria.status && r.estimate_id === q.criteria.estimate_id)
          .map((r) => ({ ...r })),
        update: async (payload) => {
          const target = rows.find((r) => r.id === q.criteria.id);
          if (!target) return 0;
          if (q.criteria.status && target.status !== q.criteria.status) return 0;
          if (q.criteria.credited_amount !== undefined && String(target.credited_amount) !== String(q.criteria.credited_amount)) return 0;
          Object.assign(target, payload);
          return 1;
        },
      };
      return chain;
    };
  }

  it('refunds received deposits stranded on declined/expired estimates — paid-then-abandoned money comes back', async () => {
    mockRefundPaymentIntent.mockResolvedValue({ id: 're_1' });
    const rows = [
      { id: 'd1', estimate_id: 'est-9', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00', refunded_amount: 0 },
    ];
    mockDbHandler = terminalSweepDb({ strandedEstimateIds: ['est-9'], rows });

    const result = await sweepTerminalEstimateDeposits();
    expect(result).toEqual({ estimatesSwept: 1, refundedTotal: 49 });
    expect(mockRefundPaymentIntent).toHaveBeenCalledWith('pi_a', { amountCents: 4900 });
    expect(rows[0]).toMatchObject({ status: 'refunded', refunded_amount: 49 });
  });

  it('nothing stranded = no Stripe calls', async () => {
    mockDbHandler = terminalSweepDb({ strandedEstimateIds: [], rows: [] });
    const result = await sweepTerminalEstimateDeposits();
    expect(result).toEqual({ estimatesSwept: 0, refundedTotal: 0 });
    expect(mockRefundPaymentIntent).not.toHaveBeenCalled();
  });

  it('one estimate failing does not stop the sweep for the rest', async () => {
    mockRefundPaymentIntent
      .mockRejectedValueOnce(new Error('stripe down'))
      .mockResolvedValueOnce({ id: 're_2' });
    const rows = [
      { id: 'd1', estimate_id: 'est-a', stripe_payment_intent_id: 'pi_a', status: 'received', amount: '49.00', credited_amount: '0.00', refunded_amount: 0 },
      { id: 'd2', estimate_id: 'est-b', stripe_payment_intent_id: 'pi_b', status: 'received', amount: '99.00', credited_amount: '0.00', refunded_amount: 0 },
    ];
    mockDbHandler = terminalSweepDb({ strandedEstimateIds: ['est-a', 'est-b'], rows });

    const result = await sweepTerminalEstimateDeposits();
    expect(result).toEqual({ estimatesSwept: 1, refundedTotal: 99 });
    // The failed estimate's row reverted to received for the next daily run.
    expect(rows[0].status).toBe('received');
    expect(rows[1].status).toBe('refunded');
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

  it('partially refunded rows expose only the unrefunded remainder (P2)', async () => {
    const updates = [];
    // $99 deposit, $50 already returned via dashboard partial refund — only
    // $49 may ever be credited, and credit+refund together exhaust the row.
    mockDbHandler = consumeDb({
      rows: [{ id: 'd1', amount: '99.00', credited_amount: '0.00', refunded_amount: '50.00' }],
      updates,
    });
    const allocated = await consumeDepositCredit({ estimateId: 'est-1', amount: 80, invoiceId: 'inv-1' });
    expect(allocated).toBe(49);
    expect(updates[0].payload).toMatchObject({ credited_amount: 49, status: 'credited', credited_invoice_id: 'inv-1' });
    expect(updates[0].criteria).toMatchObject({ refunded_amount: '50.00' });
  });

  it('pendingDepositCredit nets partial refunds out of the available balance (P2)', async () => {
    mockDbHandler = consumeDb({
      rows: [{ id: 'd1', amount: '99.00', credited_amount: '20.00', refunded_amount: '50.00' }],
    });
    const credit = await pendingDepositCredit('est-1');
    expect(credit.amount).toBe(29);
  });
});

describe('restoreDepositCreditForVoidedInvoice — void returns consumed dollars to the ledger (P1)', () => {
  const { restoreDepositCreditForVoidedInvoice } = require('../services/estimate-deposits');
  const logger = require('../services/logger');

  function voidedInvoice(creditLines) {
    return {
      id: 'inv-void',
      status: 'void',
      line_items: JSON.stringify([
        { description: 'Service', quantity: 1, unit_price: 100 },
        ...creditLines,
      ]),
    };
  }
  const creditLine = (amount, estimateId = 'est-1') => ({
    description: 'Deposit credit (paid at acceptance)',
    quantity: 1,
    unit_price: -amount,
    amount: -amount,
    category: 'deposit_credit',
    ...(estimateId ? { estimate_id: estimateId } : {}),
  });

  // Mirrors consumeDb: conditional updates report affected counts; 0 = the
  // row was flipped under us by a reversal webhook.
  function restoreDb({ rows, updates = [], updateResults = {} }) {
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
      whereIn() { return this; },
      orderBy() { return this; },
      select: async () => rows,
    });
  }

  it('restores newest consumption first; a fully-consumed row flips back to received with no invoice stamp', async () => {
    const updates = [];
    mockDbHandler = restoreDb({
      rows: [
        { id: 'd2', status: 'credited', credited_amount: '49.00' }, // newest
        { id: 'd1', status: 'received', credited_amount: '30.00' },
      ],
      updates,
    });

    const restored = await restoreDepositCreditForVoidedInvoice({ invoice: voidedInvoice([creditLine(70)]) });

    expect(restored).toBe(70);
    expect(updates[0]).toMatchObject({
      id: 'd2',
      payload: { credited_amount: 0, status: 'received', credited_invoice_id: null },
    });
    // Conditional on the exact state the math used.
    expect(updates[0].criteria).toMatchObject({ id: 'd2', status: 'credited', credited_amount: '49.00' });
    // The remaining $21 comes off the partially-consumed row, which keeps
    // its received status (no status key in the payload).
    expect(updates[1].id).toBe('d1');
    expect(updates[1].payload.credited_amount).toBe(9);
    expect(updates[1].payload.status).toBeUndefined();
  });

  it('a row flipped terminal mid-restore is skipped — the shortfall alerts and THROWS so the void rolls back (P1)', async () => {
    const updates = [];
    mockDbHandler = restoreDb({
      rows: [{ id: 'd1', status: 'credited', credited_amount: '49.00' }],
      updates,
      updateResults: { d1: 0 },
    });

    // Never resurrects refunded money; the throw aborts the enclosing void
    // transaction so the invoice stays live until a human reconciles.
    await expect(restoreDepositCreditForVoidedInvoice({ invoice: voidedInvoice([creditLine(49)]) }))
      .rejects.toThrow(/void blocked/);
    expect(logger.error).toHaveBeenCalled();
    expect(mockTriggerNotification).toHaveBeenCalledWith('estimate_deposit_reconcile_needed', { invoiceId: 'inv-void' });
  });

  it('an unstamped legacy credit line cannot be attributed — alert + throw instead of guessing a ledger', async () => {
    mockDbHandler = () => { throw new Error('should not query without an estimate stamp'); };
    await expect(restoreDepositCreditForVoidedInvoice({ invoice: voidedInvoice([creditLine(49, null)]) }))
      .rejects.toThrow(/void blocked/);
    expect(mockTriggerNotification).toHaveBeenCalledWith('estimate_deposit_reconcile_needed', { invoiceId: 'inv-void' });
  });

  it('no deposit lines (or unparseable line_items) = silent no-op', async () => {
    mockDbHandler = () => { throw new Error('should not query'); };
    expect(await restoreDepositCreditForVoidedInvoice({ invoice: voidedInvoice([]) })).toBe(0);
    expect(await restoreDepositCreditForVoidedInvoice({ invoice: { id: 'x', line_items: '{not json' } })).toBe(0);
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });
});

describe('handleDepositIntentCanceled — canceled PIs go terminal so retries mint fresh intents (P1)', () => {
  const { handleDepositIntentCanceled } = require('../services/estimate-deposits');

  function canceledDb({ updates = [], updateResult = 1 } = {}) {
    return (table) => {
      if (table !== 'estimate_deposits') throw new Error(`unexpected table: ${table}`);
      return {
        where(criteria) {
          return {
            update: async (payload) => {
              updates.push({ criteria, payload });
              return updateResult;
            },
          };
        },
      };
    };
  }

  it('flips ONLY the pending row to failed — the terminal row advances the retry generation', async () => {
    const updates = [];
    mockDbHandler = canceledDb({ updates });
    const result = await handleDepositIntentCanceled({
      id: 'pi_dead',
      metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1' },
    });
    expect(result.handled).toBe(true);
    expect(updates[0].criteria).toMatchObject({ stripe_payment_intent_id: 'pi_dead', status: 'pending' });
    expect(updates[0].payload.status).toBe('failed');
  });

  it('non-deposit PIs and received/credited rows are untouched', async () => {
    mockDbHandler = () => { throw new Error('should not query'); };
    expect((await handleDepositIntentCanceled({ id: 'pi_x', metadata: {} })).handled).toBe(false);
    // A row already received/credited simply does not match the conditional
    // (status: pending) — the cancellation echo cannot un-receive money.
    const updates = [];
    mockDbHandler = canceledDb({ updates, updateResult: 0 });
    const result = await handleDepositIntentCanceled({
      id: 'pi_paid',
      metadata: { purpose: 'estimate_deposit', estimate_id: 'est-1' },
    });
    expect(result.handled).toBe(true);
    expect(updates[0].criteria).toMatchObject({ status: 'pending' });
  });
});

describe('assessDepositFollowUpEligibility (deposit-abandonment nudge)', () => {
  const gates = require('../routes/estimate-public');
  const { buildEstimateMembershipContext } = require('../services/estimate-membership-context');
  const { assessDepositFollowUpEligibility } = require('../services/estimate-deposits');

  // Minimal chainable for this helper's three reads: the estimate row, the
  // refund-netted received rows, and the latest pending intent.
  function followUpDb({ estimate, receivedRows = [], pendingRow = undefined }) {
    return (table) => {
      const b = {};
      for (const m of ['where', 'whereIn', 'whereNotNull', 'orderBy', 'select']) {
        b[m] = jest.fn(() => b);
      }
      b.first = jest.fn(async () => {
        if (table === 'estimates') return estimate;
        // No source_estimate_id-linked per-job payer in these fixtures, so the
        // payer exemption check falls through to the customer-default resolver.
        if (table === 'scheduled_services') return null;
        return pendingRow;
      });
      b.then = (resolve, reject) =>
        Promise.resolve(table === 'estimate_deposits' ? receivedRows : [])
          .then(resolve, reject);
      return b;
    };
  }

  const NOW = new Date('2026-06-10T15:00:00Z');
  const hoursBefore = (h) => new Date(NOW.getTime() - h * 3600000);
  const liveEstimate = { id: 'est-1', status: 'viewed', estimate_data: '{}' };
  const inWindowPending = (over = {}) =>
    ({ id: 'dep-1', status: 'pending', updated_at: hoursBefore(3), ...over });

  beforeEach(() => {
    mockIsEstimateAcceptActive.mockReturnValue(true);
    gates.buildPricingBundle.mockResolvedValue({});
    gates.resolveEstimateQuoteRequirement.mockReturnValue({ quoteRequired: false });
    gates.isStructuralOneTimeOnlyEstimate.mockReturnValue(false);
    buildEstimateMembershipContext.mockResolvedValue({ isExistingCustomer: false });
    mockLoadExistingRecurringQualifyingRows.mockResolvedValue([]);
  });

  it('eligible: quotes the policy amount minus refund-netted received money', async () => {
    mockDbHandler = followUpDb({
      estimate: liveEstimate,
      receivedRows: [{ amount: '20.00', refunded_amount: '0.00' }],
      pendingRow: inWindowPending(),
    });
    const result = await assessDepositFollowUpEligibility('est-1', NOW);
    expect(result).toEqual({ eligible: true, outstandingAmount: 29 });
  });

  it('top-up case: $49 received toward a $99 structural one-time policy stays eligible for $50', async () => {
    gates.isStructuralOneTimeOnlyEstimate.mockReturnValueOnce(true);
    mockDbHandler = followUpDb({
      estimate: liveEstimate,
      receivedRows: [{ amount: '49.00', refunded_amount: '0.00' }],
      pendingRow: inWindowPending({ id: 'dep-topup' }),
    });
    const result = await assessDepositFollowUpEligibility('est-1', NOW);
    expect(result).toEqual({ eligible: true, outstandingAmount: 50 });
  });

  it('satisfied policy goes silent even with a stale pending row lingering', async () => {
    mockDbHandler = followUpDb({
      estimate: liveEstimate,
      receivedRows: [{ amount: '49.00', refunded_amount: '0.00' }],
      pendingRow: inWindowPending({ id: 'dep-stale' }),
    });
    const result = await assessDepositFollowUpEligibility('est-1', NOW);
    expect(result).toEqual({ eligible: false, reason: 'deposit_satisfied' });
  });

  it('no pending intent means no abandonment — never started paying', async () => {
    mockDbHandler = followUpDb({ estimate: liveEstimate, pendingRow: undefined });
    const result = await assessDepositFollowUpEligibility('est-1', NOW);
    expect(result).toEqual({ eligible: false, reason: 'no_pending_intent' });
  });

  it('pending intent touched under 2h ago is NOT nudged (customer may be mid-payment)', async () => {
    mockDbHandler = followUpDb({
      estimate: liveEstimate,
      pendingRow: inWindowPending({ updated_at: hoursBefore(0.5) }),
    });
    const result = await assessDepositFollowUpEligibility('est-1', NOW);
    expect(result).toEqual({ eligible: false, reason: 'pending_intent_recent' });
  });

  it('pending intent older than 72h is stale — expiring stage owns it', async () => {
    mockDbHandler = followUpDb({
      estimate: liveEstimate,
      pendingRow: inWindowPending({ updated_at: hoursBefore(80) }),
    });
    const result = await assessDepositFollowUpEligibility('est-1', NOW);
    expect(result).toEqual({ eligible: false, reason: 'pending_intent_stale' });
  });

  it('non-live estimate status is ineligible (accepted race)', async () => {
    mockDbHandler = followUpDb({ estimate: { ...liveEstimate, status: 'accepted' } });
    const result = await assessDepositFollowUpEligibility('est-1', NOW);
    expect(result).toEqual({ eligible: false, reason: 'status:accepted' });
  });

  it('accept-inactive estimate is ineligible', async () => {
    mockIsEstimateAcceptActive.mockReturnValueOnce(false);
    mockDbHandler = followUpDb({ estimate: liveEstimate });
    const result = await assessDepositFollowUpEligibility('est-1', NOW);
    expect(result).toEqual({ eligible: false, reason: 'estimate_inactive' });
  });

  it('exempt plan customer (snapshot) is ineligible', async () => {
    buildEstimateMembershipContext.mockResolvedValueOnce({ isExistingCustomer: true });
    mockDbHandler = followUpDb({
      estimate: liveEstimate,
      pendingRow: inWindowPending(),
    });
    const result = await assessDepositFollowUpEligibility('est-1', NOW);
    expect(result).toEqual({ eligible: false, reason: 'existing_plan_customer' });
  });

  it('live plan-customer check exempts a linked customer with qualifying services', async () => {
    mockLoadExistingRecurringQualifyingRows.mockResolvedValueOnce([{ id: 'svc-1' }]);
    mockDbHandler = followUpDb({
      estimate: { ...liveEstimate, customer_id: 'cust-1' },
      pendingRow: inWindowPending(),
    });
    const result = await assessDepositFollowUpEligibility('est-1', NOW);
    expect(result).toEqual({ eligible: false, reason: 'existing_plan_customer' });
  });

  it('fails CLOSED when the live plan-customer lookup throws (accept gate fails open here — SMS must not)', async () => {
    mockLoadExistingRecurringQualifyingRows.mockRejectedValueOnce(new Error('scheduled_services unavailable'));
    mockDbHandler = followUpDb({
      estimate: { ...liveEstimate, customer_id: 'cust-1' },
      pendingRow: inWindowPending(),
    });
    const result = await assessDepositFollowUpEligibility('est-1', NOW);
    expect(result).toEqual({ eligible: false, reason: 'eligibility_unverified' });
  });

  it('fails CLOSED when verification errors (unlike depositStillRecordable)', async () => {
    gates.buildPricingBundle.mockRejectedValueOnce(new Error('bundle exploded'));
    mockDbHandler = followUpDb({ estimate: liveEstimate });
    const result = await assessDepositFollowUpEligibility('est-1', NOW);
    expect(result).toEqual({ eligible: false, reason: 'eligibility_unverified' });
  });
});
