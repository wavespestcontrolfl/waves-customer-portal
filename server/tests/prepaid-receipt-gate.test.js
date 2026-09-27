const {
  shouldAttemptPrepaidReceipt,
  resolveScheduledServiceCharge,
} = require('../routes/admin-schedule')._test;

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
  test('an explicit estimate price wins over everything', () => {
    expect(resolveScheduledServiceCharge({ estimatedPrice: 129, isCallback: false, monthlyRate: 49 }))
      .toBe(129);
    // even on a callback, an explicitly-set price is honoured
    expect(resolveScheduledServiceCharge({ estimatedPrice: 129, isCallback: true, monthlyRate: 49 }))
      .toBe(129);
  });

  test('a non-callback recurring visit falls back to the monthly rate', () => {
    expect(resolveScheduledServiceCharge({ estimatedPrice: null, isCallback: false, monthlyRate: 49 }))
      .toBe(49);
  });

  test('a callback (re-service) is free even with a monthly rate', () => {
    expect(resolveScheduledServiceCharge({ estimatedPrice: null, isCallback: true, monthlyRate: 49 }))
      .toBe(0);
  });

  test('a zero/negative estimate price falls through to the monthly rate', () => {
    expect(resolveScheduledServiceCharge({ estimatedPrice: 0, isCallback: false, monthlyRate: 49 }))
      .toBe(49);
    expect(resolveScheduledServiceCharge({ estimatedPrice: -10, isCallback: false, monthlyRate: 49 }))
      .toBe(49);
  });

  test('nothing chargeable returns 0', () => {
    expect(resolveScheduledServiceCharge({ estimatedPrice: null, isCallback: false, monthlyRate: 0 }))
      .toBe(0);
    expect(resolveScheduledServiceCharge({ estimatedPrice: null, isCallback: false, monthlyRate: null }))
      .toBe(0);
  });

  // Codex pre-push P1: this resolver used to short-circuit ANY explicit
  // non-monthly billingMode to 0 before ever looking at a per-application
  // fee — Charge Now / prepaid-receipt minting billed $0 for an unpriced
  // explicit per_application visit with a real acceptance fee on file,
  // although completion (completionInvoiceAmount) and the schedule sheet's
  // own billingLane.prediction both billed the fee. Delegating to
  // completionInvoiceAmount fixes the divergence for every caller.
  test('an explicit per_application lane bills its acceptance fee, not zero', () => {
    expect(resolveScheduledServiceCharge({
      estimatedPrice: null, isCallback: false, monthlyRate: 74.7, billingMode: 'per_application', perApplicationFee: 97.2,
    })).toBe(97.2);
    // No fee stamped on the per_application account — nothing bills, and
    // still never the lingering monthlyRate (that number is the dues
    // figure, not a per-visit fee).
    expect(resolveScheduledServiceCharge({
      estimatedPrice: null, isCallback: false, monthlyRate: 74.7, billingMode: 'per_application', perApplicationFee: null,
    })).toBe(0);
    // A callback never bills the acceptance fee either.
    expect(resolveScheduledServiceCharge({
      estimatedPrice: null, isCallback: true, monthlyRate: 74.7, billingMode: 'per_application', perApplicationFee: 97.2,
    })).toBe(0);
  });

  test('an explicit non-monthly, non-per_application lane still never falls back to the lingering monthly rate', () => {
    expect(resolveScheduledServiceCharge({
      estimatedPrice: null, isCallback: false, monthlyRate: 74.7, billingMode: 'per_visit',
    })).toBe(0);
  });
});
