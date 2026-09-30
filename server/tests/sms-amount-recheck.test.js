/**
 * sms-amount-recheck — the send-time amount revalidation shared by the
 * scheduler's fire-time path and the immediate Agent Review send (PR #5119
 * follow-up #2). Fresh context, current obligations only, payment history
 * only for an acknowledgement, fail closed on any error.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/context-aggregator', () => ({
  getContextForCustomer: jest.fn(),
  authorizedDuesCents: jest.fn(() => []),
}));
// the clause-aware guard is stubbed; the shared billing figures are the real ones
jest.mock('../services/sms-shadow-drafter', () => ({
  ...jest.requireActual('../services/sms-shadow-drafter'),
  replyQuotesUngroundedAmount: jest.fn(() => false),
}));
jest.mock('../services/sms-followup-sla', () => ({ realAnswersGateOn: jest.fn(() => false) }));
jest.mock('../services/sms-suggest-mode', () => ({ hasPriceQuote: jest.fn((t) => /\b(?:fifty|forty|twenty|hundred)\s+dollars\b|\d+\s?\/\s?mo\b|\$\s?\d/i.test(String(t || ''))) }));
jest.mock('../routes/pay-v2', () => ({ payPageZelleVisibility: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: jest.fn(async () => {}) }));
const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
const { realAnswersGateOn } = require('../services/sms-followup-sla');
const ContextAggregator = require('../services/context-aggregator');
const { payPageZelleVisibility } = require('../routes/pay-v2');
const { assertInvoiceDepositSettlementReady } = require('../services/estimate-deposits');
const {
  outgoingAmountsStale, bodyAmountCents, outgoingZelleStale, zelleBodyContacts, zelleInvoiceStillEligible,
  hasAffirmativeZelleMention, classifyZelleClause, amountFreeStatusClaimStale,
} = require('../services/sms-amount-recheck');

function dbWithCustomer(row) {
  return () => ({ where: () => ({ first: async () => row }) });
}

// Distinguishes by table name, unlike dbWithCustomer above — needed once a
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
  replyQuotesUngroundedAmount.mockReset().mockReturnValue(false);
  realAnswersGateOn.mockReset().mockReturnValue(false);
  payPageZelleVisibility.mockReset();
  assertInvoiceDepositSettlementReady.mockReset().mockImplementation(async () => {});
});

test('gate ON: the drafter\'s clause-aware guard is the stricter authority (a reversed payment no longer backs an acknowledgement)', async () => {
  realAnswersGateOn.mockReturnValue(true);
  const ctx = { billing: { outstandingBalance: 95, recentPayments: [{ amount: 95, status: 'failed' }] } };
  ContextAggregator.getContextForCustomer.mockResolvedValue(ctx);
  replyQuotesUngroundedAmount.mockReturnValue(true);
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $95 payment — thank you!', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  expect(replyQuotesUngroundedAmount).toHaveBeenCalledWith('We received your $95 payment — thank you!', ctx, { byMeaning: true, trustOwedAmounts: false, inboundMessage: null });
  replyQuotesUngroundedAmount.mockReturnValue(false);
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $95 payment — thank you!', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: false });
});

test('a v12 decision is rechecked strictly even after a gate rollback (prompt version wins over the live gate)', async () => {
  realAnswersGateOn.mockReturnValue(false);
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 95, recentPayments: [{ amount: 95, status: 'failed' }] } });
  replyQuotesUngroundedAmount.mockReturnValue(true);
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $95 payment.', promptVersion: 'house_voice_v12_real_answers', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toMatchObject({ stale: true });
  expect(replyQuotesUngroundedAmount).toHaveBeenCalledWith('We received your $95 payment.', expect.any(Object), { byMeaning: true, trustOwedAmounts: false, inboundMessage: null });
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is fifty dollars.', promptVersion: 'house_voice_v12_real_answers', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: true, reason: 'amount_unverifiable' });
  // an older-prompt decision under a gate that is ON stays on the legacy rule
  realAnswersGateOn.mockReturnValue(true);
  replyQuotesUngroundedAmount.mockClear();
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 120.5, recentPayments: [] } });
  await outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is $120.50.', promptVersion: 'house_voice_v11', dbh: dbWithCustomer({ id: 'c1' }) });
  expect(replyQuotesUngroundedAmount).not.toHaveBeenCalled();
});

test('gate OFF: the guard is not consulted', async () => {
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 120.5, recentPayments: [] } });
  await outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is $120.50.', dbh: dbWithCustomer({ id: 'c1' }) });
  expect(replyQuotesUngroundedAmount).not.toHaveBeenCalled();
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
    expect(payPageZelleVisibility).toHaveBeenCalledWith({ invoice: invoiceRow, dbh: expect.any(Function) });
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
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is fifty dollars.', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: true, reason: 'amount_unverifiable' });
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

describe('Codex round 4 P1 (finding 1): a Zelle RECEIPT clause never runs the recipient/eligibility recheck', () => {
  let priorZelle;
  beforeEach(() => {
    priorZelle = process.env.ZELLE_RECIPIENT;
    process.env.ZELLE_RECIPIENT = 'payments@wavespestcontrol.com';
  });
  afterEach(() => {
    if (priorZelle === undefined) delete process.env.ZELLE_RECIPIENT;
    else process.env.ZELLE_RECIPIENT = priorZelle;
  });

  test('classifyZelleClause: offer wording', () => {
    expect(classifyZelleClause('you can Zelle us anytime')).toBe('offer');
    expect(classifyZelleClause('Zelle to payments@wavespestcontrol.com')).toBe('offer');
    expect(classifyZelleClause('we accept Zelle')).toBe('offer');
    expect(classifyZelleClause('you can pay via Zelle')).toBe('offer');
  });

  test('classifyZelleClause: historical receipt wording', () => {
    expect(classifyZelleClause('We received your $120 Zelle payment from Sep 12')).toBe('receipt');
    expect(classifyZelleClause('we got your Zelle payment')).toBe('receipt');
    expect(classifyZelleClause('your Zelle payment cleared')).toBe('receipt');
  });

  test('classifyZelleClause: negation and no-mention', () => {
    expect(classifyZelleClause('we don\'t take Zelle anymore')).toBe(null);
    expect(classifyZelleClause('see you Tuesday')).toBe(null);
  });

  test('classifyZelleClause: an ambiguous affirmative mention fails closed as an offer', () => {
    expect(classifyZelleClause('Zelle works great for that')).toBe('offer');
  });

  test('hasAffirmativeZelleMention: false for a receipt-only body (the reported P1 bug)', () => {
    expect(hasAffirmativeZelleMention('We received your $120 Zelle payment from Sep 12.')).toBe(false);
  });

  test('hasAffirmativeZelleMention: true for an offer clause', () => {
    expect(hasAffirmativeZelleMention('You can Zelle the rest to payments@wavespestcontrol.com.')).toBe(true);
  });

  test('hasAffirmativeZelleMention: true for a MIXED body (one receipt clause, one offer clause)', () => {
    expect(hasAffirmativeZelleMention('We got your Zelle payment, and you can Zelle the rest to payments@wavespestcontrol.com.')).toBe(true);
  });

  test('outgoingZelleStale: a pure receipt confirmation is never stale even after the invoice settles (zelleInvoiceId null)', () => {
    expect(outgoingZelleStale('We received your $120 Zelle payment from Sep 12.')).toEqual({ stale: false });
  });

  test('outgoingAmountsStale: a receipt-only body never runs the invoice-eligibility recheck, and reaches the amount binder instead', async () => {
    realAnswersGateOn.mockReturnValue(true);
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [] } });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'We received your $120 Zelle payment from Sep 12.', zelleInvoiceId: null, dbh: dbWithCustomer({ id: 'c1' }),
    })).resolves.toEqual({ stale: false }); // replyQuotesUngroundedAmount is mocked to return false
    expect(payPageZelleVisibility).not.toHaveBeenCalled();
    expect(replyQuotesUngroundedAmount).toHaveBeenCalled();
  });

  test('outgoingAmountsStale: a mixed body still runs the offer\'s eligibility recheck (receipt clause alongside it does not exempt it)', async () => {
    payPageZelleVisibility.mockResolvedValue({ visible: false, reason: 'not_eligible' });
    const invoiceRow = { id: 'inv-1', customer_id: 'c1', status: 'paid' };
    await expect(outgoingAmountsStale({
      customerId: 'c1',
      body: 'We got your Zelle payment, and you can Zelle the rest to payments@wavespestcontrol.com.',
      zelleInvoiceId: 'inv-1',
      dbh: dbWithTables({ invoices: invoiceRow }),
    })).resolves.toEqual({ stale: true, reason: 'zelle_invoice_ineligible' });
  });
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

  test('trustOwedAmounts skips the pooled owed-amount check (gate off / legacy prompt)', async () => {
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'Your balance is $9,999.00.', dbh: dbWithCustomer({ id: 'c1' }), trustOwedAmounts: true,
    })).resolves.toEqual({ stale: false });
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('without trustOwedAmounts, the same ungrounded balance is still blocked (regression guard)', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [] } });
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'Your balance is $9,999.00.', dbh: dbWithCustomer({ id: 'c1' }),
    })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });

  test('the strict (real-answers) path passes trustOwedAmounts through to the clause-aware binder', async () => {
    realAnswersGateOn.mockReturnValue(true);
    replyQuotesUngroundedAmount.mockReturnValue(false);
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [] } });
    await outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is $9,999.00.', dbh: dbWithCustomer({ id: 'c1' }), trustOwedAmounts: true });
    expect(replyQuotesUngroundedAmount).toHaveBeenCalledWith('Your balance is $9,999.00.', expect.any(Object), { byMeaning: true, trustOwedAmounts: true, inboundMessage: null });
  });
});

describe('Codex round 5 (finding 1): an amount-free payment-status claim still re-fetches billing before send', () => {
  test('strict + a settlement claim ⇒ billing is fetched fresh and the binder decides', async () => {
    realAnswersGateOn.mockReturnValue(true);
    const ctx = { billing: { outstandingBalance: 0, recentPayments: [] } };
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx);
    replyQuotesUngroundedAmount.mockReturnValue(false);
    await expect(outgoingAmountsStale({ customerId: 'c1', body: "You're paid up!", dbh: dbWithCustomer({ id: 'c1' }) }))
      .resolves.toEqual({ stale: false });
    expect(ContextAggregator.getContextForCustomer).toHaveBeenCalled();
    expect(replyQuotesUngroundedAmount).toHaveBeenCalledWith("You're paid up!", ctx, { byMeaning: true, trustOwedAmounts: false, inboundMessage: null });
  });

  test('strict + the claim no longer grounds against CURRENT billing ⇒ stale', async () => {
    realAnswersGateOn.mockReturnValue(true);
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 40, recentPayments: [] } });
    replyQuotesUngroundedAmount.mockReturnValue(true);
    await expect(outgoingAmountsStale({ customerId: 'c1', body: "You're paid up!", dbh: dbWithCustomer({ id: 'c1' }) }))
      .resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });

  test('strict + a body with no payment-status claim at all ⇒ clean, no billing fetch', async () => {
    realAnswersGateOn.mockReturnValue(true);
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'See you Tuesday!', dbh: dbWithCustomer({ id: 'c1' }) }))
      .resolves.toEqual({ stale: false });
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  // Codex round-6 (PR #5331): CI regression on the gratitude auto-send lane —
  // a body naming no payment/paid/account word is skipped BEFORE the drafter is
  // touched, so a stubbed/absent drafter export can never turn thank-you copy
  // into a send_error.
  test('strict + gratitude copy never reaches the drafter or billing (pre-screen)', async () => {
    const drafter = require('../services/sms-shadow-drafter');
    const saved = drafter.hasAffirmativePaymentAck;
    drafter.hasAffirmativePaymentAck = undefined;
    try {
      await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: "You're welcome, Dana! Glad we could help.", strict: true, dbh: dbWithCustomer({ id: 'c1' }) }))
        .resolves.toEqual({ stale: false });
    } finally {
      drafter.hasAffirmativePaymentAck = saved;
    }
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('not strict (legacy prompt / gate off) ⇒ the original amount-free fast path, no billing fetch', async () => {
    realAnswersGateOn.mockReturnValue(false);
    await expect(outgoingAmountsStale({ customerId: 'c1', body: "You're paid up!", dbh: dbWithCustomer({ id: 'c1' }) }))
      .resolves.toEqual({ stale: false });
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  });

  test('strict + no customerId ⇒ fails closed without a lookup', async () => {
    await expect(amountFreeStatusClaimStale({ customerId: null, body: "You're paid up!", strict: true }))
      .resolves.toEqual({ stale: true, reason: 'amount_recheck_no_customer' });
  });

  test('a billing lookup error fails closed rather than throwing', async () => {
    ContextAggregator.getContextForCustomer.mockRejectedValue(new Error('boom'));
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: 'We have your payment.', strict: true, dbh: dbWithCustomer({ id: 'c1' }) }))
      .resolves.toEqual({ stale: true, reason: 'amount_recheck_failed' });
  });
});

describe('Codex round 5 (finding 2): a Zelle clause needs an explicit past-tense verb to read as a receipt', () => {
  // The reported case: an INSTRUCTION with no offer verb ("use X") and no
  // completed-payment verb was previously matched by the old, purely
  // structural "your … Zelle … payment" alternative and misclassified as a
  // receipt, bypassing the offer rechecks entirely.
  test('classifyZelleClause: an instruction naming a contact is never a receipt', () => {
    expect(classifyZelleClause('For your Zelle payment, use old@example.com')).toBe('offer');
    expect(classifyZelleClause('For your Zelle payment use old@example.com')).toBe('offer');
    expect(hasAffirmativeZelleMention('For your Zelle payment, use old@example.com')).toBe(true);
  });

  test('classifyZelleClause: "your Zelle payment" alone, with no verb at all, fails closed as an offer', () => {
    expect(classifyZelleClause('Your Zelle payment is due')).toBe('offer');
  });

  test('classifyZelleClause: a genuine past-tense receipt is unaffected', () => {
    expect(classifyZelleClause('your Zelle payment cleared')).toBe('receipt');
    expect(classifyZelleClause('We received your $120 Zelle payment from Sep 12')).toBe('receipt');
  });

  test('outgoingAmountsStale: the instruction-with-no-verb example still runs the recipient/eligibility recheck', async () => {
    await expect(outgoingAmountsStale({
      customerId: 'c1', body: 'For your Zelle payment, use old@example.com.', zelleInvoiceId: null, dbh: dbWithCustomer({ id: 'c1' }),
    })).resolves.toEqual({ stale: true, reason: 'zelle_recipient_stale' });
  });
});

describe('P2 (round 6, PR #5331): thank-you wording reads as a historical Zelle receipt', () => {
  test('classifyZelleClause: "thanks/thank you for the Zelle payment" is a receipt with no other verb needed', () => {
    expect(classifyZelleClause('Thanks for the Zelle payment!')).toBe('receipt');
    expect(classifyZelleClause('Thank you for your Zelle payment.')).toBe('receipt');
  });

  test('classifyZelleClause: a contact token still forces "offer" even alongside thank-you wording', () => {
    expect(classifyZelleClause('Thanks for your Zelle payment, please send the rest to old@example.com')).toBe('offer');
  });

  test('hasAffirmativeZelleMention: a thank-you-only receipt body is NOT an affirmative offer (never re-runs the recipient recheck)', () => {
    expect(hasAffirmativeZelleMention('Thanks for the Zelle payment!')).toBe(false);
  });
});

describe('P1 (round 6, PR #5331): the customer\'s inbound wording threads through to the clause-aware binder', () => {
  test('outgoingAmountsStale passes inboundMessage through to replyQuotesUngroundedAmount (strict path)', async () => {
    realAnswersGateOn.mockReturnValue(true);
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [{ amount: 120, status: 'paid' }] } });
    await outgoingAmountsStale({
      customerId: 'c1', body: 'We received your $120.00 payment — thank you!', dbh: dbWithCustomer({ id: 'c1' }), inboundMessage: 'Did you get my $120 Zelle payment?',
    });
    expect(replyQuotesUngroundedAmount).toHaveBeenCalledWith(
      'We received your $120.00 payment — thank you!',
      expect.any(Object),
      { byMeaning: true, trustOwedAmounts: false, inboundMessage: 'Did you get my $120 Zelle payment?' },
    );
  });

  test('amountFreeStatusClaimStale passes inboundMessage through too', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 0, recentPayments: [] } });
    await amountFreeStatusClaimStale({
      customerId: 'c1', body: "You're paid up!", strict: true, dbh: dbWithCustomer({ id: 'c1' }), inboundMessage: 'Did I pay in full?',
    });
    expect(replyQuotesUngroundedAmount).toHaveBeenCalledWith(
      "You're paid up!",
      expect.any(Object),
      { byMeaning: true, trustOwedAmounts: false, inboundMessage: 'Did I pay in full?' },
    );
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

describe('Codex round-6 pre-push audit P1: a missing customer row / context is not an empty account', () => {
  test('amount-free settlement claim with NO customer row ⇒ stale (fail closed), drafter never asked', async () => {
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: "You're paid up!", strict: true, dbh: dbWithCustomer(null) }))
      .resolves.toEqual({ stale: true, reason: 'amount_recheck_no_customer' });
    expect(replyQuotesUngroundedAmount).not.toHaveBeenCalled();
  });

  test('a customer row whose context comes back empty ⇒ stale too', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(null);
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: "You're paid up!", strict: true, dbh: dbWithCustomer({ id: 'c1' }) }))
      .resolves.toEqual({ stale: true, reason: 'amount_recheck_no_customer' });
  });

  test('outgoingAmountsStale (strict, amounts) with no customer row ⇒ stale', async () => {
    realAnswersGateOn.mockReturnValue(true);
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is $95.', dbh: dbWithCustomer(null) }))
      .resolves.toEqual({ stale: true, reason: 'amount_recheck_no_customer' });
  });
});

describe('Codex round-7 P1 #3: receipt wording must identify an actual past payment', () => {
  test('"Yes, we\'ve got Zelle" / "we have Zelle" / "we take Zelle" are OFFERS (recipient + invoice rechecked)', () => {
    for (const c of ["Yes, we've got Zelle", 'We have Zelle', 'Yes, we got Zelle set up', 'We take Zelle']) {
      expect(classifyZelleClause(c)).toBe('offer');
      expect(hasAffirmativeZelleMention(c)).toBe(true);
    }
    delete process.env.ZELLE_RECIPIENT;
    expect(outgoingZelleStale("Yes, we've got Zelle")).toEqual({ stale: true, reason: 'zelle_recipient_stale' });
  });

  test('real receipt wording still classifies as a receipt', () => {
    for (const c of ['We got your Zelle payment.', 'We received your $120 Zelle from Sep 12.', "We've got your Zelle transfer.", 'Got your Zelle payment - thanks!']) {
      expect(classifyZelleClause(c)).toBe('receipt');
    }
  });

  test('a status phrase with no dollar figure ("still processing") reaches the strict binder at send time', async () => {
    realAnswersGateOn.mockReturnValue(true);
    const ctx = { billing: { outstandingBalance: 0, recentPayments: [{ amount: 120, status: 'paid' }] } };
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx);
    replyQuotesUngroundedAmount.mockReturnValue(true);
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: 'Your payment is still processing.', strict: true, dbh: dbWithCustomer({ id: 'c1' }) }))
      .resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
    expect(replyQuotesUngroundedAmount).toHaveBeenCalled();
  });
});
