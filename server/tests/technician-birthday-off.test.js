// Technician birthday = a paid day off (owner 2026-11-24, benefits ruling E6).
// technicians.dob is the only source; the day counts exactly like a
// technician_absences row through the shared seam in technician-eligibility.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  NOT_ASSIGNABLE,
  assertAssignableTechnician,
  absentTechDays,
  isBirthdayOn,
  birthdayDateInYear,
  birthdayDatesInRange,
  birthdayTechDays,
} = require('../services/technician-eligibility');
const logger = require('../services/logger');

describe('birthday date logic (pure)', () => {
  test('a plain birthday is kept on its month and day in any year', () => {
    expect(birthdayDateInYear('1990-07-14', 2026)).toBe('2026-07-14');
    expect(birthdayDateInYear('1990-07-14', 2027)).toBe('2027-07-14');
    expect(isBirthdayOn('1990-07-14', '2026-07-14')).toBe(true);
    expect(isBirthdayOn('1990-07-14', '2026-07-15')).toBe(false);
    expect(isBirthdayOn('1990-07-14', '2026-08-14')).toBe(false);
  });

  test('the birth year does not matter', () => {
    expect(isBirthdayOn('1960-03-02', '2026-03-02')).toBe(true);
    expect(isBirthdayOn('2005-03-02', '2026-03-02')).toBe(true);
  });

  test('Feb 29 is kept on Feb 28 in a year with no Feb 29', () => {
    expect(birthdayDateInYear('1992-02-29', 2027)).toBe('2027-02-28');
    expect(birthdayDateInYear('1992-02-29', 2100)).toBe('2100-02-28'); // not a leap year
    expect(birthdayDateInYear('1992-02-29', 2028)).toBe('2028-02-29');
    expect(birthdayDateInYear('1992-02-29', 2000)).toBe('2000-02-29'); // leap year
    expect(isBirthdayOn('1992-02-29', '2027-02-28')).toBe(true);
    expect(isBirthdayOn('1992-02-29', '2027-03-01')).toBe(false);
    expect(isBirthdayOn('1992-02-29', '2028-02-28')).toBe(false);
    expect(isBirthdayOn('1992-02-29', '2028-02-29')).toBe(true);
  });

  test('a stored DATE (JS Date at UTC midnight) reads the same as its string', () => {
    expect(isBirthdayOn(new Date('1990-07-14T00:00:00.000Z'), '2026-07-14')).toBe(true);
    expect(isBirthdayOn('1990-07-14', new Date('2026-07-14T00:00:00.000Z'))).toBe(true);
  });

  test('NULL, empty or unreadable dob never matches', () => {
    for (const dob of [null, undefined, '', 'soon', '1990-13-40', '1990-02-30']) {
      expect(birthdayDateInYear(dob, 2026)).toBeNull();
      expect(isBirthdayOn(dob, '2026-07-14')).toBe(false);
      expect(birthdayDatesInRange(dob, '2026-01-01', '2026-12-31')).toEqual([]);
    }
  });

  test('an unreadable date never matches', () => {
    expect(isBirthdayOn('1990-07-14', null)).toBe(false);
    expect(isBirthdayOn('1990-07-14', 'tomorrow')).toBe(false);
  });

  test('range: only a birthday inside the inclusive range counts', () => {
    expect(birthdayDatesInRange('1990-07-14', '2026-07-14', '2026-07-14')).toEqual(['2026-07-14']);
    expect(birthdayDatesInRange('1990-07-14', '2026-07-01', '2026-07-13')).toEqual([]);
    expect(birthdayDatesInRange('1990-07-14', '2026-07-15', '2026-07-31')).toEqual([]);
  });

  test('range across a new year finds each year\'s birthday', () => {
    expect(birthdayDatesInRange('1990-01-05', '2026-12-20', '2028-01-10')).toEqual(['2027-01-05', '2028-01-05']);
  });

  test('range with a Feb 29 birthday uses Feb 28 in common years', () => {
    expect(birthdayDatesInRange('1992-02-29', '2027-02-01', '2029-03-31')).toEqual(['2027-02-28', '2028-02-29', '2029-02-28']);
  });
});

describe('birthdayTechDays', () => {
  function connRows(rows) {
    const chain = {
      where: jest.fn(() => chain),
      whereNotNull: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      select: jest.fn(async () => rows),
    };
    const conn = jest.fn(() => chain);
    return { conn, chain };
  }

  test('returns technicianId:date keys in the same shape as absentTechDays', async () => {
    const { conn } = connRows([
      { id: 't1', dob: '1990-07-14' },
      { id: 't2', dob: new Date('1985-07-16T00:00:00.000Z') },
      { id: 't3', dob: '1979-08-01' },
    ]);
    const days = await birthdayTechDays(conn, { dateFrom: '2026-07-10', dateTo: '2026-07-20' });
    expect(days).toEqual(new Set(['t1:2026-07-14', 't2:2026-07-16']));
  });

  test('reads only active technicians with a dob, narrowed to the caller\'s list', async () => {
    const { conn, chain } = connRows([]);
    await birthdayTechDays(conn, { dateFrom: '2026-07-10', dateTo: '2026-07-20', technicianIds: ['t1', 't2'] });
    expect(conn).toHaveBeenCalledWith('technicians');
    expect(chain.where).toHaveBeenCalledWith('employment_status', 'active');
    expect(chain.whereNotNull).toHaveBeenCalledWith('dob');
    expect(chain.whereIn).toHaveBeenCalledWith('id', ['t1', 't2']);
  });

  test('no technician list reads every active technician', async () => {
    const { conn, chain } = connRows([]);
    await birthdayTechDays(conn, { dateFrom: '2026-07-10', dateTo: '2026-07-20' });
    expect(chain.whereIn).not.toHaveBeenCalled();
  });

  test('nobody with a birthday in range gives an empty Set', async () => {
    const { conn } = connRows([{ id: 't1', dob: '1990-01-01' }]);
    expect(await birthdayTechDays(conn, { dateFrom: '2026-07-10', dateTo: '2026-07-20' })).toEqual(new Set());
  });

  test('a failed read applies no birthdays and warns, never throws', async () => {
    const conn = jest.fn(() => { throw new Error('boom'); });
    await expect(birthdayTechDays(conn, { dateFrom: '2026-07-10', dateTo: '2026-07-20' })).resolves.toEqual(new Set());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('birthday read failed'));
  });
});

describe('absentTechDays carries birthdays through the shared seam', () => {
  // technician_absences and technicians answer from separate chains.
  function connBoth({ absences = [], techs = [] }) {
    const absenceChain = {
      whereBetween: jest.fn(() => absenceChain),
      whereNull: jest.fn(() => absenceChain),
      whereIn: jest.fn(() => absenceChain),
      select: jest.fn(async () => absences),
    };
    const techChain = {
      where: jest.fn(() => techChain),
      whereNotNull: jest.fn(() => techChain),
      whereIn: jest.fn(() => techChain),
      select: jest.fn(async () => techs),
    };
    const conn = jest.fn((table) => (table === 'technician_absences' ? absenceChain : techChain));
    return { conn, techChain };
  }

  test('a birthday and a mark-out both land in the Set', async () => {
    const { conn } = connBoth({
      absences: [{ technician_id: 't2', absence_date: '2026-07-12' }],
      techs: [{ id: 't1', dob: '1990-07-14' }],
    });
    const days = await absentTechDays(conn, { dateFrom: '2026-07-10', dateTo: '2026-07-20', technicianIds: ['t1', 't2'] });
    expect(days).toEqual(new Set(['t2:2026-07-12', 't1:2026-07-14']));
  });

  test('includeBirthdays: false skips the birthday read', async () => {
    const { conn, techChain } = connBoth({ techs: [{ id: 't1', dob: '1990-07-14' }] });
    const days = await absentTechDays(conn, { dateFrom: '2026-07-10', dateTo: '2026-07-20', includeBirthdays: false });
    expect(days).toEqual(new Set());
    expect(techChain.select).not.toHaveBeenCalled();
  });

  test('a technician with no dob adds nothing', async () => {
    const { conn } = connBoth({ techs: [{ id: 't1', dob: null }] });
    expect(await absentTechDays(conn, { dateFrom: '2026-07-10', dateTo: '2026-07-20' })).toEqual(new Set());
  });
});

describe('assertAssignableTechnician on a birthday', () => {
  function connWith(techRow, absenceRow) {
    const techChain = { where: jest.fn(() => techChain), forShare: jest.fn(() => techChain), first: jest.fn(async () => techRow) };
    const absenceChain = { where: jest.fn(() => absenceChain), whereNull: jest.fn(() => absenceChain), first: jest.fn(async () => absenceRow) };
    const conn = jest.fn((table) => (table === 'technicians' ? techChain : absenceChain));
    return { conn, techChain };
  }
  const ROW = { id: 't1', name: 'Tech One', employment_status: 'active', field_dispatchable: true, dob: '1990-07-14' };

  test('refuses the technician on their own birthday, 422 TECH_NOT_ASSIGNABLE', async () => {
    const { conn } = connWith(ROW, undefined);
    await expect(assertAssignableTechnician('t1', { conn, date: '2026-07-14' })).rejects.toMatchObject({
      status: 422,
      code: NOT_ASSIGNABLE,
      technicianId: 't1',
      message: expect.stringMatching(/Tech One has their birthday off on 2026-07-14 and cannot be assigned work/),
    });
  });

  test('allows the day before and the day after', async () => {
    const { conn } = connWith(ROW, undefined);
    await expect(assertAssignableTechnician('t1', { conn, date: '2026-07-13' })).resolves.toBe(ROW);
    await expect(assertAssignableTechnician('t1', { conn, date: '2026-07-15' })).resolves.toBe(ROW);
  });

  test('Feb 29 birthday refuses Feb 28 in a common year', async () => {
    const { conn } = connWith({ ...ROW, dob: '1992-02-29' }, undefined);
    await expect(assertAssignableTechnician('t1', { conn, date: '2027-02-28' })).rejects.toMatchObject({ code: NOT_ASSIGNABLE });
    await expect(assertAssignableTechnician('t1', { conn, date: '2027-03-01' })).resolves.toBeTruthy();
  });

  test('no date: dob is not read and nothing changes', async () => {
    const { conn, techChain } = connWith(ROW, undefined);
    await expect(assertAssignableTechnician('t1', { conn })).resolves.toBe(ROW);
    expect(techChain.first).toHaveBeenCalledWith('id', 'name', 'role', 'employment_status', 'field_dispatchable', 'active');
  });

  test('NULL dob never blocks', async () => {
    const { conn } = connWith({ ...ROW, dob: null }, undefined);
    await expect(assertAssignableTechnician('t1', { conn, date: '2026-07-14' })).resolves.toBeTruthy();
  });

  test('an inactive technician is refused for being inactive, not for the birthday', async () => {
    const { conn } = connWith({ ...ROW, employment_status: 'inactive' }, undefined);
    await expect(assertAssignableTechnician('t1', { conn, date: '2026-07-14' })).rejects.toMatchObject({
      message: expect.stringMatching(/no longer active/),
    });
  });
});
