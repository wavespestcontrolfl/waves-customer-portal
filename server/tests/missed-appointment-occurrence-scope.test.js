/** onSkip freezes the missed occurrence's own scope (service + catalog id + property) on its reschedule_log row. Synthetic data. */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const mockRaiseCard = jest.fn(async () => ({ raised: true }));
let mockQueueOn = false;
jest.mock('../services/not-closed-out', () => {
  const actual = jest.requireActual('../services/not-closed-out');
  return { isSameNoShowOccurrence: actual.isSameNoShowOccurrence, RESOLUTION_BY_STATUS: actual.RESOLUTION_BY_STATUS, raiseCard: (...a) => mockRaiseCard(...a), queueEnabled: () => mockQueueOn };
});

const db = require('../models/db');
const MissedAppointment = require('../services/workflows/missed-appointment');

function fakeConn(service) {
  const inserts = [];
  const locks = [];
  const conn = (table) => {
    const chain = {
      where() { return chain; },
      forUpdate() { locks.push(table); return chain; },
      select() { return chain; },
      first: async () => {
        if (table === 'scheduled_services') return service;
        if (table === 'customers') return { id: 'c1', first_name: 'Sam' };
        return { count: '0' };
      },
      insert: (row) => {
        inserts.push({ table, row });
        const done = Promise.resolve([{ id: 'log-new' }]);
        return { returning: () => done, then: (res, rej) => done.then(res, rej) };
      },
    };
    return chain;
  };
  conn.raw = (sql) => sql;
  conn.transaction = (fn) => fn(conn);
  conn.isTransaction = true;
  return { conn, inserts, locks };
}

test('the log row carries the occurrence scope as it was at the miss', async () => {
  const { conn, inserts } = fakeConn({
    id: 'visit-1', customer_id: 'c1', scheduled_date: '2026-09-29', window_start: '09:00:00', window_end: '10:30:00',
    service_type: 'Pest Control', service_id: 'svc-pest', property_id: 'prop-1',
  });
  jest.spyOn(MissedAppointment, 'evaluateThreshold').mockResolvedValueOnce(null);
  await MissedAppointment.onSkip('visit-1', 'no_show', conn);
  const log = inserts.find((i) => i.table === 'reschedule_log').row;
  expect(log).toMatchObject({
    reason_code: 'customer_noshow', original_date: '2026-09-29', original_window: '09:00:00-10:30:00',
    occurrence_service_type: 'Pest Control', occurrence_service_id: 'svc-pest', occurrence_property_id: 'prop-1',
  });
});

test('an unlinked visit stores null scope, never a guess', async () => {
  const { conn, inserts } = fakeConn({ id: 'visit-2', customer_id: 'c1', scheduled_date: '2026-09-29', window_start: null, service_type: null, service_id: null, property_id: null });
  jest.spyOn(MissedAppointment, 'evaluateThreshold').mockResolvedValueOnce(null);
  await MissedAppointment.onSkip('visit-2', 'no_show', conn);
  const log = inserts.find((i) => i.table === 'reschedule_log').row;
  expect(log).toMatchObject({ occurrence_service_type: null, occurrence_service_id: null, occurrence_property_id: null });
});

test('a caller snapshot (dispatch no-show) wins over a later edit of the live row (Codex #5669 r1)', async () => {
  const { conn, inserts } = fakeConn({
    id: 'visit-3', customer_id: 'c1', scheduled_date: '2026-09-29', window_start: '13:00:00', window_end: '14:00:00',
    service_type: 'Lawn Care', service_id: 'svc-lawn', property_id: 'prop-2', // edited after the no-show was marked
  });
  jest.spyOn(MissedAppointment, 'evaluateThreshold').mockResolvedValueOnce(null);
  await MissedAppointment.onSkip('visit-3', 'manual_no_show', conn, { occurrence: {
    id: 'visit-3', scheduled_date: '2026-09-29', window_start: '09:00:00', window_end: '10:00:00',
    service_type: 'Pest Control', service_id: 'svc-pest', property_id: 'prop-1',
  } });
  const log = inserts.find((i) => i.table === 'reschedule_log').row;
  expect(log).toMatchObject({
    customer_id: 'c1', original_window: '09:00:00-10:00:00',
    occurrence_service_type: 'Pest Control', occurrence_service_id: 'svc-pest', occurrence_property_id: 'prop-1',
  });
});

describe('the office card for a flagged visit (not-closed-out.js)', () => {
  const visit = { id: 'visit-4', customer_id: 'c1', scheduled_date: '2026-09-29', window_start: '09:00:00', window_end: '10:00:00', service_type: 'Pest Control', service_id: 'svc-pest', property_id: 'prop-1' };
  beforeEach(() => mockRaiseCard.mockClear());

  test('the nightly check raises an unconfirmed card: it only knows the visit was still open', async () => {
    const { conn, inserts } = fakeConn(visit);
    jest.spyOn(MissedAppointment, 'evaluateThreshold').mockResolvedValueOnce(null);
    await MissedAppointment.onSkip('visit-4', 'no_show', conn);
    expect(inserts.find((i) => i.table === 'reschedule_log').row.miss_confirmed_at).toBeUndefined();
    expect(mockRaiseCard).toHaveBeenCalledWith(expect.objectContaining({ logId: 'log-new', confirmed: false, service: expect.objectContaining({ id: 'visit-4' }) }));
  });

  test('a person marking the no-show in dispatch is a confirmed miss from the start', async () => {
    const { conn, inserts } = fakeConn(visit);
    jest.spyOn(MissedAppointment, 'evaluateThreshold').mockResolvedValueOnce(null);
    await MissedAppointment.onSkip('visit-4', 'manual_no_show', conn);
    expect(inserts.find((i) => i.table === 'reschedule_log').row).toMatchObject({ miss_confirmed_by: 'dispatch' });
    expect(inserts.find((i) => i.table === 'reschedule_log').row.miss_confirmed_at).toBeInstanceOf(Date);
    expect(mockRaiseCard).toHaveBeenCalledWith(expect.objectContaining({ confirmed: true }));
  });

  test.each([
    ['completed', { status: 'completed' }],
    ['moved to another day', { status: 'pending', scheduled_date: '2026-10-06' }],
    ['moved to a later window', { status: 'confirmed', window_start: '15:00:00', window_end: '16:00:00' }],
  ])('the nightly check does not flag a candidate %s since its scan', async (_label, change) => {
    const { conn, inserts } = fakeConn({ ...visit, status: 'pending', ...change });
    const evaluate = jest.spyOn(MissedAppointment, 'evaluateThreshold').mockClear();
    expect(await MissedAppointment.onSkip('visit-4', 'no_show', conn, { scanned: { ...visit, status: 'pending' } })).toEqual({ action: 'stale_candidate' });
    expect(inserts).toEqual([]);
    expect(mockRaiseCard).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  test('queue on: the nightly row waits for a person before the repeated-miss outreach; a dispatch no-show does not wait', async () => {
    mockQueueOn = true;
    try {
      const nightly = fakeConn({ ...visit, status: 'pending' });
      const evaluate = jest.spyOn(MissedAppointment, 'evaluateThreshold').mockClear().mockResolvedValue({ action: 'reschedule_system', skips: 1 });
      expect(await MissedAppointment.onSkip('visit-4', 'no_show', nightly.conn)).toEqual({ action: 'awaiting_confirmation' });
      expect(nightly.inserts.find((i) => i.table === 'reschedule_log')).toBeTruthy();
      expect(evaluate).not.toHaveBeenCalled();
      const manual = fakeConn({ ...visit, status: 'no_show' });
      await MissedAppointment.onSkip('visit-4', 'manual_no_show', manual.conn);
      expect(evaluate).toHaveBeenCalledTimes(1);
      evaluate.mockRestore();
    } finally { mockQueueOn = false; }
  });

  test('queue on: the 90-day count takes person-marked misses only; queue off: every flagged row, as before', async () => {
    const built = [];
    const conn = (table) => {
      const chain = {
        where(arg) {
          if (typeof arg === 'function') {
            const b = {
              whereNotNull(c) { built.push(c); return b; },
              orWhereNotNull(c) { built.push(c); return b; },
              whereNull(c) { built.push(`null:${c}`); return b; },
              orWhere(c, op, v) { built.push(`${c}${op}${v}`); return b; },
            };
            arg.call(b);
          }
          return chain;
        },
        select() { return chain; },
        first: async () => (table === 'customers' ? { id: 'c1', first_name: 'Sam' } : { count: '1' }),
      };
      return chain;
    };
    conn.raw = (sql) => sql;
    conn.isTransaction = true;
    // a row a person settled as "Not a miss" never counts, gate on or off
    const NOT_DISMISSED = ['null:resolution', 'resolution<>not_a_miss'];
    await MissedAppointment.evaluateThreshold('c1', 'no_show', conn);
    expect(built).toEqual(NOT_DISMISSED);
    built.length = 0;
    mockQueueOn = true;
    try {
      await MissedAppointment.evaluateThreshold('c1', 'confirmed_miss', conn);
      expect(built).toEqual([...NOT_DISMISSED, 'miss_confirmed_at', 'new_date']);
    } finally { mockQueueOn = false; }
  });

  test('a candidate unchanged since the scan is flagged', async () => {
    const { conn, inserts } = fakeConn({ ...visit, status: 'confirmed' });
    jest.spyOn(MissedAppointment, 'evaluateThreshold').mockResolvedValueOnce({ action: 'reschedule_system', skips: 1 });
    await MissedAppointment.onSkip('visit-4', 'no_show', conn, { scanned: { ...visit, status: 'pending' } });
    expect(inserts.find((i) => i.table === 'reschedule_log')).toBeTruthy();
  });

  // Dispatch calls onSkip on the shared pool, after its status change committed.
  describe('a dispatch no-show is logged under the visit lock', () => {
    const occurrence = { id: 'visit-4', scheduled_date: '2026-09-29', window_start: '09:00:00', window_end: '10:00:00' };
    function onPool(visitNow) {
      const fake = fakeConn(visitNow);
      db.transaction = jest.fn(async (fn) => fn(fake.conn));
      jest.spyOn(MissedAppointment, 'evaluateThreshold').mockResolvedValueOnce(null);
      return fake;
    }

    test('still that no-show occurrence: an open confirmed miss and its card', async () => {
      const { inserts, locks } = onPool({ ...visit, status: 'no_show' });
      await MissedAppointment.onSkip('visit-4', 'manual_no_show', undefined, { occurrence });
      expect(locks).toEqual(['scheduled_services']);
      const log = inserts.find((i) => i.table === 'reschedule_log').row;
      expect(log.resolved_at).toBeUndefined();
      expect(log.miss_confirmed_by).toBe('dispatch');
      expect(mockRaiseCard).toHaveBeenCalledWith(expect.objectContaining({ confirmed: true }));
      // the outreach task it may raise is linked to this row, so "Not a miss" can withdraw it
      expect(MissedAppointment.evaluateThreshold).toHaveBeenCalledWith('c1', 'manual_no_show', expect.anything(), { logId: 'log-new' });
    });

    test.each([
      ['completed in between', { status: 'completed' }, 'completed'],
      ['cancelled in between', { status: 'cancelled' }, 'dismissed'],
      ['rebooked to another day', { status: 'pending', scheduled_date: '2026-10-06' }, 'rebooked'],
      ['rebooked later the same day and missed again', { status: 'no_show', window_start: '14:00:00', window_end: '15:00:00' }, 'rebooked'],
    ])('%s: the miss is still counted but written settled, with no card', async (_label, change, resolution) => {
      const { inserts } = onPool({ ...visit, ...change });
      await MissedAppointment.onSkip('visit-4', 'manual_no_show', undefined, { occurrence });
      const log = inserts.find((i) => i.table === 'reschedule_log').row;
      expect(log).toMatchObject({ reason_code: 'customer_noshow', original_date: '2026-09-29', original_window: '09:00:00-10:00:00', resolution, resolved_by: 'system' });
      expect(log.resolved_at).toBeInstanceOf(Date);
      expect(mockRaiseCard).not.toHaveBeenCalled();
    });
  });
});

describe('the repeated-miss outreach task follows the confirmation that raised it', () => {
  test('the task carries the flagged row it came from', async () => {
    const inserts = [];
    const conn = (table) => {
      const chain = {
        where() { return chain; },
        select() { return chain; },
        first: async () => (table === 'customers' ? { id: 'c1', first_name: 'Sam' } : { count: '2' }),
        insert: async (row) => { inserts.push({ table, row }); },
      };
      return chain;
    };
    const raws = [];
    conn.raw = (sql, b) => { raws.push([sql, b]); return sql; };
    // given the pool, the whole count-and-write runs in ONE transaction, so the lock is held to the insert
    db.transaction = jest.fn(async (fn) => { conn.isTransaction = true; try { return await fn(conn); } finally { conn.isTransaction = false; } });
    expect(await MissedAppointment.evaluateThreshold('c1', 'confirmed_miss', conn, { logId: 'log-9' })).toEqual({ action: 'recommendation_created', skips: 2 });
    expect(raws[0]).toEqual(['SELECT pg_advisory_xact_lock(hashtext(?))', ['missed_outreach:c1']]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(JSON.parse(inserts[0].row.metadata)).toEqual({ source: 'missed_appointment_threshold', log_id: 'log-9' });
  });

  // Misses A and B raised a task (linked to B). "Not a miss" on EITHER leaves one miss: the task goes.
  test.each([
    ['one miss left: the pending task is cancelled', '1', 1],
    ['two misses still stand: the task stays', '2', 0],
  ])('withdrawOutreachIfBelowThreshold — %s', async (_label, count, withdrawn) => {
    const calls = [];
    const sp = (table) => {
      const chain = {
        where(c) { if (typeof c === 'object') calls.push(['where', table, c]); return chain; },
        whereRaw(sql) { calls.push(['whereRaw', sql]); return chain; },
        select() { return chain; },
        first: async () => ({ count }),
        update: async (patch) => { calls.push(['update', patch.status]); return 1; },
      };
      return chain;
    };
    sp.raw = (sql, b) => { calls.push(['raw', sql, b]); return sql; };
    expect(await MissedAppointment.withdrawOutreachIfBelowThreshold('c1', { transaction: (fn) => fn(sp) })).toEqual({ withdrawn });
    // the per-customer lock comes first: a concurrent confirmation on another visit counts after this commits
    expect(calls[0]).toEqual(['raw', 'SELECT pg_advisory_xact_lock(hashtext(?))', ['missed_outreach:c1']]);
    const cancelled = calls.some((c) => c[0] === 'update' && c[1] === 'cancelled');
    expect(cancelled).toBe(withdrawn === 1);
    if (withdrawn) {
      // every pending threshold task of the customer, whichever miss it was raised from
      expect(calls).toEqual(expect.arrayContaining([
        ['where', 'customer_interactions', { customer_id: 'c1', interaction_type: 'task', status: 'pending' }],
        ['whereRaw', "metadata->>'source' = 'missed_appointment_threshold'"],
      ]));
    }
  });

  test('a database failure never reaches the dismissal', async () => {
    expect(await MissedAppointment.withdrawOutreachIfBelowThreshold('c1', { transaction: async () => { throw new Error('db down'); } })).toEqual({ withdrawn: 0 });
  });

  describe('reconcileOutreach (nightly repair)', () => {
    // tables: pending tasks, recent confirmed rows; `count` = the customer's misses now
    function world({ pendingTasks = [], confirmed = [], recentTask = null, count = '2' }) {
      const writes = [];
      const conn = (table) => {
        const chain = {
          where() { return chain; }, whereNotNull() { return chain; }, orderBy() { return chain; },
          whereRaw() { return chain; },
          select: () => (table === 'customer_interactions' ? Promise.resolve(pendingTasks) : (table === 'reschedule_log' ? Object.assign(Promise.resolve(confirmed), { first: async () => ({ count }) }) : chain)),
          first: async () => {
            if (table === 'customers') return { id: 'c1', first_name: 'Sam' };
            if (table === 'customer_interactions') return recentTask || undefined;
            return { count };
          },
          update: async (patch) => { writes.push(['update', patch.status]); return 1; },
          insert: async (row) => { writes.push(['insert', JSON.parse(row.metadata).log_id]); },
        };
        return chain;
      };
      conn.raw = (sql) => sql;
      conn.isTransaction = true;
      conn.transaction = (fn) => fn(conn);
      const dbFn = require('../models/db');
      dbFn.mockImplementation((table) => conn(table));
      dbFn.raw = conn.raw;
      dbFn.transaction = (fn) => fn(conn);
      return writes;
    }

    test('a pending task whose customer no longer has two misses is cancelled', async () => {
      const writes = world({ pendingTasks: [{ customer_id: 'c1' }], count: '1' });
      expect(await MissedAppointment.reconcileOutreach()).toEqual({ withdrawn: 1, raised: 0 });
      expect(writes).toEqual([['update', 'cancelled']]);
    });

    test('two misses and no task in the window: one task, linked to the latest confirmed miss; any recent task (a Quick Move\'s too) means none is added', async () => {
      let writes = world({ confirmed: [{ id: 'log-B', customer_id: 'c1' }, { id: 'log-A', customer_id: 'c1' }], count: '2' });
      expect(await MissedAppointment.reconcileOutreach()).toEqual({ withdrawn: 0, raised: 1 });
      expect(writes).toEqual([['insert', 'log-B']]); // the latest row only: never a second task for the earlier miss
      // e.g. first miss confirmed, second a no-show Quick Move whose task carries no log id
      writes = world({ confirmed: [{ id: 'log-A', customer_id: 'c1' }], recentTask: { id: 't1' }, count: '2' });
      expect(await MissedAppointment.reconcileOutreach()).toEqual({ withdrawn: 0, raised: 0 });
      expect(writes).toEqual([]);
    });

    test('a database failure never throws', async () => {
      const dbFn = require('../models/db');
      dbFn.mockImplementation(() => { throw new Error('db down'); });
      expect(await MissedAppointment.reconcileOutreach()).toEqual({ withdrawn: 0, raised: 0 });
    });
  });
});

