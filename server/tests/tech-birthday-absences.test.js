// Technician birthdays as technician_absences rows (owner 2026-11-24): pure date logic and the write rules
// against a knex double. The real Postgres run is tech-birthday-absences-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn(async () => []) }));
jest.mock('../config/feature-gates', () => ({ techBirthdayPayLive: jest.fn(() => false) }));
jest.mock('../services/payroll-time-off', () => ({ createTimeOff: jest.fn(async () => ({ entry: {} })) }));

const logger = require('../services/logger');
const { lockTechDays } = require('../services/scheduling/tech-day-lock');
const { techBirthdayPayLive } = require('../config/feature-gates');
const { createTimeOff } = require('../services/payroll-time-off');
const {
  HORIZON_DAYS, ABSENCE_REASON, CATCH_UP_DAYS, PAY_KIND, PAY_HOURS, PAY_NOTE, birthdayDateInYear, birthdayDatesBetween, syncTechDaysOff,
} = require('../services/tech-birthday-absences');

beforeEach(() => {
  jest.clearAllMocks();
  techBirthdayPayLive.mockReturnValue(false);
});

describe('date logic (pure)', () => {
  test('a birthday keeps its month and day in any year; the birth year never matters', () => {
    expect(birthdayDateInYear('1990-07-14', 2026)).toBe('2026-07-14');
    expect(birthdayDateInYear('2005-07-14', 2027)).toBe('2027-07-14');
    expect(birthdayDateInYear(new Date('1990-07-14T00:00:00.000Z'), 2026)).toBe('2026-07-14');
  });

  test('Feb 29 is kept on Feb 28 in a common year and on Feb 29 in a leap year', () => {
    expect(birthdayDateInYear('1992-02-29', 2027)).toBe('2027-02-28');
    expect(birthdayDateInYear('1992-02-29', 2100)).toBe('2100-02-28'); // 2100 is not a leap year
    expect(birthdayDateInYear('1992-02-29', 2028)).toBe('2028-02-29');
    expect(birthdayDateInYear('1992-02-29', 2000)).toBe('2000-02-29');
  });

  test('a NULL, empty or impossible dob has no birthday', () => {
    for (const dob of [null, undefined, '', 'soon', '1990-13-40', '1991-02-29']) {
      expect(birthdayDateInYear(dob, 2026)).toBeNull();
      expect(birthdayDatesBetween(dob, '2026-01-01', '2026-12-31')).toEqual([]);
    }
  });

  test('a range holds each birthday inside it, inclusive, across a new year', () => {
    expect(birthdayDatesBetween('1990-07-14', '2026-07-14', '2026-07-14')).toEqual(['2026-07-14']);
    expect(birthdayDatesBetween('1990-07-14', '2026-07-15', '2027-07-13')).toEqual([]);
    expect(birthdayDatesBetween('1990-01-05', '2026-12-20', '2028-01-10')).toEqual(['2027-01-05', '2028-01-05']);
    expect(birthdayDatesBetween('1992-02-29', '2027-02-01', '2029-03-31')).toEqual(['2027-02-28', '2028-02-29', '2029-02-28']);
  });

  test('the reason is the generic one tech-out already accepts, with no birthday wording', () => {
    const { REASONS } = require('../services/tech-out');
    expect(REASONS).toContain(ABSENCE_REASON);
    expect(ABSENCE_REASON).toBe('other');
    expect(HORIZON_DAYS).toBe(120);
  });
});

describe('syncTechDaysOff (knex double)', () => {
  // technicians -> `techs`; technician_absences -> the rows already there (any, cleared or not); payroll_time_off -> `timeOff`;
  // audit_log -> `audit`; inserts into technician_absences are recorded.
  function makeConn({ techs = [], absences = [], timeOff = [], audit = [] } = {}) {
    const inserted = [];
    const tableOf = (table) => {
      if (table === 'technicians') {
        const q = {
          where: jest.fn(() => q), whereNotNull: jest.fn(() => q), whereIn: jest.fn(() => q), select: jest.fn(async () => techs),
        };
        return q;
      }
      if (table === 'payroll_time_off') {
        const q = { where: jest.fn((c) => { q.c = c; return q; }), first: jest.fn(async () => timeOff.find((r) => r.technician_id === q.c.technician_id && r.work_date === q.c.work_date)) };
        return q;
      }
      if (table === 'audit_log') {
        const q = { where: jest.fn(() => q), whereRaw: jest.fn((_sql, [id, date]) => { q.k = [id, date]; return q; }), first: jest.fn(async () => audit.find((r) => r.technician_id === q.k[0] && r.work_date === q.k[1])) };
        return q;
      }
      const filter = {};
      let openOnly = false;
      const q = {
        where: jest.fn((cond) => { Object.assign(filter, cond); return q; }),
        whereNull: jest.fn(() => { openOnly = true; return q; }),
        first: jest.fn(async () => absences.find((a) => a.technician_id === filter.technician_id && a.absence_date === filter.absence_date
          && (!openOnly || !a.cleared_at))),
        insert: jest.fn(async (row) => { inserted.push(row); absences.push({ ...row }); }),
      };
      return q;
    };
    const conn = jest.fn(tableOf);
    conn.raw = jest.fn((sql) => sql);
    conn.transaction = jest.fn(async (fn) => fn(conn));
    return { conn, inserted, absences };
  }
  // 2026-11-24 12:00 ET
  const NOW = new Date('2026-11-24T17:00:00Z');

  test('writes one generic absence row per birthday inside the next 120 days, directly', async () => {
    const { conn, inserted } = makeConn({ techs: [
      { id: 't1', dob: '1990-12-02' }, // inside
      { id: 't2', dob: '1985-03-24' }, // exactly on day 120
      { id: 't3', dob: '1979-03-25' }, // one day past
      { id: 't4', dob: '1980-11-23' }, // yesterday: next one is in 2027-11, past the horizon
    ] });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(inserted).toEqual([
      { technician_id: 't1', absence_date: '2026-12-02', reason: 'other' },
      { technician_id: 't2', absence_date: '2027-03-24', reason: 'other' },
    ]);
    expect(out).toMatchObject({ technicians: 4, written: 2, skipped: 0, failed: 0 });
    // each row is written under the tech-day fence, never through markTechOut (no alert, no parked stop)
    expect(lockTechDays).toHaveBeenCalledWith(expect.anything(), [{ techId: 't1', date: '2026-12-02' }]);
    expect(conn.mock.calls.every(([table]) => table === 'technicians' || table === 'technician_absences')).toBe(true);
    expect(createTimeOff).not.toHaveBeenCalled(); // the pay half is dark
  });

  test('today counts: a birthday today is written', async () => {
    const { conn, inserted } = makeConn({ techs: [{ id: 't1', dob: '1990-11-24' }] });
    await syncTechDaysOff({ now: NOW, conn });
    expect(inserted.map((r) => r.absence_date)).toEqual(['2026-11-24']);
  });

  test('Feb 29 lands on Feb 28 in a common year', async () => {
    const { conn, inserted } = makeConn({ techs: [{ id: 't1', dob: '1992-02-29' }] });
    await syncTechDaysOff({ now: NOW, conn });
    expect(inserted.map((r) => r.absence_date)).toEqual(['2027-02-28']);
  });

  test('never writes when the technician already has an uncleared absence that date', async () => {
    const { conn, inserted } = makeConn({
      techs: [{ id: 't1', dob: '1990-12-02' }],
      absences: [{ technician_id: 't1', absence_date: '2026-12-02', reason: 'sick', cleared_at: null }],
    });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(inserted).toEqual([]);
    expect(out).toMatchObject({ written: 0, skipped: 1 });
  });

  test('never re-creates a row the office cleared', async () => {
    const { conn, inserted } = makeConn({
      techs: [{ id: 't1', dob: '1990-12-02' }],
      absences: [{ technician_id: 't1', absence_date: '2026-12-02', reason: 'other', cleared_at: new Date('2026-11-25T14:00:00Z') }],
    });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(inserted).toEqual([]);
    expect(out).toMatchObject({ written: 0, skipped: 1 });
  });

  test('a second tick the same day writes nothing', async () => {
    const harness = makeConn({ techs: [{ id: 't1', dob: '1990-12-02' }] });
    expect((await syncTechDaysOff({ now: NOW, conn: harness.conn })).written).toBe(1);
    expect((await syncTechDaysOff({ now: NOW, conn: harness.conn })).written).toBe(0);
    expect(harness.inserted).toHaveLength(1);
  });

  test('a technician with no dob writes nothing, and the read is limited to active technicians with a dob', async () => {
    const { conn, inserted } = makeConn({ techs: [] });
    await syncTechDaysOff({ now: NOW, conn });
    expect(inserted).toEqual([]);
    const q = conn.mock.results[0].value;
    expect(q.where).toHaveBeenCalledWith('employment_status', 'active');
    expect(q.whereNotNull).toHaveBeenCalledWith('dob');
  });

  test('one failed day is logged without birthday wording and the rest still run', async () => {
    const { conn } = makeConn({ techs: [{ id: 't1', dob: '1990-12-02' }, { id: 't2', dob: '1990-12-03' }] });
    let calls = 0;
    conn.transaction.mockImplementation(async (fn) => {
      calls += 1;
      if (calls === 1) throw new Error('db hiccup');
      return fn(conn);
    });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(out).toMatchObject({ written: 1, failed: 1 });
    const logged = [...logger.error.mock.calls, ...logger.info.mock.calls].map(([m]) => m).join('\n');
    expect(logged).toMatch(/\[tech-days-off\]/);
    expect(logged).not.toMatch(/birth/i);
  });

  test('the horizon comes from one captured instant, across a DST change', async () => {
    // 2027-03-13 23:30 ET (spring forward is the next morning): 120 days on is 2027-07-11, whatever the clock offset.
    const at = new Date('2027-03-14T03:30:00Z');
    const { conn, inserted } = makeConn({ techs: [{ id: 't1', dob: '1990-07-11' }, { id: 't2', dob: '1990-07-12' }] });
    await syncTechDaysOff({ now: at, conn });
    expect(inserted.map((r) => r.absence_date)).toEqual(['2027-07-11']);
  });

  test('a limit of technician ids reaches the read', async () => {
    const { conn } = makeConn({ techs: [] });
    await syncTechDaysOff({ now: NOW, conn, technicianIds: ['t1'] });
    expect(conn.mock.results[0].value.whereIn).toHaveBeenCalledWith('id', ['t1']);
  });
});

describe('the pay half (GATE_TECH_BIRTHDAY_PAY)', () => {
  const NOW = new Date('2026-11-24T17:00:00Z');
  const TODAY = '2026-11-24';
  const w2 = (extra = {}) => ({ id: 't1', dob: '1990-11-24', employment_type: 'w2', ...extra });

  // reuse the harness from the block above through a small copy
  function conn2({ techs, absences = [], timeOff = [], audit = [] }) {
    const inserted = [];
    const tableOf = (table) => {
      const filter = {};
      let raw = null;
      const q = {
        where: jest.fn((c) => { Object.assign(filter, c); return q; }),
        whereNull: jest.fn(() => { filter.open = true; return q; }),
        whereNotNull: jest.fn(() => q),
        whereIn: jest.fn(() => q),
        whereRaw: jest.fn((_s, args) => { raw = args; return q; }),
        select: jest.fn(async () => techs),
        insert: jest.fn(async (row) => { inserted.push(row); absences.push({ ...row }); }),
        first: jest.fn(async () => {
          if (table === 'technician_absences') {
            return absences.find((a) => a.technician_id === filter.technician_id && a.absence_date === filter.absence_date && (!filter.open || !a.cleared_at));
          }
          if (table === 'payroll_time_off') return timeOff.find((r) => r.technician_id === filter.technician_id && r.work_date === filter.work_date);
          if (table === 'audit_log') return audit.find((r) => r.technician_id === raw[0] && r.work_date === raw[1]);
          if (table === 'technicians') {
            const row = techs.find((x) => x.id === filter.id);
            return row && { employment_status: 'active', field_dispatchable: true, ...row };
          }
          return undefined;
        }),
      };
      return q;
    };
    const conn = jest.fn(tableOf);
    conn.raw = jest.fn((sql) => sql);
    conn.transaction = jest.fn(async (fn) => fn(conn));
    return { conn, inserted };
  }

  const syncOneTick = (conn) => syncTechDaysOff({ now: NOW, conn });

  beforeEach(() => techBirthdayPayLive.mockReturnValue(true));

  test('gate off: nothing is recorded for pay, and no pay table is read', async () => {
    techBirthdayPayLive.mockReturnValue(false);
    const { conn } = conn2({ techs: [w2()] });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(out).toMatchObject({ written: 1, paid: 0, paySkipped: 0 });
    expect(createTimeOff).not.toHaveBeenCalled();
    expect(conn.mock.calls.map(([t]) => t)).not.toContain('payroll_time_off');
  });

  test('gate on, on the day: one 10 hour holiday entry through the payroll time-off service, with a generic note', async () => {
    const { conn } = conn2({ techs: [w2()] });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(out).toMatchObject({ written: 1, paid: 1, paySkipped: 0, failed: 0 });
    expect(createTimeOff).toHaveBeenCalledTimes(1);
    expect(createTimeOff).toHaveBeenCalledWith({
      technicianId: 't1', workDate: TODAY, kind: 'holiday', hours: 10, note: 'Paid day off',
    }, null, conn);
    expect([PAY_KIND, PAY_HOURS, PAY_NOTE]).toEqual(['holiday', 10, 'Paid day off']);
    expect(PAY_NOTE).not.toMatch(/birth/i);
  });

  test('the entry is written under the tech-day lock, in the transaction that re-reads the open absence', async () => {
    const { conn } = conn2({ techs: [w2()] });
    await syncOneTick(conn);
    // one fence for the absence row, one for the pay transaction; the service call gets the transaction handle
    expect(lockTechDays).toHaveBeenCalledTimes(2);
    expect(lockTechDays).toHaveBeenLastCalledWith(conn, [{ techId: 't1', date: TODAY }]);
    expect(createTimeOff.mock.calls[0][2]).toBe(conn);
  });

  test('a missed tick is made up for CATCH_UP_DAYS days: a past birthday is paid, no absence row is written for it, and nothing older', async () => {
    const recent = conn2({ techs: [w2({ dob: '1990-11-20' })], absences: [{ technician_id: 't1', absence_date: '2026-11-20', reason: 'other', cleared_at: null }] });
    expect(await syncTechDaysOff({ now: NOW, conn: recent.conn })).toMatchObject({ written: 0, paid: 1 });
    expect(recent.inserted).toEqual([]);
    expect(createTimeOff).toHaveBeenCalledWith(expect.objectContaining({ workDate: '2026-11-20' }), null, recent.conn);
    createTimeOff.mockClear();
    const old = conn2({ techs: [w2({ dob: String(`1990-11-${24 - CATCH_UP_DAYS - 1}`) })], absences: [{ technician_id: 't1', absence_date: `2026-11-${24 - CATCH_UP_DAYS - 1}`, reason: 'other', cleared_at: null }] });
    expect(await syncTechDaysOff({ now: NOW, conn: old.conn })).toMatchObject({ paid: 0 });
    expect(createTimeOff).not.toHaveBeenCalled();
    // a past birthday with no absence row (the tick never wrote one) pays nothing
    const none = conn2({ techs: [w2({ dob: '1990-11-20' })] });
    expect(await syncTechDaysOff({ now: NOW, conn: none.conn })).toMatchObject({ written: 0, paid: 0, paySkipped: 1 });
  });

  test('a birthday still ahead pays nothing yet', async () => {
    const { conn } = conn2({ techs: [w2({ dob: '1990-12-02' })] });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(out).toMatchObject({ written: 1, paid: 0, paySkipped: 0 });
    expect(createTimeOff).not.toHaveBeenCalled();
  });

  test('never over an entry the office made for that date', async () => {
    const { conn } = conn2({ techs: [w2()], timeOff: [{ technician_id: 't1', work_date: TODAY }] });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(out).toMatchObject({ paid: 0, paySkipped: 1 });
    expect(createTimeOff).not.toHaveBeenCalled();
  });

  test('never again for an entry once added and since removed (audit log)', async () => {
    const { conn } = conn2({ techs: [w2()], audit: [{ technician_id: 't1', work_date: TODAY }] });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(out).toMatchObject({ paid: 0, paySkipped: 1 });
    expect(createTimeOff).not.toHaveBeenCalled();
  });

  test('a technician who changed since the roster was read pays nothing: deactivated, office staff, or a corrected date of birth', async () => {
    for (const change of [{ employment_status: 'inactive' }, { field_dispatchable: false }, { dob: '1990-11-25' }, { employment_type: '1099' }]) {
      const { conn } = conn2({ techs: [w2()] });
      // the pass reads the roster once, then the pay transaction reads the row again
      let reads = 0;
      const base = conn.getMockImplementation();
      conn.mockImplementation((table) => {
        const q = base(table);
        if (table === 'technicians') {
          const select = q.select;
          const first = q.first;
          q.select = jest.fn(async (...a) => { reads += 1; return select(...a); });
          q.first = jest.fn(async (...a) => ({ ...(await first(...a)), ...change }));
        }
        return q;
      });
      const out = await syncTechDaysOff({ now: NOW, conn });
      expect(out).toMatchObject({ paid: 0, paySkipped: 1 });
      expect(reads).toBe(1);
    }
    expect(createTimeOff).not.toHaveBeenCalled();
  });

  test('the roster read takes only field-dispatchable active technicians (office staff and admins get no days off)', async () => {
    const { conn } = conn2({ techs: [] });
    await syncTechDaysOff({ now: NOW, conn });
    expect(conn.mock.results[0].value.where).toHaveBeenCalledWith('field_dispatchable', true);
  });

  test('a cleared absence row pays nothing, and neither does a technician who is not W-2', async () => {
    const cleared = conn2({ techs: [w2()], absences: [{ technician_id: 't1', absence_date: TODAY, reason: 'other', cleared_at: new Date() }] });
    expect(await syncTechDaysOff({ now: NOW, conn: cleared.conn })).toMatchObject({ paid: 0, paySkipped: 1 });
    const contractor = conn2({ techs: [w2({ employment_type: '1099' })] });
    expect(await syncTechDaysOff({ now: NOW, conn: contractor.conn })).toMatchObject({ paid: 0, paySkipped: 1 });
    expect(createTimeOff).not.toHaveBeenCalled();
  });

  test('a 409 from the service (a final week, a row that appeared) is a skip; any other error is a failure', async () => {
    createTimeOff.mockRejectedValueOnce(Object.assign(new Error('final'), { name: 'PayrollError', status: 409 }));
    const a = conn2({ techs: [w2()] });
    expect(await syncTechDaysOff({ now: NOW, conn: a.conn })).toMatchObject({ paid: 0, paySkipped: 1, failed: 0 });
    createTimeOff.mockRejectedValueOnce(new Error('db down'));
    const b = conn2({ techs: [w2()] });
    expect(await syncTechDaysOff({ now: NOW, conn: b.conn })).toMatchObject({ paid: 0, failed: 1 });
    const logged = [...logger.error.mock.calls, ...logger.warn.mock.calls, ...logger.info.mock.calls].map(([m]) => m).join('\n');
    expect(logged).toMatch(/\[tech-days-off\]/);
    expect(logged).not.toMatch(/birth/i);
  });

  test('a second tick the same day does not pay again once the entry exists', async () => {
    const timeOff = [];
    createTimeOff.mockImplementation(async ({ technicianId, workDate }) => { timeOff.push({ technician_id: technicianId, work_date: workDate }); return { entry: {} }; });
    const { conn } = conn2({ techs: [w2()], timeOff });
    expect((await syncTechDaysOff({ now: NOW, conn })).paid).toBe(1);
    expect((await syncTechDaysOff({ now: NOW, conn })).paid).toBe(0);
    expect(createTimeOff).toHaveBeenCalledTimes(1);
    createTimeOff.mockImplementation(async () => ({ entry: {} }));
  });
});
