jest.mock('../services/estimate-first-application-invoice', () => ({
  findFirstApplicationInvoiceForEstimateService: jest.fn(),
}));

const {
  shouldAttemptPrepaidReceipt,
  resolveScheduledServiceCharge,
} = require('../routes/admin-schedule')._test;
const { findFirstApplicationInvoiceForEstimateService } = require('../services/estimate-first-application-invoice');

afterEach(() => {
  jest.clearAllMocks();
});

describe('shouldAttemptPrepaidReceipt', () => {
  const ok = { gateEnabled: true, emailReceipt: true, applyToSeries: false, prepaidAmount: 80 };

  test('attempts when gated on, requested, single visit, positive amount', () => {
    expect(shouldAttemptPrepaidReceipt(ok)).toEqual({ attempt: true, reason: null });
  });

  test('does not attempt when the operator did not request a receipt', () => {
    expect(shouldAttemptPrepaidReceipt({ ...ok, emailReceipt: false }))
      .toEqual({ attempt: false, reason: 'not_requested' });
    // undefined (flag absent in body) is also "not requested", not a crash.
    expect(shouldAttemptPrepaidReceipt({ ...ok, emailReceipt: undefined }))
      .toEqual({ attempt: false, reason: 'not_requested' });
    // Only a strict true opts in — a truthy string must not trigger a send.
    expect(shouldAttemptPrepaidReceipt({ ...ok, emailReceipt: 'yes' }))
      .toEqual({ attempt: false, reason: 'not_requested' });
  });

  test('not-requested takes precedence over a disabled gate', () => {
    expect(shouldAttemptPrepaidReceipt({ ...ok, emailReceipt: false, gateEnabled: false }))
      .toEqual({ attempt: false, reason: 'not_requested' });
  });

  test('does not attempt when the gate is off (fail-closed)', () => {
    expect(shouldAttemptPrepaidReceipt({ ...ok, gateEnabled: false }))
      .toEqual({ attempt: false, reason: 'disabled' });
  });

  test('does not attempt for a whole-series prepayment', () => {
    expect(shouldAttemptPrepaidReceipt({ ...ok, applyToSeries: true }))
      .toEqual({ attempt: false, reason: 'series_unsupported' });
  });

  test('does not attempt when no money was recorded', () => {
    expect(shouldAttemptPrepaidReceipt({ ...ok, prepaidAmount: 0 }))
      .toEqual({ attempt: false, reason: 'no_prepaid_amount' });
    expect(shouldAttemptPrepaidReceipt({ ...ok, prepaidAmount: -5 }))
      .toEqual({ attempt: false, reason: 'no_prepaid_amount' });
    expect(shouldAttemptPrepaidReceipt({ ...ok, prepaidAmount: NaN }))
      .toEqual({ attempt: false, reason: 'no_prepaid_amount' });
  });
});

describe('resolveScheduledServiceCharge', () => {
  test('an explicit estimate price wins over everything', async () => {
    expect(await resolveScheduledServiceCharge({ estimatedPrice: 129, isCallback: false, monthlyRate: 49 }))
      .toBe(129);
    // even on a callback, an explicitly-set price is honoured
    expect(await resolveScheduledServiceCharge({ estimatedPrice: 129, isCallback: true, monthlyRate: 49 }))
      .toBe(129);
  });

  test('a non-callback recurring visit falls back to the monthly rate', async () => {
    expect(await resolveScheduledServiceCharge({ estimatedPrice: null, isCallback: false, monthlyRate: 49 }))
      .toBe(49);
  });

  test('a callback (re-service) is free even with a monthly rate', async () => {
    expect(await resolveScheduledServiceCharge({ estimatedPrice: null, isCallback: true, monthlyRate: 49 }))
      .toBe(0);
  });

  test('a zero/negative estimate price falls through to the monthly rate', async () => {
    expect(await resolveScheduledServiceCharge({ estimatedPrice: 0, isCallback: false, monthlyRate: 49 }))
      .toBe(49);
    expect(await resolveScheduledServiceCharge({ estimatedPrice: -10, isCallback: false, monthlyRate: 49 }))
      .toBe(49);
  });

  test('nothing chargeable returns 0', async () => {
    expect(await resolveScheduledServiceCharge({ estimatedPrice: null, isCallback: false, monthlyRate: 0 }))
      .toBe(0);
    expect(await resolveScheduledServiceCharge({ estimatedPrice: null, isCallback: false, monthlyRate: null }))
      .toBe(0);
  });

  // Codex pre-push P1: this resolver used to short-circuit ANY explicit
  // non-monthly billingMode to 0 before ever looking at a per-application
  // fee — Charge Now / prepaid-receipt minting billed $0 for an unpriced
  // explicit per_application visit with a real acceptance fee on file,
  // although completion (completionInvoiceAmount) and the schedule sheet's
  // own billingLane.prediction both billed the fee. Delegating to
  // completionInvoiceAmount fixes the divergence for every caller.
  test('an explicit per_application lane bills its acceptance fee, not zero', async () => {
    expect(await resolveScheduledServiceCharge({
      estimatedPrice: null, isCallback: false, monthlyRate: 74.7, billingMode: 'per_application', perApplicationFee: 97.2,
    })).toBe(97.2);
    // No fee stamped on the per_application account — nothing bills, and
    // still never the lingering monthlyRate (that number is the dues
    // figure, not a per-visit fee).
    expect(await resolveScheduledServiceCharge({
      estimatedPrice: null, isCallback: false, monthlyRate: 74.7, billingMode: 'per_application', perApplicationFee: null,
    })).toBe(0);
    // A callback never bills the acceptance fee either.
    expect(await resolveScheduledServiceCharge({
      estimatedPrice: null, isCallback: true, monthlyRate: 74.7, billingMode: 'per_application', perApplicationFee: 97.2,
    })).toBe(0);
  });

  test('an explicit non-monthly, non-per_application lane still never falls back to the lingering monthly rate', async () => {
    expect(await resolveScheduledServiceCharge({
      estimatedPrice: null, isCallback: false, monthlyRate: 74.7, billingMode: 'per_visit',
    })).toBe(0);
  });

  // Codex pre-push P0: completionInvoiceAmount itself has no serviceType
  // concept — only predictCompletionBilling's per_application branch
  // excludes always-free types (estimate/follow-up/re-service), BEFORE ever
  // computing an amount. An unpriced follow-up under an explicit
  // per_application lane predicts $0 there; this resolver must refuse the
  // SAME acceptance-fee fallback for it, or Charge Now / the prepaid
  // receipt would mint a fee completion never bills.
  test('an unpriced always-free-type visit under an explicit per_application lane never bills the acceptance fee', async () => {
    expect(await resolveScheduledServiceCharge({
      estimatedPrice: null, isCallback: false, monthlyRate: 74.7, billingMode: 'per_application',
      perApplicationFee: 97.2, serviceType: 'Pest Control Follow-Up',
    })).toBe(0);
    // An explicit price still wins over the always-free-type guard, same
    // as it always has over isCallback on this resolver.
    expect(await resolveScheduledServiceCharge({
      estimatedPrice: 50, isCallback: false, monthlyRate: 74.7, billingMode: 'per_application',
      perApplicationFee: 97.2, serviceType: 'Pest Control Follow-Up',
    })).toBe(50);
    // A genuinely billable per_application type is unaffected — with no
    // svc/dbConn passed (the pure, DB-free shape), the sibling-coverage
    // guard below never even asks.
    expect(await resolveScheduledServiceCharge({
      estimatedPrice: null, isCallback: false, monthlyRate: 74.7, billingMode: 'per_application',
      perApplicationFee: 97.2, serviceType: 'Quarterly Pest Control',
    })).toBe(97.2);
    expect(findFirstApplicationInvoiceForEstimateService).not.toHaveBeenCalled();
  });

  // Codex pre-push P1 (this branch): a same-day combined per-application
  // accept invoices the RESERVED sibling row for the whole trip and leaves
  // THIS, the PROMOTED row, deliberately unpriced — but the customer can
  // still carry an established per_application_fee from an earlier accept
  // (estimate-converter.js preserves it on an add-on accept). Without a
  // sibling-coverage check, Charge Now / the prepaid receipt would mint
  // that unrelated fee for a trip the sibling's invoice already covers.
  describe('sibling-covered same-trip visit', () => {
    const SVC = { id: 'svc-lawn', customer_id: 'cust-1', source_estimate_id: 'est-1', scheduled_date: '2026-09-27' };
    const DB_CONN = {};

    test('a sibling-covered unpriced per_application visit never mints the lingering acceptance fee', async () => {
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
        invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
        liveBeside: null,
      });
      expect(await resolveScheduledServiceCharge({
        estimatedPrice: null, isCallback: false, monthlyRate: 74.7, billingMode: 'per_application',
        perApplicationFee: 97.2, serviceType: 'Every 6 Weeks Lawn Care', svc: SVC, dbConn: DB_CONN,
      })).toBe(0);
    });

    test('an explicit own price still wins over sibling coverage', async () => {
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
        invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
        liveBeside: null,
      });
      expect(await resolveScheduledServiceCharge({
        estimatedPrice: 40, isCallback: false, monthlyRate: 74.7, billingMode: 'per_application',
        perApplicationFee: 97.2, serviceType: 'Every 6 Weeks Lawn Care', svc: SVC, dbConn: DB_CONN,
      })).toBe(40);
      expect(findFirstApplicationInvoiceForEstimateService).not.toHaveBeenCalled();
    });

    test('a match naming this visit\'s OWN row (not a sibling) still bills the fee', async () => {
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
        invoice: { id: 'inv-1', scheduled_service_id: SVC.id, status: 'sent', total: 97.2 },
        liveBeside: null,
      });
      expect(await resolveScheduledServiceCharge({
        estimatedPrice: null, isCallback: false, monthlyRate: 74.7, billingMode: 'per_application',
        perApplicationFee: 97.2, serviceType: 'Every 6 Weeks Lawn Care', svc: SVC, dbConn: DB_CONN,
      })).toBe(97.2);
    });

    test('no sibling match still bills the fee', async () => {
      findFirstApplicationInvoiceForEstimateService.mockResolvedValue({ invoice: null, liveBeside: null });
      expect(await resolveScheduledServiceCharge({
        estimatedPrice: null, isCallback: false, monthlyRate: 74.7, billingMode: 'per_application',
        perApplicationFee: 97.2, serviceType: 'Every 6 Weeks Lawn Care', svc: SVC, dbConn: DB_CONN,
      })).toBe(97.2);
    });

    test('a lookup failure fails toward the fee, never toward a false $0', async () => {
      findFirstApplicationInvoiceForEstimateService.mockRejectedValue(new Error('db down'));
      expect(await resolveScheduledServiceCharge({
        estimatedPrice: null, isCallback: false, monthlyRate: 74.7, billingMode: 'per_application',
        perApplicationFee: 97.2, serviceType: 'Every 6 Weeks Lawn Care', svc: SVC, dbConn: DB_CONN,
      })).toBe(97.2);
    });

    test('without svc/dbConn (a caller that has neither) skips the lookup and still bills the fee', async () => {
      expect(await resolveScheduledServiceCharge({
        estimatedPrice: null, isCallback: false, monthlyRate: 74.7, billingMode: 'per_application',
        perApplicationFee: 97.2, serviceType: 'Every 6 Weeks Lawn Care',
      })).toBe(97.2);
      expect(findFirstApplicationInvoiceForEstimateService).not.toHaveBeenCalled();
    });
  });
});
