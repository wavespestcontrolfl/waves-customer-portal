// checkUnscheduledAskGates: the staffComposer option (Quick Links "send
// anytime") skips the active-cadence block, the 30-day cooldown and the
// 3-ask cap, and keeps the queued/in-flight checks. Default behavior is
// unchanged.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_key, fn) => fn()),
  wasLockSkipped: r => !!(r && r.skipped === true),
}));
const ReviewService = require('../services/review-request');

describe('checkUnscheduledAskGates staffComposer option', () => {
  const day = 86400000;
  let cadence;
  let stats;
  let pending;
  beforeEach(() => {
    cadence = false;
    stats = { count: 1, lastAt: new Date(Date.now() - 2 * day) };
    pending = null;
    jest.spyOn(ReviewService, '_activeCadenceFor').mockImplementation(async () => cadence);
    jest.spyOn(ReviewService, 'getDeliveredAskStats').mockImplementation(async () => stats);
    jest.spyOn(ReviewService, '_pendingOneOffAsk').mockImplementation(async () => pending);
  });
  afterEach(() => jest.restoreAllMocks());

  test('default: an active cadence, the cap and a 30-day cooldown still refuse', async () => {
    cadence = true;
    expect(await ReviewService.checkUnscheduledAskGates('c1')).toEqual({ allowed: false, outcome: 'in_cadence' });
    cadence = false;
    expect(await ReviewService.checkUnscheduledAskGates('c1')).toEqual({ allowed: false, outcome: 'cooldown' });
    stats = { count: 3, lastAt: new Date(Date.now() - 60 * day) };
    expect(await ReviewService.checkUnscheduledAskGates('c1')).toEqual({ allowed: false, outcome: 'at_cap' });
  });

  test('staffComposer: an active cadence and a recent ask no longer refuse', async () => {
    cadence = true;
    expect(await ReviewService.checkUnscheduledAskGates('c1', { staffComposer: true })).toEqual({ allowed: true });
    expect(ReviewService._activeCadenceFor).not.toHaveBeenCalled();
  });

  test('staffComposer: the 3-ask cap no longer refuses, and delivery stats are not read', async () => {
    stats = { count: 3, lastAt: new Date(Date.now() - 60 * day) };
    expect(await ReviewService.checkUnscheduledAskGates('c1', { staffComposer: true })).toEqual({ allowed: true });
    expect(ReviewService.getDeliveredAskStats).not.toHaveBeenCalled();
  });

  test('staffComposer: a queued or in-flight one-off ask still refuses', async () => {
    pending = { outcome: 'in_flight' };
    expect(await ReviewService.checkUnscheduledAskGates('c1', { staffComposer: true })).toEqual({ allowed: false, outcome: 'in_flight' });
    pending = { outcome: 'already_queued', queuedId: 'q1' };
    expect(await ReviewService.checkUnscheduledAskGates('c1', { staffComposer: true })).toMatchObject({ allowed: false, outcome: 'already_queued' });
  });

  test('default: a stats read failure still fails closed', async () => {
    ReviewService.getDeliveredAskStats.mockRejectedValue(new Error('db down'));
    await expect(ReviewService.checkUnscheduledAskGates('c1')).rejects.toThrow('db down');
  });
});
