/**
 * The registry copies each tool's schema once at load (additionalProperties:false), so the
 * `vehicle` input of get_truck_trips must validate through it and reach the per-vehicle answer.
 */
process.env.JWT_SECRET = 'synthetic-ib-test';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockBouncie = { getVehicles: jest.fn(), getTrips: jest.fn() };
jest.mock('../services/bouncie', () => mockBouncie);
const mockTechnicianNames = jest.fn();
jest.mock('../services/bouncie-mileage', () => ({
  ...jest.requireActual('../services/bouncie-mileage'),
  technicianNamesByImei: (...a) => mockTechnicianNames(...a),
}));

const KEYS = ['BOUNCIE_CLIENT_ID', 'BOUNCIE_CLIENT_SECRET', 'BOUNCIE_VEHICLE_IMEI'];
const saved = {};
const scope = { role: 'admin', context: 'platform' };

beforeAll(() => { for (const k of KEYS) saved[k] = process.env[k]; });
afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  jest.clearAllMocks();
  process.env.BOUNCIE_CLIENT_ID = 'id';
  process.env.BOUNCIE_CLIENT_SECRET = 'secret';
  process.env.BOUNCIE_VEHICLE_IMEI = 'imei-1';
  mockBouncie.getVehicles.mockResolvedValue([
    { id: 'imei-1', imei: 'imei-1', nickname: 'Waves Truck' },
    { id: 'imei-2', imei: 'imei-2', nickname: 'Second Van' },
  ]);
  mockBouncie.getTrips.mockImplementation(async (id) => [{ startTime: 's', endTime: 'e', distanceMiles: id === 'imei-1' ? 12 : 7 }]);
  mockTechnicianNames.mockResolvedValue(new Map([['imei-2', 'Sample Alpha']]));
});

function loadRegistry() {
  let registry;
  jest.isolateModules(() => { registry = require('../services/intelligence-bar/action-registry'); });
  return registry;
}

test('`vehicle` validates and reaches the per-vehicle answer', async () => {
  const registry = loadRegistry();
  expect(registry.validateInput('get_truck_trips', { vehicle: 'Second Van' }, scope)).toBeNull();
  const result = await registry.execute('get_truck_trips', { date: '2026-07-17', vehicle: 'second van' }, scope);
  expect(result.error).toBeUndefined();
  expect(result.vehicles.map(v => [v.vehicle, v.technician, v.total_miles])).toEqual([['Second Van', 'Sample Alpha', 7]]);
  expect(mockBouncie.getTrips).toHaveBeenCalledTimes(1);
});

test('the model-facing definition offers the vehicle input', () => {
  const def = loadRegistry().actions.get('get_truck_trips').definition;
  expect(def.input_schema.properties.vehicle.type).toBe('string');
});
