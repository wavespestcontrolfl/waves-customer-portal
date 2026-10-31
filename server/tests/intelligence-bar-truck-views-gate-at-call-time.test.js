/**
 * GATE_TRUCK_VIEWS_PER_VEHICLE is read per call, not when the action registry loads.
 * The registry copies each tool's schema once at load (additionalProperties:false), so the
 * `vehicle` input must validate whatever the gate was at boot.
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

const GATE = 'GATE_TRUCK_VIEWS_PER_VEHICLE';
const KEYS = [GATE, 'BOUNCIE_CLIENT_ID', 'BOUNCIE_CLIENT_SECRET', 'BOUNCIE_VEHICLE_IMEI'];
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

function loadRegistry(gateAtLoad) {
  if (gateAtLoad) process.env[GATE] = 'true';
  else delete process.env[GATE];
  let registry;
  jest.isolateModules(() => { registry = require('../services/intelligence-bar/action-registry'); });
  return registry;
}

test('gate off at load, then on: `vehicle` validates and reaches the per-vehicle answer', async () => {
  const registry = loadRegistry(false);
  expect(registry.validateInput('get_truck_trips', { vehicle: 'Second Van' }, scope)).toBeNull();
  process.env[GATE] = 'true';
  const result = await registry.execute('get_truck_trips', { date: '2026-07-17', vehicle: 'second van' }, scope);
  expect(result.error).toBeUndefined();
  expect(result.vehicles.map(v => [v.vehicle, v.technician, v.total_miles])).toEqual([['Second Van', 'Sample Alpha', 7]]);
  expect(mockBouncie.getTrips).toHaveBeenCalledTimes(1);
});

test('gate on at load, then off: `vehicle` is ignored and the answer is today\'s', async () => {
  const registry = loadRegistry(true);
  process.env[GATE] = 'false';
  const result = await registry.execute('get_truck_trips', { date: '2026-07-17', vehicle: 'Second Van' }, scope);
  expect(Object.keys(result)).toEqual(['date', 'vehicle', 'trips', 'total', 'total_miles', 'truncated', 'note']);
  expect(result.vehicle).toBe('Waves Truck');
  expect(mockBouncie.getTrips).toHaveBeenCalledTimes(1);
  expect(mockBouncie.getTrips).toHaveBeenCalledWith('imei-1', '2026-07-17', '2026-07-17');
  expect(mockTechnicianNames).not.toHaveBeenCalled();
});

test('the model-facing definition is the same text in both gate states', () => {
  const off = loadRegistry(false).actions.get('get_truck_trips').definition;
  const on = loadRegistry(true).actions.get('get_truck_trips').definition;
  expect(on).toEqual(off);
  expect(off.input_schema.properties.vehicle.type).toBe('string');
});
