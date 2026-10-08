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
      location_received_at: 'NOW()', // round 45: server-side receipt stamped with new coordinates
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
      location_received_at: { raw: 'tech_status.location_received_at' }, // status-only keeps the previous receipt
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

  test('provider GPS timestamps are clamped when too far in the future', () => {
    const now = new Date('2026-05-05T12:00:00.000Z');
    expect(techStatus._test.normalizeProviderTimestamp('2026-05-05T12:01:59.000Z', now))
      .toEqual(new Date('2026-05-05T12:01:59.000Z'));
    expect(techStatus._test.normalizeProviderTimestamp('2026-05-05T12:02:01.000Z', now))
      .toBe(now);
    expect(techStatus._test.normalizeProviderTimestamp('not-a-date', now))
      .toBe(now);
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
    const [, values] = raw.mock.calls[0];
    expect(sql).toContain('location_updated_at, location_received_at)');
    expect(sql).toContain('EXCLUDED.location_updated_at >= tech_status.location_updated_at');
    expect(sql).toContain('ELSE tech_status.location_updated_at');
    expect(sql).toContain('RETURNING id, tech_id, status, lat, lng, current_job_id, updated_at, location_updated_at');
    expect(values).toHaveLength(5);
    expect(values[4]).toBeInstanceOf(Date);
  });

  test('GPS pings preserve provider-reported freshness timestamps', async () => {
    const raw = jest.fn().mockResolvedValue({
      rows: [{
        tech_id: 'tech-1',
        status: 'driving',
        lat: 27.1,
        lng: -82.2,
        current_job_id: null,
        updated_at: '2026-05-05T12:00:00.000Z',
        location_updated_at: '2026-05-05T11:58:00.000Z',
      }],
    });
    db.transaction = jest.fn(async (cb) => cb({ raw }));

    await techStatus.pingTechLocation({
      tech_id: 'tech-1',
      lat: 27.1,
      lng: -82.2,
      ignition: true,
      speed_mph: 12,
      reported_at: '2026-05-05T11:58:00.000Z',
    });

    const [, values] = raw.mock.calls[0];
    expect(values[4]).toEqual(new Date('2026-05-05T11:58:00.000Z'));
  });
  // Codex round-37 P2: compare-and-write against the tracker mapping.
  test('a guarded ping writes only while technicians.bouncie_imei still equals the IMEI the point was fetched from', async () => {
    const raw = jest.fn().mockResolvedValue({
      rows: [{ tech_id: 'tech-1', status: 'idle', lat: 27.1, lng: -82.2, current_job_id: null, updated_at: '2026-05-05T12:00:00.000Z', location_updated_at: '2026-05-05T11:58:00.000Z' }],
    });
    db.transaction = jest.fn(async (cb) => cb({ raw }));
    await techStatus.pingTechLocation({ tech_id: 'tech-1', lat: 27.1, lng: -82.2, reported_at: '2026-05-05T11:58:00.000Z', requireBouncieImei: ' 356938035643809 ' });
    const [sql, values] = raw.mock.calls[0];
    expect(sql).toContain('WHERE EXISTS (SELECT 1 FROM technicians WHERE id = ?::uuid AND bouncie_imei = ? FOR SHARE)');
    expect(sql).not.toContain('VALUES (?, ?, ?, ?, NOW(), ?, clock_timestamp())');
    expect(sql).toContain('ON CONFLICT (tech_id) DO UPDATE SET');
    expect(values).toHaveLength(7);
    expect(values.slice(5)).toEqual(['tech-1', '356938035643809']);
  });

  test('a guarded ping whose mapping moved mid-flight matches no row: nothing is broadcast and null is returned', async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [] });
    db.transaction = jest.fn(async (cb) => cb({ raw }));
    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
    require('../sockets').getIo.mockReturnValue(io);
    const out = await techStatus.pingTechLocation({ tech_id: 'tech-1', lat: 27.1, lng: -82.2, requireBouncieImei: 'OLD-DEVICE' });
    expect(out).toBeNull();
    expect(io.to).not.toHaveBeenCalled();
    require('../sockets').getIo.mockReturnValue(null);
  });

  // Codex #5334 P2: the receipt time is the ACTUAL write instant (clock_timestamp()), never the transaction start.
  test('location_received_at is stamped with clock_timestamp() on the insert path AND the conflict path (guarded and unguarded)', async () => {
    for (const requireBouncieImei of [undefined, 'DEV-A']) {
      const raw = jest.fn().mockResolvedValue({ rows: [{ tech_id: 'tech-1', status: 'idle', lat: 1, lng: 2, current_job_id: null, updated_at: 'x', location_updated_at: 'y' }] });
      db.transaction = jest.fn(async (cb) => cb({ raw }));
      await techStatus.pingTechLocation({ tech_id: 'tech-1', lat: 27.1, lng: -82.2, ...(requireBouncieImei ? { requireBouncieImei } : {}) });
      const [sql] = raw.mock.calls[0];
      expect(sql).toContain('INSERT INTO tech_status (tech_id, status, lat, lng, updated_at, location_updated_at, location_received_at)');
      expect(sql).toContain('clock_timestamp()');
      expect(sql).toMatch(/THEN clock_timestamp\(\)\s+ELSE tech_status\.location_received_at/);
      expect(sql).not.toMatch(/location_received_at[^,]*NOW\(\)/);
    }
  });
  test('pingTechLocation takes no caller connection: it is never nested inside a provider handoff transaction (its broadcast fires after its own commit)', async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [{ tech_id: 'tech-1', status: 'idle', lat: 1, lng: 2, current_job_id: null, updated_at: 'x', location_updated_at: 'y' }] });
    db.transaction = jest.fn(async (cb) => cb({ raw }));
    const handoff = { transaction: jest.fn() };
    await techStatus.pingTechLocation({ tech_id: 'tech-1', lat: 27.1, lng: -82.2, dbh: handoff });
    expect(handoff.transaction).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('an unguarded ping is exactly the plain upsert (5 values, VALUES clause)', async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [{ tech_id: 'tech-1', status: 'idle', lat: 1, lng: 2, current_job_id: null, updated_at: 'x', location_updated_at: 'y' }] });
    db.transaction = jest.fn(async (cb) => cb({ raw }));
    await techStatus.pingTechLocation({ tech_id: 'tech-1', lat: 27.1, lng: -82.2 });
    const [sql, values] = raw.mock.calls[0];
    expect(sql).toContain('VALUES (?, ?, ?, ?, NOW(), ?, clock_timestamp())');
    expect(sql).not.toContain('WHERE EXISTS');
    expect(values).toHaveLength(5);
  });
  // Codex round-45 P2: the server's own receipt time for stored coordinates.
  test('a location ping stamps location_received_at = NOW() only when it writes the newer coordinates', async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [{ tech_id: 'tech-1', status: 'idle', lat: 27.1, lng: -82.2, current_job_id: null, updated_at: 'x', location_updated_at: 'y' }] });
    db.transaction = jest.fn(async (cb) => cb({ raw }));
    await techStatus.pingTechLocation({ tech_id: 'tech-1', lat: 27.1, lng: -82.2 });
    const [sql] = raw.mock.calls[0];
    expect(sql).toMatch(/location_received_at = CASE\s+WHEN tech_status\.location_updated_at IS NULL\s+OR EXCLUDED\.location_updated_at >= tech_status\.location_updated_at\s+THEN clock_timestamp\(\)\s+ELSE tech_status\.location_received_at\s+END/);
  });
  test('a status-only write (setTechJobStatus) never touches location_received_at (nor lat/lng)', async () => {
    db.raw = jest.fn().mockResolvedValue({ rows: [{ tech_id: 'tech-1', status: 'en_route', current_job_id: 'job-1', updated_at: 'x', location_updated_at: 'y' }] });
    await techStatus.setTechJobStatus({ tech_id: 'tech-1', status: 'en_route', current_job_id: 'job-1' });
    expect(db.raw.mock.calls[0][0]).not.toContain('location_received_at');
  });
});
