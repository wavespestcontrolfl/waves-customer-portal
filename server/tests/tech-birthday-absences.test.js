// Technician birthdays as technician_absences rows (owner 2026-11-24): pure date logic and the write rules
// against a knex double. The real Postgres run is tech-birthday-absences-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn(async () => []) }));
jest.mock('../services/tech-out', () => ({
  ...jest.requireActual('../services/tech-out'),
  emitAbsenceChange: jest.fn(),
  resolveOverflowAlerts: jest.fn(async () => []),
}));

jest.mock('../services/scheduling/blackout-dates', () => ({ getClosedHolidays: jest.fn(), getBlackoutDates: jest.fn(), lockClosureState: jest.fn(async () => {}) }));

const logger = require('../services/logger');
const { getClosedHolidays, getBlackoutDates, lockClosureState } = require('../services/scheduling/blackout-dates');
const { lockTechDays } = require('../services/scheduling/tech-day-lock');
const { emitAbsenceChange, resolveOverflowAlerts } = require('../services/tech-out');
const {
  HORIZON_DAYS, ABSENCE_REASON, SOURCE, birthdayDateInYear, birthdayDatesBetween, holidayTakenDay, holidayTakenDates, syncTechDaysOff,
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

// technicians -> `techs`; technician_absences -> the rows already there (any, cleared or not); inserts are recorded;
// `owned` is what the reconcile read (technician_absences joined to technicians) returns; updates are applied to `absences`.
function makeConn({ techs = [], absences = [], owned = [], liveTech } = {}) {
  const inserted = [];
  const tableOf = (table) => {
    if (table === 'technicians') {
      let id;
      const q = {
        where: jest.fn((col, val) => { if (col === 'id' || (col && col.id)) id = typeof col === 'object' ? col.id : val; return q; }),
        whereNotNull: jest.fn(() => q),
        whereIn: jest.fn(() => q),
        select: jest.fn(async () => techs),
        // the locked re-read of one technician: `liveTech` when given, else what the reconcile scan saw for it
        first: jest.fn(async () => {
          if (liveTech) return liveTech;
          const seen = owned.find((o) => o.technician_id === id);
          return seen && { employment_status: seen.employment_status, field_dispatchable: seen.field_dispatchable, dob: seen.dob };
        }),
      };
      return q;
    }
    if (table === 'technician_absences as a') {
      const q = {
        join: jest.fn(() => q), where: jest.fn(() => q), whereNull: jest.fn(() => q), whereIn: jest.fn(() => q), select: jest.fn(async () => owned),
      };
      return q;
    }
    const filter = {};
    const nulls = [];
    const matching = () => absences.filter((a) => Object.entries(filter).every(([k, v]) => a[k] === v) && nulls.every((c) => a[c] == null));
    const q = {
      where: jest.fn((col, val) => { if (typeof col === 'object') Object.assign(filter, col); else filter[col] = val; return q; }),
      whereNull: jest.fn((col) => { nulls.push(col); return q; }),
      forUpdate: jest.fn(() => q),
      select: jest.fn(async () => matching()),
      first: jest.fn(async () => matching()[0]),
      update: jest.fn(async (patch) => { matching().forEach((row) => Object.assign(row, patch)); }),
      insert: jest.fn((row) => {
        inserted.push(row);
        absences.push({ id: `abs-${inserted.length}`, ...row });
        return { returning: jest.fn(async () => [{ id: `abs-${inserted.length}` }]) };
      }),
    };
    return q;
  };
  const conn = jest.fn(tableOf);
  conn.raw = jest.fn((sql) => sql);
  conn.fn = { now: jest.fn(() => 'NOW()') };
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
      { technician_id: 't1', absence_date: '2026-12-02', reason: 'other', source: 'tech_days_off' },
      { technician_id: 't2', absence_date: '2027-03-24', reason: 'other', source: 'tech_days_off' },
    ]);
    expect(out).toMatchObject({ technicians: 4, written: 2, skipped: 0, failed: 0 });
    // each row is written under the tech-day fence, never through markTechOut (no alert, no parked stop)
    expect(lockTechDays).toHaveBeenCalledWith(expect.anything(), [{ techId: 't1', date: '2026-12-02' }]);
    expect(conn.mock.calls.every(([table]) => ['technicians', 'technician_absences', 'technician_absences as a'].includes(table))).toBe(true);
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

  test('a technician with no dob and no work_days writes nothing, and the read is limited to active technicians with a dob or work_days', async () => {
    const { conn, inserted } = makeConn({ techs: [] });
    await syncTechDaysOff({ now: NOW, conn });
    expect(inserted).toEqual([]);
    const q = conn.mock.results[0].value;
    expect(q.where).toHaveBeenCalledWith('employment_status', 'active');
    // the dob-or-work_days filter is one grouped where
    const group = q.where.mock.calls.map(([arg]) => arg).find((arg) => typeof arg === 'function');
    expect(group).toBeDefined();
    const inner = { whereNotNull: jest.fn(() => inner), orWhereNotNull: jest.fn(() => inner) };
    group.call(inner);
    expect(inner.whereNotNull).toHaveBeenCalledWith('dob');
    expect(inner.orWhereNotNull).toHaveBeenCalledWith('work_days');
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
    expect(conn.mock.calls.every(([table]) => ['technicians', 'technician_absences', 'technician_absences as a'].includes(table))).toBe(true);
    const logged = [...logger.error.mock.calls, ...logger.warn.mock.calls, ...logger.info.mock.calls].map(([m]) => m).join('\n');
    expect(logged).not.toMatch(/birth/i);
  });

  test('the roster read takes only active, field-dispatchable technicians (office staff and admins get no days off)', async () => {
    const { conn } = makeConn({ techs: [] });
    await syncTechDaysOff({ now: NOW, conn });
    expect(conn.mock.results[0].value.where).toHaveBeenCalledWith('field_dispatchable', true);
  });
});

describe('reconcile and reopen: the sync touches only rows with its own source', () => {
  const NOW = new Date('2026-11-24T17:00:00Z');
  // a row the sync wrote
  const own = (extra = {}) => ({
    id: 'a1', technician_id: 't1', absence_date: '2026-12-02', reason: 'other', note: null, created_by: null,
    source: SOURCE, cleared_at: null, cleared_by: null, system_cleared_at: null, ...extra,
  });
  // what the reconcile read returns for it
  const joined = (extra = {}) => ({
    id: 'a1', technician_id: 't1', date: '2026-12-02', employment_status: 'active', field_dispatchable: true, dob: '1990-12-02', ...extra,
  });
  const systemCleared = (extra = {}) => own({ cleared_at: new Date('2026-11-20T10:00:00Z'), system_cleared_at: new Date('2026-11-20T10:00:00Z'), ...extra });

  test('the sync stamps its source on a new row and says so in its constant', () => {
    expect(SOURCE).toBe('tech_days_off');
  });

  test('a corrected dob clears the old future row (a system clear), writes the new one, and announces both', async () => {
    const { conn, absences } = makeConn({
      techs: [{ id: 't1', dob: '1990-12-05' }], // corrected from Dec 2 to Dec 5
      absences: [own()],
      owned: [joined({ dob: '1990-12-05' })],
    });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(out).toMatchObject({ written: 1, cleared: 1, failed: 0 });
    expect(absences[0]).toMatchObject({ cleared_at: 'NOW()', system_cleared_at: 'NOW()', cleared_by: null });
    expect(absences.find((a) => a.absence_date === '2026-12-05')).toMatchObject({ reason: 'other', source: SOURCE });
    expect(lockTechDays).toHaveBeenCalledWith(expect.anything(), [{ techId: 't1', date: '2026-12-02' }]);
    expect(emitAbsenceChange).toHaveBeenCalledWith({ technicianId: 't1', date: '2026-12-02', out: false, absenceId: 'a1' });
    expect(emitAbsenceChange).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-12-05', out: true }));
    expect(logger.info.mock.calls.map(([m]) => m).join('\n')).toMatch(/1 cleared/);
  });

  test('a clear resolves the parked overflow alerts of that tech-day in the same transaction, through the shared helper', async () => {
    const order = [];
    const { conn } = makeConn({ techs: [], absences: [own()], owned: [joined({ dob: null })] });
    conn.transaction.mockImplementation(async (fn) => { const out = await fn(conn); order.push('commit'); return out; });
    resolveOverflowAlerts.mockImplementation(async () => { order.push('resolve'); return []; });
    await syncTechDaysOff({ now: NOW, conn });
    expect(resolveOverflowAlerts).toHaveBeenCalledWith(conn, { technicianId: 't1', date: '2026-12-02', actorId: null });
    expect(order).toEqual(['resolve', 'commit']);
    resolveOverflowAlerts.mockReset();
    resolveOverflowAlerts.mockResolvedValue([]);
  });

  test.each([
    ['the technician is no longer active', { employment_status: 'inactive' }],
    ['the technician is no longer field-dispatchable', { field_dispatchable: false }],
    ['the dob is now empty', { dob: null }],
  ])('clears the row when %s', async (_label, change) => {
    const { conn, absences } = makeConn({ techs: [], absences: [own()], owned: [joined(change)] });
    expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ written: 0, cleared: 1 });
    expect(absences[0].cleared_at).toBe('NOW()');
  });

  test('a row the dob still gives is kept', async () => {
    const { conn, absences } = makeConn({ techs: [{ id: 't1', dob: '1990-12-02' }], absences: [own()], owned: [joined()] });
    expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ written: 0, skipped: 1, cleared: 0 });
    expect(absences[0].cleared_at).toBeNull();
    expect(emitAbsenceChange).not.toHaveBeenCalled();
  });

  test('the reconcile read asks only for rows with the sync source, uncleared, dated today through the horizon', async () => {
    const { conn } = makeConn({ techs: [], owned: [] });
    await syncTechDaysOff({ now: NOW, conn, technicianIds: ['t1'] });
    const q = conn.mock.results.map((r) => r.value).find((v) => v.join);
    expect(q.where).toHaveBeenCalledWith('a.source', 'tech_days_off');
    expect(q.whereNull).toHaveBeenCalledWith('a.cleared_at');
    expect(q.where).toHaveBeenCalledWith('a.absence_date', '>=', '2026-11-24');
    expect(q.where).toHaveBeenCalledWith('a.absence_date', '<=', '2027-03-24');
    expect(q.whereIn).toHaveBeenCalledWith('a.technician_id', ['t1']);
  });

  test('the locked re-read refuses a row that is no longer open or is not the sync\'s: nothing is changed or announced', async () => {
    for (const row of [own({ source: null }), own({ cleared_at: new Date(), cleared_by: 'office-1' })]) {
      const { conn, absences } = makeConn({ techs: [], absences: [row], owned: [joined({ dob: null })] });
      expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ cleared: 0, failed: 0 });
      expect(absences[0].system_cleared_at).toBe(row.system_cleared_at);
      expect(absences[0].cleared_at).toBe(row.cleared_at);
    }
    expect(emitAbsenceChange).not.toHaveBeenCalled();
    expect(resolveOverflowAlerts).not.toHaveBeenCalled();
  });

  test('a dob removed and then restored starts a NEW episode: a fresh row with a new id, the old system-cleared row left as it is, announced out: true', async () => {
    const { conn, absences } = makeConn({ techs: [{ id: 't1', dob: '1990-12-02' }], absences: [systemCleared()] });
    expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ written: 0, reopened: 1, skipped: 0, failed: 0 });
    expect(absences).toHaveLength(2);
    // the old row is untouched: a manual dismissal keyed to its id (payload.absence_id) cannot cover the new episode
    expect(absences[0]).toMatchObject({ id: 'a1', cleared_by: null });
    expect(absences[0].cleared_at).not.toBeNull();
    expect(absences[0].system_cleared_at).not.toBeNull();
    expect(absences[1]).toMatchObject({ technician_id: 't1', absence_date: '2026-12-02', reason: 'other', source: SOURCE });
    expect(absences[1].id).not.toBe('a1');
    expect(absences[1].cleared_at).toBeUndefined();
    expect(emitAbsenceChange).toHaveBeenCalledWith({ technicianId: 't1', date: '2026-12-02', out: true, absenceId: absences[1].id });
    expect(logger.info.mock.calls.map(([m]) => m).join('\n')).toMatch(/1 reopened/);
  });

  test('several earlier system-cleared episodes on the date still allow one new episode, and an open one blocks it', async () => {
    const earlier = [systemCleared(), systemCleared({ id: 'a0' })];
    const a = makeConn({ techs: [{ id: 't1', dob: '1990-12-02' }], absences: earlier });
    expect(await syncTechDaysOff({ now: NOW, conn: a.conn })).toMatchObject({ reopened: 1 });
    expect(await syncTechDaysOff({ now: NOW, conn: a.conn })).toMatchObject({ reopened: 0, skipped: 1 }); // now one is open
    expect(a.absences).toHaveLength(3);
  });

  test('an office-cleared own row is never reopened (cleared_by set, or no system-clear stamp)', async () => {
    for (const row of [
      systemCleared({ cleared_by: 'office-1', system_cleared_at: null }),
      systemCleared({ cleared_by: 'office-1' }),
      own({ cleared_at: new Date(), cleared_by: null }), // an office clear with no recorded user still has no system stamp
    ]) {
      const { conn, absences } = makeConn({ techs: [{ id: 't1', dob: '1990-12-02' }], absences: [row] });
      expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ written: 0, reopened: 0, skipped: 1 });
      expect(absences[0].cleared_at).toBe(row.cleared_at);
    }
    expect(emitAbsenceChange).not.toHaveBeenCalled();
  });

  test('a system-cleared row is not reopened over another row on the same date', async () => {
    const { conn, absences } = makeConn({
      techs: [{ id: 't1', dob: '1990-12-02' }],
      absences: [systemCleared(), { id: 'x1', technician_id: 't1', absence_date: '2026-12-02', reason: 'sick', source: null, cleared_at: null }],
    });
    expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ reopened: 0, skipped: 1 });
    expect(absences[0].cleared_at).not.toBeNull();
  });

  test('the clear rechecks the technician under the lock: a dob restored (or a tech made active) between the scan and the lock keeps the row open', async () => {
    for (const live of [
      { employment_status: 'active', field_dispatchable: true, dob: '1990-12-02' }, // dob restored: the day is wanted again
    ]) {
      const { conn, absences } = makeConn({ techs: [], absences: [own()], owned: [joined({ dob: null })], liveTech: live });
      expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ cleared: 0, failed: 0 });
      expect(absences[0].cleared_at).toBeNull();
      expect(absences[0].system_cleared_at).toBeNull();
    }
    expect(emitAbsenceChange).not.toHaveBeenCalled();
    expect(resolveOverflowAlerts).not.toHaveBeenCalled();
  });

  test('the clear goes ahead when the locked re-read still shows the technician unwanted for that date', async () => {
    for (const live of [
      { employment_status: 'inactive', field_dispatchable: true, dob: '1990-12-02' },
      { employment_status: 'active', field_dispatchable: false, dob: '1990-12-02' },
      { employment_status: 'active', field_dispatchable: true, dob: null },
      { employment_status: 'active', field_dispatchable: true, dob: '1990-12-05' }, // a different date
    ]) {
      const { conn, absences } = makeConn({ techs: [], absences: [own()], owned: [joined({ dob: null })], liveTech: live });
      expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ cleared: 1, failed: 0 });
      expect(absences[0].cleared_at).toBe('NOW()');
    }
  });

  test('a failed clear is counted, logged with no date and no error text, and the rest still run', async () => {
    const { conn } = makeConn({
      techs: [],
      absences: [own(), own({ id: 'a2', technician_id: 't2' })],
      owned: [joined({ dob: null }), joined({ id: 'a2', technician_id: 't2', dob: null })],
    });
    let calls = 0;
    const base = conn.transaction.getMockImplementation();
    conn.transaction.mockImplementation(async (fn) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('secret db text'), { code: '40P01' });
      return base(fn);
    });
    expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ cleared: 1, failed: 1 });
    const logged = logger.error.mock.calls.map(([m]) => m).join('\n');
    expect(logged).toMatch(/\[tech-days-off\].*t1.*40P01/);
    expect(logged).not.toMatch(/2026-12|secret|birth/i);
  });
});

// ---- Holiday taken days (owner 2026-11-24, Employee Handbook: Holidays) ----------------------------------------------
const MON_THU = [1, 2, 3, 4];
const BIG6 = new Set(['new_years_day', 'memorial_day', 'independence_day', 'labor_day', 'thanksgiving', 'christmas']);
// Waves' own closed dates around the cases below, as getBlackoutDates would answer (observed weekdays included).
const CLOSED_DATES = new Set(['2026-11-26', '2026-12-25', '2027-01-01', '2027-05-31', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24']);

describe('holiday taken days (pure)', () => {
  test('Christmas 2026 is a Friday: a Monday to Thursday technician takes Thursday 12-24', () => {
    expect(holidayTakenDay(MON_THU, '2026-12-25')).toBe('2026-12-24');
    expect(holidayTakenDates(MON_THU, BIG6, '2026-11-24', '2027-03-24', CLOSED_DATES)).toEqual(['2026-12-24', '2026-12-31']);
  });

  test("New Year's Day 2027 is a Friday: Thursday 12-31", () => {
    expect(holidayTakenDates(MON_THU, new Set(['new_years_day']), '2026-12-01', '2027-01-31', CLOSED_DATES)).toEqual(['2026-12-31']);
  });

  test('July 4 2027 is a Sunday: the Monday after is closed by Waves as the observed day, so no row', () => {
    expect(holidayTakenDay(MON_THU, '2027-07-04')).toBe('2027-07-05');
    expect(holidayTakenDates(MON_THU, new Set(['independence_day']), '2027-06-01', '2027-08-01', CLOSED_DATES)).toEqual([]);
    // the same Sunday with the observed Monday open (a technician view with no business closure) would be the Monday
    expect(holidayTakenDates(MON_THU, new Set(['independence_day']), '2027-06-01', '2027-08-01', new Set())).toEqual(['2027-07-05']);
  });

  test('a Saturday holiday goes to the work day before it in the same week (July 4 2026)', () => {
    expect(holidayTakenDay(MON_THU, '2026-07-04')).toBe('2026-07-02');
  });

  test('Thanksgiving is a Thursday, a work day: no row. A Monday holiday for a Monday to Thursday technician: no row', () => {
    expect(holidayTakenDay(MON_THU, '2026-11-26')).toBeNull();
    expect(holidayTakenDates(MON_THU, new Set(['thanksgiving', 'memorial_day', 'labor_day']), '2026-01-01', '2027-12-31', CLOSED_DATES)).toEqual([]);
  });

  test('a Monday to Thursday week has a nearest earlier work day for Tuesday to Saturday holidays, none for a technician who works only later days', () => {
    expect(holidayTakenDay([2, 3, 4, 5], '2026-12-25')).toBeNull(); // works Friday: covered
    expect(holidayTakenDay([3, 4], '2026-12-28')).toBeNull(); // a Monday: nothing earlier in the week
    expect(holidayTakenDay([3, 4], '2026-12-26')).toBe('2026-12-24'); // a Saturday: Thursday
    expect(holidayTakenDay([6], '2027-07-02')).toBeNull(); // Friday, only Saturday works: nothing earlier
    expect(holidayTakenDay([6], '2027-07-04')).toBe('2027-07-10'); // Sunday: the first work day after it
    expect(holidayTakenDay([0], '2027-07-04')).toBeNull(); // works Sunday
  });

  test('NULL, empty or unreadable work_days, an all-seven list, and no closed holiday give nothing', () => {
    for (const wd of [null, undefined, [], 'junk', [0, 1, 2, 3, 4, 5, 6], [9]]) {
      expect(holidayTakenDates(wd, BIG6, '2026-11-24', '2027-03-24', CLOSED_DATES)).toEqual([]);
    }
    expect(holidayTakenDates(MON_THU, new Set(), '2026-11-24', '2027-03-24', CLOSED_DATES)).toEqual([]);
  });

  test('a holiday just outside the window still gives its taken day inside it, and the window bounds apply to the taken day', () => {
    // Saturday 2026-12-26 style: a window that starts on the taken Thursday keeps it; one that starts after drops it
    expect(holidayTakenDates(MON_THU, new Set(['christmas']), '2026-12-24', '2026-12-24', CLOSED_DATES)).toEqual(['2026-12-24']);
    expect(holidayTakenDates(MON_THU, new Set(['christmas']), '2026-12-25', '2027-02-01', CLOSED_DATES)).toEqual([]);
  });

  test('a work_days value in the Postgres text form reads like the array', () => {
    expect(holidayTakenDates('{1,2,3,4}', BIG6, '2026-11-24', '2027-01-31', CLOSED_DATES)).toEqual(['2026-12-24', '2026-12-31']);
  });
});

describe('syncTechDaysOff: holiday taken days (knex double)', () => {
  const NOW = new Date('2026-11-24T17:00:00Z');
  const own = (date, extra = {}) => ({
    id: `own-${date}`, technician_id: 't1', absence_date: date, reason: 'other', note: null, created_by: null,
    source: SOURCE, cleared_at: null, cleared_by: null, system_cleared_at: null, ...extra,
  });
  const joinedRow = (date, extra = {}) => ({
    id: `own-${date}`, technician_id: 't1', date, employment_status: 'active', field_dispatchable: true, dob: null, work_days: MON_THU, ...extra,
  });

  // the technician as the locked re-read of a holiday write sees it
  const LIVE = { employment_status: 'active', field_dispatchable: true, work_days: MON_THU, dob: null };

  beforeEach(() => {
    getClosedHolidays.mockReset().mockResolvedValue(BIG6);
    getBlackoutDates.mockReset().mockResolvedValue(CLOSED_DATES);
  });

  test('writes the taken Thursdays for a Monday to Thursday technician, through blackout-dates, as ordinary rows', async () => {
    const { conn, inserted } = makeConn({ techs: [{ id: 't1', dob: null, work_days: MON_THU }], liveTech: LIVE });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(inserted).toEqual([
      { technician_id: 't1', absence_date: '2026-12-24', reason: 'other', source: 'tech_days_off' },
      { technician_id: 't1', absence_date: '2026-12-31', reason: 'other', source: 'tech_days_off' },
    ]);
    expect(out).toMatchObject({ written: 2, failed: 0 });
    expect(getClosedHolidays).toHaveBeenCalledWith(conn, { strict: true });
    expect(getBlackoutDates).toHaveBeenCalledWith('2026-11-24', '2027-03-24', conn, { strict: true });
    expect(emitAbsenceChange).toHaveBeenCalledTimes(2);
  });

  test('NULL work_days reads no settings and writes no holiday row', async () => {
    const { conn, inserted } = makeConn({ techs: [{ id: 't1', dob: null, work_days: null }] });
    expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ written: 0, failed: 0 });
    expect(inserted).toEqual([]);
    expect(getClosedHolidays).not.toHaveBeenCalled();
    expect(getBlackoutDates).not.toHaveBeenCalled();
  });

  test('a birthday on the same date as a holiday taken day is one row', async () => {
    const { conn, inserted } = makeConn({ techs: [{ id: 't1', dob: '1990-12-24', work_days: MON_THU }], liveTech: { ...LIVE, dob: '1990-12-24' } });
    await syncTechDaysOff({ now: NOW, conn });
    expect(inserted.map((r) => r.absence_date)).toEqual(['2026-12-24', '2026-12-31']);
  });

  test('a holiday reopened in settings clears its row as a system clear', async () => {
    getClosedHolidays.mockResolvedValue(new Set(['new_years_day'])); // Christmas reopened
    getBlackoutDates.mockResolvedValue(new Set(['2027-01-01']));
    const { conn, absences } = makeConn({
      techs: [{ id: 't1', dob: null, work_days: MON_THU }],
      absences: [own('2026-12-24'), own('2026-12-31')],
      owned: [joinedRow('2026-12-24'), joinedRow('2026-12-31')],
    });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(out).toMatchObject({ cleared: 1, written: 0, failed: 0 });
    expect(absences.find((a) => a.absence_date === '2026-12-24')).toMatchObject({ cleared_at: 'NOW()', system_cleared_at: 'NOW()', cleared_by: null });
    expect(absences.find((a) => a.absence_date === '2026-12-31').cleared_at).toBeNull();
    expect(resolveOverflowAlerts).toHaveBeenCalledWith(expect.anything(), { technicianId: 't1', date: '2026-12-24', actorId: null });
    expect(emitAbsenceChange).toHaveBeenCalledWith({ technicianId: 't1', date: '2026-12-24', out: false, absenceId: 'own-2026-12-24' });
  });

  test('a work_days change moves the row: the old taken day clears and the new one is written', async () => {
    // the technician now works Monday to Friday: every Friday and Thursday holiday is a work day, so no row
    const { conn, absences, inserted } = makeConn({
      techs: [{ id: 't1', dob: null, work_days: [1, 2, 3, 4, 5] }], 
      absences: [own('2026-12-24'), own('2026-12-31')],
      owned: [joinedRow('2026-12-24', { work_days: [1, 2, 3, 4, 5] }), joinedRow('2026-12-31', { work_days: [1, 2, 3, 4, 5] })],
    });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(out).toMatchObject({ cleared: 2, written: 0, failed: 0 });
    expect(inserted).toEqual([]);
    expect(absences.every((a) => a.system_cleared_at === 'NOW()')).toBe(true);

    // and the reverse: work_days set to Monday to Wednesday moves the taken day to Wednesday (Thanksgiving left open here)
    getClosedHolidays.mockResolvedValue(new Set(['christmas', 'new_years_day']));
    const second = makeConn({
      techs: [{ id: 't1', dob: null, work_days: [1, 2, 3] }],
      liveTech: { ...LIVE, work_days: [1, 2, 3] },
      absences: [own('2026-12-24'), own('2026-12-31')],
      owned: [joinedRow('2026-12-24', { work_days: [1, 2, 3] }), joinedRow('2026-12-31', { work_days: [1, 2, 3] })],
    });
    expect(await syncTechDaysOff({ now: NOW, conn: second.conn })).toMatchObject({ cleared: 2, written: 2, failed: 0 });
    expect(second.inserted.map((r) => r.absence_date)).toEqual(['2026-12-23', '2026-12-30']);
  });

  test('NULL work_days after a change clears the rows', async () => {
    const { conn, absences } = makeConn({
      techs: [{ id: 't1', dob: null, work_days: null }],
      absences: [own('2026-12-24')],
      owned: [joinedRow('2026-12-24', { work_days: null })],
    });
    expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ cleared: 1, failed: 0 });
    expect(absences[0].system_cleared_at).toBe('NOW()');
    expect(getClosedHolidays).not.toHaveBeenCalled();
  });

  test('a failed settings read writes and clears no holiday row, counts one failure and logs no dates or holiday wording; birthdays proceed', async () => {
    getClosedHolidays.mockRejectedValue(Object.assign(new Error('secret db text'), { code: 'ECONNRESET' }));
    const { conn, absences, inserted } = makeConn({
      techs: [{ id: 't1', dob: '1990-12-02', work_days: MON_THU }, { id: 't2', dob: null, work_days: MON_THU }],
      liveTech: { ...LIVE, dob: '1990-12-02' },
      absences: [own('2026-12-24')],
      owned: [joinedRow('2026-12-24')],
    });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(inserted).toEqual([{ technician_id: 't1', absence_date: '2026-12-02', reason: 'other', source: 'tech_days_off' }]);
    expect(out).toMatchObject({ written: 1, cleared: 0, failed: 1 });
    expect(absences[0].cleared_at).toBeNull();
    const logged = [...logger.error.mock.calls, ...logger.warn.mock.calls, ...logger.info.mock.calls].map(([m]) => m).join('\n');
    expect(logged).toMatch(/could not read the closure settings: ECONNRESET/);
    expect(logged).not.toMatch(/2026|2027|secret|birth|holiday|christmas/i);
  });

  test('a failed settings read does not stop a row of an unassignable technician from clearing', async () => {
    getClosedHolidays.mockRejectedValue(new Error('down'));
    const { conn, absences } = makeConn({
      techs: [],
      absences: [own('2026-12-24')],
      owned: [joinedRow('2026-12-24', { employment_status: 'inactive' })],
    });
    expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ cleared: 1, failed: 0 });
    expect(absences[0].system_cleared_at).toBe('NOW()');
  });

  test('the clear rechecks the closure settings under the lock: a holiday closed again between the scan and the lock keeps the row; an unreadable read there keeps it too', async () => {
    // the scan sees Christmas reopened, the locked recheck sees it closed again
    getClosedHolidays.mockResolvedValueOnce(new Set()).mockResolvedValue(BIG6);
    let { conn, absences } = makeConn({
      techs: [{ id: 't1', dob: null, work_days: MON_THU }],
      absences: [own('2026-12-24')],
      owned: [joinedRow('2026-12-24')],
      liveTech: { employment_status: 'active', field_dispatchable: true, work_days: MON_THU, dob: null },
    });
    expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ cleared: 0, failed: 0 });
    expect(absences[0].cleared_at).toBeNull();

    getClosedHolidays.mockReset().mockResolvedValueOnce(new Set()).mockRejectedValue(Object.assign(new Error('x'), { code: '57014' }));
    ({ conn, absences } = makeConn({
      techs: [{ id: 't1', dob: null, work_days: MON_THU }],
      absences: [own('2026-12-24')],
      owned: [joinedRow('2026-12-24')],
      liveTech: { employment_status: 'active', field_dispatchable: true, work_days: MON_THU, dob: null },
    }));
    expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ cleared: 0, failed: 1 });
    expect(absences[0].cleared_at).toBeNull();
  });

  test('the write rechecks under the lock: a holiday reopened between the pass read and the lock writes nothing and counts nothing', async () => {
    // the pass read sees Christmas closed; the read inside the transaction sees it reopened
    getClosedHolidays.mockReset().mockResolvedValueOnce(new Set(['christmas'])).mockResolvedValue(new Set());
    getBlackoutDates.mockReset().mockResolvedValue(new Set());
    const { conn, inserted } = makeConn({ techs: [{ id: 't1', dob: null, work_days: MON_THU }], liveTech: LIVE });
    const out = await syncTechDaysOff({ now: NOW, conn });
    expect(inserted).toEqual([]);
    expect(out).toMatchObject({ written: 0, reopened: 0, skipped: 0, failed: 0 });
    expect(emitAbsenceChange).not.toHaveBeenCalled();
    // the recheck read through the same transaction, under the shared closure-state lock taken after the tech-day fence
    expect(lockClosureState).toHaveBeenCalledWith(conn);
    expect(getClosedHolidays).toHaveBeenLastCalledWith(conn, { strict: true });
    expect(lockTechDays.mock.invocationCallOrder[0]).toBeLessThan(lockClosureState.mock.invocationCallOrder[0]);
  });

  test('the write recheck also sees work_days changed since the scan', async () => {
    const { conn, inserted } = makeConn({
      techs: [{ id: 't1', dob: null, work_days: MON_THU }],
      liveTech: { ...LIVE, work_days: [1, 2, 3, 4, 5] }, // now works Fridays: the Christmas Thursday is not taken
    });
    expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ written: 0, failed: 0 });
    expect(inserted).toEqual([]);
  });

  test('a failed recheck read writes nothing and counts a failure, with no dates in the log; a birthday day takes no recheck', async () => {
    getClosedHolidays.mockReset().mockResolvedValueOnce(BIG6).mockRejectedValue(Object.assign(new Error('secret'), { code: '57014' }));
    getBlackoutDates.mockReset().mockResolvedValue(CLOSED_DATES);
    const { conn, inserted } = makeConn({ techs: [{ id: 't1', dob: '1990-12-24', work_days: MON_THU }], liveTech: { ...LIVE, dob: '1990-12-24' } });
    const out = await syncTechDaysOff({ now: NOW, conn });
    // 12-24 is also the birthday: written without a recheck; 12-31 is holiday-only: its recheck fails
    expect(inserted.map((r) => r.absence_date)).toEqual(['2026-12-24']);
    expect(out).toMatchObject({ written: 1, failed: 1 });
    const logged = logger.error.mock.calls.map(([m]) => m).join('\n');
    expect(logged).toMatch(/\[tech-days-off\].*t1.*57014/);
    expect(logged).not.toMatch(/2026|2027|secret|holiday|birth/i);
  });

  test('the clear takes the closure state shared after the tech-day fence, and a holiday re-closed before it keeps the row', async () => {
    getClosedHolidays.mockReset().mockResolvedValueOnce(new Set()).mockResolvedValue(BIG6);
    getBlackoutDates.mockReset().mockResolvedValue(CLOSED_DATES);
    const { conn, absences } = makeConn({
      techs: [{ id: 't1', dob: null, work_days: MON_THU }],
      absences: [own('2026-12-24')],
      owned: [joinedRow('2026-12-24')],
      liveTech: LIVE,
    });
    expect(await syncTechDaysOff({ now: NOW, conn })).toMatchObject({ cleared: 0, failed: 0 });
    expect(absences[0].cleared_at).toBeNull();
    expect(lockClosureState).toHaveBeenCalledWith(conn);
    expect(lockTechDays.mock.invocationCallOrder[0]).toBeLessThan(lockClosureState.mock.invocationCallOrder[0]);
  });
});
