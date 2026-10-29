/**
 * The every-5-minute scheduled-SMS tick records its stale-claim recovery and
 * claim in job health, the lease-free way: every replica claims (FOR UPDATE
 * SKIP LOCKED is the fence), so cron-lock does not wrap the tick. A throw there
 * used to return through a bare catch with no log and no record, so a claim
 * that kept failing stopped every scheduled text unseen (weekly sweep
 * 2026-10-03, finding B1). The DB-gated tick suites only run healthy claims.
 * Same mocking shape as scheduler-ib-cancel-recovery.test.js.
 */
jest.mock('../utils/scheduled-cron', () => ({ schedule: jest.fn(), scheduleTimeout: jest.fn(), scheduleInterval: jest.fn() }));
jest.mock('../models/db', () => {
  const chain = { where() { return this; }, whereRaw() { return this; }, update: jest.fn().mockResolvedValue(0), del: jest.fn().mockResolvedValue(0) };
  const db = jest.fn(() => chain);
  db.raw = jest.fn();
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((name) => name === 'cronJobs'), gateEnvValue: jest.fn(() => false), logGateStatus: jest.fn(),
  neighborhoodAccessLive: jest.fn(() => false),
}));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async () => {}),
  settleDeadRunningJobs: jest.fn(async () => []),
  recordMissedTick: jest.fn(async () => {}),
  recordLeaseFreeJobEnd: jest.fn(async () => {}),
}));
jest.mock('../services/messaging/deferred-replay-registry', () => ({
  DURABLE_FINALIZE_ENTRY_POINTS: [],
  TERMINAL_HOOK_ENTRY_POINTS: [],
  sweepPendingTerminalHooks: jest.fn(async () => ({ candidates: 0, reran: 0 })),
}));
jest.mock('../services/sms-suggest-mode', () => ({ recoverSuggestionHoldingStates: jest.fn(async () => {}) }));
jest.mock('../services/sms-auto-send', () => ({ reconcileAutoSendClaims: jest.fn(async () => {}) }));

const cron = require('../utils/scheduled-cron');
const db = require('../models/db');
const logger = require('../services/logger');
const { recordLeaseFreeJobEnd } = require('../utils/cron-lock');
const { initScheduledJobs } = require('../services/scheduler');

const CLAIM_SQL = 'FOR UPDATE SKIP LOCKED';
const SETTLE_SQL = "SET status = 'sent'";

function tick() {
  initScheduledJobs();
  const regs = cron.schedule.mock.calls.filter(([, cb]) => String(cb).includes('claimDueScheduledSms(now)'));
  expect(regs).toHaveLength(1);
  expect(regs[0][0]).toBe('*/5 * * * *');
  return regs[0][1];
}

// Every statement answers with no rows, except the one whose SQL contains
// `failOn`, which rejects with `err`.
function rawFailing(failOn, err) {
  db.raw.mockImplementation((sql) => (failOn && String(sql).includes(failOn) ? Promise.reject(err) : Promise.resolve({ rows: [] })));
}
const claimCalls = () => db.raw.mock.calls.filter(([sql]) => String(sql).includes(CLAIM_SQL));
const claimFailedLogs = () => logger.error.mock.calls.filter(([line]) => String(line).startsWith('[scheduled-sms] claim failed'));

beforeEach(() => {
  jest.clearAllMocks();
});

test('a clean claim is a successful run in job health', async () => {
  rawFailing(null);
  await tick()();
  expect(claimCalls()).toHaveLength(1);
  expect(recordLeaseFreeJobEnd).toHaveBeenCalledTimes(1);
  expect(recordLeaseFreeJobEnd).toHaveBeenCalledWith('scheduled-sms-claim', expect.any(Number), null);
  expect(claimFailedLogs()).toHaveLength(0);
});

test('a claim that throws is logged by name and code only, and recorded as a failed run', async () => {
  // The message stands in for bound customer text a knex error can echo.
  const err = Object.assign(new Error('column "scheduled_for" does not exist, bound text Synthetic Fixture'), { code: '42703' });
  rawFailing(CLAIM_SQL, err);
  await expect(tick()()).resolves.toBeUndefined();
  expect(claimFailedLogs()).toEqual([['[scheduled-sms] claim failed, no scheduled texts sent this tick: Error 42703']]);
  expect(recordLeaseFreeJobEnd).toHaveBeenCalledTimes(1);
  expect(recordLeaseFreeJobEnd).toHaveBeenCalledWith('scheduled-sms-claim', expect.any(Number), err);
});

test('a stale-claim recovery that throws is recorded the same way, and nothing is claimed', async () => {
  const err = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
  rawFailing(SETTLE_SQL, err);
  await tick()();
  expect(claimCalls()).toHaveLength(0);
  expect(claimFailedLogs()).toEqual([['[scheduled-sms] claim failed, no scheduled texts sent this tick: Error ECONNRESET']]);
  expect(recordLeaseFreeJobEnd).toHaveBeenCalledTimes(1);
  expect(recordLeaseFreeJobEnd).toHaveBeenCalledWith('scheduled-sms-claim', expect.any(Number), err);
});
