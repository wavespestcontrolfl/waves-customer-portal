// move-limit.js (owner 2026-10-09: at most two automatic moves per visit,
// counted from the durable move log) and needs-person-notice.js (the admin
// notice for a visit auto-dispatch cannot fix alone).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(async () => ({ id: 1 })),
}));

// The shared ring allowance and the notice store reads (audit.js) are faked;
// the budget pick and the ring test are the real ones.
jest.mock('../services/auto-dispatch/audit', () => {
  const actual = jest.requireActual('../services/auto-dispatch/audit');
  return {
    withinRingBudget: actual.withinRingBudget,
    noticeRang: actual.noticeRang,
    ringsLeft: jest.fn(async () => 10),
    standingNoticeKeys: jest.fn(async () => new Set()),
    retireResolvedNotices: jest.fn(async () => {}),
    namedVisitAction: jest.fn(async (_id, _templates, generic) => generic),
  };
});

const moveLimit = require('../services/auto-dispatch/move-limit');
const notice = require('../services/auto-dispatch/needs-person-notice');
const audit = require('../services/auto-dispatch/audit');
const { SLOT_CHANGED_SQL } = require('../services/auto-dispatch/eligibility');
const { raiseAdminAlert, composeAdminAlert } = require('../services/admin-alert-compose');
const { getAutoDispatchConfig } = require('../services/auto-dispatch/config');

// A knex-shaped conn that records the query and answers with `rows`.
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

describe('config', () => {
  afterEach(() => { delete process.env.AUTO_DISPATCH_MAX_MOVES_PER_VISIT; });
  test('maxAutoMovesPerVisit defaults to 2, reads the env, 0 = no limit', () => {
    expect(getAutoDispatchConfig().maxAutoMovesPerVisit).toBe(2);
    process.env.AUTO_DISPATCH_MAX_MOVES_PER_VISIT = '3';
    expect(getAutoDispatchConfig().maxAutoMovesPerVisit).toBe(3);
    process.env.AUTO_DISPATCH_MAX_MOVES_PER_VISIT = '0';
    expect(moveLimit.limitOf(getAutoDispatchConfig())).toBe(0);
  });
});

describe('the count', () => {
  test('reads the auto-dispatch writer signature in the durable log where the slot changed (same-day re-times included)', async () => {
    const conn = logConn([{ scheduled_service_id: 's1', moves: '2' }, { scheduled_service_id: 's2', moves: '1' }]);
    const counts = await moveLimit.countAutoMoves(conn, ['s1', 's2', 's3']);
    expect(counts.get('s1')).toBe(2);
    expect(counts.get('s2')).toBe(1);
    expect(counts.get('s3')).toBeUndefined();
    expect(conn.calls).toEqual(expect.arrayContaining([
      ['table', 'reschedule_log'],
      ['where', 'reason_code', 'auto_dispatch'],
      ['where', 'initiated_by', 'auto_dispatch'],
      ['whereRaw', `${SLOT_CHANGED_SQL} AND original_window IS NOT NULL`],
      ['groupBy', 'scheduled_service_id'],
    ]));
    // The predicate: a changed date OR a changed window, so a same-day re-time counts.
    expect(SLOT_CHANGED_SQL).toMatch(/original_date IS DISTINCT FROM new_date OR original_window IS DISTINCT FROM new_window/);
  });

  test('no ids reads nothing; the limit off reads nothing; a failed read is null (fail closed)', async () => {
    const conn = logConn([]);
    expect((await moveLimit.countAutoMoves(conn, [])).size).toBe(0);
    expect((await moveLimit.loadMoveCounts(conn, ['s1'], { maxAutoMovesPerVisit: 0 })).size).toBe(0);
    expect(conn).not.toHaveBeenCalled();
    expect(await moveLimit.loadMoveCounts(logConn([], { fail: true }), ['s1'], { maxAutoMovesPerVisit: 2 })).toBeNull();
  });
});

describe('the verdict', () => {
  const config = { maxAutoMovesPerVisit: 2 };
  test('under the limit moves; at it, skips with MOVE_LIMIT_REACHED; unknown counts fail closed; off never skips', () => {
    expect(moveLimit.limitSkip({ id: 's1' }, new Map([['s1', 1]]), config)).toBeNull();
    expect(moveLimit.limitSkip({ id: 's1' }, new Map(), config)).toBeNull();
    expect(moveLimit.limitSkip({ id: 's1' }, new Map([['s1', 2]]), config)).toMatchObject({ reason_code: 'MOVE_LIMIT_REACHED' });
    expect(moveLimit.limitSkip({ id: 's1' }, new Map([['s1', 5]]), config)).toMatchObject({ reason_code: 'MOVE_LIMIT_REACHED' });
    expect(moveLimit.limitSkip({ id: 's1' }, null, config)).toMatchObject({ reason_code: 'MOVE_COUNT_UNKNOWN', unknown: true });
    expect(moveLimit.limitSkip({ id: 's1' }, new Map([['s1', 9]]), { maxAutoMovesPerVisit: 0 })).toBeNull();
    expect(moveLimit.limitSkip({ id: 's1' }, null, { maxAutoMovesPerVisit: 0 })).toBeNull();
  });

  test('the write-transaction check refuses with the caller\'s refusal when any row is at the limit', async () => {
    const refuse = (id, why) => Object.assign(new Error(`${id} ${why}`), { statusCode: 409 });
    const rows = [{ id: 's1' }, { id: 's2' }];
    await expect(moveLimit.assertUnderLimit(logConn([{ scheduled_service_id: 's2', moves: '2' }]), rows, config, refuse))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/^s2 .*2 times/) });
    await expect(moveLimit.assertUnderLimit(logConn([{ scheduled_service_id: 's2', moves: '1' }]), rows, config, refuse)).resolves.toBeUndefined();
  });
});

describe('needs-a-person notice', () => {
  const visit = (id, date) => ({ id, customer_id: `c-${id}`, scheduled_date: date });
  beforeEach(() => {
    raiseAdminAlert.mockClear();
    audit.ringsLeft.mockResolvedValue(10);
    audit.standingNoticeKeys.mockResolvedValue(new Set());
    audit.retireResolvedNotices.mockClear();
  });

  test('one notice per visit and date, soonest first, inside the shared allowance of 10', async () => {
    const bucket = new Map();
    for (let day = 12; day >= 1; day--) notice.collect(bucket, visit(`s${day}`, `2026-11-${String(day).padStart(2, '0')}`), 'move_limit', { kind: 'overlap' });
    notice.collect(bucket, visit('s1', '2026-11-01'), 'move_limit', { kind: 'overlap' }); // the same visit and date again
    expect(bucket.size).toBe(12);
    expect(await notice.raiseNotices(bucket)).toBe(10);
    const dates = raiseAdminAlert.mock.calls.map(([, , opts]) => opts.metadata.scheduledDate);
    expect(dates).toEqual([...dates].sort());
    expect(dates[0]).toBe('2026-11-01');
    expect(dates).not.toContain('2026-11-11');
    expect(raiseAdminAlert.mock.calls[0][2].dedupeKey).toBe('auto-dispatch-needs-person:s1:2026-11-01');
  });

  // The lane shares the allowance with every auto-dispatch lane (#6208): a
  // day another lane filled leaves nothing, and a standing notice is free.
  test('the shared allowance: 3 left rings 3; a standing notice is refreshed free; a deduped write spends nothing', async () => {
    const bucket = new Map();
    for (let day = 1; day <= 5; day++) notice.collect(bucket, visit(`s${day}`, `2026-11-0${day}`), 'no_slot', { kind: 'overlap' });
    audit.ringsLeft.mockResolvedValue(3);
    audit.standingNoticeKeys.mockResolvedValue(new Set(['auto-dispatch-needs-person:s1:2026-11-01']));
    raiseAdminAlert.mockResolvedValueOnce({ id: 9, deduped: true }); // s1: standing, refreshed, no ring
    expect(await notice.raiseNotices(bucket)).toBe(3);
    expect(raiseAdminAlert.mock.calls.map(([, , opts]) => opts.dedupeKey.split(':')[1])).toEqual(['s1', 's2', 's3', 's4']);
    raiseAdminAlert.mockClear();
    audit.ringsLeft.mockResolvedValue(0);
    expect(await notice.raiseNotices(bucket)).toBe(0);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a complete run closes the notice of a loaded visit it no longer collects; any other notice stays', async () => {
    const bucket = new Map();
    notice.collect(bucket, visit('kept', '2026-11-01'), 'no_slot', { kind: 'overlap' });
    audit.standingNoticeKeys.mockResolvedValue(new Set([
      'auto-dispatch-needs-person:kept:2026-11-01', 'auto-dispatch-needs-person:fixed:2026-11-02', 'auto-dispatch-needs-person:notloaded:2026-11-03',
    ]));
    const clearedOf = () => {
      const q = { whereRaw: jest.fn(() => q), whereIn: jest.fn(() => q), whereNotIn: jest.fn(() => q) };
      audit.retireResolvedNotices.mock.calls[audit.retireResolvedNotices.mock.calls.length - 1][0].stillOpen(q);
      return q.whereNotIn.mock.calls;
    };
    await notice.raiseNotices(bucket, { complete: true, loadedIds: new Set(['kept', 'fixed']) });
    expect(clearedOf()).toEqual([['s.id', ['fixed']]]);
    // A run that failed part way clears nothing by evaluation.
    await notice.raiseNotices(bucket, { complete: false, loadedIds: new Set(['kept', 'fixed']) });
    expect(clearedOf()).toEqual([]);
  });

  test('a failed notice is logged, the rest still go, and nothing throws', async () => {
    const bucket = new Map();
    notice.collect(bucket, visit('a', '2026-11-01'), 'no_slot', { kind: 'overlap' });
    notice.collect(bucket, visit('b', '2026-11-02'), 'no_slot', { kind: 'overlap' });
    raiseAdminAlert.mockRejectedValueOnce(new Error('down'));
    expect(await notice.raiseNotices(bucket)).toBe(1);
  });

  test('every wording passes the admin-notification rules, with and without a customer name', async () => {
    const bucket = new Map();
    const conflicts = [{ kind: 'overlap' }, { kind: 'closed_day' }, null];
    let n = 0;
    for (const kind of ['move_limit', 'no_near_slot', 'no_slot']) {
      for (const conflict of conflicts) {
        if (!conflict && kind !== 'move_limit') continue;
        n += 1;
        notice.collect(bucket, { ...visit(`s${n}`, '2026-11-26'), first_name: 'Pat', last_name: 'Example' }, kind, conflict);
      }
    }
    await notice.raiseNotices(bucket);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(n);
    for (const [category, spec] of raiseAdminAlert.mock.calls) {
      expect(category).toBe('schedule_conflict');
      expect(() => composeAdminAlert(spec)).not.toThrow();
    }
    // The named headline of each kind fits the composer's rules too.
    const { fitAction } = jest.requireActual('../services/admin-alert-names');
    audit.namedVisitAction.mockImplementation(async (_id, templates) => fitAction('Schedule', 'Sample Tester', templates));
    raiseAdminAlert.mockClear();
    await notice.raiseNotices(bucket);
    for (const [, spec] of raiseAdminAlert.mock.calls) {
      expect(spec.action).toContain('Sample Tester');
      expect(() => composeAdminAlert(spec)).not.toThrow();
    }
    audit.namedVisitAction.mockImplementation(async (_id, _templates, generic) => generic);
  });

  test('only a conflict visit that auto-dispatch cannot fix is collected from an evaluation', () => {
    const bucket = new Map();
    const conflict = { kind: 'overlap' };
    notice.collectFromEvaluation(bucket, visit('a', '2026-11-01'), { reason_code: 'NO_SCORE_IMPROVEMENT', conflict });
    notice.collectFromEvaluation(bucket, visit('b', '2026-11-01'), { reason_code: 'CONFLICT_NO_NEAR_SLOT', conflict: null });
    notice.collectFromEvaluation(bucket, visit('c', '2026-11-01'), { reason_code: 'NO_DRIVE_SAVING', conflict });
    expect(bucket.size).toBe(0);
    notice.collectFromEvaluation(bucket, visit('d', '2026-11-01'), { reason_code: 'CONFLICT_NO_NEAR_SLOT', conflict });
    notice.collectFromEvaluation(bucket, visit('e', '2026-11-01'), { reason_code: 'NO_VALID_SLOT', conflict });
    notice.collectFromEvaluation(bucket, visit('f', '2026-11-01'), { reason_code: 'NO_SLOT_MATCHING_PREFERENCE', conflict });
    expect([...bucket.values()].map((i) => i.kind)).toEqual(['no_near_slot', 'no_slot', 'no_slot']);
  });
});
