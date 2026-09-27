// FLEX-TIER apply-time write-path guards (Codex pre-push P1 — 3 findings):
//   1. index.js:444 — loadReminderFreeze reports "not frozen" for a visit
//      with NO reminder row at all, and the flex ctx removed the legacy
//      date lock, so the 73h cutoff must ALSO be enforced directly from the
//      visit's own schedule (flexTier.ownScheduleFrozen), independent of
//      reminder evidence — exercised here through the write-path guards
//      that gate the actual commit (checkFlexOwnBounds / checkFlexSiblingBounds).
//   2. apply.js's makeMemberGuard only knew routeTiersEnabled — grouped
//      siblings must get the SAME flex rules (73h cutoff, ±5 days, their
//      own series-neighbor bounds), with flex precedence over tiers.
//   3. The series-neighbor bounds must be RE-READ fresh at apply time,
//      inside the write path (under the trx the rebooker/apply already
//      hold) — never reused from an earlier snapshot — so a newly
//      inserted/edited occurrence blocks a crossing move.
jest.mock('../services/auto-dispatch/route-tiers', () => ({
  ...jest.requireActual('../services/auto-dispatch/route-tiers'),
  loadReminderFreeze: jest.fn(),
}));
jest.mock('../services/appointment-reminders', () => ({
  // A realistic composer (mirrors the real module's own logic) so
  // ownScheduleFrozen's hours-until-appointment math is genuine, without
  // pulling in the full appointment-reminders module and its own
  // dependencies into this unit test.
  composeScheduledApptTime: jest.fn((svc) => {
    if (!svc) return null;
    const datePart = String(svc.scheduled_date || '').slice(0, 10);
    const timePart = svc.window_start ? String(svc.window_start).slice(0, 8) : null;
    if (!datePart || !timePart) return null;
    return require('../utils/datetime-et').parseETDateTime(`${datePart}T${timePart}`);
  }),
}));

const routeTiers = require('../services/auto-dispatch/route-tiers');
const {
  makeMoveGuard, makeMemberGuard, checkFlexOwnBounds, checkFlexSiblingBounds, previewGroupMove,
} = require('../services/auto-dispatch/apply');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const TODAY = etDateString(new Date());
const dayOffset = (n) => etDateString(addETDays(parseETDateTime(`${TODAY}T12:00`), n));

function refuseFactory() {
  return (id, why) => Object.assign(new Error(`refused ${id}: ${why}`), { code: 'TEST_REFUSE', id, why });
}

// `raw` answers fenceFlexSeries' pg_try_advisory_xact_lock — granted
// unless the parent is listed in `busyParents`.
function withSeriesFence(trx, busyParents = []) {
  trx.raw = jest.fn(async (_sql, [, parentId]) => ({ rows: [{ locked: !busyParents.includes(parentId) }] }));
  return trx;
}

// A trx stub for the reads these unit-level guard functions issue once
// loadReminderFreeze is mocked: loadSeriesNeighbors' bulk
// `db('scheduled_services').where(fn).whereNotIn(status)[.forShare().noWait()].select(...)`
// and route-tiers' loadAnchorMap evidence reads (reschedule_log /
// auto_dispatch_audit_logs — `moves` are reschedule_log rows, none by
// default, so every visit anchors on its own date). `trx.locks` records the
// row-lock clauses; `rowLockBusy` makes a NOWAIT read fail the way
// PostgreSQL does when another transaction holds a series row (55P03).
function seriesTrx(rowsByParent, busyParents, moves = [], { rowLockBusy = false } = {}) {
  const locks = [];
  const trx = withSeriesFence(jest.fn((table) => {
    if (table === 'reschedule_log' || table === 'auto_dispatch_audit_logs') {
      const rows = table === 'reschedule_log' ? moves : [];
      const chain = {
        whereIn: () => chain, where: () => chain, orderBy: () => chain, select: async () => rows,
      };
      return chain;
    }
    if (table !== 'scheduled_services') throw new Error(`unexpected table ${table}`);
    let parentIds = [];
    let noWait = false;
    const capture = { whereIn: (col, vals) => { if (col === 'id') parentIds = vals; return capture; }, orWhereIn: () => capture };
    const api = {
      where: (fn) => { fn.call(capture); return api; },
      whereNotIn: () => api,
      forShare: () => { locks.push('forShare'); return api; },
      noWait: () => { locks.push('noWait'); noWait = true; return api; },
      select: async () => {
        if (noWait && rowLockBusy) {
          throw Object.assign(new Error('could not obtain lock on row in relation "scheduled_services"'), { code: '55P03' });
        }
        return parentIds.flatMap((pid) => (rowsByParent[pid] || [])
          .map((r) => ({ recurring_parent_id: r.id === pid ? null : pid, ...r })));
      },
    };
    return api;
  }), busyParents);
  trx.locks = locks;
  return trx;
}

// The unit mover's per-member targets for `rows`, each landing on its own
// current start (the member guard reads a sibling's destination start here).
const targetsOf = (rows) => rows.map((r) => ({ id: r.id, startHHMM: r.window_start }));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkFlexOwnBounds (the tapped row, inside makeMoveGuard)', () => {
  const BEST = { date: dayOffset(9), technician_id: null };

  test('no-op outside flex mode, for a non-recurring-child row, or an unplaced due-date visit', async () => {
    const trx = jest.fn(() => { throw new Error('must not query'); });
    const refuse = refuseFactory();
    const recurringRow = {
      id: 's1', scheduled_date: dayOffset(9), window_start: '09:00', is_recurring: true, recurring_parent_id: 'p1',
    };
    await expect(checkFlexOwnBounds(trx, recurringRow, BEST, 'tiers', refuse)).resolves.toBeUndefined();
    await expect(checkFlexOwnBounds(trx, recurringRow, BEST, 'legacy', refuse)).resolves.toBeUndefined();
    await expect(checkFlexOwnBounds(trx, { ...recurringRow, recurring_parent_id: null }, BEST, 'flex', refuse)).resolves.toBeUndefined();
    await expect(checkFlexOwnBounds(trx, { ...recurringRow, is_recurring: false }, BEST, 'flex', refuse)).resolves.toBeUndefined();
    await expect(checkFlexOwnBounds(trx, {
      ...recurringRow, recurring_dispatch_due_date: dayOffset(9), window_start: null,
    }, BEST, 'flex', refuse)).resolves.toBeUndefined();
    expect(trx).not.toHaveBeenCalled();
  });

  test('Finding 1: a row within 73h of its OWN schedule is frozen — no reminder evidence involved at all', async () => {
    const trx = jest.fn(() => { throw new Error('must not query — frozen before any DB read'); });
    const refuse = refuseFactory();
    const soonRow = {
      id: 's1', scheduled_date: dayOffset(2), window_start: '09:00', is_recurring: true, recurring_parent_id: 'p1',
    };
    await expect(checkFlexOwnBounds(trx, soonRow, BEST, 'flex', refuse))
      .rejects.toMatchObject({ code: 'TEST_REFUSE', id: 's1' });
  });

  test('a row safely past 73h, with no adjacent occurrence, admits a best.date inside ±5 days', async () => {
    const row = {
      id: 's1', scheduled_date: dayOffset(9), window_start: '09:00', is_recurring: true, recurring_parent_id: 'p1',
    };
    const trx = seriesTrx({ p1: [{ id: 's1', scheduled_date: dayOffset(9) }] });
    const refuse = refuseFactory();
    await expect(checkFlexOwnBounds(trx, row, { date: dayOffset(12) }, 'flex', refuse)).resolves.toBeUndefined();
  });

  test('Finding 3: a freshly-read (never cached) NEXT occurrence blocks a move that would cross it', async () => {
    const row = {
      id: 's1', scheduled_date: dayOffset(9), window_start: '09:00', is_recurring: true, recurring_parent_id: 'p1',
    };
    // A sibling occurrence 3 days after the tapped row — inside the ±5
    // radius, so it must clamp the legal window.
    const trx = seriesTrx({
      p1: [
        { id: 's1', scheduled_date: dayOffset(9) },
        { id: 's2', scheduled_date: dayOffset(12) },
      ],
    });
    const refuse = refuseFactory();
    // Landing ON or past the adjacent occurrence's date is refused...
    await expect(checkFlexOwnBounds(trx, row, { date: dayOffset(12) }, 'flex', refuse))
      .rejects.toMatchObject({ code: 'TEST_REFUSE', id: 's1' });
    // ...one day short of it is fine.
    await expect(checkFlexOwnBounds(trx, row, { date: dayOffset(11) }, 'flex', refuse)).resolves.toBeUndefined();
  });

  test('an unreadable series-neighbor read fails closed (no move)', async () => {
    const row = {
      id: 's1', scheduled_date: dayOffset(9), window_start: '09:00', is_recurring: true, recurring_parent_id: 'p1',
    };
    const trx = withSeriesFence(jest.fn(() => ({ where: () => ({ whereNotIn: () => ({ select: async () => { throw new Error('db down'); } }) }) })));
    const refuse = refuseFactory();
    await expect(checkFlexOwnBounds(trx, row, { date: dayOffset(11) }, 'flex', refuse))
      .rejects.toMatchObject({ code: 'TEST_REFUSE', id: 's1' });
  });
});

describe('fenceFlexSeries — series writers are serialized, not just re-read', () => {
  const row = {
    id: 's1', scheduled_date: dayOffset(9), window_start: '09:00', is_recurring: true, recurring_parent_id: 'p1',
  };

  test('takes the canonical recurring-series-maintenance lock for the parent before reading neighbors', async () => {
    const trx = seriesTrx({ p1: [{ id: 's1', scheduled_date: dayOffset(9) }] });
    await expect(checkFlexOwnBounds(trx, row, { date: dayOffset(11) }, 'flex', refuseFactory())).resolves.toBeUndefined();
    expect(trx.raw).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS locked',
      ['recurring-series-maintenance', 'p1'],
    );
    expect(trx.raw.mock.invocationCallOrder[0]).toBeLessThan(trx.mock.invocationCallOrder[0]);
  });

  test('a series update in progress refuses the move without waiting or reading neighbors (fail closed)', async () => {
    const trx = seriesTrx({ p1: [{ id: 's1', scheduled_date: dayOffset(9) }] }, ['p1']);
    await expect(checkFlexOwnBounds(trx, row, { date: dayOffset(11) }, 'flex', refuseFactory()))
      .rejects.toMatchObject({ code: 'TEST_REFUSE', id: 's1', why: expect.stringContaining('series update in progress') });
    expect(trx).not.toHaveBeenCalled();
  });

  test('grouped siblings fence every distinct parent in sorted order and refuse on the busy one', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set() });
    const rows = [
      { id: 's3', scheduled_date: dayOffset(9), window_start: '09:00', recurring_parent_id: 'p2' },
      { id: 's2', scheduled_date: dayOffset(9), window_start: '09:00', recurring_parent_id: 'p1' },
    ];
    const trx = seriesTrx({ p1: [rows[1]], p2: [rows[0]] }, ['p2']);
    await expect(checkFlexSiblingBounds(trx, rows, rows, { date: dayOffset(11) }, TODAY, refuseFactory(), targetsOf(rows)))
      .rejects.toMatchObject({ id: 's3' });
    expect(trx.raw.mock.calls.map((c) => c[1][1])).toEqual(['p1', 'p2']);
  });
});

describe('checkFlexSiblingBounds (grouped siblings) — Finding 2', () => {
  const BEST = { date: dayOffset(11) };
  function sib(overrides = {}) {
    return {
      id: 's2', scheduled_date: dayOffset(9), window_start: '09:00', recurring_parent_id: 'p1', ...overrides,
    };
  }

  test('the 73h reminder band (route-tiers evidence) freezes a sibling, fail closed on an unreadable read', async () => {
    const rows = [sib()];
    const trx = seriesTrx({ p1: rows });
    const refuse = refuseFactory();
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: true, frozen: new Set() });
    await expect(checkFlexSiblingBounds(trx, rows, rows, BEST, TODAY, refuse)).rejects.toMatchObject({ id: 's2' });
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set(['s2']) });
    await expect(checkFlexSiblingBounds(trx, rows, rows, BEST, TODAY, refuse)).rejects.toMatchObject({ id: 's2' });
    // Confirms the FLEX freeze band was requested, not route-tiers' own default.
    const { FLEX_TIER_FREEZE_HOURS } = require('../services/auto-dispatch/flex-tier');
    expect(routeTiers.loadReminderFreeze).toHaveBeenLastCalledWith(trx, ['s2'], expect.any(Date), FLEX_TIER_FREEZE_HOURS);
  });

  test('Finding 1: a sibling within 73h of its OWN schedule freezes the grouped move even with clean reminder evidence', async () => {
    const rows = [sib({ scheduled_date: dayOffset(2) })];
    const trx = seriesTrx({ p1: rows });
    const refuse = refuseFactory();
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set() }); // no reminder row at all
    await expect(checkFlexSiblingBounds(trx, rows, rows, BEST, TODAY, refuse)).rejects.toMatchObject({ id: 's2' });
  });

  test('a sibling passes when clear of the freeze and inside its own flex window', async () => {
    const rows = [sib()];
    const trx = seriesTrx({ p1: rows });
    const refuse = refuseFactory();
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set() });
    await expect(checkFlexSiblingBounds(trx, rows, rows, BEST, TODAY, refuse, targetsOf(rows))).resolves.toBeUndefined();
  });

  test('Finding 3: a sibling series-neighbor bound is re-read fresh — a newly inserted occurrence between the members blocks the move', async () => {
    const rows = [sib({ id: 's2', scheduled_date: dayOffset(9) }), sib({ id: 's3', scheduled_date: dayOffset(20) })];
    // s3's real previous occurrence is now s2b (a NEW row at day+12, inserted
    // since any earlier read) — s3 cannot legally land on dayOffset(11),
    // which is BEFORE that newly-inserted occurrence's own date... exercise
    // the more direct case: a new occurrence lands INSIDE the radius and
    // must clamp best.date for the sibling whose window it bounds.
    const trx = seriesTrx({
      p1: [
        { id: 's2', scheduled_date: dayOffset(9) },
        { id: 's2b', scheduled_date: dayOffset(12) }, // newly inserted, between s2 and s3
        { id: 's3', scheduled_date: dayOffset(20) },
      ],
    });
    const refuse = refuseFactory();
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set() });
    // best.date = dayOffset(11) crosses s2's newly-adjacent next occurrence (day 12 - 1 = day 11 is the last legal day; day 12+ crosses it)
    await expect(checkFlexSiblingBounds(trx, rows, rows, { date: dayOffset(12) }, TODAY, refuse, targetsOf(rows)))
      .rejects.toMatchObject({ id: 's2', why: expect.stringContaining('cannot legally move') });
  });
});

describe('checkFlexSiblingBounds — unplaced due-date sibling', () => {
  test('an unplaced due-date sibling (no window_start) is exempt from the freeze and series window, like the tapped row', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set() });
    const rows = [{
      id: 's2', scheduled_date: dayOffset(9), window_start: null, recurring_dispatch_due_date: dayOffset(9), recurring_parent_id: 'p1',
    }];
    const trx = seriesTrx({ p1: rows });
    await expect(checkFlexSiblingBounds(trx, rows, rows, { date: dayOffset(10) }, TODAY, refuseFactory())).resolves.toBeUndefined();
    expect(trx.raw).not.toHaveBeenCalled();
  });

  test('a placed sibling beside an unplaced one is still frozen/bounded', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set() });
    const rows = [
      { id: 's2', scheduled_date: dayOffset(9), window_start: null, recurring_dispatch_due_date: dayOffset(9), recurring_parent_id: 'p1' },
      { id: 's3', scheduled_date: dayOffset(2), window_start: '09:00', recurring_parent_id: 'p1' },
    ];
    const trx = seriesTrx({ p1: rows });
    await expect(checkFlexSiblingBounds(trx, rows, rows, { date: dayOffset(10) }, TODAY, refuseFactory(), targetsOf(rows)))
      .rejects.toMatchObject({ id: 's3' });
  });
});

describe('makeMoveGuard / makeMemberGuard thread the resolved guard mode (Finding 2 wiring)', () => {
  test('makeMoveGuard applies the flex check when config.guardMode is flex, and skips it otherwise', async () => {
    const row = {
      id: 's1', scheduled_date: dayOffset(2), window_start: '09:00', is_recurring: true, recurring_parent_id: 'p1', technician_id: null,
    };
    const best = { date: dayOffset(9), technician_id: null };
    const guardOn = makeMoveGuard({ service: row, best, config: { guardMode: 'flex' } });
    await expect(guardOn({ trx: jest.fn(), technicianId: null }))
      .rejects.toMatchObject({ code: 'VISIT_AUTO_DISPATCH_CAPABILITY_GUARD' }); // 73h own-schedule freeze, no trx query needed
    const guardOff = makeMoveGuard({ service: row, best, config: {} });
    await expect(guardOff({ trx: jest.fn(), technicianId: null })).resolves.toBeUndefined();
  });

  test('makeMemberGuard dispatches to the flex sibling check when config.guardMode is flex', async () => {
    const service = { id: 's1', status: 'confirmed' };
    const sibling = {
      id: 's2', status: 'confirmed', scheduled_date: dayOffset(2), window_start: '09:00',
      is_recurring: true, recurring_parent_id: 'p1', technician_id: null,
      lat: 27.4, lng: -82.5, customer_active: true, // clears eligibility so the flex freeze is what's actually exercised
    };
    const trx = jest.fn((table) => {
      if (table === 'scheduled_services as ss') {
        return {
          leftJoin: () => ({ whereIn: () => ({ select: async () => [sibling] }) }),
        };
      }
      if (table === 'recurring_plan_alerts') return { where: () => ({ where: () => ({ where: () => ({ whereNull: () => ({ first: async () => null }) }) }) }) };
      if (table === 'scheduled_services') {
        return {
          where: (fn) => { const cap = { where: () => cap, orWhere: () => cap }; fn.call(cap); return { whereNotIn: () => ({ select: async () => [sibling] }) }; },
        };
      }
      return { where: () => ({ orWhereNull: () => ({ first: async () => null }) }) };
    });
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set() });
    const guard = makeMemberGuard({ service, best: { date: dayOffset(9) }, config: { guardMode: 'flex' }, techChanged: false });
    await expect(guard({ trx, members: [service, { id: 's2', status: 'confirmed' }] }))
      .rejects.toMatchObject({ code: 'VISIT_MEMBER_AUTO_DISPATCH_GUARD', memberId: 's2', message: expect.stringContaining('73 hours') });
  });
});

describe('apply-time drift bound — ±5 days from the durable original date (Codex #4995 P1)', () => {
  test('a visit an earlier night already moved +5 cannot be pushed further out at apply time', async () => {
    const row = {
      id: 's1', scheduled_date: dayOffset(14), window_start: '09:00', is_recurring: true, recurring_parent_id: 'p1', auto_dispatch_change_count: 1,
    };
    const moves = [{ scheduled_service_id: 's1', original_date: dayOffset(9), created_at: new Date() }];
    const trx = seriesTrx({ p1: [{ id: 's1', scheduled_date: dayOffset(14) }] }, [], moves);
    await expect(checkFlexOwnBounds(trx, row, { date: dayOffset(15) }, 'flex', refuseFactory()))
      .rejects.toMatchObject({ id: 's1', why: expect.stringContaining(`original date ${dayOffset(9)}`) });
    // Back toward the original date stays legal.
    await expect(checkFlexOwnBounds(trx, row, { date: dayOffset(12) }, 'flex', refuseFactory())).resolves.toBeUndefined();
  });

  test('moved per change_count but no durable record of the original date refuses (never guesses a budget)', async () => {
    const row = {
      id: 's1', scheduled_date: dayOffset(14), window_start: '09:00', is_recurring: true, recurring_parent_id: 'p1', auto_dispatch_change_count: 1,
    };
    const trx = seriesTrx({ p1: [{ id: 's1', scheduled_date: dayOffset(14) }] });
    await expect(checkFlexOwnBounds(trx, row, { date: dayOffset(13) }, 'flex', refuseFactory()))
      .rejects.toMatchObject({ id: 's1', why: expect.stringContaining('drift anchor') });
  });
});

describe('the authoritative neighbor read row-locks the series (Codex #4995 P1)', () => {
  const row = {
    id: 's1', scheduled_date: dayOffset(9), window_start: '09:00', is_recurring: true, recurring_parent_id: 'p1',
  };

  test('the tapped row reads its neighbors FOR SHARE NOWAIT, after the series fence', async () => {
    const trx = seriesTrx({ p1: [{ id: 's1', scheduled_date: dayOffset(9) }] });
    await expect(checkFlexOwnBounds(trx, row, { date: dayOffset(11) }, 'flex', refuseFactory())).resolves.toBeUndefined();
    expect(trx.locks).toEqual(['forShare', 'noWait']);
    expect(trx.raw.mock.invocationCallOrder[0]).toBeLessThan(trx.mock.invocationCallOrder[0]);
  });

  test('a neighbor row already being rescheduled (lock not available) refuses at once — fail closed, no wait', async () => {
    const trx = seriesTrx({ p1: [{ id: 's1', scheduled_date: dayOffset(9) }] }, [], [], { rowLockBusy: true });
    await expect(checkFlexOwnBounds(trx, row, { date: dayOffset(11) }, 'flex', refuseFactory()))
      .rejects.toMatchObject({ id: 's1', why: expect.stringContaining('being edited') });
  });

  test('grouped siblings are read under the same row lock', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set() });
    const rows = [{ id: 's2', scheduled_date: dayOffset(9), window_start: '09:00', recurring_parent_id: 'p1' }];
    const trx = seriesTrx({ p1: rows });
    await expect(checkFlexSiblingBounds(trx, rows, rows, { date: dayOffset(11) }, TODAY, refuseFactory(), targetsOf(rows))).resolves.toBeUndefined();
    expect(trx.locks).toEqual(['forShare', 'noWait']);
  });

  test('a visit missing from its own series read refuses (fail closed)', async () => {
    const trx = seriesTrx({ p1: [{ id: 'p1', scheduled_date: dayOffset(1) }] });
    await expect(checkFlexOwnBounds(trx, row, { date: dayOffset(11) }, 'flex', refuseFactory()))
      .rejects.toMatchObject({ id: 's1', why: expect.stringContaining('missing from its own series read') });
  });
});

describe('destination freeze — the DESTINATION instant must clear 73h, not just the source (Codex #4995 P1)', () => {
  // Mon 2026-10-05 15:00 ET (19:00Z): Thu 10-08 17:00 ET is 74h away (movable),
  // but a same-day re-time to 09:00 would be only 66h away.
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-05T19:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  const row = {
    id: 's1', scheduled_date: '2026-10-08', window_start: '17:00', is_recurring: true, recurring_parent_id: 'p1', technician_id: null,
  };

  test('the row being written: 17:00 -> 09:00 the same day is refused; keeping 17:00 or a later day passes', async () => {
    const trx = seriesTrx({ p1: [{ id: 's1', scheduled_date: '2026-10-08' }] });
    await expect(checkFlexOwnBounds(trx, row, { date: '2026-10-08', start_time: '09:00' }, 'flex', refuseFactory(), { date: '2026-10-08', windowStart: '09:00' }))
      .rejects.toMatchObject({ id: 's1', why: expect.stringContaining('at its destination') });
    await expect(checkFlexOwnBounds(trx, row, { date: '2026-10-08', start_time: '17:00' }, 'flex', refuseFactory(), { date: '2026-10-08', windowStart: '17:00' })).resolves.toBeUndefined();
    await expect(checkFlexOwnBounds(trx, row, { date: '2026-10-10', start_time: '08:00' }, 'flex', refuseFactory(), { date: '2026-10-10', windowStart: '08:00' })).resolves.toBeUndefined();
  });

  test('a day move below the 5-day destination floor is refused; only the current date is exempt (Codex #4995 r3 P1)', async () => {
    // Today is 10-05, so the floor is 10-10: Fri 10-09 sits between the
    // visit's own date (10-08) and the floor.
    const trx = seriesTrx({ p1: [{ id: 's1', scheduled_date: '2026-10-08' }] });
    await expect(checkFlexOwnBounds(trx, row, { date: '2026-10-09', start_time: '09:00' }, 'flex', refuseFactory(), { date: '2026-10-09', windowStart: '09:00' }))
      .rejects.toMatchObject({ id: 's1', why: expect.stringContaining('destination floor') });
  });

  test('makeMoveGuard checks the destination the rebooker is about to write — the tapped row and a forwarded grouped member alike', async () => {
    const best = { date: '2026-10-08', start_time: '09:00', technician_id: null };
    const guard = makeMoveGuard({ service: row, best, config: { guardMode: 'flex' } });
    await expect(guard({ trx: seriesTrx({ p1: [{ id: 's1', scheduled_date: '2026-10-08' }] }), technicianId: null, destination: { date: '2026-10-08', windowStart: '09:00' } }))
      .rejects.toMatchObject({ code: 'VISIT_AUTO_DISPATCH_CAPABILITY_GUARD', message: expect.stringContaining('at its destination') });
    // A grouped member whose own derived start crossed into the freeze since
    // planning is refused in its own write transaction...
    const member = { ...row, id: 's2' };
    const memberTrx = () => seriesTrx({ p1: [{ id: 's2', scheduled_date: '2026-10-08' }] });
    await expect(guard({ trx: memberTrx(), technicianId: null, service: member, destination: { date: '2026-10-08', windowStart: '09:00' } }))
      .rejects.toMatchObject({ message: expect.stringContaining('at its destination') });
    // ...and passes when its own start clears it.
    await expect(guard({ trx: memberTrx(), technicianId: null, service: member, destination: { date: '2026-10-08', windowStart: '17:00' } }))
      .resolves.toBeUndefined();
  });

  test('a grouped member: its own derived start is checked — 09:00 refused, 17:00 passes, no target fails closed', async () => {
    const sibRow = { id: 's2', scheduled_date: '2026-10-08', window_start: '17:00', recurring_parent_id: 'p1' };
    const trx = seriesTrx({ p1: [sibRow] });
    const best = { date: '2026-10-08' };
    for (let i = 0; i < 3; i++) routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set() });
    await expect(checkFlexSiblingBounds(trx, [sibRow], [sibRow], best, '2026-10-05', refuseFactory(), [{ id: 's2', startHHMM: '09:00' }]))
      .rejects.toMatchObject({ id: 's2', why: expect.stringContaining('at its destination') });
    await expect(checkFlexSiblingBounds(trx, [sibRow], [sibRow], best, '2026-10-05', refuseFactory(), [{ id: 's2', startHHMM: '17:00' }]))
      .resolves.toBeUndefined();
    await expect(checkFlexSiblingBounds(trx, [sibRow], [sibRow], best, '2026-10-05', refuseFactory(), []))
      .rejects.toMatchObject({ id: 's2', why: expect.stringContaining('at its destination') });
  });
});

describe('previewGroupMove — pass 1 runs the grouped-member guard, so a dry run never recommends what apply refuses (Codex #4995 r4 P2)', () => {
  // Mon 2026-10-05 15:00 ET (19:00Z).
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-05T19:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  // A pool stub answering the preview's member + visit reads and the member
  // guard's own reads (sibling rows, plan alerts, the series and clash reads,
  // anchor evidence, the series fence).
  function groupConn({ date }) {
    const members = [
      { id: 's1', status: 'confirmed', scheduled_date: date, window_start: '17:00', window_end: '18:00', estimated_duration_minutes: 60 },
      { id: 's2', status: 'confirmed', scheduled_date: date, window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60 },
    ];
    const siblingRow = {
      id: 's2', status: 'confirmed', scheduled_date: date, window_start: '09:00', is_recurring: true, recurring_parent_id: 'p1',
      technician_id: null, lat: 27.4, lng: -82.5, customer_active: true,
    };
    const conn = jest.fn((table) => {
      if (table === 'service_visits') return { where: () => ({ first: async () => ({ window_start: '17:00' }) }) };
      if (table === 'scheduled_services as ss') return { leftJoin: () => ({ whereIn: () => ({ select: async () => [siblingRow] }) }) };
      if (table === 'recurring_plan_alerts') return { where: () => ({ where: () => ({ where: () => ({ whereNull: () => ({ first: async () => null }) }) }) }) };
      if (table === 'reschedule_log' || table === 'auto_dispatch_audit_logs') {
        const chain = { whereIn: () => chain, where: () => chain, orderBy: () => chain, select: async () => [] };
        return chain;
      }
      if (table !== 'scheduled_services') throw new Error(`unexpected table ${table}`);
      let series = false;
      const q = {
        where: (arg) => { if (typeof arg === 'function') series = true; return q; },
        whereNotIn: () => q,
        forShare: () => q,
        noWait: () => q,
        select: async () => (series ? [{ id: 's2', recurring_parent_id: 'p1', scheduled_date: date }] : members),
        first: async () => null, // no same-series clash
      };
      return q;
    });
    return withSeriesFence(conn);
  }
  const service = { id: 's1', visit_id: 'v1', status: 'confirmed', technician_id: null };

  test('a grouped move whose earlier sibling is inside its own 73 hours is not recommended', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set() });
    // Both at Thu 10-08: the tapped 17:00 stop is 74h out, its 09:00 sibling 66h.
    const refusal = await previewGroupMove(
      { ...service, scheduled_date: '2026-10-08', window_start: '17:00' },
      { date: '2026-10-13', start_time: '17:00', end_time: '18:00', technician_id: null },
      { guardMode: 'flex' },
      groupConn({ date: '2026-10-08' }),
    );
    expect(refusal).toEqual({ code: 'GROUP_MEMBER_GUARD', description: expect.stringContaining('73 hours') });
  });

  test('a grouped move every sibling can legally make passes the whole member guard', async () => {
    routeTiers.loadReminderFreeze.mockResolvedValueOnce({ failed: false, frozen: new Set() });
    const conn = groupConn({ date: '2026-10-12' });
    await expect(previewGroupMove(
      { ...service, scheduled_date: '2026-10-12', window_start: '17:00' },
      { date: '2026-10-13', start_time: '17:00', end_time: '18:00', technician_id: null },
      { guardMode: 'flex' },
      conn,
    )).resolves.toBeNull();
    expect(conn.raw).toHaveBeenCalled(); // reached the sibling's series fence and window
  });

  test('an unreadable group is a failure the run records, not a quiet refusal', async () => {
    const conn = jest.fn(() => {
      const q = { where: () => q, whereNotIn: () => q, select: async () => { throw new Error('db down'); } };
      return q;
    });
    await expect(previewGroupMove(service, { date: '2026-10-13' }, { guardMode: 'flex' }, conn)).rejects.toThrow('db down');
  });

  test('an ungrouped visit, or a visit with one open member, needs no preview', async () => {
    const conn = jest.fn(() => { throw new Error('must not query'); });
    await expect(previewGroupMove({ id: 's1', visit_id: null }, { date: '2026-10-13' }, { guardMode: 'flex' }, conn)).resolves.toBeNull();
    const single = jest.fn(() => {
      const q = { where: () => q, whereNotIn: () => q, select: async () => [{ id: 's1' }] };
      return q;
    });
    await expect(previewGroupMove(service, { date: '2026-10-13' }, { guardMode: 'flex' }, single)).resolves.toBeNull();
  });
});
