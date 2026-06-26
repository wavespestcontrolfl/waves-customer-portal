// Charge-in-person (Tap to Pay) defers annual-prepay term creation to the payment
// webhook: syncTermForInvoicePayment only creates the term when the paid invoice
// carries a well-formed annualPrepay payload. parseAnnualPrepayMeta is that gate —
// if it ever returned non-null for a malformed/absent payload, a stray term could
// be created (and a payment_pending term suppresses the customer's billing). These
// tests pin the contract.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn() }));

const { parseAnnualPrepayMeta } = require('../services/annual-prepay-renewals');

describe('parseAnnualPrepayMeta (charge-in-person deferred-term gate)', () => {
  const valid = {
    annualPrepay: {
      serviceType: 'Quarterly Pest Control',
      visitCount: 4,
      cadence: 'quarterly',
      termStart: '2026-07-01',
      termEnd: '2027-07-01',
      planLabel: 'WaveGuard',
      prepayAmount: 480,
    },
  };

  test('parses a valid object payload', () => {
    expect(parseAnnualPrepayMeta(valid)).toEqual({
      serviceType: 'Quarterly Pest Control',
      visitCount: 4,
      cadence: 'quarterly',
      termStart: '2026-07-01',
      termEnd: '2027-07-01',
      planLabel: 'WaveGuard',
      prepayAmount: 480,
    });
  });

  test('carries the pre-surcharge prepayAmount (coerces numeric strings; drops non-positive)', () => {
    expect(parseAnnualPrepayMeta({ annualPrepay: { visitCount: 4, prepayAmount: '600.50' } }).prepayAmount).toBe(600.5);
    // Non-positive/absent prepayAmount → undefined, so activation falls back to the paid total.
    expect(parseAnnualPrepayMeta({ annualPrepay: { visitCount: 4, prepayAmount: 0 } }).prepayAmount).toBeUndefined();
    expect(parseAnnualPrepayMeta({ annualPrepay: { visitCount: 4, prepayAmount: 'abc' } }).prepayAmount).toBeUndefined();
    expect(parseAnnualPrepayMeta({ annualPrepay: { visitCount: 4 } }).prepayAmount).toBeUndefined();
  });

  test('parses a valid JSON string payload (jsonb can arrive stringified)', () => {
    expect(parseAnnualPrepayMeta(JSON.stringify(valid))?.visitCount).toBe(4);
  });

  test('coerces a numeric-string visitCount', () => {
    expect(parseAnnualPrepayMeta({ annualPrepay: { visitCount: '6', cadence: 'bimonthly' } }))
      .toMatchObject({ visitCount: 6, cadence: 'bimonthly' });
  });

  test('normalizes missing optional fields to undefined (not empty string)', () => {
    const out = parseAnnualPrepayMeta({ annualPrepay: { visitCount: 4 } });
    expect(out).toEqual({
      serviceType: undefined,
      visitCount: 4,
      cadence: undefined,
      termStart: undefined,
      termEnd: undefined,
      planLabel: undefined,
      prepayAmount: undefined,
    });
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['malformed JSON', '{not json'],
    ['plain non-prepay metadata', { foo: 'bar' }],
    ['stringified non-prepay metadata', '{"foo":"bar"}'],
    ['zero visitCount', { annualPrepay: { visitCount: 0 } }],
    ['missing visitCount', { annualPrepay: { serviceType: 'X' } }],
    ['negative visitCount', { annualPrepay: { visitCount: -1 } }],
    ['non-numeric visitCount', { annualPrepay: { visitCount: 'abc' } }],
    ['empty annualPrepay', { annualPrepay: {} }],
  ])('returns null for %s (never creates a term)', (_label, input) => {
    expect(parseAnnualPrepayMeta(input)).toBeNull();
  });
});
