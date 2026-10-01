/**
 * sms-amount-recheck - the send-time revalidation shared by the scheduler's fire-time path and the immediate Agent Review send
 * (PR #5119 follow-up #2), plus (PR #5331) the PAYMENT STATUS contract at send time and the Zelle recheck: fresh context,
 * current obligations only, fail closed on any error.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/context-aggregator', () => ({
  getContextForCustomer: jest.fn(),
  authorizedDuesCents: jest.fn(() => []),
}));
// the shared billing figures + the owed-figure rule are the drafter's real ones
jest.mock('../services/sms-followup-sla', () => ({ realAnswersGateOn: jest.fn(() => false) }));
jest.mock('../services/sms-suggest-mode', () => ({ hasPriceQuote: jest.fn((t) => /\b(?:fifty|forty|twenty|hundred)\s+dollars\b|\d+\s?\/\s?mo\b|\$\s?\d/i.test(String(t || ''))) }));
jest.mock('../routes/pay-v2', () => ({ payPageZelleVisibility: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: jest.fn(async () => {}) }));
const { realAnswersGateOn } = require('../services/sms-followup-sla');
const ContextAggregator = require('../services/context-aggregator');
const { payPageZelleVisibility } = require('../routes/pay-v2');
const { assertInvoiceDepositSettlementReady } = require('../services/estimate-deposits');
const {
  outgoingAmountsStale, bodyAmountCents, outgoingZelleStale, zelleBodyContacts, zelleInvoiceStillEligible,
  hasAffirmativeZelleMention, classifyZelleClause, paymentStatusSendBlockReason, bodyNeedsPaymentRecheck,
} = require('../services/sms-amount-recheck');

const V12 = 'house_voice_v12_real_answers5_cf_pf';

function dbWithCustomer(row) {
  return () => ({ where: () => ({ first: async () => row }) });
}

// Distinguishes by table name, unlike dbWithCustomer above - needed once a
// test exercises BOTH the invoices lookup (Zelle eligibility) and the
// customers lookup (the amount-grounding path) in the same call.
function dbWithTables(map) {
  return (table) => ({
    where: () => ({
      first: async () => {
        const entry = map[table];
        if (entry instanceof Error) throw entry;
        return entry === undefined ? null : entry;
      },
    }),
  });
}

beforeEach(() => {
  ContextAggregator.getContextForCustomer.mockReset();
  ContextAggregator.authorizedDuesCents.mockReset().mockReturnValue([]);
  realAnswersGateOn.mockReset().mockReturnValue(false);
  payPageZelleVisibility.mockReset();
  assertInvoiceDepositSettlementReady.mockReset().mockImplementation(async () => {});
});

test('bodyAmountCents extracts every priced form in cents', () => {
  expect(bodyAmountCents('You owe $120.50 and paid 95 dollars; USD 12 too.')).toEqual([12050, 9500, 1200]);
  expect(bodyAmountCents('No figures here, just Tuesday at 9.')).toEqual([]);
});

// Independent-review P1 (finding 4): ZELLE_RECIPIENT is a live env var that
// can change or be unset between a card's draft time and its send.

describe('outgoingZelleStale / zelleBodyContacts — a Zelle contact must still be the CURRENT one at send time', () => {
  let priorZelle;
  beforeEach(() => {
    priorZelle = process.env.ZELLE_RECIPIENT;
  });
  afterEach(() => {
    if (priorZelle === undefined) delete process.env.ZELLE_RECIPIENT;
    else process.env.ZELLE_RECIPIENT = priorZelle;
  });

  test('no Zelle contact in the body ⇒ not stale, regardless of config', () => {
    delete process.env.ZELLE_RECIPIENT;
    expect(zelleBodyContacts('We take card or ACH through your pay link.')).toEqual([]);
    expect(outgoingZelleStale('We take card or ACH through your pay link.')).toEqual({ stale: false });
  });

  test('body names the CURRENT recipient exactly ⇒ not stale', () => {
    process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com';
    const body = 'You can Zelle to payments@wavespestcontrol.com, just add your name.';
    expect(zelleBodyContacts(body)).toEqual([{ kind: 'email', value: 'payments@wavespestcontrol.com' }]);
    expect(outgoingZelleStale(body)).toEqual({ stale: false });
  });

  // Codex round-16 P1: Zelle context carries across clauses — the instruction clause that names
  // the contact never says "Zelle" itself.
  test('Zelle context carries to a following transfer-instruction clause that has no Zelle word', () => {
    process.env.ZELLE_RECIPIENT = 'new-recipient@wavespestcontrol.com';
    const stale = { stale: true, reason: 'zelle_recipient_stale' };
    // the auditor's split (clause 1 is already an offer) and the receipt-then-instruction split
    expect(outgoingZelleStale('Send it via Zelle. Use old-recipient@wavespestcontrol.com for $120.')).toEqual(stale);
    expect(hasAffirmativeZelleMention('We received your Zelle payment. Use old-recipient@wavespestcontrol.com for the rest.')).toBe(true);
    expect(zelleBodyContacts('We received your Zelle payment. Use old-recipient@wavespestcontrol.com for the rest.')).toHaveLength(1);
    expect(outgoingZelleStale('We received your Zelle payment. Use old-recipient@wavespestcontrol.com for the rest.')).toEqual(stale);
    expect(outgoingZelleStale('We received your Zelle payment. Send the rest to (941) 555-1234.')).toEqual(stale);
    // the current recipient still passes; and with no recipient configured the instruction is stale
    expect(outgoingZelleStale('We received your Zelle payment. Use new-recipient@wavespestcontrol.com for the rest.')).toEqual({ stale: false });
    delete process.env.ZELLE_RECIPIENT;
    expect(outgoingZelleStale('We received your Zelle payment. Use pay@example.com for the rest.')).toEqual(stale);
  });

  test('no over-trigger: a portal instruction or negated Zelle stay clean', () => {
    process.env.ZELLE_RECIPIENT = 'new-recipient@wavespestcontrol.com';
    for (const body of [
      "We don't take Zelle. Pay online at the portal.",
      'Thanks! Send the rest through the invoice page.',
    ]) expect({ body, mention: hasAffirmativeZelleMention(body) }).toEqual({ body, mention: false });
  });

  // PR #5331: a rendered payment-status sentence never names a manual tender, so ANY affirmative Zelle clause is a live
  // instruction/offer (recipient + invoice rechecked) - there is no separate "Zelle receipt" kind to exempt.
  test('a Zelle clause is an offer unless negated; a receipt-shaped Zelle clause is NOT exempt (fail closed)', () => {
    expect(classifyZelleClause('We received your $120 Zelle payment from Sep 12.')).toBe('offer');
    expect(hasAffirmativeZelleMention('We received your $120 Zelle payment from Sep 12.')).toBe(true);
    expect(classifyZelleClause("We don't take Zelle anymore")).toBeNull();
    expect(classifyZelleClause('see you Tuesday')).toBeNull();
    expect(classifyZelleClause('Zelle works great for that')).toBe('offer');
    expect(classifyZelleClause('you can Zelle us anytime')).toBe('offer');
  });

  test('recipient reconfigured since draft ⇒ stale', () => {
    process.env.ZELLE_RECIPIENT = 'new-recipient@wavespestcontrol.com';
    const body = 'You can Zelle to old-recipient@wavespestcontrol.com, just add your name.';
    expect(outgoingZelleStale(body)).toEqual({ stale: true, reason: 'zelle_recipient_stale' });
  });

  test('Zelle disabled since draft (ZELLE_RECIPIENT unset) ⇒ stale', () => {
    delete process.env.ZELLE_RECIPIENT;
    const body = 'You can Zelle to payments@wavespestcontrol.com, just add your name.';
    expect(outgoingZelleStale(body)).toEqual({ stale: true, reason: 'zelle_recipient_stale' });
  });

  test('case-insensitive match (an email may round-trip differently cased)', () => {
    process.env.ZELLE_RECIPIENT = 'Payments@WavesPestControl.com';
    const body = 'Zelle to payments@wavespestcontrol.com works too.';
    expect(outgoingZelleStale(body)).toEqual({ stale: false });
  });

  test('phrasing other than "Zelle to X" is still checked (Zelle us at / our Zelle is)', () => {
    process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com';
    expect(outgoingZelleStale('Our Zelle is old@wavespestcontrol.com.')).toEqual({ stale: true, reason: 'zelle_recipient_stale' });
    expect(outgoingZelleStale('Zelle us at payments@wavespestcontrol.com anytime.')).toEqual({ stale: false });
  });

  test('phone recipients match by digits in any format; a different number is stale', () => {
    process.env.ZELLE_RECIPIENT = '941-555-0100';
    expect(outgoingZelleStale('Zelle us at (941) 555-0100.')).toEqual({ stale: false });
    expect(outgoingZelleStale('You can Zelle +1 941.555.0100')).toEqual({ stale: false });
    expect(outgoingZelleStale('Zelle us at (941) 555-0199.')).toEqual({ stale: true, reason: 'zelle_recipient_stale' });
  });

  test('a truthful NEGATIVE Zelle mention with no contact is not stale, whatever the config', () => {
    delete process.env.ZELLE_RECIPIENT;
    expect(outgoingZelleStale('We do not take Zelle right now, but your pay link takes card or bank.')).toEqual({ stale: false });
    process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com';
    expect(outgoingZelleStale("Sorry, we don't take Zelle anymore.")).toEqual({ stale: false });
  });

  // Independent-review P1 (round 3, PR #5331, finding 1): an AFFIRMATIVE
  // Zelle offer with NO specific contact ("Yes, you can use Zelle") still
  // needs the recipient-enabled check — the prior rule treated "no contact"
  // as safe outright, so this offer still sent after ZELLE_RECIPIENT was
  // disabled.
  describe('an AFFIRMATIVE Zelle mention with NO contact still runs the recipient-enabled check', () => {
    test('Zelle disabled (ZELLE_RECIPIENT unset) ⇒ stale', () => {
      delete process.env.ZELLE_RECIPIENT;
      expect(outgoingZelleStale('Yes, you can use Zelle for that.')).toEqual({ stale: true, reason: 'zelle_recipient_stale' });
    });

    test('Zelle currently enabled ⇒ not stale (nothing to compare a missing contact against)', () => {
      process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com';
      expect(outgoingZelleStale('Yes, you can use Zelle for that.')).toEqual({ stale: false });
    });
  });

  test('outgoingAmountsStale blocks on a stale Zelle contact even with no dollar amount in the body', async () => {
    process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com';
    const body = 'Sure, you can Zelle to a-different-address@example.com.';
    await expect(outgoingAmountsStale({ customerId: 'c1', body, dbh: dbWithCustomer({ id: 'c1' }) }))
      .resolves.toEqual({ stale: true, reason: 'zelle_recipient_stale' });
    // never even reaches the billing lookup
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  });
});

describe('zelleInvoiceStillEligible / outgoingAmountsStale — pre-push audit P1 (finding 2): a valid Zelle CONTACT is not enough, the INVOICE it was drafted for must still be eligible', () => {
  let priorZelle;
  beforeEach(() => {
    priorZelle = process.env.ZELLE_RECIPIENT;
    process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com';
  });
  afterEach(() => {
    if (priorZelle === undefined) delete process.env.ZELLE_RECIPIENT;
    else process.env.ZELLE_RECIPIENT = priorZelle;
  });

  test('no zelleInvoiceId (a human-typed Zelle body, or a caller that predates the snapshot) fails closed', async () => {
    await expect(zelleInvoiceStillEligible({ customerId: 'c1', zelleInvoiceId: null }))
      .resolves.toEqual({ eligible: false, reason: 'zelle_invoice_unresolved' });
    expect(payPageZelleVisibility).not.toHaveBeenCalled();
  });

  test('no customerId fails closed without a lookup', async () => {
    await expect(zelleInvoiceStillEligible({ customerId: null, zelleInvoiceId: 'inv-1' }))
      .resolves.toEqual({ eligible: false, reason: 'zelle_invoice_unresolved' });
    expect(payPageZelleVisibility).not.toHaveBeenCalled();
  });

  test('the invoice no longer resolves to this customer (paid off, reassigned, or never existed) fails closed', async () => {
    await expect(zelleInvoiceStillEligible({ customerId: 'c1', zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: undefined }) }))
      .resolves.toEqual({ eligible: false, reason: 'zelle_invoice_unresolved' });
    expect(payPageZelleVisibility).not.toHaveBeenCalled();
  });

  test('the invoice resolves but payPageZelleVisibility now says no (paid, saved-card charge, or a succeeded/processing PI since the draft)', async () => {
    const invoiceRow = { id: 'inv-1', customer_id: 'c1', status: 'paid' };
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason: 'not_eligible' });
    await expect(zelleInvoiceStillEligible({ customerId: 'c1', zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: invoiceRow }) }))
      .resolves.toEqual({ eligible: false, reason: 'zelle_invoice_ineligible' });
    expect(payPageZelleVisibility).toHaveBeenCalledWith({ invoice: invoiceRow, dbh: expect.any(Function), readOnly: true }); // read-only: a recheck never writes charge-claim state
  });

  // Codex round-14 P2: the visibility check's SPECIFIC reason survives, so the scheduler's
  // reviewer-facing mapping for it is reachable.
  test.each([
    ['payer_owned', 'payer_owned'],
    ['payer_unverifiable', 'payer_unverifiable'],
    ['credit_unverifiable', 'credit_unverifiable'],
    ['eligibility_unverifiable', 'zelle_recheck_failed'],
    ['not_eligible', 'zelle_invoice_ineligible'],
    ['credit_pending', 'zelle_invoice_ineligible'],
    ['invoice_not_found', 'zelle_invoice_ineligible'],
    ['not_configured', 'zelle_invoice_ineligible'],
    [undefined, 'zelle_invoice_ineligible'],
  ])('visibility reason %s => recheck reason %s (and the scheduler note for it is specific)', async (visibilityReason, expected) => {
    const invoiceRow = { id: 'inv-1', customer_id: 'c1', status: 'open' };
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason: visibilityReason });
    await expect(zelleInvoiceStillEligible({ customerId: 'c1', zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: invoiceRow }) }))
      .resolves.toEqual({ eligible: false, reason: expected });
    const { amountsStaleNote } = require('../services/scheduler');
    const generic = 'no longer accurate';
    if (expected !== 'zelle_invoice_ineligible') expect(amountsStaleNote(expected)).not.toMatch(generic);
  });

  test('the invoice resolves and is still eligible', async () => {
    const invoiceRow = { id: 'inv-1', customer_id: 'c1', status: 'open' };
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(zelleInvoiceStillEligible({ customerId: 'c1', zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: invoiceRow }) }))
      .resolves.toEqual({ eligible: true });
  });

  test('a lookup error fails closed rather than throwing', async () => {
    await expect(zelleInvoiceStillEligible({ customerId: 'c1', zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: new Error('db down') }) }))
      .resolves.toEqual({ eligible: false, reason: 'zelle_recheck_failed' });
  });

  // Independent-review P1 (round 2, PR #5331): a receipt can commit (and its
  // credit stay unapplied) between the draft's own fetchZelleEligibility
  // read and this send-time recheck — GET /:token refuses the whole pay
  // page for that case, and this recheck must too, before ever asking
  // pay-v2's own payPageZelleVisibility predicate.
  test('a pending deposit-settlement receipt blocks the send even when payPageZelleVisibility would say yes', async () => {
    const invoiceRow = { id: 'inv-1', customer_id: 'c1', status: 'open' };
    assertInvoiceDepositSettlementReady.mockRejectedValueOnce(
      Object.assign(new Error('A received deposit is awaiting invoice reconciliation'), { code: 'DEPOSIT_RECONCILIATION_REQUIRED' }),
    );
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(zelleInvoiceStillEligible({ customerId: 'c1', zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: invoiceRow }) }))
      .resolves.toEqual({ eligible: false, reason: 'zelle_invoice_ineligible' });
    expect(payPageZelleVisibility).not.toHaveBeenCalled();
  });

  test('an unexpected deposit-settlement read error fails closed too (never a throw)', async () => {
    const invoiceRow = { id: 'inv-1', customer_id: 'c1', status: 'open' };
    assertInvoiceDepositSettlementReady.mockRejectedValueOnce(new Error('db down'));
    await expect(zelleInvoiceStillEligible({ customerId: 'c1', zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: invoiceRow }) }))
      .resolves.toEqual({ eligible: false, reason: 'zelle_recheck_failed' });
  });

  test('outgoingAmountsStale: a body with no Zelle mention never triggers the invoice recheck', async () => {
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'See you Tuesday!', zelleInvoiceId: null, dbh: dbWithCustomer({ id: 'c1' }) }))
      .resolves.toEqual({ stale: false });
    expect(payPageZelleVisibility).not.toHaveBeenCalled();
  });

  test('outgoingAmountsStale: recipient still matches, but the snapshot carries no invoice id ⇒ blocked', async () => {
    const body = 'You can Zelle to payments@wavespestcontrol.com — just add your name.';
    await expect(outgoingAmountsStale({ customerId: 'c1', body, zelleInvoiceId: null, dbh: dbWithCustomer({ id: 'c1' }) }))
      .resolves.toEqual({ stale: true, reason: 'zelle_invoice_unresolved' });
  });

  test('outgoingAmountsStale: recipient matches AND the invoice is still eligible ⇒ not stale (no dollar amount in the body)', async () => {
    const body = 'You can Zelle to payments@wavespestcontrol.com — just add your name.';
    const invoiceRow = { id: 'inv-1', customer_id: 'c1', status: 'open' };
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body, zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: invoiceRow }),
    })).resolves.toEqual({ stale: false });
    // the amount branch is never reached — the Zelle body carries no dollar
    // figure — so the customers/billing lookup never runs.
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('outgoingAmountsStale: recipient matches but the invoice was paid off since the draft ⇒ blocked, billing never re-read for amounts', async () => {
    const body = 'You can Zelle to payments@wavespestcontrol.com — just add your name.';
    const invoiceRow = { id: 'inv-1', customer_id: 'c1', status: 'paid' };
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason: 'not_eligible' });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body, zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: invoiceRow }),
    })).resolves.toEqual({ stale: true, reason: 'zelle_invoice_ineligible' });
  });

  // Independent-review P1 (round 3, PR #5331, finding 1): an affirmative
  // offer with NO contact ("Yes, you can use Zelle") must ALSO run the
  // invoice-eligibility recheck — the prior gate ran only when the body
  // named a specific contact.
  test('outgoingAmountsStale: an affirmative Zelle mention with NO contact still runs the invoice-eligibility recheck', async () => {
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'Yes, you can use Zelle for that.', zelleInvoiceId: null, dbh: dbWithCustomer({ id: 'c1' }),
    })).resolves.toEqual({ stale: true, reason: 'zelle_invoice_unresolved' });

    const invoiceRow = { id: 'inv-1', customer_id: 'c1', status: 'open' };
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'Yes, you can use Zelle for that.', zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: invoiceRow }),
    })).resolves.toEqual({ stale: false });

    payPageZelleVisibility.mockResolvedValue({ visible: false, reason: 'not_eligible' });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'Yes, you can use Zelle for that.', zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: { ...invoiceRow, status: 'paid' } }),
    })).resolves.toEqual({ stale: true, reason: 'zelle_invoice_ineligible' });
  });
});

test('no amounts in the body → never stale, context never read', async () => {
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'See you Tuesday!', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: false });
  expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
});

test('an amount still owed passes; a paid-off balance no longer authorizes "your balance is $X"', async () => {
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 120.5, recentPayments: [] } });
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is $120.50.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: false });
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [{ amount: 120.5 }] } });
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is $120.50.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
});

test('payment history backs only an acknowledgement', async () => {
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [{ amount: 95 }] } });
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $95 payment — thank you!', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: false });
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Thanks for reaching out — your balance is $95.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toMatchObject({ stale: true });
});

test('fails closed: no customer id, a missing customer row, or a lookup error', async () => {
  await expect(outgoingAmountsStale({ customerId: null, body: 'You owe $5.', dbh: dbWithCustomer(null) })).resolves.toEqual({ stale: true, reason: 'amount_recheck_no_customer' });
  ContextAggregator.getContextForCustomer.mockResolvedValue(null);
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'You owe $5.', dbh: dbWithCustomer(null) })).resolves.toMatchObject({ stale: true });
  ContextAggregator.getContextForCustomer.mockRejectedValue(new Error('boom'));
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'You owe $5.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: true, reason: 'amount_recheck_failed' });
});


test('gate ON: price grammar with no numeric amount ("fifty dollars", "45/mo") is unverifiable → stale, billing never read', async () => {
  realAnswersGateOn.mockReturnValue(true);
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'The monthly fee is fifty dollars.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: true, reason: 'amount_unverifiable' });
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your plan is 45/mo.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: true, reason: 'amount_unverifiable' });
  expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
});

test('gate OFF: spelled amounts keep the original behavior (no amounts to check)', async () => {
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is fifty dollars.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: false });
});


test('a settled DECIMAL payment that cleared the balance still backs its acknowledgement ("$95.50 payment")', async () => {
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [{ amount: 95.5, status: 'paid' }] } });
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $95.50 payment — thank you!', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: false });
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Thank you for your payment of $95.50.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: false });
});

describe('Codex round 4 P1 (finding 3): the Zelle recheck resolves the customer\'s CURRENT open invoice when no drafted snapshot names one', () => {
  let priorZelle;
  beforeEach(() => {
    priorZelle = process.env.ZELLE_RECIPIENT;
    process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com';
  });
  afterEach(() => {
    if (priorZelle === undefined) delete process.env.ZELLE_RECIPIENT;
    else process.env.ZELLE_RECIPIENT = priorZelle;
  });

  test('no zelleInvoiceId passed: resolves the customer\'s open invoice via the context aggregator and checks IT', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { openInvoice: { id: 'inv-current' } } });
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'You can Zelle it to payments@wavespestcontrol.com.', zelleInvoiceId: null, dbh: dbWithTables({ customers: { id: 'c1' }, invoices: { id: 'inv-current', customer_id: 'c1' } }),
    })).resolves.toEqual({ stale: false });
    expect(ContextAggregator.getContextForCustomer).toHaveBeenCalled();
  });

  test('no zelleInvoiceId AND no current open invoice at all: fails closed', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { openInvoice: null } });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'You can Zelle it to payments@wavespestcontrol.com.', zelleInvoiceId: null, dbh: dbWithTables({ customers: { id: 'c1' } }),
    })).resolves.toEqual({ stale: true, reason: 'zelle_invoice_unresolved' });
  });

  test('a snapshot-provided zelleInvoiceId is used as-is — no fallback lookup', async () => {
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'You can Zelle it to payments@wavespestcontrol.com.', zelleInvoiceId: 'inv-drafted', dbh: dbWithTables({ invoices: { id: 'inv-drafted', customer_id: 'c1' } }),
    })).resolves.toEqual({ stale: false });
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  // trustOwedAmounts (the scheduler's "a human already reviewed this exact
  // figure" trust): excuses only an OWED clause, never a Zelle offer or a
  // receipt claim — both still assert a fact that can go stale.
  test('trustOwedAmounts still runs the Zelle recheck', async () => {
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason: 'not_eligible' });
    const invoiceRow = { id: 'inv-1', customer_id: 'c1', status: 'paid' };
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'You can Zelle it to payments@wavespestcontrol.com.', zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: invoiceRow }), trustOwedAmounts: true,
    })).resolves.toEqual({ stale: true, reason: 'zelle_invoice_ineligible' });
  });

  // Codex round-13 P1: a human-edited PRE-v12 reply no longer skips everything —
  // the clause-aware binder runs with trustOwedAmounts (owed clauses excused, receipts not).

  test('without trustOwedAmounts, the same ungrounded balance is still blocked (regression guard, pre-v12 pooled rule)', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [] } });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'Your balance is $9,999.00.', dbh: dbWithCustomer({ id: 'c1' }),
    })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });

  test('trustOwedAmounts (a human reviewed the figure) skips the OWED-figure half only - main\'s scheduler behavior', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [] } });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'Your balance is $9,999.00.', dbh: dbWithCustomer({ id: 'c1' }), trustOwedAmounts: true,
    })).resolves.toEqual({ stale: false });
  });
});

describe('Codex round-6 pre-push audit P1: negation is scoped to the Zelle offer itself', () => {
  const saved = process.env.ZELLE_RECIPIENT;
  afterEach(() => { if (saved === undefined) delete process.env.ZELLE_RECIPIENT; else process.env.ZELLE_RECIPIENT = saved; });

  test('"You don\'t need a card to use Zelle to old@example.com." is still an offer and is stale when Zelle is disabled', () => {
    delete process.env.ZELLE_RECIPIENT;
    const body = "You don't need a card to use Zelle to old@example.com.";
    expect(classifyZelleClause(body)).toBe('offer');
    expect(hasAffirmativeZelleMention(body)).toBe(true);
    expect(outgoingZelleStale(body)).toEqual({ stale: true, reason: 'zelle_recipient_stale' });
  });

  test('...and stale when the contact is not the CURRENT recipient; fine when it is', () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    expect(outgoingZelleStale("You don't need a card to use Zelle to old@example.com.")).toEqual({ stale: true, reason: 'zelle_recipient_stale' });
    expect(outgoingZelleStale("You don't need a card to use Zelle to pay@example.com.")).toEqual({ stale: false });
  });

  test('a contact makes even a negator-bearing clause an offer ("we don\'t take Zelle at old@example.com")', () => {
    expect(classifyZelleClause("Sorry, we don't take Zelle at old@example.com")).toBe('offer');
  });

  test('a contact-free affirmative clause with an unrelated negator is still an offer', () => {
    expect(classifyZelleClause("You don't need a card to use Zelle.")).toBe('offer');
    expect(classifyZelleClause("Don't worry, you can use Zelle.")).toBe('offer');
  });

  test('genuinely negated Zelle offers are NOT offers', () => {
    for (const c of [
      "We don't accept Zelle.", "Sorry, we don't take Zelle anymore.", "Zelle isn't available right now.",
      "We can't use Zelle at the moment.", 'We no longer accept payments by Zelle.', "We've stopped taking Zelle.",
      'Zelle is not currently supported.', "we don't accept payments via Zelle",
    ]) {
      expect(classifyZelleClause(c)).toBeNull();
      expect(hasAffirmativeZelleMention(c)).toBe(false);
    }
  });
});

describe('negative Zelle availability claims are revalidated before sending', () => {
  const { hasNegativeZelleAvailabilityClaim, zelleDenialStale, bodyNeedsPaymentRecheck } = require('../services/sms-amount-recheck');
  let priorZelle;
  beforeEach(() => { priorZelle = process.env.ZELLE_RECIPIENT; });
  afterEach(() => { if (priorZelle === undefined) delete process.env.ZELLE_RECIPIENT; else process.env.ZELLE_RECIPIENT = priorZelle; });
  const dbh = dbWithTables({ customers: { id: 'c1' }, invoices: { id: 'inv-1', customer_id: 'c1', status: 'open' } });
  const DENIALS = ["Zelle isn't available right now.", "We don't take Zelle.", 'Zelle is not available for this account right now, so use your pay link.'];

  test('detected as denials (not offers); the scheduler prescreen sends them to the recheck', () => {
    for (const d of DENIALS) {
      expect({ d, neg: hasNegativeZelleAvailabilityClaim(d), aff: hasAffirmativeZelleMention(d), screen: bodyNeedsPaymentRecheck(d) }).toEqual({ d, neg: true, aff: false, screen: true });
    }
    expect(hasNegativeZelleAvailabilityClaim('You can Zelle us at pay@example.com')).toBe(false);
    expect(hasNegativeZelleAvailabilityClaim('Thanks, see you Tuesday!')).toBe(false);
  });

  test('Zelle now visible for the open invoice => the denial is STALE (zelle_now_available)', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { openInvoice: { id: 'inv-1' } } });
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(zelleDenialStale({ customerId: 'c1', dbh })).resolves.toEqual({ stale: true, reason: 'zelle_now_available' });
    for (const d of DENIALS) {
      await expect(outgoingAmountsStale({ customerId: 'c1', body: d, promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual({ stale: true, reason: 'zelle_now_available' });
    }
  });

  test('still unavailable => the denial stands: no recipient configured, no open invoice, or the invoice is ineligible', async () => {
    delete process.env.ZELLE_RECIPIENT;
    await expect(zelleDenialStale({ customerId: 'c1', dbh })).resolves.toEqual({ stale: false });
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { openInvoice: null } });
    await expect(zelleDenialStale({ customerId: 'c1', dbh })).resolves.toEqual({ stale: false });
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { openInvoice: { id: 'inv-1' } } });
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason: 'not_eligible' });
    await expect(zelleDenialStale({ customerId: 'c1', dbh })).resolves.toEqual({ stale: false });
    await expect(outgoingAmountsStale({ customerId: 'c1', body: "Zelle isn't available for this account right now.", promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual({ stale: false });
  });

  // Codex round-38 P2 class: a denial is only true when EXPLICITLY scoped to this account / invoice; a general or business-wide
  // denial is false while a recipient is configured, whatever the invoice state.
  test('a business-wide / unscoped denial is stale while a recipient is configured, even with no open invoice or an ineligible one', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    for (const ctx of [{ openInvoice: null }, { openInvoice: { id: 'inv-1' } }]) {
      ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: ctx });
      payPageZelleVisibility.mockResolvedValue({ visible: false, reason: 'not_eligible' });
      for (const body of ["We don't accept Zelle.", "We don't take Zelle for payments.", "Zelle isn't available right now.", 'We no longer offer Zelle.']) {
        await expect({ body, r: await zelleDenialStale({ customerId: 'c1', dbh, body }) }).toEqual({ body, r: { stale: true, reason: 'zelle_now_available' } });
        await expect(outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual({ stale: true, reason: 'zelle_now_available' });
      }
    }
  });
  test('an explicitly account- or invoice-scoped denial still stands when no invoice is open / the invoice is ineligible', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { openInvoice: null } });
    for (const body of ["Zelle isn't available for this account right now.", "We can't take Zelle for your invoice.", "Zelle isn't available for invoice WPC-2026-0002."]) {
      await expect({ body, r: await zelleDenialStale({ customerId: 'c1', dbh, body }) }).toEqual({ body, r: { stale: false } });
    }
  });
  test('with no recipient configured an unscoped denial is true (nothing to accept)', async () => {
    delete process.env.ZELLE_RECIPIENT;
    await expect(zelleDenialStale({ customerId: 'c1', dbh, body: "We don't accept Zelle." })).resolves.toEqual({ stale: false });
  });

  // Codex round-21 P2: an UNVERIFIABLE Zelle state is not a confirmed "ineligible" — the denial can't be confirmed.
  test.each([['payer_unverifiable', true], ['credit_unverifiable', true], ['eligibility_unverifiable', true], ['payer_owned', false], ['not_eligible', false], ['credit_pending', false]])(
    'visibility reason %s: denial stale=%s', async (reason, stale) => {
      process.env.ZELLE_RECIPIENT = 'pay@example.com';
      ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { openInvoice: { id: 'inv-1' } } });
      payPageZelleVisibility.mockResolvedValue({ visible: false, reason });
      const out = await zelleDenialStale({ customerId: 'c1', dbh });
      if (stale) {
        expect(out.stale).toBe(true);
        expect(out.reason).toMatch(/^(?:payer_unverifiable|credit_unverifiable|zelle_recheck_failed)$/);
      } else {
        expect(out).toEqual({ stale: false });
      }
    },
  );

  test('an unverifiable check fails CLOSED (blocks the send)', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    ContextAggregator.getContextForCustomer.mockRejectedValue(new Error('db down'));
    await expect(zelleDenialStale({ customerId: 'c1', dbh })).resolves.toEqual({ stale: true, reason: 'zelle_recheck_failed' });
    await expect(zelleDenialStale({ customerId: null, dbh })).resolves.toEqual({ stale: true, reason: 'zelle_recheck_failed' });
  });
});

// Codex round-19 P1: the send-time recheck validates the invoice the customer NAMED when several are open.
describe('several open invoices: the send-time Zelle recheck resolves the same invoice as the draft', () => {
  const { zelleDenialStale } = require('../services/sms-amount-recheck');
  let priorZelle;
  beforeEach(() => { priorZelle = process.env.ZELLE_RECIPIENT; process.env.ZELLE_RECIPIENT = 'pay@example.com'; });
  afterEach(() => { if (priorZelle === undefined) delete process.env.ZELLE_RECIPIENT; else process.env.ZELLE_RECIPIENT = priorZelle; });
  const open = [
    { id: 'inv-3', invoiceNumber: 'WPC-2026-0303', status: 'sent', amountDue: 95 },
    { id: 'inv-1', invoiceNumber: 'WPC-2026-0101', status: 'overdue', amountDue: 210 },
  ];
  const dbh = dbWithTables({ customers: { id: 'c1' }, invoices: { id: 'x', customer_id: 'c1', status: 'open' } });
  const ctxWith = (list) => ({ billing: { openInvoice: list[0], openInvoices: list } });
  const BODY = 'You can Zelle to pay@example.com.';

  test('a human-typed Zelle offer (no persisted id): the invoice the inbound names is rechecked, not the newest', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctxWith(open));
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(outgoingAmountsStale({ customerId: 'c1', body: BODY, dbh, inboundMessage: 'Can I pay invoice WPC-2026-0101 by Zelle?' })).resolves.toEqual({ stale: false });
    expect(payPageZelleVisibility).toHaveBeenCalledWith({ invoice: expect.objectContaining({ id: 'x' }), dbh: expect.any(Function), readOnly: true });
  });
  test('several open and no reference: the offer cannot be tied to one invoice => blocked (unresolved)', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctxWith(open));
    await expect(outgoingAmountsStale({ customerId: 'c1', body: BODY, dbh, inboundMessage: 'Can I pay by Zelle?' })).resolves.toEqual({ stale: true, reason: 'zelle_invoice_unresolved' });
    expect(payPageZelleVisibility).not.toHaveBeenCalled();
  });
  test('a persisted invoice id (from the decision) is used as-is', async () => {
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(outgoingAmountsStale({ customerId: 'c1', body: BODY, dbh, zelleInvoiceId: 'inv-1', inboundMessage: 'Can I pay by Zelle?' })).resolves.toEqual({ stale: false });
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  });
  test('a Zelle DENIAL: unresolvable with several open => UNVERIFIABLE, blocked (the draft asks which invoice); named invoice now eligible => stale', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctxWith(open));
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(zelleDenialStale({ customerId: 'c1', dbh, inboundMessage: 'Can I pay by Zelle?' })).resolves.toEqual({ stale: true, reason: 'zelle_target_ambiguous' });
    await expect(outgoingAmountsStale({ customerId: 'c1', body: "Zelle isn't available for your invoice.", dbh, inboundMessage: 'Can I pay by Zelle?' })).resolves.toEqual({ stale: true, reason: 'zelle_target_ambiguous' });
    // an ambiguous reference (two invoices share the amount) is unverifiable too; a named invoice that is not open too
    await expect(zelleDenialStale({ customerId: 'c1', dbh, inboundMessage: 'Can I Zelle invoice WPC-2026-0999?' })).resolves.toEqual({ stale: true, reason: 'zelle_target_ambiguous' });
    // nothing open at all: there is nothing to pay by Zelle, the denial stands
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctxWith([]));
    await expect(zelleDenialStale({ customerId: 'c1', dbh, inboundMessage: 'Can I pay by Zelle?' })).resolves.toEqual({ stale: false });
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctxWith(open));
    await expect(zelleDenialStale({ customerId: 'c1', dbh, inboundMessage: 'Can I Zelle invoice WPC-2026-0101?' })).resolves.toEqual({ stale: true, reason: 'zelle_now_available' });
  });
});

// Codex round-30 P2: subject-first MODAL denials are negative availability claims, not offers.
describe('subject-first modal Zelle denials (round 30)', () => {
  const { hasNegativeZelleAvailabilityClaim, bodyNeedsPaymentRecheck } = require('../services/sms-amount-recheck');
  const DENIALS = [
    'Zelle cannot be used for this.', "Zelle can't be used right now.", "Zelle won't be available this week.", 'Zelle could not be offered.', 'Zelle will not be accepted.',
    "Zelle wouldn't be an option.", 'Zelle payments cannot be taken.', 'Zelle may not be available.', "Zelle couldn't be processed.",
  ];
  test.each(DENIALS)('%s => negative availability claim, not an offer, sent to the recheck', (body) => {
    expect({ body, neg: hasNegativeZelleAvailabilityClaim(body), aff: hasAffirmativeZelleMention(body), screen: bodyNeedsPaymentRecheck(body) }).toEqual({ body, neg: true, aff: false, screen: true });
  });
  test('genuine offers are unchanged', () => {
    for (const body of ['You can use Zelle.', 'Zelle can be used for this.', 'Zelle works great for that.', 'We take Zelle.']) {
      expect({ body, neg: hasNegativeZelleAvailabilityClaim(body) }).toEqual({ body, neg: false });
    }
  });
});

// Codex round-33 P2: plain copular denials are denials (checked before the offer rule), never offers.
describe('copular Zelle denials classify as denials, not offers', () => {
  const { hasAffirmativeZelleMention, hasNegativeZelleAvailabilityClaim, classifyZelleClause } = require('../services/sms-amount-recheck');
  test.each([
    'We are not accepting Zelle.', "We aren't taking Zelle.", "We're not accepting Zelle right now.", 'Zelle is not an option.', "Zelle isn't an option.",
    "We're not set up for Zelle.", 'We take card, not Zelle.', 'We are not currently taking Zelle payments.',
  ])('%s', (t) => {
    expect(hasNegativeZelleAvailabilityClaim(t)).toBe(true);
    expect(hasAffirmativeZelleMention(t)).toBe(false);
    expect(classifyZelleClause(t)).toBeNull();
  });
  test.each([
    'You can use Zelle.', 'We accept Zelle.', 'Do not hesitate to Zelle us.', 'Not only can you use Zelle, you can also pay by card.',
    "We aren't accepting Zelle at pay@example.com.", // a transfer contact is always a live instruction
  ])('an offer stays an offer: %s', (t) => {
    expect(hasAffirmativeZelleMention(t)).toBe(true);
  });
});


// ---------------------------------------------------------------------------------------------------------------------
// PAYMENT STATUS at send time (PR #5331, owner ruling 2026-10-01). The decision's payment_status_snapshot names the sentences
// the draft copied; they are the only authorized status wording, and each must STILL be rendered from the records.
// ---------------------------------------------------------------------------------------------------------------------
describe('paymentStatusSendBlockReason - the send-time half of the fixed-sentence contract', () => {
  const RECEIVED = 'We received your $120.00 card payment on Sep 12, 2026.';
  const NO_BALANCE = 'Your account has no balance due.';
  const SNAP = { customer_id: 'c1', sentences: [RECEIVED] };
  const paidCtx = (over = {}) => ({ billing: { outstandingBalance: 0, hasProcessingPayment: false, recentPayments: [{ id: 'p1', amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' }], recentPaymentsTruncated: false, ...over } });
  const run = (body, extra = {}) => paymentStatusSendBlockReason({ customerId: 'c1', body, snapshot: SNAP, dbh: dbWithCustomer({ id: 'c1' }), ...extra });

  test('a verbatim copy of a snapshotted sentence that the records STILL render goes out', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(paidCtx());
    await expect(run(RECEIVED)).resolves.toBeNull();
    await expect(run(`Hi Jane, ${RECEIVED} A teammate will follow up within the hour.`)).resolves.toBeNull();
  });

  test('stale-at-send: the row was refunded / reversed / re-dated since the draft => payment_status_changed', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(paidCtx({ recentPayments: [{ id: 'p1', amount: 120, status: 'refunded', refund_status: 'full', refund_amount: 120, payment_date: '2026-09-12', payment_method_type: 'card' }] }));
    await expect(run(RECEIVED)).resolves.toBe('payment_status_changed');
    ContextAggregator.getContextForCustomer.mockResolvedValue(paidCtx({ recentPayments: [{ id: 'p1', amount: 120, status: 'paid', payment_date: '2026-09-13', payment_method_type: 'card' }] }));
    await expect(run(RECEIVED)).resolves.toBe('payment_status_changed');
  });

  test('a paraphrase, an edited sentence or a status typed in by hand is unauthorized - no billing read needed', async () => {
    for (const body of [
      'We got your $120.00 card payment on Sep 12, 2026.',
      'We received your $120.00 card payment on Sep 12, 2026!',
      'We received your $125.00 card payment on Sep 12, 2026.',
      "You're all paid up.",
      `${RECEIVED} It will post tomorrow.`,
      'We received your $120.00 card payment on Sep 12, 2026, but it was refunded.',
    ]) {
      expect({ body, r: await run(body) }).toEqual({ body, r: 'payment_status_unauthorized' });
    }
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('a sentence that was never snapshotted is unauthorized even if it is rendered right now', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(paidCtx());
    await expect(run(NO_BALANCE)).resolves.toBe('payment_status_unauthorized');
    await expect(paymentStatusSendBlockReason({ customerId: 'c1', body: NO_BALANCE, snapshot: null, dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toBe('payment_status_unauthorized');
  });

  test('a body that states no status and copies nothing needs no billing read at all', async () => {
    await expect(run('Sounds good, see you Tuesday! You can pay online with your pay link.')).resolves.toBeNull();
    await expect(paymentStatusSendBlockReason({ customerId: null, body: 'Here is your pay link.', snapshot: null })).resolves.toBeNull();
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('the customer\'s inbound scopes the detector: a bare pronoun clause is a status only in a payment conversation', async () => {
    await expect(run('It settled.', { snapshot: null, inboundMessage: 'Did my payment go through?' })).resolves.toBe('payment_status_unauthorized');
    await expect(run('It settled.', { snapshot: null, inboundMessage: 'What time is my visit Tuesday?' })).resolves.toBeNull();
  });

  test('fail closed: no customer, another customer\'s snapshot, no customer row, or a lookup error', async () => {
    await expect(paymentStatusSendBlockReason({ customerId: null, body: RECEIVED, snapshot: SNAP })).resolves.toBe('payment_status_recheck_no_customer');
    await expect(paymentStatusSendBlockReason({ customerId: 'c2', body: RECEIVED, snapshot: SNAP, dbh: dbWithCustomer({ id: 'c2' }) })).resolves.toBe('payment_status_changed');
    await expect(run(RECEIVED, { dbh: dbWithCustomer(null) })).resolves.toBe('payment_status_recheck_failed');
    ContextAggregator.getContextForCustomer.mockRejectedValue(new Error('boom'));
    await expect(run(RECEIVED)).resolves.toBe('payment_status_recheck_failed');
  });

  test('billing that is unavailable renders nothing, so every copied sentence is stale', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { unavailable: true } });
    await expect(run(RECEIVED)).resolves.toBe('payment_status_changed');
  });
});

describe('outgoingAmountsStale - real-answers (strict) decisions run the status contract; the rest is main\'s', () => {
  const RECEIVED = 'We received your $120.00 card payment on Sep 12, 2026.';
  const SNAP = { customer_id: 'c1', sentences: [RECEIVED] };
  const ctxWith = (over = {}) => ({ billing: { outstandingBalance: 95, openInvoice: { amountDue: 95 }, hasProcessingPayment: false, recentPayments: [{ id: 'p1', amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' }], ...over } });
  const args = (body, over = {}) => ({ customerId: 'c1', body, promptVersion: V12, paymentStatusSnapshot: SNAP, dbh: dbWithCustomer({ id: 'c1' }), ...over });

  test('a copied sentence\'s own figure is not judged against the owed figures (it was just re-rendered); a stray paid figure is', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctxWith());
    await expect(outgoingAmountsStale(args(`${RECEIVED} Your balance is $95.00.`))).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' }); // "balance" is a status word: copy the sentence or hand off
    await expect(outgoingAmountsStale(args(`${RECEIVED} You can pay the $95.00 invoice with your pay link.`))).resolves.toEqual({ stale: false }); // an OWED figure in an owed clause
    await expect(outgoingAmountsStale(args(`${RECEIVED} You can pay the $120.00 invoice with your pay link.`))).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });

  test('stale sentence => the status reason comes back before any amount rule', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctxWith({ recentPayments: [] }));
    await expect(outgoingAmountsStale(args(RECEIVED))).resolves.toEqual({ stale: true, reason: 'payment_status_changed' });
  });

  test('an unsanctioned status on a real-answers decision is held even with no figure and no customer lookup', async () => {
    await expect(outgoingAmountsStale(args("You're paid up!", { paymentStatusSnapshot: null }))).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('the live gate decides when the decision carries no prompt version', async () => {
    realAnswersGateOn.mockReturnValue(true);
    await expect(outgoingAmountsStale(args("You're paid up!", { promptVersion: null, paymentStatusSnapshot: null }))).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
  });

  test('gate-off / pre-v12 identity: no status check, main\'s pooled amount rule', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctxWith());
    await expect(outgoingAmountsStale(args("You're paid up!", { promptVersion: 'house_voice_v11', paymentStatusSnapshot: null }))).resolves.toEqual({ stale: false });
    await expect(outgoingAmountsStale(args('We received your $120 payment — thank you!', { promptVersion: 'house_voice_v11', paymentStatusSnapshot: null }))).resolves.toEqual({ stale: false }); // pooled: a paid figure backs an ack
    await expect(outgoingAmountsStale(args('Your balance is $9,999.00.', { promptVersion: 'house_voice_v11', paymentStatusSnapshot: null }))).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });

  test('trustOwedAmounts (a reviewed edit) skips the owed-figure rule but never the status contract or the Zelle recheck', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctxWith());
    await expect(outgoingAmountsStale(args('You can pay the $9,999.00 invoice with your pay link.', { trustOwedAmounts: true }))).resolves.toEqual({ stale: false });
    await expect(outgoingAmountsStale(args("You're paid up!", { trustOwedAmounts: true, paymentStatusSnapshot: null }))).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
  });

  test('price grammar the extractor cannot verify stays unverifiable on a strict decision', async () => {
    await expect(outgoingAmountsStale(args('The fee is fifty dollars.', { paymentStatusSnapshot: null }))).resolves.toEqual({ stale: true, reason: 'amount_unverifiable' });
  });
});

describe('bodyNeedsPaymentRecheck - the read-free pre-screen', () => {
  test.each(['You owe $5.', "You're paid up.", 'We received your $120.00 card payment on Sep 12, 2026.', 'You can Zelle us.', "Zelle isn't available right now.", 'Your balance is fifty dollars.'])('selects: %s', (body) => {
    expect(bodyNeedsPaymentRecheck(body)).toBe(true);
  });
  test.each(['Sounds good, see you Tuesday!', 'Your invoice is attached.', 'Here is your pay link.', 'You can pay by card or bank account through your pay link.', ''])('leaves alone: %s', (body) => {
    expect(bodyNeedsPaymentRecheck(body)).toBe(false);
  });
  test('the customer\'s message scopes a bare pronoun clause', () => {
    expect(bodyNeedsPaymentRecheck('It settled.')).toBe(true); // unknown inbound reads as payment-scoped
    expect(bodyNeedsPaymentRecheck('It settled.', { inboundMessage: 'Did my payment go through?' })).toBe(true);
    expect(bodyNeedsPaymentRecheck('It settled.', { inboundMessage: 'What time is my visit?' })).toBe(false);
  });
});
