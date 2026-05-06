const {
  calculateBoundedTrackingEta,
  finiteNumber,
} = require('../services/customer-tracking-eta');

describe('customer tracking ETA helper', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-05T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('finiteNumber rejects empty and non-finite coordinates', () => {
    expect(finiteNumber(null)).toBeNull();
    expect(finiteNumber(undefined)).toBeNull();
    expect(finiteNumber('')).toBeNull();
    expect(finiteNumber('abc')).toBeNull();
    expect(finiteNumber('27.1')).toBe(27.1);
  });

  test('does not call ETA provider when coordinates are missing or GPS is stale', async () => {
    const bouncie = { calculateETAFromCoords: jest.fn() };

    await expect(calculateBoundedTrackingEta({
      techLat: '',
      techLng: '-82.2',
      customerLat: '27.2',
      customerLng: '-82.3',
      techUpdatedAt: '2026-05-05T11:59:00.000Z',
      bouncieService: bouncie,
    })).resolves.toBeNull();

    await expect(calculateBoundedTrackingEta({
      techLat: '27.1',
      techLng: '-82.2',
      customerLat: '27.2',
      customerLng: '-82.3',
      techUpdatedAt: '2026-05-05T11:54:59.000Z',
      bouncieService: bouncie,
    })).resolves.toBeNull();

    expect(bouncie.calculateETAFromCoords).not.toHaveBeenCalled();
  });

  test('maps fresh provider ETA without exposing coordinates', async () => {
    const bouncie = {
      calculateETAFromCoords: jest.fn().mockResolvedValue({
        etaMinutes: 11,
        distanceMiles: 3.8,
        source: 'google',
      }),
    };

    const eta = await calculateBoundedTrackingEta({
      techLat: '27.1',
      techLng: '-82.2',
      customerLat: '27.2',
      customerLng: '-82.3',
      techUpdatedAt: '2026-05-05T11:59:00.000Z',
      bouncieService: bouncie,
    });

    expect(bouncie.calculateETAFromCoords).toHaveBeenCalledWith(27.1, -82.2, 27.2, -82.3);
    expect(eta).toEqual({
      minutes: 11,
      distanceMiles: 3.8,
      source: 'google',
      techUpdatedAt: '2026-05-05T11:59:00.000Z',
    });
    expect(eta).not.toHaveProperty('lat');
    expect(eta).not.toHaveProperty('lng');
  });

  test('times out slow ETA providers to keep tracker reads moving', async () => {
    const bouncie = {
      calculateETAFromCoords: jest.fn().mockImplementation(() => new Promise(() => {})),
    };

    const pending = calculateBoundedTrackingEta({
      techLat: '27.1',
      techLng: '-82.2',
      customerLat: '27.2',
      customerLng: '-82.3',
      techUpdatedAt: '2026-05-05T11:59:00.000Z',
      bouncieService: bouncie,
    });

    jest.advanceTimersByTime(750);

    await expect(pending).resolves.toBeNull();
    expect(bouncie.calculateETAFromCoords).toHaveBeenCalledWith(27.1, -82.2, 27.2, -82.3);
  });
});
