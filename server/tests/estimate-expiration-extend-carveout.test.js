/**
 * Estimate expiration — operator-extension carve-out.
 *
 * POST /:id/extend pushes expires_at forward (and texts the customer the new
 * deadline) but leaves sent_at untouched. The age rule (Rule 1) used to
 * expire on sent_at alone, so any extended estimate whose ORIGINAL send was
 * older than the threshold was re-expired at the next 6am cron — every
 * extension of an older estimate silently died within 24h, and the public
 * accept guard then blocked the customer from accepting.
 *
 * Contract: Rule 1 only applies when there is no live explicit deadline —
 * expires_at IS NULL, or expires_at has already passed (Rule 2 owns those
 * rows anyway). A future expires_at always wins over the inactivity rule.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-conversion-guard', () => ({
  excludePendingFirstBookings: jest.fn((q) => q),
}));
jest.mock('../services/estimate-deposits', () => ({
  sweepTerminalEstimateDeposits: jest.fn(async () => undefined),
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(async () => undefined),
}));

const db = require('../models/db');
const { runEstimateExpiration } = require('../services/estimate-expiration');

// Recording query chain: every builder call is captured; function args
// (grouped wheres, .modify) are invoked against a nested recorder so the
// carve-out's inner whereNull/orWhere calls are visible to assertions.
function makeQuery(updateResult = 0) {
  const calls = [];
  const q = {};
  const record = (name) => (...args) => {
    if (typeof args[0] === 'function') {
      const nested = makeQuery();
      args[0].call(nested.q, nested.q);
      calls.push([name, 'fn', nested.calls]);
    } else {
      calls.push([name, ...args]);
    }
    return name === 'update' ? Promise.resolve(updateResult) : q;
  };
  ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'orWhere', 'modify', 'update']
    .forEach((m) => { q[m] = record(m); });
  return { q, calls };
}

describe('runEstimateExpiration Rule 1 extension carve-out', () => {
  let rule1;
  let rule2;

  beforeEach(async () => {
    jest.clearAllMocks();
    rule1 = makeQuery(0);
    rule2 = makeQuery(0);
    db.mockReturnValueOnce(rule1.q).mockReturnValueOnce(rule2.q);
    await runEstimateExpiration();
  });

  test('Rule 1 skips rows whose explicit expires_at is still in the future', () => {
    const grouped = rule1.calls.filter(([name, kind]) => name === 'where' && kind === 'fn');
    const carveOut = grouped.find(([, , nested]) =>
      nested.some(([n, col]) => n === 'whereNull' && col === 'expires_at'));
    expect(carveOut).toBeDefined();
    const nested = carveOut[2];
    expect(nested).toContainEqual(['whereNull', 'expires_at']);
    const orWhere = nested.find(([n]) => n === 'orWhere');
    expect(orWhere).toBeDefined();
    expect(orWhere[1]).toBe('expires_at');
    expect(orWhere[2]).toBe('<=');
    expect(orWhere[3]).toBeInstanceOf(Date);
  });

  test('Rule 1 still ages out on sent_at for rows without a live deadline', () => {
    expect(rule1.calls).toContainEqual(['whereIn', 'status', ['sent', 'viewed']]);
    expect(rule1.calls).toContainEqual(['whereNotNull', 'sent_at']);
    const aged = rule1.calls.find(([n, col, op]) => n === 'where' && col === 'sent_at' && op === '<');
    expect(aged).toBeDefined();
    expect(aged[3]).toBeInstanceOf(Date);
  });

  test('Rule 2 (explicit expires_at passed) is unchanged', () => {
    expect(rule2.calls).toContainEqual(['whereNotNull', 'expires_at']);
    const passed = rule2.calls.find(([n, col, op]) => n === 'where' && col === 'expires_at' && op === '<');
    expect(passed).toBeDefined();
    expect(rule2.calls).toContainEqual(['whereNotIn', 'status', ['expired', 'accepted', 'declined']]);
  });
});
