// bounce-guard.js: anti-oscillation cooldown (no move-count cap) — blocks
// bouncing a visit back onto a date auto-dispatch recently moved it off of,
// while letting it still move to genuinely better new dates and never blocking
// conflict moves, first placements, or same-day re-times. No database.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/auto-dispatch/eligibility', () => ({
  ...jest.requireActual('../services/auto-dispatch/eligibility'),
  isPersonPlacedVisit: jest.fn(async () => ({ placed: false })),
}));
jest.mock('../services/auto-dispatch/reminder-off', () => ({
  ...jest.requireActual('../services/auto-dispatch/reminder-off'),
  assertRemindersOn: jest.fn(async () => {}),
}));
jest.mock('../services/auto-dispatch/told-visits', () => ({
  loadToldVisitIds: jest.fn(async () => new Set()),
}));

const bounceGuard = require('../services/auto-dispatch/bounce-guard');
const { getAutoDispatchConfig } = require('../services/auto-dispatch/config');
const { rankCandidates } = require('../services/auto-dispatch/move-rules');
const { makeMoveGuard, makeMemberGuard } = require('../services/auto-dispatch/apply');

function logConn(rows, { fail = false } = {}) {
  const calls = [];
  const c = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'then') return (resolve, reject) => (fail ? Promise.reject(new Error('log down')) : Promise.resolve(rows)).then(resolve, reject);
      return (...args) => { calls.push([prop, ...args]); return c; };
    },
  });
  const conn = jest.fn((table) => { calls.push(['table', table]); return c; });
  conn.calls = calls;
  return conn;
}

describe('config bounceCooldownDays', () => {
  const prev = process.env.AUTO_DISPATCH_BOUNCE_COOLDOWN_DAYS;
  afterEach(() => {
    if (prev === undefined) delete process.env.AUTO_DISPATCH_BOUNCE_COOLDOWN_DAYS;
    else process.env.AUTO_DISPATCH_BOUNCE_COOLDOWN_DAYS = prev;
  });

  test('defaults to 30 in flex mode and 0 otherwise; env and override win', () => {
    delete process.env.AUTO_DISPATCH_BOUNCE_COOLDOWN_DAYS;
    expect(getAutoDispatchConfig({ flexTierEnabled: true }).bounceCooldownDays).toBe(30);
    expect(getAutoDispatchConfig({ flexTierEnabled: false, routeTiersEnabled: true }).bounceCooldownDays).toBe(0);
    expect(getAutoDispatchConfig({ flexTierEnabled: false, routeTiersEnabled: false }).bounceCooldownDays).toBe(0);
    process.env.AUTO_DISPATCH_BOUNCE_COOLDOWN_DAYS = '10';
    expect(getAutoDispatchConfig({ flexTierEnabled: true }).bounceCooldownDays).toBe(10);
    expect(getAutoDispatchConfig({ flexTierEnabled: false }).bounceCooldownDays).toBe(10);
    expect(getAutoDispatchConfig({ flexTierEnabled: true, bounceCooldownDays: 0 }).bounceCooldownDays).toBe(0);
  });
});

describe('bounce-guard history reader', () => {
  const NOW = new Date('2026-12-08T09:10:00Z');

  test('loads recent left original_date values and ignores entries older than the cooldown window', async () => {
    const conn = logConn([
      { scheduled_service_id: 's1', original_date: '2026-12-31', created_at: '2026-12-05T09:10:00Z' },
      { scheduled_service_id: 's1', original_date: new Date('2027-01-02T00:00:00Z'), created_at: '2026-12-07T09:10:00Z' },
      { scheduled_service_id: 's1', original_date: '2026-12-28', created_at: '2026-11-20T09:10:00Z' }, // outside 7d window
      { scheduled_service_id: 's2', original_date: '2027-01-04', created_at: '2026-12-02T09:10:00Z' },
    ]);
    const map = await bounceGuard.loadRecentLeftDates(conn, ['s1', 's2', 's3'], NOW, { bounceCooldownDays: 7 });
    expect([...map.get('s1')].sort()).toEqual(['2026-12-31', '2027-01-02']);
    expect([...map.get('s2')]).toEqual(['2027-01-04']);
    expect(map.get('s3')).toBeUndefined();
    expect(conn.calls).toEqual(expect.arrayContaining([
      ['table', 'reschedule_log'],
      ['where', 'reason_code', 'auto_dispatch'],
      ['where', 'initiated_by', 'auto_dispatch'],
      ['where', 'created_at', '>=', bounceGuard.cutoffFor(NOW, 7)],
    ]));
  });

  test('off or empty ids reads nothing; DB error fails closed with null', async () => {
    const conn = logConn([]);
    expect((await bounceGuard.loadRecentLeftDates(conn, ['s1'], NOW, { bounceCooldownDays: 0 })).size).toBe(0);
    expect((await bounceGuard.loadRecentLeftDates(conn, [], NOW, { bounceCooldownDays: 7 })).size).toBe(0);
    expect(conn).not.toHaveBeenCalled();
    expect(await bounceGuard.loadRecentLeftDates(logConn([], { fail: true }), ['s1'], NOW, { bounceCooldownDays: 7 })).toBeNull();
  });
});

describe('move-rules rankCandidates with recentLeftDates', () => {
  const CONFIG = { minDayMoveDriveSavingMinutes: 6, bounceCooldownDays: 7 };
  const SERVICE = { id: 's1', window_start: '13:00', recurring_dispatch_due_date: null };
  const CURRENT = { is_current: true, date: '2027-01-04', start_time: '13:00', detour_minutes: 25 };
  const score = (total) => ({ total_score: total, default_time_score: 0 });
  const cand = (date, detour = 5) => ({ date, start_time: '09:00', detour_minutes: detour });
  const rank = (scored, extra = {}) => rankCandidates({
    service: SERVICE, current: CURRENT, currentScore: score(50), scored, threshold: 15, config: CONFIG, ...extra,
  });

  test('disqualifies bouncing back to a recently-left date and picks the next qualifying new date', () => {
    const dec31 = cand('2026-12-31', 2); // bigger gain, recently left
    const jan06 = cand('2027-01-06', 8); // smaller gain, still qualifies, new date
    const res = rank(
      [{ cand: dec31, sc: score(90) }, { cand: jan06, sc: score(75) }],
      { recentLeftDates: new Set(['2026-12-31']) },
    );
    expect(res).toMatchObject({ qualifies: true, best: jan06, bounceBlocked: false });
    expect(res.ranked).toEqual([jan06]);
  });

  test('reports bounceBlocked when every otherwise-qualifying candidate returns to a recently-left date', () => {
    const dec31 = cand('2026-12-31', 2);
    const weakNew = cand('2027-01-06', 5); // under threshold (+10)
    const res = rank(
      [{ cand: dec31, sc: score(90) }, { cand: weakNew, sc: score(60) }],
      { recentLeftDates: new Set(['2026-12-31']) },
    );
    expect(res).toMatchObject({ qualifies: false, bounceBlocked: true, floorFailed: false, best: dec31 });
    expect(res.ranked).toEqual([]);
  });

  test('does not report bounceBlocked when the bounced candidate would not have qualified anyway', () => {
    const dec31 = cand('2026-12-31', 2); // under threshold (+10)
    const res = rank([{ cand: dec31, sc: score(60) }], { recentLeftDates: new Set(['2026-12-31']) });
    expect(res).toMatchObject({ qualifies: false, bounceBlocked: false });
  });

  test('conflict moves and unplaced due-date placements bypass the bounce guard; normalBest still respects it', () => {
    const dec31 = cand('2026-12-31', 5);
    const conflictCurrent = { ...CURRENT, conflict: { kind: 'closed_day', date: CURRENT.date } };
    const conflictRes = rank([{ cand: dec31, sc: score(90) }], {
      current: conflictCurrent, recentLeftDates: new Set(['2026-12-31']),
    });
    expect(conflictRes).toMatchObject({ qualifies: true, best: dec31, bounceBlocked: false, movesWithoutConflict: false });
    expect(conflictRes.normalBest).toBeUndefined();

    const unplaced = { id: 's1', window_start: null, recurring_dispatch_due_date: '2027-01-04' };
    const unplacedRes = rank([{ cand: dec31, sc: score(90) }], {
      service: unplaced, current: { ...CURRENT, start_time: null }, recentLeftDates: new Set(['2026-12-31']),
    });
    expect(unplacedRes).toMatchObject({ qualifies: true, best: dec31, bounceBlocked: false });
  });

  test('same-day re-times are never blocked by bounce-back', () => {
    const sameDay = cand('2027-01-04', 5);
    const res = rank([{ cand: sameDay, sc: score(90) }], { recentLeftDates: new Set(['2027-01-04']) });
    expect(res).toMatchObject({ qualifies: true, best: sameDay, bounceBlocked: false });
  });
});

describe('apply-time bounce guard (assertNotBouncingBack, makeMoveGuard, makeMemberGuard)', () => {
  const NOW = new Date('2026-12-08T09:10:00Z');
  const refuse = (id, why) => Object.assign(new Error(`service ${id} ${why}`), { statusCode: 409, code: 'REFUSED' });
  const row = { id: 's1', scheduled_date: '2027-01-04', window_start: '09:00', technician_id: 't1', status: 'confirmed' };

  test('refuses a day move back onto a recently-left date; exempts conflicts, same-day, unplaced, and disabled config', async () => {
    const recent = [{ scheduled_service_id: 's1', original_date: '2026-12-31', created_at: '2026-12-06T09:10:00Z' }];
    await expect(bounceGuard.assertNotBouncingBack(logConn(recent), [row], '2026-12-31', { bounceCooldownDays: 7 }, refuse, NOW))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('bounce back to 2026-12-31') });
    await expect(bounceGuard.assertNotBouncingBack(logConn(recent), [row], '2027-01-06', { bounceCooldownDays: 7 }, refuse, NOW))
      .resolves.toBeUndefined();
    // Conflict move exempt
    const conflictConn = logConn(recent);
    await expect(bounceGuard.assertNotBouncingBack(conflictConn, [row], '2026-12-31', { bounceCooldownDays: 7, sourceConflict: { kind: 'closed_day' } }, refuse, NOW))
      .resolves.toBeUndefined();
    expect(conflictConn).not.toHaveBeenCalled();
    // Same-day exempt
    const sameConn = logConn(recent);
    await expect(bounceGuard.assertNotBouncingBack(sameConn, [row], '2027-01-04', { bounceCooldownDays: 7 }, refuse, NOW))
      .resolves.toBeUndefined();
    expect(sameConn).not.toHaveBeenCalled();
    // Unplaced due-date exempt
    const unplacedConn = logConn(recent);
    await expect(bounceGuard.assertNotBouncingBack(unplacedConn, [{ ...row, window_start: null, recurring_dispatch_due_date: '2027-01-04' }], '2026-12-31', { bounceCooldownDays: 7 }, refuse, NOW))
      .resolves.toBeUndefined();
    expect(unplacedConn).not.toHaveBeenCalled();
    // Disabled config exempt
    const offConn = logConn(recent);
    await expect(bounceGuard.assertNotBouncingBack(offConn, [row], '2026-12-31', { bounceCooldownDays: 0 }, refuse, NOW))
      .resolves.toBeUndefined();
    expect(offConn).not.toHaveBeenCalled();
  });

  test('makeMoveGuard refuses a bounce-back inside the move transaction', async () => {
    const recent = [{ scheduled_service_id: 's1', original_date: '2026-12-31', created_at: new Date().toISOString() }];
    const guard = makeMoveGuard({ service: row, best: { date: '2026-12-31', start_time: '09:00', technician_id: 't1' }, config: { bounceCooldownDays: 7 } });
    await expect(guard({ trx: logConn(recent), technicianId: 't1' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_AUTO_DISPATCH_CAPABILITY_GUARD', message: expect.stringContaining('bounce back to 2026-12-31') });
  });

  test('makeMemberGuard refuses when a grouped sibling recently left the destination date', async () => {
    const FAR = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 40); return d.toISOString().slice(0, 10); })();
    const sibling = {
      id: 's2', service_type: 'Pest Control', is_recurring: true, recurring_parent_id: 'p2', status: 'confirmed',
      scheduled_date: FAR, window_start: '10:00', auto_dispatch_locked: false, auto_dispatch_excluded: false,
      customer_active: true, customer_latitude: 27.5, customer_longitude: -82.4,
    };
    const trx = jest.fn((table) => {
      const api = {
        where: () => api, whereIn: () => api, whereNotIn: () => api, whereNull: () => api, whereRaw: () => api,
        leftJoin: () => api, forShare: () => api,
        first: async () => null,
        select: async () => (table === 'reschedule_log'
          ? [{ scheduled_service_id: 's2', original_date: '2026-12-31', created_at: new Date().toISOString() }]
          : (String(table).startsWith('scheduled_services') ? [sibling] : [])),
      };
      return api;
    });
    const guard = makeMemberGuard({ service: row, best: { date: '2026-12-31', start_time: '09:00', technician_id: 't1' }, config: { bounceCooldownDays: 7 }, techChanged: false });
    await expect(guard({ trx, members: [{ id: 's1', status: 'confirmed' }, { id: 's2', status: 'confirmed' }] }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2', message: expect.stringContaining('bounce back to 2026-12-31') });
  });
});
