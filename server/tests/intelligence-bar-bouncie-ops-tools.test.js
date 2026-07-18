/**
 * Bouncie vehicle ops tools — unit tests with a mocked bouncie service.
 * Read-only contract: benign dark state, live-status mapping, miles come
 * from distanceMiles (distance is METERS), day totals, failures as
 * { error }.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockBouncie = {
  getVehicles: jest.fn(),
  getTrips: jest.fn(),
};
jest.mock('../services/bouncie', () => mockBouncie);

const ENV_KEYS = ['BOUNCIE_CLIENT_ID', 'BOUNCIE_CLIENT_SECRET', 'BOUNCIE_VEHICLE_IMEI'];
const savedEnv = {};
const { executeBouncieOpsTool } = require('../services/intelligence-bar/bouncie-ops-tools');

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('intelligence bar Bouncie ops tools', () => {
  test('unconfigured state is benign — no error field and no service call', async () => {
    const result = await executeBouncieOpsTool('get_truck_status', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/BOUNCIE_CLIENT_ID/);
    expect(mockBouncie.getVehicles).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    process.env.BOUNCIE_CLIENT_ID = 'id';
    process.env.BOUNCIE_CLIENT_SECRET = 'secret';
    const result = await executeBouncieOpsTool('start_engine', {});
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('truck status maps live vehicle state', async () => {
    process.env.BOUNCIE_CLIENT_ID = 'id';
    process.env.BOUNCIE_CLIENT_SECRET = 'secret';
    mockBouncie.getVehicles.mockResolvedValueOnce([{
      nickname: 'Waves Truck', make: 'Ford', model: 'Transit', year: 2023,
      isRunning: true, speed: 34, fuelLevel: 62.5, odometer: 41890,
      lastLocation: { lat: 27.41, lon: -82.42 }, lastUpdated: '2026-07-17T19:00:00Z',
    }]);

    const result = await executeBouncieOpsTool('get_truck_status', {});
    expect(result.error).toBeUndefined();
    expect(result.vehicles[0]).toEqual({
      nickname: 'Waves Truck', make: 'Ford', model: 'Transit', year: 2023,
      is_running: true, speed: 34, fuel_level: 62.5, odometer: 41890,
      last_location: { lat: 27.41, lng: -82.42 },
      last_updated: '2026-07-17T19:00:00Z',
    });
  });

  test('trips report miles from distanceMiles (distance is meters) and sum the day', async () => {
    process.env.BOUNCIE_CLIENT_ID = 'id';
    process.env.BOUNCIE_CLIENT_SECRET = 'secret';
    process.env.BOUNCIE_VEHICLE_IMEI = 'imei-1';
    mockBouncie.getVehicles.mockResolvedValueOnce([
      { id: 'imei-1', imei: 'imei-1', nickname: 'Waves Truck' },
      { id: 'imei-2', imei: 'imei-2', nickname: 'Spare' },
    ]);
    mockBouncie.getTrips.mockResolvedValueOnce([
      { startTime: '2026-07-17T12:00:00Z', endTime: '2026-07-17T12:30:00Z', distance: 19312, distanceMiles: 12, durationMinutes: 30, maxSpeed: 55 },
      { startTime: '2026-07-17T14:00:00Z', endTime: '2026-07-17T14:20:00Z', distance: 8046, distanceMiles: 5, durationMinutes: 20, maxSpeed: 45 },
    ]);

    const result = await executeBouncieOpsTool('get_truck_trips', { date: '2026-07-17' });
    expect(result.error).toBeUndefined();
    expect(result.vehicle).toBe('Waves Truck');
    expect(mockBouncie.getTrips).toHaveBeenCalledWith('imei-1', '2026-07-17', '2026-07-17');
    // Never the raw meters value
    expect(result.trips[0].distance_miles).toBe(12);
    expect(result.total_miles).toBe(17);
    expect(result.total).toBe(2);
  });

  test('service failure surfaces as { error }, never a throw', async () => {
    process.env.BOUNCIE_CLIENT_ID = 'id';
    process.env.BOUNCIE_CLIENT_SECRET = 'secret';
    mockBouncie.getVehicles.mockRejectedValueOnce(new Error('token refresh failed'));
    const result = await executeBouncieOpsTool('get_truck_status', {});
    expect(result.error).toMatch(/token refresh failed/);
  });
});
