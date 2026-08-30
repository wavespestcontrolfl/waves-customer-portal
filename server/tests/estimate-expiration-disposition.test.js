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


// Revival clears the sweep's classification (codex pre-push P1): an
// extended expired estimate is a live courtship again.
describe('extension revival', () => {
  const { extendEstimate } = require('../services/estimate-extension');

  test('extending an expired_unviewed row nulls the expiry disposition fields', async () => {
    const calls = [];
    const q = {};
    const chain = (name) => (...args) => {
      if (typeof args[0] === 'function' && name === 'where') { args[0].call(q, q); }
      calls.push([name, ...args]);
      return name === 'update' ? Promise.resolve(1) : q;
    };
    ['where', 'whereNull', 'orWhere', 'update', 'first', 'whereIn', 'whereNot', 'select'].forEach((m) => { q[m] = chain(m); });
    db.mockImplementation(() => q);
    db.fn = { now: () => 'NOW' };

    await extendEstimate({
      estimate: {
        id: 'e1', status: 'expired', sent_at: '2026-08-01T00:00:00Z', viewed_at: null,
        expires_at: '2026-08-08T00:00:00Z', archived_at: null, estimate_data: {},
        disposition: 'expired_unviewed', estimate_group_id: null,
      },
      days: 7,
      silent: true,
      entryPoint: 'test',
    });

    const update = calls.find(([m]) => m === 'update')[1];
    expect(update.status).toBe('sent');
    expect(update).toMatchObject({ disposition: null, disposition_source: null, disposition_at: null });
  });
});


// Never-delivered rows cannot be extended (GH codex P2): reviving an
// expired_unsent draft to 'sent' would erase the classification that keeps
// internal drafts out of the loss rates.
test('extending a never-sent expired draft is rejected', async () => {
  const { extendEstimate } = require('../services/estimate-extension');
  await expect(extendEstimate({
    estimate: {
      id: 'e1', status: 'expired', sent_at: null, viewed_at: null,
      expires_at: '2026-08-08T00:00:00Z', archived_at: null, estimate_data: {},
      disposition: 'expired_unsent', estimate_group_id: null,
    },
    days: 7,
    silent: true,
    entryPoint: 'test',
  })).rejects.toThrow(/never sent/);
});
