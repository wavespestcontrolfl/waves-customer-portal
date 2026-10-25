/**
 * getTechCountForArea drives the autonomous capacity → budget cron. It used to
 * return a hardcoded per-area roster (2–3 phantom techs), overstating capacity.
 * It now returns the real assignable-technician count (active AND
 * field-dispatchable) for every area — a prospective placeholder or an
 * office-only account offers no slot, so it adds no capacity.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockTechs = [];
let mockWheres = [];
let mockAbsences = [];
let mockWorkDayRows = [];
let mockAbsenceReads = 0;
jest.mock('../models/db', () => jest.fn((table) => {
  if (table === 'technicians') {
    // applyAssignable awaits the builder after .where(); the off-day read
    // (GATE_TECH_WORK_DAYS) goes whereNotNull -> whereIn -> select.
    const q = {
      where: (...args) => { mockWheres.push(args); return q; },
      whereNotNull: () => q,
      whereIn: () => q,
      select: () => Promise.resolve(mockWorkDayRows),
      then: (res, rej) => Promise.resolve(mockTechs).then(res, rej),
    };
    return q;
  }
  if (table === 'technician_absences') {
    const q = {
      whereBetween: () => q,
      whereNull: () => q,
      whereIn: () => q,
      select: () => { mockAbsenceReads += 1; return Promise.resolve(mockAbsences); },
    };
    return q;
  }
  return { where: () => ({ first: () => Promise.resolve(null) }) };
}));

const BudgetManager = require('../services/ads/budget-manager');

beforeEach(() => {
  mockTechs = []; mockWheres = []; mockAbsences = []; mockWorkDayRows = []; mockAbsenceReads = 0;
  delete process.env.GATE_ADS_CAPACITY_WORK_DAYS;
  delete process.env.GATE_TECH_WORK_DAYS;
});
afterAll(() => {
  delete process.env.GATE_ADS_CAPACITY_WORK_DAYS;
  delete process.env.GATE_TECH_WORK_DAYS;
});

test('returns the assignable-technician count and ignores the area', async () => {
  mockTechs = [{ id: 1, name: 'Adam' }];
  expect(await BudgetManager.getTechCountForArea('general')).toBe(1);
  expect(mockWheres).toEqual([
    ['technicians.employment_status', 'active'],
    ['technicians.field_dispatchable', true],
  ]);
  expect(await BudgetManager.getTechCountForArea('Sarasota')).toBe(1);
  expect(await BudgetManager.getTechCountForArea('Parrish', '2026-07-20')).toBe(1);
});

test('scales with the real crew size, not a per-area map', async () => {
  mockTechs = [{ id: 1 }, { id: 2 }, { id: 3 }];
  expect(await BudgetManager.getTechCountForArea('Venice')).toBe(3);
});

describe('GATE_ADS_CAPACITY_WORK_DAYS', () => {
  // 2026-07-24 is a Friday, 2026-07-20 a Monday.
  const FRI = '2026-07-24';
  const MON = '2026-07-20';

  beforeEach(() => {
    mockTechs = [{ id: 1, name: 'Adam' }, { id: 2, name: 'Tech Two' }, { id: 3, name: 'Tech Three' }];
  });

  test('gate off ignores absences and off days (no extra read)', async () => {
    mockAbsences = [{ technician_id: 2, absence_date: FRI }];
    process.env.GATE_TECH_WORK_DAYS = 'true';
    mockWorkDayRows = [{ id: 3, work_days: [1, 2, 3, 4] }];
    expect(await BudgetManager.getTechCountForArea('general', FRI)).toBe(3);
    expect(mockAbsenceReads).toBe(0);
  });

  test('gate on drops a technician who is absent on that date, keeps the others', async () => {
    process.env.GATE_ADS_CAPACITY_WORK_DAYS = 'true';
    mockAbsences = [{ technician_id: 2, absence_date: FRI }];
    expect(await BudgetManager.getTechCountForArea('general', FRI)).toBe(2);
    // a datetime string normalizes to its calendar day
    expect(await BudgetManager.getTechCountForArea('general', `${FRI}T12:00:00`)).toBe(2);
  });

  test('gate on drops a technician who does not work that weekday (needs GATE_TECH_WORK_DAYS)', async () => {
    process.env.GATE_ADS_CAPACITY_WORK_DAYS = 'true';
    process.env.GATE_TECH_WORK_DAYS = 'true';
    mockWorkDayRows = [{ id: 3, work_days: [1, 2, 3, 4] }];
    expect(await BudgetManager.getTechCountForArea('general', FRI)).toBe(2);
    expect(await BudgetManager.getTechCountForArea('general', MON)).toBe(3);
  });

  test('gate on, work-days gate off: weekdays are not dropped', async () => {
    process.env.GATE_ADS_CAPACITY_WORK_DAYS = 'true';
    mockWorkDayRows = [{ id: 3, work_days: [1, 2, 3, 4] }];
    expect(await BudgetManager.getTechCountForArea('general', FRI)).toBe(3);
  });

  test('gate on with no date returns the full count', async () => {
    process.env.GATE_ADS_CAPACITY_WORK_DAYS = 'true';
    mockAbsences = [{ technician_id: 2, absence_date: FRI }];
    expect(await BudgetManager.getTechCountForArea('general')).toBe(3);
    expect(mockAbsenceReads).toBe(0);
  });

  test('gate on and every technician off returns 0', async () => {
    process.env.GATE_ADS_CAPACITY_WORK_DAYS = 'true';
    mockAbsences = [
      { technician_id: 1, absence_date: FRI },
      { technician_id: 2, absence_date: FRI },
      { technician_id: 3, absence_date: FRI },
    ];
    expect(await BudgetManager.getTechCountForArea('general', FRI)).toBe(0);
  });

  test('gate on, no assignable technician: 0 without an absence read', async () => {
    process.env.GATE_ADS_CAPACITY_WORK_DAYS = 'true';
    mockTechs = [];
    expect(await BudgetManager.getTechCountForArea('general', FRI)).toBe(0);
    expect(mockAbsenceReads).toBe(0);
  });
});
