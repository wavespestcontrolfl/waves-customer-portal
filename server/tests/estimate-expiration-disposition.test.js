/**
 * The 6am expiry sweep stamps WHY (estimator audit 2026-08-29 P0): both
 * rules write disposition/disposition_source/disposition_at in the SAME
 * UPDATE that flips status, via the pre-update-row CASE, and RETURN the
 * disposition so the log can count never-opened losses.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-conversion-guard', () => ({ excludePendingFirstBookings: jest.fn((q) => q) }));
jest.mock('../services/estimate-deposits', () => ({ sweepTerminalEstimateDeposits: jest.fn(async () => undefined) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => undefined) }));

const db = require('../models/db');
const logger = require('../services/logger');
const { runEstimateExpiration } = require('../services/estimate-expiration');
const { EXPIRED_DISPOSITION_SQL } = require('../services/estimate-disposition');

function makeQuery(updateResult) {
  const q = {};
  const updates = [];
  const chain = () => q;
  ['where', 'whereIn', 'whereNot', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhere', 'orWhereRaw', 'modify']
    .forEach((m) => { q[m] = jest.fn(chain); });
  q.update = jest.fn((payload, returning) => { updates.push({ payload, returning }); return Promise.resolve(updateResult); });
  return { q, updates };
}

test('both rules stamp disposition in the flip UPDATE and return it', async () => {
  const rule1 = makeQuery([
    { id: 'a', customer_name: 'A', disposition: 'expired_unviewed' },
    { id: 'b', customer_name: 'B', disposition: 'expired_viewed' },
  ]);
  const rule2 = makeQuery([{ id: 'c', customer_name: 'C', disposition: 'expired_unviewed' }]);
  db.mockImplementationOnce(() => rule1.q).mockImplementationOnce(() => rule2.q);

  const result = await runEstimateExpiration();
  expect(result).toEqual({ aged: 2, dateExpired: 1 });

  for (const { updates } of [rule1, rule2]) {
    expect(updates).toHaveLength(1);
    const { payload, returning } = updates[0];
    expect(payload.status).toBe('expired');
    expect(payload.disposition).toEqual({ __raw: EXPIRED_DISPOSITION_SQL, bindings: undefined });
    expect(payload.disposition_source.__raw).toContain("COALESCE(disposition_source, 'system')");
    expect(payload.disposition_at.__raw).toContain('COALESCE(disposition_at, ?)');
    expect(payload.disposition_at.bindings[0]).toBeInstanceOf(Date);
    expect(returning).toContain('disposition');
  }
  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('unviewed=2'));
});
