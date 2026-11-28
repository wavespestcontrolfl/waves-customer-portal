/**
 * PR 7 regression suite — Billing audit findings B-12, B-22, B-23, B-24, B-44, B-46, B-60.
 * (B-44 route/dismiss tests also live in admin-billing-recovery-routes.test.js;
 * B-12/B-23 preview tests also live in schedule-prepay-switch.test.js;
 * B-24 Customer 360 tests also live in admin-customers-annual-prepay-receipt.test.js;
 * B-60 bell tests also live in prepay-year-end-bell.test.js;
 * B-22 client tests live in client/src/pages/PayPageV2.part-payments.test.jsx.)
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn(async () => ({ rows: [] }));
  fn.transaction = jest.fn(async (cb) => cb(fn));
  fn.schema = {
    hasTable: jest.fn(async () => true),
    hasColumn: jest.fn(async () => true),
  };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })),
}));

const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const { gates } = require('../config/feature-gates');
const { isRecognizedAcceptDiscountLine } = require('../services/estimate-first-application-invoice');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
const PayPlanChoice = require('../services/pay-plan-choice');
const { computeSeriesPrepayPricing } = require('../services/secure-appointment-plans');
const EstimateConverter = require('../services/estimate-converter');
const { assertNoExistingPlanForPrepay } = require('../services/estimate-manual-acceptance');
const PlanRateLedger = require('../services/plan-rate-ledger');
const StripeService = require('../services/stripe');

function qb({ rows = [], first = undefined, del = 0, returning = [] } = {}) {
  const q = {};
  const chain = [
    'where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull',
    'whereRaw', 'whereBetween', 'orWhere', 'andWhere', 'orderBy', 'limit',
    'forUpdate', 'select', 'join', 'leftJoin', 'distinct', 'modify',
  ];
  for (const m of chain) q[m] = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.del = jest.fn(async () => del);
  q.update = jest.fn(() => q);
  q.insert = jest.fn(() => q);
  q.onConflict = jest.fn(() => q);
  q.merge = jest.fn(async () => returning);
  q.returning = jest.fn(async () => returning);
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(rows).catch(reject);
  return q;
}

function setQueues(map) {
  const queues = new Map(Object.entries(map).map(([k, v]) => [k, [...v]]));
  db.mockImplementation((table) => {
    const list = queues.get(table);
    if (!list || !list.length) throw new Error(`Unexpected db table ${table}`);
    return list.shift();
  });
}

describe('B-12: negative _kind: discount lines on first-application invoices', () => {
  test('isRecognizedAcceptDiscountLine accepts legitimate negative estimate-discount lines and rejects unsafe shapes', () => {
    expect(isRecognizedAcceptDiscountLine({
      _kind: 'discount', description: 'Military Discount', quantity: 1, unit_price: -15, amount: -15,
    })).toBe(true);
    expect(isRecognizedAcceptDiscountLine({
      _kind: 'discount', description: 'Zero dollar promo', quantity: 1, unit_price: 0, amount: 0,
    })).toBe(true);
    // Reject positive discount line
    expect(isRecognizedAcceptDiscountLine({
      _kind: 'discount', description: 'Positive line', quantity: 1, unit_price: 15, amount: 15,
    })).toBe(false);
    // Reject deposit credit, catalog discount_id / discount_for, arbitrary line
    expect(isRecognizedAcceptDiscountLine({
      _kind: 'deposit_credit', description: 'Deposit', quantity: 1, unit_price: -50, amount: -50,
    })).toBe(false);
    expect(isRecognizedAcceptDiscountLine({
      _kind: 'discount', discount_id: 'disc-1', description: 'Catalog discount', quantity: 1, unit_price: -15, amount: -15,
    })).toBe(false);
    expect(isRecognizedAcceptDiscountLine({
      _kind: 'discount', discount_for: 'line-1', description: 'Targeted discount', quantity: 1, unit_price: -15, amount: -15,
    })).toBe(false);
    expect(isRecognizedAcceptDiscountLine({
      description: 'Extra service', quantity: 1, unit_price: 45, amount: 45,
    })).toBe(false);
  });

  test('invoiceBillsOnlyAcceptedPlan allows negative _kind: discount beside base lines and fails closed on discount-only or positive extras', () => {
    const { invoiceBillsOnlyAcceptedPlan } = AnnualPrepayRenewals._private;
    expect(invoiceBillsOnlyAcceptedPlan({
      credit_applied: 0,
      amount_paid: 0,
      line_items: [
        { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99, amount: 99 },
        { description: 'First service application', quantity: 1, unit_price: 120, amount: 120 },
        { _kind: 'discount', description: 'WaveGuard Silver', quantity: 1, unit_price: -12, amount: -12 },
      ],
    })).toBe(true);

    // Discount-only invoice fails closed
    expect(invoiceBillsOnlyAcceptedPlan({
      credit_applied: 0,
      amount_paid: 0,
      line_items: [{ _kind: 'discount', description: 'WaveGuard Silver', quantity: 1, unit_price: -12, amount: -12 }],
    })).toBe(false);

    // Positive _kind: discount fails closed
    expect(invoiceBillsOnlyAcceptedPlan({
      credit_applied: 0,
      amount_paid: 0,
      line_items: [
        { description: 'First service application', quantity: 1, unit_price: 120, amount: 120 },
        { _kind: 'discount', description: 'Tampered', quantity: 1, unit_price: 12, amount: 12 },
      ],
    })).toBe(false);

    // Applied credit or partial payment fails closed
    expect(invoiceBillsOnlyAcceptedPlan({
      credit_applied: 10,
      amount_paid: 0,
      line_items: [{ description: 'First service application', quantity: 1, unit_price: 120, amount: 120 }],
    })).toBe(false);
    expect(invoiceBillsOnlyAcceptedPlan({
      credit_applied: 0,
      amount_paid: 20,
      line_items: [{ description: 'First service application', quantity: 1, unit_price: 120, amount: 120 }],
    })).toBe(false);
  });
});

describe('B-22: cross-invoice locks, close-refusal alert, auto-credit/promo guard, and bidirectional combined exclusion', () => {
  const origPayPlanChoice = gates.payPlanChoice;
  const origAutoApply = gates.autoApplyAccountCredit;

  beforeEach(() => {
    jest.clearAllMocks();
    gates.payPlanChoice = true;
    gates.autoApplyAccountCredit = true;
    db.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  });

  afterAll(() => {
    gates.payPlanChoice = origPayPlanChoice;
    gates.autoApplyAccountCredit = origAutoApply;
  });

  test('bidirectional combined-balance exclusion drops F for P anchor, P for F anchor, and P for an unrelated anchor X', () => {
    const first = { id: 'inv-f', invoice_number: 'WPC-2026-1001', notes: 'Auto-generated from accepted estimate #est-1.' };
    const prepay = {
      id: 'inv-p',
      invoice_number: 'WPC-2026-1002',
      notes: PayPlanChoice.prepayInvoiceNote('WPC-2026-1001'),
    };
    const unrelated = { id: 'inv-x', invoice_number: 'WPC-2026-1003', notes: 'Routine service' };

    // Anchor = P -> exclude F
    expect(PayPlanChoice.filterOutPlanChoiceAlternatives(prepay, [first, unrelated]).map((i) => i.id)).toEqual(['inv-x']);
    // Anchor = F -> exclude P
    expect(PayPlanChoice.filterOutPlanChoiceAlternatives(first, [prepay, unrelated]).map((i) => i.id)).toEqual(['inv-x']);
    // Anchor = X -> keep F, exclude P so F+P can never bundle together
    expect(PayPlanChoice.filterOutPlanChoiceAlternatives(unrelated, [first, prepay]).map((i) => i.id)).toEqual(['inv-f']);
  });

  test('assertPlanChoiceCounterpartPayable refuses (409 planChoiceConflict) when counterpart P is processing or has a live Stripe PI', async () => {
    const EST_UUID = '11111111-1111-4111-8111-111111111111';
    const first = {
      id: 'inv-f',
      customer_id: 'cust-1',
      invoice_number: 'WPC-2026-1001',
      status: 'sent',
      notes: `Auto-generated from accepted estimate #${EST_UUID}.`,
      annual_prepay_term_id: null,
    };
    const prepayProcessing = {
      id: 'inv-p',
      invoice_number: 'WPC-2026-1002',
      status: 'processing',
      notes: PayPlanChoice.prepayInvoiceNote('WPC-2026-1001'),
      stripe_payment_intent_id: null,
    };
    setQueues({
      invoices: [qb({ rows: [prepayProcessing] })],
    });
    await expect(PayPlanChoice.assertPlanChoiceCounterpartPayable(db, first, { inspectStripe: false }))
      .rejects.toMatchObject({ statusCode: 409, planChoiceConflict: true, inProgress: true });

    // Reverse direction: paying P while F has a live Stripe PI in 'processing' (ACH / two-tab race)
    const retrieveSpy = jest.spyOn(StripeService, 'retrievePaymentIntent').mockResolvedValue({ status: 'processing' });
    try {
      const prepayOpen = {
        id: 'inv-p',
        customer_id: 'cust-1',
        invoice_number: 'WPC-2026-1002',
        status: 'draft',
        notes: PayPlanChoice.prepayInvoiceNote('WPC-2026-1001'),
        annual_prepay_term_id: 'term-p',
      };
      const firstOpenWithLivePi = {
        id: 'inv-f',
        invoice_number: 'WPC-2026-1001',
        status: 'sent',
        notes: `Auto-generated from accepted estimate #${EST_UUID}.`,
        stripe_payment_intent_id: 'pi_live_1',
      };
      setQueues({
        invoices: [qb({ rows: [firstOpenWithLivePi] })],
        payments: [qb({ first: null })],
      });
      await expect(PayPlanChoice.assertPlanChoiceCounterpartPayable(db, prepayOpen, { inspectStripe: true }))
        .rejects.toMatchObject({ statusCode: 409, planChoiceConflict: true, inProgress: true });
    } finally {
      retrieveSpy.mockRestore();
    }
  });

  test('planChoiceForInvoice withholds choice when invoice has credit_applied, amount_paid, active promo, or projected auto-credit', async () => {
    const EST_UUID = '11111111-1111-4111-8111-111111111111';
    const baseFirst = {
      id: 'inv-f',
      customer_id: 'cust-1',
      invoice_number: 'WPC-2026-1001',
      status: 'sent',
      total: 227,
      credit_applied: 0,
      amount_paid: 0,
      paid_at: null,
      payer_id: null,
      annual_prepay_term_id: null,
      scheduled_service_id: 'ss-1',
      notes: `Auto-generated from accepted estimate #${EST_UUID}.`,
    };
    // Direct credit_applied > 0 refuses immediately with zero DB reads
    expect(await PayPlanChoice.planChoiceForInvoice({ ...baseFirst, credit_applied: 10 })).toBeNull();
    // Direct amount_paid > 0 refuses immediately with zero DB reads
    expect(await PayPlanChoice.planChoiceForInvoice({ ...baseFirst, amount_paid: 25 })).toBeNull();

    // Projected auto-apply account credit on customer withholds plan choice
    setQueues({
      invoices: [qb({ rows: [] })],
      annual_prepay_terms: [qb({ rows: [] })],
      invoice_promo_codes: [qb({ first: null })],
      customers: [qb({ first: { account_credits: 30, auto_apply_account_credit: true } })],
    });
    expect(await PayPlanChoice.planChoiceForInvoice(baseFirst)).toBeNull();

    // Active entered promo code on invoice withholds plan choice
    setQueues({
      invoices: [qb({ rows: [] })],
      annual_prepay_terms: [qb({ rows: [] })],
      invoice_promo_codes: [qb({ first: { id: 'ipc-1' } })],
    });
    expect(await PayPlanChoice.planChoiceForInvoice(baseFirst)).toBeNull();
  });

  test('closeAcceptInvoiceReplacedByPaidTerm raises a rule-clean Billing needs-you alert when F cannot auto-void (credit_applied or processing)', async () => {
    const term = {
      id: 'term-1',
      customer_id: 'cust-1',
      source_estimate_id: 'est-1',
      prepay_invoice_id: 'inv-p',
      status: 'active',
    };
    const prepay = {
      id: 'inv-p',
      invoice_number: 'WPC-2026-2002',
      status: 'paid',
      notes: PayPlanChoice.prepayInvoiceNote('WPC-2026-2001'),
    };
    const firstWithCredit = {
      id: 'inv-f',
      invoice_number: 'WPC-2026-2001',
      status: 'sent',
      notes: 'Auto-generated from accepted estimate #est-1.',
      scheduled_service_id: 'ss-1',
      line_items: [{ description: 'First service application', quantity: 1, unit_price: 120, amount: 120 }],
      credit_applied: 20,
      amount_paid: 0,
    };
    setQueues({
      annual_prepay_terms: [qb({ first: term })],
      invoices: [qb({ first: prepay }), qb({ rows: [firstWithCredit] })],
    });

    const out = await AnnualPrepayRenewals.closeAcceptInvoiceReplacedByPaidTerm(term);
    expect(out).toEqual({ closed: false, alerted: true, reason: 'credit_payment_or_line_mismatch' });
    // Real composeAdminAlert ran (throws in NODE_ENV=test on any rule violation) and called notifyAdmin!
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'billing',
      'Billing — review first invoice after annual prepay',
      'Annual prepay paid, but the replaced first invoice could not auto-void and needs manual review.',
      expect.objectContaining({
        bell: true,
        dedupeKey: 'plan-choice-replace-close-refused:term-1:inv-f',
        link: '/admin/customers?customerId=cust-1',
      }),
    );

    // Also fires when F is already 'processing' (ACH in flight)
    NotificationService.notifyAdmin.mockClear();
    const firstProcessing = { ...firstWithCredit, status: 'processing', credit_applied: 0 };
    setQueues({
      annual_prepay_terms: [qb({ first: term })],
      invoices: [qb({ first: prepay }), qb({ rows: [firstProcessing] })],
    });
    const out2 = await AnnualPrepayRenewals.closeAcceptInvoiceReplacedByPaidTerm(term);
    expect(out2).toEqual({ closed: false, alerted: true, reason: 'invoice_processing' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });
});

describe('B-23: estimate-origin prepay switches delegate to EstimateConverter.resolveAnnualPrepayInvoiceTotal', () => {
  test('lawn estimate with lawnProgramMinimumMonthly and armed lawnCostFloor never undercuts protected floor', () => {
    // Program minimum floor ($50/mo = $600/yr): only $200 above-floor headroom earns 5% ($10 -> $790, NOT flat 5% = $760).
    const minProtectedData = {
      pricingMetadata: { lawnProgramMinimumMonthly: 50, lawnCostFloorArmed: false },
      recurring: {
        services: [{ service: 'lawn_care', name: 'Lawn Care', annualTotal: 800, monthly: 66.67, visitsPerYear: 9 }],
      },
    };
    const minExpected = EstimateConverter.resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 800,
      recurringServices: EstimateConverter.recurringServicesFromEstimateData(minProtectedData),
      estimateData: minProtectedData,
    });
    expect(minExpected.amount).toBe(790);
    expect(minExpected.discount).toBe(10);

    const minPricing = computeSeriesPrepayPricing({
      perVisit: 800 / 9,
      visitsPerYear: 9,
      planClass: 'discount',
      serviceKey: 'lawn_care',
      serviceType: 'Lawn Care',
      estimateData: minProtectedData,
    });
    expect(minPricing.prepay.total).toBe(minExpected.amount);
    expect(minPricing.prepay.discount).toBe(10);

    // Armed cost-floor slice ($820 floor on $840/yr = $70/mo exact): discount clamps at $20 -> $820 (never flat 5% = $798).
    const costFloorData = {
      pricingMetadata: { lawnProgramMinimumMonthly: 0, lawnCostFloorArmed: true },
      recurring: {
        services: [{
          service: 'lawn_care',
          name: 'Lawn Care',
          annualTotal: 840,
          monthly: 70,
          visitsPerYear: 9,
          minimumCollectedAnnualPrice: 820,
        }],
      },
    };
    const costFloorExpected = EstimateConverter.resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 840,
      recurringServices: EstimateConverter.recurringServicesFromEstimateData(costFloorData),
      estimateData: costFloorData,
    });
    expect(costFloorExpected.amount).toBe(820);
    const costFloorPricing = computeSeriesPrepayPricing({
      perVisit: 840 / 9,
      visitsPerYear: 9,
      planClass: 'discount',
      serviceKey: 'lawn_care',
      serviceType: 'Lawn Care',
      estimateData: costFloorData,
    });
    expect(costFloorPricing.prepay.total).toBe(820);
    expect(costFloorPricing.prepay.discount).toBe(20);
  });

  test('operator-waived solo Pest estimate gets 5% prepay discount instead of $0 savings', () => {
    const estimateData = {
      operatorPriceAdjustment: { waiveSetupFee: true },
      recurring: { services: [{ service: 'pest_control', name: 'Quarterly Pest Control', annualTotal: 520, monthly: 43.33, visitsPerYear: 4 }] },
    };
    const pricing = computeSeriesPrepayPricing({
      perVisit: 130,
      visitsPerYear: 4,
      planClass: 'fee_waiver',
      serviceKey: 'pest_control',
      serviceType: 'Quarterly Pest Control',
      estimateData,
    });
    expect(pricing.prepay.total).toBe(494);
    expect(pricing.prepay.discount).toBe(26);
    expect(pricing.prepay.ratePctLabel).toBe('5%');
  });
});

describe('B-24: live locked existing-plan guard and non-successor property/series scoping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AnnualPrepayRenewals._private.resetCachesForTests();
    db.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  });

  test('B-24(a): assertNoExistingPlanForPrepay refuses with 400 ANNUAL_PREPAY_EXISTING_PLAN even when membershipSnapshot is stale false', async () => {
    const trx = jest.fn((table) => {
      if (table === 'customers') {
        return qb({
          first: { id: 'cust-1', pipeline_stage: 'active_customer', billing_mode: 'monthly_membership', monthly_rate: 55 },
        });
      }
      if (table === 'scheduled_services') return qb({ first: null });
      throw new Error(`Unexpected table ${table}`);
    });
    trx.raw = jest.fn(async () => ({ rows: [] }));

    await expect(assertNoExistingPlanForPrepay(
      trx,
      { bookedAppointmentIds: [] },
      {
        id: 'est-1',
        customer_id: 'cust-1',
        estimate_data: { membershipSnapshot: { isExistingCustomer: false } },
      },
    )).rejects.toMatchObject({ status: 400, statusCode: 400, code: 'ANNUAL_PREPAY_EXISTING_PLAN' });
  });

  test('B-24(b): non-successor coverageRowsForTerm never steals visits from Property B when term belongs to Property A', async () => {
    const term = {
      id: 'term-prop-a',
      customer_id: 'cust-mp',
      source_estimate_id: 'est-prop-a',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
      term_start: '2026-01-01',
      term_end: '2026-12-31',
    };
    const rows = [
      { id: 'v-b1', customer_id: 'cust-mp', property_id: 'prop-B', scheduled_date: '2026-02-01', service_type: 'Quarterly Pest Control', status: 'pending' },
      { id: 'v-a1', customer_id: 'cust-mp', property_id: 'prop-A', scheduled_date: '2026-03-01', service_type: 'Quarterly Pest Control', status: 'pending' },
      { id: 'v-b2', customer_id: 'cust-mp', property_id: 'prop-B', scheduled_date: '2026-05-01', service_type: 'Quarterly Pest Control', status: 'pending' },
      { id: 'v-a2', customer_id: 'cust-mp', property_id: 'prop-A', scheduled_date: '2026-06-01', service_type: 'Quarterly Pest Control', status: 'pending' },
    ];
    setQueues({
      scheduled_services: [qb({ rows })],
      estimates: [qb({ first: { property_id: 'prop-A' } })],
    });
    const covered = await AnnualPrepayRenewals.coverageRowsForTerm(term, db);
    expect(covered.map((r) => r.id)).toEqual(['v-a1', 'v-a2']);
  });

  test('B-24(b): non-successor coverageRowsForTerm scopes commercial multi-series terms to their own series root', async () => {
    const term = {
      id: 'term-s1',
      customer_id: 'cust-comm',
      coverage_service_type: 'Quarterly Pest Control',
      coverage_visit_count: 4,
      term_start: '2026-04-01',
      term_end: '2027-03-31',
    };
    // Series 1 root was outside the window (already linked to term-s1); Series 1 & 2 children sit inside the window.
    const windowRows = [
      { id: 's2-v2', customer_id: 'cust-comm', is_recurring: true, recurring_parent_id: 's2-root', scheduled_date: '2026-05-01', service_type: 'Quarterly Pest Control', status: 'pending' },
      { id: 's1-v2', customer_id: 'cust-comm', is_recurring: true, recurring_parent_id: 's1-root', scheduled_date: '2026-06-01', service_type: 'Quarterly Pest Control', status: 'pending' },
      { id: 's2-v3', customer_id: 'cust-comm', is_recurring: true, recurring_parent_id: 's2-root', scheduled_date: '2026-08-01', service_type: 'Quarterly Pest Control', status: 'pending' },
      { id: 's1-v3', customer_id: 'cust-comm', is_recurring: true, recurring_parent_id: 's1-root', scheduled_date: '2026-09-01', service_type: 'Quarterly Pest Control', status: 'pending' },
    ];
    const outsideLinked = [
      { id: 's1-root', is_recurring: true, recurring_parent_id: null, recurring_pattern: 'quarterly' },
    ];
    setQueues({
      scheduled_services: [qb({ rows: windowRows }), qb({ rows: outsideLinked })],
    });
    const covered = await AnnualPrepayRenewals.coverageRowsForTerm(term, db);
    expect(covered.map((r) => r.id)).toEqual(['s1-v2', 's1-v3']);
  });

  test('B-24(b): stampedTermStillCoversVisit rejects a stale stamp sitting on a different property', async () => {
    const term = {
      id: 'term-prop-a',
      customer_id: 'cust-mp',
      source_estimate_id: 'est-prop-a',
      coverage_service_type: 'Quarterly Pest Control',
    };
    setQueues({
      estimates: [qb({ first: { property_id: 'prop-A' } })],
    });
    // Use annualPrepayCoversVisit indirectly via _private or check directly:
    const scope = await AnnualPrepayRenewals._private.nonSuccessorCoverageScope(term, db, null);
    expect(scope.propertyId).toBe('prop-A');
    expect(AnnualPrepayRenewals._private.rowInNonSuccessorScope({
      id: 'v-b', property_id: 'prop-B', service_type: 'Quarterly Pest Control',
    }, scope)).toBe(false);
    expect(AnnualPrepayRenewals._private.rowInNonSuccessorScope({
      id: 'v-a', property_id: 'prop-A', service_type: 'Quarterly Pest Control',
    }, scope)).toBe(true);
  });
});

describe('B-46: prepay_annual plan-rate snapshot and revert on term void/refund', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.schema = { hasTable: jest.fn(async () => true), hasColumn: jest.fn(async () => true) };
  });

  test('revertPrepayAcceptPlanRates deletes term-minted customer_plan_rates, restores prior components, and restores prior monthly_rate', async () => {
    const estimateUpdateRows = [];
    let rateRows = [
      { customer_id: 'cust-1', family_key: 'pest', monthly_rate: 45, source_estimate_id: 'est-prepay', source: 'estimate_accept' },
    ];
    let customerRow = { id: 'cust-1', monthly_rate: 45 };
    const fakeDb = jest.fn((table) => {
      if (table === 'estimates') {
        return {
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async () => ({
            estimate_data: {
              acceptedBillingTerm: 'prepay_annual',
              prepayPriorRateSnapshot: {
                customerId: 'cust-1',
                priorMonthlyRate: 30,
                writtenMonthlyRate: 45,
                priorComponents: [{ family_key: 'mosquito', monthly_rate: 30, source_estimate_id: 'est-old', source: 'estimate_accept' }],
              },
            },
          })),
        };
      }
      if (table === 'customer_plan_rates') {
        let filter = {};
        const q = {
          where: jest.fn((cond) => { filter = { ...filter, ...cond }; return q; }),
          del: jest.fn(async () => {
            const before = rateRows.length;
            rateRows = rateRows.filter((r) => !(r.customer_id === filter.customer_id && r.source_estimate_id === filter.source_estimate_id));
            return before - rateRows.length;
          }),
          select: jest.fn(async () => rateRows.filter((r) => r.customer_id === filter.customer_id)),
          insert: jest.fn((row) => ({
            onConflict: () => ({
              merge: async () => {
                rateRows = rateRows.filter((r) => !(r.customer_id === row.customer_id && r.family_key === row.family_key));
                rateRows.push(row);
              },
            }),
          })),
        };
        return q;
      }
      if (table === 'customers') {
        const q = {
          where: jest.fn(() => q),
          first: jest.fn(async () => customerRow),
          update: jest.fn(async (patch) => {
            customerRow = { ...customerRow, ...patch };
            estimateUpdateRows.push(patch);
            return 1;
          }),
        };
        return q;
      }
      throw new Error(`Unexpected table ${table}`);
    });
    fakeDb.schema = { hasTable: jest.fn(async () => true) };

    const result = await PlanRateLedger.revertPrepayAcceptPlanRates(fakeDb, {
      customerId: 'cust-1',
      sourceEstimateId: 'est-prepay',
      termMonthlyRate: 45,
    });
    expect(result).toEqual({ reverted: true, restoredRate: 30, deletedCount: 1 });
    expect(customerRow.monthly_rate).toBe(30);
    expect(rateRows.map((r) => ({ family: r.family_key, rate: r.monthly_rate }))).toEqual([{ family: 'mosquito', rate: 30 }]);
  });

  test('revertPrepayAcceptPlanRates leaves per_application switch-prepays completely untouched', async () => {
    const fakeDb = jest.fn((table) => {
      if (table === 'estimates') {
        return {
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async () => ({
            estimate_data: { acceptedBillingTerm: 'per_application' },
          })),
        };
      }
      throw new Error(`Unexpected write on ${table}`);
    });
    fakeDb.schema = { hasTable: jest.fn(async () => true) };

    const result = await PlanRateLedger.revertPrepayAcceptPlanRates(fakeDb, {
      customerId: 'cust-1',
      sourceEstimateId: 'est-switch',
      termMonthlyRate: 42,
    });
    expect(result).toEqual({ reverted: false, reason: 'not_prepay_accept' });
  });

  test('revertPrepayAcceptPlanRates does not clobber a manual admin monthly_rate edit', async () => {
    const customerUpdate = jest.fn();
    const fakeDb = jest.fn((table) => {
      if (table === 'estimates') {
        return {
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async () => ({
            estimate_data: {
              acceptedBillingTerm: 'prepay_annual',
              prepayPriorRateSnapshot: {
                customerId: 'cust-1',
                priorMonthlyRate: null,
                writtenMonthlyRate: 45,
                priorComponents: [],
              },
            },
          })),
        };
      }
      if (table === 'customer_plan_rates') {
        const q = {
          where: jest.fn(() => q),
          del: jest.fn(async () => 0),
          select: jest.fn(async () => [{ family_key: 'pest', monthly_rate: 79 }]),
        };
        return q;
      }
      if (table === 'customers') {
        return {
          where: jest.fn().mockReturnThis(),
          first: jest.fn(async () => ({ id: 'cust-1', monthly_rate: 79 })),
          update: customerUpdate,
        };
      }
      throw new Error(`Unexpected table ${table}`);
    });
    fakeDb.schema = { hasTable: jest.fn(async () => true) };

    const result = await PlanRateLedger.revertPrepayAcceptPlanRates(fakeDb, {
      customerId: 'cust-1',
      sourceEstimateId: 'est-prepay',
      termMonthlyRate: 45,
    });
    expect(result).toEqual({ reverted: false, restoredRate: null, deletedCount: 0 });
    expect(customerUpdate).not.toHaveBeenCalled();
  });
});

describe('B-60: prepay year-end bell uses serviceMatchesCoverage for variant labels', () => {
  test('isNextYearOf matches variant service labels and rejects unrelated services', () => {
    const { isNextYearOf } = require('../services/prepay-year-end-bell')._private;
    const year1 = {
      id: 'term-1',
      term_start: '2025-11-24',
      term_end: '2026-11-24',
      coverage_service_type: 'Quarterly Pest Control',
    };
    expect(isNextYearOf({ id: 'term-2', term_start: '2026-11-25', coverage_service_type: 'Pest Control' }, year1)).toBe(true);
    expect(isNextYearOf({ id: 'term-2', term_start: '2026-11-25', coverage_service_type: 'General Pest Control Service' }, year1)).toBe(true);
    expect(isNextYearOf({ id: 'term-2', term_start: '2026-11-25', coverage_service_type: 'Lawn Care' }, year1)).toBe(false);
  });
});
