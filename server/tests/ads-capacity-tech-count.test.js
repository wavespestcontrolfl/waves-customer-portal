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
jest.mock('../models/db', () => jest.fn((table) => {
  if (table === 'technicians') {
    const q = {
      where: (...args) => { mockWheres.push(args); return q; },
      then: (res, rej) => Promise.resolve(mockTechs).then(res, rej),
    };
    return q;
  }
  return { where: () => ({ first: () => Promise.resolve(null) }) };
}));

const BudgetManager = require('../services/ads/budget-manager');

beforeEach(() => { mockTechs = []; mockWheres = []; });

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
