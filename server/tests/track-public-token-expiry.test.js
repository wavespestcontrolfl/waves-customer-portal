jest.mock('../services/geocoder', () => ({
  ensureCustomerGeocoded: jest.fn(),
}));

const { ensureCustomerGeocoded } = require('../services/geocoder');
const trackPublicRouter = require('../routes/track-public');

describe('public track token expiry', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-05T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('keeps missing and future expirations live', () => {
    expect(trackPublicRouter._test.isTrackTokenLive(null)).toBe(true);
    expect(trackPublicRouter._test.isTrackTokenLive('2026-05-05T12:00:00.000Z')).toBe(true);
    expect(trackPublicRouter._test.isTrackTokenLive('2026-05-05T12:01:00.000Z')).toBe(true);
  });

  test('fails closed for expired or malformed expirations', () => {
    expect(trackPublicRouter._test.isTrackTokenLive('2026-05-05T11:59:59.999Z')).toBe(false);
    expect(trackPublicRouter._test.isTrackTokenLive('not-a-date')).toBe(false);
  });

  test('only exposes fresh vehicle timestamps', () => {
    expect(trackPublicRouter._test.isFreshVehicleTimestamp('2026-05-05T11:55:00.000Z')).toBe(true);
    expect(trackPublicRouter._test.isFreshVehicleTimestamp('2026-05-05T11:54:59.999Z')).toBe(false);
    expect(trackPublicRouter._test.isFreshVehicleTimestamp(null)).toBe(false);
    expect(trackPublicRouter._test.isFreshVehicleTimestamp('not-a-date')).toBe(false);
  });

  test('geocodes en-route destination coordinates when customer record is missing them', async () => {
    ensureCustomerGeocoded.mockResolvedValue({ lat: 27.4208, lng: -82.4929 });

    const row = await trackPublicRouter._test.ensureEnRouteDestinationGeocoded({
      track_state: 'en_route',
      customer_id: 'cust-1',
      latitude: null,
      longitude: null,
    });

    expect(ensureCustomerGeocoded).toHaveBeenCalledWith('cust-1');
    expect(row.latitude).toBe(27.4208);
    expect(row.longitude).toBe(-82.4929);
  });

  test('does not geocode non-en-route tracking states', async () => {
    const row = await trackPublicRouter._test.ensureEnRouteDestinationGeocoded({
      track_state: 'scheduled',
      customer_id: 'cust-1',
      latitude: null,
      longitude: null,
    });

    expect(ensureCustomerGeocoded).not.toHaveBeenCalled();
    expect(row.latitude).toBeNull();
    expect(row.longitude).toBeNull();
  });
});
