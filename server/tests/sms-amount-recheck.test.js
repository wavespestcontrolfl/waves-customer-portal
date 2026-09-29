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
const { replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');
const { realAnswersGateOn } = require('../services/sms-followup-sla');
const ContextAggregator = require('../services/context-aggregator');
const { outgoingAmountsStale, bodyAmountCents, outgoingZelleStale, zelleBodyContacts } = require('../services/sms-amount-recheck');

function dbWithCustomer(row) {
  return () => ({ where: () => ({ first: async () => row }) });
}

beforeEach(() => {
  ContextAggregator.getContextForCustomer.mockReset();
  ContextAggregator.authorizedDuesCents.mockReset().mockReturnValue([]);
  replyQuotesUngroundedAmount.mockReset().mockReturnValue(false);
  realAnswersGateOn.mockReset().mockReturnValue(false);
});

test('gate ON: the drafter\'s clause-aware guard is the stricter authority (a reversed payment no longer backs an acknowledgement)', async () => {
  realAnswersGateOn.mockReturnValue(true);
  const ctx = { billing: { outstandingBalance: 95, recentPayments: [{ amount: 95, status: 'failed' }] } };
  ContextAggregator.getContextForCustomer.mockResolvedValue(ctx);
  replyQuotesUngroundedAmount.mockReturnValue(true);
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $95 payment — thank you!', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  expect(replyQuotesUngroundedAmount).toHaveBeenCalledWith('We received your $95 payment — thank you!', ctx, { byMeaning: true });
  replyQuotesUngroundedAmount.mockReturnValue(false);
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $95 payment — thank you!', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toEqual({ stale: false });
});

test('a v12 decision is rechecked strictly even after a gate rollback (prompt version wins over the live gate)', async () => {
  realAnswersGateOn.mockReturnValue(false);
  ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { outstandingBalance: 95, recentPayments: [{ amount: 95, status: 'failed' }] } });
  replyQuotesUngroundedAmount.mockReturnValue(true);
  await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $95 payment.', promptVersion: 'house_voice_v12_real_answers', dbh: dbWithCustomer({ id: 'c1' }) })).resolves.toMatchObject({ stale: true });
  expect(replyQuotesUngroundedAmount).toHaveBeenCalledWith('We received your $95 payment.', expect.any(Object), { byMeaning: true });
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

  test('a body that mentions Zelle but carries no contact is not stale', () => {
    delete process.env.ZELLE_RECIPIENT;
    expect(outgoingZelleStale('We do not take Zelle right now, but your pay link takes card or bank.')).toEqual({ stale: false });
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
