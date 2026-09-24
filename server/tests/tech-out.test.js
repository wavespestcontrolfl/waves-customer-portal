/**
 * services/tech-out.js — "tech out today" redistribution.
 *
 * Mocked heavily: dependent services (day-stops, technician-eligibility,
 * technician-capabilities, arrival-route, occupancy, geo, the rebooker,
 * dispatch-alerts) are replaced with small controllable fakes; db.js is a
 * lightweight in-memory table router covering exactly the query shapes
 * tech-out.js issues directly (technicians, technician_absences,
 * scheduled_services overlap probe, tech_schedule_blocks, dispatch_alerts).
 * No real Postgres.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// Everything the fake db needs (state + chain builders) is declared INSIDE
// the factory: a jest.mock() factory may not reference out-of-scope
// variables (babel-plugin-jest-hoist), so `state` is exposed back to the
// test body via `db.__state` / `db.__reset` after require().
jest.mock('../models/db', () => {
  const state = {
    technicians: {},
    absences: {},
    overlapsByTech: {},
    neighborsByTech: {},
    scheduleBlocksByTech: {},
    absentStops: [],
    dispatchAlerts: [],
  };

  function resetState() {
    state.technicians = {};
    state.absences = {};
    state.overlapsByTech = {};
    state.neighborsByTech = {};
    state.scheduleBlocksByTech = {};
    state.absentStops = [];
    state.dispatchAlerts = [];
  }

  function techniciansChain() {
    const c = {};
    c.where = jest.fn((cond) => { c._cond = cond; return c; });
    c.first = jest.fn(async () => (c._cond && c._cond.id ? state.technicians[c._cond.id] : undefined));
    return c;
  }

  function absencesChain() {
    const c = {};
    let cond = null;
    let insertRow = null;
    let updatePatch = null;
    c.where = jest.fn((w) => { cond = { ...(cond || {}), ...w }; return c; });
    c.whereNull = jest.fn(() => { cond = { ...(cond || {}), __clearedNull: true }; return c; });
    c.first = jest.fn(async () => Object.values(state.absences).find((r) => {
      if (cond?.technician_id && r.technician_id !== cond.technician_id) return false;
      if (cond?.absence_date && r.absence_date !== cond.absence_date) return false;
      if (cond?.id && r.id !== cond.id) return false;
      if (cond?.__clearedNull && r.cleared_at) return false;
      return true;
    }));
    c.insert = jest.fn((row) => { insertRow = row; return c; });
    c.update = jest.fn((patch) => { updatePatch = patch; return c; });
    c.returning = jest.fn(async () => {
      if (insertRow) {
        const dup = Object.values(state.absences).find((r) => r.technician_id === insertRow.technician_id
          && r.absence_date === insertRow.absence_date && !r.cleared_at);
        if (dup) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
        const id = `absence-${Object.keys(state.absences).length + 1}`;
        const row = { id, cleared_at: null, cleared_by: null, redistribution: null, ...insertRow };
        state.absences[id] = row;
        return [row];
      }
      if (updatePatch) {
        const row = Object.values(state.absences).find((r) => r.id === cond?.id);
        if (row) {
          // Real Postgres auto-parses a jsonb column back to an object on
          // read; the production writer always JSON.stringifies before
          // writing, so mirror that round-trip here instead of storing the
          // raw string (a later read — e.g. the ALREADY_OUT resume check
          // reading .redistribution.status — must see an object).
          const patch = { ...updatePatch };
          if (typeof patch.redistribution === 'string') {
            try { patch.redistribution = JSON.parse(patch.redistribution); } catch { /* leave as-is */ }
          }
          Object.assign(row, patch);
        }
        return row ? [row] : [];
      }
      return [];
    });
    return c;
  }

  function scheduledServicesChain() {
    const c = {};
    let techId = null;
    c.where = jest.fn((w) => { techId = w.technician_id; return c; });
    c.whereNot = jest.fn(() => c);
    c.whereNotIn = jest.fn(() => c);
    c.select = jest.fn(() => c);
    c.then = (res, rej) => Promise.resolve(state.overlapsByTech[techId] || []).then(res, rej);
    return c;
  }

  function techScheduleBlocksChain() {
    const c = {};
    let techId = null;
    const sub = {
      where: jest.fn((col, val) => { if (col === 'technician_id') techId = val; return sub; }),
      orWhereNull: jest.fn(() => sub),
    };
    c.where = jest.fn((arg) => { if (typeof arg === 'function') arg(sub); return c; });
    c.whereNot = jest.fn(() => c);
    c.select = jest.fn(() => c);
    c.then = (res, rej) => Promise.resolve(state.scheduleBlocksByTech[techId] || []).then(res, rej);
    return c;
  }

  function dispatchAlertsChain() {
    const c = {};
    let filters = {};
    let cols = ['id'];
    c.where = jest.fn((w) => { filters = { ...filters, ...w }; return c; });
    c.whereNull = jest.fn(() => c);
    c.whereRaw = jest.fn(() => c);
    c.select = jest.fn((...columns) => { cols = columns.length ? columns : ['id']; return c; });
    c.then = (res, rej) => Promise.resolve(
      state.dispatchAlerts
        .filter((a) => (filters.type === undefined || a.type === filters.type)
          && (filters.tech_id === undefined || a.tech_id === filters.tech_id)
          && !a.resolved_at)
        .map((a) => Object.fromEntries(cols.map((k) => [k, a[k]]))),
    ).then(res, rej);
    return c;
  }

  const fn = jest.fn((table) => {
    if (table === 'technicians') return techniciansChain();
    if (table === 'technician_absences') return absencesChain();
    if (table === 'scheduled_services') return scheduledServicesChain();
    if (table === 'tech_schedule_blocks') return techScheduleBlocksChain();
    if (table === 'dispatch_alerts') return dispatchAlertsChain();
    throw new Error(`fake db: unexpected table ${table}`);
  });
  fn.fn = { now: jest.fn(() => 'NOW()') };
  fn.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  fn.__state = state;
  fn.__reset = resetState;
  return fn;
});

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

function fakeQuery(rows) {
  const obj = {
    orderBy: () => obj,
    then: (res, rej) => Promise.resolve(rows).then(res, rej),
    catch: (rej) => Promise.resolve(rows).catch(rej),
  };
  return obj;
}

jest.mock('../services/scheduling/day-stops', () => ({
  dayStopsQuery: jest.fn(),
  guardedCoordSelects: jest.fn(() => []),
}));

jest.mock('../services/technician-eligibility', () => ({
  applyAssignable: jest.fn(),
}));

jest.mock('../services/technician-capabilities', () => ({
  inactiveCapabilitiesForServices: jest.fn(),
}));

jest.mock('../services/scheduling/arrival-route', () => ({
  arrivalWindowRoutingEnabled: jest.fn(() => false),
  checkArrivalPlacement: jest.fn(),
}));

jest.mock('../services/scheduling/occupancy', () => ({
  windowsOverlap: (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart,
  DEFAULT_EXCLUDE_STATUSES: ['cancelled', 'skipped', 'no_show', 'rescheduled'],
}));

jest.mock('../services/auto-dispatch/geo', () => ({
  driveMin: jest.fn(() => 0),
  resolveGeo: jest.fn(() => null),
  HQ: { lat: 27.5, lng: -82.5 },
}));

jest.mock('../services/rebooker', () => ({
  reschedule: jest.fn(),
}));

jest.mock('../services/dispatch-alerts', () => ({
  createAlert: jest.fn(),
  resolveAlert: jest.fn(),
}));

const db = require('../models/db');
const { dayStopsQuery } = require('../services/scheduling/day-stops');
const { applyAssignable } = require('../services/technician-eligibility');
const { inactiveCapabilitiesForServices } = require('../services/technician-capabilities');
const { arrivalWindowRoutingEnabled, checkArrivalPlacement } = require('../services/scheduling/arrival-route');
const SmartRebooker = require('../services/rebooker');
const { createAlert, resolveAlert } = require('../services/dispatch-alerts');
const { addETDays, etDateString } = require('../utils/datetime-et');

const {
  REASONS, techOutEnabled, markTechOut, clearTechOut, redistributeTechDay, rankBumpOrder,
} = require('../services/tech-out');

// The fake db's state lives inside its jest.mock() factory closure; it is
// exposed back here as plain properties on the mocked module.
const state = db.__state;
const resetState = db.__reset;

const ABSENT_TECH = 'tech-absent';
const CANDIDATE = { id: 'tech-b', name: 'Beth' };
// Computed relative to today — a hardcoded literal eventually falls behind
// the not-in-the-past guard in markTechOut (codex #4678 r1 finding I).
const DATE = etDateString(addETDays(new Date(), 2));

beforeEach(() => {
  jest.clearAllMocks();
  resetState();
  state.technicians[ABSENT_TECH] = { id: ABSENT_TECH, name: 'Adam' };

  dayStopsQuery.mockImplementation((_db, opts) => {
    if (opts.technicianId === ABSENT_TECH) return fakeQuery(state.absentStops);
    return fakeQuery(state.neighborsByTech[opts.technicianId] || []);
  });
  applyAssignable.mockImplementation(() => {
    const c = {};
    c.whereNot = jest.fn(() => c);
    c.whereNotExists = jest.fn(() => c);
    c.select = jest.fn(() => c);
    c.then = (res, rej) => Promise.resolve(state.crew || []).then(res, rej);
    return c;
  });
  inactiveCapabilitiesForServices.mockResolvedValue([]);
  createAlert.mockImplementation(async ({ jobId }) => ({ id: `alert-${jobId}` }));
  // jest.clearAllMocks() clears call history but NOT a mockReturnValue/
  // mockResolvedValue a prior test set — re-pin the module's real default
  // (arrival routing off) so one test's override can never leak into the
  // next.
  arrivalWindowRoutingEnabled.mockReturnValue(false);
  checkArrivalPlacement.mockReset();
});

describe('REASONS', () => {
  test('is the fixed vocabulary', () => {
    expect(REASONS).toEqual(['sick', 'emergency', 'no_show', 'other']);
  });
});

describe('techOutEnabled', () => {
  test('reads the gate at call time', () => {
    delete process.env.GATE_TECH_OUT_REDISTRIBUTE;
    expect(techOutEnabled()).toBe(false);
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    expect(techOutEnabled()).toBe(true);
    delete process.env.GATE_TECH_OUT_REDISTRIBUTE;
  });
});

describe('rankBumpOrder', () => {
  test('recurring-unconfirmed bumps first, one-time-confirmed bumps last', () => {
    const stops = [
      { id: 'a', status: 'confirmed', window_start: '09:00' }, // one-time, confirmed => 70
      { id: 'b', recurring_parent_id: 'p1', status: 'pending', window_start: '10:00' }, // recurring, unconfirmed => 0
      { id: 'c', recurring_parent_id: 'p2', status: 'confirmed', window_start: '11:00' }, // recurring, confirmed => 20
      { id: 'd', status: 'pending', window_start: '12:00' }, // one-time, unconfirmed => 50
    ];
    const ranked = rankBumpOrder(stops);
    expect(ranked.map((s) => s.id)).toEqual(['b', 'c', 'd', 'a']);
    expect(ranked[0].bump_reason).toMatch(/easiest to slide/);
    expect(ranked[3].bump_reason).toMatch(/bump last/);
  });

  test('ties break on later window_start first', () => {
    const stops = [
      { id: 'early', status: 'pending', window_start: '08:00' },
      { id: 'late', status: 'pending', window_start: '15:00' },
    ];
    expect(rankBumpOrder(stops).map((s) => s.id)).toEqual(['late', 'early']);
  });

  test('is pure — does not mutate its input', () => {
    const stop = { id: 'a', status: 'pending', window_start: '09:00' };
    rankBumpOrder([stop]);
    expect(stop.bump_reason).toBeUndefined();
  });
});

const STOP = {
  id: 'stop-1', customer_id: 'cust-1', status: 'confirmed', service_type: 'general_pest',
  window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60,
  recurring_parent_id: null, lat: null, lng: null, first_name: 'Sam', last_name: 'Jones',
};

describe('redistributeTechDay', () => {
  test('a fitting stop moves through the canonical rebooker (SmartRebooker.reschedule) with expect pinned', async () => {
    state.absentStops = [{ ...STOP }];
    state.crew = [CANDIDATE];
    state.overlapsByTech[CANDIDATE.id] = [];
    SmartRebooker.reschedule.mockResolvedValue({ success: true });

    const summary = await redistributeTechDay({ technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1' });

    expect(SmartRebooker.reschedule).toHaveBeenCalledWith(
      STOP.id, DATE, { start: STOP.window_start, end: STOP.window_end }, 'tech_out', 'system',
      {
        technicianId: CANDIDATE.id,
        keepStatus: true,
        allowLive: true,
        expect: { technician_id: ABSENT_TECH },
        suppressTechNotice: false,
      },
    );
    expect(summary.moved).toEqual([{ job_id: STOP.id, to_technician_id: CANDIDATE.id, to_technician_name: CANDIDATE.name, detour_minutes: null }]);
    expect(summary.parked).toEqual([]);
    expect(summary.failed).toEqual([]);
    expect(summary.status).toBe('complete');
    expect(createAlert).not.toHaveBeenCalled();
  });

  test('no fitting tech parks the stop as a ranked tech_out_overflow alert', async () => {
    state.absentStops = [{ ...STOP }];
    state.crew = [CANDIDATE];
    // The candidate already has an overlapping stop at the same window.
    state.overlapsByTech[CANDIDATE.id] = [{ window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60 }];

    const summary = await redistributeTechDay({ technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1' });

    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    expect(createAlert).toHaveBeenCalledTimes(1);
    const call = createAlert.mock.calls[0][0];
    expect(call).toMatchObject({ type: 'tech_out_overflow', severity: 'warn', techId: ABSENT_TECH, jobId: STOP.id });
    expect(call.payload).toMatchObject({ date: DATE, reason: 'sick', bump_order: 1, bump_total: 1, service_type: STOP.service_type });
    expect(call.payload.near_misses[0]).toMatchObject({ technician_id: CANDIDATE.id, conflict_reason: 'overlap' });
    expect(summary.parked).toEqual([{ job_id: STOP.id, alert_id: `alert-${STOP.id}`, bump_order: 1 }]);
  });

  test('a NULL window_end still covers the visit\'s real duration for the overlap probe (no false zero-length window)', async () => {
    // window_end is NULL; estimated_duration_minutes derives a 09:00-10:30 window.
    // The candidate has a stop starting at 09:30, squarely inside that derived
    // window — a zero-length-window bug would report no conflict at all.
    state.absentStops = [{ ...STOP, window_end: null, estimated_duration_minutes: 90 }];
    state.crew = [CANDIDATE];
    state.overlapsByTech[CANDIDATE.id] = [{ window_start: '09:30', window_end: '10:00', estimated_duration_minutes: 30 }];

    const summary = await redistributeTechDay({ technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1' });

    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    expect(summary.parked).toHaveLength(1);
    const call = createAlert.mock.calls[0][0];
    expect(call.payload.near_misses[0]).toMatchObject({ technician_id: CANDIDATE.id, conflict_reason: 'overlap' });
  });

  test('a tech deactivated for the stop\'s capability is skipped (capability_inactive)', async () => {
    state.absentStops = [{ ...STOP }];
    state.crew = [CANDIDATE];
    state.overlapsByTech[CANDIDATE.id] = []; // would otherwise fit
    inactiveCapabilitiesForServices.mockResolvedValue([{ technician_id: CANDIDATE.id, service_category: 'general', active: false }]);

    const summary = await redistributeTechDay({ technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1' });

    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    expect(summary.parked).toHaveLength(1);
    const call = createAlert.mock.calls[0][0];
    expect(call.payload.near_misses[0]).toMatchObject({ technician_id: CANDIDATE.id, conflict_reason: 'capability_inactive' });
  });

  test('a candidate\'s non-available tech_schedule_blocks entry refuses the plain-overlap fallback (schedule_block)', async () => {
    state.absentStops = [{ ...STOP }];
    state.crew = [CANDIDATE];
    state.overlapsByTech[CANDIDATE.id] = []; // no scheduled_services conflict
    state.scheduleBlocksByTech[CANDIDATE.id] = [{ start_time: '08:30', end_time: '09:30' }]; // overlaps 09:00-10:00

    const summary = await redistributeTechDay({ technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1' });

    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
    expect(summary.parked).toHaveLength(1);
    const call = createAlert.mock.calls[0][0];
    expect(call.payload.near_misses[0]).toMatchObject({ technician_id: CANDIDATE.id, conflict_reason: 'schedule_block' });
  });

  test('a non-overlapping tech_schedule_blocks entry does not block placement', async () => {
    state.absentStops = [{ ...STOP }];
    state.crew = [CANDIDATE];
    state.overlapsByTech[CANDIDATE.id] = [];
    state.scheduleBlocksByTech[CANDIDATE.id] = [{ start_time: '13:00', end_time: '14:00' }]; // no overlap with 09:00-10:00
    SmartRebooker.reschedule.mockResolvedValue({ success: true });

    const summary = await redistributeTechDay({ technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1' });

    expect(summary.moved).toHaveLength(1);
    expect(summary.parked).toEqual([]);
  });

  test('arrival-window routing pre-check treats the absent tech\'s own stop as pending, not active', async () => {
    arrivalWindowRoutingEnabled.mockReturnValue(true);
    checkArrivalPlacement.mockResolvedValue({ feasible: true });
    state.absentStops = [{ ...STOP }];
    state.crew = [CANDIDATE];
    SmartRebooker.reschedule.mockResolvedValue({ success: true });

    await redistributeTechDay({ technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1' });

    expect(checkArrivalPlacement).toHaveBeenCalledWith(expect.objectContaining({
      serviceId: STOP.id, technicianId: CANDIDATE.id, treatTargetAsPending: true,
    }));
  });

  test('en_route stops stay in the redistribution set; on_site is excluded from it', async () => {
    state.crew = [CANDIDATE];
    await redistributeTechDay({ technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1' });

    const call = dayStopsQuery.mock.calls.find(([, opts]) => opts.technicianId === ABSENT_TECH);
    expect(call).toBeTruthy();
    const [, opts] = call;
    expect(opts.excludeStatuses).toEqual(expect.arrayContaining(['on_site']));
    expect(opts.excludeStatuses).not.toEqual(expect.arrayContaining(['en_route']));
    expect(opts.select).toEqual(expect.arrayContaining(['scheduled_services.visit_id']));
  });

  test('a 409 (CAS/conflict) from SmartRebooker.reschedule is recorded as failed, not parked, and the loop continues', async () => {
    state.absentStops = [{ ...STOP }];
    state.crew = [CANDIDATE];
    state.overlapsByTech[CANDIDATE.id] = [];
    SmartRebooker.reschedule.mockRejectedValue(Object.assign(new Error('Job was reassigned concurrently'), { status: 409 }));

    const summary = await redistributeTechDay({ technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1' });

    expect(summary.failed).toEqual([{ job_id: STOP.id, error: 'Job was reassigned concurrently' }]);
    expect(summary.moved).toEqual([]);
    expect(createAlert).not.toHaveBeenCalled();
  });

  describe('near-miss ranking (finding G)', () => {
    // All four candidates fail the same overlap; resolveGeo mocked to null
    // (default) means detour_minutes is null for everyone here, so ranking
    // falls through to the stops_that_day tie-break — the ascending order
    // this test pins.
    const CONFLICT = [{ window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60 }];

    test('failures are ranked by fewer stops that day (detour null for all) and sliced to 3', async () => {
      state.absentStops = [{ ...STOP }];
      const techA = { id: 'tech-a', name: 'A' };
      const techB = { id: 'tech-b', name: 'B' };
      const techC = { id: 'tech-c', name: 'C' };
      const techD = { id: 'tech-d', name: 'D' };
      state.crew = [techA, techB, techC, techD];
      for (const t of state.crew) state.overlapsByTech[t.id] = CONFLICT;
      // stops_that_day = neighbors.length + 1
      state.neighborsByTech[techA.id] = [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }]; // 4
      state.neighborsByTech[techB.id] = [{ id: 'n4' }]; // 2
      state.neighborsByTech[techC.id] = []; // 1
      state.neighborsByTech[techD.id] = [{ id: 'n5' }, { id: 'n6' }]; // 3

      const summary = await redistributeTechDay({ technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1' });

      expect(summary.parked).toHaveLength(1);
      const call = createAlert.mock.calls[0][0];
      expect(call.payload.near_misses).toHaveLength(3);
      expect(call.payload.near_misses.map((n) => n.technician_id)).toEqual([techC.id, techB.id, techD.id]);
      expect(call.payload.near_misses.every((n) => n.detour_minutes === null)).toBe(true);
    });
  });

  describe('bump-first alert insertion order (finding F)', () => {
    test('alerts are created in REVERSE bump order (highest bump_order first) so bump #1 lands newest on top', async () => {
      // Both stops park (empty crew short-circuits placeStop trivially).
      state.absentStops = [
        { ...STOP, id: 'stop-recurring', recurring_parent_id: 'p1', status: 'pending', window_start: '09:00' }, // bump_score 0 -> bump_order 1
        { ...STOP, id: 'stop-confirmed', recurring_parent_id: null, status: 'confirmed', window_start: '11:00' }, // bump_score 70 -> bump_order 2
      ];
      state.crew = [];

      const summary = await redistributeTechDay({ technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1' });

      expect(createAlert).toHaveBeenCalledTimes(2);
      // Insertion (call) order: bump_order 2 (bump-last) created FIRST, then
      // bump_order 1 (bump-first) created LAST — so it is the newest row.
      expect(createAlert.mock.calls[0][0].payload.bump_order).toBe(2);
      expect(createAlert.mock.calls[0][0].jobId).toBe('stop-confirmed');
      expect(createAlert.mock.calls[1][0].payload.bump_order).toBe(1);
      expect(createAlert.mock.calls[1][0].jobId).toBe('stop-recurring');
      // The returned summary still lists parked stops in ascending bump order.
      expect(summary.parked.map((p) => p.bump_order)).toEqual([1, 2]);
      expect(summary.parked.map((p) => p.job_id)).toEqual(['stop-recurring', 'stop-confirmed']);
    });
  });

  describe('recoverable partial failure (finding E)', () => {
    test('a mid-run failure persists a partial summary on the absence row and rethrows', async () => {
      state.absences['abs-x'] = {
        id: 'abs-x', technician_id: ABSENT_TECH, absence_date: DATE, reason: 'sick', cleared_at: null, redistribution: null,
      };
      state.absentStops = [{ ...STOP }];
      state.crew = []; // parks trivially
      createAlert.mockRejectedValueOnce(new Error('alert insert boom'));

      await expect(redistributeTechDay({
        technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1', absenceId: 'abs-x',
      })).rejects.toThrow('alert insert boom');

      expect(state.absences['abs-x'].redistribution).toMatchObject({
        status: 'partial', error: 'alert insert boom', moved: [], parked: [], failed: [],
      });
    });

    test('with no absenceId, a mid-run failure still rethrows (nothing to persist)', async () => {
      state.absentStops = [{ ...STOP }];
      state.crew = [];
      createAlert.mockRejectedValueOnce(new Error('alert insert boom'));

      await expect(redistributeTechDay({
        technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1',
      })).rejects.toThrow('alert insert boom');
    });
  });
});

describe('markTechOut', () => {
  beforeEach(() => {
    state.technicians[ABSENT_TECH] = { id: ABSENT_TECH, name: 'Adam' };
    state.crew = [];
  });

  test('refuses a past date', async () => {
    await expect(markTechOut({
      technicianId: ABSENT_TECH, date: '2020-01-01', reason: 'sick', actorId: 'actor-1',
    })).rejects.toMatchObject({ status: 409, code: 'PAST_DATE' });
  });

  test('refuses an impossible calendar date (finding H)', async () => {
    await expect(markTechOut({
      technicianId: ABSENT_TECH, date: '2027-02-31', reason: 'sick', actorId: 'actor-1',
    })).rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
    expect(Object.keys(state.absences)).toHaveLength(0);
  });

  test('a duplicate mark for the same tech+date whose prior redistribution already completed is ALREADY_OUT (409)', async () => {
    state.absences['existing'] = {
      id: 'existing', technician_id: ABSENT_TECH, absence_date: DATE, reason: 'sick', cleared_at: null,
      redistribution: { total: 0, moved: [], parked: [], failed: [], status: 'complete' },
    };
    await expect(markTechOut({
      technicianId: ABSENT_TECH, date: DATE, reason: 'emergency', actorId: 'actor-1',
    })).rejects.toMatchObject({ status: 409, code: 'ALREADY_OUT' });
  });

  test('an invalid reason is rejected before any write', async () => {
    await expect(markTechOut({
      technicianId: ABSENT_TECH, date: DATE, reason: 'vacation', actorId: 'actor-1',
    })).rejects.toMatchObject({ status: 400, code: 'VALIDATION' });
    expect(Object.keys(state.absences)).toHaveLength(0);
  });

  describe('resume (finding E)', () => {
    test('ALREADY_OUT with an incomplete prior redistribution (null) resumes instead of erroring, and merges the summary', async () => {
      const STOP_A = { ...STOP, id: 'stop-a' };
      const STOP_B = { ...STOP, id: 'stop-b', window_start: '11:00', window_end: '12:00' };
      state.absences['absence-1'] = {
        id: 'absence-1', technician_id: ABSENT_TECH, absence_date: DATE, reason: 'sick', cleared_at: null, redistribution: null,
      };
      // Simulates: STOP_A already moved off the absent tech in an earlier
      // (never-completed) attempt — a real dayStopsQuery would no longer
      // return it once its technician_id changed. STOP_B is still pending.
      state.absentStops = [STOP_B];
      state.crew = [CANDIDATE];
      state.overlapsByTech[CANDIDATE.id] = [];
      SmartRebooker.reschedule.mockResolvedValue({ success: true });

      const priorSummary = {
        total: 2,
        moved: [{ job_id: STOP_A.id, to_technician_id: CANDIDATE.id, to_technician_name: CANDIDATE.name, detour_minutes: null }],
        parked: [],
        failed: [],
        status: 'partial',
        error: 'alert insert boom',
      };
      state.absences['absence-1'].redistribution = priorSummary;

      const { absence, summary, resumed } = await markTechOut({
        technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1',
      });

      expect(resumed).toBe(true);
      expect(absence.id).toBe('absence-1');
      expect(summary.status).toBe('complete');
      expect(summary.total).toBe(2); // preserved from the original attempt, not re-derived from the smaller resume set
      expect(summary.moved).toEqual([
        priorSummary.moved[0],
        { job_id: STOP_B.id, to_technician_id: CANDIDATE.id, to_technician_name: CANDIDATE.name, detour_minutes: null },
      ]);
      expect(state.absences['absence-1'].redistribution).toMatchObject({ status: 'complete', total: 2 });
    });

    test('ALREADY_OUT skips re-parking a stop that already has an open tech_out_overflow alert', async () => {
      const STOP_B = { ...STOP, id: 'stop-b' };
      state.absences['absence-1'] = {
        id: 'absence-1', technician_id: ABSENT_TECH, absence_date: DATE, reason: 'sick', cleared_at: null,
        redistribution: { total: 1, moved: [], parked: [], failed: [], status: 'partial', error: 'boom' },
      };
      state.absentStops = [STOP_B]; // still on the absent tech (parking doesn't reassign technician_id)
      state.dispatchAlerts = [
        { id: 'alert-existing', type: 'tech_out_overflow', tech_id: ABSENT_TECH, job_id: STOP_B.id, resolved_at: null, payload: { date: DATE } },
      ];
      state.crew = [];

      const { summary, resumed } = await markTechOut({
        technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1',
      });

      expect(resumed).toBe(true);
      expect(createAlert).not.toHaveBeenCalled();
      expect(summary.parked).toEqual([]);
      expect(summary.moved).toEqual([]);
      expect(summary.status).toBe('complete');
    });

    test('first run throws after one move -> row has partial; second POST resumes and completes (end-to-end)', async () => {
      const STOP_A = { ...STOP, id: 'stop-a' };
      const STOP_B = { ...STOP, id: 'stop-b', window_start: '11:00', window_end: '12:00' };
      state.absentStops = [STOP_A, STOP_B];
      state.crew = [CANDIDATE];
      // Conflicts only STOP_B's window (11:00-12:00) — STOP_A (09:00-10:00)
      // fits and moves; STOP_B parks, and its alert insert fails.
      state.overlapsByTech[CANDIDATE.id] = [{ window_start: '11:00', window_end: '12:00', estimated_duration_minutes: 60 }];
      SmartRebooker.reschedule.mockResolvedValue({ success: true });
      createAlert.mockImplementation(async ({ jobId }) => {
        if (jobId === STOP_B.id) throw new Error('alert insert boom');
        return { id: `alert-${jobId}` };
      });

      await expect(markTechOut({
        technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1',
      })).rejects.toThrow('alert insert boom');

      const absenceId = Object.keys(state.absences)[0];
      expect(state.absences[absenceId].redistribution).toMatchObject({ status: 'partial', total: 2 });
      expect(state.absences[absenceId].redistribution.moved).toEqual([
        { job_id: STOP_A.id, to_technician_id: CANDIDATE.id, to_technician_name: CANDIDATE.name, detour_minutes: null },
      ]);

      // STOP_A really did move (per the first attempt); only STOP_B remains
      // on the absent tech for the resume.
      state.absentStops = [STOP_B];
      createAlert.mockImplementation(async ({ jobId }) => ({ id: `alert-${jobId}` }));

      const { summary, resumed } = await markTechOut({
        technicianId: ABSENT_TECH, date: DATE, reason: 'sick', actorId: 'actor-1',
      });

      expect(resumed).toBe(true);
      expect(summary.status).toBe('complete');
      expect(summary.total).toBe(2);
      expect(summary.moved).toHaveLength(1);
      expect(summary.parked).toHaveLength(1);
      expect(summary.parked[0].job_id).toBe(STOP_B.id);
    });
  });
});

describe('clearTechOut', () => {
  test('resolves every open tech_out_overflow alert for that tech+date with auto: true, and moves nothing back', async () => {
    state.absences['abs-1'] = { id: 'abs-1', technician_id: ABSENT_TECH, absence_date: DATE, cleared_at: null };
    state.dispatchAlerts = [
      { id: 'alert-1', type: 'tech_out_overflow', tech_id: ABSENT_TECH, resolved_at: null },
      { id: 'alert-2', type: 'tech_out_overflow', tech_id: 'some-other-tech', resolved_at: null },
    ];
    resolveAlert.mockImplementation(async ({ id }) => ({ id, resolved_at: 'NOW()' }));

    const result = await clearTechOut({ technicianId: ABSENT_TECH, date: DATE, actorId: 'actor-1' });

    expect(resolveAlert).toHaveBeenCalledTimes(1);
    expect(resolveAlert).toHaveBeenCalledWith({ id: 'alert-1', resolvedBy: 'actor-1', auto: true });
    expect(result.resolvedAlerts).toEqual([{ id: 'alert-1', resolved_at: 'NOW()' }]);
    expect(state.absences['abs-1'].cleared_at).toBe('NOW()');
    expect(state.absences['abs-1'].cleared_by).toBe('actor-1');
    expect(SmartRebooker.reschedule).not.toHaveBeenCalled();
  });

  test('clearing an absence that does not exist is NOT_OUT (404)', async () => {
    await expect(clearTechOut({ technicianId: ABSENT_TECH, date: DATE, actorId: 'actor-1' }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_OUT' });
  });
});
