// The daily 1:00 AM Bouncie cron fills trip coordinates after the Bouncie sync and BEFORE the daily summary.
const mockOrder = [];
const mockHandlers = {};

jest.mock('../utils/scheduled-cron', () => ({
  schedule: jest.fn((expr, fn) => { mockHandlers[expr] = fn; }),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const chain = {
    where: () => chain, whereNotNull: () => chain, distinct: () => chain,
    pluck: async () => { mockOrder.push('vehicles'); return ['equip-1']; },
  };
  return jest.fn(() => chain);
});
jest.mock('../services/bouncie-mileage', () => ({
  computeDailySummary: jest.fn(async () => { mockOrder.push('summary'); }),
}));
jest.mock('../services/bouncie', () => ({ syncMileage: jest.fn(async () => { mockOrder.push('sync'); return { tripsImported: 0 }; }) }));
jest.mock('../services/mileage-trip-coords', () => ({
  fillRecentTripCoordinates: jest.fn(async () => { mockOrder.push('fill'); return {}; }),
}));

const { initBouncieMileageCrons } = require('../services/bouncie-mileage-crons');
const mileageService = require('../services/bouncie-mileage');
const coords = require('../services/mileage-trip-coords');

beforeEach(() => { mockOrder.length = 0; jest.clearAllMocks(); });

test('daily cron runs sync, then the coordinate fill, then the daily summary', async () => {
  initBouncieMileageCrons();
  await mockHandlers['0 1 * * *']();
  expect(mockOrder).toEqual(['sync', 'fill', 'vehicles', 'summary']);
  expect(coords.fillRecentTripCoordinates).toHaveBeenCalledTimes(1);
  expect(mileageService.computeDailySummary).toHaveBeenCalledWith('equip-1', expect.any(String));
});

test('a fill that reports an error (it never throws) still lets the summary run', async () => {
  coords.fillRecentTripCoordinates.mockImplementationOnce(async () => { mockOrder.push('fill'); return { skipped: 'error' }; });
  initBouncieMileageCrons();
  await mockHandlers['0 1 * * *']();
  expect(mockOrder).toEqual(['sync', 'fill', 'vehicles', 'summary']);
});
