// The read-only preview prints every list that has something to say, a warning-only list included.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { parseArgs, render } = require('../scripts/weekly-buy-list');

const empty = { technicianId: null, technicianName: null, supplyStore: null, items: [], estTotalCents: null, unpricedLines: 0, notes: [], warnings: [] };
const list = (technicians) => ({ weekStart: '2026-12-07', weekEnd: '2026-12-12', fromDate: '2026-12-09', technicians, unassigned: empty, warnings: [] });

test('a list with nothing short but a warning is printed, with its warning', () => {
  const out = render(list([{ ...empty, technicianId: 't1', technicianName: 'Alex Sample', warnings: ['Taurus SC yearly counts could not be read, so Taurus is left out of every pest visit this week.'] }]));
  expect(out).toContain("check Alex's supplies, week of Dec 7");
  expect(out).toContain('- Taurus SC yearly counts could not be read');
});

test('nothing to say prints one plain line', () => {
  expect(render(list([{ ...empty, technicianId: 't1', technicianName: 'Alex Sample' }]))).toContain('Nothing to buy and no warnings.');
});

test('--date takes a real calendar date only', () => {
  expect(parseArgs(['--date', '2026-12-07']).now.toISOString()).toBe('2026-12-07T12:00:00.000Z');
  expect(() => parseArgs(['--date=2026-02-30'])).toThrow(/real date/);
});
