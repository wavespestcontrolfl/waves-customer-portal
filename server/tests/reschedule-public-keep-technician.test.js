/**
 * The public reschedule link keeps the visit's own technician (owner 2026-10-25, "each
 * visit stays with its own technician"; the night run, the rain pass, the office and phone
 * moves already keep it). buildAvailabilityForService is the one builder behind the GET
 * list, the find-slots search, the commit's anti-forgery rebuild and the texting AI's
 * offers, so what it asks buildBookingAvailability for is what a customer can pick.
 *
 * Mocks routes/booking wholesale (like reschedule-public-service-identity.test.js), so it
 * lives in its own file.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null),
}));

const mockBuildBookingAvailability = jest.fn().mockResolvedValue({ days: [] });
jest.mock('../routes/booking', () => ({
  _internals: {
    resolveBookingCoords: jest.fn().mockResolvedValue({ lat: 27.4, lng: -82.4 }),
    buildBookingAvailability: (...args) => mockBuildBookingAvailability(...args),
    normalizeBookingServiceKey: jest.fn(() => ''),
    bookInsertionOffersLive: jest.fn(() => false),
  },
}));

const db = require('../models/db');
const { buildAvailabilityForService } = require('../routes/reschedule-public')._test;

const RANGE = { rangeFrom: '2026-10-01', rangeTo: '2026-10-14', config: { advance_days_min: 1, advance_days_max: 14 } };
const PEST_CATALOG = { category: 'pest_control', service_key: 'quarterly_pest', name: 'Quarterly Pest Control Service' };
const SVC = {
  id: 'svc-1',
  latitude: '27.4',
  longitude: '-82.4',
  estimated_duration_minutes: 30,
  technician_id: 'tech-a',
  service_id: 'catalog-pest',
  service_type: 'Quarterly Pest Control Service',
  service_key_snapshot: 'quarterly_pest',
};

const tables = [];
function wireDb({ tech = null, catalog = PEST_CATALOG } = {}) {
  tables.length = 0;
  db.mockImplementation((table) => {
    tables.push(table);
    return { where: () => ({ first: async () => (table === 'technicians' ? tech : catalog) }) };
  });
}

const askedFor = () => mockBuildBookingAvailability.mock.calls[0][0];

const GATE = 'GATE_SERVICE_LINE_MAP';
const previousGate = process.env[GATE];
afterAll(() => {
  if (previousGate === undefined) delete process.env[GATE]; else process.env[GATE] = previousGate;
});

beforeEach(() => {
  jest.clearAllMocks();
  wireDb();
  process.env[GATE] = 'live';
});

describe('buildAvailabilityForService — the visit keeps its technician', () => {
  test('a visit whose technician can take work is offered that technician only', async () => {
    wireDb({ tech: { employment_status: 'active', field_dispatchable: true } });
    await buildAvailabilityForService(SVC, RANGE);

    expect(askedFor().technicianId).toBe('tech-a');
    expect(askedFor()).not.toHaveProperty('serviceLines');
  });

  test.each([
    ['is not field dispatchable', { employment_status: 'active', field_dispatchable: false }],
    ['has left (inactive)', { employment_status: 'inactive', field_dispatchable: true }],
    ['row is gone', null],
  ])('a visit whose technician %s gets the line ranking instead', async (_label, tech) => {
    wireDb({ tech });
    await buildAvailabilityForService(SVC, RANGE);

    expect(askedFor()).not.toHaveProperty('technicianId');
    expect(askedFor().serviceLines).toEqual(['general']);
  });

  test('a visit with no technician gets the line ranking and reads no technician row', async () => {
    await buildAvailabilityForService({ ...SVC, technician_id: null }, RANGE);

    expect(tables).not.toContain('technicians');
    expect(askedFor()).not.toHaveProperty('technicianId');
    expect(askedFor().serviceLines).toEqual(['general']);
  });

  test('the catalog row decides the line (a lawn row reads lawn whatever the name says)', async () => {
    wireDb({ catalog: { category: 'lawn_care', service_key: 'top_dress', name: 'Top Dress' } });
    await buildAvailabilityForService({ ...SVC, technician_id: null, service_type: 'Top Dress' }, RANGE);

    expect(askedFor().serviceLines).toEqual(['lawn']);
  });

  test.each(['shadow', ''])('line map %p (not live): an unassigned visit reads no line and keeps today\'s offers', async (mode) => {
    process.env[GATE] = mode;
    await buildAvailabilityForService({ ...SVC, technician_id: null }, RANGE);

    expect(tables).toEqual([]);
    expect(askedFor()).not.toHaveProperty('technicianId');
    expect(askedFor()).not.toHaveProperty('serviceLines');
  });

  test('line map not live: an assignable technician is still kept', async () => {
    process.env[GATE] = 'shadow';
    wireDb({ tech: { employment_status: 'active', field_dispatchable: true } });
    await buildAvailabilityForService(SVC, RANGE);

    expect(askedFor().technicianId).toBe('tech-a');
  });

  test('an unassigned Waves Assessment gets neither rule (no line routes an assessment)', async () => {
    wireDb({ catalog: { category: 'lawn_care', service_key: 'lawn_inspection', name: 'Waves Assessment' } });
    await buildAvailabilityForService({
      ...SVC, technician_id: null, service_key_snapshot: 'lawn_inspection', service_type: 'Waves Assessment',
    }, RANGE);

    expect(askedFor()).not.toHaveProperty('technicianId');
    expect(askedFor()).not.toHaveProperty('serviceLines');
  });
});
