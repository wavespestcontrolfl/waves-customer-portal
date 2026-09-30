// invoiceCreditWouldFullyCover moved to services/pay-combined.js (dunning
// consolidation PR 1) so the customer dunning set can mirror pay-v2's own
// preview predicate; pay-v2 re-exports it unchanged (the retained named
// export, and the call sites inside pay-v2 that read it).
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: { autoApplyAccountCredit: true } }));

const payV2 = require('../routes/pay-v2');
const payCombined = require('../services/pay-combined');

test('pay-v2 re-exports the very same function as pay-combined', () => {
  expect(typeof payCombined.invoiceCreditWouldFullyCover).toBe('function');
  expect(payV2.invoiceCreditWouldFullyCover).toBe(payCombined.invoiceCreditWouldFullyCover);
});
