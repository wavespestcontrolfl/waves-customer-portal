/**
 * Unbilled-completion money gap — separating "free on purpose" from
 * "free because nobody set a number".
 *
 * Prod 2026-08-31: a customer was hand-booked out of an SMS thread instead of
 * accepting his estimate, so he landed with monthly_rate 0, no card, and four
 * recurring visits. Every visit predicted `no_charge` — the same kind a free
 * callback predicts — so the sheet said "nothing bills for this visit" and
 * nothing distinguished the two. These pin the `reason` split that makes the
 * warning possible, and pin that the gap NEVER fires on a deliberately free
 * visit (a false warning teaches the tech to ignore the real one).
 */

const {
  predictCompletionBilling,
  unbilledCompletionGap,
} = require('../services/billing-lane');

// The reproduction: self-pay lane, recurring plan visit, no stamped price, no
// monthly rate, no coverage of any kind.
const unbilledShape = {
  lane: 'per_visit',
  billingMode: null,
  autopayActive: false,
  estimatedPrice: null,
  monthlyRate: 0,
  isRecurring: true,
  isCallback: false,
  serviceType: 'Monthly Pest Control Service',
  payerBilled: false,
  prepaidAmount: null,
  prepaidMethod: null,
};

describe('no_charge reason split', () => {
  test('an unpriced self-pay visit is a money gap, not a free visit', () => {
    const p = predictCompletionBilling(unbilledShape);
    expect(p.kind).toBe('no_charge');
    expect(p.reason).toBe('no_amount_on_file');
    expect(unbilledCompletionGap({ prediction: p })).toEqual({
      reason: 'no_amount_on_file',
      noPaymentMethod: null,
    });
  });

  test('a callback is free BY DESIGN and never warns', () => {
    const p = predictCompletionBilling({ ...unbilledShape, isCallback: true });
    expect(p.kind).toBe('no_charge');
    expect(p.reason).toBe('callback');
    expect(unbilledCompletionGap({ prediction: p })).toBeNull();
  });

  test('an explicit per_visit callback is free BY DESIGN and never warns', () => {
    const p = predictCompletionBilling({ ...unbilledShape, billingMode: 'per_visit', isCallback: true });
    expect(p.reason).toBe('callback');
    expect(unbilledCompletionGap({ prediction: p })).toBeNull();
  });

  test('an unpriced annual-prepay visit is owned by the renewal flow, not a gap', () => {
    const p = predictCompletionBilling({
      ...unbilledShape,
      lane: 'annual_prepay',
      billingMode: 'annual_prepay',
      annualCoverageValidated: false,
    });
    expect(p.kind).toBe('no_charge');
    expect(p.reason).toBe('annual_renewal_owned');
    expect(unbilledCompletionGap({ prediction: p })).toBeNull();
  });

  test('a per-application lane with no fee on file IS a gap', () => {
    const p = predictCompletionBilling({
      ...unbilledShape,
      lane: 'per_application',
      billingMode: 'per_application',
      perApplicationFee: 0,
    });
    expect(p.reason).toBe('no_amount_on_file');
    expect(unbilledCompletionGap({ prediction: p })).toBeTruthy();
  });
});

describe('gap never fires where money IS moving', () => {
  test('a priced visit invoices and does not warn — even with no card', () => {
    const p = predictCompletionBilling({ ...unbilledShape, estimatedPrice: 89 });
    expect(p.kind).toBe('invoice');
    // The empty wallet here is the no_card_on_file badge's job, not this one.
    expect(unbilledCompletionGap({ prediction: p, hasChargeableMethod: false })).toBeNull();
  });

  test('a dues-covered membership visit does not warn', () => {
    const p = predictCompletionBilling({
      ...unbilledShape,
      lane: 'monthly_membership',
      billingMode: 'monthly_membership',
      monthlyRate: 46.33,
      autopayActive: true,
    });
    expect(p.kind).toBe('covered_membership');
    expect(unbilledCompletionGap({ prediction: p })).toBeNull();
  });

  test('a PRICED payer-billed visit does not warn', () => {
    // The unpriced case is NOT silent — see the payer-billed describe below.
    // This assertion originally covered every payer visit, which encoded the
    // bug Codex found: an unpriced payer visit bills nobody.
    const p = predictCompletionBilling({ ...unbilledShape, payerBilled: true, estimatedPrice: 183 });
    expect(p.kind).toBe('payer');
    expect(unbilledCompletionGap({ prediction: p })).toBeNull();
  });
});

describe('wallet context sharpens the message without widening the gap', () => {
  test('an empty wallet is asserted only when actually read', () => {
    const p = predictCompletionBilling(unbilledShape);
    expect(unbilledCompletionGap({ prediction: p, hasChargeableMethod: false }).noPaymentMethod).toBe(true);
    expect(unbilledCompletionGap({ prediction: p, hasChargeableMethod: true }).noPaymentMethod).toBe(false);
    // Unreadable wallet must not invent "no card on file".
    expect(unbilledCompletionGap({ prediction: p, hasChargeableMethod: null }).noPaymentMethod).toBeNull();
  });

  test('a null prediction is not a gap', () => {
    expect(unbilledCompletionGap({ prediction: null })).toBeNull();
  });
});

describe('payer-billed visits', () => {
  const payer = { ...unbilledShape, payerBilled: true };

  test('an UNPRICED payer visit with no amount from ANY source is a gap', () => {
    const p = predictCompletionBilling(payer);
    expect(p.kind).toBe('payer');
    expect(p.amount).toBeNull();
    // A payer says who owes, not how much; completion refuses to mint at <= 0,
    // so this bills nobody — not the customer, not the payer.
    expect(unbilledCompletionGap({ prediction: p })).toMatchObject({ reason: 'no_amount_on_file' });
  });

  test('the payer amount follows the CANONICAL precedence, not the stamp alone (Codex P1)', () => {
    // Reading estimatedPrice alone made these look amountless and warned falsely.
    const rated = predictCompletionBilling({ ...payer, monthlyRate: 46.33 });
    expect(rated.amount).toBe(46.33);
    expect(unbilledCompletionGap({ prediction: rated })).toBeNull();

    const perApp = predictCompletionBilling({
      ...payer, lane: 'per_application', billingMode: 'per_application', perApplicationFee: 98,
    });
    expect(perApp.amount).toBe(98);
    expect(unbilledCompletionGap({ prediction: perApp })).toBeNull();

    const priced = predictCompletionBilling({ ...payer, estimatedPrice: 183 });
    expect(priced.amount).toBe(183);
    expect(unbilledCompletionGap({ prediction: priced })).toBeNull();
  });

  test('free-by-design payer work predicts no_charge, not a payer invoice (Codex P1)', () => {
    // Completion suppresses callbacks and always-free types before the payer
    // matters, so a 'payer' verdict made the sheet promise an AP invoice that
    // completion will never cut.
    const cb = predictCompletionBilling({ ...payer, isCallback: true });
    expect(cb).toMatchObject({ kind: 'no_charge', reason: 'callback' });
    expect(unbilledCompletionGap({ prediction: cb })).toBeNull();

    const free = predictCompletionBilling({ ...payer, serviceType: 'Pest Control Re-Service' });
    expect(free).toMatchObject({ kind: 'no_charge', reason: 'always_free_service_type' });
    expect(unbilledCompletionGap({ prediction: free })).toBeNull();
  });
});

describe('payer gaps never borrow the service customer wallet', () => {
  test('a payer gap reports payerBilled and NO wallet verdict (Codex P1)', () => {
    // The sheet turns noPaymentMethod:true into an offer to text THIS
    // customer a card link — for an invoice a third party owns.
    const p = predictCompletionBilling({ ...unbilledShape, payerBilled: true });
    const gap = unbilledCompletionGap({ prediction: p, hasChargeableMethod: false });
    expect(gap).toMatchObject({ reason: 'no_amount_on_file', payerBilled: true });
    expect(gap.noPaymentMethod).toBeNull();
  });

  test('a self-pay gap still reports the empty wallet', () => {
    const p = predictCompletionBilling(unbilledShape);
    const gap = unbilledCompletionGap({ prediction: p, hasChargeableMethod: false });
    expect(gap.noPaymentMethod).toBe(true);
    expect(gap.payerBilled).toBeUndefined();
  });
});
