/**
 * reschedule-public.js's buildAvailabilityForService — Codex r5 P2 #5.
 *
 * The visit being rescheduled has a real scheduled_services row with its own
 * catalog identity (service_key_snapshot / service_type), never a /book
 * funnel selection. A cadence-specific catalog name like "Quarterly Pest
 * Control Service" never matches the 7-key funnel vocabulary
 * normalizeBookingServiceKey checks, so serviceKey alone silently degrades
 * to the no-credit legacy gap — this file locks in that the row's identity
 * is threaded through as serviceIdentity instead (booking.js's
 * bookingExpectedMinutes fallback, covered separately in
 * booking-expected-minutes-catalog.test.js).
 *
 * Isolated in its own file (rather than added to reschedule-public.test.js)
 * because it mocks routes/booking wholesale — that file's other tests never
 * touch that module and must not inherit the mock.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null),
}));

const mockBuildBookingAvailability = jest.fn().mockResolvedValue({ days: [] });
const mockResolveBookingCoords = jest.fn().mockResolvedValue({ lat: 27.4, lng: -82.4 });
const mockNormalizeBookingServiceKey = jest.fn((value) => {
  const known = new Set(['pest_control', 'lawn_care', 'mosquito', 'tree_shrub', 'termite', 'rodent', 'bora_care']);
  const text = String(value || '').trim().toLowerCase().replace(/ /g, '_');
  return known.has(text) ? text : '';
});
jest.mock('../routes/booking', () => ({
  _internals: {
    resolveBookingCoords: (...args) => mockResolveBookingCoords(...args),
    buildBookingAvailability: (...args) => mockBuildBookingAvailability(...args),
    normalizeBookingServiceKey: (...args) => mockNormalizeBookingServiceKey(...args),
  },
}));

const { buildAvailabilityForService } = require('../routes/reschedule-public')._test;
const buildBookingAvailability = mockBuildBookingAvailability;

const SVC = {
  id: 'svc-1',
  latitude: '27.4', longitude: '-82.4',
  estimated_duration_minutes: 60,
  self_booking_id: null,
  service_type: 'Quarterly Pest Control Service',
  service_key_snapshot: 'quarterly_pest',
};

const CONFIG = { advance_days_min: 1, advance_days_max: 14 };

beforeEach(() => jest.clearAllMocks());

test('a cadence-specific service_type threads through as serviceIdentity (serviceKey resolves empty)', async () => {
  buildBookingAvailability.mockResolvedValue({ days: [] });
  await buildAvailabilityForService(SVC, { rangeFrom: '2026-10-01', rangeTo: '2026-10-01', config: CONFIG });

  expect(buildBookingAvailability).toHaveBeenCalledWith(expect.objectContaining({
    serviceKey: '', // "Quarterly Pest Control Service" is not a funnel key/alias
    serviceIdentity: { catalogServiceKey: 'quarterly_pest', serviceType: 'Quarterly Pest Control Service' },
    excludeServiceIds: ['svc-1'],
  }));
});

test('no service_key_snapshot on the row: serviceIdentity still carries the service_type for a services.name lookup', async () => {
  await buildAvailabilityForService(
    { ...SVC, service_key_snapshot: null },
    { rangeFrom: '2026-10-01', rangeTo: '2026-10-01', config: CONFIG },
  );

  expect(buildBookingAvailability).toHaveBeenCalledWith(expect.objectContaining({
    serviceIdentity: { catalogServiceKey: null, serviceType: 'Quarterly Pest Control Service' },
  }));
});

test('a plain funnel-vocabulary service_type ("pest_control") still resolves serviceKey directly', async () => {
  await buildAvailabilityForService(
    { ...SVC, service_type: 'pest_control' },
    { rangeFrom: '2026-10-01', rangeTo: '2026-10-01', config: CONFIG },
  );

  expect(buildBookingAvailability).toHaveBeenCalledWith(expect.objectContaining({
    serviceKey: 'pest_control',
    serviceIdentity: { catalogServiceKey: 'quarterly_pest', serviceType: 'pest_control' },
  }));
});
