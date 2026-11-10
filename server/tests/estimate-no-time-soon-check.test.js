/**
 * Daily no-time-soon check (owner 2026-11-09, option C): one Estimates bell per open estimate whose booking page
 * shows no time within 7 days, closed by itself when the problem is gone. These tests hold the 7-day rule
 * (ET today + 7, inclusive; firstDayAvailability counts), the no-paid-call read, the skips, every close reason, the
 * silenced category, and that one failing lookup neither stops the others nor closes its own bell.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  alertEpisodesLive: jest.fn(() => true),
}));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'bell-1', deduped: false })),
  openAdminAlertKeys: jest.fn(async () => []),
  closeAdminAlertKeys: jest.fn(async () => 1),
}));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(async () => ({ id: 'bell-1', deduped: false })),
}));
jest.mock('../services/notification-bell-policy', () => ({
  isBellPolicyEnabled: jest.fn(() => true),
  bellAllowed: jest.fn(async () => true),
}));
jest.mock('../services/estimate-slot-availability', () => ({ getAvailableSlots: jest.fn() }));
jest.mock('../routes/estimate-slots-public', () => ({
  _internals: {
    SLOT_ESTIMATE_COLUMNS: ['id', 'status', 'expires_at', 'archived_at', 'customer_id', 'customer_name'],
    slotBrowseRefusal: jest.fn(async () => null),
    resolveSlotServiceMode: jest.fn(() => 'recurring'),
  },
}));

const logger = require('../services/logger');
const { alertEpisodesLive } = require('../config/feature-gates');
const episodes = require('../services/admin-alert-episodes');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const bellPolicy = require('../services/notification-bell-policy');
const { getAvailableSlots } = require('../services/estimate-slot-availability');
const { slotBrowseRefusal } = require('../routes/estimate-slots-public')._internals;
const check = require('../services/estimate-no-time-soon-check');

// 2026-11-09 is 07:35 ET; the 7-day horizon ends 2026-11-16 (inclusive).
const NOW = new Date('2026-11-09T12:35:00Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const keyOf = (id) => `estimate-no-time-soon:${id}`;
const row = (id, extra = {}) => ({
  id, status: 'viewed', sent_at: '2026-11-01T15:00:00Z', archived_at: null, expires_at: '2026-12-01T15:00:00Z',
  customer_id: `cust-${id.slice(0, 1)}`, customer_name: 'Pat Tester', ...extra,
});
const answer = (firstDay, listed = [firstDay]) => ({
  primary: listed.filter(Boolean).map((date) => ({ slotId: date, date })),
  expander: [],
  metadata: { firstDayAvailability: firstDay ? { date: firstDay } : null },
});

let estimates;
// The candidate query's SQL filters, as written (the fake's select filters nothing; settledReason does in JS).
let sqlFilters;
function chain(table) {
  const q = {
    ids: null, id: null,
    whereNotNull: () => q, whereNull: () => q,
    whereRaw: (sql, bindings) => { sqlFilters.push({ sql, bindings }); return q; },
    where: (w) => {
      if (typeof w === 'function') {
        const group = [];
        const builder = {
          whereNull: (...args) => { group.push(['whereNull', ...args]); return builder; },
          orWhere: (...args) => { group.push(['orWhere', ...args]); return builder; },
        };
        w(builder);
        sqlFilters.push({ group });
        return q;
      }
      q.id = w?.id ?? null;
      return q;
    },
    whereIn: (_col, ids) => { q.ids = ids; return q; },
    select: async () => (table === 'estimates' ? estimates.filter((r) => !q.ids || q.ids.includes(r.id)) : []),
    first: async () => (table === 'estimates' ? estimates.find((r) => r.id === q.id) : undefined),
  };
  return q;
}
function makeConn() {
  const conn = jest.fn((table) => chain(table));
  conn.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => chain(table));
    trx.raw = jest.fn(async () => undefined);
    return fn(trx);
  });
  return conn;
}

const raised = () => episodes.raiseAdminAlertWithReopen.mock.calls.map(([category, headline, why, opts]) => ({ category, headline, why, opts }));
const closedKeys = () => episodes.closeAdminAlertKeys.mock.calls.map(([, keys, reason, opts]) => ({ keys, reason, resolution: opts.resolution }));
const run = (extra = {}) => check.runEstimateNoTimeSoonCheck({ now: NOW, conn: makeConn(), ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  estimates = [row(A)];
  sqlFilters = [];
  alertEpisodesLive.mockReturnValue(true);
  bellPolicy.isBellPolicyEnabled.mockReturnValue(true);
  bellPolicy.bellAllowed.mockResolvedValue(true);
  slotBrowseRefusal.mockResolvedValue(null);
  episodes.openAdminAlertKeys.mockResolvedValue([]);
  episodes.closeAdminAlertKeys.mockResolvedValue(1);
  getAvailableSlots.mockResolvedValue(answer('2026-11-21'));
});

describe('raising', () => {
  test('a first open day after day 7 rings one estimate_stuck bell with its own key, link and first-day words', async () => {
    const out = await run();
    expect(getAvailableSlots).toHaveBeenCalledWith(A, { offer: true, bypassCache: true, paidCalls: false, windowDays: 14, serviceMode: 'recurring' });
    const [bell] = raised();
    expect(bell.category).toBe('estimate_stuck');
    expect(bell.headline).toBe('Estimates — Pat Tester has no open time in the next 7 days');
    expect(bell.why).toBe('First open time on their estimate page: Sat, Nov 21.');
    expect(bell.opts).toMatchObject({
      dedupeKey: keyOf(A),
      link: `/admin/estimates?estimateId=${A}`,
      metadata: expect.objectContaining({ estimateId: A, severity: 'needs-you', subject: { type: 'estimate', id: A }, who: 'person' }),
    });
    expect(bell.opts.dedupeKey.startsWith('estimate_stuck:')).toBe(false);
    expect(out).toMatchObject({ candidates: 1, late: 1, raised: 1, failed: 0 });
  });

  test('a page with nothing in its 14 days says so', async () => {
    getAvailableSlots.mockResolvedValue(answer(null, []));
    await run();
    expect(raised()[0].why).toBe('Nothing open in the next 14 days.');
  });

  test('day 7 itself (Nov 16) is soon: no bell; day 8 is not', async () => {
    getAvailableSlots.mockResolvedValue(answer('2026-11-16'));
    await run();
    expect(raised()).toEqual([]);
    getAvailableSlots.mockResolvedValue(answer('2026-11-17'));
    await run();
    expect(raised()).toHaveLength(1);
  });

  test('firstDayAvailability inside 7 days counts even when the capped list starts later: no bell', async () => {
    getAvailableSlots.mockResolvedValue({ ...answer('2026-11-12', ['2026-11-20']) });
    await run();
    expect(raised()).toEqual([]);
  });

  test('the raise path without alert episodes is raiseAdminAlert with the same key', async () => {
    alertEpisodesLive.mockReturnValue(false);
    await run();
    expect(episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(raiseAdminAlert).toHaveBeenCalledWith('estimate_stuck', expect.objectContaining({ area: 'Estimates', doneWhen: 'estimate_has_soon_time' }), expect.objectContaining({ dedupeKey: keyOf(A) }));
  });

  test('a long name keeps the 60-character headline by the shorter wording', async () => {
    estimates = [row(A, { customer_name: 'Maximilian Ortega' })];
    await run();
    expect(raised()[0].headline).toBe('Estimates — Maximilian Ortega: no open time within 7 days');
  });

  // The table keeps every estimate ever sent: only open ones load (settledReason below stays the rule).
  test('the open filter runs in SQL: finished statuses and past expiry dates never load', async () => {
    await run();
    expect(sqlFilters).toEqual(expect.arrayContaining([
      { sql: "coalesce(lower(status), '') not in (?, ?, ?, ?)", bindings: ['accepted', 'declined', 'expired', 'void'] },
      { group: [['whereNull', 'expires_at'], ['orWhere', 'expires_at', '>', NOW]] },
    ]));
  });

  test('settled, expired, archived, never-sent and internal test estimates are not candidates', async () => {
    estimates = [row(A, { status: 'accepted' }), row(B, { expires_at: '2026-11-01T00:00:00Z' }), row(C, { archived_at: '2026-11-02T00:00:00Z' }),
      row('44444444-4444-4444-8444-444444444444', { sent_at: null }),
      row('99999999-9999-4999-8999-999999999999', { customer_id: '3274944a-f509-413c-9dee-a8b0cdb16493' })];
    const out = await run();
    expect(out.candidates).toBe(0);
    expect(getAvailableSlots).not.toHaveBeenCalled();
  });
});

describe('skips', () => {
  test('a no-booking answer is not judged and closes its standing bell', async () => {
    slotBrowseRefusal.mockResolvedValue({ status: 200, body: { commercialManualScheduling: true } });
    episodes.openAdminAlertKeys.mockResolvedValue([keyOf(A)]);
    await run();
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(raised()).toEqual([]);
    expect(closedKeys()).toEqual([{ keys: [keyOf(A)], reason: 'the estimate page offers no booking', resolution: 'The estimate page offers no booking' }]);
  });

  test('a list answer carrying a no-booking flag is skipped too', async () => {
    getAvailableSlots.mockResolvedValue({ ...answer(null, []), invoiceOnlyAcceptance: true });
    await run();
    expect(raised()).toEqual([]);
  });

  test('COORDS_NEED_GEOCODE skips the estimate: no raise, no close, counted', async () => {
    getAvailableSlots.mockRejectedValue(Object.assign(new Error('coords'), { code: 'COORDS_NEED_GEOCODE' }));
    episodes.openAdminAlertKeys.mockResolvedValue([keyOf(A)]);
    const out = await run();
    expect(out).toMatchObject({ coordsSkipped: 1, failed: 0, raised: 0, closed: 0 });
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });

  test('a silenced category reads nothing, raises nothing and closes every standing bell', async () => {
    bellPolicy.bellAllowed.mockResolvedValue(false);
    episodes.openAdminAlertKeys.mockResolvedValue([keyOf(A), keyOf(B)]);
    await run();
    expect(getAvailableSlots).not.toHaveBeenCalled();
    expect(raised()).toEqual([]);
    expect(closedKeys().map((c) => c.reason)).toEqual(['silenced in Push Settings', 'silenced in Push Settings']);
  });
});

describe('closing', () => {
  test('each standing bell closes with its reason: settled, archived, expired, gone, a time within 7 days', async () => {
    const SOON = '55555555-5555-4555-8555-555555555555';
    const GONE = '66666666-6666-4666-8666-666666666666';
    const ARCH = '77777777-7777-4777-8777-777777777777';
    const EXP = '88888888-8888-4888-8888-888888888888';
    estimates = [row(A, { status: 'accepted' }), row(ARCH, { archived_at: '2026-11-08T00:00:00Z' }),
      row(EXP, { expires_at: '2026-11-08T00:00:00Z' }), row(SOON)];
    getAvailableSlots.mockResolvedValue(answer('2026-11-11'));
    episodes.openAdminAlertKeys.mockResolvedValue([A, ARCH, EXP, SOON, GONE].map(keyOf));
    const out = await run();
    const byKey = Object.fromEntries(closedKeys().map((c) => [c.keys[0], c.reason]));
    expect(byKey).toEqual({
      [keyOf(A)]: 'estimate accepted',
      [keyOf(ARCH)]: 'estimate archived',
      [keyOf(EXP)]: 'estimate expired',
      [keyOf(SOON)]: 'a time is open within 7 days',
      [keyOf(GONE)]: 'estimate gone',
    });
    expect(out.closed).toBe(5);
    expect(raised()).toEqual([]);
  });

  test('a bell for an estimate that still shows no time stays open and is only refreshed by the raise', async () => {
    episodes.openAdminAlertKeys.mockResolvedValue([keyOf(A)]);
    await run();
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(raised()).toHaveLength(1);
  });

  test('the close runs before the raise', async () => {
    estimates = [row(A), row(B)];
    getAvailableSlots.mockImplementation(async (id) => (id === A ? answer('2026-11-12') : answer('2026-11-21')));
    episodes.openAdminAlertKeys.mockResolvedValue([keyOf(A)]);
    await run();
    expect(episodes.closeAdminAlertKeys.mock.invocationCallOrder[0]).toBeLessThan(episodes.raiseAdminAlertWithReopen.mock.invocationCallOrder[0]);
  });
});

describe('a lookup that throws', () => {
  test('fails closed for that row (no raise, no close), the others finish, and the run throws at the end', async () => {
    estimates = [row(A), row(B)];
    getAvailableSlots.mockImplementation(async (id) => {
      if (id === A) throw new Error('db down');
      return answer('2026-11-21');
    });
    episodes.openAdminAlertKeys.mockResolvedValue([keyOf(A)]);
    await expect(run()).rejects.toThrow('1 estimate no-time-soon check failed');
    expect(raised().map((r) => r.opts.dedupeKey)).toEqual([keyOf(B)]);
    expect(episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
  });
});

describe('closeSettledNoTimeSoonAlerts (the 5-minute pass)', () => {
  test('closes only settled estimates, runs no picker, and does nothing without alert episodes', async () => {
    estimates = [row(A, { status: 'declined' }), row(B)];
    episodes.openAdminAlertKeys.mockResolvedValue([keyOf(A), keyOf(B), keyOf(C)]);
    const out = await check.closeSettledNoTimeSoonAlerts({ now: NOW, conn: makeConn() });
    expect(out).toEqual({ ran: true, open: 3, closed: 2 });
    expect(closedKeys().map((c) => [c.keys[0], c.reason])).toEqual([[keyOf(A), 'estimate declined'], [keyOf(C), 'estimate gone']]);
    expect(getAvailableSlots).not.toHaveBeenCalled();
    jest.clearAllMocks();
    alertEpisodesLive.mockReturnValue(false);
    expect(await check.closeSettledNoTimeSoonAlerts({ now: NOW, conn: makeConn() })).toEqual({ ran: false, open: 0, closed: 0 });
  });

  test('never throws', async () => {
    episodes.openAdminAlertKeys.mockRejectedValue(Object.assign(new Error('select ... token'), { code: '57P01' }));
    await expect(check.closeSettledNoTimeSoonAlerts({ now: NOW, conn: makeConn() })).resolves.toMatchObject({ closed: 0 });
    expect(logger.warn).toHaveBeenCalledWith('[estimate-no-time-soon] settle pass failed: 57P01');
  });
});
