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
const mockTechnicianNames = jest.fn();
jest.mock('../services/bouncie-mileage', () => ({ technicianNamesByImei: (...a) => mockTechnicianNames(...a) }));

const ENV_KEYS = ['BOUNCIE_CLIENT_ID', 'BOUNCIE_CLIENT_SECRET', 'BOUNCIE_VEHICLE_IMEI', 'GATE_TRUCK_VIEWS_PER_VEHICLE'];
const savedEnv = {};
const { BOUNCIE_OPS_TOOLS, executeBouncieOpsTool } = require('../services/intelligence-bar/bouncie-ops-tools');

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

describe('GATE_TRUCK_VIEWS_PER_VEHICLE (every vehicle and its technician)', () => {
  const trip = (miles, startTime = '2026-07-17T12:00:00Z') => ({ startTime, endTime: '2026-07-17T12:30:00Z', distanceMiles: miles, durationMinutes: 30, maxSpeed: 50 });
  const VEHICLES = [
    { id: 'imei-1', imei: 'imei-1', nickname: 'Waves Truck', make: 'Ford', model: 'Transit', year: 2023 },
    { id: 'imei-2', imei: 'imei-2', nickname: 'Second Van', make: 'Ford', model: 'Transit', year: 2024 },
  ];
  const tool = (name) => BOUNCIE_OPS_TOOLS.find(t => t.name === name);

  beforeEach(() => {
    process.env.BOUNCIE_CLIENT_ID = 'id';
    process.env.BOUNCIE_CLIENT_SECRET = 'secret';
    process.env.BOUNCIE_VEHICLE_IMEI = 'imei-1';
    mockBouncie.getVehicles.mockResolvedValue(VEHICLES);
    mockTechnicianNames.mockResolvedValue(new Map([['imei-2', 'Sample Alpha']]));
    mockBouncie.getTrips.mockImplementation(async (id) => (id === 'imei-1' ? [trip(12), trip(5)] : [trip(7.25)]));
  });

  test('off: trips read the one vehicle, with today\'s exact shape and no technician read', async () => {
    const result = await executeBouncieOpsTool('get_truck_trips', { date: '2026-07-17', vehicle: 'Second Van' });
    expect(Object.keys(result)).toEqual(['date', 'vehicle', 'trips', 'total', 'total_miles', 'truncated', 'note']);
    expect(result.vehicle).toBe('Waves Truck');
    expect(result.total_miles).toBe(17);
    expect(mockBouncie.getTrips).toHaveBeenCalledTimes(1);
    expect(mockTechnicianNames).not.toHaveBeenCalled();
  });

  test('off: status has no technician key', async () => {
    const result = await executeBouncieOpsTool('get_truck_status', {});
    expect(Object.keys(result.vehicles[0])).not.toContain('technician');
    expect(mockTechnicianNames).not.toHaveBeenCalled();
  });

  test('any value but the exact string true keeps it off', async () => {
    process.env.GATE_TRUCK_VIEWS_PER_VEHICLE = '1';
    const result = await executeBouncieOpsTool('get_truck_trips', { date: '2026-07-17' });
    expect(result.vehicles).toBeUndefined();
    expect(result.vehicle).toBe('Waves Truck');
  });

  describe('on', () => {
    beforeEach(() => { process.env.GATE_TRUCK_VIEWS_PER_VEHICLE = 'true'; });

    test('status names each vehicle\'s technician (null when none is linked)', async () => {
      const result = await executeBouncieOpsTool('get_truck_status', {});
      expect(result.vehicles.map(v => [v.nickname, v.technician])).toEqual([['Waves Truck', null], ['Second Van', 'Sample Alpha']]);
      expect(result.total).toBe(2);
    });

    test('trips list every vehicle with its technician and a grand total', async () => {
      const result = await executeBouncieOpsTool('get_truck_trips', { date: '2026-07-17' });
      expect(result.error).toBeUndefined();
      expect(Object.keys(result)).toEqual(['date', 'vehicles', 'total_miles', 'note']);
      expect(result.vehicles).toEqual([
        { vehicle: 'Waves Truck', technician: null, trips: expect.any(Array), total: 2, total_miles: 17, truncated: false },
        { vehicle: 'Second Van', technician: 'Sample Alpha', trips: expect.any(Array), total: 1, total_miles: 7.3, truncated: false },
      ]);
      expect(result.vehicles[1].trips[0].distance_miles).toBe(7.25);
      expect(result.total_miles).toBe(24.3);
      expect(mockBouncie.getTrips).toHaveBeenCalledWith('imei-1', '2026-07-17', '2026-07-17');
      expect(mockBouncie.getTrips).toHaveBeenCalledWith('imei-2', '2026-07-17', '2026-07-17');
    });

    test('vehicle input picks one by nickname or by technician name, any case', async () => {
      const byNickname = await executeBouncieOpsTool('get_truck_trips', { date: '2026-07-17', vehicle: ' waves TRUCK ' });
      expect(byNickname.vehicles.map(v => v.vehicle)).toEqual(['Waves Truck']);
      mockBouncie.getTrips.mockClear();
      const byTech = await executeBouncieOpsTool('get_truck_trips', { date: '2026-07-17', vehicle: 'sample alpha' });
      expect(byTech.vehicles.map(v => v.vehicle)).toEqual(['Second Van']);
      expect(byTech.total_miles).toBe(7.3);
      expect(mockBouncie.getTrips).toHaveBeenCalledTimes(1);
    });

    test('a vehicle that matches nothing is a plain answer listing the known names, never { error }', async () => {
      const result = await executeBouncieOpsTool('get_truck_trips', { date: '2026-07-17', vehicle: 'Nobody' });
      expect(result.error).toBeUndefined();
      expect(result.vehicles).toEqual([]);
      expect(result.note).toContain('No vehicle matches "Nobody"');
      expect(result.note).toContain('Waves Truck');
      expect(result.note).toContain('Second Van (Sample Alpha)');
      expect(mockBouncie.getTrips).not.toHaveBeenCalled();
    });

    test('an account with no vehicles still answers in the per-vehicle shape', async () => {
      mockBouncie.getVehicles.mockResolvedValue([]);
      const result = await executeBouncieOpsTool('get_truck_trips', { date: '2026-07-17' });
      expect(result).toMatchObject({ vehicles: [], total_miles: 0 });
      expect(result.note).toMatch(/No vehicles registered/);
    });

    test('each vehicle caps its own trips at 30 and says so', async () => {
      mockBouncie.getTrips.mockImplementation(async (id) => (id === 'imei-1' ? Array.from({ length: 31 }, () => trip(1)) : [trip(2)]));
      const result = await executeBouncieOpsTool('get_truck_trips', { date: '2026-07-17' });
      expect(result.vehicles[0].trips).toHaveLength(30);
      expect(result.vehicles[0]).toMatchObject({ total: 31, total_miles: 31, truncated: true });
      expect(result.vehicles[1].truncated).toBe(false);
    });

    test('the tool definition is static: it offers the vehicle input whatever the gate says', () => {
      const t = tool('get_truck_trips');
      expect(Object.getOwnPropertyDescriptor(t, 'description').get).toBeUndefined();
      expect(Object.getOwnPropertyDescriptor(t, 'input_schema').get).toBeUndefined();
      expect(t.description).toMatch(/per-vehicle truck views on/);
      expect(t.input_schema.properties.vehicle.type).toBe('string');
      expect(t.input_schema.properties.date).toBeDefined();
    });
  });
});
