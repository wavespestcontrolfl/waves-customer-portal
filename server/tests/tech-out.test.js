/**
 * services/tech-out.js — "tech out today" foundation: mark the absence and
 * park every open stop on the tech-day as a ranked overflow alert, in one
 * transaction. Nothing moves automatically.
 *
 * db is a small in-memory fake covering exactly the query shapes the
 * service issues (technicians FOR UPDATE, technician_absences insert /
 * update / locked read, dispatch_alerts open-alert read). day-stops,
 * tech-day-lock and dispatch-alerts are mocked. No real Postgres.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const state = { technicians: {}, absences: {}, alerts: [] };
  const reset = () => { state.technicians = {}; state.absences = {}; state.alerts = []; };
  const chain = (table) => {
    const c = {
      _cond: {}, _wheres: [], _whereRaws: [], _selectCols: null, _insert: null, _patch: null, _forUpdate: false,
    };
    for (const m of ['whereNull', 'orderBy']) c[m] = jest.fn(() => c);
    // whereRaw args are recorded (sql + bindings) — sweepAbsentTechDays'
    // dispatch_alerts read filters on payload->>'date'; select args are
    // recorded too so the dispatch_alerts fake can tell that call apart
    // from clearTechOut's existing `.select('id')` read.
    c.whereRaw = jest.fn((sql, bindings) => { c._whereRaws.push({ sql, bindings }); return c; });
    c.select = jest.fn((...cols) => { c._selectCols = cols; return c; });
    // Object form (`.where({a, b})`) and 2-arg equality (`.where('col', v)`)
    // both merge into `_cond`, exactly as before — every existing `.first()`
    // matcher below reads `_cond` and is unaffected. 3-arg comparison
    // (`.where('col', '>=', v)`, sweepAbsentTechDays' own absence_date
    // floor) is recorded ONLY in `_wheres`; `_cond` also gets an entry
    // pointing at that chain's own list-only resolver, never at a
    // `.first()` matcher (technician_absences' `.first()` is only ever
    // reached via a separate object-form `.where({technician_id, absence_date})`
    // chain instance).
    c.where = jest.fn((...args) => {
      if (args.length === 1 && typeof args[0] === 'object') {
        Object.assign(c._cond, args[0]);
        for (const [k, v] of Object.entries(args[0])) c._wheres.push([k, '=', v]);
      } else if (args.length === 2) {
        c._cond[args[0]] = args[1];
        c._wheres.push([args[0], '=', args[1]]);
      } else if (args.length === 3) {
        c._wheres.push([args[0], args[1], args[2]]);
      }
      return c;
    });
    c.forUpdate = jest.fn(() => { c._forUpdate = true; return c; });
    c.insert = jest.fn((row) => { c._insert = row; return c; });
    c.update = jest.fn((patch) => { c._patch = patch; return c; });
    if (table === 'technicians') {
      c.first = jest.fn(async () => state.technicians[c._cond.id] || null);
    } else if (table === 'technician_absences') {
      const match = () => Object.values(state.absences).find((r) => (
        (c._cond.id == null || r.id === c._cond.id)
        && (c._cond.technician_id == null || r.technician_id === c._cond.technician_id)
        && (c._cond.absence_date == null || r.absence_date === c._cond.absence_date)
        && (c.whereNull.mock.calls.length === 0 || !r.cleared_at)
      ));
      c.first = jest.fn(async () => match() || null);
      c.returning = jest.fn(async () => {
        if (c._insert) {
          const dup = Object.values(state.absences).find((r) => r.technician_id === c._insert.technician_id
            && r.absence_date === c._insert.absence_date && !r.cleared_at);
          if (dup) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
          const row = { id: `absence-${Object.keys(state.absences).length + 1}`, cleared_at: null, cleared_by: null, redistribution: null, ...c._insert };
          state.absences[row.id] = row;
          return [row];
        }
        const row = match();
        if (row && c._patch) {
          Object.assign(row, c._patch);
          if (typeof row.redistribution === 'string') row.redistribution = JSON.parse(row.redistribution);
        }
        return row ? [row] : [];
      });
      // sweepAbsentTechDays' own list read: whereNull('cleared_at') +
      // where('absence_date', '>=', today) + select(...). Independent of
      // `match()`/`_cond` above — driven entirely by `_wheres` so the
      // exact-date `.first()` matchers above are untouched.
      c.then = (res, rej) => Promise.resolve(
        Object.values(state.absences).filter((r) => (
          (c.whereNull.mock.calls.length === 0 || !r.cleared_at)
          && c._wheres.every(([col, op, val]) => {
            const rv = r[col];
            if (op === '>=') return rv >= val;
            if (op === '<=') return rv <= val;
            return rv === val;
          })
        )),
      ).then(res, rej);
    } else if (table === 'dispatch_alerts') {
      c.then = (res, rej) => {
        // clearTechOut selects only 'id' and never filters by date (matches
        // its real predicate not mattering to those tests); sweepAbsentTechDays
        // selects 'job_id'/'payload' and DOES filter by payload->>'date'.
        // Distinguishing on the requested columns keeps clearTechOut's
        // existing behavior byte-identical.
        const wantsPayload = Array.isArray(c._selectCols) && c._selectCols.includes('payload');
        const dateFilter = wantsPayload
          ? c._whereRaws.find((w) => /payload->>'date'/.test(w.sql))?.bindings?.[0]
          : undefined;
        // resolved_at is filtered only when the caller asked for it
        // (whereNull) — the sweep reads resolved rows too, to honor a
        // human's dismissal for the same absence.
        const rows = state.alerts.filter((a) => (
          a.type === c._cond.type
          && a.tech_id === c._cond.tech_id
          && (c.whereNull.mock.calls.length === 0 || !a.resolved_at)
          && (dateFilter === undefined || (a.payload && a.payload.date === dateFilter))
        ));
        const shaped = wantsPayload
          ? rows.map((a) => ({ id: a.id, job_id: a.job_id, payload: a.payload, resolved_at: a.resolved_at || null }))
          : rows.map((a) => ({ id: a.id }));
        return Promise.resolve(shaped).then(res, rej);
      };
    } else {
      throw new Error(`fake db: unexpected table ${table}`);
    }
    return c;
  };
  const fn = jest.fn(chain);
  fn.transaction = jest.fn(async (work) => {
    const trx = jest.fn(chain);
    trx.fn = { now: () => 'NOW()' };
    trx.isTransaction = true;
    trx.__chains = [];
    const wrapped = jest.fn((table) => { const c = trx(table); trx.__chains.push({ table, c }); return c; });
    wrapped.fn = trx.fn;
    wrapped.isTransaction = true;
    wrapped.__chains = trx.__chains;
    fn.__lastTrx = wrapped;
    return work(wrapped);
  });
  fn.fn = { now: () => 'NOW()' };
  fn.__state = state;
  fn.__reset = reset;
  return fn;
});

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/day-stops', () => ({ dayStopsQuery: jest.fn() }));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn().mockResolvedValue(['k']) }));
jest.mock('../services/dispatch-alerts', () => ({
  createAlert: jest.fn(),
  resolveAlert: jest.fn(),
}));
jest.mock('../sockets', () => ({ getIo: jest.fn() }));
jest.mock('../services/estimate-slot-availability', () => ({ invalidateAllEstimates: jest.fn() }));

const db = require('../models/db');
const { dayStopsQuery } = require('../services/scheduling/day-stops');
const { lockTechDays } = require('../services/scheduling/tech-day-lock');
const { createAlert, resolveAlert } = require('../services/dispatch-alerts');
const { getIo } = require('../sockets');
const { invalidateAllEstimates } = require('../services/estimate-slot-availability');
const logger = require('../services/logger');
const { etDateString, addETDays } = require('../utils/datetime-et');
const {
  REASONS, ALERT_TYPE, ABSENCE_EVENT, markTechOut, clearTechOut, getTechOut, parkTechDay, sweepAbsentTechDays, rankBumpOrder, _test,
} = require('../services/tech-out');

const TECH = { id: '11111111-2222-4333-8444-555555555555', name: 'Adam' };
// Computed relative to today: a literal near-today date would trip the
// not-in-the-past guard the night the ET calendar passes it (AGENTS.md).
const DATE = etDateString(addETDays(new Date(), 2));
const ACTOR = 'actor-1';

function fakeQuery(rows) {
  const q = { orderBy: jest.fn(() => q), then: (res, rej) => Promise.resolve(rows).then(res, rej) };
  return q;
}

function stop(overrides) {
  return {
    id: `svc-${Math.random().toString(36).slice(2, 8)}`, status: 'confirmed', service_type: 'Pest Control',
    window_start: '09:00:00', window_end: '11:00:00', is_recurring: true, visit_id: null,
    first_name: 'Pat', last_name: 'Lee', ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.__reset();
  db.__state.technicians[TECH.id] = TECH;
  dayStopsQuery.mockImplementation(() => fakeQuery([]));
  createAlert.mockImplementation(async ({ jobId }) => ({ id: `alert-${jobId}` }));
  resolveAlert.mockImplementation(async ({ id }) => ({ id, resolved_at: 'NOW()' }));
  getIo.mockReturnValue(null);
});

/** A fake socket.io server: `emit` calls are recorded per room. */
function fakeIo() {
  const emit = jest.fn();
  const io = { to: jest.fn(() => ({ emit })), emit };
  return io;
}

describe('REASONS / rankBumpOrder', () => {
  test('fixed vocabulary', () => {
    expect(REASONS).toEqual(['sick', 'emergency', 'no_show', 'other']);
  });

  test('bump-first: recurring before one-time, unconfirmed before confirmed, later window first on ties', () => {
    const rows = [
      stop({ id: 'one-time-confirmed', is_recurring: false, status: 'confirmed' }),
      stop({ id: 'recurring-confirmed', is_recurring: true, status: 'confirmed' }),
      stop({ id: 'recurring-pending-early', is_recurring: true, status: 'pending', window_start: '08:00:00' }),
      stop({ id: 'recurring-pending-late', is_recurring: true, status: 'pending', window_start: '14:00:00' }),
      stop({ id: 'one-time-pending', is_recurring: false, status: 'pending' }),
    ];
    expect(rankBumpOrder(rows).map((r) => r.id)).toEqual([
      'recurring-pending-late', 'recurring-pending-early', 'recurring-confirmed', 'one-time-pending', 'one-time-confirmed',
    ]);
    expect(rankBumpOrder(rows)[0].bump_reason).toMatch(/easiest to slide/);
  });

  test('a booster (parent set, is_recurring false) ranks as one-time; a series root (no parent, is_recurring true) as recurring', () => {
    const booster = stop({ id: 'booster', is_recurring: false, recurring_parent_id: 'p1', status: 'pending' });
    const root = stop({ id: 'root', is_recurring: true, recurring_parent_id: null, status: 'pending' });
    expect(rankBumpOrder([booster, root]).map((r) => r.id)).toEqual(['root', 'booster']);
  });

  test('does not mutate its input', () => {
    const rows = [stop({ id: 'a' })];
    rankBumpOrder(rows);
    expect(rows[0].bump_reason).toBeUndefined();
  });
});

describe('unitsOf', () => {
  test('a grouped visit is one unit represented by its first (earliest) member; ungrouped rows are their own unit', () => {
    const rows = [
      stop({ id: 'a', visit_id: 'v1', window_start: '08:00:00' }),
      stop({ id: 'b', visit_id: null, window_start: '09:00:00' }),
      stop({ id: 'c', visit_id: 'v1', window_start: '10:00:00' }),
    ];
    const units = _test.unitsOf(rows);
    expect(units.map((u) => [u.representative.id, u.members.map((m) => m.id)])).toEqual([['a', ['a', 'c']], ['b', ['b']]]);
  });
});

describe('markTechOut', () => {
  test('validation: impossible date, past date, bad reason, long note, unknown tech', async () => {
    await expect(markTechOut({ technicianId: TECH.id, date: '2027-02-31', reason: 'sick', actorId: ACTOR }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
    await expect(markTechOut({ technicianId: TECH.id, date: etDateString(addETDays(new Date(), -1)), reason: 'sick', actorId: ACTOR }))
      .rejects.toMatchObject({ status: 409, code: 'PAST_DATE' });
    await expect(markTechOut({ technicianId: TECH.id, date: DATE, reason: 'hangover', actorId: ACTOR }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
    await expect(markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', note: 'x'.repeat(301), actorId: ACTOR }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
    await expect(markTechOut({ technicianId: '99999999-2222-4333-8444-555555555555', date: DATE, reason: 'sick', actorId: ACTOR }))
      .rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
    expect(createAlert).not.toHaveBeenCalled();
  });

  test('runs in ONE transaction under the tech-day fence ONLY (technician row read, never locked), absence insert, alerts on the trx, summary persisted', async () => {
    const early = stop({ id: 'early', window_start: '08:00:00', is_recurring: true, status: 'pending' });
    const late = stop({ id: 'late', window_start: '13:00:00', is_recurring: false, status: 'confirmed', first_name: 'Sam', last_name: 'Ortiz' });
    dayStopsQuery.mockImplementation(() => fakeQuery([early, late]));

    const { absence, summary } = await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', note: 'flu', actorId: ACTOR });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    const trx = db.__lastTrx;
    const techRead = trx.__chains.find((x) => x.table === 'technicians').c;
    // The technician row is read, NEVER locked: a FOR UPDATE here is one
    // half of a lock-order cycle with every writer's FOR SHARE taken outside
    // its fence (auditor rounds on #4678); the fence is the only lock and
    // the sweep covers a check that ran outside it.
    expect(techRead.forUpdate).not.toHaveBeenCalled();
    expect(lockTechDays).toHaveBeenCalledWith(trx, [{ techId: TECH.id, date: DATE }]);
    // Fence before the row read, same as every fence-first assignment writer.
    expect(lockTechDays.mock.invocationCallOrder[0]).toBeLessThan(techRead.first.mock.invocationCallOrder[0]);
    // dayStopsQuery ran on the transaction, scoped to the absent tech, on_site excluded / en_route kept.
    expect(dayStopsQuery).toHaveBeenCalledWith(trx, expect.objectContaining({
      dateStr: DATE, technicianId: TECH.id,
      excludeStatuses: ['cancelled', 'completed', 'skipped', 'rescheduled', 'no_show', 'on_site'],
    }));
    // Every alert rides the same trx, tech-scoped, job-scoped, warn severity.
    expect(createAlert).toHaveBeenCalledTimes(2);
    for (const [call] of createAlert.mock.calls) {
      expect(call).toMatchObject({ type: ALERT_TYPE, severity: 'warn', techId: TECH.id, trx });
    }
    // Reverse insertion: bump #2 (one-time confirmed = bump last) is created FIRST, bump #1 LAST.
    expect(createAlert.mock.calls.map(([c]) => [c.jobId, c.payload.bump_order])).toEqual([['late', 2], ['early', 1]]);
    expect(createAlert.mock.calls[1][0].payload).toMatchObject({
      date: DATE, reason: 'sick', absent_tech_name: 'Adam', customer_name: 'Pat L.', service_type: 'Pest Control',
      window_start: '08:00:00', window_end: '11:00:00', bump_order: 1, bump_total: 2,
    });
    expect(createAlert.mock.calls[1][0].payload.visit_member_ids).toBeUndefined();
    expect(summary).toEqual({
      total: 2, units: 2, moved: [], failed: [], status: 'complete',
      parked: [{ job_id: 'early', alert_id: 'alert-early', bump_order: 1 }, { job_id: 'late', alert_id: 'alert-late', bump_order: 2 }],
    });
    expect(absence).toMatchObject({ technician_id: TECH.id, absence_date: DATE, reason: 'sick', note: 'flu', created_by: ACTOR });
    expect(absence.redistribution).toEqual(summary);
  });

  test('a grouped visit is parked as ONE alert on its representative with visit_member_ids; parked lists every member', async () => {
    const a = stop({ id: 'a', visit_id: 'v1', window_start: '08:00:00' });
    const c = stop({ id: 'c', visit_id: 'v1', window_start: '08:00:00', service_type: 'Lawn' });
    const b = stop({ id: 'b', window_start: '10:00:00' });
    dayStopsQuery.mockImplementation(() => fakeQuery([a, c, b]));

    const { summary } = await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'emergency', actorId: ACTOR });

    expect(createAlert).toHaveBeenCalledTimes(2);
    const unitCall = createAlert.mock.calls.find(([x]) => x.jobId === 'a')[0];
    expect(unitCall.payload.visit_member_ids).toEqual(['a', 'c']);
    expect(unitCall.payload.bump_total).toBe(2);
    expect(summary.total).toBe(3);
    expect(summary.units).toBe(2);
    expect(summary.parked).toEqual(expect.arrayContaining([
      { job_id: 'a', alert_id: 'alert-a', bump_order: expect.any(Number) },
      { job_id: 'c', alert_id: 'alert-a', bump_order: expect.any(Number) },
      { job_id: 'b', alert_id: 'alert-b', bump_order: expect.any(Number) },
    ]));
  });

  test('an empty day still records the absence with an empty summary', async () => {
    const { summary } = await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'other', actorId: ACTOR });
    expect(summary).toEqual({ total: 0, units: 0, parked: [], moved: [], failed: [], status: 'complete' });
    expect(createAlert).not.toHaveBeenCalled();
  });

  test('a second mark for the same tech+date is ALREADY_OUT (unique index) and parks nothing', async () => {
    await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });
    createAlert.mockClear();
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'x' })]));
    await expect(markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR }))
      .rejects.toMatchObject({ status: 409, code: 'ALREADY_OUT' });
    expect(createAlert).not.toHaveBeenCalled();
  });

  test('an alert insert failure propagates out of the transaction (nothing is reported parked)', async () => {
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'x' })]));
    createAlert.mockRejectedValueOnce(new Error('alert insert boom'));
    await expect(markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR })).rejects.toThrow('alert insert boom');
  });
});

describe('uncommitted estimate holds are never parked (auditor P1)', () => {
  const hold = (overrides) => stop({ customer_id: null, reservation_expires_at: '2099-01-01T00:00:00Z', first_name: null, last_name: null, ...overrides });

  test('isUncommittedHold: no customer + a reservation expiry; a booked row or a customer-linked hold is a real stop', () => {
    expect(_test.isUncommittedHold(hold({ id: 'h' }))).toBe(true);
    expect(_test.isUncommittedHold(stop({ id: 's', customer_id: 'cust-1' }))).toBe(false);
    expect(_test.isUncommittedHold(stop({ id: 'c', customer_id: 'cust-1', reservation_expires_at: '2099-01-01T00:00:00Z' }))).toBe(false);
    expect(_test.isUncommittedHold(stop({ id: 'n', customer_id: null, reservation_expires_at: null }))).toBe(false);
  });

  test('markTechOut skips a hold on the day: only the booked stop is parked and the summary counts only it', async () => {
    dayStopsQuery.mockImplementation(() => fakeQuery([hold({ id: 'hold-1', window_start: '08:00:00' }), stop({ id: 'booked', customer_id: 'cust-1' })]));
    const { summary } = await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });
    expect(createAlert).toHaveBeenCalledTimes(1);
    expect(createAlert.mock.calls[0][0].jobId).toBe('booked');
    expect(summary).toMatchObject({ total: 1, units: 1 });
    expect(summary.parked.map((p) => p.job_id)).toEqual(['booked']);
    // The read asks for the two columns the predicate needs.
    expect(dayStopsQuery.mock.calls[0][1].select).toEqual(expect.arrayContaining([
      'scheduled_services.customer_id', 'scheduled_services.reservation_expires_at',
    ]));
  });

  test('the sweep skips a hold too: a hold that landed on the absent day parks nothing', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    try {
      db.__state.absences['absence-1'] = {
        id: 'absence-1', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null,
      };
      dayStopsQuery.mockImplementation(() => fakeQuery([hold({ id: 'hold-late' })]));
      const result = await sweepAbsentTechDays();
      expect(result).toEqual({ absences: 1, parked: 0, failed: 0 });
      expect(createAlert).not.toHaveBeenCalled();
    } finally {
      delete process.env.GATE_TECH_OUT_REDISTRIBUTE;
    }
  });
});

describe('parkTechDay', () => {
  test('passes a plain connection through and returns the summary shape', async () => {
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'only' })]));
    const summary = await parkTechDay(db, { technicianId: TECH.id, date: DATE, reason: 'sick', absentTechName: 'Adam' });
    expect(summary).toMatchObject({ total: 1, units: 1, status: 'complete', parked: [{ job_id: 'only', alert_id: 'alert-only', bump_order: 1 }] });
    expect(createAlert.mock.calls[0][0].trx).toBe(db);
  });
});

describe('getTechOut / clearTechOut', () => {
  test('getTechOut returns the uncleared row or null', async () => {
    expect(await getTechOut({ technicianId: TECH.id, date: DATE })).toBeNull();
    await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });
    expect(await getTechOut({ technicianId: TECH.id, date: DATE })).toMatchObject({ technician_id: TECH.id, absence_date: DATE });
  });

  // Codex r8 P2 on #4678: the drawer's parked count must reflect a
  // dispatcher (or an auto-move run) resolving cards by hand, not just the
  // frozen mark-out snapshot — parked_open_count is read fresh every call.
  test('parked_open_count is a live read of OPEN overflow alerts, one stop per visit_member_ids entry (or 1 for an ungrouped card)', async () => {
    await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });
    db.__state.alerts.push(
      { id: 'a1', type: ALERT_TYPE, tech_id: TECH.id, resolved_at: null, payload: { date: DATE } },
      { id: 'a2', type: ALERT_TYPE, tech_id: TECH.id, resolved_at: null, payload: { date: DATE, visit_member_ids: ['m1', 'm2'] } },
      // Resolved already — never counted.
      { id: 'a3', type: ALERT_TYPE, tech_id: TECH.id, resolved_at: 'now', payload: { date: DATE } },
      // A different date's card for the same tech — never counted.
      { id: 'a4', type: ALERT_TYPE, tech_id: TECH.id, resolved_at: null, payload: { date: '2099-01-01' } },
    );
    expect((await getTechOut({ technicianId: TECH.id, date: DATE })).parked_open_count).toBe(3);

    db.__state.alerts.find((a) => a.id === 'a1').resolved_at = 'now';
    expect((await getTechOut({ technicianId: TECH.id, date: DATE })).parked_open_count).toBe(2);
  });

  test('clearTechOut locks the row, stamps cleared_at/by, and resolves that day\'s open overflow alerts on the same trx (auto: true)', async () => {
    await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });
    db.__state.alerts.push(
      { id: 'alert-1', type: ALERT_TYPE, tech_id: TECH.id, resolved_at: null },
      { id: 'alert-2', type: ALERT_TYPE, tech_id: TECH.id, resolved_at: null },
      { id: 'alert-old', type: ALERT_TYPE, tech_id: TECH.id, resolved_at: 'earlier' },
      { id: 'alert-other', type: 'tech_late', tech_id: TECH.id, resolved_at: null },
    );
    db.transaction.mockClear();

    const { absence, resolvedAlerts } = await clearTechOut({ technicianId: TECH.id, date: DATE, actorId: ACTOR });

    expect(db.transaction).toHaveBeenCalledTimes(1);
    const trx = db.__lastTrx;
    const lockedRead = trx.__chains.find((x) => x.table === 'technician_absences').c;
    expect(lockedRead.forUpdate).toHaveBeenCalled();
    // Fence before the row lock — the same order markTechOut and the sweep use.
    expect(lockTechDays).toHaveBeenCalledWith(trx, [{ techId: TECH.id, date: DATE }]);
    expect(lockTechDays.mock.invocationCallOrder[0]).toBeLessThan(lockedRead.forUpdate.mock.invocationCallOrder[0]);
    expect(absence).toMatchObject({ cleared_at: 'NOW()', cleared_by: ACTOR });
    expect(resolveAlert).toHaveBeenCalledTimes(2);
    expect(resolveAlert).toHaveBeenCalledWith({ id: 'alert-1', resolvedBy: ACTOR, trx, auto: true });
    expect(resolveAlert).toHaveBeenCalledWith({ id: 'alert-2', resolvedBy: ACTOR, trx, auto: true });
    expect(resolvedAlerts.map((r) => r.id)).toEqual(['alert-1', 'alert-2']);
    // The absence is cleared: a fresh mark works again (partial unique index).
    expect(await getTechOut({ technicianId: TECH.id, date: DATE })).toBeNull();
    await expect(markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR })).resolves.toBeTruthy();
  });

  test('clearTechOut on a tech who is not out is NOT_OUT', async () => {
    await expect(clearTechOut({ technicianId: TECH.id, date: DATE, actorId: ACTOR })).rejects.toMatchObject({ status: 404, code: 'NOT_OUT' });
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  test('a resolveAlert failure rejects out of the transaction (the clear does not commit on its own)', async () => {
    await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });
    db.__state.alerts.push({ id: 'alert-1', type: ALERT_TYPE, tech_id: TECH.id, resolved_at: null });
    resolveAlert.mockRejectedValueOnce(new Error('resolve boom'));
    await expect(clearTechOut({ technicianId: TECH.id, date: DATE, actorId: ACTOR })).rejects.toThrow('resolve boom');
  });
});

describe('absence broadcast (pre-push auditor P1 on #4678: other open boards)', () => {
  test('markTechOut emits dispatch:tech_absence {out: true} to dispatch:admins AFTER the transaction commits', async () => {
    const io = fakeIo();
    getIo.mockReturnValue(io);
    db.transaction.mockClear();

    const { absence } = await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });

    expect(io.to).toHaveBeenCalledWith('dispatch:admins');
    expect(io.emit).toHaveBeenCalledTimes(1);
    expect(io.emit).toHaveBeenCalledWith(ABSENCE_EVENT, { tech_id: TECH.id, date: DATE, out: true, absence_id: absence.id });
    // After commit: io is looked up only once the transaction has resolved.
    expect(getIo.mock.invocationCallOrder[0]).toBeGreaterThan(db.transaction.mock.invocationCallOrder[0]);
  });

  test('clearTechOut emits dispatch:tech_absence {out: false} for the cleared absence', async () => {
    const { absence } = await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });
    const io = fakeIo();
    getIo.mockReturnValue(io);

    await clearTechOut({ technicianId: TECH.id, date: DATE, actorId: ACTOR });

    expect(io.to).toHaveBeenCalledWith('dispatch:admins');
    expect(io.emit).toHaveBeenCalledTimes(1);
    expect(io.emit).toHaveBeenCalledWith(ABSENCE_EVENT, { tech_id: TECH.id, date: DATE, out: false, absence_id: absence.id });
  });

  test('a mark that fails (ALREADY_OUT) and a clear that fails (NOT_OUT) broadcast nothing', async () => {
    const io = fakeIo();
    getIo.mockReturnValue(io);
    await expect(clearTechOut({ technicianId: TECH.id, date: DATE, actorId: ACTOR })).rejects.toMatchObject({ code: 'NOT_OUT' });
    await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });
    io.emit.mockClear();
    await expect(markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR })).rejects.toMatchObject({ code: 'ALREADY_OUT' });
    expect(io.emit).not.toHaveBeenCalled();
  });

  test('io not initialized: the mutation still succeeds and the skip is logged, not thrown', async () => {
    getIo.mockReturnValue(null);
    await expect(markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR })).resolves.toBeTruthy();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('skipping absence broadcast'));
  });
});

describe('slot-offer cache + grouped ranking (Codex r6)', () => {
  test('mark-out and clear each drop the public estimate slot cache after commit; a failed mark drops nothing', async () => {
    await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });
    expect(invalidateAllEstimates).toHaveBeenCalledTimes(1);
    expect(invalidateAllEstimates.mock.invocationCallOrder[0]).toBeGreaterThan(db.transaction.mock.invocationCallOrder[0]);
    await expect(markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR })).rejects.toMatchObject({ code: 'ALREADY_OUT' });
    expect(invalidateAllEstimates).toHaveBeenCalledTimes(1);
    await clearTechOut({ technicianId: TECH.id, date: DATE, actorId: ACTOR });
    expect(invalidateAllEstimates).toHaveBeenCalledTimes(2);
  });

  test('a grouped unit is ranked by its most protected member: a confirmed one-time sibling makes the unit "bump last"', async () => {
    dayStopsQuery.mockImplementation(() => fakeQuery([
      stop({ id: 'solo-pending', is_recurring: true, status: 'pending', window_start: '13:00:00' }),
      // Representative (earliest) is a pending routine stop …
      stop({ id: 'grp-rep', visit_id: 'v1', is_recurring: true, status: 'pending', window_start: '08:00:00' }),
      // … but its sibling is a confirmed one-time visit.
      stop({ id: 'grp-sib', visit_id: 'v1', is_recurring: false, status: 'confirmed', window_start: '08:30:00' }),
    ]));
    const { summary } = await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });
    const byJob = Object.fromEntries(summary.parked.map((p) => [p.job_id, p.bump_order]));
    expect(byJob).toEqual({ 'solo-pending': 1, 'grp-rep': 2, 'grp-sib': 2 });
    const unitCall = createAlert.mock.calls.map(([c]) => c).find((c) => c.jobId === 'grp-rep');
    expect(unitCall.payload.bump_reason).toMatch(/bump last/);
    expect(_test.unitRankingFields([{ is_recurring: true, status: 'pending' }, { is_recurring: true, status: 'pending' }]))
      .toEqual({ is_recurring: true, status: 'pending' });
  });
});

describe('post-commit side effects never fail the mutation (pre-push auditor P1)', () => {
  test('a throwing slot-cache invalidation or broadcast leaves markTechOut / clearTechOut resolved and logged', async () => {
    invalidateAllEstimates.mockImplementationOnce(() => { throw new Error('cache boom'); });
    const io = fakeIo();
    io.to.mockImplementation(() => { throw new Error('socket boom'); });
    getIo.mockReturnValue(io);
    const { absence } = await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });
    expect(absence.id).toBeTruthy();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cache boom'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('socket boom'));
    await expect(clearTechOut({ technicianId: TECH.id, date: DATE, actorId: ACTOR })).resolves.toBeTruthy();
  });
});

describe('sweepAbsentTechDays', () => {
  const TECH2 = { id: '22222222-3333-4444-8888-999999999999', name: 'Sam' };

  beforeEach(() => {
    db.__state.technicians[TECH2.id] = TECH2;
  });

  afterEach(() => {
    delete process.env.GATE_TECH_OUT_REDISTRIBUTE;
  });

  test('gate off is a fast no-op — no queries at all', async () => {
    delete process.env.GATE_TECH_OUT_REDISTRIBUTE;
    const result = await sweepAbsentTechDays();
    expect(result).toEqual({ skipped: 'gate_off' });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(dayStopsQuery).not.toHaveBeenCalled();
    expect(createAlert).not.toHaveBeenCalled();
  });

  test('an uncovered stop on an absent day is parked with late_arrival: true, and the fence is taken before the alert write', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-1'] = {
      id: 'absence-1', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null,
    };
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'uncovered' })]));

    const result = await sweepAbsentTechDays();

    expect(result).toEqual({ absences: 1, parked: 1, failed: 0 });
    expect(createAlert).toHaveBeenCalledTimes(1);
    expect(createAlert.mock.calls[0][0]).toMatchObject({
      type: ALERT_TYPE, severity: 'warn', techId: TECH.id, jobId: 'uncovered',
    });
    expect(createAlert.mock.calls[0][0].payload).toMatchObject({
      date: DATE, reason: 'sick', late_arrival: true, absent_tech_name: 'Adam',
    });
    expect(lockTechDays).toHaveBeenCalledWith(expect.anything(), [{ techId: TECH.id, date: DATE }]);
    expect(lockTechDays.mock.invocationCallOrder[0]).toBeLessThan(createAlert.mock.invocationCallOrder[0]);
  });

  test('a swept late arrival is folded into the absence\'s stored redistribution on the same trx (Codex r7 P2)', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'orig' })]));
    const { absence } = await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });
    expect(absence.redistribution).toMatchObject({ total: 1, units: 1 });
    db.__state.alerts.push({ id: 'alert-orig', type: ALERT_TYPE, tech_id: TECH.id, job_id: 'orig', resolved_at: null, payload: { date: DATE, absence_id: absence.id } });
    createAlert.mockClear();
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'orig' }), stop({ id: 'late-1' })]));

    const result = await sweepAbsentTechDays();

    expect(result).toEqual({ absences: 1, parked: 1, failed: 0 });
    const stored = db.__state.absences[absence.id].redistribution;
    expect(stored).toMatchObject({ total: 2, units: 2 });
    expect(stored.parked.map((p) => p.job_id)).toEqual(['orig', 'late-1']);
    // Written on the sweep's transaction, not a plain connection.
    const trx = db.__lastTrx;
    expect(trx.__chains.some((x) => x.table === 'technician_absences' && x.c.update.mock.calls.length > 0)).toBe(true);
  });

  test('one failing absence is logged and skipped; the others are still swept this tick (pre-push auditor P1)', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-bad'] = { id: 'absence-bad', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null };
    db.__state.absences['absence-ok'] = { id: 'absence-ok', technician_id: TECH2.id, absence_date: DATE, reason: 'sick', cleared_at: null };
    dayStopsQuery.mockImplementation((_trx, { technicianId }) => {
      if (technicianId === TECH.id) throw new Error('stops boom');
      return fakeQuery([stop({ id: 'ok-stop' })]);
    });

    const result = await sweepAbsentTechDays();

    expect(result).toEqual({ absences: 2, parked: 1, failed: 1 });
    expect(createAlert).toHaveBeenCalledTimes(1);
    expect(createAlert.mock.calls[0][0]).toMatchObject({ techId: TECH2.id, jobId: 'ok-stop' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('absence-bad'));
  });

  test('an absence cleared while the sweep waited on the fence parks nothing (re-read under the fence)', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-1'] = {
      id: 'absence-1', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null,
    };
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'would-park' })]));
    // "Tech is back" commits while this sweep is blocked on the tech-day fence.
    lockTechDays.mockImplementationOnce(async () => { db.__state.absences['absence-1'].cleared_at = 'NOW()'; return ['k']; });

    const result = await sweepAbsentTechDays();

    expect(result).toEqual({ absences: 1, parked: 0, failed: 0 });
    expect(dayStopsQuery).not.toHaveBeenCalled();
    expect(createAlert).not.toHaveBeenCalled();
  });

  test('a stop already covered by an open alert on job_id is not re-parked', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-1'] = {
      id: 'absence-1', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null,
    };
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'covered' })]));
    db.__state.alerts.push({
      id: 'alert-x', type: ALERT_TYPE, tech_id: TECH.id, job_id: 'covered', resolved_at: null, payload: { date: DATE },
    });

    const result = await sweepAbsentTechDays();

    expect(result).toEqual({ absences: 1, parked: 0, failed: 0 });
    expect(createAlert).not.toHaveBeenCalled();
  });

  test('a card a dispatcher dismissed BY HAND for this absence stays dismissed: not re-parked (auditor P1)', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-1'] = {
      id: 'absence-1', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null,
    };
    // Resolved by a person: no superseded_at stamp (resolveAlert auto:false).
    db.__state.alerts.push({
      id: 'alert-dismissed', type: ALERT_TYPE, tech_id: TECH.id, job_id: 'still-there', resolved_at: 'earlier',
      payload: { date: DATE, absence_id: 'absence-1' },
    });
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'still-there' })]));

    const result = await sweepAbsentTechDays();

    expect(result).toEqual({ absences: 1, parked: 0, failed: 0 });
    expect(createAlert).not.toHaveBeenCalled();
  });

  test('a dismissed GROUPED card covers only the row it opened: siblings still on the absent tech are parked again as their own unit (Codex r5 P1)', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-1'] = {
      id: 'absence-1', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null,
    };
    db.__state.alerts.push({
      id: 'alert-group', type: ALERT_TYPE, tech_id: TECH.id, job_id: 'rep', resolved_at: 'earlier',
      payload: { date: DATE, absence_id: 'absence-1', visit_member_ids: ['rep', 'sib-1', 'sib-2'] },
    });
    // The representative was reassigned away (detached); the siblings remain.
    dayStopsQuery.mockImplementation(() => fakeQuery([
      stop({ id: 'sib-1', visit_id: 'v1' }), stop({ id: 'sib-2', visit_id: 'v1' }),
    ]));

    const result = await sweepAbsentTechDays();

    expect(result).toEqual({ absences: 1, parked: 2, failed: 0 });
    expect(createAlert).toHaveBeenCalledTimes(1);
    expect(createAlert.mock.calls[0][0]).toMatchObject({ jobId: 'sib-1' });
    expect(createAlert.mock.calls[0][0].payload.visit_member_ids).toEqual(['sib-1', 'sib-2']);
  });

  test('a SYSTEM auto-resolve (payload.superseded_at) does not cover — the stop is parked afresh', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-1'] = {
      id: 'absence-1', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null,
    };
    db.__state.alerts.push({
      id: 'alert-auto', type: ALERT_TYPE, tech_id: TECH.id, job_id: 'back-again', resolved_at: 'earlier',
      payload: { date: DATE, absence_id: 'absence-1', superseded_at: 'earlier' },
    });
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'back-again' })]));

    const result = await sweepAbsentTechDays();

    expect(result).toEqual({ absences: 1, parked: 1, failed: 0 });
    expect(createAlert).toHaveBeenCalledTimes(1);
    expect(createAlert.mock.calls[0][0].payload).toMatchObject({ absence_id: 'absence-1', late_arrival: true });
  });

  test('a manual dismissal from a PREVIOUS absence (tech back, then out again) does not cover the new absence', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-2'] = {
      id: 'absence-2', technician_id: TECH.id, absence_date: DATE, reason: 'emergency', cleared_at: null,
    };
    db.__state.alerts.push({
      id: 'alert-old-dismissed', type: ALERT_TYPE, tech_id: TECH.id, job_id: 'stop-x', resolved_at: 'earlier',
      payload: { date: DATE, absence_id: 'absence-1' },
    });
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'stop-x' })]));

    const result = await sweepAbsentTechDays();

    expect(result).toEqual({ absences: 1, parked: 1, failed: 0 });
    expect(createAlert.mock.calls[0][0].payload).toMatchObject({ absence_id: 'absence-2' });
  });

  test('markTechOut stamps payload.absence_id on every alert it parks', async () => {
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'a' })]));
    const { absence } = await markTechOut({ technicianId: TECH.id, date: DATE, reason: 'sick', actorId: ACTOR });
    expect(createAlert).toHaveBeenCalledTimes(1);
    expect(createAlert.mock.calls[0][0].payload).toMatchObject({ absence_id: absence.id, date: DATE });
  });

  test('a stop covered only via an open alert\'s visit_member_ids (grouped visit) is not re-parked', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-1'] = {
      id: 'absence-1', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null,
    };
    // The card's own stop (member-a) is still open on the absent day, so the
    // card stands and keeps covering its sibling.
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'member-a', visit_id: 'v1' }), stop({ id: 'member-b', visit_id: 'v1' })]));
    db.__state.alerts.push({
      id: 'alert-x',
      type: ALERT_TYPE,
      tech_id: TECH.id,
      job_id: 'member-a',
      resolved_at: null,
      payload: { date: DATE, visit_member_ids: ['member-a', 'member-b'] },
    });

    const result = await sweepAbsentTechDays();

    expect(result).toEqual({ absences: 1, parked: 0, failed: 0 });
    expect(createAlert).not.toHaveBeenCalled();
    expect(resolveAlert).not.toHaveBeenCalled();
  });

  test('reconcile: an open card whose stop left the absent day is closed systemically, never left as a phantom', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-1'] = {
      id: 'absence-1', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null,
    };
    dayStopsQuery.mockImplementation(() => fakeQuery([]));
    db.__state.alerts.push({
      id: 'alert-gone', type: ALERT_TYPE, tech_id: TECH.id, job_id: 'reassigned-by-hand', resolved_at: null, payload: { date: DATE },
    });

    await sweepAbsentTechDays();

    expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: 'alert-gone', auto: true }));
    expect(createAlert).not.toHaveBeenCalled();
  });

  test('reconcile: a grouped card whose representative left is closed and its sibling still on the absent tech is re-parked as its own unit, same tick', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-1'] = {
      id: 'absence-1', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null,
    };
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'member-b', visit_id: 'v1' })]));
    db.__state.alerts.push({
      id: 'alert-x', type: ALERT_TYPE, tech_id: TECH.id, job_id: 'member-a', resolved_at: null,
      payload: { date: DATE, visit_member_ids: ['member-a', 'member-b'] },
    });

    const result = await sweepAbsentTechDays();

    expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: 'alert-x', auto: true }));
    expect(result).toEqual({ absences: 1, parked: 1, failed: 0 });
    expect(createAlert.mock.calls[0][0]).toMatchObject({ jobId: 'member-b' });
  });

  test('an alert open on a DIFFERENT date does not cover a same-id stop (payload->>date scoping)', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-1'] = {
      id: 'absence-1', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null,
    };
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'x' })]));
    db.__state.alerts.push({
      id: 'alert-other-date',
      type: ALERT_TYPE,
      tech_id: TECH.id,
      job_id: 'x',
      resolved_at: null,
      payload: { date: etDateString(addETDays(new Date(), 9)) },
    });

    const result = await sweepAbsentTechDays();

    expect(result).toEqual({ absences: 1, parked: 1, failed: 0 });
    expect(createAlert).toHaveBeenCalledTimes(1);
  });

  test('a second run parks nothing — idempotent once the first run\'s alert is committed', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-1'] = {
      id: 'absence-1', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null,
    };
    dayStopsQuery.mockImplementation(() => fakeQuery([stop({ id: 'x' })]));

    const first = await sweepAbsentTechDays();
    expect(first).toEqual({ absences: 1, parked: 1, failed: 0 });

    // createAlert is mocked and does not itself write into state.alerts —
    // simulate the committed row its real insert would have left behind.
    const [call] = createAlert.mock.calls[0];
    db.__state.alerts.push({
      id: `alert-${call.jobId}`, type: call.type, tech_id: call.techId, job_id: call.jobId, resolved_at: null, payload: call.payload,
    });
    createAlert.mockClear();

    const second = await sweepAbsentTechDays();
    expect(second).toEqual({ absences: 1, parked: 0, failed: 0 });
    expect(createAlert).not.toHaveBeenCalled();
  });

  test('only uncleared absences dated today-or-later are swept; a cleared and a past absence are skipped entirely', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences.cleared = {
      id: 'cleared', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: 'earlier',
    };
    db.__state.absences.past = {
      id: 'past', technician_id: TECH2.id, absence_date: etDateString(addETDays(new Date(), -1)), reason: 'sick', cleared_at: null,
    };
    dayStopsQuery.mockImplementation(() => fakeQuery([]));

    const result = await sweepAbsentTechDays();

    expect(result).toEqual({ absences: 0, parked: 0, failed: 0 });
    expect(dayStopsQuery).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('an absent day with no open stops at all records zero parked without calling createAlert', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    db.__state.absences['absence-1'] = {
      id: 'absence-1', technician_id: TECH.id, absence_date: DATE, reason: 'sick', cleared_at: null,
    };
    dayStopsQuery.mockImplementation(() => fakeQuery([]));

    const result = await sweepAbsentTechDays();

    expect(result).toEqual({ absences: 1, parked: 0, failed: 0 });
    expect(createAlert).not.toHaveBeenCalled();
  });
});
