/**
 * STRUCTURAL coverage (Codex round-12, PR #5331): round after round added phrase
 * families. This enumerates subject x phrase x polarity from the vocabulary
 * TABLES and asserts every combination classifies to a non-'none' kind and is
 * screened in by the prescreen — so a missing family FAILS THIS TEST instead of
 * costing a review round.
 */
const V = require('../services/payment-receipt-vocabulary');
const { classifyPaymentClause, replyQuotesUngroundedAmount } = require('../services/sms-shadow-drafter');

const ENV = { inboundText: '' };
const kind = (text, hasAmounts = false) => classifyPaymentClause(text.replace(/\$\d+(?:\.\d\d)?/g, ' AMT '), hasAmounts, ENV).kind;

// Subjects a claim can be ABOUT (the shared payment-noun vocabulary).
const SUBJECTS = ['payment', 'Zelle payment', 'Zelle transfer', 'ACH payment', 'card payment', 'deposit', 'charge', 'your check'];
const withArticle = (s) => (/^your /.test(s) ? s : `your ${s}`);

const AUX = /^(?:is|was|has|have|had|isn't|wasn't|hasn't|haven't|didn't|did|not|still|being|currently|in process|no |don't|do not|are|aren't)/i;
// Natural positive sentence for (family, subject, phrase).
function positive(family, subject, phrase) {
  const subj = withArticle(subject);
  if (V.PAYMENT_STATUS_VOCABULARY[family] && family === 'paid') {
    if (/^(?:all set|all paid|paid in full)$/.test(phrase)) return `${subj} is ${phrase}`;
    return `We ${phrase} ${subj}`;
  }
  if (family === 'not_found' || family === 'not_received') return `We ${phrase} ${subj}`;
  return AUX.test(phrase) ? `${subj} ${phrase}` : `${subj} was ${phrase}`;
}

describe('every table phrase x subject classifies (positive polarity)', () => {
  for (const [family, { phrases }] of Object.entries(V.PAYMENT_STATUS_VOCABULARY)) {
    test(`${family}: ${phrases.length} phrases x ${SUBJECTS.length} subjects, amount-free and amount-bearing`, () => {
      const misses = [];
      for (const subject of SUBJECTS) {
        for (const phrase of phrases) {
          const s = positive(family, subject, phrase);
          if (kind(s) === 'none') misses.push(`amount-free: "${s}"`);
          if (kind(`${s} for $120 on Sep 12`, true) === 'none') misses.push(`amount: "${s} for $120…"`);
          if (!V.mayAssertPaymentStatus(s)) misses.push(`prescreen: "${s}"`);
        }
      }
      expect(misses).toEqual([]);
    });
  }
});

describe('every table phrase x subject classifies (negative polarity)', () => {
  test('a negated form of every phrase is classified (negated | negated_ack | absence | status), never silently none', () => {
    const misses = [];
    for (const subject of SUBJECTS) {
      for (const [family, { phrases }] of Object.entries(V.PAYMENT_STATUS_VOCABULARY)) {
        if (family === 'not_found' || family === 'not_received') continue; // already negative
        for (const phrase of phrases) {
          if (family === 'paid' && /^(?:all set|all paid|paid in full)$/.test(phrase)) continue;
          const subj = withArticle(subject);
          const s = family === 'paid' ? `${subj} has not ${phrase}` : `${subj} is not ${phrase.replace(/^(?:is|was|has been|being|currently|still)\s+/, '')}`;
          if (kind(s) === 'none') misses.push(`"${s}"`);
        }
      }
    }
    expect(misses).toEqual([]);
  });
});

describe('every SETTLEMENT phrase classifies as settlement and is screened in', () => {
  test.each(V.SETTLEMENT_PHRASES)('%s', (phrase) => {
    const s = phrase.replace(/^(?:your|you)/, (m) => m); // as written
    expect(kind(s)).toBe('settlement');
    expect(V.mayAssertPaymentStatus(s)).toBe(true);
    expect(kind(`Good news, ${s} right now`)).toBe('settlement');
  });
  test('zero-balance forms are screened in', () => {
    for (const s of ['Your balance is $0.', 'You have a $0 balance.', 'Your balance is zero.', 'You owe $0.']) {
      expect({ s, screened: V.mayAssertPaymentStatus(s) }).toEqual({ s, screened: true });
    }
  });
});

describe('settlement + status claims are validated at draft (and therefore send: same function)', () => {
  const ctx = (extra = {}, payments = []) => ({ billing: { outstandingBalance: 0, recentPayments: payments, ...extra } });
  const rq = (r, c) => replyQuotesUngroundedAmount(r, c, { byMeaning: true });
  test.each([
    "You don't owe anything.", 'There is no balance due.', 'Nothing is due right now.', "You're all caught up.",
    'You have no outstanding balance.', 'Your balance is $0.', 'You have a $0 balance.',
  ])('"%s": grounded when nothing is owed or in flight; rejected when a balance, an open invoice or a processing payment exists', (reply) => {
    expect(rq(reply, ctx())).toBe(false);
    expect(rq(reply, ctx({ outstandingBalance: 40 }))).toBe(true);
    expect(rq(reply, ctx({ openInvoice: { amountDue: 40 } }))).toBe(true);
    expect(rq(reply, ctx({}, [{ amount: 40, status: 'processing', payment_date: '2026-09-12' }]))).toBe(true);
    expect(rq(reply, { billing: { unavailable: true } })).toBe(true);
    expect(rq(reply, {})).toBe(true);
  });

  test('"Your Zelle transfer cleared" / "Your charge posted" go to the paid-row binder; refunded-after-draft is rejected', () => {
    const paid = { amount: 120, status: 'paid', payment_date: '2026-09-12', description: 'Invoice INV-9 — zelle' };
    expect(rq('Your $120 Zelle transfer cleared on Sep 12.', ctx({}, [paid]))).toBe(false);
    expect(rq('Your $120 Zelle transfer cleared on Sep 12.', ctx({}, [{ ...paid, status: 'refunded' }]))).toBe(true);
    expect(rq('Your $120 charge posted on Sep 12.', ctx({}, [{ ...paid, payment_method_type: 'card', description: null }]))).toBe(false);
    expect(rq('Your $120 charge posted on Sep 12.', ctx({}, [{ ...paid, payment_method_type: 'card', description: null, status: 'refunded' }]))).toBe(true);
    // amount-free is never a binding claim
    expect(rq('Your Zelle transfer cleared.', ctx({}, [paid]))).toBe(true);
    expect(rq('We received your Zelle transfer.', ctx({}, [paid]))).toBe(true);
    // ...but "we've got Zelle" stays an offer, not a receipt
    expect(rq("Yes, we've got Zelle.", ctx())).toBe(false);
  });

  test('question suppression is scoped to the phrase itself (dash-split statement + question)', () => {
    expect(rq('Your payment is still processing—does that answer your question?', ctx())).toBe(true);
    expect(rq('Your payment is still processing — does that answer your question?', ctx())).toBe(true);
    expect(rq('Is your payment still processing?', ctx())).toBe(false);
    expect(rq('Did it go through?', ctx())).toBe(false);
    expect(rq('Your payment is still processing—does that answer it?', ctx({}, [{ amount: 40, status: 'processing', payment_date: '2026-09-12' }]))).toBe(false);
  });
});
