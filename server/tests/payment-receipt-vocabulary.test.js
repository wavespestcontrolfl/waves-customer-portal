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
