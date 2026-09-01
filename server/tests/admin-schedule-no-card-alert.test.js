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
    recurringFloorPrice: 0,
    customer: { billing_mode: null, monthly_rate: 0, waveguard_tier: 'Bronze', per_application_fee: null },
    prepaid: null,
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

  test('the RESOLVED floor price satisfies it — including one the server derived', () => {
    // Post-buildAppointmentPricing, so a booking that sent no explicit price
    // but priced off services.base_price passes (Codex P1).
    expect(recurringWithoutBillableAmount({ ...unbillable, recurringFloorPrice: 46.33 })).toBeNull();
    // The FLOOR, not the anchor total: a series whose anchor is priced only
    // by a seasonal add-on has a $0 floor, and its children — recomputed from
    // date-filtered add-ons — would complete unbilled (Codex P0).
    expect(recurringWithoutBillableAmount({ ...unbillable, recurringFloorPrice: 0 })).toBeTruthy();
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

  test('an UNPRICED annual-prepay booking is still refused (Codex P0)', () => {
    // The prepay term invoice is created post-commit by
    // markEstimateManuallyAccepted, which may fail with the booking left
    // standing — so a requested prepay term is not an amount. A real prepay
    // booking carries its quoted price and passes on that.
    expect(recurringWithoutBillableAmount(unbillable)).toBeTruthy();
    expect(recurringWithoutBillableAmount({ ...unbillable, recurringFloorPrice: 46.33 })).toBeNull();
  });

  test('an annual-prepay customer with a STALE tier + rate cannot infer coverage (Codex P0)', () => {
    // Nulling the mode let resolveBillingLane infer monthly_membership from a
    // retained tier + positive rate. Completion sees billing_mode
    // 'annual_prepay', ignores the monthly rate, and bills nothing — so the
    // gate must force an explicit non-membership lane, not merely clear it.
    const stale = withCustomer({ billing_mode: 'annual_prepay', monthly_rate: 46.33, waveguard_tier: 'Bronze' });
    expect(recurringWithoutBillableAmount(stale)).toBeTruthy();
    expect(recurringWithoutBillableAmount({ ...stale, recurringFloorPrice: 89 })).toBeNull();
    // A genuine member (no annual mode) with the same rate is still covered.
    expect(recurringWithoutBillableAmount(withCustomer({ monthly_rate: 46.33 }))).toBeNull();
  });

  test('the annual-prepay LANE is no exemption either — priced or refused (Codex P0)', () => {
    // The prepay invoice + term are created post-commit and may never exist,
    // so neither a requested prepay term nor an inherited prepay lane can
    // stand in for an amount. A genuine prepay booking carries its quote.
    const annualCustomer = withCustomer({ billing_mode: 'annual_prepay' });
    expect(recurringWithoutBillableAmount(annualCustomer)).toBeTruthy();
    expect(recurringWithoutBillableAmount({ ...annualCustomer, recurringFloorPrice: 46.33 })).toBeNull();
  });

  test('an explicit member with a ZERO rate has no collectible dues (Codex P0)', () => {
    // memberSeriesCovered strips the primary price from covered rows, so the
    // caller passes the addon-only floor; with rate 0 there are no dues to
    // cover them either and the series would run entirely free.
    expect(recurringWithoutBillableAmount(withCustomer({ billing_mode: 'monthly_membership' }))).toBeTruthy();
    expect(recurringWithoutBillableAmount(withCustomer({ billing_mode: 'monthly_membership', monthly_rate: 46.33 }))).toBeNull();
    // The inferred-membership shape (real tier + rate) is covered as before.
    expect(recurringWithoutBillableAmount(withCustomer({ monthly_rate: 46.33 }))).toBeNull();
  });

  test('free-by-design work passes — the only exemptions left', () => {
    // The gate now carries NO bespoke exemptions: every verdict comes from the
    // canonical prediction. The payer, recorded-prepayment and
    // requested-annual-prepay exemptions were each removed after Codex showed
    // that none of them supplies an AMOUNT.
    expect(recurringWithoutBillableAmount({ ...unbillable, isCallback: true })).toBeNull();
    expect(recurringWithoutBillableAmount({ ...unbillable, serviceType: 'Pest Control Re-Service' })).toBeNull();
  });

  test('a recorded prepayment is not a price for the plan (Codex P0)', () => {
    // stampSeriesPrepaid spreads the operator's total across the visits seeded
    // NOW; an ongoing series keeps generating unstamped, unpriced visits after
    // it, and those complete unbilled.
    expect(recurringWithoutBillableAmount(unbillable)).toBeTruthy();
  });

  test('a payer does NOT substitute for a price (Codex P0)', () => {
    // A payer says who owes; completion still refuses to mint at <= 0, so an
    // unpriced payer-billed series bills nobody. Only a real amount clears it.
    expect(recurringWithoutBillableAmount(unbillable)).toBeTruthy();
    expect(recurringWithoutBillableAmount({ ...unbillable, recurringFloorPrice: 46.33 })).toBeNull();
  });

  test('a zero-amount prepay is not an arrangement', () => {
    expect(recurringWithoutBillableAmount({ ...unbillable, prepaid: { totalAmount: 0 } })).toBeTruthy();
  });
});
