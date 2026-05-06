const trackPublicRouter = require('../routes/track-public');

describe('public track token expiry', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-05T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
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
});
