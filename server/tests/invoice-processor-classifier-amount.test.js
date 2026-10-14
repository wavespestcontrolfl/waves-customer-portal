// The classifier returns the amount as printed. parseFloat('$10.06') is NaN,
// so receipts with a dollar sign were skipped as "no_amount". Synthetic values.
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const { classifierAmount } = require('../services/email/invoice-processor');

test.each([
  ['$10.06', 10.06],
  ['$1,234.50', 1234.5],
  ['1,234.50 USD', 1234.5],
  ['USD 45', 45],
  ['  $ 7.5 ', 7.5],
  ['200', 200],
  [12.34, 12.34],
  [12.345, 12.345],
  [1.005, 1.005],
  [9999999999.99, 9999999999.99],
])('reads %p as %p', (input, expected) => {
  expect(classifierAmount(input)).toBe(expected);
});

test.each([
  ['$10.06 and $5.00'], ['about $10'], ['$10,000,000,000.00'], [1e10], [Infinity], [9999999999.999], ['$9,999,999,999.999'], ['9'.repeat(400)], ['10.06 EUR'], ['$1,23.00'], ['unknown'], [''], [null], [{ amount: 5 }], [NaN], ['$10.123'],
])('rejects %p', (input) => {
  expect(classifierAmount(input)).toBeNull();
});
