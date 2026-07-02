/**
 * Expiration sweep vs the follow-up cadence (Codex P1, PR-bot round 1).
 *
 * The age rule used to flip sent/viewed estimates at 7 days regardless of
 * expires_at — with the cadence's 10-day price lock that expired quotes on
 * day 7, broke the "locked until {date}" promise, and starved the day-9
 * last-day touch. Pins: (1) the age rule only touches rows WITHOUT an
 * explicit expires_at, (2) the default threshold is 10 days, (3) the
 * explicit-date rule is unchanged.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-deposits', () => ({
  sweepTerminalEstimateDeposits: jest.fn(async () => {}),
  assessDepositFollowUpEligibility: jest.fn(),
  DEPOSIT_FOLLOWUP_WINDOW: { minAgeHours: 2, maxAgeHours: 72 },
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: jest.fn(async () => {}),
}));

const db = require('../models/db');
const { runEstimateExpiration } = require('../services/estimate-expiration');

function makeBuilder(calls) {
  const b = {};
  const record = (method) => jest.fn((...args) => {
    calls.push({ method, args });
    return b;
  });
  for (const m of ['whereIn', 'whereNotIn', 'whereNotNull', 'whereNull', 'where']) {
    b[m] = record(m);
  }
  b.update = jest.fn((payload) => {
    calls.push({ method: 'update', args: [payload] });
    return Promise.resolve(0);
  });
  return b;
}

describe('estimate expiration sweep', () => {
  let ruleCalls;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ESTIMATE_EXPIRATION_DAYS;
    ruleCalls = [];
    db.mockImplementation(() => {
      const calls = [];
      ruleCalls.push(calls);
      return makeBuilder(calls);
    });
  });

  test('age rule skips rows with an explicit expires_at (price-lock promise)', async () => {
    await runEstimateExpiration();

    const aged = ruleCalls[0];
    expect(aged).toContainEqual({ method: 'whereNull', args: ['expires_at'] });
    expect(aged).toContainEqual({ method: 'whereIn', args: ['status', ['sent', 'viewed']] });
  });

  test('default age threshold is 10 days, matching the cadence default expiry', async () => {
    const before = Date.now();
    await runEstimateExpiration();
    const after = Date.now();

    const sentAtCutoff = ruleCalls[0].find(
      (c) => c.method === 'where' && c.args[0] === 'sent_at',
    );
    expect(sentAtCutoff.args[1]).toBe('<');
    const cutoffMs = sentAtCutoff.args[2].getTime();
    const TEN_DAYS = 10 * 24 * 60 * 60 * 1000;
    expect(cutoffMs).toBeGreaterThanOrEqual(before - TEN_DAYS);
    expect(cutoffMs).toBeLessThanOrEqual(after - TEN_DAYS);
  });

  test('explicit expires_at rule still flips every non-terminal overdue row', async () => {
    await runEstimateExpiration();

    const dated = ruleCalls[1];
    expect(dated).toContainEqual({ method: 'whereNotNull', args: ['expires_at'] });
    expect(dated).toContainEqual({
      method: 'whereNotIn',
      args: ['status', ['expired', 'accepted', 'declined']],
    });
    // The date rule must NOT get the whereNull guard — it owns stamped rows.
    expect(dated.find((c) => c.method === 'whereNull' && c.args[0] === 'expires_at')).toBeUndefined();
  });

  test('env override still wins', async () => {
    process.env.ESTIMATE_EXPIRATION_DAYS = '3';
    const before = Date.now();
    await runEstimateExpiration();

    const sentAtCutoff = ruleCalls[0].find(
      (c) => c.method === 'where' && c.args[0] === 'sent_at',
    );
    const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
    expect(sentAtCutoff.args[2].getTime()).toBeGreaterThanOrEqual(before - THREE_DAYS - 1000);
    expect(sentAtCutoff.args[2].getTime()).toBeLessThanOrEqual(Date.now() - THREE_DAYS + 1000);
  });
});
