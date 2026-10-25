// technician-eligibility.js — the one answer to "may this tech take field
// work?" (Field Team Program, Phase 0 item 1). Pure helpers plus the
// save-time assert every visit writer calls.
jest.mock('../models/db', () => jest.fn());

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
} = require('../services/technician-eligibility');

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
