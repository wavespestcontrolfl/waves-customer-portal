jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const {
  runYearlyReviewAsk, anniversaryWindow, exclusionReason, YEARLY_STARTED_BY, MAX_ENROLL_PER_RUN,
} = require('../services/review-yearly-ask');

const NOW = new Date('2026-11-20T15:00:00Z'); // 10 AM ET, 2026-11-20
const DAY = 86400000;

function makeWorld(overrides = {}) {
  const world = {
    yearly: new Set(), active: new Set(), linked: new Set(), probable: new Set(), tap: new Set(),
    allowed: {}, stats: {}, manual: new Set(), failLookup: new Set(), started: [],
    ...overrides,
  };
  const guard = (id) => { if (world.failLookup.has(id)) throw new Error('synthetic lookup failure'); };
  world.reads = {
    yearlyAskSince: async (id) => { guard(id); return world.yearly.has(id); },
    activeSequence: async (id) => world.active.has(id),
    linkedGoogleReview: async (id) => world.linked.has(id),
  };
  world.services = {
    ClickGuard: {
      probableReviewer: async (id) => world.probable.has(id),
      tapPauseActive: async (id) => world.tap.has(id),
    },
    ReviewService: {
      reviewSmsAllowedNow: async (id) => world.allowed[id] || { allowed: true },
      getDeliveredAskStats: async (id) => world.stats[id] || { count: 0, lastAt: null },
      manualReviewAskSentRecently: async (id) => world.manual.has(id),
      startReviewSequence: jest.fn(async (args) => {
        world.started.push(args);
        world.yearly.add(args.customerId);
        return { started: true, sequence: { id: `seq-${args.customerId}` } };
      }),
      __private: {
        nextCadenceTickAt: (d) => new Date(d.getTime() + 60000),
        sequenceDecision: (o) => JSON.stringify(o),
      },
    },
  };
  return world;
}

const row = (id, firstOn) => ({ customer_id: id, first_on: firstOn });
// First recurring visit 2 years and 5 days ago: inside the 14-day window.
const IN_WINDOW = '2024-11-15';

function run(world, rows, extra = {}) {
  return runYearlyReviewAsk({
    now: NOW,
    deps: { reads: world.reads, services: world.services, loadCustomers: async () => rows, ...extra },
  });
}

beforeEach(() => jest.clearAllMocks());

describe('anniversaryWindow', () => {
  test.each([
    ['2025-11-20', 0, true],
    ['2025-11-06', 14, true],
    ['2025-11-05', 15, false],
    ['2025-11-21', null, false], // anniversary tomorrow: under a year
    ['2026-02-01', null, false], // under 12 months
    ['2020-11-15', 5, true], // a later year anniversary
  ])('first visit %s', (first, days, ok) => {
    const w = anniversaryWindow(first, '2026-11-20');
    if (ok) expect(w.daysSince).toBe(days); else expect(w).toBeNull();
  });
  test('a Feb 29 start anniversaries on Feb 28 in a common year', () => {
    expect(anniversaryWindow('2024-02-29', '2026-03-02')).toMatchObject({ anniversaryOn: '2026-02-28', daysSince: 2 });
  });
  test('bad input is no match', () => {
    expect(anniversaryWindow(null, '2026-11-20')).toBeNull();
  });
});

describe('who is picked', () => {
  test.each([
    ['a yearly ask in 365 days', (w) => w.yearly.add('c'), 'yearly_ask_in_365_days'],
    ['a linked Google review', (w) => w.linked.add('c'), 'has_google_review'],
    ['a probable reviewer', (w) => w.probable.add('c'), 'probable_reviewer'],
    ['texts off', (w) => { w.allowed.c = { allowed: false, reason: 'sms_off' }; }, 'not_allowed_sms_off'],
    ['review asks off', (w) => { w.allowed.c = { allowed: false, reason: 'review_off' }; }, 'not_allowed_review_off'],
    ['an active cadence', (w) => w.active.add('c'), 'active_sequence'],
    ['a link tap in 180 days', (w) => w.tap.add('c'), 'review_link_tap_in_180_days'],
    ['3 asks in the window', (w) => { w.stats.c = { count: 3, lastAt: new Date(NOW - 60 * DAY) }; }, 'ask_cap'],
    ['an ask 10 days ago', (w) => { w.stats.c = { count: 1, lastAt: new Date(NOW - 10 * DAY) }; }, 'ask_in_30_days'],
    ['a staff ask in 30 days', (w) => w.manual.add('c'), 'manual_ask_in_30_days'],
  ])('%s is skipped', async (_label, setup, reason) => {
    const w = makeWorld();
    setup(w);
    const out = await run(w, [row('c', IN_WINDOW)], { live: true });
    expect(out.skipped).toEqual({ [reason]: 1 });
    expect(out.eligible).toBe(0);
    expect(w.services.ReviewService.startReviewSequence).not.toHaveBeenCalled();
  });

  test('an ask 31 days ago does not block', async () => {
    const w = makeWorld({ stats: { c: { count: 1, lastAt: new Date(NOW - 31 * DAY) } } });
    expect((await run(w, [row('c', IN_WINDOW)])).eligible).toBe(1);
  });

  test('outside the anniversary window or under a year is not looked at', async () => {
    const w = makeWorld();
    const out = await run(w, [row('late', '2024-10-01'), row('young', '2026-01-01')]);
    expect(out).toMatchObject({ tenured: 2, inWindow: 0, eligible: 0 });
  });

  test('a failed lookup skips only that customer and never enrolls it', async () => {
    const w = makeWorld({ failLookup: new Set(['bad']) });
    const out = await run(w, [row('bad', IN_WINDOW), row('ok', IN_WINDOW)], { live: true });
    expect(out.lookupFailed).toBe(1);
    expect(w.started.map((s) => s.customerId)).toEqual(['ok']);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lookup failed'));
  });

  test('a failed candidate read sends nothing', async () => {
    const w = makeWorld();
    const out = await run(w, [], { live: true, loadCustomers: async () => { throw new Error('db down'); } });
    expect(out.error).toBe('candidate_read_failed');
    expect(w.started).toHaveLength(0);
  });

  test('exclusionReason is null for a clean customer', async () => {
    const w = makeWorld();
    expect(await exclusionReason('c', { now: NOW, reads: w.reads, services: w.services })).toBeNull();
  });
});

describe('gate off and on', () => {
  test('gate off counts and logs, with zero enrollment or writes', async () => {
    const w = makeWorld();
    const out = await run(w, [row('a', IN_WINDOW), row('b', IN_WINDOW)], { live: false });
    expect(out).toMatchObject({ mode: 'count_only', eligible: 2, enrolled: 0 });
    expect(w.services.ReviewService.startReviewSequence).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('dry run'));
  });

  test('gate on enrolls once through the existing cadence path with the yearly label', async () => {
    const w = makeWorld();
    const out = await run(w, [row('a', IN_WINDOW)], { live: true });
    expect(out).toMatchObject({ mode: 'enroll', enrolled: 1 });
    expect(w.services.ReviewService.startReviewSequence).toHaveBeenCalledTimes(1);
    const args = w.started[0];
    expect(args.startedBy).toBe(YEARLY_STARTED_BY);
    expect(args.customerId).toBe('a');
    expect(args.plan).toHaveLength(1);
    expect(args.firstTouchAt).toBeInstanceOf(Date);
    expect(JSON.parse(args.decision).reason).toBe('yearly_anniversary');
  });

  test('a re-run the same day picks nobody (idempotent)', async () => {
    const w = makeWorld();
    await run(w, [row('a', IN_WINDOW)], { live: true });
    const again = await run(w, [row('a', IN_WINDOW)], { live: true });
    expect(again.eligible).toBe(0);
    expect(again.skipped).toEqual({ yearly_ask_in_365_days: 1 });
    expect(w.services.ReviewService.startReviewSequence).toHaveBeenCalledTimes(1);
  });

  test('a start the cadence refuses counts as not started', async () => {
    const w = makeWorld();
    w.services.ReviewService.startReviewSequence.mockResolvedValueOnce({ started: false, reason: 'cooldown' });
    expect(await run(w, [row('a', IN_WINDOW)], { live: true })).toMatchObject({ enrolled: 0, notStarted: 1 });
  });

  test('one run enrolls at most the flood cap', async () => {
    const w = makeWorld();
    const rows = Array.from({ length: MAX_ENROLL_PER_RUN + 5 }, (_, i) => row(`c${i}`, IN_WINDOW));
    expect((await run(w, rows, { live: true })).enrolled).toBe(MAX_ENROLL_PER_RUN);
  });
});

describe('default reads', () => {
  test('the yearly check asks for this customer, the yearly label and the 365-day span', async () => {
    const db = require('../models/db');
    const calls = [];
    const chain = {};
    ['where', 'whereRaw', 'whereNull'].forEach((m) => { chain[m] = (...a) => { calls.push([m, ...a]); return chain; }; });
    chain.first = async () => ({ id: 1 });
    db.mockReturnValue(chain);
    const { runYearlyReviewAsk: runIt } = require('../services/review-yearly-ask');
    const w = makeWorld();
    const out = await runIt({ now: NOW, deps: { services: w.services, loadCustomers: async () => [row('c', IN_WINDOW)] } });
    expect(out.skipped).toEqual({ yearly_ask_in_365_days: 1 });
    expect(db).toHaveBeenCalledWith('review_sequences');
    expect(calls).toContainEqual(['where', { customer_id: 'c', started_by: 'yearly' }]);
    const since = calls.find((c) => c[0] === 'where' && c[1] === 'started_at')[3];
    expect(Math.round((NOW - since) / DAY)).toBe(365);
  });
});
