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
  if (family === 'paid') {
    if (/^(?:all set|all paid|paid in full)$/.test(phrase)) return `${subj} is ${phrase}`;
    // Literal paid-status forms are predicates of the subject ("your payment shows as paid").
    if (V.PAID_STATUS_PHRASES.includes(phrase)) return `${subj} ${phrase}`;
    return `We ${phrase} ${subj}`;
  }
  if (family === 'unpaid') return `${subj} ${phrase}`;
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
        if (family === 'not_found' || family === 'not_received' || family === 'unpaid') continue; // already negative
        for (const phrase of phrases) {
          if (family === 'paid' && (/^(?:all set|all paid|paid in full)$/.test(phrase) || V.PAID_STATUS_PHRASES.includes(phrase))) continue;
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

describe('round-13: literal paid / unpaid forms', () => {
  const ctx = (payments, extra = {}) => ({ billing: { outstandingBalance: 0, recentPayments: payments, ...extra } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const paid = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };
  test('"shows as paid" / "marked paid" / "it\'s been paid" / "is paid" are paid-family claims that bind to a current paid row', () => {
    for (const phrase of ['shows as paid', 'is marked paid', "it's been paid", 'is paid']) {
      const r = `Your $120 payment ${phrase} from Sep 12.`;
      expect({ phrase, kind: kind(`Your payment ${phrase}`) }).toEqual({ phrase, kind: 'ack' });
      expect({ phrase, ungrounded: rq(r, ctx([paid])) }).toEqual({ phrase, ungrounded: false });
      expect({ phrase, ungrounded: rq(r, ctx([{ ...paid, status: 'refunded' }])) }).toEqual({ phrase, ungrounded: true });
      expect({ phrase, ungrounded: rq(r, ctx([])) }).toEqual({ phrase, ungrounded: true });
    }
    // amount-free paid claims never name a payment
    expect(rq('This invoice is paid.', ctx([paid]))).toBe(true);
  });
  test('"is unpaid" / "hasn\'t been paid" are contradicted by a PAID row; owed figures must be owed', () => {
    const r = "Your $120 payment hasn't been paid from Sep 12.";
    expect(rq('Your $120 invoice is unpaid.', ctx([], { outstandingBalance: 120 }))).toBe(false);
    expect(rq('Your $120 invoice is unpaid.', ctx([paid], { outstandingBalance: 120 }))).toBe(true); // a paid $120 row contradicts
    expect(rq('Your $120 invoice is unpaid.', ctx([], { outstandingBalance: 50 }))).toBe(true); // $120 is not owed
    expect(rq('This invoice is unpaid.', ctx([], { outstandingBalance: 120 }))).toBe(false);
    expect(rq('This invoice is unpaid.', ctx([paid], { outstandingBalance: 120 }))).toBe(true);
    expect(rq('You have an unpaid balance of $50.', ctx([], { outstandingBalance: 50 }))).toBe(false); // owed language, untouched
    expect(r).toBeTruthy();
  });
});

// Codex round-14 P1: an unpaid/owed status assertion must bind to a CURRENT open obligation.
describe('round-14: "unpaid" needs a current open invoice or balance', () => {
  const base = { billing: { outstandingBalance: 0, recentPayments: [] } };
  const withOpen = (over = {}) => ({ billing: { ...base.billing, ...over } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const CLAIMS = ['This invoice is still unpaid.', 'Your invoice is unpaid.', "Your payment hasn't been paid.", 'Your account shows as unpaid.'];

  test('open invoice / positive balance grounds it; nothing open (voided or canceled after the draft) does not', () => {
    for (const claim of CLAIMS) {
      expect({ claim, open: rq(claim, withOpen({ outstandingBalance: 95 })) }).toEqual({ claim, open: false });
      expect({ claim, invoice: rq(claim, withOpen({ openInvoice: { amountDue: 95 } })) }).toEqual({ claim, invoice: false });
      // the void-after-draft case: the send-time recheck re-reads billing and finds nothing open
      expect({ claim, voided: rq(claim, withOpen({ outstandingBalance: 0, openInvoice: null })) }).toEqual({ claim, voided: true });
    }
  });

  test('money merely in flight is not an open obligation for an unpaid claim', () => {
    expect(rq('This invoice is unpaid.', withOpen({ hasProcessingPayment: true }))).toBe(true);
  });

  test('billing unavailable is still unknowable', () => {
    expect(rq('This invoice is unpaid.', { billing: { unavailable: true } })).toBe(true);
    expect(rq('This invoice is unpaid.', {})).toBe(true);
  });
});

// Codex round-14 P1: every status family a clause asserts must bind (or the clause is ungrounded).
describe('round-14: a clause asserting several status families is validated against ALL of them', () => {
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const row = (status, extra = {}) => ({ amount: 120, status, payment_date: '2026-09-12', payment_method_type: 'card', ...extra });
  const { paymentStatusPhraseFamilies } = V;

  test('the classifier reports every family, in table order', () => {
    expect(paymentStatusPhraseFamilies('Your payment was refunded after it failed')).toEqual(['refunded', 'failed']);
    expect(paymentStatusPhraseFamilies('Your payment was refunded')).toEqual(['refunded']);
    expect(paymentStatusPhraseFamilies('Your payment is still processing')).toEqual(['pending']);
    expect(paymentStatusPhraseFamilies('Your payment was not refunded after it failed')).toEqual(['negated']);
    expect(paymentStatusPhraseFamilies('We are processing your invoice request')).toEqual([]);
  });

  test('"refunded after it failed" is ungrounded whatever rows exist (one payment cannot be both)', () => {
    const r = 'Your payment was refunded after it failed.';
    expect(rq(r, ctx([row('refunded')]))).toBe(true);
    expect(rq(r, ctx([row('failed')]))).toBe(true);
    expect(rq(r, ctx([row('refunded'), row('failed', { payment_date: '2026-08-01' })]))).toBe(true);
    expect(rq(r, ctx([]))).toBe(true);
    // the same with a figure and a date
    const r2 = 'Your $120 payment from Sep 12 was refunded after it failed.';
    expect(rq(r2, ctx([row('refunded')]))).toBe(true);
    expect(rq(r2, ctx([row('refunded'), row('failed')]))).toBe(true);
  });

  test('other incompatible pairs are ungrounded too; a single family with its row still passes', () => {
    expect(rq('Your payment was refunded after it was disputed.', ctx([row('refunded'), row('disputed')]))).toBe(true);
    expect(rq('Your payment failed while it is still processing.', ctx([row('failed'), row('processing')]))).toBe(true);
    expect(rq('Your $120 payment from Sep 12 was refunded.', ctx([row('refunded')]))).toBe(false);
    expect(rq('Your $120 payment from Sep 12 failed.', ctx([row('failed')]))).toBe(false);
    expect(rq('Your $120 payment from Sep 12 is still processing.', ctx([row('processing')]))).toBe(false);
  });

  test('compatible pairs pass only when EACH family binds', () => {
    // refunded + reversed describe the same reversed payment
    const r = 'Your $120 payment from Sep 12 was refunded and reversed.';
    const single = 'Your $120 payment from Sep 12 was refunded, so it was reversed.';
    expect(rq(single, ctx([row('refunded')]))).toBe(false);
    expect(rq(single, ctx([row('failed')]))).toBe(true);
    expect(rq(single, ctx([]))).toBe(true);
    expect(r).toBeTruthy();
  });
});
