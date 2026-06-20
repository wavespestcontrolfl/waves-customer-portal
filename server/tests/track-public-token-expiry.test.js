jest.mock('../services/geocoder', () => ({
  ensureCustomerGeocoded: jest.fn(),
}));
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
const mockGetViewUrl = jest.fn();
jest.mock('../services/photos', () => ({
  getViewUrl: mockGetViewUrl,
}));

const { ensureCustomerGeocoded } = require('../services/geocoder');
const trackPublicRouter = require('../routes/track-public');

function makeQuery({ firstResult = null, selectResult = [] } = {}) {
  const chain = {
    where: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    first: jest.fn(async () => firstResult),
    select: jest.fn(async () => selectResult),
  };
  return chain;
}

function installSummaryDb({ record = null, photos = [], reviewRequest = null } = {}) {
  mockDb.mockImplementation((table) => {
    if (table === 'service_records') {
      return makeQuery({ firstResult: record });
    }
    if (table === 'service_photos') {
      return makeQuery({ selectResult: photos });
    }
    if (table === 'review_requests') {
      return makeQuery({ firstResult: reviewRequest });
    }
    return makeQuery();
  });
}

describe('public track token expiry', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-05T12:00:00.000Z'));
    mockDb.mockReset();
    mockGetViewUrl.mockReset();
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

  test('hides report token and photos when frozen delivery suppresses customer artifacts', async () => {
    installSummaryDb({
      record: {
        id: 'record-1',
        report_view_token: 'report-token',
        structured_notes: JSON.stringify({ typedReportDelivery: 'disabled' }),
      },
      photos: [{ s3_key: 'service-photos/record-1/internal.jpg' }],
      reviewRequest: { token: 'old-review-token' },
    });

    const summary = await trackPublicRouter._test.buildSummary({
      id: 'scheduled-1',
      customer_id: 'customer-1',
      completed_at: '2026-05-05T12:00:00.000Z',
    });

    expect(summary.serviceReportToken).toBeNull();
    expect(summary.photos).toEqual([]);
    expect(summary.reviewUrl).toBeNull();
    expect(mockDb.mock.calls.map(([table]) => table)).not.toContain('service_photos');
    expect(mockDb.mock.calls.map(([table]) => table)).not.toContain('review_requests');
    expect(mockGetViewUrl).not.toHaveBeenCalled();
  });

  test('presigns completion photos and review CTA when the frozen delivery is customer-visible', async () => {
    installSummaryDb({
      record: {
        id: 'record-1',
        report_view_token: 'report-token',
        structured_notes: JSON.stringify({ typedReportDelivery: 'auto_send' }),
      },
      photos: [
        { s3_key: 'service-photos/record-1/after-1.jpg' },
        { s3_key: null },
        { s3_key: 'service-photos/record-1/after-2.jpg' },
      ],
      reviewRequest: { token: 'review-token' },
    });
    mockGetViewUrl
      .mockResolvedValueOnce('https://signed.example/after-1.jpg')
      .mockResolvedValueOnce('https://signed.example/after-2.jpg');

    const summary = await trackPublicRouter._test.buildSummary({
      id: 'scheduled-1',
      customer_id: 'customer-1',
      completed_at: '2026-05-05T12:00:00.000Z',
    });

    expect(summary.serviceReportToken).toBe('report-token');
    expect(summary.photos).toEqual([
      'https://signed.example/after-1.jpg',
      'https://signed.example/after-2.jpg',
    ]);
    expect(summary.reviewUrl).toBe('/rate/review-token');
    expect(mockDb.mock.calls.map(([table]) => table)).toContain('service_photos');
    expect(mockDb.mock.calls.map(([table]) => table)).toContain('review_requests');
    expect(mockGetViewUrl).toHaveBeenCalledTimes(2);
  });
});
