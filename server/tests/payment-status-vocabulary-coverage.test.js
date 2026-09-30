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
    owed95: ctx([], { outstandingBalance: 95, openInvoice: { amountDue: 95 } }),
    paidAndOwed: ctx([row('paid')], { outstandingBalance: 95 }),
    everything: ctx([row('paid'), row('processing'), row('failed'), row('refunded'), row('disputed')], { outstandingBalance: 95, hasProcessingPayment: true }),
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
