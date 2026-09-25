/**
 * Real PostgreSQL regression for coordinate recovery flowing through the
 * shared schedule-quality reader, ledger, and Dispatch alert reconciler.
 * Fixtures live in connection-local TEMP tables and roll back after each
 * test. Provider and socket edges are mocked; quality computation is real.
 */
let mockConnection;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConnection(...args);
  for (const method of ['raw', 'transaction', 'queryBuilder', 'ref']) {
    proxy[method] = (...args) => mockConnection[method](...args);
  }
  for (const property of ['schema', 'fn']) {
    Object.defineProperty(proxy, property, { get: () => mockConnection[property] });
  }
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/geocoder', () => ({ geocodeAddressWithStatus: jest.fn() }));
jest.mock('../services/dispatch-assignment', () => ({ emitDispatchJobUpdate: jest.fn(async () => {}) }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));

const knex = require('knex');
const { geocodeAddressWithStatus } = require('../services/geocoder');
const { sweepUngeocodedServices } = require('../services/geocoder-service-locations');
const { getScheduleQualityMeasurements, QUALITY_EXCLUDED_STATUSES } = require('../services/scheduling/day-quality');
const { refreshScheduleQualityAfterChange } = require('../services/scheduling/quality-after-change');
const { refreshScheduleQualityAlerts } = require('../services/scheduling/quality-alerts');

const connection = process.env.SERVICE_GEOCODE_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
const NOW = new Date('2026-09-25T14:00:00Z');
const TODAY = '2026-09-25';
const DAY = '2026-09-30';
const SECOND_DAY = '2026-10-01';
const OUTSIDE_HORIZON = '2026-10-26';
const TECH = '41000000-0000-4000-8000-000000000001';
const CUSTOMER = '42000000-0000-4000-8000-000000000001';
const OTHER_CUSTOMER = '42000000-0000-4000-8000-000000000002';
const RECOVERED = '43000000-0000-4000-8000-000000000001';
const PIN = { lat: 27.4981, lng: -82.5748 };
const serviceId = suffix => `43000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

postgres('geocoder quality recovery on isolated PostgreSQL', () => {
  let database;
  const gates = [
    'GATE_ROUTE_REORDER',
    'GATE_ROUTE_REORDER_REPAIR',
    'GATE_SCHEDULE_QUALITY_MEASUREMENTS',
    'GATE_SCHEDULE_QUALITY_ALERTS',
    'GATE_DRIVE_TIME_CALIBRATION',
  ];
  const savedGates = Object.fromEntries(gates.map(gate => [gate, process.env[gate]]));

  async function insertService(id, overrides = {}) {
    await mockConnection('scheduled_services').insert({
      id,
      customer_id: CUSTOMER,
      technician_id: TECH,
      scheduled_date: DAY,
      status: 'confirmed',
      service_type: 'Synthetic Pest Control',
      estimated_duration_minutes: 60,
      window_start: '09:00',
      window_end: '10:00',
      route_order: 1,
      lat: null,
      lng: null,
      is_recurring: false,
      visit_id: null,
      auto_dispatch_locked: false,
      auto_dispatch_excluded: false,
      reservation_expires_at: null,
      service_address_line1: '200 Divergent Fixture Way',
      service_address_line2: null,
      service_address_city: 'Bradenton',
      service_address_state: 'FL',
      service_address_zip: '34205',
      ...overrides,
    });
  }

  const qualityForTech = measured => measured.days[0].byTech.find(row => row.technicianId === TECH);

  beforeAll(() => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  });

  afterAll(async () => {
    await database?.destroy();
    for (const gate of gates) {
      if (savedGates[gate] === undefined) delete process.env[gate];
      else process.env[gate] = savedGates[gate];
    }
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.GATE_ROUTE_REORDER = 'true';
    process.env.GATE_ROUTE_REORDER_REPAIR = 'true';
    process.env.GATE_SCHEDULE_QUALITY_MEASUREMENTS = 'true';
    process.env.GATE_SCHEDULE_QUALITY_ALERTS = 'true';
    // Deliberately keep calibration off: this suite verifies coordinate and
    // warning reconciliation, while route-order repair has its own PG suite.
    delete process.env.GATE_DRIVE_TIME_CALIBRATION;
    geocodeAddressWithStatus.mockResolvedValue({ location: PIN, permanent: false });
    mockConnection = await database.transaction();
    for (const table of [
      'scheduled_services', 'customers', 'technicians', 'audit_log',
      'schedule_blackout_dates', 'system_settings',
      'route_optimization_planner_runs', 'dispatch_alerts',
    ]) {
      await mockConnection.raw('CREATE TEMP TABLE ?? ON COMMIT DROP AS SELECT * FROM public.?? WITH NO DATA', [table, table]);
    }
    for (const table of ['audit_log', 'route_optimization_planner_runs', 'dispatch_alerts']) {
      await mockConnection.raw('ALTER TABLE ?? ALTER COLUMN id SET DEFAULT gen_random_uuid()', [table]);
      await mockConnection.raw('ALTER TABLE ?? ALTER COLUMN created_at SET DEFAULT NOW()', [table]);
    }
    await mockConnection('technicians').insert({
      id: TECH,
      name: 'Synthetic routing technician',
      active: true,
      employment_status: 'active',
      field_dispatchable: true,
    });
    await mockConnection('customers').insert([
      {
        id: CUSTOMER,
        first_name: 'Synthetic',
        last_name: 'Recovered',
        address_line1: '100 Primary Fixture Way',
        city: 'Bradenton',
        state: 'FL',
        zip: '34205',
        latitude: PIN.lat,
        longitude: PIN.lng,
        deleted_at: null,
      },
      {
        id: OTHER_CUSTOMER,
        first_name: 'Synthetic',
        last_name: 'Other',
        address_line1: '300 Other Fixture Way',
        city: 'Sarasota',
        state: 'FL',
        zip: '34236',
        latitude: 27.336,
        longitude: -82.53,
        deleted_at: null,
      },
    ]);
  });

  afterEach(async () => {
    if (mockConnection && !mockConnection.isCompleted()) await mockConnection.rollback();
  });

  test('service-pin recovery clears the real missing-location measurement and resolves its Dispatch warning', async () => {
    await insertService(RECOVERED);
    const before = await getScheduleQualityMeasurements({ date: DAY }, mockConnection, NOW);
    expect(qualityForTech(before).missingCoordinates).toEqual([RECOVERED]);

    expect(await refreshScheduleQualityAlerts({ dates: [DAY], now: NOW }, mockConnection))
      .toMatchObject({ status: 'reconciled', created: 1, resolved: 0 });
    const [opened] = await mockConnection('dispatch_alerts')
      .where({ type: 'schedule_route_quality', tech_id: TECH })
      .whereNull('resolved_at');
    expect(opened.payload.issues).toEqual([expect.stringContaining('without a usable location')]);

    const recovered = await sweepUngeocodedServices({ limit: 1, now: NOW, dryRun: false }, mockConnection);

    expect(recovered).toMatchObject({ status: 'completed', checked: 1, geocoded: 1, failed: 0 });
    const after = await getScheduleQualityMeasurements({ date: DAY }, mockConnection, NOW);
    expect(qualityForTech(after).missingCoordinates).toEqual([]);
    expect(await mockConnection('dispatch_alerts')
      .where({ type: 'schedule_route_quality', tech_id: TECH })
      .whereNull('resolved_at')).toHaveLength(0);
    expect((await mockConnection('dispatch_alerts').where({ id: opened.id }).first()).resolved_at).not.toBeNull();

    const ledger = await mockConnection('route_optimization_planner_runs')
      .where({ run_type: 'schedule_quality_change' }).orderBy('created_at', 'desc').first();
    const details = typeof ledger.result === 'string' ? JSON.parse(ledger.result) : ledger.result;
    expect(details.route_quality.find(row => row.technician_id === TECH)).toMatchObject({
      date: DAY,
      snapshot_phase: 'schedule_change',
      missingCoordinates: [],
    });
  }, 30000);

  test('customerIds refresh includes only active future stops inside the planning horizon', async () => {
    const futureOne = serviceId(10);
    const futureTwo = serviceId(11);
    const today = serviceId(12);
    const terminal = serviceId(13);
    const outside = serviceId(14);
    const otherCustomer = serviceId(15);
    await insertService(futureOne, {
      service_address_line1: '100 Primary Fixture Way',
      service_address_city: 'Bradenton',
      service_address_state: 'FL',
      service_address_zip: '34205',
    });
    await insertService(futureTwo, {
      scheduled_date: SECOND_DAY,
      status: 'pending',
      route_order: 1,
      service_address_line1: '100 Primary Fixture Way',
      service_address_city: 'Bradenton',
      service_address_state: 'FL',
      service_address_zip: '34205',
    });
    await insertService(today, { scheduled_date: TODAY, service_address_line1: '100 Primary Fixture Way' });
    await insertService(terminal, { status: 'completed', service_address_line1: '100 Primary Fixture Way' });
    await insertService(outside, { scheduled_date: OUTSIDE_HORIZON, service_address_line1: '100 Primary Fixture Way' });
    await insertService(otherCustomer, {
      customer_id: OTHER_CUSTOMER,
      scheduled_date: '2026-10-02',
      service_address_line1: '300 Other Fixture Way',
      service_address_city: 'Sarasota',
      service_address_state: 'FL',
      service_address_zip: '34236',
    });

    const refreshed = await refreshScheduleQualityAfterChange({ customerIds: [CUSTOMER], now: NOW }, mockConnection);

    expect(QUALITY_EXCLUDED_STATUSES).toContain('completed');
    expect(refreshed).toMatchObject({ status: 'recorded', dates: [DAY, SECOND_DAY] });
    const ledger = await mockConnection('route_optimization_planner_runs').where({ id: refreshed.ledgerId }).first();
    const details = typeof ledger.result === 'string' ? JSON.parse(ledger.result) : ledger.result;
    expect([...new Set(details.route_quality.map(row => row.date))]).toEqual([DAY, SECOND_DAY]);
    expect(details.route_quality.filter(row => row.technician_id === TECH))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ date: DAY, missingCoordinates: [] }),
        expect.objectContaining({ date: SECOND_DAY, missingCoordinates: [] }),
      ]));
    const plannedIds = details.route_quality.flatMap(row => row.plannedStops.map(stop => stop.id));
    expect(plannedIds.sort()).toEqual([futureOne, futureTwo].sort());
    for (const excluded of [today, terminal, outside, otherCustomer]) expect(plannedIds).not.toContain(excluded);
  }, 30000);
});
