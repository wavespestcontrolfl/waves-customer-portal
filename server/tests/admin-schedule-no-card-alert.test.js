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

describe('recurringWithoutBillableAmount (booking gate)', () => {
  const { recurringWithoutBillableAmount } = adminScheduleRouter._test;

  const C = (patch) => ({ billing_mode: null, monthly_rate: 0, waveguard_tier: null, per_application_fee: null, ...patch });
  const base = {
    isRecurring: true,
    recurringFloorPrice: 0,
    createInvoiceOnComplete: true,
    isCallback: false,
    serviceType: 'Monthly Pest Control Service',
    customer: C({}),
  };

  test('refuses a recurring plan with no billable amount', () => {
    const out = recurringWithoutBillableAmount(base);
    expect(out).toMatchObject({ code: 'RECURRING_WITHOUT_BILLABLE_AMOUNT' });
  });

  test('a one-off visit is never blocked — booking stays instant', () => {
    expect(recurringWithoutBillableAmount({ ...base, isRecurring: false })).toBeNull();
  });

  test('asks whether an invoice will MINT, not what it would bill (Codex P0)', () => {
    // A priced visit predicts 'invoice', but shouldAutoInvoiceCompletion still
    // declines when create_invoice_on_complete is false, no explicit lane or
    // membership tier applies, and GATE_AUTOINVOICE_PRICED_VISITS is off —
    // those visits complete unbilled.
    expect(recurringWithoutBillableAmount({ ...base, recurringFloorPrice: 89 })).toBeNull();
    expect(recurringWithoutBillableAmount({
      ...base, recurringFloorPrice: 89, createInvoiceOnComplete: false,
    })).toBeTruthy();
    // A real membership tier DOES mint on completion, so it clears the gate.
    expect(recurringWithoutBillableAmount({
      ...base, recurringFloorPrice: 89, createInvoiceOnComplete: false, customer: C({ waveguard_tier: 'Bronze' }),
    })).toBeNull();
  });

  test('membership dues are real coverage — but only with a rate to collect', () => {
    expect(recurringWithoutBillableAmount({ ...base, customer: C({ waveguard_tier: 'Bronze', monthly_rate: 46.33 }) })).toBeNull();
    expect(recurringWithoutBillableAmount({ ...base, customer: C({ billing_mode: 'monthly_membership' }) })).toBeTruthy();
  });

  test('the mint question is asked with the REAL lane, not a rewritten one (Codex P0)', () => {
    // The annual lane is neutralized ONLY for the dues-coverage check. Passing
    // a rewritten lane into shouldAutoInvoiceCompletion made the gate believe
    // an invoice would mint (explicitPerVisitLane true, annualPrepayBilling
    // false) that completion then declines to cut with the priced-visits gate
    // off — every visit uninvoiced.
    const annual = C({ billing_mode: 'annual_prepay' });
    expect(recurringWithoutBillableAmount({
      ...base, customer: annual, recurringFloorPrice: 89, createInvoiceOnComplete: false,
    })).toBeTruthy();
    // With the scheduler stamp set it really does mint, so it clears.
    expect(recurringWithoutBillableAmount({
      ...base, customer: annual, recurringFloorPrice: 89,
    })).toBeNull();
  });

  test('an annual-prepay lane or a stale rate on an explicit lane is no amount (Codex P0)', () => {
    // Neither an inherited prepay lane (its term invoice is created
    // post-commit and may never exist) nor a monthly rate an explicit
    // per_visit lane deliberately ignores.
    expect(recurringWithoutBillableAmount({ ...base, customer: C({ billing_mode: 'annual_prepay', waveguard_tier: 'Bronze', monthly_rate: 46.33 }) })).toBeTruthy();
    expect(recurringWithoutBillableAmount({ ...base, customer: C({ billing_mode: 'per_visit', monthly_rate: 46.33 }) })).toBeTruthy();
  });

  test('per_application clears only with an acceptance fee on file', () => {
    expect(recurringWithoutBillableAmount({ ...base, customer: C({ billing_mode: 'per_application', per_application_fee: 98 }) })).toBeNull();
    expect(recurringWithoutBillableAmount({ ...base, customer: C({ billing_mode: 'per_application' }) })).toBeTruthy();
  });

  test('free-by-design work passes — the only exemption left', () => {
    expect(recurringWithoutBillableAmount({ ...base, isCallback: true })).toBeNull();
    expect(recurringWithoutBillableAmount({ ...base, serviceType: 'Pest Control Re-Service' })).toBeNull();
  });

  test('the remedy names the amount source the lane can actually use (Codex P1)', () => {
    // Telling a per_visit or per_application customer to set a monthly rate
    // sends the operator after a fix that cannot clear the gate.
    expect(recurringWithoutBillableAmount(base).fix).toMatchObject({ monthlyRate: true, perApplicationFee: false });
    expect(recurringWithoutBillableAmount({ ...base, customer: C({ billing_mode: 'per_visit', monthly_rate: 46.33 }) }).fix)
      .toMatchObject({ monthlyRate: false, visitPrice: true });
    const perApp = recurringWithoutBillableAmount({ ...base, customer: C({ billing_mode: 'per_application' }) });
    expect(perApp.fix).toMatchObject({ perApplicationFee: true, monthlyRate: false });
    expect(perApp.error).toMatch(/per-application fee/i);
  });
});

describe('recurringWithoutBillableAmount — typed one-time profile (Codex P1)', () => {
  const { recurringWithoutBillableAmount } = adminScheduleRouter._test;
  const C = (patch) => ({ billing_mode: null, monthly_rate: 0, waveguard_tier: null, per_application_fee: null, ...patch });
  const base = {
    isRecurring: true,
    recurringFloorPrice: 89,
    createInvoiceOnComplete: false,
    isCallback: false,
    serviceType: 'Monthly Pest Control Service',
    customer: C({}),
  };

  test('a one_time completion profile IS a mint trigger, so the booking clears', () => {
    // Without it the gate 409s a priced service completion would invoice.
    expect(recurringWithoutBillableAmount(base)).toBeTruthy();
    expect(recurringWithoutBillableAmount({ ...base, typedOneTimeBilling: true })).toBeNull();
  });

  test('the trigger still needs a price — it is not a blanket exemption', () => {
    expect(recurringWithoutBillableAmount({ ...base, recurringFloorPrice: 0, typedOneTimeBilling: true })).toBeTruthy();
  });

  test('it defaults FALSE, matching completion — never a blanket pass', () => {
    // Defaulting true would let any priced visit satisfy the typed-one-time
    // branch and silently undo the mint-decision fix.
    expect(recurringWithoutBillableAmount(base)).toBeTruthy();
  });
});
