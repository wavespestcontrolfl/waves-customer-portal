// technician-eligibility.js — the one answer to "may this tech take field
// work?" (Field Team Program, Phase 0 item 1). Pure helpers plus the
// save-time assert every visit writer calls.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../models/db');
const {
  EMPLOYMENT_STATUSES,
  NOT_ASSIGNABLE,
  isEmploymentStatus,
  isAssignable,
  applyAssignable,
  assertAssignableTechnician,
  employmentPatch,
  absentTechDays,
  offDayTechDays,
  normalizeWorkDays,
  dayOfWeekOfDate,
  isOffDay,
  offDayWarning,
  offDayWarningsFor,
  loadTechShifts,
  shiftMinutes,
  storedShift,
  shiftBounds,
  shiftExcluding,
} = require('../services/technician-eligibility');
const logger = require('../services/logger');

function connReturning(row, { transaction = false } = {}) {
  const chain = {
    where: jest.fn(() => chain),
    forShare: jest.fn(() => chain),
    first: jest.fn(async () => row),
  };
  const conn = jest.fn(() => chain);
  if (transaction) conn.isTransaction = true;
  return { conn, chain };
}

// A conn that routes 'technicians' to the given row and 'technician_absences'
// to an uncleared-absence lookup, for the date-scoped branch.
function connWithAbsence(techRow, absenceRow, { transaction = false } = {}) {
  const techChain = {
    where: jest.fn(() => techChain), forShare: jest.fn(() => techChain), first: jest.fn(async () => techRow),
  };
  const absenceChain = {
    where: jest.fn(() => absenceChain), whereNull: jest.fn(() => absenceChain), first: jest.fn(async () => absenceRow),
  };
  const conn = jest.fn((table) => (table === 'technicians' ? techChain : absenceChain));
  if (transaction) conn.isTransaction = true;
  return { conn, techChain, absenceChain };
}

describe('technician eligibility', () => {
  test('statuses are exactly prospective / active / inactive', () => {
    expect(EMPLOYMENT_STATUSES).toEqual(['prospective', 'active', 'inactive']);
    expect(isEmploymentStatus('active')).toBe(true);
    expect(isEmploymentStatus('terminated')).toBe(false);
    expect(isEmploymentStatus(undefined)).toBe(false);
  });

  test('assignable = active employment AND field-dispatchable; nothing else counts', () => {
    expect(isAssignable({ employment_status: 'active', field_dispatchable: true })).toBe(true);
    // An office admin stays on staff without ever taking field work.
    expect(isAssignable({ employment_status: 'active', field_dispatchable: false })).toBe(false);
    // A placeholder for a hire who has not started.
    expect(isAssignable({ employment_status: 'prospective', field_dispatchable: true })).toBe(false);
    expect(isAssignable({ employment_status: 'inactive', field_dispatchable: true })).toBe(false);
    // The legacy flag alone never grants assignment.
    expect(isAssignable({ active: true })).toBe(false);
    expect(isAssignable(null)).toBe(false);
  });

  test('applyAssignable narrows a technicians query on both columns (aliased or not)', () => {
    const q = { where: jest.fn() };
    q.where.mockReturnValue(q);
    applyAssignable(q);
    expect(q.where).toHaveBeenCalledWith('technicians.employment_status', 'active');
    expect(q.where).toHaveBeenCalledWith('technicians.field_dispatchable', true);
    q.where.mockClear();
    applyAssignable(q, 't');
    expect(q.where).toHaveBeenCalledWith('t.employment_status', 'active');
    expect(q.where).toHaveBeenCalledWith('t.field_dispatchable', true);
  });

  test('employmentPatch writes status and the legacy active flag together', () => {
    expect(employmentPatch('active')).toEqual({ employment_status: 'active', active: true });
    expect(employmentPatch('prospective')).toEqual({ employment_status: 'prospective', active: false });
    expect(employmentPatch('inactive')).toEqual({ employment_status: 'inactive', active: false });
    expect(() => employmentPatch('fired')).toThrow(/Invalid employment status/);
  });

  describe('assertAssignableTechnician', () => {
    test('unassigned (null / undefined / empty) is always legal and reads nothing', async () => {
      const { conn } = connReturning(null);
      await expect(assertAssignableTechnician(null, { conn })).resolves.toBeNull();
      await expect(assertAssignableTechnician(undefined, { conn })).resolves.toBeNull();
      await expect(assertAssignableTechnician('', { conn })).resolves.toBeNull();
      expect(conn).not.toHaveBeenCalled();
    });

    test('returns the row for an assignable technician', async () => {
      const row = { id: 't1', name: 'Tech One', employment_status: 'active', field_dispatchable: true };
      const { conn, chain } = connReturning(row);
      await expect(assertAssignableTechnician('t1', { conn })).resolves.toBe(row);
      expect(chain.where).toHaveBeenCalledWith({ id: 't1' });
    });

    test.each([
      ['a prospective placeholder', { employment_status: 'prospective', field_dispatchable: true }, /has not started yet/],
      ['an inactive account', { employment_status: 'inactive', field_dispatchable: true }, /no longer active/],
      ['an active office-only admin', { employment_status: 'active', field_dispatchable: false }, /not field-dispatchable/],
      ['an unknown id', null, /unknown technician/],
    ])('throws 422 TECH_NOT_ASSIGNABLE for %s', async (_label, row, message) => {
      const { conn } = connReturning(row ? { id: 't1', name: 'Tech One', ...row } : null);
      await expect(assertAssignableTechnician('t1', { conn })).rejects.toMatchObject({
        status: 422,
        // The shared error middleware (middleware/errors.js) only surfaces
        // isOperational errors with their statusCode — without both this
        // would reach the client as a generic 500.
        statusCode: 422,
        isOperational: true,
        code: NOT_ASSIGNABLE,
        technicianId: 't1',
        message: expect.stringMatching(message),
      });
    });

    test('on a transaction the row is read FOR SHARE so a concurrent status change cannot commit underneath the assignment', async () => {
      const row = { id: 't1', name: 'Tech One', employment_status: 'active', field_dispatchable: true };
      const { conn, chain } = connReturning(row, { transaction: true });
      await expect(assertAssignableTechnician('t1', { conn })).resolves.toBe(row);
      expect(chain.forShare).toHaveBeenCalledTimes(1);
    });

    test('on a plain connection no row lock is taken', async () => {
      const { conn, chain } = connReturning({ id: 't1', employment_status: 'active', field_dispatchable: true });
      await assertAssignableTechnician('t1', { conn });
      expect(chain.forShare).not.toHaveBeenCalled();
    });

    test('defaults to the shared db handle when no connection is passed', async () => {
      const chain = { where: jest.fn(() => chain), first: jest.fn(async () => ({ id: 't1', employment_status: 'active', field_dispatchable: true })) };
      db.mockReturnValue(chain);
      await expect(assertAssignableTechnician('t1')).resolves.toMatchObject({ id: 't1' });
      expect(db).toHaveBeenCalledWith('technicians');
    });

    describe('date-scoped technician_absences check (tech-out redistribution, codex #4678 r1 finding B)', () => {
      const ROW = { id: 't1', name: 'Tech One', employment_status: 'active', field_dispatchable: true };

      test('no date ⇒ byte-identical: technician_absences is never queried', async () => {
        const { conn, absenceChain } = connWithAbsence(ROW, { id: 'abs-1' });
        await expect(assertAssignableTechnician('t1', { conn })).resolves.toBe(ROW);
        expect(absenceChain.where).not.toHaveBeenCalled();
      });

      test('a date with no uncleared absence row is unaffected', async () => {
        const { conn } = connWithAbsence(ROW, undefined);
        await expect(assertAssignableTechnician('t1', { conn, date: '2026-10-01' })).resolves.toBe(ROW);
      });

      test('an uncleared absence on that date throws 422 TECH_NOT_ASSIGNABLE, "marked out on <date>"', async () => {
        const { conn, absenceChain } = connWithAbsence(ROW, { id: 'abs-1' });
        await expect(assertAssignableTechnician('t1', { conn, date: '2026-10-01' })).rejects.toMatchObject({
          status: 422,
          statusCode: 422,
          isOperational: true,
          code: NOT_ASSIGNABLE,
          technicianId: 't1',
          message: expect.stringMatching(/Tech One is marked out on 2026-10-01 and cannot be assigned work/),
        });
        expect(absenceChain.where).toHaveBeenCalledWith({ technician_id: 't1', absence_date: '2026-10-01' });
      });

      test('a technician already ineligible for another reason short-circuits before the absence read', async () => {
        const inactiveRow = { id: 't1', name: 'Tech One', employment_status: 'inactive', field_dispatchable: true };
        const { conn, absenceChain } = connWithAbsence(inactiveRow, { id: 'abs-1' });
        await expect(assertAssignableTechnician('t1', { conn, date: '2026-10-01' })).rejects.toMatchObject({
          code: NOT_ASSIGNABLE,
          message: expect.stringMatching(/no longer active/),
        });
        expect(absenceChain.where).not.toHaveBeenCalled();
      });
    });
  });

  describe('absentTechDays (slot-discovery counterpart to the date-scoped assert, codex #4678 pre-push auditor P1)', () => {
    function connAbsenceRows(rows) {
      const chain = {
        whereBetween: jest.fn(() => chain),
        whereNull: jest.fn(() => chain),
        whereIn: jest.fn(() => chain),
        select: jest.fn(async () => rows),
      };
      const conn = jest.fn(() => chain);
      return { conn, chain };
    }

    test('returns technicianId:date keys, one Set entry per uncleared row in range', async () => {
      const { conn } = connAbsenceRows([
        { technician_id: 't1', absence_date: '2026-10-01' },
        { technician_id: 't2', absence_date: '2026-10-02' },
      ]);
      const days = await absentTechDays(conn, { dateFrom: '2026-10-01', dateTo: '2026-10-07' });
      expect(days).toEqual(new Set(['t1:2026-10-01', 't2:2026-10-02']));
    });

    test('normalizes a Postgres DATE column (JS Date at UTC midnight) to YYYY-MM-DD', async () => {
      const { conn } = connAbsenceRows([
        { technician_id: 't1', absence_date: new Date('2026-10-01T00:00:00.000Z') },
      ]);
      const days = await absentTechDays(conn, { dateFrom: '2026-10-01', dateTo: '2026-10-07' });
      expect(days).toEqual(new Set(['t1:2026-10-01']));
    });

    test('no absences in range returns an empty Set', async () => {
      const { conn } = connAbsenceRows([]);
      const days = await absentTechDays(conn, { dateFrom: '2026-10-01', dateTo: '2026-10-07' });
      expect(days).toEqual(new Set());
    });

    test('queries only the given date range and, when technicianIds is passed, narrows to it', async () => {
      const { conn, chain } = connAbsenceRows([]);
      await absentTechDays(conn, { dateFrom: '2026-10-01', dateTo: '2026-10-07', technicianIds: ['t1', 't2'] });
      expect(chain.whereBetween).toHaveBeenCalledWith('absence_date', ['2026-10-01', '2026-10-07']);
      expect(chain.whereNull).toHaveBeenCalledWith('cleared_at');
      expect(chain.whereIn).toHaveBeenCalledWith('technician_id', ['t1', 't2']);
    });

    test('omitting technicianIds (or passing an empty array) reads every absence in range, no whereIn', async () => {
      const { conn, chain } = connAbsenceRows([]);
      await absentTechDays(conn, { dateFrom: '2026-10-01', dateTo: '2026-10-07' });
      expect(chain.whereIn).not.toHaveBeenCalled();
      const { conn: conn2, chain: chain2 } = connAbsenceRows([]);
      await absentTechDays(conn2, { dateFrom: '2026-10-01', dateTo: '2026-10-07', technicianIds: [] });
      expect(chain2.whereIn).not.toHaveBeenCalled();
    });
  });

  // GATE_TECH_WORK_DAYS (owner 2026-10-25): technicians.work_days, 0 = Sunday.
  describe('work days (GATE_TECH_WORK_DAYS)', () => {
    const MON_THU = [1, 2, 3, 4];
    afterEach(() => { delete process.env.GATE_TECH_WORK_DAYS; });
    const gateOn = () => { process.env.GATE_TECH_WORK_DAYS = 'true'; };

    test('normalizeWorkDays: sorted and de-duplicated; all seven, empty or unreadable = every day (null)', () => {
      expect(normalizeWorkDays([4, 1, 3, 2, 2])).toEqual([1, 2, 3, 4]);
      expect(normalizeWorkDays('{1,2,3,4}')).toEqual([1, 2, 3, 4]);
      expect(normalizeWorkDays(['1', '2'])).toEqual([1, 2]);
      expect(normalizeWorkDays([0, 1, 2, 3, 4, 5, 6])).toBeNull();
      expect(normalizeWorkDays([])).toBeNull();
      expect(normalizeWorkDays(null)).toBeNull();
      expect(normalizeWorkDays(undefined)).toBeNull();
      expect(normalizeWorkDays([7])).toBeNull();
      expect(normalizeWorkDays([1.5])).toBeNull();
      expect(normalizeWorkDays('nope')).toBeNull();
    });

    test('dayOfWeekOfDate reads the calendar date itself: Sunday = 0, impossible dates = null', () => {
      expect(dayOfWeekOfDate('2026-10-25')).toBe(0); // Sunday
      expect(dayOfWeekOfDate('2026-10-26')).toBe(1);
      expect(dayOfWeekOfDate('2026-10-30')).toBe(5);
      expect(dayOfWeekOfDate('2026-10-31T00:00:00.000Z')).toBe(6);
      expect(dayOfWeekOfDate(new Date('2026-10-30T00:00:00.000Z'))).toBe(5); // a pg DATE read back as a Date
      expect(dayOfWeekOfDate('2026-02-31')).toBeNull();
      expect(dayOfWeekOfDate('soon')).toBeNull();
      expect(dayOfWeekOfDate(null)).toBeNull();
    });

    test('gate off: nothing is ever an off day, whatever work_days says', () => {
      expect(isOffDay({ work_days: MON_THU }, '2026-10-30')).toBe(false);
      expect(offDayWarning({ name: 'Tech One', work_days: MON_THU }, '2026-10-30')).toBeNull();
    });

    test('gate must be exactly "true"', () => {
      process.env.GATE_TECH_WORK_DAYS = '1';
      expect(isOffDay({ work_days: MON_THU }, '2026-10-30')).toBe(false);
      process.env.GATE_TECH_WORK_DAYS = 'TRUE';
      expect(isOffDay({ work_days: MON_THU }, '2026-10-30')).toBe(false);
    });

    test('gate on: NULL / missing work_days = works every day', () => {
      gateOn();
      expect(isOffDay({ work_days: null }, '2026-10-30')).toBe(false);
      expect(isOffDay({}, '2026-10-30')).toBe(false);
      expect(isOffDay(null, '2026-10-30')).toBe(false);
    });

    test('gate on: a Monday-to-Thursday week is off Friday, Saturday and Sunday', () => {
      gateOn();
      const tech = { work_days: MON_THU };
      const week = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
      expect(week.map((d) => isOffDay(tech, d))).toEqual([false, false, false, false, true, true, true]);
    });

    test('gate on: weekdays hold across both DST changes (calendar dates, not clock hours)', () => {
      gateOn();
      const tech = { work_days: MON_THU };
      // Fall back Sun 2026-11-01 and spring forward Sun 2027-03-14 (America/New_York).
      expect(isOffDay(tech, '2026-11-01')).toBe(true);
      expect(isOffDay(tech, '2026-11-02')).toBe(false); // Monday after fall back
      expect(isOffDay(tech, '2027-03-12')).toBe(true); // Friday
      expect(isOffDay(tech, '2027-03-14')).toBe(true); // Sunday, the 23-hour day
      expect(isOffDay(tech, '2027-03-15')).toBe(false); // Monday after spring forward
      expect(isOffDay(tech, '2027-03-18')).toBe(false); // Thursday
    });

    test('offDayWarning names the weekday in plain words', () => {
      gateOn();
      expect(offDayWarning({ name: 'Tech One', work_days: MON_THU }, '2026-10-30')).toBe('Tech One does not work on Fridays.');
      expect(offDayWarning({ name: 'Tech One', work_days: MON_THU }, '2026-10-28')).toBeNull();
      expect(offDayWarning({ work_days: MON_THU }, '2026-11-01')).toBe('This technician does not work on Sundays.');
    });

    function connWithWorkDays(rows) {
      const chain = {
        whereNotNull: jest.fn(() => chain), whereIn: jest.fn(() => chain),
        select: jest.fn(async () => rows),
      };
      const conn = jest.fn(() => chain);
      return { conn, chain };
    }

    test('offDayTechDays lists every off date in range across a DST change; empty with the gate off', async () => {
      const { conn, chain } = connWithWorkDays([{ id: 't1', work_days: MON_THU }, { id: 't2', work_days: null }]);
      expect(await offDayTechDays(conn, { dateFrom: '2026-10-26', dateTo: '2026-11-08' })).toEqual(new Set());
      expect(conn).not.toHaveBeenCalled();
      gateOn();
      const days = await offDayTechDays(conn, { dateFrom: '2026-10-26', dateTo: '2026-11-08', technicianIds: ['t1', 't2'] });
      expect(days).toEqual(new Set([
        't1:2026-10-30', 't1:2026-10-31', 't1:2026-11-01', 't1:2026-11-06', 't1:2026-11-07', 't1:2026-11-08',
      ]));
      expect(chain.whereNotNull).toHaveBeenCalledWith('work_days');
      expect(chain.whereIn).toHaveBeenCalledWith('id', ['t1', 't2']);
    });

    function connAbsencesAndWorkDays(absenceRows, techRows) {
      const absences = {
        whereBetween: jest.fn(() => absences), whereNull: jest.fn(() => absences), whereIn: jest.fn(() => absences),
        select: jest.fn(async () => absenceRows),
      };
      const techs = {
        whereNotNull: jest.fn(() => techs), whereIn: jest.fn(() => techs), select: jest.fn(async () => techRows),
      };
      const conn = jest.fn((table) => (table === 'technicians' ? techs : absences));
      return { conn, techs };
    }

    test('absentTechDays: gate off reads no technicians row (byte-identical); gate on adds off days beside absences', async () => {
      const args = { dateFrom: '2026-10-26', dateTo: '2026-11-01', technicianIds: ['t1'] };
      const off = connAbsencesAndWorkDays([{ technician_id: 't1', absence_date: '2026-10-27' }], [{ id: 't1', work_days: MON_THU }]);
      expect(await absentTechDays(off.conn, args)).toEqual(new Set(['t1:2026-10-27']));
      expect(off.techs.select).not.toHaveBeenCalled();
      gateOn();
      const on = connAbsencesAndWorkDays([{ technician_id: 't1', absence_date: '2026-10-27' }], [{ id: 't1', work_days: MON_THU }]);
      expect(await absentTechDays(on.conn, args)).toEqual(new Set(['t1:2026-10-27', 't1:2026-10-30', 't1:2026-10-31', 't1:2026-11-01']));
    });

    test('absentTechDays: includeOffDays false (the open-visit nudge) returns absences only, even with the gate on', async () => {
      gateOn();
      const { conn, techs } = connAbsencesAndWorkDays([], [{ id: 't1', work_days: MON_THU }]);
      const days = await absentTechDays(conn, { dateFrom: '2026-10-26', dateTo: '2026-11-01', technicianIds: ['t1'], includeOffDays: false });
      expect(days).toEqual(new Set());
      expect(techs.select).not.toHaveBeenCalled();
    });

    describe('assertAssignableTechnician workDays option', () => {
      const ROW = { id: 't1', name: 'Tech One', employment_status: 'active', field_dispatchable: true, work_days: MON_THU };
      const connFor = (row) => connWithAbsence(row, undefined).conn;

      test('without the option an off day is accepted (office paths), and work_days is not even read', async () => {
        gateOn();
        const { conn, techChain } = connWithAbsence(ROW, undefined);
        await expect(assertAssignableTechnician('t1', { conn, date: '2026-10-30' })).resolves.toBe(ROW);
        expect(techChain.first).toHaveBeenCalledWith('id', 'name', 'role', 'employment_status', 'field_dispatchable', 'active');
      });

      test('with the option and the gate on, an off day throws 422 TECH_NOT_ASSIGNABLE with offDay set', async () => {
        gateOn();
        await expect(assertAssignableTechnician('t1', { conn: connFor(ROW), date: '2026-10-30', workDays: true })).rejects.toMatchObject({
          status: 422,
          statusCode: 422,
          isOperational: true,
          code: NOT_ASSIGNABLE,
          offDay: true,
          technicianId: 't1',
          message: expect.stringMatching(/Tech One does not work on Fridays \(2026-10-30\) and cannot be assigned work/),
        });
      });

      test('with the option, a work day passes and reads work_days', async () => {
        gateOn();
        const { conn, techChain } = connWithAbsence(ROW, undefined);
        await expect(assertAssignableTechnician('t1', { conn, date: '2026-10-29', workDays: true })).resolves.toBe(ROW);
        expect(techChain.first).toHaveBeenCalledWith('id', 'name', 'role', 'employment_status', 'field_dispatchable', 'active', 'work_days');
      });

      test('with the option but the gate off, an off day passes with the original column list', async () => {
        const { conn, techChain } = connWithAbsence(ROW, undefined);
        await expect(assertAssignableTechnician('t1', { conn, date: '2026-10-30', workDays: true })).resolves.toBe(ROW);
        expect(techChain.first).toHaveBeenCalledWith('id', 'name', 'role', 'employment_status', 'field_dispatchable', 'active');
      });

      test('with the option but no date nothing is checked', async () => {
        gateOn();
        await expect(assertAssignableTechnician('t1', { conn: connFor(ROW), workDays: true })).resolves.toBe(ROW);
      });

      test('an absence still wins the reason when the day is also an off day', async () => {
        gateOn();
        const { conn } = connWithAbsence(ROW, { id: 'abs-1' });
        await expect(assertAssignableTechnician('t1', { conn, date: '2026-10-30', workDays: true })).rejects.toMatchObject({
          message: expect.stringMatching(/is marked out on 2026-10-30/),
        });
      });
    });

    test('offDayWarningsFor: one read, one line per distinct off weekday, [] with the gate off or a failed read', async () => {
      const chain = { where: jest.fn(() => chain), first: jest.fn(async () => ({ id: 't1', name: 'Tech One', work_days: MON_THU })) };
      const conn = jest.fn(() => chain);
      expect(await offDayWarningsFor('t1', ['2026-10-30'], { conn })).toEqual([]);
      expect(conn).not.toHaveBeenCalled();
      gateOn();
      expect(await offDayWarningsFor('t1', ['2026-11-06', '2026-10-30', '2026-10-29', '2026-10-31'], { conn }))
        .toEqual(['Tech One does not work on Fridays.', 'Tech One does not work on Saturdays.']);
      expect(chain.first).toHaveBeenCalledTimes(1);
      chain.first.mockRejectedValueOnce(new Error('column work_days does not exist'));
      expect(await offDayWarningsFor('t1', ['2026-10-30'], { conn })).toEqual([]);
      expect(await offDayWarningsFor(null, ['2026-10-30'], { conn })).toEqual([]);
    });
  });
});

// GATE_TECH_SHIFT_HOURS (owner 2026-11-19, page item D4): each technician's shift for a date.
describe('shift hours (GATE_TECH_SHIFT_HOURS)', () => {
  afterEach(() => { delete process.env.GATE_TECH_SHIFT_HOURS; });
  const gateOn = () => { process.env.GATE_TECH_SHIFT_HOURS = 'true'; };
  // 2031-03-04 is a Tuesday before the 2031-03-09 spring-forward: 15:00Z = 10:00 AM EST.
  const NOW = new Date('2031-03-04T15:00:00Z');
  const TODAY = '2031-03-04';
  const TOMORROW = '2031-03-05';

  // Routes 'technicians' and 'time_entries' to recording chains that resolve to the given rows.
  function shiftConn({ techRows = [], clockRows = [], clockError = null } = {}) {
    const calls = { technicians: [], time_entries: [] };
    const conn = jest.fn((table) => {
      const chain = {};
      for (const m of ['where', 'whereNot', 'whereNotNull', 'whereIn', 'whereRaw', 'groupBy', 'select', 'min']) {
        chain[m] = jest.fn((...args) => { calls[table].push([m, ...args]); return chain; });
      }
      // Settled only when the chain is awaited: a rejection made up front and never
      // awaited (the read under test threw first) would end the whole test process.
      const settle = () => (table === 'technicians'
        ? Promise.resolve(techRows)
        : clockError ? Promise.reject(clockError) : Promise.resolve(clockRows));
      chain.then = (res, rej) => settle().then(res, rej);
      return chain;
    });
    return { conn, calls };
  }
  const DAY_TECH = { id: 'tech-1', shift_start: '08:00:00', shift_end: '18:00:00' };

  test('shiftMinutes reads HH:MM and the Postgres HH:MM:SS form; anything else is null', () => {
    expect(shiftMinutes('08:00')).toBe(480);
    expect(shiftMinutes('17:30:00')).toBe(1050);
    expect(shiftMinutes('07:45:00.000')).toBe(465);
    for (const bad of ['8:00', '24:00', '12:60', '', null, undefined, 480, 'noon']) expect(shiftMinutes(bad)).toBeNull();
  });

  // The rule every offer path applies (owner 2026-11-19, page item D4): a job starts at or after
  // the shift start and ends by the shift end, inside the caller's own day.
  test('shiftBounds narrows the caller\'s day to the shift and never widens it', () => {
    const shift = { startMin: 600, endMin: 900, source: 'roster' };
    // A day wider than the shift on both sides takes the shift.
    expect(shiftBounds(shift, 480, 1080)).toEqual({ openMin: 600, closeMin: 900 });
    // A day narrower than the shift on both sides stays as it is.
    expect(shiftBounds(shift, 660, 840)).toEqual({ openMin: 660, closeMin: 840 });
    // Each side on its own: a later open with an earlier shift end, and the reverse.
    expect(shiftBounds(shift, 660, 1080)).toEqual({ openMin: 660, closeMin: 900 });
    expect(shiftBounds(shift, 480, 840)).toEqual({ openMin: 600, closeMin: 840 });
    // No shift (the gate off, or no set hours): the caller's day.
    expect(shiftBounds(null, 480, 1080)).toEqual({ openMin: 480, closeMin: 1080 });
    expect(shiftBounds(undefined, 0, 1440)).toEqual({ openMin: 0, closeMin: 1440 });
  });

  test('storedShift needs both times with the end after the start', () => {
    expect(storedShift(DAY_TECH)).toEqual({ startMin: 480, endMin: 1080 });
    expect(storedShift({ shift_start: '08:00:00', shift_end: null })).toBeNull();
    expect(storedShift({ shift_start: '18:00:00', shift_end: '08:00:00' })).toBeNull();
    expect(storedShift({ shift_start: '08:00:00', shift_end: '08:00:00' })).toBeNull();
    expect(storedShift(null)).toBeNull();
  });

  test('gate off: no read at all, and every lookup is null', async () => {
    const { conn } = shiftConn({ techRows: [DAY_TECH] });
    const shiftOf = await loadTechShifts(conn, { now: NOW });
    expect(conn).not.toHaveBeenCalled();
    expect(shiftOf('tech-1', TOMORROW)).toBeNull();
  });

  test('the set hours answer every date; a technician without hours, or a non-date, is null', async () => {
    gateOn();
    const { conn, calls } = shiftConn({ techRows: [DAY_TECH] });
    const shiftOf = await loadTechShifts(conn, { now: NOW });
    expect(shiftOf('tech-1', TOMORROW)).toEqual({ startMin: 480, endMin: 1080, source: 'roster' });
    expect(shiftOf('tech-1', TODAY)).toEqual({ startMin: 480, endMin: 1080, source: 'roster' });
    // A pg DATE read back as a Date, and a numeric id, read the same.
    expect(shiftOf('tech-1', new Date('2031-03-06T00:00:00Z'))).toEqual({ startMin: 480, endMin: 1080, source: 'roster' });
    expect(shiftOf('tech-2', TOMORROW)).toBeNull();
    expect(shiftOf('tech-1', 'not-a-date')).toBeNull();
    expect(shiftOf('tech-1', null)).toBeNull();
    // A tail, an impossible day and an invalid Date are no date (and never throw).
    expect(shiftOf('tech-1', '2031-03-05junk')).toBeNull();
    expect(shiftOf('tech-1', '2031-02-30')).toBeNull();
    expect(shiftOf('tech-1', new Date('not a date'))).toBeNull();
    expect(calls.technicians).toEqual(expect.arrayContaining([
      ['whereNotNull', 'shift_start'], ['whereNotNull', 'shift_end'], ['select', 'id', 'shift_start', 'shift_end'],
    ]));
  });

  test('today, after a clock-in: the same length of day from the clock-in; other dates keep the set hours', async () => {
    gateOn();
    // 12:52Z = 7:52 AM EST.
    const { conn, calls } = shiftConn({ techRows: [DAY_TECH], clockRows: [{ technician_id: 'tech-1', clock_in: new Date('2031-03-04T12:52:00Z') }] });
    const shiftOf = await loadTechShifts(conn, { now: NOW });
    expect(shiftOf('tech-1', TODAY)).toEqual({ startMin: 472, endMin: 1072, source: 'clock_in' });
    expect(shiftOf('tech-1', TOMORROW)).toEqual({ startMin: 480, endMin: 1080, source: 'roster' });
    // Each answer is the caller's own object: changing one changes no later answer.
    Object.assign(shiftOf('tech-1', TODAY), { endMin: 0 });
    Object.assign(shiftOf('tech-1', TOMORROW), { endMin: 0 });
    expect(shiftOf('tech-1', TODAY).endMin).toBe(1072);
    expect(shiftOf('tech-1', TOMORROW).endMin).toBe(1080);
    // The read: shift entries that are not voided, for the technicians with hours, on today's Staff work date, and
    // not after now (an entry typed in ahead of time has not happened yet).
    expect(calls.time_entries).toEqual(expect.arrayContaining([
      ['where', { entry_type: 'shift' }],
      ['whereNot', { status: 'voided' }],
      ['whereIn', 'technician_id', ['tech-1']],
      ['whereRaw', "(clock_in::timestamptz AT TIME ZONE 'America/New_York')::date = ?::date", [TODAY]],
      ['where', 'clock_in', '<=', NOW],
      ['min', { clock_in: 'clock_in' }],
    ]));
  });

  test('a late clock-in never runs the day past midnight', async () => {
    gateOn();
    // 21:00Z = 4:00 PM EST, read at 5:00 PM; ten hours later would be 2:00 AM.
    const { conn } = shiftConn({ techRows: [DAY_TECH], clockRows: [{ technician_id: 'tech-1', clock_in: '2031-03-04T21:00:00.000Z' }] });
    const shiftOf = await loadTechShifts(conn, { now: new Date('2031-03-04T22:00:00Z') });
    expect(shiftOf('tech-1', TODAY)).toEqual({ startMin: 960, endMin: 1440, source: 'clock_in' });

    // The longest day, clocked in at 12:10 AM (05:10Z): its end is 12:09 AM tomorrow, so midnight, not minute 9.
    const allDay = shiftConn({
      techRows: [{ id: 'tech-1', shift_start: '00:00:00', shift_end: '23:59:00' }],
      clockRows: [{ technician_id: 'tech-1', clock_in: new Date('2031-03-04T05:10:00Z') }],
    });
    const allDayShiftOf = await loadTechShifts(allDay.conn, { now: NOW });
    expect(allDayShiftOf('tech-1', TODAY)).toEqual({ startMin: 10, endMin: 1440, source: 'clock_in' });
  });

  // The day's length is elapsed time from the clock-in, so its clock end moves with a daylight-saving change.
  test.each([
    // 2031-03-09: 2:00 AM EST becomes 3:00 AM EDT. 05:30Z = 12:30 AM EST; ten hours later is 15:30Z = 11:30 AM EDT.
    ['spring forward, the clock end is an hour later', '2031-03-09', '2031-03-09T05:30:00Z', '2031-03-09T16:00:00Z', { startMin: 30, endMin: 690 }],
    // 2031-11-02: 2:00 AM EDT becomes 1:00 AM EST. 04:30Z = 12:30 AM EDT; ten hours later is 14:30Z = 9:30 AM EST.
    ['fall back, the clock end is an hour earlier', '2031-11-02', '2031-11-02T04:30:00Z', '2031-11-02T15:00:00Z', { startMin: 30, endMin: 570 }],
    // After the change it is start + length again: 12:00Z = 8:00 AM EDT, ten hours later 6:00 PM EDT.
    ['a clock-in after the change, start + length', '2031-03-09', '2031-03-09T12:00:00Z', '2031-03-09T16:00:00Z', { startMin: 480, endMin: 1080 }],
    // The night before the change: 03:30Z on 2031-03-09 is 10:30 PM EST on the 8th; ten hours later is the 9th.
    ['the evening before, still capped at midnight', '2031-03-08', '2031-03-09T03:30:00Z', '2031-03-09T04:00:00Z', { startMin: 1350, endMin: 1440 }],
  ])('a clock-in on a daylight-saving weekend keeps the elapsed length: %s', async (_label, today, clockInAt, now, expected) => {
    gateOn();
    const { conn } = shiftConn({ techRows: [DAY_TECH], clockRows: [{ technician_id: 'tech-1', clock_in: new Date(clockInAt) }] });
    const shiftOf = await loadTechShifts(conn, { now: new Date(now) });
    expect(shiftOf('tech-1', today)).toEqual({ ...expected, source: 'clock_in' });
  });

  test('the day never ends before its clock-in on the clock (a short day inside the repeated hour)', async () => {
    gateOn();
    // 2031-11-02: 05:30Z = 1:30 AM EDT; 45 minutes later is 06:15Z = 1:15 AM EST, earlier on the clock.
    const { conn } = shiftConn({
      techRows: [{ id: 'tech-1', shift_start: '08:00:00', shift_end: '08:45:00' }],
      clockRows: [{ technician_id: 'tech-1', clock_in: new Date('2031-11-02T05:30:00Z') }],
    });
    const shiftOf = await loadTechShifts(conn, { now: new Date('2031-11-02T15:00:00Z') });
    expect(shiftOf('tech-1', '2031-11-02')).toEqual({ startMin: 90, endMin: 90, source: 'clock_in' });
  });

  test('a clock-in row with an unreadable time, or for a technician without set hours, is skipped; the others keep theirs', async () => {
    gateOn();
    logger.warn.mockClear();
    const { conn } = shiftConn({
      techRows: [DAY_TECH, { id: 'tech-2', shift_start: '09:00:00', shift_end: '17:00:00' }],
      clockRows: [
        { technician_id: 'tech-1', clock_in: 'not a time' },
        { technician_id: 'tech-9', clock_in: new Date('2031-03-04T12:00:00Z') },
        { technician_id: 'tech-2', clock_in: new Date('2031-03-04T13:10:00Z') },
      ],
    });
    const shiftOf = await loadTechShifts(conn, { now: NOW });
    expect(shiftOf('tech-1', TODAY)).toEqual({ startMin: 480, endMin: 1080, source: 'roster' });
    expect(shiftOf('tech-9', TODAY)).toBeNull();
    // 13:10Z = 8:10 AM EST, and eight hours.
    expect(shiftOf('tech-2', TODAY)).toEqual({ startMin: 490, endMin: 970, source: 'clock_in' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // The statements the shared savepoint read (utils/savepoint-read.js) sent on the transaction.
  const savepointStatements = (conn) => conn.raw.mock.calls.map(([sql]) => sql.replace(/fail_soft_[0-9a-f]+/, 'sp'));

  test('inside a transaction the clock-in read is a shared savepoint read, released when it succeeds', async () => {
    gateOn();
    const { conn, calls } = shiftConn({ techRows: [DAY_TECH], clockRows: [{ technician_id: 'tech-1', clock_in: new Date('2031-03-04T12:52:00Z') }] });
    conn.isTransaction = true;
    conn.raw = jest.fn(async () => undefined);
    const shiftOf = await loadTechShifts(conn, { now: NOW });
    expect(savepointStatements(conn)).toEqual(['SAVEPOINT sp', 'RELEASE SAVEPOINT sp']);
    expect(calls.time_entries).toEqual(expect.arrayContaining([['where', { entry_type: 'shift' }]]));
    expect(shiftOf('tech-1', TODAY)).toEqual({ startMin: 472, endMin: 1072, source: 'clock_in' });
  });

  test('inside a transaction a failed clock-in read rolls back to its savepoint and keeps the set hours', async () => {
    gateOn();
    const { conn } = shiftConn({ techRows: [DAY_TECH], clockError: new Error('time_entries unavailable') });
    conn.isTransaction = true;
    conn.raw = jest.fn(async () => undefined);
    const shiftOf = await loadTechShifts(conn, { now: NOW });
    expect(savepointStatements(conn)).toEqual(['SAVEPOINT sp', 'ROLLBACK TO SAVEPOINT sp', 'RELEASE SAVEPOINT sp']);
    expect(shiftOf('tech-1', TODAY)).toEqual({ startMin: 480, endMin: 1080, source: 'roster' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('time_entries unavailable'));
  });

  test('outside a transaction the clock-in read opens no savepoint', async () => {
    gateOn();
    const { conn } = shiftConn({ techRows: [DAY_TECH] });
    conn.raw = jest.fn(async () => undefined);
    await loadTechShifts(conn, { now: NOW });
    expect(conn.raw).not.toHaveBeenCalled();
  });

  test('a failed clock-in read keeps the set hours for today and logs it', async () => {
    gateOn();
    const { conn } = shiftConn({ techRows: [DAY_TECH], clockError: new Error('time_entries unavailable') });
    const shiftOf = await loadTechShifts(conn, { now: NOW });
    expect(shiftOf('tech-1', TODAY)).toEqual({ startMin: 480, endMin: 1080, source: 'roster' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('time_entries unavailable'));
  });

  test('a failed read of the hours throws (as absentTechDays does)', async () => {
    gateOn();
    const conn = jest.fn(() => {
      const chain = { whereNotNull: () => chain, whereIn: () => chain, select: () => Promise.reject(new Error('technicians unavailable')) };
      return chain;
    });
    await expect(loadTechShifts(conn, { now: NOW })).rejects.toThrow('technicians unavailable');
  });

  test('technicianIds narrows the hours read; no technician with hours means no clock-in read', async () => {
    gateOn();
    const narrowed = shiftConn({ techRows: [DAY_TECH] });
    await loadTechShifts(narrowed.conn, { technicianIds: ['tech-1', 'tech-9'], now: NOW });
    expect(narrowed.calls.technicians).toContainEqual(['whereIn', 'id', ['tech-1', 'tech-9']]);

    const empty = shiftConn({ techRows: [{ id: 'tech-3', shift_start: '18:00:00', shift_end: '08:00:00' }] });
    const shiftOf = await loadTechShifts(empty.conn, { now: NOW });
    expect(empty.calls.time_entries).toEqual([]);
    expect(shiftOf('tech-3', TOMORROW)).toBeNull();
  });

  test('an empty technician list asks about no one: nothing is read', async () => {
    gateOn();
    const nobody = shiftConn({ techRows: [DAY_TECH] });
    const shiftOf = await loadTechShifts(nobody.conn, { technicianIds: [], now: NOW });
    expect(nobody.conn).not.toHaveBeenCalled();
    expect(shiftOf('tech-1', TOMORROW)).toBeNull();
  });

  describe('at a commit: the job\'s own hours (assertAssignableTechnician `hours`, shiftExcluding)', () => {
    afterEach(() => {
      jest.useRealTimers();
      delete process.env.GATE_TECH_WORK_DAYS;
    });
    const TECH_ROW = { id: 'tech-1', name: 'Tech One', role: 'technician', employment_status: 'active', field_dispatchable: true, active: true };
    const job = (startHour, endHour) => ({ startMin: startHour * 60, endMin: endHour * 60 });
    const hoursReads = (calls) => calls.technicians.filter(([method]) => method === 'select');

    // The assert's own reads (the technician row, the absence row) and the shift reads (the set hours, today's
    // clock-ins), each recorded.
    function commitConn({ tech = TECH_ROW, absence, shiftRows = [DAY_TECH], clockRows = [], shiftError = null, transaction = false } = {}) {
      const calls = { technicians: [], technician_absences: [], time_entries: [] };
      const conn = jest.fn((table) => {
        const chain = {};
        for (const m of ['where', 'whereNot', 'whereNotNull', 'whereNull', 'whereIn', 'whereRaw', 'groupBy', 'select', 'min', 'forShare']) {
          chain[m] = jest.fn((...args) => { calls[table].push([m, ...args]); return chain; });
        }
        chain.first = jest.fn(async () => (table === 'technicians' ? tech : absence));
        const settle = () => (table !== 'technicians'
          ? Promise.resolve(clockRows)
          : shiftError ? Promise.reject(shiftError) : Promise.resolve(shiftRows));
        chain.then = (res, rej) => settle().then(res, rej);
        return chain;
      });
      if (transaction) {
        conn.isTransaction = true;
        conn.raw = jest.fn(async () => ({}));
      }
      return { conn, calls };
    }

    test('gate off: a job outside the set hours is accepted, and the hours are not read', async () => {
      const { conn, calls } = commitConn();
      await expect(assertAssignableTechnician('tech-1', { conn, date: TOMORROW, hours: job(18, 19) })).resolves.toBe(TECH_ROW);
      expect(hoursReads(calls)).toEqual([]);
      expect(calls.time_entries).toEqual([]);
    });

    test('a job inside the shift is accepted, at the shift start and at the shift end', async () => {
      gateOn();
      for (const hours of [job(8, 9), job(17, 18), job(8, 18), job(12, 13)]) {
        const { conn, calls } = commitConn();
        await expect(assertAssignableTechnician('tech-1', { conn, date: TOMORROW, hours })).resolves.toBe(TECH_ROW);
        expect(hoursReads(calls)).toHaveLength(1);
      }
    });

    test('a job that starts before the shift is refused: 422 TECH_NOT_ASSIGNABLE with outsideShift', async () => {
      gateOn();
      const { conn } = commitConn();
      const refusal = await assertAssignableTechnician('tech-1', { conn, date: TOMORROW, hours: { startMin: 479, endMin: 540 } })
        .then(() => null, (err) => err);
      expect(refusal).toMatchObject({
        status: 422,
        statusCode: 422,
        isOperational: true,
        code: NOT_ASSIGNABLE,
        technicianId: 'tech-1',
        outsideShift: true,
        message: 'Technician Tech One is on shift 08:00 to 18:00 on 2031-03-05, not for a job from 07:59 to 09:00, and cannot be assigned work',
      });
      expect(refusal.offDay).toBeUndefined();
    });

    test('a job that ends after the shift end is refused, by one minute too', async () => {
      gateOn();
      for (const hours of [job(17, 19), { startMin: 1020, endMin: 1081 }, job(6, 20)]) {
        const { conn } = commitConn();
        await expect(assertAssignableTechnician('tech-1', { conn, date: TOMORROW, hours }))
          .rejects.toMatchObject({ code: NOT_ASSIGNABLE, outsideShift: true });
      }
    });

    test('a technician without set hours takes any job', async () => {
      gateOn();
      const { conn, calls } = commitConn({ shiftRows: [] });
      await expect(assertAssignableTechnician('tech-1', { conn, date: TOMORROW, hours: job(20, 22) })).resolves.toBe(TECH_ROW);
      expect(calls.time_entries).toEqual([]);
    });

    test('no hours, no date, or a block that is not a block: the shift is not read and the job is left to the other checks', async () => {
      gateOn();
      const notBlocks = [undefined, null, {}, { startMin: 1140 }, { startMin: '1140', endMin: '1200' },
        { startMin: 1200, endMin: 1140 }, { startMin: 1140, endMin: 1140 }, { startMin: NaN, endMin: 1200 }, { startMin: 1140, endMin: Infinity }];
      for (const hours of notBlocks) {
        const { conn, calls } = commitConn();
        await expect(assertAssignableTechnician('tech-1', { conn, date: TOMORROW, hours })).resolves.toBe(TECH_ROW);
        expect(hoursReads(calls)).toEqual([]);
      }
      const noDate = commitConn();
      await expect(assertAssignableTechnician('tech-1', { conn: noDate.conn, hours: job(19, 20) })).resolves.toBe(TECH_ROW);
      expect(hoursReads(noDate.calls)).toEqual([]);
    });

    test('today follows the clock-in: a 07:30 clock-in ends today at 17:30, and tomorrow keeps the set hours', async () => {
      gateOn();
      jest.useFakeTimers({ now: NOW });
      const clockRows = [{ technician_id: 'tech-1', clock_in: new Date('2031-03-04T12:30:00Z') }];
      const attempt = (date, hours) => assertAssignableTechnician('tech-1', { conn: commitConn({ clockRows }).conn, date, hours });
      await expect(attempt(TODAY, { startMin: 450, endMin: 510 })).resolves.toBe(TECH_ROW);
      await expect(attempt(TODAY, job(17, 18))).rejects.toMatchObject({
        outsideShift: true,
        message: expect.stringContaining('is on shift 07:30 to 17:30 on 2031-03-04, not for a job from 17:00 to 18:00,'),
      });
      await expect(attempt(TOMORROW, job(17, 18))).resolves.toBe(TECH_ROW);
      await expect(attempt(TOMORROW, { startMin: 450, endMin: 510 })).rejects.toMatchObject({ outsideShift: true });
    });

    test('another refusal comes first: the hours are not read, and the error keeps its own flag', async () => {
      gateOn();
      process.env.GATE_TECH_WORK_DAYS = 'true';
      const outside = job(19, 20);
      const inactive = commitConn({ tech: { ...TECH_ROW, employment_status: 'inactive' } });
      const absent = commitConn({ absence: { id: 'abs-1' } });
      // 2031-03-05 is a Wednesday; this technician works Monday and Tuesday.
      const offDay = commitConn({ tech: { ...TECH_ROW, work_days: [1, 2] } });
      for (const { conn, calls } of [inactive, absent, offDay]) {
        const refusal = await assertAssignableTechnician('tech-1', { conn, date: TOMORROW, workDays: true, hours: outside })
          .then(() => null, (err) => err);
        expect(refusal).toMatchObject({ code: NOT_ASSIGNABLE });
        expect(refusal.outsideShift).toBeUndefined();
        expect(hoursReads(calls)).toEqual([]);
      }
      await expect(assertAssignableTechnician('tech-1', { conn: offDay.conn, date: TOMORROW, workDays: true, hours: outside }))
        .rejects.toMatchObject({ offDay: true, message: expect.stringContaining('does not work on Wednesdays') });
      // On a day the technician works, the same job is refused for the shift.
      await expect(assertAssignableTechnician('tech-1', { conn: offDay.conn, date: TODAY, workDays: true, hours: outside }))
        .rejects.toMatchObject({ outsideShift: true });
    });

    test('the hours are read for that technician only, on the caller\'s connection (a transaction: FOR SHARE row, savepoint clock-in read)', async () => {
      gateOn();
      db.mockClear();
      const { conn, calls } = commitConn({ transaction: true });
      await expect(assertAssignableTechnician('tech-1', { conn, date: TOMORROW, hours: job(9, 10) })).resolves.toBe(TECH_ROW);
      expect(calls.technicians).toContainEqual(['forShare']);
      expect(calls.technicians).toContainEqual(['whereIn', 'id', ['tech-1']]);
      expect(calls.time_entries).toContainEqual(['whereIn', 'technician_id', ['tech-1']]);
      expect(conn.raw.mock.calls.map(([sql]) => sql.split(' ')[0])).toEqual(['SAVEPOINT', 'RELEASE']);
      expect(db).not.toHaveBeenCalled();
    });

    test('a failed read of the hours fails the commit: the job is not confirmed on a guess', async () => {
      gateOn();
      const { conn } = commitConn({ shiftError: new Error('technicians unavailable') });
      const failure = await assertAssignableTechnician('tech-1', { conn, date: TOMORROW, hours: job(19, 20) }).then(() => null, (err) => err);
      expect(failure.message).toBe('technicians unavailable');
      expect(failure.code).toBeUndefined();
    });

    test('shiftExcluding: the shift a job does not fit, null for a job that fits, and no read without a technician', async () => {
      gateOn();
      const at = (technicianId, date, hours, options) => {
        const made = commitConn(options);
        return shiftExcluding(made.conn, technicianId, date, hours).then((answer) => ({ answer, calls: made.calls, conn: made.conn }));
      };
      expect((await at('tech-1', TOMORROW, job(17, 19))).answer).toEqual({ startMin: 480, endMin: 1080, source: 'roster' });
      expect((await at('tech-1', TOMORROW, job(7, 9))).answer).toEqual({ startMin: 480, endMin: 1080, source: 'roster' });
      expect((await at('tech-1', TOMORROW, job(8, 18))).answer).toBeNull();
      expect((await at('tech-1', TOMORROW, job(17, 19), { shiftRows: [] })).answer).toBeNull();
      // A pg DATE read back as a Date reads the same.
      expect((await at('tech-1', new Date('2031-03-05T00:00:00Z'), job(17, 19))).answer).toMatchObject({ endMin: 1080 });
      for (const technicianId of [null, undefined, '']) {
        const unassigned = await at(technicianId, TOMORROW, job(17, 19));
        expect(unassigned.answer).toBeNull();
        expect(unassigned.conn).not.toHaveBeenCalled();
      }
      delete process.env.GATE_TECH_SHIFT_HOURS;
      const off = await at('tech-1', TOMORROW, job(17, 19));
      expect(off.answer).toBeNull();
      expect(off.conn).not.toHaveBeenCalled();
    });
  });
});

