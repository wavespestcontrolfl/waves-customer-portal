// Technician birthdays as technician_absences rows (owner 2026-11-24): pure date logic and the write rules
// against a knex double. The real Postgres run is tech-birthday-absences-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn(async () => []) }));
jest.mock('../services/tech-out', () => ({
  ...jest.requireActual('../services/tech-out'),
  emitAbsenceChange: jest.fn(),
}));

const logger = require('../services/logger');
const { lockTechDays } = require('../services/scheduling/tech-day-lock');
const { emitAbsenceChange } = require('../services/tech-out');
const {
  HORIZON_DAYS, ABSENCE_REASON, birthdayDateInYear, birthdayDatesBetween, syncTechDaysOff,
} = require('../services/tech-birthday-absences');

beforeEach(() => {
  jest.clearAllMocks();
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

// technicians -> `techs`; technician_absences -> the rows already there (any, cleared or not); inserts are recorded.
function makeConn({ techs = [], absences = [] } = {}) {
  const inserted = [];
  const tableOf = (table) => {
    if (table === 'technicians') {
      const q = {
        where: jest.fn(() => q), whereNotNull: jest.fn(() => q), whereIn: jest.fn(() => q), select: jest.fn(async () => techs),
      };
      return q;
    }
    const filter = {};
    let openOnly = false;
    const q = {
      where: jest.fn((cond) => { Object.assign(filter, cond); return q; }),
      whereNull: jest.fn(() => { openOnly = true; return q; }),
      first: jest.fn(async () => absences.find((a) => a.technician_id === filter.technician_id && a.absence_date === filter.absence_date
        && (!openOnly || !a.cleared_at))),
      insert: jest.fn((row) => {
        inserted.push(row);
        absences.push({ ...row });
        return { returning: jest.fn(async () => [{ id: `abs-${inserted.length}` }]) };
      }),
    };
    return q;
  };
  const conn = jest.fn(tableOf);
  conn.raw = jest.fn((sql) => sql);
  conn.transaction = jest.fn(async (fn) => fn(conn));
  return { conn, inserted, absences };
}

describe('syncTechDaysOff (knex double)', () => {
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
    expect(logged).not.toMatch(/12-0[23]/); // no date: it would reveal the birthday
    expect(logged).not.toMatch(/db hiccup/);
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

describe('announcing each new row (emitAbsenceChange, as a tech-out mark does)', () => {
  const NOW = new Date('2026-11-24T17:00:00Z');

  test('every inserted row is announced once, after the commit, with its id and out: true', async () => {
    const order = [];
    const { conn } = makeConn({ techs: [{ id: 't1', dob: '1990-12-02' }, { id: 't2', dob: '1990-12-03' }] });
    conn.transaction.mockImplementation(async (fn) => { const out = await fn(conn); order.push('commit'); return out; });
    emitAbsenceChange.mockImplementation(() => order.push('emit'));
    await syncTechDaysOff({ now: NOW, conn });
    expect(emitAbsenceChange).toHaveBeenCalledTimes(2);
    expect(emitAbsenceChange).toHaveBeenNthCalledWith(1, { technicianId: 't1', date: '2026-12-02', out: true, absenceId: 'abs-1' });
    expect(emitAbsenceChange).toHaveBeenNthCalledWith(2, { technicianId: 't2', date: '2026-12-03', out: true, absenceId: 'abs-2' });
    expect(order).toEqual(['commit', 'emit', 'commit', 'emit']);
    emitAbsenceChange.mockReset();
  });

  test('a day already set, a cleared day, a failed write and a second tick announce nothing', async () => {
    const set = makeConn({
      techs: [{ id: 't1', dob: '1990-12-02' }, { id: 't2', dob: '1990-12-03' }],
      absences: [
        { technician_id: 't1', absence_date: '2026-12-02', reason: 'sick', cleared_at: null },
        { technician_id: 't2', absence_date: '2026-12-03', reason: 'other', cleared_at: new Date() },
      ],
    });
    await syncTechDaysOff({ now: NOW, conn: set.conn });
    const failing = makeConn({ techs: [{ id: 't3', dob: '1990-12-04' }] });
    failing.conn.transaction.mockRejectedValue(new Error('db hiccup'));
    expect(await syncTechDaysOff({ now: NOW, conn: failing.conn })).toMatchObject({ written: 0, failed: 1 });
    const again = makeConn({ techs: [{ id: 't4', dob: '1990-12-05' }] });
    await syncTechDaysOff({ now: NOW, conn: again.conn });
    emitAbsenceChange.mockClear();
    await syncTechDaysOff({ now: NOW, conn: again.conn });
    expect(emitAbsenceChange).not.toHaveBeenCalled();
  });

  test('nothing but the technician and absence tables is touched, and no log line carries birthday wording', async () => {
    const { conn } = makeConn({ techs: [{ id: 't1', dob: '1990-11-24' }] });
    await syncTechDaysOff({ now: NOW, conn });
    expect(conn.mock.calls.every(([table]) => table === 'technicians' || table === 'technician_absences')).toBe(true);
    const logged = [...logger.error.mock.calls, ...logger.warn.mock.calls, ...logger.info.mock.calls].map(([m]) => m).join('\n');
    expect(logged).not.toMatch(/birth/i);
  });

  test('the roster read takes only active, field-dispatchable technicians (office staff and admins get no days off)', async () => {
    const { conn } = makeConn({ techs: [] });
    await syncTechDaysOff({ now: NOW, conn });
    expect(conn.mock.results[0].value.where).toHaveBeenCalledWith('field_dispatchable', true);
  });
});
