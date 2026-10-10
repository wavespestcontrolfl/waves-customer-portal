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

  // Codex #6253 r1 P2: a notice closes on PROOF (the run moved the visit, or
  // evaluated it and read no conflict), never because a run did not collect it.
  test('a notice closes only for a visit the run proved clear; a visit still collected stays', async () => {
    const bucket = new Map();
    notice.collect(bucket, visit('kept', '2026-11-01'), 'no_slot', { kind: 'overlap' });
    const clearedOf = () => {
      const q = { whereRaw: jest.fn(() => q), whereIn: jest.fn(() => q), whereNotIn: jest.fn(() => q) };
      audit.retireResolvedNotices.mock.calls[audit.retireResolvedNotices.mock.calls.length - 1][0].stillOpen(q);
      return { cleared: q.whereNotIn.mock.calls, sql: q.whereRaw.mock.calls.map(([text]) => text).join(' ') };
    };
    await notice.raiseNotices(bucket, { clearedIds: new Set(['kept', 'fixed']) });
    expect(clearedOf().cleared).toEqual([['s.id', ['fixed']]]);
    // No proof (a degraded run, a skipped visit): nothing closes by evaluation.
    await notice.raiseNotices(bucket, {});
    expect(clearedOf().cleared).toEqual([]);
    // The visit's own row decides the rest: its date and its status.
    expect(clearedOf().sql).toMatch(/scheduled_date::text = notifications\.metadata->>'scheduledDate'/);
  });

  test('an empty run still closes what its proof allows, and raises nothing', async () => {
    expect(await notice.raiseNotices(new Map(), { clearedIds: new Set(['fixed']) })).toBe(0);
    expect(audit.retireResolvedNotices).toHaveBeenCalledTimes(1);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
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
    const conflicts = [{ kind: 'overlap' }, { kind: 'closed_day' }];
    let n = 0;
    // No conflict, no notice: a visit with no arrival time is not this lane's.
    notice.collect(bucket, visit('unplaced', '2026-11-26'), 'move_limit', null);
    for (const kind of ['move_limit', 'no_near_slot', 'no_slot', 'not_moved']) {
      for (const conflict of conflicts) {
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

  // Codex #6253 r1: a list of reason codes missed two of them. One rule now:
  // in conflict and not moved = a person is told; the reason picks the wording.
  test('every visit left in conflict is collected, whatever the reason; no conflict, nothing', () => {
    const bucket = new Map();
    const conflict = { kind: 'overlap' };
    notice.collectUnmoved(bucket, visit('a', '2026-11-01'), 'CONFLICT_NO_NEAR_SLOT', null);
    notice.collectUnmoved(bucket, visit('b', '2026-11-01'), 'GROUP_MEMBER_GUARD', undefined);
    expect(bucket.size).toBe(0);
    const reasons = ['CONFLICT_NO_NEAR_SLOT', 'NO_VALID_SLOT', 'NO_SLOT_MATCHING_PREFERENCE', 'DRIFT_ANCHOR_STALE', 'MOVE_LIMIT_REACHED', 'GROUP_MEMBER_GUARD', 'ERROR', 'A_REASON_ADDED_LATER'];
    reasons.forEach((reason, i) => notice.collectUnmoved(bucket, visit(`v${i}`, '2026-11-01'), reason, conflict));
    expect([...bucket.values()].map((i) => i.kind)).toEqual(['no_near_slot', 'no_slot', 'no_slot', 'no_slot', 'move_limit', 'not_moved', 'not_moved', 'not_moved']);
  });

});
