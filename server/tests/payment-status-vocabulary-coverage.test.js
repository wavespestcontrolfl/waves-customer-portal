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
    // invoice-subject claims bind the INVOICE's own status (round-22); payment-subject ones the payments rows
    const invs = (status, total, amountDue) => ({ invoiceStatuses: [{ id: 'i1', invoiceNumber: 'WPC-2026-0001', status, total, amountDue }] });
    expect(rq('Your $120 invoice is unpaid.', ctx([], { outstandingBalance: 120, ...invs('sent', 120, 120) }))).toBe(false);
    expect(rq('Your $120 invoice is unpaid.', ctx([paid], { outstandingBalance: 0, ...invs('paid', 120, 0) }))).toBe(true); // the invoice is paid
    expect(rq('Your $120 invoice is unpaid.', ctx([], { outstandingBalance: 50, ...invs('sent', 50, 50) }))).toBe(true); // $120 is not that invoice
    expect(rq('This invoice is unpaid.', ctx([], { outstandingBalance: 120, ...invs('sent', 120, 120) }))).toBe(false);
    expect(rq('This invoice is unpaid.', ctx([paid], { outstandingBalance: 0, ...invs('paid', 120, 0) }))).toBe(true);
    expect(rq('You have an unpaid balance of $50.', ctx([], { outstandingBalance: 50 }))).toBe(false); // owed language, untouched
    // payment-subject: still contradicted by a paid row
    expect(rq("Your payment hasn't been paid.", ctx([paid], { outstandingBalance: 120 }))).toBe(true);
    expect(rq("Your payment hasn't been paid.", ctx([], { outstandingBalance: 120 }))).toBe(false);
  });
});

// Codex round-14 P1: an unpaid/owed status assertion must bind to a CURRENT open obligation.
describe('round-14: "unpaid" needs a current open invoice or balance', () => {
  const base = { billing: { outstandingBalance: 0, recentPayments: [] } };
  const withOpen = (over = {}) => ({ billing: { ...base.billing, ...over } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const CLAIMS = ['This invoice is still unpaid.', 'Your invoice is unpaid.', "Your payment hasn't been paid.", 'Your account shows as unpaid.'];

  test('open invoice / positive balance grounds it; nothing open (voided or canceled after the draft) does not', () => {
    const invs = (status, amountDue) => ({ invoiceStatuses: [{ id: 'i1', invoiceNumber: 'WPC-2026-0001', status, total: 95, amountDue }] });
    for (const claim of CLAIMS) {
      expect({ claim, open: rq(claim, withOpen({ outstandingBalance: 95, ...invs('sent', 95) })) }).toEqual({ claim, open: false });
      expect({ claim, invoice: rq(claim, withOpen({ openInvoice: { amountDue: 95 }, ...invs('overdue', 95) })) }).toEqual({ claim, invoice: false });
      // the void-after-draft case: the send-time recheck re-reads billing and finds nothing open
      expect({ claim, voided: rq(claim, withOpen({ outstandingBalance: 0, openInvoice: null, ...invs('void', 0) })) }).toEqual({ claim, voided: true });
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

// Codex round-15 P1: amount-free NEGATED acks are denials of receipt, judged by the absence binder.
describe('round-15: amount-free negated acks ("wasn\'t processed") are checked against payment history', () => {
  const ctx = (rows, extra = {}) => ({ billing: { outstandingBalance: 0, recentPayments: rows, ...extra } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const paidRow = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };
  // verb-first denials (now in the not_received table) and ones only the generic negated-ack route catches
  const DENIALS = ["We didn't get your payment.", "We haven't seen your payment.", 'No payment received.', 'Payment has not posted.', "We don't have your payment.", 'We do not have a payment on file.'];

  test('a paid row makes the denial false (ungrounded); no matching paid row keeps it truthful', () => {
    for (const d of DENIALS) {
      expect({ d, paid: rq(d, ctx([paidRow])) }).toEqual({ d, paid: true });
      expect({ d, refunded: rq(d, ctx([{ ...paidRow, status: 'refunded' }])) }).toEqual({ d, refunded: true });
      expect({ d, none: rq(d, ctx([])) }).toEqual({ d, none: false });
      // "we don't have your payment" is a NOT-FOUND claim (a row of ANY status contradicts it); receipt denials are only contradicted by a received row
      const notFound = /don't have|do not have/.test(d);
      expect({ d, failedOnly: rq(d, ctx([{ ...paidRow, status: 'failed' }])) }).toEqual({ d, failedOnly: notFound });
    }
  });

  test('unavailable billing and unknown/incomplete history block it', () => {
    const d = 'No payment received.';
    expect(rq(d, { billing: { unavailable: true } })).toBe(true);
    expect(rq(d, ctx([], { recentPaymentsTruncated: true }))).toBe(true); // window may hide a paid row; history not loaded
    expect(rq(d, ctx([], { recentPaymentsTruncated: true, paymentHistory: null }))).toBe(true);
    // an OLDER paid row outside the window is found through the authoritative history
    expect(rq(d, ctx([], { recentPaymentsTruncated: true, paymentHistory: { rows: [paidRow], complete: true } }))).toBe(true);
    expect(rq(d, ctx([], { recentPaymentsTruncated: true, paymentHistory: { rows: [], complete: true } }))).toBe(false);
  });

  test('amount-bearing negated acks are still rejected outright', () => {
    expect(rq("Your $120 payment wasn't processed.", ctx([]))).toBe(true);
    expect(rq('No $120 payment received.', ctx([]))).toBe(true);
  });

  test('a null-status row (found-but-unknown) contradicts the denial but never grounds a paid claim', () => {
    const unknown = { amount: 120, status: null, payment_date: '2026-09-12', payment_method_type: 'card' };
    expect(rq('No payment received.', ctx([unknown]))).toBe(true);
    expect(rq("Your payment isn't showing yet.", ctx([unknown]))).toBe(true);
    expect(rq('We received your $120 payment from Sep 12.', ctx([unknown]))).toBe(true);
    expect(rq('This invoice is unpaid.', ctx([unknown], { outstandingBalance: 120 }))).toBe(true);
  });
});

// Codex round-15 P1: a reply's tender / date / amount must AGREE with the payment the customer named.
describe('round-15: a reply identity that conflicts with the inbound is ungrounded', () => {
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const card = { amount: 120, status: 'paid', payment_date: '2026-09-10', payment_method_type: 'card' };
  const zelle = { amount: 120, status: 'paid', payment_date: '2026-09-12', description: 'Invoice INV-9 — zelle' };
  const ASK = 'Did you get my $120 Zelle payment from Sep 12?';

  test('TENDER: the customer asked about Zelle; a reply that restates the card row does not bind', () => {
    expect(rq('We received your $120 card payment from Sep 10.', ctx([card]), ASK)).toBe(true);
    expect(rq('We received your $120 card payment from Sep 12.', ctx([{ ...card, payment_date: '2026-09-12' }]), ASK)).toBe(true);
    expect(rq('We received your $120 Zelle payment from Sep 12.', ctx([zelle]), ASK)).toBe(false); // agrees
  });

  test('DATE: a reply date that differs from the date the customer named is rejected, even on a real row', () => {
    const zelleSep10 = { ...zelle, payment_date: '2026-09-10' };
    expect(rq('We received your $120 Zelle payment from Sep 10.', ctx([zelleSep10]), ASK)).toBe(true);
    expect(rq('We received your $120 Zelle payment from Sep 12.', ctx([zelle]), ASK)).toBe(false);
    // year: the same month/day in a different year conflicts too
    expect(rq('We received your $120 Zelle payment from Sep 12, 2025.', ctx([{ ...zelle, payment_date: '2025-09-12' }]), 'Did you get my $120 Zelle payment from Sep 12, 2026?')).toBe(true);
  });

  test('AMOUNT: a reply amount the customer did not name is rejected', () => {
    const zelle95 = { ...zelle, amount: 95 };
    expect(rq('We received your $95 Zelle payment from Sep 12.', ctx([zelle95]), ASK)).toBe(true);
    expect(rq('We received your $120 Zelle payment from Sep 12.', ctx([zelle]), ASK)).toBe(false);
    // status + absence claims are held to the same identity
    expect(rq('Your $95 Zelle payment is still processing.', ctx([{ ...zelle95, status: 'processing' }]), ASK)).toBe(true);
    expect(rq("We don't see a $95 Zelle payment from Sep 12.", ctx([]), ASK)).toBe(true);
    expect(rq("We don't see a $120 Zelle payment from Sep 12.", ctx([card]), ASK)).toBe(false); // the prompt's required "not showing" answer
  });

  test('a reply that is silent on a field inherits the inbound (unchanged), and no inbound means no conflict', () => {
    expect(rq('We received your payment.', ctx([zelle]), ASK)).toBe(true); // amount-free receipt still never names a payment
    expect(rq('We received your $120 Zelle payment from Sep 12.', ctx([zelle]))).toBe(false);
    expect(rq('We received your $120 card payment from Sep 10.', ctx([card]))).toBe(false);
  });
});

// Codex round-17 P1: a zero-balance claim is ONE claim among others in a clause — only its span
// is blanked; every other claim, figure and price phrase still goes through the normal binders.
describe('round-17: zero-balance claims do not shield the rest of the clause', () => {
  const ctx = (rows = [], extra = {}) => ({ billing: { outstandingBalance: 0, recentPayments: rows, ...extra } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const paid500 = { amount: 500, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };

  test('the auditor sentences are ungrounded with no payments', () => {
    expect(rq('Your balance is $0 after we received your $500 payment from Sep 12.', ctx())).toBe(true);
    expect(rq('Your balance is $0 plus a fee of fifty dollars.', ctx())).toBe(true);
    expect(rq('Your balance is $0 plus a fee of $50.', ctx())).toBe(true);
  });

  test('"$0 after we received your $500 payment" is grounded only with a matching paid row', () => {
    const r = 'Your balance is $0 after we received your $500 payment from Sep 12.';
    expect(rq(r, ctx([paid500]))).toBe(false);
    expect(rq(r, ctx([{ ...paid500, status: 'refunded' }]))).toBe(true);
    expect(rq(r, ctx([{ ...paid500, amount: 400 }]))).toBe(true);
    expect(rq(r, ctx([{ ...paid500, payment_date: '2026-09-10' }]))).toBe(true);
    // ...and the zero claim itself still has to be true
    expect(rq(r, ctx([paid500], { outstandingBalance: 40 }))).toBe(true);
    expect(rq(r, ctx([paid500], { openInvoice: { amountDue: 40 } }))).toBe(true);
  });

  test('plain zero-balance claims are unchanged: clean at zero, ungrounded when anything is owed or in flight', () => {
    for (const r of ['Your balance is zero.', 'Your balance is $0.', 'You have a zero balance.', 'You have a $0.00 balance.', 'Your $0 balance is unchanged.']) {
      expect({ r, atZero: rq(r, ctx()) }).toEqual({ r, atZero: false });
      expect({ r, owed: rq(r, ctx([], { outstandingBalance: 40 })) }).toEqual({ r, owed: true });
      expect({ r, inFlight: rq(r, ctx([], { hasProcessingPayment: true })) }).toEqual({ r, inFlight: true });
    }
    expect(rq('Your balance is fifty dollars.', ctx())).toBe(true);
  });
});

// Codex round-18 P1 (STRUCTURAL): a clause is grounded only if EVERY claim in it is. The same
// short-circuit bug (first recognized claim wins) hit three different pairs in a row, so this
// table crosses EVERY pair of claim kinds: the joined clause must be ungrounded whenever either
// half is ungrounded on its own, in every context below — no pair may launder the other.
describe('round-18: every pair of claim kinds is validated independently (no short-circuit)', () => {
  const rq = (r, c) => replyQuotesUngroundedAmount(r, c, { byMeaning: true });
  const row = (status, over = {}) => ({ amount: 120, status, payment_date: '2026-09-12', payment_method_type: 'card', ...over });
  const CLAIMS = {
    ack: 'we received your $120 payment from Sep 12',
    pending: 'your $120 payment from Sep 12 is still processing',
    failed: 'your $120 payment from Sep 12 failed',
    refunded: 'your $120 payment from Sep 12 was refunded',
    disputed: 'your $120 payment from Sep 12 was disputed',
    not_received: "we haven't received your $120 payment from Sep 12",
    not_found: "we don't see a $120 payment from Sep 12",
    unpaid: 'your $95 invoice is unpaid',
    settlement: 'your account is current',
    settlement_phrase: "you're paid up",
    zero: 'your balance is $0',
    owed: 'you owe $95',
    negated_ack: 'no payment received',
  };
  const ctx = (rows = [], extra = {}) => ({ billing: { outstandingBalance: 0, recentPayments: rows, ...extra } });
  const CONTEXTS = {
    empty: ctx(),
    paid: ctx([row('paid')]),
    processing: ctx([row('processing')]),
    failed: ctx([row('failed')]),
    refunded: ctx([row('refunded')]),
    disputed: ctx([row('disputed')]),
    owed95: ctx([], { outstandingBalance: 95, openInvoice: { amountDue: 95 }, invoiceStatuses: [{ id: 'i1', invoiceNumber: 'WPC-2026-0001', status: 'sent', total: 95, amountDue: 95 }] }),
    paidAndOwed: ctx([row('paid')], { outstandingBalance: 95, invoiceStatuses: [{ id: 'i1', invoiceNumber: 'WPC-2026-0001', status: 'sent', total: 95, amountDue: 95 }] }),
    everything: ctx([row('paid'), row('processing'), row('failed'), row('refunded'), row('disputed')], { outstandingBalance: 95, hasProcessingPayment: true, invoiceStatuses: [{ id: 'i1', invoiceNumber: 'WPC-2026-0001', status: 'sent', total: 95, amountDue: 95 }] }),
  };
  const alone = (name, c) => rq(`${CLAIMS[name][0].toUpperCase()}${CLAIMS[name].slice(1)}.`, c);
  const joined = (a, b) => `${CLAIMS[a][0].toUpperCase()}${CLAIMS[a].slice(1)} while ${CLAIMS[b]}.`;
  const names = Object.keys(CLAIMS);

  test('the table really covers every claim kind (each is recognized on its own)', () => {
    for (const n of names) expect({ n, claims: drafterEnumerate(CLAIMS[n]).length > 0 }).toEqual({ n, claims: true });
  });

  test('joined ungrounded whenever EITHER half is ungrounded alone, in every context', () => {
    const failures = [];
    for (const a of names) {
      for (const b of names) {
        if (a === b) continue;
        for (const [cname, c] of Object.entries(CONTEXTS)) {
          const expectUngrounded = alone(a, c) || alone(b, c);
          if (expectUngrounded && !rq(joined(a, b), c)) failures.push(`${a} + ${b} in ${cname}: "${joined(a, b)}"`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('consistent pairs are still grounded (the enumerator is not simply rejecting every multi-claim clause)', () => {
    expect(rq('Your account is current while your balance is $0.', ctx())).toBe(false);
    expect(rq("You're paid up while your balance is zero.", ctx())).toBe(false);
    expect(rq('We received your $120 payment from Sep 12 while your balance is $0.', ctx([row('paid')]))).toBe(false);
    expect(rq('We received your $120 payment from Sep 12 while your balance is $0.', ctx([row('paid')], { outstandingBalance: 40 }))).toBe(true);
    expect(rq("We haven't received your $120 payment from Sep 12 while you owe $95.", ctx([], { outstandingBalance: 95 }))).toBe(false);
  });

  test('the three shapes the auditor found, plus their mirror images', () => {
    const inFlight = ctx([row('processing')], { outstandingBalance: 95 });
    expect(rq('Your account is current while your payment is processing.', inFlight)).toBe(true);
    expect(rq('Your payment is processing while your account is current.', inFlight)).toBe(true);
    expect(rq('We received your $120 payment from Sep 12 while it is processing.', ctx())).toBe(true);
    expect(rq('Your balance is $0 after we received your $500 payment from Sep 12.', ctx())).toBe(true);
    expect(rq('Your payment was refunded after it failed.', ctx([row('refunded')]))).toBe(true);
  });
});
function drafterEnumerate(text) {
  return require('../services/sms-shadow-drafter').enumeratePaymentClaims(text, {}).claims;
}

// Codex round-16 P1: every event-status stem the positive grammar recognizes has its negated denial forms,
// generated from the SAME stem list (EVENT_STATUS_STEMS).
describe('round-16: negated event-status verbs are denials of receipt (one stem list)', () => {
  const { EVENT_STATUS_STEMS, NEGATED_EVENT_PHRASES, PAYMENT_STATUS_VOCABULARY } = V;
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const rq = (r, c) => replyQuotesUngroundedAmount(r, c, { byMeaning: true });
  const paidRow = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };
  const drafter = require('../services/sms-shadow-drafter');

  test('every stem yields denial phrases, and every denial phrase is a not_received phrase', () => {
    for (const st of EVENT_STATUS_STEMS) {
      const word = st.past || st.adjective;
      if (!word) continue; // "processed": negations are negated pending-family claims (fail closed already)
      expect({ word, has: NEGATED_EVENT_PHRASES.some((p) => p.endsWith(word)) }).toEqual({ word, has: true });
    }
    for (const p of NEGATED_EVENT_PHRASES) expect(PAYMENT_STATUS_VOCABULARY.not_received.phrases).toContain(p);
  });

  test('each denial: a PAID row makes it false (ungrounded); a truthful denial (no paid row) is grounded', () => {
    const failures = [];
    for (const phrase of NEGATED_EVENT_PHRASES) {
      const sentence = `Your payment ${phrase}.`;
      if (!rq(sentence, ctx([paidRow]))) failures.push(`paid row: ${sentence}`);
      if (!rq(sentence, ctx([{ ...paidRow, status: 'refunded' }]))) failures.push(`refunded row: ${sentence}`);
      if (rq(sentence, ctx([]))) failures.push(`no rows (truthful) blocked: ${sentence}`);
      if (rq(sentence, ctx([{ ...paidRow, status: 'failed' }]))) failures.push(`failed row (truthful) blocked: ${sentence}`);
    }
    expect(failures).toEqual([]);
  });

  test('the auditor phrasings, by name', () => {
    for (const s of ['Your payment did not clear.', "Your payment didn't clear.", 'Your payment was not successful.', "Your payment wasn't successful.",
      "Your payment didn't complete.", "Your payment hasn't gone through.", "Your payment didn't post."]) {
      expect({ s, paid: rq(s, ctx([paidRow])) }).toEqual({ s, paid: true });
    }
    expect(rq("Your payment didn't go through.", ctx([paidRow]))).toBe(true); // failed-family claim, no failed row
  });

  test('positive event grammar still recognizes every stem as a receipt claim', () => {
    for (const s of ['Your payment cleared.', 'Your payment posted.', 'Your payment went through.', 'Your payment was successful.', 'Your payment is complete.', 'Your payment was processed.']) {
      expect({ s, claims: drafter.enumeratePaymentClaims(s, {}).claims.length > 0 }).toEqual({ s, claims: true });
    }
  });
});

// Codex round-16 P1: partial refunds keep status 'paid' (+ refund_status 'partial', refund_amount).
describe('round-16: a partially refunded row is not a plain paid payment', () => {
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const base = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };
  const partial = { ...base, refund_status: 'partial', refund_amount: 30 };

  test('plain paid / received claims do not bind to a partially refunded row (conservative)', () => {
    expect(rq('We received your $120 payment from Sep 12.', ctx([base]))).toBe(false);
    expect(rq('We received your $120 payment from Sep 12.', ctx([partial]))).toBe(true);
    expect(rq('Your $120 payment from Sep 12 is paid.', ctx([partial]))).toBe(true);
    expect(rq('Your $120 payment from Sep 12 is paid.', ctx([base]))).toBe(false);
    // detected by refund_amount < amount too, and by the flag alone
    expect(rq('We received your $120 payment from Sep 12.', ctx([{ ...base, refund_status: null, refund_amount: 30 }]))).toBe(true);
    expect(rq('We received your $120 payment from Sep 12.', ctx([{ ...base, refund_status: 'partial', refund_amount: null }]))).toBe(true);
  });

  test('a REFUNDED claim IS grounded by it (by the payment amount, or the refunded amount)', () => {
    expect(rq('Your $120 payment from Sep 12 was partially refunded.', ctx([partial]))).toBe(false);
    expect(rq('Your $120 payment from Sep 12 was partially refunded.', ctx([base]))).toBe(true);
    expect(rq('$30 of your $120 payment from Sep 12 was refunded.', ctx([partial]))).toBe(false);
    expect(rq('$50 of your $120 payment from Sep 12 was refunded.', ctx([partial]))).toBe(true); // not the actual refund amount
    expect(rq('Your $120 payment from Sep 12 was partially refunded.', ctx([{ ...partial, payment_date: '2026-09-01' }]))).toBe(true);
  });

  test('it still contradicts absence / unpaid claims (money was received)', () => {
    expect(rq("We haven't received your $120 payment from Sep 12.", ctx([partial]))).toBe(true);
    expect(rq("We don't see a $120 payment from Sep 12.", ctx([partial]))).toBe(true);
  });

  test('a fully refunded row (status refunded) is unchanged: refunded claim ok, paid claim not', () => {
    const full = { ...base, status: 'refunded', refund_status: 'full', refund_amount: 120 };
    expect(rq('Your $120 payment from Sep 12 was refunded.', ctx([full]))).toBe(false);
    expect(rq('We received your $120 payment from Sep 12.', ctx([full]))).toBe(true);
  });
});

// Codex round-17 P1 #1: partial vs full refund wording binds the matching row kind only.
describe('round-17: unqualified "refunded" binds fully refunded rows only; partial wording binds partial rows only', () => {
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const rq = (r, c) => replyQuotesUngroundedAmount(r, c, { byMeaning: true });
  const base = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };
  const partial = { ...base, refund_status: 'partial', refund_amount: 30 };
  const full = { ...base, status: 'refunded', refund_status: 'full', refund_amount: 120 };
  test('unqualified "was refunded"', () => {
    expect(rq('Your $120 payment from Sep 12 was refunded.', ctx([full]))).toBe(false);
    expect(rq('Your $120 payment from Sep 12 was refunded.', ctx([partial]))).toBe(true);
    expect(rq('Your $120 payment from Sep 12 has been refunded.', ctx([partial]))).toBe(true);
    expect(rq('Your $120 payment from Sep 12 was reversed.', ctx([partial]))).toBe(true);
  });
  test('explicitly partial wording (with the actual refund amount)', () => {
    for (const r of ['Your $120 payment from Sep 12 was partially refunded.', 'Part of your $120 payment from Sep 12 was refunded.', '$30 of your $120 payment from Sep 12 was refunded.']) {
      expect({ r, partialRow: rq(r, ctx([partial])) }).toEqual({ r, partialRow: false });
      expect({ r, fullRow: rq(r, ctx([full])) }).toEqual({ r, fullRow: true });
      expect({ r, plainRow: rq(r, ctx([base])) }).toEqual({ r, plainRow: true });
    }
    expect(rq('$50 of your $120 payment from Sep 12 was refunded.', ctx([partial]))).toBe(true); // wrong refund amount
  });
});

// Codex round-17 P1 #2: bare "bank" and other tenders the customer names must not let a card row bind.
describe('round-17: the customer\'s named tender decides the row, including bare bank / bill pay / non-card tenders', () => {
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const card = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };
  const bank = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'us_bank_account' };
  const REPLY = 'We received your $120 payment from Sep 12.';
  const ask = (how) => `Did you get my $120 payment? I paid ${how}.`;

  test.each(['through my bank', 'with my bank', 'using online banking', 'by bill pay', 'via online bill pay', 'by bank'])('bank-like "%s" binds bank/ACH rows, never a card row', (how) => {
    expect(rq(REPLY, ctx([card]), ask(how))).toBe(true);
    expect(rq(REPLY, ctx([bank]), ask(how))).toBe(false);
    expect(rq(REPLY, ctx([card, bank]), ask(how))).toBe(false); // the bank row is the one that binds
  });
  test.each(['by wire transfer', 'by money order', 'with a gift card', 'via Western Union', 'in bitcoin', 'with Cash App'])('non-card tender "%s" can never bind a card or bank row', (how) => {
    expect(rq(REPLY, ctx([card]), ask(how))).toBe(true);
    expect(rq(REPLY, ctx([bank]), ask(how))).toBe(true);
  });
  test('card brands and kinds still read as a card', () => {
    for (const how of ['with my Visa', 'on my debit card', 'with a credit card', 'with my Mastercard', 'with Amex']) {
      expect({ how, card: rq(REPLY, ctx([card]), ask(how)) }).toEqual({ how, card: false });
      expect({ how, bank: rq(REPLY, ctx([bank]), ask(how)) }).toEqual({ how, bank: true });
    }
  });
  test('an absence claim about the named tender is not contradicted by a row of another tender', () => {
    expect(rq("We don't see a $120 payment from Sep 12 through your bank.", ctx([card]), ask('through my bank'))).toBe(false);
    expect(rq("We don't see a $120 payment from Sep 12 through your bank.", ctx([bank]), ask('through my bank'))).toBe(true);
  });
});

// Codex round-17 P1 #3: an anaphoric continuation inherits the row the previous payment clause bound.
describe('round-17: "...but it was refunded" — continuations bind to the SAME row (shared by draft and send)', () => {
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const rq = (r, c) => replyQuotesUngroundedAmount(r, c, { byMeaning: true });
  const base = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };
  const partial = { ...base, refund_status: 'partial', refund_amount: 30 };
  const unrelatedRefunded = { amount: 45, status: 'refunded', payment_date: '2026-08-01', payment_method_type: 'card' };
  const unrelatedFailed = { amount: 45, status: 'failed', payment_date: '2026-08-01', payment_method_type: 'card' };
  const unrelatedProcessing = { amount: 45, status: 'processing', payment_date: '2026-08-01', payment_method_type: 'card' };
  const R = 'We received your $120 payment from Sep 12';

  test('the auditor case: paid row + an UNRELATED refunded row is ungrounded (was: grounded)', () => {
    for (const joiner of [', but it was refunded.', ' but it was refunded.', ', however it was refunded.', ', and it was refunded.', '. However, that was refunded.', '. That was refunded.', ', but that was refunded.']) {
      expect({ joiner, r: rq(`${R}${joiner}`, ctx([base, unrelatedRefunded])) }).toEqual({ joiner, r: true });
    }
  });
  test('one row that is BOTH received and (partially) refunded grounds it — with the partial wording', () => {
    for (const joiner of [', but it was partially refunded.', ', however it was partially refunded.', ', and part of it was refunded.', ', but $30 of it was refunded.']) {
      expect({ joiner, r: rq(`${R}${joiner}`, ctx([partial])) }).toEqual({ joiner, r: false });
      expect({ joiner, plain: rq(`${R}${joiner}`, ctx([base, unrelatedRefunded])) }).toEqual({ joiner, plain: true });
    }
    // unqualified "it was refunded" about a partially refunded row stays ungrounded (round-17 #1)
    expect(rq(`${R}, but it was refunded.`, ctx([partial]))).toBe(true);
  });
  test('other continuation families bind to the antecedent row too', () => {
    expect(rq('Your $120 payment from Sep 12 is still processing, but it failed.', ctx([{ ...base, status: 'processing' }, { ...base, status: 'failed' }]))).toBe(true);
    expect(rq('Your $120 payment from Sep 12 is processing, and it is processing.', ctx([{ ...base, status: 'processing' }]))).toBe(false);
    expect(rq('Your $120 payment from Sep 12 failed, however it was refunded.', ctx([{ ...base, status: 'failed' }, unrelatedRefunded]))).toBe(true);
    expect(rq('Your $120 payment from Sep 12 is processing, but it failed.', ctx([{ ...base, status: 'processing' }, unrelatedFailed]))).toBe(true);
    expect(rq('Your $120 payment from Sep 12 failed, and it is still processing.', ctx([{ ...base, status: 'failed' }, unrelatedProcessing]))).toBe(true);
  });
  test('an anaphoric clause with NO antecedent is ungrounded', () => {
    expect(rq('It was refunded.', ctx([unrelatedRefunded]))).toBe(true);
    expect(rq('The payment was refunded.', ctx([unrelatedRefunded]))).toBe(true);
    // a bare pronoun clause is read as a payment claim when the customer's message is about a payment
    const asked = 'Did my payment go through?';
    const rqAsked = (r, c) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage: asked });
    expect(rqAsked('That failed.', ctx([unrelatedFailed]))).toBe(true);
    expect(rqAsked('Thanks for your patience, it is still processing.', ctx([unrelatedProcessing]))).toBe(true);
  });
  test('non-anaphoric clauses (own figure / date / "your payment") are unchanged', () => {
    expect(rq('Your payment was refunded.', ctx([unrelatedRefunded]))).toBe(false);
    expect(rq('Your $45 payment from Aug 1 was refunded.', ctx([unrelatedRefunded]))).toBe(false);
    expect(rq('We received your $120 payment from Sep 12, but your $45 payment from Aug 1 was refunded.', ctx([base, unrelatedRefunded]))).toBe(false);
  });
  test('send time uses the same enumerator: "it failed" after a payment claim counts as a payment claim', () => {
    const { enumeratePaymentClaims } = require('../services/sms-shadow-drafter');
    expect(enumeratePaymentClaims('it failed', { paymentContext: true }).claims.map((c) => c.kind)).toEqual(['status']);
    expect(enumeratePaymentClaims('it failed', {}).claims).toEqual([]);
  });
});

// Codex round-18 P1: every claim in one clause must hold for ONE row — the receipt included.
describe('round-18: a receipt and another status in the same clause bind the SAME row', () => {
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const rq = (r, c) => replyQuotesUngroundedAmount(r, c, { byMeaning: true });
  const row = (status, over = {}) => ({ amount: 120, status, payment_date: '2026-09-12', payment_method_type: 'card', ...over });
  const R = 'We received your $120 card payment from Sep 12';
  test('paid row + a SEPARATE processing row (same amount/date/tender) does not launder "received ... while it is processing"', () => {
    expect(rq(`${R} while it is processing.`, ctx([row('paid'), row('processing')]))).toBe(true);
    expect(rq(`${R} while it is processing.`, ctx([row('processing')]))).toBe(true);
    expect(rq(`${R} while it is processing.`, ctx([row('paid')]))).toBe(true);
  });
  test('received + failed / refunded / disputed in one clause are never one row either', () => {
    for (const status of ['failed', 'refunded', 'disputed']) {
      const claim = { failed: 'it failed', refunded: 'it was refunded', disputed: 'it was disputed' }[status];
      expect({ status, r: rq(`${R} while ${claim}.`, ctx([row('paid'), row(status)])) }).toEqual({ status, r: true });
    }
  });
  test('the one legitimate combination: received + PARTIALLY refunded on a single paid row', () => {
    const partial = row('paid', { refund_status: 'partial', refund_amount: 30 });
    expect(rq(`${R} while part of it was refunded.`, ctx([partial]))).toBe(false);
    expect(rq(`${R} while part of it was refunded.`, ctx([row('paid')]))).toBe(true);
  });
  test('a receipt alone binds its paid row — when that row is the only one with the identity', () => {
    expect(rq(`${R}.`, ctx([row('paid')]))).toBe(false);
    expect(rq(`${R}.`, ctx([row('paid'), row('processing', { amount: 45 })]))).toBe(false); // different identity
    expect(rq(`${R}.`, ctx([row('paid'), row('processing', { payment_date: '2026-09-01' })]))).toBe(false);
    // ...but a paid and a processing row with the SAME identity are indistinguishable (round-19 P1)
    expect(rq(`${R}.`, ctx([row('paid'), row('processing')]))).toBe(true);
  });
});

// Codex round-18 P1: one tender resolver over both writers' shapes (metadata.payment_method AND metadata.method).
describe('round-18: manual-writer tenders (metadata.method) resolve to a tender', () => {
  const { paymentTenderLabel } = require('../services/sms-shadow-drafter');
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  // annual prepay (admin-customers.js): description "Invoice X - annual prepay (zelle)", metadata.method
  const prepay = (method, over = {}) => ({
    amount: 480, status: 'paid', payment_date: '2026-09-12',
    description: `Invoice INV-77 - annual prepay (${method.replace(/_/g, ' ')})`,
    metadata: JSON.stringify({ source: 'customer360_annual_prepay', method, invoice_id: 'i-1' }), ...over,
  });
  // account credit prepayment: description "Account credit prepayment — zelle (note)", metadata.method
  const credit = (method) => ({
    amount: 200, status: 'paid', payment_date: '2026-09-12',
    description: `Account credit prepayment — ${method} (thanks)`,
    metadata: { source: 'account_credit_prepayment', method },
  });
  test('the allowlisted methods resolve; "other" and unknown values name no tender', () => {
    expect(paymentTenderLabel(prepay('zelle'))).toBe('Zelle');
    expect(paymentTenderLabel(prepay('check'))).toBe('Check');
    expect(paymentTenderLabel(prepay('cash'))).toBe('Cash');
    expect(paymentTenderLabel(prepay('venmo'))).toBe('Venmo');
    expect(paymentTenderLabel(prepay('paypal'))).toBe('PayPal');
    expect(paymentTenderLabel(prepay('card_present'))).toBe('card');
    expect(paymentTenderLabel(prepay('other'))).toBeNull();
    expect(paymentTenderLabel(prepay('bitcoin'))).toBeNull(); // not on the writers' allowlist
    expect(paymentTenderLabel(credit('zelle'))).toBe('Zelle');
    expect(paymentTenderLabel(credit('check'))).toBe('Check');
    expect(paymentTenderLabel({ ...prepay('zelle'), metadata: 'not json' })).toBeNull();
  });
  test('the gateway shape (metadata.payment_method) still wins and is unchanged', () => {
    expect(paymentTenderLabel({ amount: 1, status: 'paid', metadata: { payment_method: 'us_bank_account' } })).toBe('bank/ACH');
    expect(paymentTenderLabel({ amount: 1, status: 'paid', metadata: { payment_method: 'card', method: 'zelle' } })).toBe('card');
  });
  test('a recorded Zelle annual prepay binds the customer\'s named Zelle payment; a check prepay does not', () => {
    const ask = 'Did you get my $480 Zelle payment from Sep 12?';
    const reply = 'We received your $480 Zelle payment from Sep 12.';
    expect(rq(reply, { billing: { outstandingBalance: 0, recentPayments: [prepay('zelle')] } }, ask)).toBe(false);
    expect(rq(reply, { billing: { outstandingBalance: 0, recentPayments: [prepay('check')] } }, ask)).toBe(true);
    expect(rq('We received your $200 Zelle payment from Sep 12.', { billing: { outstandingBalance: 0, recentPayments: [credit('zelle')] } }, 'Did you get my $200 Zelle payment?')).toBe(false);
  });
  test('gate-on facts render "via <tender>" for both writers\' rows', () => {
    const { buildFactsBlock } = require('../services/sms-shadow-drafter');
    process.env.GATE_SMS_REAL_ANSWERS = 'true';
    try {
      const block = buildFactsBlock({ summary: 'T', billing: { outstandingBalance: 0, recentPayments: [prepay('zelle'), credit('check')] } }, { now: new Date('2026-09-29T15:00:00Z') });
      expect(block).toMatch(/\$480\.00 paid [^;]*Sep 12 via Zelle/);
      expect(block).toMatch(/\$200\.00 paid [^;]*Sep 12 via Check/);
    } finally { delete process.env.GATE_SMS_REAL_ANSWERS; }
  });
});

// Codex round-18 P1: correct payment-policy answers from COMPANY FACTS are not payment-claim fabrications.
describe('round-18: COMPANY FACTS payment policy answers pass the deterministic checks', () => {
  const rq = (r) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: [] } }, { byMeaning: true });
  test('"You can mail us a check" and "We don\'t accept cash" are not ungrounded payment claims', () => {
    expect(rq('You can mail us a check.')).toBe(false);
    expect(rq("We don't accept cash.")).toBe(false);
    expect(rq('Technicians accept cards at the visit, never cash.')).toBe(false);
  });
});

// Codex round-19 P1: identity ambiguity is judged across EVERY status before a status claim picks its family.
describe('round-19: rows with the same identity but conflicting statuses make a status claim ungrounded', () => {
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const row = (status, over = {}) => ({ amount: 120, status, payment_date: '2026-09-12', payment_method_type: 'card', ...over });
  const FAILED = 'Your $120 card payment from Sep 12 failed.';
  const PAID = 'We received your $120 card payment from Sep 12.';
  const PROCESSING = 'Your $120 card payment from Sep 12 is still processing.';

  test('a failed + a paid attempt (either order): neither "failed" nor "received" binds', () => {
    for (const rows of [[row('failed'), row('paid')], [row('paid'), row('failed')]]) {
      expect(rq(FAILED, ctx(rows))).toBe(true);
      expect(rq(PAID, ctx(rows))).toBe(true);
    }
  });
  test('failed + processing, and refunded + paid, are ambiguous too', () => {
    for (const rows of [[row('failed'), row('processing')], [row('processing'), row('failed')]]) {
      expect(rq(FAILED, ctx(rows))).toBe(true);
      expect(rq(PROCESSING, ctx(rows))).toBe(true);
    }
    expect(rq('Your $120 card payment from Sep 12 was refunded.', ctx([row('refunded'), row('paid')]))).toBe(true);
  });
  test('a genuine single-status case is unchanged', () => {
    expect(rq(FAILED, ctx([row('failed')]))).toBe(false);
    expect(rq(PAID, ctx([row('paid')]))).toBe(false);
    expect(rq(FAILED, ctx([row('failed'), row('paid', { payment_date: '2026-09-10' })]))).toBe(false); // different date
    expect(rq(FAILED, ctx([row('failed'), row('paid', { amount: 45 })]))).toBe(false); // different amount
    expect(rq(FAILED, ctx([row('failed'), row('paid', { payment_method_type: 'us_bank_account' })]))).toBe(false); // different tender named
    expect(rq(FAILED, ctx([row('failed'), row('failed')]))).toBe(false); // same family twice is not a conflict
  });
  test('an inbound naming the tender/date resolves what the reply left open', () => {
    const asked = 'Why did my $120 card payment from Sep 12 fail?';
    expect(rq('Your $120 payment failed.', ctx([row('failed'), row('paid', { payment_method_type: 'us_bank_account' })]), asked)).toBe(false);
    expect(rq('Your $120 payment failed.', ctx([row('failed'), row('paid')]), asked)).toBe(true);
  });
  test('absence claims are not affected (any matching row contradicts them anyway)', () => {
    expect(rq("We haven't received your $120 card payment from Sep 12.", ctx([row('failed'), row('paid')]))).toBe(true);
    expect(rq("We haven't received your $120 card payment from Sep 12.", ctx([row('failed')]))).toBe(false);
  });
});

// Codex round-20 P1: wallets settle as CARD payments (Stripe paymentMethod='card'); genuinely non-Stripe tenders stay non-card.
describe('round-20: Apple / Google / Samsung Pay carry the card identity', () => {
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const card = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card', metadata: { payment_method: 'card' } };
  const bank = { ...card, payment_method_type: 'us_bank_account', metadata: { payment_method: 'us_bank_account' } };
  const { paymentIdentityFromText } = require('../services/sms-shadow-drafter');
  test.each(['Apple Pay', 'Google Pay', 'Samsung Pay'])('%s: a receipt binds the card row (inbound or reply names it), never a bank row', (wallet) => {
    const ask = `Did you get my $120 payment? I paid with ${wallet}.`;
    expect(paymentIdentityFromText(ask).tender).toBe('card');
    expect(rq('We received your $120 payment from Sep 12.', ctx([card]), ask)).toBe(false);
    expect(rq('We received your $120 payment from Sep 12.', ctx([bank]), ask)).toBe(true);
    expect(rq(`We received your $120 ${wallet} payment from Sep 12.`, ctx([card]))).toBe(false);
    expect(rq(`We received your $120 ${wallet} payment from Sep 12.`, ctx([bank]))).toBe(true);
  });
  test('absence: "we don\'t see your Apple Pay payment" is contradicted by a card row (it is not passed through)', () => {
    const ask = 'Did you get my $120 Apple Pay payment from Sep 12?';
    expect(rq("We don't see a $120 payment from Sep 12.", ctx([card]), ask)).toBe(true);
    expect(rq("We don't see a $120 payment from Sep 12.", ctx([bank]), ask)).toBe(false);
    expect(rq("We haven't received your $120 payment from Sep 12.", ctx([card]), ask)).toBe(true);
  });
  test('genuinely non-Stripe tenders stay non-card: Cash App, wire, money order, crypto, gift card', () => {
    for (const how of ['with Cash App', 'by wire transfer', 'by money order', 'in bitcoin', 'with a gift card']) {
      const ask = `Did you get my $120 payment? I paid ${how}.`;
      expect({ how, card: rq('We received your $120 payment from Sep 12.', ctx([card]), ask) }).toEqual({ how, card: true });
    }
  });
});

// Codex round-20 P1: refund-subject completion forms are refunded-family claims (derived from the shared event stems).
describe('round-20: "Your refund was processed / posted / went through / was issued / completed"', () => {
  const V2 = require('../services/payment-receipt-vocabulary');
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const base = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };
  const full = { ...base, status: 'refunded', refund_status: 'full', refund_amount: 120 };
  const partial = { ...base, refund_status: 'partial', refund_amount: 30 };
  const FORMS = ['was processed', 'has been processed', 'posted', 'went through', 'was issued', 'has been issued', 'completed', 'was completed', 'is complete', 'cleared', 'was successful', 'was sent'];

  test('every completion form is recognized as a refunded claim (one shared stem list)', () => {
    for (const f of FORMS) {
      const m = V2.paymentStatusPhraseMatches(`Your refund ${f}.`, false);
      expect({ f, families: [...new Set(m.matches.map((x) => x.family))], negated: m.negated }).toEqual({ f, families: ['refunded'], negated: false });
    }
    // the event stems the payment grammar uses also derive the refund forms
    for (const st of V2.EVENT_STATUS_STEMS.filter((x) => x.past)) {
      expect({ st: st.past, re: V2.REFUND_COMPLETION_RE.test(`refund ${st.past}`) || V2.REFUND_COMPLETION_RE.test(`refund ${st.pattern.replace(/\\s\+/g, ' ')}`) }).toEqual({ st: st.past, re: true });
    }
  });
  test('binds a CURRENT refunded row; nothing else grounds it', () => {
    for (const f of FORMS) {
      const r = `Your refund ${f}.`;
      expect({ f, full: rq(r, ctx([full])) }).toEqual({ f, full: false });
      expect({ f, paid: rq(r, ctx([base])) }).toEqual({ f, paid: true });
      expect({ f, none: rq(r, ctx([])) }).toEqual({ f, none: true });
      expect({ f, failed: rq(r, ctx([{ ...base, status: 'failed' }])) }).toEqual({ f, failed: true });
    }
  });
  test('amounts: the figure is the REFUNDED amount — a partial refund matches its refund amount, a full one its total', () => {
    expect(rq('Your $120 refund was issued.', ctx([full]))).toBe(false);
    expect(rq('Your $30 refund was issued.', ctx([partial]))).toBe(false);
    expect(rq('Your refund of $30 went through.', ctx([partial]))).toBe(false);
    expect(rq('Your $120 refund was issued.', ctx([partial]))).toBe(true); // that isn't what was refunded
    expect(rq('Your $30 refund was issued.', ctx([full]))).toBe(true);
    expect(rq('Your refund was processed.', ctx([partial]))).toBe(true); // unqualified => full refunds only
    expect(rq('Your refund was partially processed.', ctx([partial]))).toBe(false);
  });
  test('a DENIAL ("hasn\'t posted") stays a denial, not a completion claim', () => {
    expect(V2.paymentStatusPhraseMatches("Your refund hasn't posted yet.", false).matches.map((m) => m.family)).toEqual(['not_received']);
    expect(rq("Your refund hasn't posted yet.", ctx([]))).toBe(false);
    expect(rq("Your refund hasn't posted yet.", ctx([full]))).toBe(true);
  });
  test('unrelated refund wording is not a completion claim', () => {
    expect(V2.paymentStatusPhraseMatches('You can request a refund by replying here.', false).matches).toEqual([]);
  });
});

// Codex round-20 P1: invoice / bill status statements bind to the authoritative INVOICE status.
describe('round-20: "Your invoice is still processing / failed / pending", "your bill is paid"', () => {
  const rq = (r, list, inboundMessage) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: [], invoiceStatuses: list } }, { byMeaning: true, inboundMessage });
  const inv = (status, over = {}) => ({ id: `i-${status}`, invoiceNumber: 'WPC-2026-0101', status, total: 120, amountDue: status === 'sent' ? 120 : 0, ...over });
  const other = inv('sent', { id: 'i-2', invoiceNumber: 'WPC-2026-0202', total: 45, amountDue: 45 });

  test('a status statement binds to the invoice status, not a payments row', () => {
    expect(rq('Your invoice is still processing.', [inv('processing')])).toBe(false);
    expect(rq('Your invoice is pending.', [inv('processing')])).toBe(false);
    expect(rq('Your invoice is still processing.', [inv('sent')])).toBe(true);
    expect(rq('Your bill is paid.', [inv('paid')])).toBe(false);
    expect(rq('Your bill is paid.', [inv('prepaid')])).toBe(false);
    expect(rq('Your bill is paid.', [inv('sent')])).toBe(true);
    expect(rq('Your invoice was refunded.', [inv('refunded')])).toBe(false);
    expect(rq('Your invoice was refunded.', [inv('paid')])).toBe(true);
  });
  test('"failed" is never an invoice status: it is ungrounded whatever the invoice', () => {
    for (const status of ['processing', 'sent', 'paid', 'overdue', 'void']) expect({ status, r: rq('Your invoice failed.', [inv(status)]) }).toEqual({ status, r: true });
  });
  test('identification: by number, then by amount; several candidates with no identifier is ambiguous; unknown state fails closed', () => {
    const list = [inv('processing'), other];
    expect(rq('Your invoice is still processing.', list)).toBe(true); // which one?
    expect(rq('Your invoice WPC-2026-0101 is still processing.', list)).toBe(false);
    expect(rq('Your $120 invoice is still processing.', list)).toBe(false);
    expect(rq('Your $45 invoice is still processing.', list)).toBe(true);
    expect(rq('Your invoice is still processing.', list, 'Is invoice 0101 still processing?')).toBe(false); // the customer's own reference
    expect(rq('Your invoice WPC-2026-0999 is still processing.', list)).toBe(true); // names none
    expect(rq('Your invoice is still processing.', undefined)).toBe(true);
    expect(rq('Your invoice is still processing.', null)).toBe(true);
    expect(rq('Your invoice is still processing.', [])).toBe(true);
  });
  test('a payment-subject clause is unchanged (still binds a payments row)', () => {
    const paymentsCtx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows, invoiceStatuses: [inv('sent')] } });
    const processing = { amount: 120, status: 'processing', payment_date: '2026-09-12', payment_method_type: 'card' };
    expect(replyQuotesUngroundedAmount('Your $120 payment for the invoice is still processing.', paymentsCtx([processing]), { byMeaning: true })).toBe(false);
    expect(replyQuotesUngroundedAmount('Your $120 payment for the invoice is still processing.', paymentsCtx([]), { byMeaning: true })).toBe(true);
  });
});

// Codex round-21 P1: an identity-free status claim ("my payment") is about the MOST RECENT payment.
describe('round-21: amount-free, date-free, tender-free status claims are judged against the most recent payment', () => {
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const row = (status, date, over = {}) => ({ amount: 100 + Number(date.slice(-2)), status, payment_date: date, payment_method_type: 'card', ...over });
  const ASK = 'Did my payment go through?';
  const newerPaidOlderProcessing = [row('paid', '2026-09-20'), row('processing', '2026-09-10')];

  test('the auditor case: a newer paid row + an older processing row => "is processing" is FALSE (was: bound the older row)', () => {
    expect(rq('Your payment is processing.', ctx(newerPaidOlderProcessing), ASK)).toBe(true);
    expect(rq('Your payment is still processing.', ctx(newerPaidOlderProcessing))).toBe(true);
    expect(rq('Your payment failed.', ctx(newerPaidOlderProcessing), ASK)).toBe(true);
    // ...and the mirror: the NEWEST is the processing one
    expect(rq('Your payment is processing.', ctx([row('processing', '2026-09-20'), row('paid', '2026-09-10')]), ASK)).toBe(false);
  });
  test('row order does not matter — recency comes from the payment date', () => {
    expect(rq('Your payment is processing.', ctx([...newerPaidOlderProcessing].reverse()), ASK)).toBe(true);
    expect(rq('Your payment is processing.', ctx([row('paid', '2026-09-10'), row('processing', '2026-09-20')]), ASK)).toBe(false);
  });
  test('rows tied for the newest date with conflicting statuses are ambiguous => ungrounded', () => {
    const tied = [row('paid', '2026-09-20', { amount: 50 }), row('processing', '2026-09-20', { amount: 60 })];
    expect(rq('Your payment is processing.', ctx(tied), ASK)).toBe(true);
    expect(rq('Your payment failed.', ctx([row('failed', '2026-09-20', { amount: 50 }), row('paid', '2026-09-20', { amount: 60 })]), ASK)).toBe(true);
    expect(rq('Your payment is processing.', ctx([row('processing', '2026-09-20', { amount: 50 }), row('processing', '2026-09-20', { amount: 60 })]), ASK)).toBe(false); // same family
  });
  test('a single payment, or an explicit identity, is unchanged', () => {
    expect(rq('Your payment is processing.', ctx([row('processing', '2026-09-10')]), ASK)).toBe(false);
    expect(rq('Your payment failed.', ctx([row('failed', '2026-09-10')]), ASK)).toBe(false);
    // an explicit date/amount/tender in the reply or the inbound switches to the identity rule (older row is fine)
    // (round-27: with a GENERIC inbound the reply may not reach back to an older payment on its own — see below)
    expect(rq('Your $110 payment from Sep 10 is processing.', ctx(newerPaidOlderProcessing), ASK)).toBe(true);
    expect(rq('Your $110 payment from Sep 10 is processing.', ctx(newerPaidOlderProcessing))).toBe(false); // no inbound at all: a proactive message
    expect(rq('Your payment is processing.', ctx(newerPaidOlderProcessing), 'Is my Sep 10 payment still processing?')).toBe(false);
  });
  test('absence claims are not scoped to the newest payment', () => {
    expect(rq("We haven't received your payment yet.", ctx([row('processing', '2026-09-20'), row('processing', '2026-09-10')]), ASK)).toBe(false);
  });
});

// Codex round-22 P2(1): invoice-subject UNPAID claims bind the NAMED invoice's own status.
describe('round-22: "Invoice #0123 is still unpaid" binds THAT invoice, not the account-wide balance', () => {
  const rq = (r, list, extra = {}) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: [], invoiceStatuses: list, ...extra } }, { byMeaning: true });
  const inv = (num, status, amountDue, total = 100) => ({ id: `i-${num}`, invoiceNumber: `WPC-2026-${num}`, status, total, amountDue });
  const CLAIM = 'Invoice #0123 is still unpaid.';

  test('collectible (sent / viewed / overdue / partially paid) with an amount due => true', () => {
    for (const status of ['sent', 'viewed', 'overdue', 'partially_paid']) {
      expect({ status, r: rq(CLAIM, [inv('0123', status, 60)]) }).toEqual({ status, r: false });
    }
    expect(rq(CLAIM, [inv('0123', 'sent', 0)])).toBe(true); // nothing due
  });
  test('closed (paid / prepaid / void / canceled / uncollectible / refunded / processing) contradicts it', () => {
    for (const status of ['paid', 'prepaid', 'void', 'canceled', 'uncollectible', 'refunded', 'processing']) {
      expect({ status, r: rq(CLAIM, [inv('0123', status, 0)]) }).toEqual({ status, r: true });
    }
  });
  test('the auditor case: #0123 is voided while ANOTHER invoice is open (and the account owes money) => ungrounded', () => {
    const list = [inv('0456', 'sent', 95), inv('0123', 'void', 0)];
    expect(rq(CLAIM, list, { outstandingBalance: 95, openInvoice: { id: 'i-0456', amountDue: 95 } })).toBe(true);
    // the same claim about the OPEN invoice is fine
    expect(rq('Invoice #0456 is still unpaid.', list, { outstandingBalance: 95, openInvoice: { id: 'i-0456', amountDue: 95 } })).toBe(false);
  });
  test('identification: by number or amount; ambiguity, an unknown number, or missing invoice state fails closed', () => {
    const list = [inv('0456', 'sent', 95, 95), inv('0123', 'sent', 60, 60)];
    expect(rq('Your $60 invoice is unpaid.', list)).toBe(false);
    expect(rq('Your invoice is unpaid.', list)).toBe(true); // which one?
    expect(rq('Invoice #0999 is still unpaid.', list)).toBe(true);
    expect(rq(CLAIM, undefined)).toBe(true);
    expect(rq(CLAIM, null)).toBe(true);
  });
  test('payment- and account-subject unpaid claims keep the account-wide obligation rule', () => {
    expect(rq("Your payment hasn't been paid.", [], { outstandingBalance: 95 })).toBe(false);
    expect(rq("Your payment hasn't been paid.", [], { outstandingBalance: 0 })).toBe(true);
  });
});

// Codex round-22 P1 (the CLASS): a payment assertion the enumerator has no phrase for fails CLOSED.
describe('round-22: unrecognized payment assertions fail closed (draft and send share the path)', () => {
  const V3 = require('../services/payment-receipt-vocabulary');
  const rq = (r, rows = [], extra = {}) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: rows, invoiceStatuses: [], ...extra } }, { byMeaning: true });
  const paid = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };

  test('"yet to receive / see / get" forms are not_received phrases and ground properly', () => {
    for (const s of ['We have yet to receive your payment.', 'We have yet to see your payment.', 'We have yet to get your payment.', 'Your payment has yet to post.', 'Your payment is yet to come through.']) {
      expect({ s, none: rq(s) }).toEqual({ s, none: false }); // truthful with no paid row
      expect({ s, paid: rq(s, [paid]) }).toEqual({ s, paid: true }); // false once a paid row exists
    }
  });
  test('an unlisted phrasing that the prescreen flags but no phrase recognizes is UNGROUNDED', () => {
    for (const s of ['Your payment is all squared away on our end.', 'We are in receipt of your payment.', 'Your payment landed safely.', 'Your payment is in good hands.']) {
      expect({ s, claims: require('../services/sms-shadow-drafter').enumeratePaymentClaims(s, {}).claims.length }).toEqual({ s, claims: 0 });
      expect({ s, r: rq(s, [paid]) }).toEqual({ s, r: true });
    }
  });
  test('clearly non-assertive clauses are NOT swept up: questions, conditionals, offers/instructions, payment-option references', () => {
    for (const s of [
      'Can you tell me when you paid?', 'If your payment does not go through, let us know.', 'Once the visit is done we will reschedule your payment date.',
      'You can pay with the link below.', 'Please use your personal pay link.', 'We accept card payments and Zelle.', 'Payment options are listed on your invoice.',
      "I'll send you the payment link now.", 'Your payment method on file is a Visa.', 'Your autopay payment date is the 1st.', 'Thanks so much!', 'See you Tuesday at 9.',
      "We're processing your request.", 'Your estimate is pending.', "Yes, we've got Zelle.",
    ]) expect({ s, r: rq(s) }).toEqual({ s, r: false });
  });
  test('the trigger is narrow: payment noun / paid / unpaid / settlement / zero balance', () => {
    expect(V3.unrecognizedPaymentAssertion('Your payment is all squared away.')).toBe(true);
    expect(V3.unrecognizedPaymentAssertion('You can pay any time.')).toBe(false);
    expect(V3.unrecognizedPaymentAssertion('Your account is in good standing.')).toBe(false); // "account" alone is not a status noun
    expect(V3.unrecognizedPaymentAssertion('Everything is squared away and paid.')).toBe(true);
  });
});

// Codex round-25 P1: exemptions are scoped to the payment phrase's own sub-clause; invoice / bill subjects are covered.
describe('round-25: non-assertive exemption is sub-clause scoped; invoice/bill subjects join the fail-closed rule', () => {
  const V4 = require('../services/payment-receipt-vocabulary');
  const rq = (r, extra = {}) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: [{ amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' }], invoiceStatuses: [], ...extra } }, { byMeaning: true });

  test('a non-assertive marker elsewhere in the clause does NOT exempt the payment assertion', () => {
    for (const s of [
      'Your payment settled so please call if you need anything', 'Your payment settled, but you can pay online if you like', 'Your payment settled and I will send the receipt',
      'Your payment settled because you can rest easy', 'Your payment settled, can you confirm?', 'Your payment settled if that helps', 'Your payment settled. Please call us.',
    ]) expect({ s, r: V4.unrecognizedPaymentAssertion(s) }).toEqual({ s, r: true });
  });
  test('a genuinely non-assertive PAYMENT sub-clause still is exempt', () => {
    for (const s of [
      'Did your payment settle, or is it still pending?', 'If your payment does not go through, let us know.', 'Can you confirm when you paid?', 'You can pay with the link below.',
      'Once the visit is done we will reschedule your payment date.', 'I will send you the payment link.', 'Please use your personal pay link so your payment goes through.',
    ]) expect({ s, r: V4.unrecognizedPaymentAssertion(s) }).toEqual({ s, r: false });
  });
  test('invoice / bill subjects: unrecognized status wording fails closed; delivery / offers do not', () => {
    for (const s of ['Your invoice is settled.', 'The bill finalized.', 'Your invoice cleared out.', 'Your bill is squared away.', 'The invoice got resolved.']) {
      expect({ s, r: V4.unrecognizedPaymentAssertion(s), flagged: V4.mayAssertPaymentStatus(s), draft: rq(s) }).toEqual({ s, r: true, flagged: true, draft: true });
    }
    for (const s of ['Your invoice is attached.', 'Your invoice is ready below.', 'I will email you the invoice.', 'Can you send me the invoice number?', 'We bill on the first of the month.', 'Your invoice was sent Tuesday.']) {
      expect({ s, r: V4.unrecognizedPaymentAssertion(s) }).toEqual({ s, r: false });
    }
  });
  test('the prescreen is a superset of the unrecognized-assertion trigger (invoice / bill included)', () => {
    for (const s of ['Your invoice is settled.', 'The bill finalized.', 'Your payment settled.', 'Everything is unpaid.', 'A chargeback resolved.']) {
      if (V4.unrecognizedPaymentAssertion(s)) expect({ s, flagged: V4.mayAssertPaymentStatus(s) }).toEqual({ s, flagged: true });
    }
  });
});

// Codex round-25 P1: invoice binding rejects conflicting inbound / reply identity.
describe('round-25: invoice status claims agree with the invoice the customer asked about', () => {
  const rq = (r, list, inboundMessage) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: [], invoiceStatuses: list } }, { byMeaning: true, inboundMessage });
  const inv = (num, status, total) => ({ id: `i-${num}`, invoiceNumber: `WPC-2026-${num}`, status, total, amountDue: status === 'sent' ? total : 0 });
  const list = [inv('0101', 'paid', 120), inv('0202', 'paid', 95)];

  test('the auditor case: "Is my $120 invoice paid?" + "Your $95 invoice is paid" binds NEITHER (was: the separate $95 invoice)', () => {
    expect(rq('Your $95 invoice is paid.', list, 'Is my $120 invoice paid?')).toBe(true);
    expect(rq('Your $120 invoice is paid.', list, 'Is my $120 invoice paid?')).toBe(false); // agrees
    expect(rq('Your invoice is paid.', list, 'Is my $120 invoice paid?')).toBe(false); // reply silent: inherits the inbound
  });
  test('a reply invoice NUMBER that the customer did not ask about is rejected', () => {
    expect(rq('Invoice WPC-2026-0202 is paid.', list, 'Is invoice WPC-2026-0101 paid?')).toBe(true);
    expect(rq('Invoice WPC-2026-0101 is paid.', list, 'Is invoice 0101 paid?')).toBe(false);
    expect(rq('Invoice #0202 is paid.', list, 'Is invoice #0101 paid?')).toBe(true);
  });
  test('no inbound identity: the reply resolves on its own, as before', () => {
    expect(rq('Your $95 invoice is paid.', list)).toBe(false);
    expect(rq('Invoice WPC-2026-0202 is paid.', list)).toBe(false);
  });
});

// Codex round-26 P1: the cross-status ambiguity rule runs for ANY identity — amount, date, tender or a combination.
describe('round-26: conflicting statuses under a date-only / tender-only / combined identity are ungrounded', () => {
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const row = (status, over = {}) => ({ amount: 120, status, payment_date: '2026-09-12', payment_method_type: 'card', ...over });

  test('TENDER + DATE: "Your card payment from Sep 12 failed" with paid + failed card rows that day binds neither (either order)', () => {
    for (const rows of [[row('failed'), row('paid')], [row('paid'), row('failed')]]) {
      expect(rq('Your card payment from Sep 12 failed.', ctx(rows))).toBe(true);
      expect(rq('Your card payment from Sep 12 is still processing.', ctx([row('paid'), row('processing')]))).toBe(true);
    }
  });
  test('DATE only: two attempts on the date with conflicting statuses', () => {
    expect(rq('Your payment from Sep 12 failed.', ctx([row('failed', { amount: 50 }), row('paid', { amount: 60 })]))).toBe(true);
    expect(rq('Your payment from Sep 12 failed.', ctx([row('failed', { amount: 50 })]))).toBe(false); // single status
    expect(rq('Your payment from Sep 12 failed.', ctx([row('failed', { amount: 50 }), row('paid', { amount: 60, payment_date: '2026-09-10' })]))).toBe(false); // other date
  });
  test('TENDER only (reply or the customer\'s inbound)', () => {
    const zelleFailed = row('failed', { payment_method_type: undefined, description: 'Invoice INV-9 — zelle' });
    const zellePaid = row('paid', { payment_method_type: undefined, description: 'Invoice INV-9 — zelle', payment_date: '2026-09-01' });
    expect(rq('Your Zelle payment failed.', ctx([zelleFailed, zellePaid]))).toBe(true);
    expect(rq('Your payment failed.', ctx([zelleFailed, zellePaid]), 'Why did my Zelle payment fail?')).toBe(true);
    expect(rq('Your Zelle payment failed.', ctx([zelleFailed, row('paid')]))).toBe(false); // the paid row is a CARD payment
  });
  test('the inbound identity counts: the customer named the date, the reply did not', () => {
    expect(rq('Your payment failed.', ctx([row('failed', { amount: 50 }), row('paid', { amount: 60 })]), 'Did my Sep 12 payment fail?')).toBe(true);
    expect(rq('Your payment failed.', ctx([row('failed', { amount: 50 }), row('paid', { amount: 60, payment_date: '2026-09-01' })]), 'Did my Sep 12 payment fail?')).toBe(false);
  });
  test('the most-recent fallback for a fully identity-free claim is unchanged', () => {
    expect(rq('Your payment is processing.', ctx([row('paid', { payment_date: '2026-09-20' }), row('processing', { payment_date: '2026-09-10' })]))).toBe(true);
  });
  test('absence claims and same-family rows are unaffected', () => {
    expect(rq('Your card payment from Sep 12 failed.', ctx([row('failed'), row('failed', { amount: 45 })]))).toBe(false);
    expect(rq("We haven't received your card payment from Sep 12.", ctx([row('failed')]))).toBe(false);
  });
});

// Codex round-27 P1 (2): a GENERIC inbound leaves the reply's claim about the MOST RECENT payment.
describe('round-27: a generic inbound binds the reply to the most recent payment (date, then created_at)', () => {
  const rq = (r, rows, inboundMessage) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: rows } }, { byMeaning: true, inboundMessage });
  const row = (status, date, created, over = {}) => ({ amount: 120, status, payment_date: date, created_at: created, payment_method_type: 'card', ...over });
  const ASK = 'Did my payment go through?';

  test('the auditor case: newest is FAILED, an older $120 payment is PAID — "We received your $120 payment from Sep 12" is ungrounded', () => {
    const rows = [row('failed', '2026-09-20', '2026-09-20T15:00:00Z', { amount: 80 }), row('paid', '2026-09-12', '2026-09-12T15:00:00Z')];
    expect(rq('We received your $120 payment from Sep 12.', rows, ASK)).toBe(true);
    expect(rq('Your $120 payment from Sep 12 is paid.', rows, ASK)).toBe(true);
    expect(rq('Your payment failed.', rows, ASK)).toBe(false); // the newest one did
    expect(rq('Your $80 payment from Sep 20 failed.', rows, ASK)).toBe(false); // identity matches the newest
  });
  test('a reply identity that does not match the most recent payment is ungrounded (amount, date or tender)', () => {
    const rows = [row('paid', '2026-09-20', '2026-09-20T15:00:00Z', { amount: 80 }), row('paid', '2026-09-12', '2026-09-12T15:00:00Z')];
    expect(rq('We received your $80 payment from Sep 20.', rows, ASK)).toBe(false);
    expect(rq('We received your $120 payment from Sep 12.', rows, ASK)).toBe(true);
    expect(rq('We received your $80 card payment from Sep 20.', rows, ASK)).toBe(false);
    expect(rq('We received your $80 Zelle payment from Sep 20.', rows, ASK)).toBe(true); // wrong tender for the newest
  });
  test('created_at breaks same-day ties: the LATER attempt is the payment the customer means', () => {
    const failedThenPaid = [row('failed', '2026-09-12', '2026-09-12T10:00:00Z'), row('paid', '2026-09-12', '2026-09-12T16:00:00Z')];
    expect(rq('Your payment failed.', failedThenPaid, ASK)).toBe(true); // the retry went through
    expect(rq('We received your $120 payment from Sep 12.', failedThenPaid, ASK)).toBe(false);
    expect(rq('We received your $120 payment from Sep 12.', [...failedThenPaid].reverse(), ASK)).toBe(false); // row order is irrelevant
  });
  test('an inbound that NAMES a payment identity, or no inbound at all, is unchanged', () => {
    const rows = [row('failed', '2026-09-20', '2026-09-20T15:00:00Z', { amount: 80 }), row('paid', '2026-09-12', '2026-09-12T15:00:00Z')];
    expect(rq('We received your $120 payment from Sep 12.', rows, 'Did my $120 payment from Sep 12 go through?')).toBe(false);
    expect(rq('We received your $120 payment from Sep 12.', rows)).toBe(false); // proactive message, no inbound
    expect(rq('We received your $120 payment from Sep 12.', rows, 'What time is my visit Tuesday?')).toBe(false); // inbound is not about a payment
  });
});

// Codex round-27 P1 (3): a partial-refund disclosure is tracked by the payment ROW it is bound to.
describe('round-27: a partial refund disclosure only lets a receipt bind THAT partially refunded row', () => {
  const rq = (r, rows) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: rows } }, { byMeaning: true });
  const partialA = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card', refund_status: 'partial', refund_amount: 30 };
  const partialB = { amount: 200, status: 'paid', payment_date: '2026-09-05', payment_method_type: 'card', refund_status: 'partial', refund_amount: 50 };
  const rows = [partialA, partialB];

  test('disclosure about $120 (A) does NOT let a receipt claim bind $200 (B), in either order', () => {
    const disclosureA = 'part of your $120 payment from Sep 12 was refunded';
    expect(rq(`${disclosureA}. We received your $200 payment from Sep 5.`, rows)).toBe(true);
    expect(rq(`We received your $200 payment from Sep 5. Also, ${disclosureA}.`, rows)).toBe(true);
  });
  test('a receipt for the SAME row the disclosure is bound to is fine (either order, also refund-subject wording)', () => {
    expect(rq('We received your $120 payment from Sep 12. Part of your $120 payment from Sep 12 was refunded.', rows)).toBe(false);
    expect(rq('Part of your $200 payment from Sep 5 was refunded. We received your $200 payment from Sep 5.', rows)).toBe(false);
    expect(rq('We received your $120 payment from Sep 12. Your $30 refund was issued.', rows)).toBe(false);
  });
  test('an anaphoric disclosure follows the receipt\'s own row (the antecedent), not another', () => {
    expect(rq('We received your $120 payment from Sep 12, but it was partially refunded.', rows)).toBe(false);
    expect(rq('We received your $200 payment from Sep 5, but it was partially refunded.', rows)).toBe(false);
  });
  test('no disclosure at all: a partially refunded row never backs "received"', () => {
    expect(rq('We received your $120 payment from Sep 12.', rows)).toBe(true);
    expect(rq('We received your $200 payment from Sep 5.', rows)).toBe(true);
  });
  test('a disclosure about a row that is not partially refunded discloses nothing', () => {
    const plain = { amount: 90, status: 'paid', payment_date: '2026-09-01', payment_method_type: 'card' };
    expect(rq('Part of your $90 payment from Sep 1 was refunded. We received your $120 payment from Sep 12.', [partialA, plain])).toBe(true);
  });
});

// Codex round-27 P1 (1b): the authoritative history rows are what claims bind against once it is loaded.
describe('round-27: with a truncated window, claims bind against the loaded HISTORY (hidden same-day attempts)', () => {
  const day = '2026-09-12';
  const att = (id, status, created, over = {}) => ({ id, amount: 120, status, payment_date: day, created_at: created, payment_method_type: 'card', ...over });
  const all = [att('e', 'failed', '2026-09-12T18:00:00Z'), att('d', 'failed', '2026-09-12T17:00:00Z'), att('c', 'failed', '2026-09-12T16:00:00Z'), att('b', 'paid', '2026-09-12T15:00:00Z'), att('a', 'processing', '2026-09-12T14:00:00Z')];
  const window3 = all.slice(0, 3);
  const ctxWith = (billing) => ({ billing: { outstandingBalance: 0, recentPayments: window3, recentPaymentsTruncated: true, ...billing } });
  const rq = (r, c, inboundMessage) => replyQuotesUngroundedAmount(r, c, { byMeaning: true, inboundMessage });
  const FAILED = 'Your $120 card payment from Sep 12 failed.';

  test('the 3-row window alone looks unambiguous ("failed")...', () => {
    expect(rq(FAILED, ctxWith({}))).toBe(false);
  });
  test('...but with the 5 same-day attempts loaded (failed x3, paid, processing) the claim is ambiguous => ungrounded', () => {
    expect(rq(FAILED, ctxWith({ paymentHistory: { rows: all, complete: true } }))).toBe(true);
    expect(rq('We received your $120 card payment from Sep 12.', ctxWith({ paymentHistory: { rows: all, complete: true } }))).toBe(true);
  });
  test('a truncated window whose history could not be read (null) fails closed for receipts and status claims', () => {
    expect(rq(FAILED, ctxWith({ paymentHistory: null }))).toBe(true);
    expect(rq('We received your $120 card payment from Sep 12.', ctxWith({ paymentHistory: null }))).toBe(true);
  });
  test('a paid row that only the history holds (older than the window) still grounds a receipt once loaded', () => {
    const older = att('z', 'paid', '2026-06-12T10:00:00Z', { payment_date: '2026-06-12', amount: 77 });
    const c = ctxWith({ paymentHistory: { rows: [...all, older], complete: true } });
    expect(rq('We received your $77 card payment from Jun 12.', c)).toBe(false);
    expect(rq('We received your $77 card payment from Jun 12.', ctxWith({}))).toBe(true); // window only: not there
  });
});

// Codex round-28 P1 (2)+(3): card / tender subjects and "charge" inbound.
describe('round-28: card and tender subjects are payment subjects; "charge" inbound is a payment question', () => {
  const V5 = require('../services/payment-receipt-vocabulary');
  const rq = (r, rows = [], inboundMessage) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: rows, invoiceStatuses: [] } }, { byMeaning: true, inboundMessage });
  const row = (status, over = {}) => ({ amount: 120, status, payment_date: '2026-09-12', payment_method_type: 'card', ...over });

  test('the classifier reads "Your card was declined / Your Apple Pay failed" as a FAILED claim', () => {
    for (const s of ['Your card was declined.', 'Your card failed.', 'Your Apple Pay payment failed.', 'Your Apple Pay failed.', 'Your Google Pay was declined.', 'Your Zelle failed.', 'Your bank account payment failed.']) {
      expect({ s, families: [...new Set(V5.paymentStatusPhraseMatches(s, false).matches.map((m) => m.family))] }).toEqual({ s, families: ['failed'] });
    }
  });
  test('and binds it to a FAILED row (grounded), never a paid one', () => {
    expect(rq('Your card was declined.', [row('failed')])).toBe(false);
    expect(rq('Your card was declined.', [row('paid')])).toBe(true);
    expect(rq('Your card was declined.', [])).toBe(true);
    expect(rq('Your Apple Pay payment failed.', [row('failed')])).toBe(false);
    expect(rq('Your Apple Pay payment failed.', [row('paid')])).toBe(true);
    expect(rq('Your Apple Pay failed.', [row('paid')])).toBe(true);
  });
  test('the unrecognized fallback covers card / tender subjects; saved-method facts are not assertions', () => {
    for (const s of ['Your card got sorted out.', 'Your Apple Pay went fine.', 'Your card was all fixed.']) expect({ s, r: V5.unrecognizedPaymentAssertion(s), flagged: V5.mayAssertPaymentStatus(s) }).toEqual({ s, r: true, flagged: true });
    for (const s of ['Your card on file is a Visa ending 4242.', 'Your card expires next month.', 'Your default card was updated.', 'You can pay by card or Zelle.']) expect({ s, r: V5.unrecognizedPaymentAssertion(s) }).toEqual({ s, r: false });
    expect(rq('Your card got sorted out.', [row('paid')])).toBe(true);
  });
  test('the customer-message test includes charge / charged / card / tender words (built from the same list)', () => {
    for (const q of ['Did my charge go through?', 'Was I charged twice?', 'Did my card get declined?', 'Did my Apple Pay work?', 'Did my Zelle arrive?']) expect({ q, r: V5.inboundNamesPayment(q) }).toEqual({ q, r: true });
    expect(V5.inboundNamesPayment('What time is my visit Tuesday?')).toBe(false);
  });
  test('"Did my charge go through?" + "It failed." is now VALIDATED (was: a bare pronoun clause validated nothing)', () => {
    const ASK = 'Did my charge go through?';
    expect(rq('It failed.', [row('failed')], ASK)).toBe(true); // an anaphor with no antecedent is ungrounded
    expect(rq('Your charge failed.', [row('failed')], ASK)).toBe(false);
    expect(rq('Your charge failed.', [row('paid')], ASK)).toBe(true);
    expect(rq('It failed.', [row('paid')], ASK)).toBe(true);
    expect(require('../services/sms-shadow-drafter').enumeratePaymentClaims('It failed.', { inboundText: ASK }).claims.map((c) => c.kind)).toEqual(['status']);
  });
});

// Codex round-28 P1 (4): the anaphoric partial-refund disclosure backs ONLY the claim it follows.
describe('round-28: an anaphoric partial disclosure is bound to its antecedent row only', () => {
  const rq = (r, rows) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: rows } }, { byMeaning: true });
  const A = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card', refund_status: 'partial', refund_amount: 30 };
  const B = { amount: 200, status: 'paid', payment_date: '2026-09-05', payment_method_type: 'card', refund_status: 'partial', refund_amount: 50 };
  test('the two-partial-rows case', () => {
    const ra = 'We received your $120 payment from Sep 12, but it was partially refunded.';
    const rb = 'We received your $200 payment from Sep 5.';
    expect(rq(ra, [A, B])).toBe(false);
    expect(rq(`${ra} ${rb}`, [A, B])).toBe(true); // B has no disclosure of its own
    expect(rq(`${rb} ${ra}`, [A, B])).toBe(true);
    expect(rq(`${rb.replace('.', '')}, but it was partially refunded. ${ra}`, [A, B])).toBe(false); // each has its own disclosure
    expect(rq('We received your $200 payment from Sep 5, and we received your $120 payment from Sep 12, but it was partially refunded.', [A, B])).toBe(true);
  });
});

// Codex round-29 P1 (2): subject is classified PER SUB-CLAUSE; an invoice claim survives a payment noun elsewhere.
describe('round-29: invoice and payment subjects in one clause are both validated', () => {
  const rq = (r, { rows = [], invoices = [] } = {}) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: rows, invoiceStatuses: invoices } }, { byMeaning: true });
  const inv = (status) => ({ id: 'i1', invoiceNumber: 'WPC-2026-0123', status, total: 120, amountDue: status === 'sent' ? 120 : 0 });
  const pay = (status) => ({ amount: 120, status, payment_date: '2026-09-12', payment_method_type: 'card' });
  const R = 'Invoice #0123 is still processing because your payment is still processing.';

  test('the auditor sentence yields an INVOICE claim and a PAYMENT claim', () => {
    const claims = require('../services/sms-shadow-drafter').enumeratePaymentClaims(R, {}).claims;
    expect(claims.map((c) => [c.kind, c.family, c.subject || 'payment'])).toEqual([['status', 'pending', 'invoice'], ['status', 'pending', 'payment']]);
  });
  test('grounded only when BOTH hold: the invoice is processing AND a payment is processing', () => {
    expect(rq(R, { invoices: [inv('processing')], rows: [pay('processing')] })).toBe(false);
    expect(rq(R, { invoices: [inv('sent')], rows: [pay('processing')] })).toBe(true); // the invoice claim was being dropped
    expect(rq(R, { invoices: [inv('processing')], rows: [pay('paid')] })).toBe(true); // the payment claim fails
    expect(rq(R, { invoices: [inv('processing')], rows: [] })).toBe(true);
    expect(rq(R, {})).toBe(true);
  });
  test('mirror order and other connectors', () => {
    const M = 'Your payment is still processing so invoice #0123 is still processing.';
    expect(rq(M, { invoices: [inv('processing')], rows: [pay('processing')] })).toBe(false);
    expect(rq(M, { invoices: [inv('sent')], rows: [pay('processing')] })).toBe(true);
    expect(rq('Invoice #0123 is paid while your payment is processing.', { invoices: [inv('paid')], rows: [pay('processing')] })).toBe(false);
    expect(rq('Invoice #0123 is paid while your payment is processing.', { invoices: [inv('sent')], rows: [pay('processing')] })).toBe(true);
  });
  test('a single-subject clause is unchanged', () => {
    expect(rq('Your invoice is still processing.', { invoices: [inv('processing')] })).toBe(false);
    expect(rq('Your payment is still processing.', { rows: [pay('processing')] })).toBe(false);
  });
});

// Codex round-29 P1 (3): the benign "on file" exemption only covers clauses that merely DESCRIBE the stored method.
describe('round-29: "Your card on file didn\'t work" is a failure assertion', () => {
  const V6 = require('../services/payment-receipt-vocabulary');
  const rq = (r, rows = []) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: rows, invoiceStatuses: [] } }, { byMeaning: true });
  const failedRow = { amount: 120, status: 'failed', payment_date: '2026-09-12', payment_method_type: 'card' };
  test('status predicates in an "on file" clause are claims / assertions', () => {
    for (const s of ["Your card on file didn't work.", 'Your card on file was declined.', 'Your card on file got rejected.', "Your card on file wasn't accepted.", 'Your default card went through.']) {
      expect({ s, r: V6.unrecognizedPaymentAssertion(s) }).toEqual({ s, r: true });
    }
    // "bounced" is a recognized FAILED phrase: it makes a claim, so the fallback is not even needed
    expect(require('../services/sms-shadow-drafter').enumeratePaymentClaims('Your card on file bounced.', {}).claims.map((c) => c.family)).toEqual(['failed']);
  });
  test('the new "didn\'t work / wasn\'t accepted / rejected" forms are FAILED-family phrases and bind a failed row', () => {
    for (const s of ["Your card didn't work.", "Your card wasn't accepted.", 'Your card was rejected.', 'Your card got rejected.', "Your payment didn't work.", 'Your card on file did not work.']) {
      expect({ s, fam: [...new Set(V6.paymentStatusPhraseMatches(s, false).matches.map((m) => m.family))] }).toEqual({ s, fam: ['failed'] });
      expect({ s, failed: rq(s, [failedRow]) }).toEqual({ s, failed: false });
      expect({ s, none: rq(s, []) }).toEqual({ s, none: true });
      expect({ s, paid: rq(s, [{ ...failedRow, status: 'paid' }]) }).toEqual({ s, paid: true });
    }
  });
  test('pure stored-method descriptions stay benign', () => {
    for (const s of ['Your card on file is a Visa ending 4242.', 'Your card on file expires next month.', 'Your default card was updated.', 'Your saved card is active.']) {
      expect({ s, r: V6.unrecognizedPaymentAssertion(s) }).toEqual({ s, r: false });
    }
  });
});

// Codex round-30 P1 (1): a receipt can't bind any row while billing is unavailable.
describe('round-30: receipts fail closed when billing is unavailable', () => {
  const rq = (r, billing) => replyQuotesUngroundedAmount(r, { billing }, { byMeaning: true });
  const paid = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };
  test('unavailable billing (e.g. payer-linkage lookup failed): receipt, status and absence claims are all ungrounded', () => {
    const unavailable = { unavailable: true, outstandingBalance: 0, recentPayments: [paid] };
    expect(rq('We received your $120 payment from Sep 12.', unavailable)).toBe(true);
    expect(rq('Your $120 payment from Sep 12 is paid.', unavailable)).toBe(true);
    expect(rq('Your $120 payment from Sep 12 is still processing.', { ...unavailable, recentPayments: [{ ...paid, status: 'processing' }] })).toBe(true);
    expect(rq("We haven't received your $120 payment from Sep 12.", { ...unavailable, recentPayments: [] })).toBe(true);
    // the same receipt is fine with available billing
    expect(rq('We received your $120 payment from Sep 12.', { outstandingBalance: 0, recentPayments: [paid] })).toBe(false);
  });
});

// Codex round-30 P1 (3): pronoun-subject clauses are payment-scoped when the environment is about a payment.
describe('round-30: "It settled." after a payment question is an unrecognized payment assertion', () => {
  const V7 = require('../services/payment-receipt-vocabulary');
  const { paymentClauseNeedsValidation, enumeratePaymentClaims } = require('../services/sms-shadow-drafter');
  const rq = (r, rows, inboundMessage) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: rows, invoiceStatuses: [] } }, { byMeaning: true, inboundMessage });
  const paidRow = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };
  const ASK = 'Did my payment go through?';

  test('with a payment-scoped environment the fallback fires; without one it does not', () => {
    for (const s of ['It settled.', 'That cleared out.', "They're sorted.", 'It all worked out.']) {
      expect({ s, withCtx: V7.unrecognizedPaymentAssertion(s, { paymentContext: true }), without: V7.unrecognizedPaymentAssertion(s) }).toEqual({ s, withCtx: true, without: false });
    }
    // still exempt when genuinely non-assertive, even in a payment context
    for (const s of ['Can you tell me if it settled?', 'If it settled, let us know.', 'You can pay with the link.', 'It is easy to pay online.']) {
      expect({ s, r: V7.unrecognizedPaymentAssertion(s, { paymentContext: true }) }).toEqual({ s, r: false });
    }
  });
  test('draft: inbound "Did my payment go through?" + reply "It settled." is ungrounded; an unrelated inbound leaves it alone', () => {
    expect(rq('It settled.', [paidRow], ASK)).toBe(true);
    expect(rq('It settled.', [paidRow], 'What time is my visit Tuesday?')).toBe(false);
    expect(rq('It settled.', [paidRow])).toBe(false);
  });
  test('send: the gate uses the same environment (inbound in the env) — so the recheck is not skipped', () => {
    expect(enumeratePaymentClaims('It settled.', { inboundText: ASK }).claims).toEqual([]);
    expect(paymentClauseNeedsValidation('It settled.', { inboundText: ASK })).toBe(true);
    expect(paymentClauseNeedsValidation('It settled.', { inboundText: 'What time Tuesday?' })).toBe(false);
    expect(paymentClauseNeedsValidation('It settled.', { paymentContext: true })).toBe(true); // an earlier clause made a payment claim
  });
});

// Codex round-32 P2 (1): recognized status phrases in a hypothetical / interrogative sub-clause assert nothing.
describe('round-32: recognized status phrases honor conditional / question scope (per sub-clause)', () => {
  const V8 = require('../services/payment-receipt-vocabulary');
  const { enumeratePaymentClaims } = require('../services/sms-shadow-drafter');
  const rq = (r, rows = []) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: rows, invoiceStatuses: [] } }, { byMeaning: true });
  const paidRow = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };

  test('hypothetical / interrogative mentions are not claims (and not negated claims)', () => {
    for (const s of [
      'If your payment failed, please try another card.', "If your payment wasn't processed, let us know.", 'Let me know whether your payment failed.',
      'I will check if your payment posted.', 'In case your card is declined, call us.', 'Did your payment fail?', 'Once your payment clears we will reschedule.',
      'If your refund was issued you will see it in 3 days.',
    ]) {
      expect({ s, claims: enumeratePaymentClaims(s, {}).claims.map((c) => c.kind), neg: V8.paymentStatusPhraseMatches(s, false).negated }).toEqual({ s, claims: [], neg: false });
      expect({ s, r: rq(s, [paidRow]) }).toEqual({ s, r: false }); // grounded whatever the payment rows say
    }
  });
  test('the assertion half of a mixed sentence is still judged (sub-clause scoped)', () => {
    expect(rq('Your payment failed, please try another card.', [paidRow])).toBe(true); // asserts failure, but it is paid
    expect(rq('Your payment failed, please try another card.', [{ ...paidRow, status: 'failed' }])).toBe(false);
    expect(rq('Please note your payment failed.', [paidRow])).toBe(true); // "please" is not a conditional
    expect(rq('Your payment is paid, and if it failed let us know.', [paidRow])).toBe(true); // the paid-ack clause has no amount => ungrounded; the if-clause is exempt
    expect(rq('Your payment method was declined.', [{ ...paidRow, status: 'failed' }])).toBe(false);
    expect(rq('Your payment method was declined.', [paidRow])).toBe(true);
  });
  test('the unrecognized fallback and the recognized rule agree on the conditional opener', () => {
    expect(V8.unrecognizedPaymentAssertion('If your payment settled, please call us.')).toBe(false);
    expect(V8.unrecognizedPaymentAssertion('Your payment settled, please call us.')).toBe(true);
  });
});

// Codex round-32 P2 (2): only an AFFIRMATIVE partial-refund mention discloses.
describe('round-32: interrogative / conditional partial-refund mentions disclose nothing', () => {
  const rq = (r, rows) => replyQuotesUngroundedAmount(r, { billing: { outstandingBalance: 0, recentPayments: rows } }, { byMeaning: true });
  const A = { amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card', refund_status: 'partial', refund_amount: 30 };
  test('an affirmative disclosure still relaxes the guard for ITS row', () => {
    expect(rq('We received your $120 payment from Sep 12. Part of your $120 payment from Sep 12 was refunded.', [A])).toBe(false);
    expect(rq('We received your $120 payment from Sep 12, but it was partially refunded.', [A])).toBe(false);
  });
  test('a question or a conditional does not: the plain-paid guard stays in force (and the mention itself asserts nothing)', () => {
    for (const d of [
      'Was part of your $120 payment from Sep 12 refunded?', 'Was it partially refunded?', 'If part of your $120 payment from Sep 12 was refunded, let us know.',
      'Let me know whether part of your $120 payment from Sep 12 was refunded.',
    ]) {
      expect({ d, r: rq(`We received your $120 payment from Sep 12. ${d}`, [A]) }).toEqual({ d, r: true });
    }
    // anaphoric question right after the receipt must not be read as a disclosure either
    expect(rq('We received your $120 payment from Sep 12, but was it partially refunded?', [A])).toBe(true);
  });
});

// Codex round-33 P1: an invoice-subject sentence that names a tender makes a SECOND claim (how it was paid) bound to the
// row(s) that settled THAT invoice.
describe('round-33: "Invoice #0123 is paid with your card" validates the tender against the settling payment row', () => {
  const inv = { id: 'inv-1', invoiceNumber: 'WPC-2026-0123', status: 'paid', total: 120, amountDue: 0 };
  const ctx = (rows) => ({ customer: { id: 'c1' }, billing: { outstandingBalance: 0, recentPayments: rows, invoiceStatuses: [inv] } });
  const cash = { id: 'p1', amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: null, metadata: { invoice_id: 'inv-1', method: 'cash' } };
  const card = { id: 'p2', amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card', metadata: { invoice_id: 'inv-1' } };
  const byDescription = { id: 'p3', amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card', description: 'Invoice WPC-2026-0123 — pest control' };
  const ask = 'Is invoice 0123 paid?';
  const ungrounded = (reply, rows) => replyQuotesUngroundedAmount(reply, ctx(rows), { byMeaning: true, inboundMessage: ask });

  test('cash-settled invoice + "with your card" is ungrounded; matching tender is grounded', () => {
    expect(ungrounded('Invoice #0123 is paid with your card.', [cash])).toBe(true);
    expect(ungrounded('Invoice #0123 was paid by card.', [cash])).toBe(true);
    expect(ungrounded('Invoice #0123 is paid with your card.', [card])).toBe(false);
    expect(ungrounded('Invoice #0123 is paid in cash.', [cash])).toBe(false);
    expect(ungrounded('Invoice #0123 is paid in cash.', [card])).toBe(true);
  });
  test('the settling row is found through the "Invoice <n> —" description as well', () => {
    expect(ungrounded('Invoice #0123 is paid with your card.', [byDescription])).toBe(false);
    expect(ungrounded('Invoice #0123 is paid by Zelle.', [byDescription])).toBe(true);
  });
  test('no settling row on record, an unreadable tender, or a mixed settlement is unverifiable => ungrounded', () => {
    expect(ungrounded('Invoice #0123 is paid with your card.', [])).toBe(true);
    expect(ungrounded('Invoice #0123 is paid with your card.', [{ ...card, id: 'x', metadata: { invoice_id: 'other' } }])).toBe(true);
    expect(ungrounded('Invoice #0123 is paid with your card.', [{ ...card, payment_method_type: null }])).toBe(true);
    expect(ungrounded('Invoice #0123 is paid with your card.', [card, cash])).toBe(true);
    expect(ungrounded('Invoice #0123 is paid with your card or cash.', [card])).toBe(true); // ambiguous tender wording
  });
  test('a tender-free invoice status and a how-to-pay sub-clause are unchanged', () => {
    expect(ungrounded('Invoice #0123 is paid.', [cash])).toBe(false);
    expect(ungrounded('Invoice #0123 is paid, and you can pay by card next time.', [cash])).toBe(false);
  });
});

// Codex round-34 P1: a tender word after a tender preposition is NEVER a subject, for every tender — "Invoice #0123 is
// processing via ACH" is an INVOICE claim plus a TENDER claim bound to that invoice's own rows.
describe('round-34: tender-after-preposition keeps the invoice subject and binds the tender to the invoice rows', () => {
  const V = require('../services/payment-receipt-vocabulary');
  const mk = (status, rows) => ({ customer: { id: 'c1' }, billing: { outstandingBalance: 0, recentPayments: rows, invoiceStatuses: [{ id: 'inv-1', invoiceNumber: 'WPC-2026-0123', status, total: 120, amountDue: status === 'processing' ? 120 : 0 }] } });
  const row = (st, extra) => ({ id: `r-${st}-${Math.random()}`, amount: 120, status: st, payment_date: '2026-09-12', metadata: { invoice_id: 'inv-1' }, ...extra });
  const TENDERS = {
    ach: { payment_method_type: 'us_bank_account' },
    card: { payment_method_type: 'card' },
    zelle: { payment_method_type: null, metadata: { invoice_id: 'inv-1', method: 'zelle' } },
    check: { payment_method_type: null, metadata: { invoice_id: 'inv-1', method: 'check' } },
    cash: { payment_method_type: null, metadata: { invoice_id: 'inv-1', method: 'cash' } },
  };
  const WORDING = { ach: 'via ACH', card: 'with your card', zelle: 'through Zelle', check: 'by check', cash: 'in cash' };
  const ungrounded = (reply, ctx, inbound) => replyQuotesUngroundedAmount(reply, ctx, { byMeaning: true, inboundMessage: inbound });

  test('the subject stays the invoice for every tender wording', () => {
    for (const w of ['via ACH', 'by check', 'through Zelle', 'with your card', 'using your bank account', 'by Zelle', 'via your checking account']) {
      expect({ w, invoice: V.invoiceSubjectClause(`Invoice #0123 is processing ${w}.`) }).toEqual({ w, invoice: true });
    }
    // a tender that is the SUBJECT (or a payment noun) is still a payment clause
    for (const t of ['Your ACH payment is processing.', 'The Zelle transfer is processing.', 'Your check is processing.', 'Invoice #0123 is processing via your ACH payment.']) {
      expect({ t, invoice: V.invoiceSubjectClause(t) }).toEqual({ t, invoice: false });
    }
  });
  test.each(Object.keys(TENDERS))('processing %s: only a processing row of the SAME tender on THAT invoice grounds it', (tender) => {
    const reply = `Invoice #0123 is processing ${WORDING[tender]}.`;
    const inbound = 'Is invoice 0123 processing?';
    for (const other of Object.keys(TENDERS)) {
      expect({ tender, other, ungrounded: ungrounded(reply, mk('processing', [row('processing', TENDERS[other])]), inbound) })
        .toEqual({ tender, other, ungrounded: tender !== other });
    }
    // a processing row of that tender on a DIFFERENT invoice, a paid row, or no row at all cannot back it
    expect(ungrounded(reply, mk('processing', [row('processing', { ...TENDERS[tender], metadata: { ...(TENDERS[tender].metadata || {}), invoice_id: 'other' } })]), inbound)).toBe(true);
    expect(ungrounded(reply, mk('processing', [row('paid', TENDERS[tender])]), inbound)).toBe(true);
    expect(ungrounded(reply, mk('processing', []), inbound)).toBe(true);
  });
  test.each(Object.keys(TENDERS))('paid %s: bound to the settling row of that invoice', (tender) => {
    const reply = `Invoice #0123 is paid ${WORDING[tender]}.`;
    const inbound = 'Is invoice 0123 paid?';
    for (const other of Object.keys(TENDERS)) {
      expect({ tender, other, ungrounded: ungrounded(reply, mk('paid', [row('paid', TENDERS[other])]), inbound) })
        .toEqual({ tender, other, ungrounded: tender !== other });
    }
  });
  test('the invoice STATUS itself is still judged: a processing claim against a paid invoice is ungrounded whatever the tender rows say', () => {
    expect(ungrounded('Invoice #0123 is processing via ACH.', mk('paid', [row('processing', TENDERS.ach)]), 'Is invoice 0123 processing?')).toBe(true);
  });
  test('"Your ACH payment is processing." (payment subject) is unchanged: bound to the payments rows, not invoice statuses', () => {
    const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows, invoiceStatuses: [] } });
    const inbound = 'Is my ACH payment processing?';
    expect(ungrounded('Your ACH payment is processing.', ctx([row('processing', TENDERS.ach)]), inbound)).toBe(false);
    expect(ungrounded('Your ACH payment is processing.', ctx([row('paid', TENDERS.ach)]), inbound)).toBe(true);
  });
});

// Codex round-35 P2: a clause whose subject is a REFUND is judged against refund_status / refund_amount, never the payment
// attempt's status.
describe('round-35: refund-subject clauses bind to the refund state', () => {
  const base = { id: 'p1', amount: 120, status: 'paid', payment_date: '2026-09-12', payment_method_type: 'card' };
  const pending = { ...base, id: 'r-pend', status: 'refunded', refund_status: 'pending', refund_amount: 30 };
  const partialDone = { ...base, id: 'r-part', refund_status: 'partial', refund_amount: 30 };
  const failedRefund = { ...base, id: 'r-fail', refund_status: 'failed', refund_amount: 30 };
  const fullRefund = { ...base, id: 'r-full', status: 'refunded', refund_status: 'full', refund_amount: 120 };
  const succeeded = { ...base, id: 'r-ok', status: 'refunded', refund_status: 'succeeded', refund_amount: 120 };
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows, invoiceStatuses: [] } });
  const ung = (reply, rows, inbound = 'Where is my refund?') => replyQuotesUngroundedAmount(reply, ctx(rows), { byMeaning: true, inboundMessage: inbound });

  test('pending: only a refund actually pending grounds it (the payment status is irrelevant)', () => {
    expect(ung('Your $30 refund is pending.', [pending])).toBe(false);
    expect(ung('Your refund is still processing.', [pending])).toBe(false);
    expect(ung('Your $30 refund is pending.', [partialDone])).toBe(true); // completed, not pending
    expect(ung('Your $30 refund is pending.', [failedRefund])).toBe(true);
    expect(ung('Your $30 refund is pending.', [{ ...base }])).toBe(true); // no refund at all
    // a PENDING payment attempt is not a pending refund
    expect(ung('Your $30 refund is pending.', [{ ...base, status: 'pending' }])).toBe(true);
  });
  test('completed: a succeeded / full / partial refund grounds it; a pending or failed one does not', () => {
    expect(ung('Your $30 refund was issued.', [partialDone])).toBe(false);
    expect(ung('Your $120 refund was issued.', [succeeded])).toBe(false);
    expect(ung('Your refund was issued.', [fullRefund])).toBe(false);
    expect(ung('Your $30 refund was issued.', [pending])).toBe(true);
    expect(ung('Your $30 refund was issued.', [failedRefund])).toBe(true);
    expect(ung('Your $120 refund was issued.', [partialDone])).toBe(true); // that is not what was refunded
  });
  test('failed: only a failed / canceled refund grounds it', () => {
    expect(ung('Your refund failed.', [failedRefund])).toBe(false);
    expect(ung('Your refund failed.', [partialDone])).toBe(true);
    expect(ung('Your refund failed.', [{ ...base, status: 'failed' }])).toBe(true); // a failed PAYMENT is not a failed refund
  });
  test('the named amount must be the refund: two refunds in different states => every matching refund must agree', () => {
    expect(ung('Your $30 refund is pending.', [pending, { ...partialDone, id: 'r-other', refund_amount: 15 }])).toBe(false);
    expect(ung('Your refund is pending.', [pending, partialDone])).toBe(true); // ambiguous without an amount
  });
  test('payment-subject wording is unchanged: "Your payment is pending" still binds to the payment status', () => {
    expect(ung('Your payment is pending.', [{ ...base, status: 'pending' }], 'Is my payment pending?')).toBe(false);
    expect(ung('Your payment was refunded.', [fullRefund], 'Was my payment refunded?')).toBe(false);
  });
});

// Codex round-35 P1: every invoice number named must resolve and satisfy the claim.
describe('round-35: several named invoices are each resolved and each must satisfy the claim', () => {
  const invs = [
    { id: 'i1', invoiceNumber: 'WPC-2026-0123', status: 'paid', total: 120, amountDue: 0 },
    { id: 'i2', invoiceNumber: 'WPC-2026-0124', status: 'sent', total: 95, amountDue: 95 },
  ];
  const ctx = (list) => ({ billing: { outstandingBalance: 95, recentPayments: [], invoiceStatuses: list } });
  const ung = (reply, inbound, list = invs) => replyQuotesUngroundedAmount(reply, ctx(list), { byMeaning: true, inboundMessage: inbound });

  test('both named invoices satisfy => grounded; one does not => ungrounded', () => {
    const allPaid = invs.map((i) => ({ ...i, status: 'paid', amountDue: 0 }));
    expect(ung('Invoice #0123 is paid. Invoice #0124 is paid.', 'Are invoices 0123 and 0124 paid?', allPaid)).toBe(false);
    expect(ung('Invoice #0123 is paid. Invoice #0124 is paid.', 'Are invoices 0123 and 0124 paid?')).toBe(true); // 0124 is open
    expect(require('../services/zelle-target-invoice').invoiceNumbersNamed('Are invoices 0123, 0124 or 0125 paid?').tail).toEqual(['0123', '0124', '0125']);
    expect(require('../services/zelle-target-invoice').invoiceNumbersNamed('I paid invoice 0123 and 50 dollars').tail).toEqual(['0123']);
  });
  test('a named number missing from the list is ungrounded — never silently dropped', () => {
    expect(ung('Invoice #0123 is paid. Invoice #0999 is paid.', 'Are invoices 0123 and 0999 paid?')).toBe(true);
    expect(ung('Your invoice is paid.', 'Are invoices 0123 and 0999 paid?', invs.map((i) => ({ ...i, status: 'paid', amountDue: 0 })))).toBe(true); // 0999 is not on the account
    expect(ung('Invoice #0123 is paid.', 'Is invoice 0123 paid?')).toBe(false);
  });
  test('the customer\'s numbers decide when the reply names none: a generic "it is paid" covers every invoice they asked about', () => {
    expect(ung('Your invoice is paid.', 'Are invoices 0123 and 0124 paid?')).toBe(true);
    expect(ung('Your invoice is paid.', 'Is invoice 0123 paid?')).toBe(false);
  });
  test('a reply number the customer did not ask about is a different invoice => ungrounded', () => {
    expect(ung('Invoice #0124 is paid.', 'Is invoice 0123 paid?', invs.map((i) => ({ ...i, status: 'paid', amountDue: 0 })))).toBe(true);
  });
});

// Codex round-35 P1: several dates / amounts in the customer's message are several payments.
describe('round-35: an inbound naming several payment dates or amounts has no single payment identity', () => {
  const rowSep1 = { id: 'a', amount: 120, status: 'paid', payment_date: '2026-09-01', payment_method_type: 'card' };
  const rowSep2 = { id: 'b', amount: 120, status: 'paid', payment_date: '2026-09-02', payment_method_type: 'card' };
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows, invoiceStatuses: [] } });
  const ung = (reply, rows, inbound) => replyQuotesUngroundedAmount(reply, ctx(rows), { byMeaning: true, inboundMessage: inbound });
  const ask = 'Did my payment from Sep 1 or Sep 2 go through?';

  test('a reply naming no date is ambiguous => ungrounded, even when only the FIRST date has a payment', () => {
    expect(ung('We received your payment.', [rowSep1], ask)).toBe(true);
    expect(ung('Your payment is paid.', [rowSep1, rowSep2], ask)).toBe(true);
  });
  test('a reply that explicitly names one of the dates binds to it', () => {
    expect(ung('We received your $120 payment from Sep 1.', [rowSep1], ask)).toBe(false);
    expect(ung('We received your $120 payment from Sep 2.', [rowSep1], ask)).toBe(true); // nothing on Sep 2
    expect(ung('We received your $120 payment from Sep 3.', [rowSep1], ask)).toBe(true); // not one of the dates asked about
  });
  test('one date stays exactly as before', () => {
    expect(ung('We received your $120 payment from Sep 1.', [rowSep1], 'Did my Sep 1 payment go through?')).toBe(false);
  });
  test('several distinct amounts: a reply stating no amount is ambiguous; one stating an asked amount is explicit', () => {
    const r120 = { ...rowSep1, amount: 120 };
    const r95 = { ...rowSep1, id: 'c', amount: 95, payment_date: '2026-09-05' };
    const inbound = 'Did you get my $120 or my $95 payment?';
    expect(ung('Your payment is processing.', [{ ...r120, status: 'pending' }], inbound)).toBe(true);
    expect(ung('We received your $120 payment from Sep 1.', [r120, r95], inbound)).toBe(false);
  });
  test('surfacing a referenced older payment matches ANY of the dates named', () => {
    const { paymentIdentityFromText, paymentRowMatchesIdentity } = require('../services/sms-shadow-drafter');
    const id = paymentIdentityFromText(ask);
    expect(id.dates).toHaveLength(2);
    expect(paymentRowMatchesIdentity(rowSep1, id)).toBe(true);
    expect(paymentRowMatchesIdentity(rowSep2, id)).toBe(true);
    expect(paymentRowMatchesIdentity({ ...rowSep1, payment_date: '2026-09-03' }, id)).toBe(false);
  });
});

// Codex round-36 P1: a FULL invoice reference is a full identifier (WPC-2025-0123 is not WPC-2026-0123).
describe('round-36: full invoice references are compared as full identifiers', () => {
  const invs = [
    { id: 'i25', invoiceNumber: 'WPC-2025-0123', status: 'paid', total: 120, amountDue: 0 },
    { id: 'i26', invoiceNumber: 'WPC-2026-0123', status: 'sent', total: 95, amountDue: 95 },
  ];
  const ctx = (list) => ({ billing: { outstandingBalance: 95, recentPayments: [], invoiceStatuses: list } });
  const ung = (reply, inbound, list = invs) => replyQuotesUngroundedAmount(reply, ctx(list), { byMeaning: true, inboundMessage: inbound });

  test('a reply naming the full WPC-2025-0123 does not agree with an inbound about WPC-2026-0123', () => {
    expect(ung('Invoice WPC-2025-0123 is paid.', 'Is invoice WPC-2026-0123 paid?')).toBe(true);
    expect(ung('Invoice WPC-2026-0123 is paid.', 'Is invoice WPC-2026-0123 paid?')).toBe(true); // 2026 is open, not paid
    expect(ung('Invoice WPC-2025-0123 is paid.', 'Is invoice WPC-2025-0123 paid?')).toBe(false);
  });
  test('each year resolves to ITS invoice (the status claim is judged on the right one)', () => {
    expect(ung('Invoice WPC-2026-0123 is still unpaid.', 'Is invoice WPC-2026-0123 still unpaid?')).toBe(false);
    expect(ung('Invoice WPC-2025-0123 is still unpaid.', 'Is invoice WPC-2025-0123 still unpaid?')).toBe(true);
  });
  test('a tail-only reference matches by tail only when the customer supplied a tail: two invoices sharing it are ambiguous', () => {
    expect(ung('Invoice #0123 is paid.', 'Is invoice 0123 paid?')).toBe(true); // matches both years => ambiguous => ungrounded
    expect(ung('Invoice #0123 is paid.', 'Is invoice 0123 paid?', [invs[0]])).toBe(false); // only one invoice has that tail
  });
  test('a tail-only reply about the invoice the customer named IN FULL means that full invoice', () => {
    expect(ung('Invoice #0123 is paid.', 'Is invoice WPC-2025-0123 paid?')).toBe(false); // resolves to the 2025 invoice, which is paid
    expect(ung('Invoice #0123 is paid.', 'Is invoice WPC-2026-0123 paid?')).toBe(true); // resolves to the 2026 invoice, which is open
  });
});

// Codex round-36 P1: a generic refund reply takes the customer's amount / date / tender, or the most recent refund.
describe('round-36: refund claims use the inbound identity fallback and the most-recent rule', () => {
  const mk = (id, date, rs, amount, extra = {}) => ({ id, amount: 120, status: 'paid', payment_date: date, payment_method_type: 'card', refund_status: rs, refund_amount: amount, created_at: `${date}T12:00:00Z`, ...extra });
  const ctx = (rows) => ({ billing: { outstandingBalance: 0, recentPayments: rows, invoiceStatuses: [] } });
  const ung = (reply, rows, inbound) => replyQuotesUngroundedAmount(reply, ctx(rows), { byMeaning: true, inboundMessage: inbound });
  const oldDone = mk('old', '2026-08-01', 'partial', 30);
  const newPending = mk('new', '2026-09-20', 'pending', 40, { status: 'refunded' });

  test('an identity-free inbound => the MOST RECENT refund decides (an older refund in another state cannot back or sink it)', () => {
    expect(ung('Your refund is pending.', [oldDone, newPending], 'Where is my refund?')).toBe(false);
    expect(ung('Your refund was issued.', [oldDone, newPending], 'Where is my refund?')).toBe(true); // the newest is pending
    expect(ung('Your refund is pending.', [newPending, oldDone], 'Where is my refund?')).toBe(false); // order-independent
  });
  test('the customer\'s amount is the fallback identity: "Your refund is pending" about the $30 refund binds to THAT refund', () => {
    expect(ung('Your refund was issued.', [oldDone, newPending], 'Did my $30 refund go through?')).toBe(false);
    expect(ung('Your refund is pending.', [oldDone, newPending], 'Did my $30 refund go through?')).toBe(true); // the $30 one is completed
    expect(ung('Your refund is pending.', [oldDone, newPending], 'Where is my $40 refund?')).toBe(false);
  });
  test('the customer\'s date is the fallback identity', () => {
    expect(ung('Your partial refund was issued.', [oldDone, newPending], 'Did my Aug 1 payment get refunded?')).toBe(false);
    expect(ung('Your refund is pending.', [oldDone, newPending], 'Did my Aug 1 payment get refunded?')).toBe(true);
  });
  test('the customer\'s tender is the fallback identity; a reply identity the customer did not ask about is a different payment', () => {
    const ach = mk('ach', '2026-09-25', 'pending', 40, { status: 'refunded', payment_method_type: 'us_bank_account' });
    expect(ung('Your refund is pending.', [oldDone, ach], 'Where is the refund for my card payment?')).toBe(true); // the card refund is completed
    expect(ung('Your refund is pending.', [oldDone, ach], 'Where is the refund for my ACH payment?')).toBe(false);
    expect(ung('Your $40 refund is pending.', [oldDone, newPending], 'Where is my $30 refund?')).toBe(true);
  });
  test('several distinct amounts / dates named and a silent reply => ambiguous', () => {
    expect(ung('Your refund is pending.', [oldDone, newPending], 'Did my $30 or $40 refund go through?')).toBe(true);
    expect(ung('Your $40 refund is pending.', [oldDone, newPending], 'Did my $30 or $40 refund go through?')).toBe(false);
  });
});

// Codex round-36 P1: partially_paid — SMS agrees with the portal balance and fails closed on settlement.
describe('round-36: a partially_paid invoice with an amount due makes settlement claims ungrounded', () => {
  const partial = { id: 'ip', invoiceNumber: 'WPC-2026-0003', status: 'partially_paid', total: 100, amountDue: 40 };
  const billing = (extra = {}) => ({ outstandingBalance: 0, recentPayments: [], invoiceStatuses: [partial], hasUncountedPartialDue: true, ...extra });
  const ung = (reply, b = billing(), inbound) => replyQuotesUngroundedAmount(reply, { billing: b }, { byMeaning: true, inboundMessage: inbound });
  test('settlement / zero balance are ungrounded; without the uncounted partial they stand', () => {
    for (const r of ["You're paid up.", 'Your account is current.', 'Your balance is $0.', "You don't owe anything."]) expect({ r, ung: ung(r) }).toEqual({ r, ung: true });
    expect(ung("You're paid up.", billing({ hasUncountedPartialDue: false, invoiceStatuses: [] }))).toBe(false);
  });
  test('an unpaid claim about that invoice binds through its status (partially paid with an amount due => still unpaid)', () => {
    expect(ung('Invoice #0003 is still unpaid.', billing(), 'Is invoice 0003 unpaid?')).toBe(false);
    expect(ung('Invoice #0003 is still unpaid.', billing({ invoiceStatuses: [{ ...partial, amountDue: 0, status: 'paid' }] }), 'Is invoice 0003 unpaid?')).toBe(true);
  });
  test('the model-facing facts say so (gate on only; gate off stays byte-identical)', () => {
    const { buildFactsBlock } = require('../services/sms-shadow-drafter');
    const context = { customer: { first_name: 'Test' }, billing: { ...billing(), unavailable: false } };
    const prior = process.env.GATE_SMS_REAL_ANSWERS;
    try {
      process.env.GATE_SMS_REAL_ANSWERS = 'true';
      expect(buildFactsBlock(context)).toMatch(/PARTIALLY PAID/);
      delete process.env.GATE_SMS_REAL_ANSWERS;
      expect(buildFactsBlock(context)).not.toMatch(/PARTIALLY PAID/);
    } finally { if (prior === undefined) delete process.env.GATE_SMS_REAL_ANSWERS; else process.env.GATE_SMS_REAL_ANSWERS = prior; }
  });
});
