const {
  mayAssertPaymentStatus, RECEIPT_VERB_RE, THANKS_FOR_PAYMENT_RE, paymentAckPatternSource,
} = require('../services/payment-receipt-vocabulary');
const drafter = require('../services/sms-shadow-drafter');

describe('payment-receipt-vocabulary', () => {
  test('mayAssertPaymentStatus is a superset of every drafter status/ack claim (Codex round-6, PR #5331)', () => {
    const claims = [
      "You're paid up.", 'You are paid up!', 'Paid in full, thank you.', "You're all paid.", 'Your account is current.',
      'Your account is up to date.', 'Your payment cleared.', 'We have your payment.', 'We received your payment.',
      'Thanks for your Zelle payment!', 'The payment went through.', 'Payment is complete.',
    ];
    for (const c of claims) {
      const flagged = drafter.hasAffirmativePaymentAck(c) || drafter.paymentStatusClaimKind(c) != null;
      expect(flagged).toBe(true);
      expect(mayAssertPaymentStatus(c)).toBe(true);
    }
  });

  test('gratitude / scheduling copy names no payment word and is skipped', () => {
    for (const c of ["You're welcome, Dana! Glad we could help.", 'See you Tuesday at 9!', '']) {
      expect(mayAssertPaymentStatus(c)).toBe(false);
    }
    expect(mayAssertPaymentStatus(null)).toBe(false);
  });

  test('the shared verb list and thank-you construction are what both callers use', () => {
    expect(RECEIPT_VERB_RE.test('it came through')).toBe(true);
    expect(THANKS_FOR_PAYMENT_RE.test('Thanks for the payment')).toBe(true);
    expect(new RegExp(paymentAckPatternSource(), 'i').test('the payment cleared')).toBe(true);
  });
});

describe('Codex round-9 P1: the prescreen is built from the full status table', () => {
  const { PAYMENT_STATUS_VOCABULARY, paymentStatusPhraseClaim } = require('../services/payment-receipt-vocabulary');
  test('EVERY phrase of EVERY family passes the prescreen (guaranteed superset)', () => {
    for (const [family, { phrases }] of Object.entries(PAYMENT_STATUS_VOCABULARY)) {
      for (const phrase of phrases) {
        expect({ family, phrase, screened: mayAssertPaymentStatus(`It ${phrase}.`) }).toEqual({ family, phrase, screened: true });
        expect({ family, phrase, screened: mayAssertPaymentStatus(phrase) }).toEqual({ family, phrase, screened: true });
      }
    }
  });
  test('bare replies the classifier recognizes with a payment inbound are screened in', () => {
    for (const c of ['It failed.', "We haven't received it yet.", "It isn't reflected yet.", "It hasn't posted.", 'It was refunded.']) {
      expect(paymentStatusPhraseClaim(c, true)).not.toBeNull();
      expect(mayAssertPaymentStatus(c)).toBe(true);
    }
  });
  test('copy that asserts nothing about payments is still skipped', () => {
    expect(mayAssertPaymentStatus("You're welcome, Dana! Glad we could help.")).toBe(false);
    expect(mayAssertPaymentStatus('See you Tuesday at 9!')).toBe(false);
  });
});

// Codex round-16 P1: a zero-balance claim needs the COMPLETE amount to be zero.
describe('zeroBalanceClaim / ZERO_BALANCE_RE', () => {
  const { zeroBalanceClaim } = require('../services/payment-receipt-vocabulary');
  test.each([
    'Your balance is $0.', 'Your balance is $0.00.', 'Your balance is $0', 'Your balance is 0.00.', 'Your balance is zero.',
    'You have a $0 balance.', 'You have a $0.00 balance', 'You have a zero balance', 'You owe $0.', 'You owe us $0.00.',
  ])('zero: %s', (t) => { expect(zeroBalanceClaim(t)).toBe(true); });
  test.each([
    'Your balance is $0.99.', 'Your balance is $0.50.', 'Your balance is $0.01.', 'You have a $0.99 balance', 'You owe $0.99.',
    'You owe us $0.05', 'Your balance is $0,50.', 'Your balance is $10.00.', 'Is your balance zero?',
  ])('not zero: %s', (t) => { expect(zeroBalanceClaim(t)).toBe(false); });
});
