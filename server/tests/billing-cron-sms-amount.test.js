const fs = require('fs');
const path = require('path');

const { resolveSmsAmount } = require('../services/billing-cron');

const BILLING_CRON_SRC = path.join(__dirname, '..', 'services', 'billing-cron.js');

describe('resolveSmsAmount', () => {
  test('returns a BARE NN.NN — the templates already print the $', () => {
    // "your payment of ${amount}": a pre-formatted "$12.34" here sends
    // "$$12.34" to the customer.
    expect(resolveSmsAmount(12.3)).toBe('12.30');
    expect(resolveSmsAmount(12)).toBe('12.00');
    expect(resolveSmsAmount(12.345)).toBe('12.35');
    expect(resolveSmsAmount(12.3)).not.toMatch(/\$/);
  });

  test('accepts the numeric STRING pg returns for a NUMERIC column', () => {
    // payments.amount arrives as '57.20', not 57.2.
    expect(resolveSmsAmount('57.20')).toBe('57.20');
    expect(resolveSmsAmount('57.2')).toBe('57.20');
  });

  test('rejects the literal that caused the incident', () => {
    // The exact value five call sites passed, which rendered
    // "your payment of $your payment" to 14 customers on 2026-06-01.
    expect(resolveSmsAmount('your payment')).toBeNull();
  });

  test('rejects every other unusable value rather than formatting garbage', () => {
    expect(resolveSmsAmount(null)).toBeNull();
    expect(resolveSmsAmount(undefined)).toBeNull();
    expect(resolveSmsAmount('')).toBeNull();
    expect(resolveSmsAmount(NaN)).toBeNull();
    expect(resolveSmsAmount(Infinity)).toBeNull();
    expect(resolveSmsAmount(-5)).toBeNull();
    expect(resolveSmsAmount({})).toBeNull();
    expect(resolveSmsAmount()).toBeNull();
  });

  test('zero is a real amount, not a missing one', () => {
    expect(resolveSmsAmount(0)).toBe('0.00');
    expect(resolveSmsAmount('0.00')).toBe('0.00');
  });

  test('takes ONE operand — a fallback cannot be smuggled in', () => {
    // The no-fallback rule is structural on purpose. Every plausible
    // fallback misstates the amount: monthly_rate and baseAmount are
    // pre-surcharge, and the original payment.amount carries the old
    // tender's gross. An extra argument must not rescue an unusable first
    // one.
    expect(resolveSmsAmount(null, '55.00')).toBeNull();
    expect(resolveSmsAmount('your payment', '55.00')).toBeNull();
    expect(resolveSmsAmount(undefined, 49)).toBeNull();
    expect(resolveSmsAmount.length).toBe(1);
  });
});

describe('billing-cron autopay SMS call sites', () => {
  const src = fs.readFileSync(BILLING_CRON_SRC, 'utf8');

  test('no call site passes a non-numeric literal into the {amount} slot', () => {
    // The regression itself: `amount: 'your payment'` typechecks, renders,
    // and ships. Only the customer sees the result, so guard it at the
    // source.
    expect(src).not.toMatch(/amount:\s*'your payment'/);
    // Any string literal in an amount: position is the same class of bug.
    const stringLiteralAmounts = src.match(/\bamount:\s*'[^']*'/g) || [];
    expect(stringLiteralAmounts).toEqual([]);
  });

  // The authoritative payments-row amount for the exact attempt each message
  // describes. Anything else — monthly_rate, baseAmount, the original
  // payment.amount — is pre-surcharge or belongs to a different attempt, and
  // is invisible in review because every one of them is a plausible dollar
  // figure.
  const REQUIRED_OPERAND = {
    autopay_charge_success: 'paymentResult?.amount',
    autopay_charge_failed: 'err.paymentRecord?.amount',
    autopay_retry_failed: 'err.paymentRecord?.amount',
    autopay_retry_final_failed: 'err.paymentRecord?.amount',
    autopay_retry_success: 'newPayment?.amount',
  };

  test.each(Object.entries(REQUIRED_OPERAND))(
    '%s quotes the exact attempt it describes, with no fallback',
    (key, operand) => {
      const idx = src.indexOf(`renderTemplate('${key}'`);
      expect(idx).toBeGreaterThan(-1);
      const preceding = src.slice(Math.max(0, idx - 900), idx);
      const call = preceding.slice(preceding.lastIndexOf('resolveSmsAmount('));
      const args = call.slice(call.indexOf('(') + 1, call.indexOf(')'));
      expect(args.trim()).toBe(operand);
      // A comma in the argument list IS the fallback bug.
      expect(args).not.toContain(',');
    },
  );

  test('every autopay template render resolves its amount first', () => {
    const AMOUNT_TEMPLATES = [
      'autopay_charge_success',
      'autopay_charge_failed',
      'autopay_retry_failed',
      'autopay_retry_final_failed',
      'autopay_retry_success',
    ];
    for (const key of AMOUNT_TEMPLATES) {
      // Each renderTemplate('<key>', ...) call must be preceded by a
      // resolveSmsAmount + a null guard within the same try block.
      const idx = src.indexOf(`renderTemplate('${key}'`);
      expect(idx).toBeGreaterThan(-1);
      const preceding = src.slice(Math.max(0, idx - 600), idx);
      expect(preceding).toContain('resolveSmsAmount(');
      expect(preceding).toMatch(/if \(!amountText\) throw new Error/);
    }
  });
});
