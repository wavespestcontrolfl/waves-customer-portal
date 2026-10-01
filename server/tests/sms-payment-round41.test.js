/**
 * Codex round-41 (PR #5331): three chokepoints in the clause validator (sms-shadow-drafter) —
 *   1. resolveEveryFigure/bindAllTargets resolves every named DATE, not only the first (paymentClaimBinding.claimedDates)
 *   2. a recognized claim never shields a second, unclassifiable assertion in the same clause (residualPaymentAssertion)
 *   3. a bare pronoun carries the customer's INVOICE (inboundNamesInvoice -> invoice-subject claim)
 * each checked at draft time (replyQuotesUngroundedAmount) and at the send-time recheck (amountFreeStatusClaimStale).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/context-aggregator', () => ({ getContextForCustomer: jest.fn(), authorizedDuesCents: jest.fn(() => []) }));
jest.mock('../routes/pay-v2', () => ({ payPageZelleVisibility: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({ assertInvoiceDepositSettlementReady: jest.fn(async () => {}) }));
const ContextAggregator = require('../services/context-aggregator');
const V = require('../services/payment-receipt-vocabulary');
const { replyQuotesUngroundedAmount, resolveEveryFigure } = require('../services/sms-shadow-drafter');
const { amountFreeStatusClaimStale } = require('../services/sms-amount-recheck');

const row = (id, status, date, extra = {}) => ({ id, amount: 60, status, payment_date: date, payment_method_type: 'card', ...extra });
const ctx = (rows, extra = {}) => ({ billing: { outstandingBalance: 0, recentPayments: rows, ...extra } });
const ungrounded = (reply, c, inbound = '') => replyQuotesUngroundedAmount(reply, c, { byMeaning: true, inboundMessage: inbound });
const customerDb = () => () => ({ where: () => ({ first: async () => ({ id: 'c1' }) }) });
async function staleAtSend(reply, c, inbound = '') {
  ContextAggregator.getContextForCustomer.mockResolvedValue(c);
  return (await amountFreeStatusClaimStale({ customerId: 'c1', body: reply, strict: true, dbh: customerDb(), inboundMessage: inbound })).stale;
}

describe('round-41 #2: every date a clause names must resolve (resolveEveryFigure extended to dates)', () => {
  const sep1 = row('a', 'pending', '2026-09-01');
  const sep2 = row('b', 'pending', '2026-09-02');
  const reply = 'Your payments from Sep 1 through Sep 2 are pending.';
  test('only a Sep 1 row: the Sep 2 date is unsupported, so the claim is ungrounded (draft and send)', async () => {
    expect(ungrounded(reply, ctx([sep1]))).toBe(true);
    expect(await staleAtSend(reply, ctx([sep1]))).toBe(true);
  });
  test('a row for EACH date grounds it (draft and send); the single-date form is unchanged', async () => {
    expect(ungrounded(reply, ctx([sep1, sep2]))).toBe(false);
    expect(await staleAtSend(reply, ctx([sep1, sep2]))).toBe(false);
    expect(ungrounded('Your payment from Sep 1 is pending.', ctx([sep1]))).toBe(false);
    expect(ungrounded('Your payment from Sep 1 is pending.', ctx([sep2]))).toBe(true);
  });
  test('the dates must agree with what the customer asked about, each of them', () => {
    expect(ungrounded(reply, ctx([sep1, sep2]), 'Is my payment from Sep 1 pending?')).toBe(true); // Sep 2 is a different payment
    expect(ungrounded(reply, ctx([sep1, sep2]), 'Are my Sep 1 and Sep 2 payments pending?')).toBe(false);
  });
  test('a receipt and an absence claim over several dates resolve every date too', () => {
    const paid = (d, id) => row(id, 'paid', d);
    expect(ungrounded('We received your $60 payment from Sep 1 or Sep 2.', ctx([paid('2026-09-01', 'p1')]))).toBe(true);
    expect(ungrounded('We received your $60 payments from Sep 1 through Sep 2.', ctx([paid('2026-09-01', 'p1'), paid('2026-09-02', 'p2')]))).toBe(false);
    // an absence claim is contradicted by a row on ANY named date
    expect(ungrounded("We don't see a payment from Sep 1 or Sep 2.", ctx([sep2]))).toBe(true);
    expect(ungrounded("We don't see a payment from Sep 1 or Sep 2.", ctx([row('z', 'paid', '2026-08-01')]))).toBe(false);
  });
  test('resolveEveryFigure is the one resolver: a date with no row (or several) fails the whole claim', () => {
    expect(resolveEveryFigure(['d1', 'd2'], (d) => (d === 'd1' ? ['r1'] : []))).toBeNull();
    expect(resolveEveryFigure(['d1', 'd2'], (d) => [`r-${d}`])).toEqual(['r-d1', 'r-d2']);
  });
});

describe('round-41 #3: a recognized claim never shields an unclassifiable assertion left in the clause', () => {
  const pending = row('p', 'pending', '2026-09-01');
  test('"pending yet already settled" is held although "pending" is grounded (draft and send)', async () => {
    const reply = 'Your payment is pending yet already settled.';
    expect(ungrounded(reply, ctx([pending]))).toBe(true);
    expect(await staleAtSend(reply, ctx([pending]))).toBe(true);
    expect(V.residualPaymentAssertion('Your payment is   yet already settled.')).toBe(true);
  });
  test('more shapes of the same class are held; plain scaffolding after the claim is not', () => {
    for (const r of ['Your payment is pending and now reconciled.', 'Your payment is pending but complete.', 'Your payment is pending yet final.']) {
      expect({ r, held: ungrounded(r, ctx([pending])) }).toEqual({ r, held: true });
    }
    for (const r of ['Your payment is pending.', "Your payment isn't showing on our end yet.", 'Your payment from Sep 1 is pending, thanks for your patience!', 'Your payment is pending as of today.']) {
      const rows = /isn't showing/.test(r) ? [] : [pending];
      expect({ r, held: ungrounded(r, ctx(rows)) }).toEqual({ r, held: false });
    }
  });
  test('non-assertive sub-clauses are skipped, exactly as in the unrecognized-assertion rule', () => {
    expect(V.residualPaymentAssertion('Your payment is  , and you can pay online if you prefer.')).toBe(false);
    expect(V.residualPaymentAssertion('Your payment is  . Did it settle?')).toBe(false);
  });
});

describe('round-41 #4: a pronoun carries the invoice the customer asked about', () => {
  const inv = (status) => ({ invoiceStatuses: [{ id: 'i1', invoiceNumber: 'WPC-2026-0123', status, total: 120, amountDue: status === 'processing' ? 120 : 0 }, { id: 'i2', invoiceNumber: 'WPC-2026-0200', status: 'paid', total: 95, amountDue: 0 }] });
  const ask = 'Is invoice #0123 still processing?';
  test('"It is still processing." is checked against invoice #0123 (draft and send)', async () => {
    expect(ungrounded('It is still processing.', ctx([], inv('sent')), ask)).toBe(true);
    expect(ungrounded('It is still processing.', ctx([], inv('processing')), ask)).toBe(false);
    expect(await staleAtSend('It is still processing.', ctx([], inv('sent')), ask)).toBe(true);
    expect(await staleAtSend('It is still processing.', ctx([], inv('processing')), ask)).toBe(false);
  });
  test('it is the NAMED invoice, never another: #0200 is paid, so "still processing" about #0123 stays false when #0123 is paid', () => {
    expect(ungrounded('It is still processing.', ctx([], inv('paid')), ask)).toBe(true);
    expect(ungrounded('It is paid.', ctx([], inv('paid')), 'Is invoice #0123 paid?')).toBe(false);
    expect(ungrounded('It failed.', ctx([], inv('processing')), 'Did invoice #0123 fail?')).toBe(true);
  });
  test('a payment question keeps its payment pronoun semantics (no invoice context)', () => {
    expect(V.inboundNamesInvoice('Is invoice #0123 still processing?')).toBe(true);
    expect(V.inboundNamesInvoice('Did my payment for invoice 0123 go through?')).toBe(false);
    expect(V.inboundNamesInvoice('Did my Zelle payment go through?')).toBe(false);
  });
});
