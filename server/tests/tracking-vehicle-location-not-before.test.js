/**
 * resolveFreshTechPosition `cachedNotBefore` (Codex round-24 P2, PR #5334):
 * tech_status is keyed by technician and stores no device identity, so a cached
 * fix reported BEFORE the technician's tracker mapping was last edited may be
 * the old vehicle's. Such a fix is bypassed for the configured device's own
 * Bouncie position; without the option the behavior is unchanged.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tech-status', () => ({ pingTechLocation: jest.fn(() => Promise.resolve()) }));

const db = require('../models/db');
const { resolveFreshTechPosition } = require('../services/tracking-vehicle-location');

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);

function mockTechStatus(row) {
  db.mockImplementation((table) => {
    if (table === 'tech_status') return { where: () => ({ first: async () => row }) };
    throw new Error(`unexpected table ${table}`);
  });
}
const bouncie = (loc) => ({ getLocationByImei: jest.fn(async () => loc) });

beforeEach(() => db.mockReset());

test('no cachedNotBefore: a fresh tech_status fix is returned as before', async () => {
  mockTechStatus({ lat: '27.1', lng: '-82.2', location_updated_at: minutesAgo(1) });
  const svc = bouncie(null);
  const out = await resolveFreshTechPosition({ techId: 't1', bouncieImei: 'NEW', bouncieService: svc });
  expect(out.source).toBe('tech_status');
  expect(svc.getLocationByImei).not.toHaveBeenCalled();
});

test('a cached fix reported before the mapping edit is bypassed: the configured device is read instead', async () => {
  mockTechStatus({ lat: '27.1', lng: '-82.2', location_updated_at: minutesAgo(3) });
  const svc = bouncie({ lat: 28.0, lng: -81.0, updatedAt: minutesAgo(0.2).toISOString() });
  const out = await resolveFreshTechPosition({ techId: 't1', bouncieImei: 'NEW', bouncieService: svc, cachedNotBefore: minutesAgo(2) });
  expect(out.source).toBe('bouncie_api');
  expect(out.lat).toBe(28.0);
  expect(svc.getLocationByImei).toHaveBeenCalledWith('NEW');
});

test('a cached fix reported after the mapping edit is trusted', async () => {
  mockTechStatus({ lat: '27.1', lng: '-82.2', location_updated_at: minutesAgo(1) });
  const svc = bouncie(null);
  const out = await resolveFreshTechPosition({ techId: 't1', bouncieImei: 'NEW', bouncieService: svc, cachedNotBefore: minutesAgo(2) });
  expect(out.source).toBe('tech_status');
});

test('bypassed cache + the configured device unreadable: no position (fails closed)', async () => {
  mockTechStatus({ lat: '27.1', lng: '-82.2', location_updated_at: minutesAgo(3) });
  const out = await resolveFreshTechPosition({ techId: 't1', bouncieImei: 'NEW', bouncieService: bouncie(null), cachedNotBefore: minutesAgo(2) });
  expect(out).toBeNull();
});

// Codex round-37 P2: an in-flight Bouncie fetch from a device that was remapped meanwhile
// must not write the old vehicle's point into the tech-keyed tech_status row.
describe('fallback cache write is compare-and-write against the tracker mapping', () => {
  const { pingTechLocation } = require('../services/tech-status');
  beforeEach(() => pingTechLocation.mockClear());

  test('the fallback write carries the IMEI the point was fetched from', async () => {
    mockTechStatus(undefined);
    const svc = bouncie({ lat: 28.0, lng: -81.0, updatedAt: minutesAgo(0.2).toISOString() });
    await resolveFreshTechPosition({ techId: 't1', bouncieImei: '  OLD-DEVICE ', bouncieService: svc });
    expect(pingTechLocation).toHaveBeenCalledWith(expect.objectContaining({ tech_id: 't1', requireBouncieImei: 'OLD-DEVICE' }));
  });

  test('race: the mapping changes while the old device is being fetched -> the guarded write is dropped, the row keeps no old-vehicle point', async () => {
    mockTechStatus(undefined);
    const store = { mappedImei: 'OLD-DEVICE', techStatus: null };
    // In-memory model of the guarded statement: WHERE technicians.bouncie_imei = $imei.
    pingTechLocation.mockImplementation(async (args) => {
      if (args.requireBouncieImei != null && store.mappedImei !== args.requireBouncieImei) return null;
      store.techStatus = { lat: args.lat, lng: args.lng };
      return store.techStatus;
    });
    const svc = { getLocationByImei: jest.fn(async () => {
      store.mappedImei = 'NEW-DEVICE'; // admin remap lands while the old device is in flight
      return { lat: 28.0, lng: -81.0, updatedAt: minutesAgo(0.1).toISOString() };
    }) };
    const out = await resolveFreshTechPosition({ techId: 't1', bouncieImei: 'OLD-DEVICE', bouncieService: svc });
    await new Promise((resolve) => setImmediate(resolve));
    expect(out.source).toBe('bouncie_api'); // this request still answers from the device it asked
    expect(store.techStatus).toBeNull(); // ...but the old vehicle's point never seeds the cache
  });

  test('no remap in flight: the same guarded write lands', async () => {
    mockTechStatus(undefined);
    const store = { mappedImei: 'OLD-DEVICE', techStatus: null };
    pingTechLocation.mockImplementation(async (args) => {
      if (args.requireBouncieImei != null && store.mappedImei !== args.requireBouncieImei) return null;
      store.techStatus = { lat: args.lat, lng: args.lng };
      return store.techStatus;
    });
    await resolveFreshTechPosition({ techId: 't1', bouncieImei: 'OLD-DEVICE', bouncieService: bouncie({ lat: 28.0, lng: -81.0, updatedAt: minutesAgo(0.1).toISOString() }) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.techStatus).toEqual({ lat: 28.0, lng: -81.0 });
  });
});
