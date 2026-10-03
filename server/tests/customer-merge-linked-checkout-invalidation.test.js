/**
 * The customer merge withdraws visit-linked invoices that moved to a payer (ownerTransitions) and its own
 * session release already invalidates the single-invoice checkouts of every invoice it can move: the
 * loser's always (they are repointed under the winner), the winner's when the merge transfers a payer
 * onto a blank-payer winner. A winner that already has a payer moves none of its own invoices.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { singleInvoiceSessionsInvalidatedByMerge } = require('../services/customer-dedupe');

test.each([
  ['blank winner, loser with a payer: both sides', { payer_id: null }, { payer_id: 4 }, { winner: true, loser: true }],
  ['payer-linked winner, blank loser: the loser only (the winner moves none of its own)', { payer_id: 3 }, { payer_id: null }, { winner: false, loser: true }],
  ['payer-linked winner and loser: the loser only', { payer_id: 3 }, { payer_id: 4 }, { winner: false, loser: true }],
  ['both blank: the loser only', { payer_id: null }, { payer_id: null }, { winner: false, loser: true }],
])('merge checkout invalidation: %s', (_name, winner, loser, expected) => {
  expect(singleInvoiceSessionsInvalidatedByMerge(winner, loser)).toEqual(expected);
});
