/**
 * stampCustomerPreferredLanguage — the ONE customers.preferred_language writer
 * (empty-only, non-blocking), shared by the ElevenLabs lead webhook path and
 * the inbound relay's Spanish session.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const { stampCustomerPreferredLanguage } = require('../services/lead-from-extraction');

function chain(updateResult = 1, throws = null) {
  const q = {};
  ['where', 'whereRaw'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.update = jest.fn(async () => { if (throws) throw throws; return updateResult; });
  return q;
}
beforeEach(() => jest.clearAllMocks());

test('writes the normalized language empty-only', async () => {
  const q = chain(1); db.mockImplementation(() => q);
  expect(await stampCustomerPreferredLanguage('cust-1', 'ES')).toBe(true);
  expect(q.where).toHaveBeenCalledWith({ id: 'cust-1' });
  expect(q.whereRaw).toHaveBeenCalledWith("COALESCE(preferred_language, '') = ''");
  expect(q.update).toHaveBeenCalledWith({ preferred_language: 'es' });
});
test('missing customer or language ⇒ no write', async () => {
  db.mockImplementation(() => chain(1));
  expect(await stampCustomerPreferredLanguage(null, 'es')).toBe(false);
  expect(await stampCustomerPreferredLanguage('cust-1', '')).toBe(false);
  expect(db).not.toHaveBeenCalled();
});
test('a prior preference is never clobbered (0 rows ⇒ false); a DB error is non-blocking', async () => {
  db.mockImplementation(() => chain(0));
  expect(await stampCustomerPreferredLanguage('cust-1', 'es')).toBe(false);
  db.mockImplementation(() => chain(1, new Error('locked')));
  expect(await stampCustomerPreferredLanguage('cust-1', 'es')).toBe(false);
});
