/**
 * A claim-state read that FAILS is "unknown", never "released": reporting a
 * still-claimed ask as settled lets the caller reset it and send a second
 * solicitation on top of one the provider already accepted.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const ReviewRequest = require('../services/review-request');

function reviewRequestsChain(first) {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(first);
  return q;
}

beforeEach(() => jest.clearAllMocks());

test('a settled row reports the outcome as known', async () => {
  db.mockImplementation(() => reviewRequestsChain(async () => ({ status: 'sent' })));
  expect(await ReviewRequest._providerOutcomeUnknown('rr-1')).toBe(false);
});

test('a claimed row reports the outcome as unknown', async () => {
  db.mockImplementation(() => reviewRequestsChain(async () => ({ status: 'sending' })));
  expect(await ReviewRequest._providerOutcomeUnknown('rr-1')).toBe(true);
});

test('a FAILED read reports unknown, so the claim is preserved', async () => {
  db.mockImplementation(() => reviewRequestsChain(async () => { throw new Error('connection reset'); }));
  expect(await ReviewRequest._providerOutcomeUnknown('rr-1')).toBe(true);
  expect(require('../services/logger').error).toHaveBeenCalledWith(expect.stringContaining('unknown'));
});
