/**
 * sms-amount-recheck - the send-time revalidation shared by the scheduler's fire-time path and the immediate Agent Review send
 * (PR #5119 follow-up #2), plus (PR #5331) the MONEY-SENTENCE contract at send time (owner 2026-10-01 ~23:58Z: an unedited AI body states
 * a payment status, a dollar figure or anything about Zelle only as a verbatim copy of a rendered sentence, re-rendered from live data),
 * the live Zelle facts, and the staff-edit Zelle-contact recheck: fresh context, current obligations only, fail closed on any error.
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
  outgoingAmountsStale, bodyAmountCents, outgoingZelleStale, zelleBodyContacts, zelleInvoiceStillEligible, liveZelleFacts,
  paymentStatusSendBlockReason, paymentStatusVerdict, bodyNeedsPaymentRecheck, bodyNeedsBillingBoundaryCheck,
} = require('../services/sms-amount-recheck');

const V12 = 'house_voice_v12_real_answers5_cfl_p';

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
    expect(zelleBodyContacts('We received your Zelle payment. Use old-recipient@wavespestcontrol.com for the rest.')).toHaveLength(1);
    expect(outgoingZelleStale('We received your Zelle payment. Use old-recipient@wavespestcontrol.com for the rest.')).toEqual(stale);
    expect(outgoingZelleStale('We received your Zelle payment. Send the rest to (941) 555-1234.')).toEqual(stale);
    // the current recipient still passes; and with no recipient configured the instruction is stale
    expect(outgoingZelleStale('We received your Zelle payment. Use new-recipient@wavespestcontrol.com for the rest.')).toEqual({ stale: false });
    delete process.env.ZELLE_RECIPIENT;
    expect(outgoingZelleStale('We received your Zelle payment. Use pay@example.com for the rest.')).toEqual(stale);
  });

  // PR #5331: there is no offer / denial grammar any more - a body is judged by its CONTACTS only (the AI's own Zelle prose is held by the
  // contract before it gets here; a staff member's contact-free Zelle words are theirs).
  test('no over-trigger: a body with no Zelle word has no contacts, whatever else it names; a Zelle mention with no contact has nothing to compare', () => {
    process.env.ZELLE_RECIPIENT = 'new-recipient@wavespestcontrol.com';
    for (const body of [
      "We don't take Zelle. Pay online at the portal.",
      'Thanks! Send the rest through the invoice page.',
      'Email billing@wavespestcontrol.com with questions.', // a contact, but no Zelle word
    ]) expect({ body, r: outgoingZelleStale(body) }).toEqual({ body, r: { stale: false } });
    expect(zelleBodyContacts('Email billing@wavespestcontrol.com with questions.')).toEqual([]);
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

  // (owner 2026-10-01: a contact-free Zelle mention is no instruction to check; the recipient, the invoice and the wording of an AI Zelle
  // sentence are all pinned by re-rendering it - paymentStatusVerdict below)
  test('a Zelle mention with NO contact is never stale here, whether Zelle is configured or not', () => {
    delete process.env.ZELLE_RECIPIENT;
    expect(outgoingZelleStale('Yes, you can use Zelle for that.')).toEqual({ stale: false });
    process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com';
    expect(outgoingZelleStale('Yes, you can use Zelle for that.')).toEqual({ stale: false });
  });

  test('a receipt-shaped Zelle clause that names a contact is judged on that contact like any other (fail closed)', () => {
    process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com';
    expect(outgoingZelleStale('We received your $120 Zelle payment at old@wavespestcontrol.com.')).toEqual({ stale: true, reason: 'zelle_recipient_stale' });
    expect(zelleBodyContacts('We received your $120 Zelle payment from Sep 12.')).toEqual([]);
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
  // credit stay unapplied) between the draft's own liveZelleFacts
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

  test('outgoingAmountsStale: recipient still matches, but the decision carries no target invoice id ⇒ blocked (a staff Zelle contact needs a live invoice)', async () => {
    const body = 'You can Zelle to payments@wavespestcontrol.com — just add your name.';
    await expect(outgoingAmountsStale({ customerId: 'c1', body, zelleInvoiceId: null, dbh: dbWithCustomer({ id: 'c1' }) }))
      .resolves.toEqual({ stale: true, reason: 'zelle_invoice_ineligible' });
  });

  test('outgoingAmountsStale: recipient matches AND the invoice is still eligible ⇒ not stale (no dollar amount in the body)', async () => {
    const body = 'You can Zelle to payments@wavespestcontrol.com — just add your name.';
    const invoiceRow = { id: 'inv-1', customer_id: 'c1', status: 'open', invoice_number: 'WPC-2026-0001' };
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body, zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: invoiceRow }),
    })).resolves.toEqual({ stale: false, zelle: { state: 'offer', invoiceId: 'inv-1', invoiceNumber: 'WPC-2026-0001', recipient: 'payments@wavespestcontrol.com' } });
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

  test('outgoingAmountsStale: a staff Zelle mention with NO contact is the staff member\'s own wording - passes with no invoice check', async () => {
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'Yes, you can use Zelle for that.', zelleInvoiceId: null, dbh: dbWithCustomer({ id: 'c1' }),
    })).resolves.toEqual({ stale: false });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'Yes, you can use Zelle for that.', zelleInvoiceId: 'inv-1', dbh: dbWithTables({ invoices: { id: 'inv-1', customer_id: 'c1', status: 'paid' } }),
    })).resolves.toEqual({ stale: false });
    expect(payPageZelleVisibility).not.toHaveBeenCalled();
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


test('gate ON: price grammar with no numeric amount ("fifty dollars", "45/mo") is money content outside a copied sentence → unauthorized, billing never read', async () => {
  realAnswersGateOn.mockReturnValue(true);
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'The monthly fee is fifty dollars.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your plan is 45/mo.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
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

describe('staff-edited / pre-v12 bodies: the Zelle recheck is about the invoice the body names, else the decision\'s target, else the resolved one', () => {
  let priorZelle;
  beforeEach(() => {
    priorZelle = process.env.ZELLE_RECIPIENT;
    process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com';
  });
  afterEach(() => {
    if (priorZelle === undefined) delete process.env.ZELLE_RECIPIENT;
    else process.env.ZELLE_RECIPIENT = priorZelle;
  });

  test('no target invoice on the decision: the customer\'s one open invoice is resolved (same resolver as the draft) and checked', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { openInvoice: { id: 'inv-current' } } });
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'You can Zelle it to payments@wavespestcontrol.com.', zelleInvoiceId: null, dbh: dbWithTables({ customers: { id: 'c1' }, invoices: { id: 'inv-current', customer_id: 'c1', invoice_number: 'WPC-2026-0009' } }), trustOwedAmounts: true,
    })).resolves.toMatchObject({ stale: false, zelle: { invoiceId: 'inv-current' } });
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason: 'not_eligible' });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'You can Zelle it to payments@wavespestcontrol.com.', zelleInvoiceId: null, dbh: dbWithTables({ customers: { id: 'c1' }, invoices: { id: 'inv-current', customer_id: 'c1' } }), trustOwedAmounts: true,
    })).resolves.toEqual({ stale: true, reason: 'zelle_invoice_ineligible' });
  });

  test('a decision-provided zelleInvoiceId is used as-is — no fallback lookup — and the live facts ride back', async () => {
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'You can Zelle it to payments@wavespestcontrol.com.', zelleInvoiceId: 'inv-drafted',
      dbh: dbWithTables({ invoices: { id: 'inv-drafted', customer_id: 'c1', invoice_number: 'WPC-2026-0007' } }),
    })).resolves.toEqual({ stale: false, zelle: { state: 'offer', invoiceId: 'inv-drafted', invoiceNumber: 'WPC-2026-0007', recipient: 'payments@wavespestcontrol.com' } });
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

  test('a copied sentence\'s own figure is not judged against the owed figures (it was just re-rendered); any figure outside a copy is held', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctxWith());
    await expect(outgoingAmountsStale(args(`${RECEIVED} Your balance is $95.00.`))).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' }); // "balance" is a status word: copy the sentence or hand off
    // PR #5331 (widened): an owed figure typed in the AI's own words is money content too - only a RENDERED sentence may state one
    await expect(outgoingAmountsStale(args(`${RECEIVED} You can pay the $95.00 invoice with your pay link.`))).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
    await expect(outgoingAmountsStale(args(`${RECEIVED} You can pay the $120.00 invoice with your pay link.`))).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
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

  test('trustOwedAmounts (a reviewed edit) skips the owed-figure rule of the staff / pre-v12 path - never the contract on an UNEDITED real-answers body', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctxWith());
    await expect(outgoingAmountsStale(args('You can pay the $9,999.00 invoice with your pay link.', { trustOwedAmounts: true, humanEditedBody: true }))).resolves.toEqual({ stale: false });
    await expect(outgoingAmountsStale(args('You can pay the $9,999.00 invoice with your pay link.', { trustOwedAmounts: true }))).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
    await expect(outgoingAmountsStale(args("You're paid up!", { trustOwedAmounts: true, paymentStatusSnapshot: null }))).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
  });

  test('price grammar the extractor cannot verify is money content outside a copy on a strict decision: unauthorized', async () => {
    await expect(outgoingAmountsStale(args('The fee is fifty dollars.', { paymentStatusSnapshot: null }))).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
    await expect(outgoingAmountsStale(args('Your plan is 45/mo.', { paymentStatusSnapshot: null }))).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
  });
});

describe('bodyNeedsPaymentRecheck - the read-free pre-screen', () => {
  beforeEach(() => { realAnswersGateOn.mockReturnValue(true); });
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
  // P2-4 (independent review): the status-vocabulary trigger is a real-answers feature. Gate off, the pre-screen is main's: the same
  // body that selects above is left alone, so a gate-off row costs no agent_decisions read and cannot be blocked by a read failure.
  test('gate off (and no v12 decision): the status vocabulary selects nothing; amounts and Zelle still do', () => {
    realAnswersGateOn.mockReturnValue(false);
    for (const body of ["You're paid up.", 'It settled.', 'We received your payment on Sep 12, 2026.', 'Your invoice is overdue.']) {
      expect({ body, r: bodyNeedsPaymentRecheck(body) }).toEqual({ body, r: false });
    }
    for (const body of ['You owe $5.', 'You can Zelle us.', "Zelle isn't available right now.", 'Your balance is fifty dollars.']) {
      expect({ body, r: bodyNeedsPaymentRecheck(body) }).toEqual({ body, r: true });
    }
  });
  test('a v12 decision selects on the status vocabulary even when the live gate is off (a card outliving a rollback)', () => {
    realAnswersGateOn.mockReturnValue(false);
    expect(bodyNeedsPaymentRecheck("You're paid up.", { promptVersion: V12 })).toBe(true);
    expect(bodyNeedsPaymentRecheck("You're paid up.", { promptVersion: 'house_voice_v11' })).toBe(false);
    realAnswersGateOn.mockReturnValue(true);
    expect(bodyNeedsPaymentRecheck("You're paid up.", { promptVersion: 'house_voice_v11' })).toBe(false); // the decision's own version wins
  });
});


// Codex round-45 P1 (PR #5331, widened): on an ACTIVE PAYMENT PLAN no invoice total is stated by a rendered sentence (the renderer
// withholds it), so an unedited real-answers body can never carry one; the pooled (staff / pre-v12) owed rule is main's, unchanged.
describe('send-time: an active payment plan states no invoice total', () => {
  const dbh = dbWithTables({ customers: { id: 'c1' } });
  const planBilling = (over = {}) => ({ outstandingBalance: 300, openInvoice: { id: 'i1', amountDue: 300 }, hasActivePaymentPlan: true, ...over });
  test('v12: "The total is $300.00." is held as unauthorized (on a plan or off one - only a rendered sentence may state a figure)', async () => {
    for (const hasActivePaymentPlan of [true, false]) {
      ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: planBilling({ hasActivePaymentPlan }) });
      await expect(outgoingAmountsStale({ customerId: 'c1', body: 'The total is $300.00.', promptVersion: V12, dbh, inboundMessage: 'How much?' })).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
    }
  });
  test('a copied balance sentence is stale once a plan starts (the renderer withholds every balance / due figure on a plan)', async () => {
    const BAL = 'Your account balance is $300.00.';
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 300, hasProcessingPayment: false, recentPayments: [] } });
    await expect(outgoingAmountsStale({ customerId: 'c1', body: BAL, promptVersion: V12, dbh, paymentStatusSnapshot: { customer_id: 'c1', sentences: [BAL] }, inboundMessage: 'How much?' })).resolves.toEqual({ stale: false });
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 300, hasProcessingPayment: false, recentPayments: [], hasActivePaymentPlan: true } });
    await expect(outgoingAmountsStale({ customerId: 'c1', body: BAL, promptVersion: V12, dbh, paymentStatusSnapshot: { customer_id: 'c1', sentences: [BAL] }, inboundMessage: 'How much?' })).resolves.toEqual({ stale: true, reason: 'payment_status_changed' });
  });
  test('the pooled rule (staff-edited / pre-v12) is main\'s: the invoice total is an owed figure whether or not a plan is active', async () => {
    const drafter = require('../services/sms-shadow-drafter');
    expect(drafter.billingAmountCents({ billing: planBilling() }).owed.has(30000)).toBe(true);
    expect(drafter.billingAmountCents({ billing: planBilling({ hasActivePaymentPlan: false }) }).owed.has(30000)).toBe(true);
  });
});

// Owner ruling 2026-10-01: a STAFF-EDITED body is the staff member's own wording - the payment-status contract does not judge it.
describe('outgoingAmountsStale humanEditedBody (staff edits)', () => {
  const dbh = dbWithTables({ customers: { id: 'c1' } });
  const AI = 'Your account has no balance due.';
  const SNAP = { customer_id: 'c1', sentences: [AI] };
  const base = { customerId: 'c1', promptVersion: V12, paymentStatusSnapshot: SNAP, inboundMessage: 'Did my payment go through?', dbh };
  beforeEach(() => { ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, hasProcessingPayment: false, recentPayments: [] } }); });
  test('an UNEDITED paraphrase is still held; the same words as a staff edit are not', async () => {
    const body = "Yes, we got your payment - you're all set!";
    await expect(outgoingAmountsStale({ ...base, body })).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
    await expect(outgoingAmountsStale({ ...base, body, humanEditedBody: true })).resolves.toEqual({ stale: false });
  });
  test('an edited body is not rechecked against stale sentences either (no billing read for the status half)', async () => {
    ContextAggregator.getContextForCustomer.mockClear();
    await expect(outgoingAmountsStale({ ...base, body: `Hi Dana! ${AI} Thanks!`, humanEditedBody: true })).resolves.toEqual({ stale: false });
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  });
  test('an UNEDITED copy keeps the stale-sentence recheck', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 50, hasProcessingPayment: false, recentPayments: [] } });
    await expect(outgoingAmountsStale({ ...base, body: AI })).resolves.toEqual({ stale: true, reason: 'payment_status_changed' });
    await expect(outgoingAmountsStale({ ...base, body: AI, humanEditedBody: true })).resolves.toEqual({ stale: false });
  });
  test('only the string true counts: a truthy non-boolean is not an edit', async () => {
    await expect(outgoingAmountsStale({ ...base, body: "You're all paid up!", humanEditedBody: 'yes' })).resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
  });
  test('Zelle rules are NOT loosened for an edit: a Zelle offer to the wrong recipient is still stale', async () => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    try {
      await expect(outgoingAmountsStale({ ...base, body: 'Yes, send it by Zelle to someone-else@example.com', humanEditedBody: true })).resolves.toMatchObject({ stale: true });
    } finally { delete process.env.ZELLE_RECIPIENT; }
  });
  test('the pre-screen: a staff-edited status-only body selects nothing; a figure still selects', () => {
    realAnswersGateOn.mockReturnValue(true);
    expect(bodyNeedsPaymentRecheck("You're all paid up!", { promptVersion: V12, statusVocabulary: false })).toBe(false);
    expect(bodyNeedsPaymentRecheck("You're all paid up!", { promptVersion: V12 })).toBe(true);
    expect(bodyNeedsPaymentRecheck('You owe $5.', { promptVersion: V12, statusVocabulary: false })).toBe(true);
    expect(bodyNeedsPaymentRecheck('You can Zelle us.', { promptVersion: V12, statusVocabulary: false })).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// LIVE ZELLE FACTS (owner 2026-10-01 ~23:58Z): the ONE function that decides which Zelle sentence (if any) exists for a target invoice - the
// drafter builds the draft's facts from it and the send path re-renders from it.
// ---------------------------------------------------------------------------------------------------------------------
describe('liveZelleFacts', () => {
  let priorZelle;
  beforeEach(() => { priorZelle = process.env.ZELLE_RECIPIENT; process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com'; });
  afterEach(() => { if (priorZelle === undefined) delete process.env.ZELLE_RECIPIENT; else process.env.ZELLE_RECIPIENT = priorZelle; });
  const INV = { id: 'inv-1', customer_id: 'c1', status: 'sent', invoice_number: 'WPC-2026-0001' };
  const dbh = dbWithTables({ invoices: INV });
  const RECIPIENT = 'payments@wavespestcontrol.com';

  test('no recipient configured => not_offered, with no invoice read at all (nothing to take Zelle at)', async () => {
    delete process.env.ZELLE_RECIPIENT;
    const dbSpy = jest.fn(dbh);
    await expect(liveZelleFacts({ customerId: 'c1', invoiceId: 'inv-1', dbh: dbSpy })).resolves.toEqual({ state: 'not_offered', invoiceId: 'inv-1', invoiceNumber: null, recipient: null });
    await expect(liveZelleFacts({ customerId: 'c1', invoiceId: null, dbh: dbSpy })).resolves.toEqual({ state: 'not_offered', invoiceId: null, invoiceNumber: null, recipient: null });
    expect(dbSpy).not.toHaveBeenCalled();
  });

  test('no target invoice (or no customer) => null: Zelle can be neither offered nor denied', async () => {
    await expect(liveZelleFacts({ customerId: 'c1', invoiceId: null, dbh })).resolves.toEqual({ state: null, invoiceId: null, invoiceNumber: null, recipient: RECIPIENT });
    await expect(liveZelleFacts({ customerId: null, invoiceId: 'inv-1', dbh })).resolves.toEqual({ state: null, invoiceId: 'inv-1', invoiceNumber: null, recipient: RECIPIENT });
    expect(payPageZelleVisibility).not.toHaveBeenCalled();
  });

  test('the invoice still takes Zelle => offer, carrying its number and the live recipient (read-only visibility check)', async () => {
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(liveZelleFacts({ customerId: 'c1', invoiceId: 'inv-1', dbh })).resolves.toEqual({ state: 'offer', invoiceId: 'inv-1', invoiceNumber: 'WPC-2026-0001', recipient: RECIPIENT });
    expect(payPageZelleVisibility).toHaveBeenCalledWith(expect.objectContaining({ readOnly: true }));
  });

  test.each(['not_eligible', 'credit_pending', 'payer_owned', 'invoice_not_found', 'not_configured', undefined])(
    'CONFIRMED not eligible (%s) => invoice_unavailable', async (reason) => {
      payPageZelleVisibility.mockResolvedValue({ visible: false, reason });
      await expect(liveZelleFacts({ customerId: 'c1', invoiceId: 'inv-1', dbh })).resolves.toEqual({ state: 'invoice_unavailable', invoiceId: 'inv-1', invoiceNumber: 'WPC-2026-0001', recipient: RECIPIENT });
    },
  );

  test('a pending estimate-deposit receipt (DEPOSIT_RECONCILIATION_REQUIRED) is a confirmed ineligibility too', async () => {
    assertInvoiceDepositSettlementReady.mockRejectedValueOnce(Object.assign(new Error('awaiting reconciliation'), { code: 'DEPOSIT_RECONCILIATION_REQUIRED' }));
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(liveZelleFacts({ customerId: 'c1', invoiceId: 'inv-1', dbh })).resolves.toMatchObject({ state: 'invoice_unavailable' });
  });

  test.each(['payer_unverifiable', 'credit_unverifiable', 'eligibility_unverifiable'])('an UNVERIFIABLE state (%s) => null: never an offer and never a denial', async (reason) => {
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason });
    await expect(liveZelleFacts({ customerId: 'c1', invoiceId: 'inv-1', dbh })).resolves.toEqual({ state: null, invoiceId: 'inv-1', invoiceNumber: 'WPC-2026-0001', recipient: RECIPIENT });
  });

  test('a lookup that throws, an unexpected deposit read error, or an invoice that no longer resolves for this customer => null', async () => {
    payPageZelleVisibility.mockRejectedValue(new Error('stripe down'));
    await expect(liveZelleFacts({ customerId: 'c1', invoiceId: 'inv-1', dbh })).resolves.toMatchObject({ state: null });
    payPageZelleVisibility.mockReset();
    assertInvoiceDepositSettlementReady.mockRejectedValueOnce(new Error('db down'));
    await expect(liveZelleFacts({ customerId: 'c1', invoiceId: 'inv-1', dbh })).resolves.toMatchObject({ state: null });
    await expect(liveZelleFacts({ customerId: 'c1', invoiceId: 'inv-1', dbh: dbWithTables({ invoices: undefined }) })).resolves.toEqual({ state: null, invoiceId: 'inv-1', invoiceNumber: null, recipient: RECIPIENT });
    await expect(liveZelleFacts({ customerId: 'c1', invoiceId: 'inv-1', dbh: dbWithTables({ invoices: new Error('db down') }) })).resolves.toEqual({ state: null, invoiceId: 'inv-1', invoiceNumber: null, recipient: RECIPIENT });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// THE CONTRACT AT SEND TIME for money content: a copied Zelle / plan-price sentence is re-rendered from live data; anything money-shaped
// the draft did not copy is held.
// ---------------------------------------------------------------------------------------------------------------------
describe('paymentStatusVerdict - Zelle and plan-price sentences are re-rendered at send time', () => {
  let priorZelle;
  const RECIPIENT = 'payments@wavespestcontrol.com';
  beforeEach(() => { priorZelle = process.env.ZELLE_RECIPIENT; process.env.ZELLE_RECIPIENT = RECIPIENT; });
  afterEach(() => { if (priorZelle === undefined) delete process.env.ZELLE_RECIPIENT; else process.env.ZELLE_RECIPIENT = priorZelle; });
  const OFFER = `You can pay invoice WPC-2026-0001 by Zelle to ${RECIPIENT}, with your name or the invoice number in the Zelle memo.`;
  const UNAVAILABLE = "Zelle isn't available for invoice WPC-2026-0001 right now.";
  const NOT_OFFERED = "We don't take Zelle right now.";
  const PRICE = 'Your monthly plan price is $99.00.';
  const CHARGE = 'When your dues are charged to the credit card on file, the monthly charge is $102.96: $99.00 dues plus a $3.96 credit-card fee.';
  const snap = (sentences, zelle = { invoice_id: 'inv-1' }) => ({ customer_id: 'c1', sentences, ...(zelle ? { zelle } : {}) });
  const dbh = dbWithTables({ customers: { id: 'c1' }, invoices: { id: 'inv-1', customer_id: 'c1', status: 'sent', invoice_number: 'WPC-2026-0001' } });
  const baseCtx = (over = {}) => ({ billing: { outstandingBalance: 0, hasProcessingPayment: false, recentPayments: [], ...over }, customer: { id: 'c1' } });
  beforeEach(() => { ContextAggregator.getContextForCustomer.mockResolvedValue(baseCtx()); });
  const run = (body, snapshot, extra = {}) => paymentStatusVerdict({ customerId: 'c1', body, snapshot, dbh, inboundMessage: 'Can I pay by Zelle?', ...extra });
  const LIVE_OFFER = { state: 'offer', invoiceId: 'inv-1', invoiceNumber: 'WPC-2026-0001', recipient: RECIPIENT };

  test('a copied Zelle offer whose recipient AND invoice are still live goes out; the verdict carries the live Zelle facts', async () => {
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(run(`Hi Sam! ${OFFER}`, snap([OFFER]))).resolves.toEqual({ reason: null, zelle: LIVE_OFFER });
    // the reason-only wrapper is the same decision
    await expect(paymentStatusSendBlockReason({ customerId: 'c1', body: OFFER, snapshot: snap([OFFER]), dbh })).resolves.toBeNull();
  });

  test('the Zelle recipient was rotated or removed since the draft => payment_status_changed (the offer re-renders differently / not at all)', async () => {
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    process.env.ZELLE_RECIPIENT = 'new@wavespestcontrol.com';
    await expect(run(OFFER, snap([OFFER]))).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
    delete process.env.ZELLE_RECIPIENT;
    await expect(run(OFFER, snap([OFFER]))).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
  });

  test('the invoice stopped taking Zelle since the draft (eligibility flipped) => payment_status_changed', async () => {
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason: 'not_eligible' });
    await expect(run(OFFER, snap([OFFER]))).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
  });

  test.each(['payer_unverifiable', 'credit_unverifiable', 'eligibility_unverifiable'])('eligibility is UNVERIFIABLE now (%s) => payment_status_changed (a Zelle sentence is never rendered on a guess)', async (reason) => {
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason });
    await expect(run(OFFER, snap([OFFER]))).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
    payPageZelleVisibility.mockRejectedValue(new Error('stripe down'));
    await expect(run(OFFER, snap([OFFER]))).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
  });

  test('the target invoice is gone / renumbered, or the snapshot names no Zelle invoice => payment_status_changed', async () => {
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(run(OFFER, snap([OFFER]), { dbh: dbWithTables({ customers: { id: 'c1' }, invoices: { id: 'inv-1', customer_id: 'c1', invoice_number: 'WPC-2026-0099' } }) })).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
    await expect(run(OFFER, snap([OFFER]), { dbh: dbWithTables({ customers: { id: 'c1' }, invoices: undefined }) })).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
    await expect(run(OFFER, snap([OFFER], null))).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
  });

  test('a copied "Zelle isn\'t available for invoice N" stands only while that invoice is still CONFIRMED ineligible', async () => {
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason: 'not_eligible' });
    await expect(run(UNAVAILABLE, snap([UNAVAILABLE]))).resolves.toEqual({ reason: null, zelle: { ...LIVE_OFFER, state: 'invoice_unavailable' } });
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null }); // Zelle became available
    await expect(run(UNAVAILABLE, snap([UNAVAILABLE]))).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason: 'credit_unverifiable' }); // can no longer be confirmed
    await expect(run(UNAVAILABLE, snap([UNAVAILABLE]))).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
  });

  test('a copied "We don\'t take Zelle right now." stands only while no recipient is configured', async () => {
    delete process.env.ZELLE_RECIPIENT;
    await expect(run(NOT_OFFERED, snap([NOT_OFFERED], null))).resolves.toEqual({ reason: null, zelle: { state: 'not_offered', invoiceId: null, invoiceNumber: null, recipient: null } });
    process.env.ZELLE_RECIPIENT = RECIPIENT; // Zelle was set up since the draft
    await expect(run(NOT_OFFERED, snap([NOT_OFFERED], null))).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
  });

  test('Zelle prose the draft did not copy - an offer, a denial, a contact, any mention - is unauthorized with no reads at all', async () => {
    for (const body of ['Yes, you can use Zelle.', `You can Zelle us at ${RECIPIENT}.`, "Sorry, we don't take Zelle.", "Zelle isn't available for that invoice.",
      `${OFFER} Zelle is the fastest way.`, `You can pay invoice WPC-2026-0001 by Zelle to other@example.com, with your name or the invoice number in the Zelle memo.`]) {
      expect({ body, r: await run(body, snap([OFFER])) }).toEqual({ body, r: { reason: 'payment_status_unauthorized', zelle: null } });
    }
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
    expect(payPageZelleVisibility).not.toHaveBeenCalled();
  });

  test('a Zelle copy about another invoice than the one the customer named is unauthorized (off target)', async () => {
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(run(OFFER, snap([OFFER]), { inboundMessage: 'Can I pay invoice WPC-2026-0002 by Zelle?' })).resolves.toEqual({ reason: 'payment_status_unauthorized', zelle: null });
    await expect(run(OFFER, snap([OFFER]), { inboundMessage: 'Can I pay invoice WPC-2026-0001 by Zelle?' })).resolves.toMatchObject({ reason: null });
  });

  test('an autonomous reply must be copies + inert text: a Zelle copy alone passes the scope block, extra prose does not', async () => {
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
    await expect(run(OFFER, snap([OFFER]), { autoSend: true })).resolves.toEqual({ reason: null, zelle: LIVE_OFFER });
    await expect(run(`${OFFER} Anything else, just ask.`, snap([OFFER]), { autoSend: true })).resolves.toMatchObject({ reason: expect.any(String) });
  });

  test('a copied plan price / card charge is re-rendered from the lane: stale once the price changed or the lane is no longer monthly', async () => {
    const lane = (dues, over = {}) => ({ ...baseCtx(), customer: { id: 'c1', billingLane: { monthlyBilled: true, monthlyDues: dues, ...over } } });
    const dues = { base: 99, total: 102.96, surcharge: 3.96, surcharged: true };
    ContextAggregator.getContextForCustomer.mockResolvedValue(lane(dues));
    await expect(run(`${PRICE} ${CHARGE}`, snap([PRICE, CHARGE], null))).resolves.toEqual({ reason: null, zelle: null });
    ContextAggregator.getContextForCustomer.mockResolvedValue(lane({ ...dues, base: 109 }));
    await expect(run(PRICE, snap([PRICE], null))).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
    ContextAggregator.getContextForCustomer.mockResolvedValue(lane(dues, { monthlyBilled: false }));
    await expect(run(PRICE, snap([PRICE], null))).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
    ContextAggregator.getContextForCustomer.mockResolvedValue(lane({ ...dues, surcharged: false })); // card funding no longer resolves to a surcharge
    await expect(run(CHARGE, snap([CHARGE], null))).resolves.toEqual({ reason: 'payment_status_changed', zelle: null });
  });

  test('a plan price or figure the draft did not copy is unauthorized, however plainly it matches the account', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ ...baseCtx(), customer: { id: 'c1', billingLane: { monthlyBilled: true, monthlyDues: { base: 99 } } } });
    for (const body of ['Your plan is $99 a month.', 'Your plan is fifty dollars.', 'It is $99/mo.']) {
      expect({ body, r: (await run(body, snap([PRICE], null))).reason }).toEqual({ body, r: 'payment_status_unauthorized' });
    }
  });
});

describe('outgoingAmountsStale carries the live Zelle facts (the provider boundary re-reads them)', () => {
  let priorZelle;
  beforeEach(() => { priorZelle = process.env.ZELLE_RECIPIENT; process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com'; });
  afterEach(() => { if (priorZelle === undefined) delete process.env.ZELLE_RECIPIENT; else process.env.ZELLE_RECIPIENT = priorZelle; });
  const OFFER = 'You can pay invoice WPC-2026-0001 by Zelle to payments@wavespestcontrol.com, with your name or the invoice number in the Zelle memo.';
  const dbh = dbWithTables({ customers: { id: 'c1' }, invoices: { id: 'inv-1', customer_id: 'c1', status: 'sent', invoice_number: 'WPC-2026-0001' } });
  const SNAP = { customer_id: 'c1', sentences: [OFFER], zelle: { invoice_id: 'inv-1' } };
  const FACTS = { state: 'offer', invoiceId: 'inv-1', invoiceNumber: 'WPC-2026-0001', recipient: 'payments@wavespestcontrol.com' };
  beforeEach(() => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, hasProcessingPayment: false, recentPayments: [] } });
    payPageZelleVisibility.mockResolvedValue({ visible: true, reason: null });
  });

  test('unedited v12: ONLY the contract judges it (no owed-figure rule, no staff-contact path) and the verdict returns { stale: false, zelle }', async () => {
    await expect(outgoingAmountsStale({ customerId: 'c1', body: OFFER, promptVersion: V12, paymentStatusSnapshot: SNAP, inboundMessage: 'Can I pay by Zelle?', zelleInvoiceId: 'inv-OTHER', dbh }))
      .resolves.toEqual({ stale: false, zelle: FACTS });
    // (the snapshot's own Zelle invoice decides - zelleInvoiceId is the staff path's argument)
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason: 'not_eligible' });
    await expect(outgoingAmountsStale({ customerId: 'c1', body: OFFER, promptVersion: V12, paymentStatusSnapshot: SNAP, dbh })).resolves.toEqual({ stale: true, reason: 'payment_status_changed' });
  });

  test('unedited v12 with Zelle prose it did not copy: payment_status_unauthorized (a Zelle contact in it never reaches the staff path)', async () => {
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'You can Zelle us at payments@wavespestcontrol.com.', promptVersion: V12, paymentStatusSnapshot: null, zelleInvoiceId: 'inv-1', dbh }))
      .resolves.toEqual({ stale: true, reason: 'payment_status_unauthorized' });
  });

  test('STAFF-EDITED v12 (humanEditedBody): a Zelle contact must be the current recipient AND the target invoice must still take Zelle; contact-free Zelle words pass', async () => {
    const edit = (body, over = {}) => outgoingAmountsStale({ customerId: 'c1', body, promptVersion: V12, paymentStatusSnapshot: SNAP, humanEditedBody: true, zelleInvoiceId: 'inv-1', trustOwedAmounts: true, dbh, ...over });
    await expect(edit('Sure - Zelle to payments@wavespestcontrol.com works.')).resolves.toEqual({ stale: false, zelle: FACTS });
    await expect(edit('Sure - Zelle to old@wavespestcontrol.com works.')).resolves.toEqual({ stale: true, reason: 'zelle_recipient_stale' });
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason: 'not_eligible' });
    await expect(edit('Sure - Zelle to payments@wavespestcontrol.com works.')).resolves.toEqual({ stale: true, reason: 'zelle_invoice_ineligible' });
    await expect(edit('Sure - we take Zelle, just put your name in the memo.')).resolves.toEqual({ stale: false });
  });

  test('pre-v12 body with a Zelle contact: the same staff-contact path, then main\'s owed-amount rule unless the caller trusts the figures', async () => {
    const pre = (body, over = {}) => outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v11', zelleInvoiceId: 'inv-1', dbh, ...over });
    await expect(pre('You can Zelle payments@wavespestcontrol.com.')).resolves.toEqual({ stale: false, zelle: FACTS });
    await expect(pre('You can Zelle payments@wavespestcontrol.com for the $9,999.00 balance.')).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
    await expect(pre('You can Zelle payments@wavespestcontrol.com for the $9,999.00 balance.', { trustOwedAmounts: true })).resolves.toEqual({ stale: false, zelle: FACTS });
  });
});

describe('the read-free pre-screens select any Zelle word and price grammar (and are one definition)', () => {
  beforeEach(() => { realAnswersGateOn.mockReturnValue(false); });
  test.each(['You can Zelle us.', "We don't take Zelle.", 'zelle', 'Your plan is fifty dollars.', 'It is 45/mo.', 'You owe $5.'])('selects even with the gate off: %s', (body) => {
    expect(bodyNeedsPaymentRecheck(body)).toBe(true);
    expect(bodyNeedsBillingBoundaryCheck(body)).toBe(true);
  });
  test.each(['Sounds good, see you Tuesday!', 'You can pay by card or bank account through your pay link.', ''])('leaves alone: %s', (body) => {
    expect(bodyNeedsPaymentRecheck(body)).toBe(false);
    expect(bodyNeedsBillingBoundaryCheck(body)).toBe(false);
  });
  test('the boundary pre-screen is the recheck pre-screen, status vocabulary included', () => {
    expect(bodyNeedsBillingBoundaryCheck).toBe(bodyNeedsPaymentRecheck);
    expect(bodyNeedsBillingBoundaryCheck("You're paid up.", { promptVersion: V12 })).toBe(true);
  });
});
