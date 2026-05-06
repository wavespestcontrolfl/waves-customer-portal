const { _test } = require('../services/job-status');

describe('job-status customer ETA payload', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-05T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('returns null for non-en-route statuses', async () => {
    const eta = await _test.buildCustomerEta({
      job_id: 'job-1',
      tech_lat: '27.1',
      tech_lng: '-82.2',
      customer_latitude: '27.2',
      customer_longitude: '-82.3',
      tech_status_updated_at: '2026-05-05T11:59:00.000Z',
    }, 'on_site', {
      calculateETAFromCoords: jest.fn(),
    });

    expect(eta).toBeNull();
  });

  test('returns null when assigned tech GPS is missing or stale', async () => {
    const bouncie = { calculateETAFromCoords: jest.fn() };

    await expect(_test.buildCustomerEta({
      job_id: 'job-1',
      tech_lat: null,
      tech_lng: null,
      customer_latitude: '27.2',
      customer_longitude: '-82.3',
      tech_status_updated_at: '2026-05-05T11:59:00.000Z',
    }, 'en_route', bouncie)).resolves.toBeNull();

    await expect(_test.buildCustomerEta({
      job_id: 'job-1',
      tech_lat: '27.1',
      tech_lng: '-82.2',
      customer_latitude: '27.2',
      customer_longitude: '-82.3',
      tech_status_updated_at: '2026-05-05T11:54:59.000Z',
    }, 'en_route', bouncie)).resolves.toBeNull();

    expect(bouncie.calculateETAFromCoords).not.toHaveBeenCalled();
  });

  test('uses assigned tech_status coordinates without exposing them', async () => {
    const bouncie = {
      calculateETAFromCoords: jest.fn().mockResolvedValue({
        etaMinutes: 12,
        distanceMiles: 4.3,
        source: 'google',
      }),
    };

    const eta = await _test.buildCustomerEta({
      job_id: 'job-1',
      tech_lat: '27.1',
      tech_lng: '-82.2',
      customer_latitude: '27.2',
      customer_longitude: '-82.3',
      tech_status_updated_at: '2026-05-05T11:59:00.000Z',
    }, 'en_route', bouncie);

    expect(bouncie.calculateETAFromCoords).toHaveBeenCalledWith(27.1, -82.2, 27.2, -82.3);
    expect(eta).toEqual({
      minutes: 12,
      distanceMiles: 4.3,
      source: 'google',
      techUpdatedAt: '2026-05-05T11:59:00.000Z',
    });
    expect(eta).not.toHaveProperty('lat');
    expect(eta).not.toHaveProperty('lng');
  });

  test('times out slow ETA providers to keep status transitions moving', async () => {
    const bouncie = {
      calculateETAFromCoords: jest.fn().mockImplementation(() => new Promise(() => {})),
    };

    const pending = _test.buildCustomerEta({
      job_id: 'job-1',
      tech_lat: '27.1',
      tech_lng: '-82.2',
      customer_latitude: '27.2',
      customer_longitude: '-82.3',
      tech_status_updated_at: '2026-05-05T11:59:00.000Z',
    }, 'en_route', bouncie);

    jest.advanceTimersByTime(750);

    await expect(pending).resolves.toBeNull();
    expect(bouncie.calculateETAFromCoords).toHaveBeenCalledWith(27.1, -82.2, 27.2, -82.3);
  });
});
