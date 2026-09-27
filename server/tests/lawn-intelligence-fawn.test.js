jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/lawn-visit-runs', () => ({}));
jest.mock('../services/fawn-weather', () => ({ getCurrent: jest.fn() }));

const db = require('../models/db');
const FawnWeather = require('../services/fawn-weather');
const LawnIntelligence = require('../services/lawn-intelligence');
const update = jest.fn().mockResolvedValue(1);

function setRows(assessment, property) {
  const rows = {
    lawn_assessments: assessment,
    customer_properties: property,
    customers: { latitude: 27.14, longitude: -82.34 },
  };
  db.mockImplementation((table) => ({ where: () => ({ first: async () => rows[table], update }) }));
}

beforeEach(() => {
  jest.clearAllMocks();
  FawnWeather.getCurrent.mockResolvedValue({ station: 'Arcadia', temp_f: 82, observation_time: '2026-09-26T14:00:00-04:00' });
});

test('assessment enrichment uses the saved property rather than the primary customer address', async () => {
  setRows({ customer_id: 'customer', property_id: 'secondary' }, { latitude: 27.22, longitude: -81.84 });
  await LawnIntelligence.attachWeather('assessment');
  expect(FawnWeather.getCurrent).toHaveBeenCalledWith({ latitude: 27.22, longitude: -81.84 });
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ fawn_temp_f: 82, fawn_station: 'Arcadia' }));
  expect(db.mock.calls.map(([table]) => table)).not.toContain('customers');
});

test('legacy assessments still use their customer coordinates', async () => {
  setRows({ customer_id: 'customer', property_id: null }, null);
  await LawnIntelligence.attachWeather('assessment');
  expect(FawnWeather.getCurrent).toHaveBeenCalledWith({ latitude: 27.14, longitude: -82.34 });
});

test.each([null, { latitude: null, longitude: -81.84 }])('missing property coordinates leave assessment weather untouched: %p', async (property) => {
  setRows({ customer_id: 'customer', property_id: 'secondary' }, property);
  await expect(LawnIntelligence.attachWeather('assessment')).resolves.toBeNull();
  expect(FawnWeather.getCurrent).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
