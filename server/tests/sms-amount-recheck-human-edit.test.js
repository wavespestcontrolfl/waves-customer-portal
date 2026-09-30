/**
 * Codex round-13 P1 (PR #5331): REAL binder, pre-v12 human-edited reply —
 * trustOwedAmounts excuses an OWED figure only; a receipt claim is bound to a
 * paid row and rechecked at fire time.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/context-aggregator', () => ({
  ...jest.requireActual('../services/context-aggregator'),
  getContextForCustomer: jest.fn(),
}));
const ContextAggregator = require('../services/context-aggregator');
const { outgoingAmountsStale } = require('../services/sms-amount-recheck');

const dbh = () => ({ where: () => ({ first: async () => ({ id: 'c1' }) }) });
const ctx = (payments, extra = {}) => ({ billing: { outstandingBalance: 0, recentPayments: payments, ...extra } });
const run = (body, payments, extra) => {
  ContextAggregator.getContextForCustomer.mockResolvedValue(ctx(payments, extra));
  return outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v11', dbh, trustOwedAmounts: true });
};
const paid = { amount: 500, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };

test('an owed figure the human reviewed is still trusted', async () => {
  await expect(run('Your balance is $9,999.00.', [], {})).resolves.toEqual({ stale: false });
});

test('a receipt claim is rechecked: no paid row / refunded after scheduling => stale; matching paid row => fine', async () => {
  const body = 'We received your $500 payment from Sep 12.';
  await expect(run(body, [], {})).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  await expect(run(body, [{ ...paid, status: 'refunded' }], {})).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  await expect(run(body, [paid], {})).resolves.toEqual({ stale: false });
});

test('an amount-free settlement claim is rechecked against current billing', async () => {
  await expect(run("You're paid up!", [], { outstandingBalance: 40 })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  await expect(run("You're paid up!", [], {})).resolves.toEqual({ stale: false });
});

// Codex round-14 P1: an "unpaid" assertion binds to a CURRENT open obligation at send time
// too — an invoice voided/canceled after the draft (no paid row, nothing open) blocks the send.
describe('a queued "still unpaid" reply is rechecked against the invoice that is open NOW', () => {
  const { amountFreeStatusClaimStale } = require('../services/sms-amount-recheck');
  const invs = (status, amountDue) => ({ invoiceStatuses: [{ id: 'i1', invoiceNumber: 'WPC-2026-0001', status, total: 95, amountDue }] });
  const check = (body, extra) => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([], extra));
    return amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh });
  };
  // invoice-subject claims bind the INVOICE's own status (round-22); payment-subject ones the account-wide obligation
  test.each(['This invoice is still unpaid.', 'Your invoice is unpaid.'])('%s', async (body) => {
    await expect(check(body, { outstandingBalance: 95, ...invs('sent', 95) })).resolves.toEqual({ stale: false }); // open at draft time
    await expect(check(body, { outstandingBalance: 0, openInvoice: null, ...invs('void', 0) })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' }); // voided after the draft
  });
  test("Your payment hasn't been paid. (payment subject: account-wide obligation)", async () => {
    await expect(check("Your payment hasn't been paid.", { outstandingBalance: 95 })).resolves.toEqual({ stale: false });
    await expect(check("Your payment hasn't been paid.", { outstandingBalance: 0, openInvoice: null })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });
  test('a voided #0123 while ANOTHER invoice is open is stale at send time', async () => {
    const list = [{ id: 'b', invoiceNumber: 'WPC-2026-0456', status: 'sent', total: 95, amountDue: 95 }, { id: 'a', invoiceNumber: 'WPC-2026-0123', status: 'void', total: 60, amountDue: 0 }];
    await expect(check('Invoice #0123 is still unpaid.', { outstandingBalance: 95, openInvoice: { id: 'b', amountDue: 95 }, invoiceStatuses: list })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
    await expect(check('Invoice #0456 is still unpaid.', { outstandingBalance: 95, openInvoice: { id: 'b', amountDue: 95 }, invoiceStatuses: list })).resolves.toEqual({ stale: false });
  });
  test('with a figure: the invoice must still be open with that amount (outgoingAmountsStale)', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([], { outstandingBalance: 95, ...invs('sent', 95) }));
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your $95 invoice is unpaid.', promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual({ stale: false });
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([], { outstandingBalance: 0, openInvoice: null, ...invs('void', 0) }));
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your $95 invoice is unpaid.', promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });
  test('a multi-family reply is rechecked against every family at send time', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([{ ...paid, status: 'refunded' }], {}));
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: 'Your payment was refunded after it failed.', strict: true, dbh }))
      .resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: 'Your payment was refunded.', strict: true, dbh }))
      .resolves.toEqual({ stale: false });
  });
});

// Codex round-15 P1: a queued amount-free DENIAL ("No payment received.") is false once a paid row lands.
describe('a queued denial of receipt is rechecked at send time (paid-after-draft)', () => {
  const { amountFreeStatusClaimStale } = require('../services/sms-amount-recheck');
  const check = (body, rows, extra = {}) => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx(rows, extra));
    return amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh });
  };
  test.each(['No payment received.', "We didn't get your payment.", "We don't have your payment.", "Payment has not posted."])('%s', async (body) => {
    await expect(check(body, [])).resolves.toEqual({ stale: false }); // true at draft time
    await expect(check(body, [paid])).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' }); // paid since
    await expect(check(body, [{ ...paid, status: 'refunded' }])).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
    await expect(check(body, [{ ...paid, status: null }])).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' }); // unknown-status row
  });
  test('unavailable billing blocks it', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue({ billing: { unavailable: true } });
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: 'No payment received.', strict: true, dbh }))
      .resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });
});

// Codex round-16 P1: a queued ZERO-balance claim is rechecked at send time with the drafter's own detector.
describe('a queued zero-balance reply is rechecked when a balance posts after the draft', () => {
  const { amountFreeStatusClaimStale } = require('../services/sms-amount-recheck');
  const check = (body, extra) => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([], extra));
    return amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh });
  };
  test.each(['Your balance is zero.', 'You have a zero balance.', 'Your balance is $0.00.'])('%s', async (body) => {
    await expect(check(body, { outstandingBalance: 0 })).resolves.toEqual({ stale: false }); // zero at draft time
    await expect(check(body, { outstandingBalance: 40 })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' }); // a balance posted
    await expect(check(body, { outstandingBalance: 0, openInvoice: { amountDue: 40 } })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });
  test('"$0.99" is a real balance, not a settlement claim, at draft and send time', async () => {
    const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([], { outstandingBalance: 0.99 }));
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is $0.99.', promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual({ stale: false });
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([], { outstandingBalance: 0 }));
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'Your balance is $0.99.', promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });
});

// Codex round-17 P1: the send-time check validates the rest of a zero-balance clause too.
describe('a zero-balance clause with another claim is fully rechecked at send time', () => {
  const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
  const run = (body, rows, extra) => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx(rows, extra));
    return outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh });
  };
  const STALE = { stale: true, reason: 'amount_no_longer_authorized' };
  test('receipt half: needs the matching paid row NOW (refunded since the draft => stale)', async () => {
    const r = 'Your balance is $0 after we received your $500 payment from Sep 12.';
    await expect(run(r, [paid])).resolves.toEqual({ stale: false });
    await expect(run(r, [])).resolves.toEqual(STALE);
    await expect(run(r, [{ ...paid, status: 'refunded' }])).resolves.toEqual(STALE);
  });
  test('an extra fee/price half is never shielded by the zero claim', async () => {
    await expect(run('Your balance is $0 plus a fee of fifty dollars.', [])).resolves.toEqual(STALE);
    await expect(run('Your balance is $0 plus a fee of $50.', [])).resolves.toEqual(STALE);
  });
});

// Codex round-18 P1: the send-time recheck runs the SAME claim enumerator — every claim in a clause is rechecked.
describe('multi-claim clauses are rechecked claim-by-claim at send time', () => {
  const { amountFreeStatusClaimStale, outgoingAmountsStale } = require('../services/sms-amount-recheck');
  const STALE = { stale: true, reason: 'amount_no_longer_authorized' };
  const proc = { ...paid, amount: 120, status: 'processing' };
  test('"Your account is current while your payment is processing." (processing payment + $95 owed) is stale', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([proc], { outstandingBalance: 95 }));
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: 'Your account is current while your payment is processing.', strict: true, dbh })).resolves.toEqual(STALE);
  });
  test('"We received your $120 payment from Sep 12 while it is processing." with no paid row is stale', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([]));
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $120 payment from Sep 12 while it is processing.', promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual(STALE);
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([{ ...paid, amount: 120 }]));
    await expect(outgoingAmountsStale({ customerId: 'c1', body: 'We received your $120 payment from Sep 12 while it is processing.', promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual(STALE); // paid, but "processing" has no row
  });
  test('the enumerator is what decides a clause needs billing: a multi-claim clause always does', async () => {
    const drafter = require('../services/sms-shadow-drafter');
    expect(drafter.enumeratePaymentClaims('Your account is current while your payment is processing.', {}).claims.map((c) => c.kind).sort()).toEqual(['settlement', 'status']);
    expect(drafter.enumeratePaymentClaims('Thanks so much, see you Tuesday!', {}).claims).toEqual([]);
  });
});

// Codex round-19 P2: the send-time fresh context surfaces the payment the customer asked about, exactly as the
// draft did — a valid reply about an OLDER payment (outside the 3-row display window) is not blocked at send.
describe('a valid reply about an older referenced payment is not blocked at send time', () => {
  const { outgoingAmountsStale, amountFreeStatusClaimStale } = require('../services/sms-amount-recheck');
  const older = { id: 'p-old', amount: 120, status: 'paid', payment_date: '2026-06-12', payment_method_type: 'card' };
  const newest = [1, 2, 3].map((n) => ({ id: `p${n}`, amount: 60 + n, status: 'paid', payment_date: `2026-09-0${n}`, payment_method_type: 'card' }));
  const freshCtx = () => ({
    customer: { id: 'c1' },
    billing: { outstandingBalance: 0, recentPayments: [...newest], recentPaymentsTruncated: true, paymentHistory: { rows: [...newest, older], complete: true } },
  });
  const ASK = 'Did you get my $120 payment from June 12?';
  const REPLY = 'We received your $120 payment from June 12.';
  const STALE = { stale: true, reason: 'amount_no_longer_authorized' };

  test('with the inbound, the older row is surfaced before the binder runs => not stale', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(freshCtx());
    await expect(outgoingAmountsStale({ customerId: 'c1', body: REPLY, promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh, inboundMessage: ASK })).resolves.toEqual({ stale: false });
  });
  test('without the referencing inbound the authoritative history (loaded because the window is truncated and the reply makes a claim) still holds the row => not stale', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(freshCtx());
    await expect(outgoingAmountsStale({ customerId: 'c1', body: REPLY, promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh, inboundMessage: null })).resolves.toEqual({ stale: false });
    // ...but a payment that is NOT in the history is still stale
    const ctx2 = freshCtx();
    ctx2.billing.paymentHistory = { rows: [...newest], complete: true };
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx2);
    await expect(outgoingAmountsStale({ customerId: 'c1', body: REPLY, promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh, inboundMessage: null })).resolves.toEqual(STALE);
  });
  test('the amount-free/absence path surfaces too; a genuinely missing payment is still a stale denial-of-nothing', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(freshCtx());
    // "we don't see it" is FALSE when the older paid row exists
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: "We don't see a $120 payment from June 12.", strict: true, dbh, inboundMessage: ASK })).resolves.toEqual(STALE);
    ContextAggregator.getContextForCustomer.mockResolvedValue({ ...freshCtx(), billing: { ...freshCtx().billing, paymentHistory: { rows: [...newest], complete: true } } });
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: "We don't see a $120 payment from June 12.", strict: true, dbh, inboundMessage: ASK })).resolves.toEqual({ stale: false });
  });
});

// Codex round-20 P1: refund-completion and invoice-status statements are rechecked against CURRENT state at send time.
describe('refund-completion and invoice-status replies are rechecked at send time', () => {
  const { outgoingAmountsStale, amountFreeStatusClaimStale, bodyNeedsPaymentRecheck } = require('../services/sms-amount-recheck');
  const STALE = { stale: true, reason: 'amount_no_longer_authorized' };
  const fullRefund = { ...paid, amount: 120, status: 'refunded', refund_status: 'full', refund_amount: 120 };

  test('"Your refund was processed." — true at draft (refunded row); the refund later failed and the row is back to paid => stale', async () => {
    const body = 'Your refund was processed.';
    expect(bodyNeedsPaymentRecheck(body)).toBe(true);
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([fullRefund]));
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh })).resolves.toEqual({ stale: false });
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([{ ...paid, amount: 120 }])); // refund failed: unwound
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh })).resolves.toEqual(STALE);
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([]));
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh })).resolves.toEqual(STALE);
  });
  test('"Your $120 refund was issued." goes through the strict binder with the figure', async () => {
    const body = 'Your $120 refund was issued.';
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([fullRefund]));
    await expect(outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual({ stale: false });
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([{ ...paid, amount: 120 }]));
    await expect(outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual(STALE);
  });

  const invoiceCtx = (list) => ({ billing: { outstandingBalance: 0, recentPayments: [], invoiceStatuses: list } });
  const inv = (status) => ({ id: 'i1', invoiceNumber: 'WPC-2026-0101', status, total: 120, amountDue: status === 'sent' ? 120 : 0 });
  test.each([['Your invoice is still processing.', 'processing', 'sent'], ['Your bill is paid.', 'paid', 'sent'], ['Your invoice is pending.', 'processing', 'paid']])(
    '%s — grounded on the invoice status at draft; stale once it changed', async (body, goodStatus, badStatus) => {
      expect(bodyNeedsPaymentRecheck(body)).toBe(true);
      ContextAggregator.getContextForCustomer.mockResolvedValue(invoiceCtx([inv(goodStatus)]));
      await expect(amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh })).resolves.toEqual({ stale: false });
      ContextAggregator.getContextForCustomer.mockResolvedValue(invoiceCtx([inv(badStatus)]));
      await expect(amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh })).resolves.toEqual(STALE);
    },
  );
  test('unknown invoice state at send time fails closed', async () => {
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([]));
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body: 'Your invoice is still processing.', strict: true, dbh })).resolves.toEqual(STALE);
  });
});

// Codex round-21 P1: paid-family wording about a Zelle payment is a HISTORICAL receipt, not a Zelle offer.
describe('a Zelle receipt written as "is paid" is not treated as an offer', () => {
  const { classifyZelleClause, hasAffirmativeZelleMention, outgoingAmountsStale } = require('../services/sms-amount-recheck');
  const zellePaid = { amount: 120, status: 'paid', payment_date: '2026-09-12', description: 'Invoice INV-9 — zelle' };
  const RECEIPTS = [
    'Your $120 Zelle payment from Sep 12 is paid.',
    'Your $120 Zelle payment from Sep 12 shows as paid.',
    'Your Zelle payment from Sep 12 is marked paid.',
    'Your $120 Zelle payment from Sep 12 was refunded.',
    'Your $120 Zelle payment from Sep 12 is still processing.',
  ];
  test.each(RECEIPTS)('%s => receipt, no affirmative Zelle mention', (body) => {
    expect(classifyZelleClause(body)).toBe('receipt');
    expect(hasAffirmativeZelleMention(body)).toBe(false);
  });
  test('genuine offers and instruction wording are still offers', () => {
    for (const body of ['You can pay with Zelle.', 'Please Zelle $120 to the office.', 'Your $120 Zelle payment from Sep 12 is paid — you can Zelle the rest.', 'For your Zelle payment, use old@example.com']) {
      expect({ body, aff: hasAffirmativeZelleMention(body) }).toEqual({ body, aff: true });
    }
  });
  test('send time with NO zelleInvoiceId: the receipt is judged by the payment binder (not blocked as an unresolved offer)', async () => {
    const body = 'Your $120 Zelle payment from Sep 12 is paid.';
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([zellePaid]));
    await expect(outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v12_real_answers_cf_pf', zelleInvoiceId: null, dbh })).resolves.toEqual({ stale: false });
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([]));
    await expect(outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v12_real_answers_cf_pf', zelleInvoiceId: null, dbh })).resolves.toEqual({ stale: true, reason: 'amount_no_longer_authorized' });
  });
});

// Codex round-24 P1: the send-time path applies the SAME unrecognized-assertion rule as the draft validator.
describe('an edited unrecognized payment assertion is not "fresh" at send time', () => {
  const { outgoingAmountsStale, amountFreeStatusClaimStale, bodyNeedsPaymentRecheck } = require('../services/sms-amount-recheck');
  const drafter = require('../services/sms-shadow-drafter');
  const V = require('../services/payment-receipt-vocabulary');
  const STALE = { stale: true, reason: 'amount_no_longer_authorized' };
  const UNRECOGNIZED = ['Your payment settled.', 'Your payment is all squared away.', 'We are in receipt of your payment.', 'Your payment landed safely.'];

  test.each(UNRECOGNIZED)('%s — blocked with a paid row AND without (nothing recognizes the wording)', async (body) => {
    expect(drafter.enumeratePaymentClaims(body, {}).claims).toEqual([]); // the enumerator has no claim for it...
    expect(bodyNeedsPaymentRecheck(body)).toBe(true); // ...but the prescreen / scheduler gate flags it
    for (const rows of [[paid], []]) {
      ContextAggregator.getContextForCustomer.mockResolvedValue(ctx(rows));
      await expect(amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh })).resolves.toEqual(STALE);
      await expect(outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v12_real_answers_cf_pf', dbh })).resolves.toEqual(STALE);
      // a human-edited pre-v12 body takes the same path (trustOwedAmounts excuses owed figures only)
      await expect(outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v11', trustOwedAmounts: true, dbh })).resolves.toEqual(STALE);
    }
  });
  test('draft and send agree: replyQuotesUngroundedAmount says ungrounded for the same body and context', () => {
    for (const body of UNRECOGNIZED) expect({ body, draft: drafter.replyQuotesUngroundedAmount(body, ctx([paid]), { byMeaning: true }) }).toEqual({ body, draft: true });
  });
  test('a recognized claim is still judged normally at send (paid row => grounded, none => stale)', async () => {
    const body = "We haven't received your payment yet."; // recognized not_received denial
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([]));
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh })).resolves.toEqual({ stale: false });
    ContextAggregator.getContextForCustomer.mockResolvedValue(ctx([paid]));
    await expect(amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh })).resolves.toEqual(STALE);
  });
  test('clearly non-assertive clauses are still fresh, with no billing read', async () => {
    ContextAggregator.getContextForCustomer.mockClear();
    for (const body of ['You can pay with the link below.', 'Can you tell me when you paid?', 'Please use your personal pay link.', 'See you Tuesday!']) {
      await expect(amountFreeStatusClaimStale({ customerId: 'c1', body, strict: true, dbh })).resolves.toEqual({ stale: false });
    }
    expect(ContextAggregator.getContextForCustomer).not.toHaveBeenCalled();
  });
  test('the send-time gate is a superset of the draft rule: whatever the draft fails closed on, the prescreen flags', () => {
    const samples = ['Your payment settled.', 'An unpaid invoice is on your account.', 'Everything is squared away and paid.', 'Your deposit is fine.',
      'Your transfer is sorted.', 'The charge is fine.', 'Your refund is on its way.', 'You are all paid up.', 'Your balance is zero.', 'Chargeback resolved.'];
    for (const s of samples) {
      if (V.unrecognizedPaymentAssertion(s)) expect({ s, flagged: V.mayAssertPaymentStatus(s) }).toEqual({ s, flagged: true });
    }
  });
  test('no customer on an unrecognized assertion fails closed (cannot be judged)', async () => {
    await expect(amountFreeStatusClaimStale({ customerId: null, body: 'Your payment settled.', strict: true, dbh })).resolves.toEqual({ stale: true, reason: 'amount_recheck_no_customer' });
  });
});

// Codex round-29 P1 (1): a reviewer EDIT that names a different invoice re-targets the Zelle offer.
describe('an edited Zelle offer that names another invoice is rechecked against THAT invoice', () => {
  const { outgoingAmountsStale } = require('../services/sms-amount-recheck');
  const pay = require('../routes/pay-v2');
  const open = [
    { id: 'inv-A', invoiceNumber: 'WPC-2026-0001', status: 'sent', amountDue: 95 },
    { id: 'inv-B', invoiceNumber: 'WPC-2026-0002', status: 'sent', amountDue: 210 },
  ];
  const withOpen = { billing: { outstandingBalance: 0, recentPayments: [], openInvoice: open[0], openInvoices: open } };
  let visibility;
  beforeEach(() => {
    process.env.ZELLE_RECIPIENT = 'pay@example.com';
    visibility = jest.spyOn(pay, 'payPageZelleVisibility').mockImplementation(async ({ invoice }) => ({ visible: invoice.id === 'inv-A' || invoice.id === 'inv-B', reason: null }));
    ContextAggregator.getContextForCustomer.mockResolvedValue(withOpen);
  });
  afterEach(() => { delete process.env.ZELLE_RECIPIENT; visibility.mockRestore(); });
  const idDb = (table) => ({ where: (w) => ({ first: async () => (table === 'invoices' ? { id: w.id, customer_id: 'c1', status: 'sent' } : { id: 'c1' }) }) });
  const run = (body, snapshotId) => outgoingAmountsStale({ customerId: 'c1', body, promptVersion: 'house_voice_v11', zelleInvoiceId: snapshotId, inboundMessage: null, trustOwedAmounts: true, dbh: idDb });

  test('the edit names invoice B while the snapshot is A: B is checked (not A)', async () => {
    const checked = [];
    const dbh = (table) => ({ where: (w) => ({ first: async () => { if (table === 'invoices') checked.push(w.id); return table === 'invoices' ? { id: w.id, customer_id: 'c1', status: 'sent' } : { id: 'c1' }; } }) });
    await outgoingAmountsStale({ customerId: 'c1', body: 'You can Zelle invoice WPC-2026-0002 to pay@example.com.', promptVersion: 'house_voice_v11', zelleInvoiceId: 'inv-A', trustOwedAmounts: true, dbh });
    expect(checked).toEqual(['inv-B']);
  });
  test('B is not eligible => the edited offer blocks even though the snapshot invoice A still is', async () => {
    visibility.mockImplementation(async ({ invoice }) => ({ visible: invoice.id !== 'inv-B', reason: 'not_eligible' }));
    await expect(run('You can Zelle invoice #0002 to pay@example.com.', 'inv-A')).resolves.toMatchObject({ stale: true, reason: 'zelle_invoice_ineligible' });
  });
  test('the edit names an invoice that is not open / cannot be resolved => blocked (unresolved)', async () => {
    await expect(run('You can Zelle invoice WPC-2026-0999 to pay@example.com.', 'inv-A')).resolves.toEqual({ stale: true, reason: 'zelle_invoice_unresolved' });
    await expect(run('You can Zelle the $77 invoice to pay@example.com.', 'inv-A')).resolves.toEqual({ stale: true, reason: 'zelle_invoice_unresolved' });
  });
  test('the edit names the SAME invoice as the snapshot, or no invoice at all: the snapshot is used as before', async () => {
    const checked = [];
    const dbh = (table) => ({ where: (w) => ({ first: async () => { if (table === 'invoices') checked.push(w.id); return table === 'invoices' ? { id: w.id, customer_id: 'c1', status: 'sent' } : { id: 'c1' }; } }) });
    await outgoingAmountsStale({ customerId: 'c1', body: 'You can Zelle invoice WPC-2026-0001 to pay@example.com.', promptVersion: 'house_voice_v11', zelleInvoiceId: 'inv-A', trustOwedAmounts: true, dbh });
    await outgoingAmountsStale({ customerId: 'c1', body: 'You can Zelle us at pay@example.com.', promptVersion: 'house_voice_v11', zelleInvoiceId: 'inv-A', trustOwedAmounts: true, dbh });
    expect(checked).toEqual(['inv-A', 'inv-A']);
    await expect(run('You can Zelle us at pay@example.com.', 'inv-A')).resolves.toEqual({ stale: false });
  });
});
