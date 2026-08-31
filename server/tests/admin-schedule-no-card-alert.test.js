const adminScheduleRouter = require('../routes/admin-schedule');

describe('noCardOnFileAlert (day-view propertyAlerts payment flag)', () => {
  const { noCardOnFileAlert } = adminScheduleRouter._test;

  const invoiceDue = { kind: 'invoice', amount: 183, conflictStampedPrice: false };

  test('flags an empty wallet when completion will cut an invoice', () => {
    expect(noCardOnFileAlert({ hasChargeableMethod: false, prediction: invoiceDue }))
      .toEqual({ type: 'no_card_on_file', text: 'NO CARD ON FILE — collect payment on site' });
  });

  test('stays silent when a chargeable method exists', () => {
    expect(noCardOnFileAlert({ hasChargeableMethod: true, prediction: invoiceDue })).toBeNull();
  });

  test('stays silent for every non-invoice prediction kind', () => {
    // payer AR, prepaid/paid, dues- or annual-covered, and free
    // callback/follow-up visits — nothing to collect at the door.
    for (const kind of ['payer', 'prepaid', 'covered_membership', 'covered_annual', 'auto_charge', 'no_charge']) {
      expect(noCardOnFileAlert({
        hasChargeableMethod: false,
        prediction: { kind, amount: 183, conflictStampedPrice: false },
      })).toBeNull();
    }
  });

  test('stays silent on a zero/absent invoice amount or missing prediction', () => {
    expect(noCardOnFileAlert({
      hasChargeableMethod: false,
      prediction: { kind: 'invoice', amount: 0, conflictStampedPrice: false },
    })).toBeNull();
    expect(noCardOnFileAlert({
      hasChargeableMethod: false,
      prediction: { kind: 'invoice', amount: null, conflictStampedPrice: false },
    })).toBeNull();
    expect(noCardOnFileAlert({ hasChargeableMethod: false, prediction: null })).toBeNull();
  });
});

describe('unbilledVisitAlert (day-view money-gap flag)', () => {
  const { unbilledVisitAlert } = adminScheduleRouter._test;

  const gapPrediction = { kind: 'no_charge', amount: 0, conflictStampedPrice: false, reason: 'no_amount_on_file' };

  test('flags a visit that will bill nothing for lack of a number', () => {
    expect(unbilledVisitAlert({ hasChargeableMethod: false, prediction: gapPrediction }))
      .toEqual({ type: 'unbilled_visit', text: 'NOTHING WILL BILL — no rate set and no card on file' });
  });

  test('drops the card clause when the customer HAS a chargeable method', () => {
    expect(unbilledVisitAlert({ hasChargeableMethod: true, prediction: gapPrediction }))
      .toEqual({ type: 'unbilled_visit', text: 'NOTHING WILL BILL — no rate or price set for this visit' });
  });

  test('never claims "no card on file" when the wallet was not read', () => {
    expect(unbilledVisitAlert({ prediction: gapPrediction }).text)
      .toBe('NOTHING WILL BILL — no rate or price set for this visit');
  });

  test('stays silent on visits that are free BY DESIGN', () => {
    for (const reason of ['callback', 'always_free_service_type', 'annual_renewal_owned']) {
      expect(unbilledVisitAlert({
        hasChargeableMethod: false,
        prediction: { ...gapPrediction, reason },
      })).toBeNull();
    }
  });

  test('stays silent whenever money IS moving', () => {
    for (const kind of ['invoice', 'auto_charge', 'payer', 'prepaid', 'covered_membership', 'covered_annual']) {
      expect(unbilledVisitAlert({
        hasChargeableMethod: false,
        prediction: { kind, amount: 183, conflictStampedPrice: false },
      })).toBeNull();
    }
    expect(unbilledVisitAlert({ hasChargeableMethod: false, prediction: null })).toBeNull();
  });
});

describe('recurringWithoutBillableAmount (booking gate, canonical prediction)', () => {
  const { recurringWithoutBillableAmount } = adminScheduleRouter._test;

  // A recurring plan with no resolved price and no billable rate: every visit
  // completes at $0, forever (prod 2026-08-31).
  const unbillable = {
    isRecurring: true,
    finalPrice: 0,
    customer: { billing_mode: null, monthly_rate: 0, waveguard_tier: 'Bronze', per_application_fee: null },
    effectiveBillingTerm: 'standard',
    prepaid: null,
    payerBilled: false,
    isCallback: false,
    serviceType: 'Monthly Pest Control Service',
  };
  const withCustomer = (patch) => ({ ...unbillable, customer: { ...unbillable.customer, ...patch } });

  test('refuses a recurring plan with no number anywhere', () => {
    const out = recurringWithoutBillableAmount(unbillable);
    expect(out).toMatchObject({ code: 'RECURRING_WITHOUT_BILLABLE_AMOUNT' });
    expect(out.error).toMatch(/monthly rate/i);
  });

  test('a one-off visit is never blocked — booking stays instant', () => {
    expect(recurringWithoutBillableAmount({ ...unbillable, isRecurring: false })).toBeNull();
  });

  test('the RESOLVED price satisfies it — including one the server derived', () => {
    // finalPrice is post-buildAppointmentPricing, so a booking that sent no
    // explicit price but priced off services.base_price passes (Codex P1).
    expect(recurringWithoutBillableAmount({ ...unbillable, finalPrice: 46.33 })).toBeNull();
    expect(recurringWithoutBillableAmount({ ...unbillable, finalPrice: 0 })).toBeTruthy();
  });

  test('a monthly rate satisfies it ONLY on a lane that actually consumes it (Codex P0)', () => {
    // Inferred membership: real tier + positive rate → dues cover the visits.
    expect(recurringWithoutBillableAmount(withCustomer({ monthly_rate: 46.33 }))).toBeNull();
    expect(recurringWithoutBillableAmount(withCustomer({ billing_mode: 'monthly_membership', monthly_rate: 46.33 }))).toBeNull();
    // Explicit per_visit / one_time lanes IGNORE a lingering monthly_rate —
    // completionInvoiceAmount refuses that fallback, so the rate is not a
    // billing arrangement and the series would still complete unbilled.
    expect(recurringWithoutBillableAmount(withCustomer({ billing_mode: 'per_visit', monthly_rate: 46.33 }))).toBeTruthy();
    expect(recurringWithoutBillableAmount(withCustomer({ billing_mode: 'one_time', monthly_rate: 46.33 }))).toBeTruthy();
  });

  test('per_application passes ONLY with an acceptance fee on file (Codex P0)', () => {
    expect(recurringWithoutBillableAmount(withCustomer({ billing_mode: 'per_application', per_application_fee: 98 }))).toBeNull();
    expect(recurringWithoutBillableAmount(withCustomer({ billing_mode: 'per_application', per_application_fee: null }))).toBeTruthy();
    expect(recurringWithoutBillableAmount(withCustomer({ billing_mode: 'per_application', per_application_fee: 0 }))).toBeTruthy();
  });

  test('annual prepay passes on the EFFECTIVE term, never the requested one (Codex P0)', () => {
    expect(recurringWithoutBillableAmount({ ...unbillable, effectiveBillingTerm: 'prepay_annual' })).toBeNull();
    // A request the route downgraded back to standard must NOT slip through.
    expect(recurringWithoutBillableAmount({ ...unbillable, effectiveBillingTerm: 'standard' })).toBeTruthy();
    // The annual_prepay LANE keeps its own exemption via the prediction.
    expect(recurringWithoutBillableAmount(withCustomer({ billing_mode: 'annual_prepay' }))).toBeNull();
  });

  test('the remaining legitimate arrangements pass', () => {
    expect(recurringWithoutBillableAmount({ ...unbillable, prepaid: { totalAmount: 900 } })).toBeNull();
    // Validated ACTIVE payer only — the caller resolves it through
    // resolveForInvoice, so a deactivated payer arrives here as false and the
    // series is still refused (Codex P0).
    expect(recurringWithoutBillableAmount({ ...unbillable, payerBilled: true })).toBeNull();
    expect(recurringWithoutBillableAmount({ ...unbillable, payerBilled: false })).toBeTruthy();
    expect(recurringWithoutBillableAmount({ ...unbillable, isCallback: true })).toBeNull();
    expect(recurringWithoutBillableAmount({ ...unbillable, serviceType: 'Pest Control Re-Service' })).toBeNull();
  });

  test('a zero-amount prepay is not an arrangement', () => {
    expect(recurringWithoutBillableAmount({ ...unbillable, prepaid: { totalAmount: 0 } })).toBeTruthy();
  });
});
