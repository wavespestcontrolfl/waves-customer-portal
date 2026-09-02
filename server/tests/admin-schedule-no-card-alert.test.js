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

  test('a priced visit that will NOT mint reads as its own reason, not a missing rate', () => {
    const priced = { kind: 'invoice', amount: 183, conflictStampedPrice: false };
    expect(unbilledVisitAlert({ hasChargeableMethod: false, prediction: priced, willMint: false }))
      .toEqual({ type: 'unbilled_visit', text: 'NOTHING WILL BILL — this visit is priced but no invoice will be created' });
    expect(unbilledVisitAlert({ hasChargeableMethod: false, prediction: { ...priced, kind: 'auto_charge' }, willMint: false }).text)
      .toBe('NOTHING WILL BILL — this visit is priced but no invoice will be created');
    // Unknown (null) is never a gap; true is money moving.
    expect(unbilledVisitAlert({ hasChargeableMethod: false, prediction: priced, willMint: null })).toBeNull();
    expect(unbilledVisitAlert({ hasChargeableMethod: false, prediction: priced, willMint: true })).toBeNull();
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

  test('NULL (profile lookup failed) on a PRICED series fails CLOSED with a retryable verdict, not "no amount" (pre-push Codex P1 + P0)', () => {
    // The typed one-time profile is the one trigger that could mint here
    // and it could not be read: refuse (never fail open on a read error)
    // but say so — the operator retries rather than chasing a rate.
    expect(recurringWithoutBillableAmount({ ...base, typedOneTimeBilling: null })).toMatchObject({
      code: 'RECURRING_BILLING_UNVERIFIED',
      fix: { monthlyRate: false, perApplicationFee: false, visitPrice: false },
    });
    // A resolved non-one-time profile is the ordinary refusal.
    expect(recurringWithoutBillableAmount({ ...base, typedOneTimeBilling: false }).code).toBe('RECURRING_WITHOUT_BILLABLE_AMOUNT');
    // A $0 floor mints under no profile, so uncertainty changes nothing:
    // ordinary refusal, with the fix hints.
    expect(recurringWithoutBillableAmount({ ...base, recurringFloorPrice: 0, typedOneTimeBilling: null }).code).toBe('RECURRING_WITHOUT_BILLABLE_AMOUNT');
    // A read failure never overrides a verdict that mints anyway.
    expect(recurringWithoutBillableAmount({ ...base, typedOneTimeBilling: null, createInvoiceOnComplete: true })).toBeNull();
  });

  test('every gate call site passes NULL when the profile read fails, never false', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    // POST create, make-recurring spawn, visit-count extend: each resolves
    // the profile with .catch(() => null) and maps null → null.
    const sites = src.match(/typedOneTimeBilling: (gateProfile|spawnProfile|extendProfile)\n/g) || [];
    expect(sites).toHaveLength(3);
    expect((src.match(/typedOneTimeBilling: String\(/g) || []).length).toBe(0);
  });
});

describe('enrichBillingLaneWithWalletGap wiring (source guards)', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
  const fn = src.slice(
    src.indexOf('async function enrichBillingLaneWithWalletGap('),
    src.indexOf('function recurringWithoutBillableAmount('),
  );

  test('auto_charge predictions reach the mint verdict instead of returning early (Codex P1)', () => {
    expect(fn).toContain("const needsWallet = ['invoice', 'auto_charge', 'payer'].includes(billingLane?.prediction?.kind)");
  });

  test('the no-card badge is derived AFTER the mint verdict and suppressed when nothing mints (Codex P2)', () => {
    const verdict = fn.indexOf('const gap = unbilledCompletionGap({ prediction: billingLane.prediction, hasChargeableMethod, willMint });');
    const noCard = fn.indexOf('noCardOnFileAlert({ hasChargeableMethod, prediction: billingLane.prediction })');
    expect(verdict).toBeGreaterThan(-1);
    expect(noCard).toBeGreaterThan(verdict);
    expect(fn).toContain("const noCardAlert = gap?.reason === 'no_invoice_will_mint'\n      ? null\n      : noCardOnFileAlert(");
    // One alert writer for the money-gap line: the helper, fed the verdict.
    expect(fn).toContain('unbilledVisitAlert({ hasChargeableMethod, prediction: billingLane.prediction, willMint })');
    expect((fn.match(/alerts\.push\(/g) || []).length).toBe(2);
  });
});

describe('predictionFromAttachedInvoice — dead attachments never short-circuit the mint question (Codex P1)', () => {
  const { predictionFromAttachedInvoice } = adminScheduleRouter._test;
  const inv = { id: 'i1', status: 'sent', total: 129, credit_applied: 0, payer_id: null };

  test('a live attachment is the prediction source', () => {
    expect(predictionFromAttachedInvoice(inv)).toMatchObject({ kind: 'invoice', amount: 129, source: 'attached_invoice' });
  });

  test('void AND canceled attachments yield null — completion replaces them, so the row prediction (and its mint verdict) must run', () => {
    for (const status of ['void', 'canceled', 'cancelled', 'Canceled']) {
      expect(predictionFromAttachedInvoice({ ...inv, status })).toBeNull();
    }
  });

  test('the day/week feed loads pick the latest LIVE attachment — a newer canceled one must not hide an older open one', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    // The three feed loads that feed predictionFromAttachedInvoice / the
    // sheet's checkout lines. The Charge-now mint-or-reuse loads (svc.id)
    // are a different contract and deliberately untouched.
    expect((src.match(/\.whereNotIn\('status', DEAD_ATTACHED_INVOICE_STATUSES\)/g) || []).length).toBe(3);
    expect(src).not.toMatch(/scheduled_service_id: s\.id \}\)\s*\n\s*\.whereNot\('status', 'void'\)/);
  });
});
