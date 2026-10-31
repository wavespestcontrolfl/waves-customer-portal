/**
 * An UNASSIGNED visit's current placement once a second technician is
 * assignable (#6716 "not covered": with two assignable techs, auto-dispatch
 * skipped every unassigned visit as CURRENT_DAY_TECH_UNRESOLVED).
 *
 * GATE_AUTO_DISPATCH_SHARED_MODEL scores the current placement on a
 * technician's day. With several assignable technicians, an unassigned visit
 * is scored on the day of each one who could take it that date (not absent,
 * not off that weekday, not switched off for the category) and keeps the day
 * it adds the least drive to: the owner's "closest route that day" rule
 * (pick-technician.js, 2026-10-03). One assignable technician is unchanged:
 * their day, no further read.
 *
 * Real drive estimates (no route-optimizer mock): the day choice is a
 * distance question. Synthetic coordinates only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/rebooker', () => ({
  probeMoveConflicts: jest.fn().mockResolvedValue({ rows: [], snapshot: [] }),
  occupancyProbeEnd: jest.requireActual('../services/rebooker').occupancyProbeEnd,
}));

const { computeCurrentPlacement } = require('../services/auto-dispatch/candidate-slots');

const ENV = Object.fromEntries(['GATE_AUTO_DISPATCH_SHARED_MODEL', 'GATE_TECH_WORK_DAYS', 'GATE_TECH_START_POINTS', 'GATE_DRIVE_TIME_CALIBRATION']
  .map((k) => [k, process.env[k]]));
beforeEach(() => {
  process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
  delete process.env.GATE_TECH_WORK_DAYS;
  delete process.env.GATE_TECH_START_POINTS;
  delete process.env.GATE_DRIVE_TIME_CALIBRATION;
});
afterAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const DATE = '2026-08-07'; // a Friday: the hire works Monday to Thursday
const VISIT = { lat: 27.3, lng: -82.5 };
const NEAR = { lat: 27.301, lng: -82.501 };
const FAR = { lat: 27.65, lng: -82.15 };

const UNASSIGNED = {
  id: 's1', customer_id: 'c1', scheduled_date: DATE, technician_id: null, window_start: '09:00', window_end: '10:00',
  estimated_duration_minutes: 60, lat: VISIT.lat, lng: VISIT.lng,
};
const dayRow = (id, technicianId, geo) => ({
  id, customer_id: `c-${id}`, technician_id: technicianId, scheduled_date: DATE, window_start: '11:00', window_end: '12:00',
  estimated_duration_minutes: 60, status: 'confirmed', svc_lat: geo.lat, svc_lng: geo.lng,
});
// t1's day runs far from the visit, t2's passes next door.
const DAY_ROWS = [dayRow('far', 't1', FAR), dayRow('near', 't2', NEAR)];
const TWO = [{ id: 't1' }, { id: 't2' }];
const PREFS = { service_category: 'general' };

// One fake knex: `technicians` answers the assignable list (or the work-days
// rows, for offDayTechDays' select), `technician_absences` the absences, and
// `scheduled_services` each technician's day (their rows plus unassigned
// ones, by the technician ids loadDayStopRows asks for). Every read is logged.
function fakeDb({ techs = TWO, absences = [], workDays = [], dayRows = DAY_ROWS, absencesError = null } = {}) {
  const reads = [];
  const db = (table) => {
    let techIds = null;
    const q = {};
    ['whereNot', 'whereNotIn', 'whereNotNull', 'whereBetween', 'whereNull', 'orWhereNull', 'leftJoin', 'orderBy'].forEach((m) => { q[m] = () => q; });
    q.where = (arg) => { if (typeof arg === 'function') arg(q); return q; };
    q.whereIn = (column, ids) => { if (/technician_id$/.test(column)) techIds = ids.map(String); return q; };
    q.select = async (...columns) => {
      const cols = columns.flat();
      reads.push({ table, techIds, cols });
      if (table === 'technicians') return cols.includes('work_days') ? workDays : techs;
      if (table === 'technician_absences') {
        if (absencesError) throw absencesError;
        return absences;
      }
      if (table === 'scheduled_services') return dayRows.filter((r) => r.technician_id == null || (techIds || []).includes(r.technician_id));
      return [];
    };
    return q;
  };
  db.reads = reads;
  return db;
}
const ctxFor = (db, extra = {}) => ({ db, capabilityFor: () => 'qualified', ...extra });
const tablesRead = (db) => db.reads.map((r) => r.table);

describe('unassigned visit, several assignable technicians', () => {
  test('scored on the day it adds the least drive to, with exactly that day\'s numbers', async () => {
    const db = fakeDb();
    const current = await computeCurrentPlacement(UNASSIGNED, PREFS, ctxFor(db));
    expect(current.day_technician_id).toBe('t2');
    expect(current.technician_id).toBeNull(); // the visit itself stays unassigned
    expect(db.reads.filter((r) => r.table === 'scheduled_services').map((r) => r.techIds)).toEqual([['t1'], ['t2']]);

    const onDay = (tech) => computeCurrentPlacement({ ...UNASSIGNED, technician_id: tech }, PREFS, ctxFor(fakeDb()));
    const [onT1, onT2] = await Promise.all([onDay('t1'), onDay('t2')]);
    for (const field of ['detour_minutes', 'total_drive_minutes', 'route_minutes', 'stops_that_day', 'same_area_share']) {
      expect(current[field]).toBe(onT2[field]);
    }
    expect(current.detour_minutes).toBeLessThan(onT1.detour_minutes);
    // An assigned visit's day is its own technician's; nothing extra rides it.
    expect(onT2.day_technician_id).toBeUndefined();
  });

  test.each([
    ['absent that day', { db: { absences: [{ technician_id: 't2', absence_date: DATE }] } }],
    ['off that weekday (works Monday to Thursday)', { workDaysGate: true, db: { workDays: [{ id: 't2', work_days: [1, 2, 3, 4] }] } }],
    ['switched off for the visit\'s category', { capabilityFor: (id) => (id === 't2' ? 'deactivated' : 'qualified') }],
  ])('a technician %s is not a current-day option', async (_label, { db: dbOpts = {}, workDaysGate = false, capabilityFor }) => {
    if (workDaysGate) process.env.GATE_TECH_WORK_DAYS = 'true';
    const db = fakeDb(dbOpts);
    const current = await computeCurrentPlacement(UNASSIGNED, PREFS, ctxFor(db, capabilityFor ? { capabilityFor } : {}));
    expect(current.day_technician_id).toBe('t1');
    expect(db.reads.filter((r) => r.table === 'scheduled_services').map((r) => r.techIds)).toEqual([['t1']]);
  });

  test('nobody who could take it works that day: every assignable technician is scored, the visit is not skipped', async () => {
    const absences = TWO.map((t) => ({ technician_id: t.id, absence_date: DATE }));
    const current = await computeCurrentPlacement(UNASSIGNED, PREFS, ctxFor(fakeDb({ absences })));
    expect(current.model).toBe('shared_v1');
    expect(current.day_technician_id).toBe('t2');
  });

  test('two days that cost the same: the first technician by id, whatever order the rows come back in', async () => {
    const current = await computeCurrentPlacement(UNASSIGNED, PREFS, ctxFor(fakeDb({ techs: [{ id: 't2' }, { id: 't1' }], dayRows: [] })));
    expect(current.day_technician_id).toBe('t1');
  });

  test('the absence read fails: skipped as CURRENT_DAY_TECH_UNRESOLVED, never scored on a guess', async () => {
    await expect(computeCurrentPlacement(UNASSIGNED, PREFS, ctxFor(fakeDb({ absencesError: new Error('boom') }))))
      .rejects.toMatchObject({ code: 'CURRENT_DAY_TECH_UNRESOLVED', skipEvaluation: true });
  });
});

describe('unassigned visit, one assignable technician (unchanged)', () => {
  test('their day, with no absence or work-day read even when they are out', async () => {
    process.env.GATE_TECH_WORK_DAYS = 'true';
    const db = fakeDb({
      techs: [{ id: 't1' }], absences: [{ technician_id: 't1', absence_date: DATE }], workDays: [{ id: 't1', work_days: [1, 2, 3, 4] }],
    });
    const current = await computeCurrentPlacement(UNASSIGNED, PREFS, ctxFor(db));
    expect(current.day_technician_id).toBe('t1');
    expect(tablesRead(db)).toEqual(['technicians', 'scheduled_services']);
  });
});
