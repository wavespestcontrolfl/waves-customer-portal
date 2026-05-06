jest.mock('../models/db', () => jest.fn());
jest.mock('../sockets', () => ({
  getIo: jest.fn(() => null),
}));
jest.mock('../services/logger', () => ({
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const techStatus = require('../services/tech-status');

describe('tech_status GPS freshness writes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.fn = { now: jest.fn(() => 'NOW()') };
  });

  test('status-only job transitions do not refresh location_updated_at', async () => {
    db.raw = jest.fn().mockResolvedValue({
      rows: [{
        tech_id: 'tech-1',
        status: 'en_route',
        current_job_id: 'job-1',
        updated_at: '2026-05-05T12:00:00.000Z',
        location_updated_at: '2026-05-05T11:20:00.000Z',
      }],
    });

    await techStatus.setTechJobStatus({
      tech_id: 'tech-1',
      status: 'en_route',
      current_job_id: 'job-1',
    });

    const [sql] = db.raw.mock.calls[0];
    expect(sql).toContain('current_job_id = EXCLUDED.current_job_id');
    expect(sql).toContain('updated_at = NOW()');
    expect(sql).not.toMatch(/location_updated_at\s*=/);
    expect(sql).not.toContain('INSERT INTO tech_status (tech_id, status, current_job_id, updated_at, location_updated_at)');
  });

  test('upsertTechStatus refreshes location_updated_at only when coordinates are supplied', async () => {
    const insert = jest.fn().mockReturnThis();
    const onConflict = jest.fn().mockReturnThis();
    const merge = jest.fn().mockReturnThis();
    const returning = jest.fn().mockResolvedValue([{
      tech_id: 'tech-1',
      status: 'idle',
      lat: 27.1,
      lng: -82.2,
      location_updated_at: 'NOW()',
    }]);
    const table = { insert, onConflict, merge, returning };
    db.raw = jest.fn((sql) => ({ raw: sql }));
    db.transaction = jest.fn(async (cb) => cb(() => table));

    await techStatus.upsertTechStatus({
      tech_id: 'tech-1',
      status: 'idle',
      lat: 27.1,
      lng: -82.2,
    });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      lat: 27.1,
      lng: -82.2,
      location_updated_at: 'NOW()',
    }));
    expect(merge).toHaveBeenCalledWith(expect.objectContaining({
      location_updated_at: 'NOW()',
    }));

    await techStatus.upsertTechStatus({
      tech_id: 'tech-1',
      status: 'en_route',
      current_job_id: 'job-1',
    });

    expect(merge).toHaveBeenLastCalledWith(expect.objectContaining({
      lat: { raw: 'tech_status.lat' },
      lng: { raw: 'tech_status.lng' },
      location_updated_at: { raw: 'tech_status.location_updated_at' },
    }));
  });

  test('dispatch broadcasts strip stale coordinates', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-05T12:00:00.000Z'));

    expect(techStatus._test.sanitizeTechStatusForDispatch({
      tech_id: 'tech-1',
      lat: '27.1',
      lng: '-82.2',
      location_updated_at: '2026-05-05T11:59:00.000Z',
      eta_minutes: 12,
    })).toMatchObject({
      lat: '27.1',
      lng: '-82.2',
      eta_minutes: 12,
    });

    expect(techStatus._test.sanitizeTechStatusForDispatch({
      tech_id: 'tech-1',
      lat: '27.1',
      lng: '-82.2',
      location_updated_at: '2026-05-04T11:59:59.999Z',
      eta_minutes: 12,
    })).toMatchObject({
      lat: null,
      lng: null,
      eta_minutes: null,
    });

    expect(techStatus._test.sanitizeTechStatusForDispatch({
      tech_id: 'tech-1',
      lat: '27.1',
      lng: '-82.2',
      location_updated_at: null,
      eta_minutes: 12,
    })).toMatchObject({
      lat: null,
      lng: null,
      eta_minutes: null,
    });

    jest.useRealTimers();
  });

  test('GPS pings refresh location_updated_at with coordinates', async () => {
    const raw = jest.fn().mockResolvedValue({
      rows: [{
        tech_id: 'tech-1',
        status: 'driving',
        lat: 27.1,
        lng: -82.2,
        current_job_id: null,
        updated_at: '2026-05-05T12:00:00.000Z',
        location_updated_at: '2026-05-05T12:00:00.000Z',
      }],
    });
    db.transaction = jest.fn(async (cb) => cb({ raw }));

    await techStatus.pingTechLocation({
      tech_id: 'tech-1',
      lat: 27.1,
      lng: -82.2,
      ignition: true,
      speed_mph: 12,
    });

    const [sql] = raw.mock.calls[0];
    expect(sql).toContain('location_updated_at)');
    expect(sql).toContain('location_updated_at = NOW()');
    expect(sql).toContain('RETURNING id, tech_id, status, lat, lng, current_job_id, updated_at, location_updated_at');
  });
});
