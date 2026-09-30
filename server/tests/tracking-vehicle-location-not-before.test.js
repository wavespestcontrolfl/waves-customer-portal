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

// `mapped`: what technicians.bouncie_imei reads at the mapping recheck (round-38 P2).
// `undefined` (default) = the same IMEI the caller passed, so existing cases are unaffected.
function mockTechStatus(row, mapped) {
  db.mockImplementation((table) => {
    if (table === 'tech_status') return { where: () => ({ first: async () => row }) };
    if (table === 'technicians') return { where: () => ({ first: async () => (typeof mapped === 'function' ? mapped() : { bouncie_imei: mapped === undefined ? 'NEW' : mapped }) }) };
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

// Codex round-37/38 P2: an in-flight Bouncie fetch from a device that was remapped
// meanwhile must neither write the old vehicle's point into the tech-keyed tech_status
// row NOR be returned to the caller.
describe('fallback is compare-and-write AND revalidated before the coordinates are returned', () => {
  const { pingTechLocation } = require('../services/tech-status');
  beforeEach(() => pingTechLocation.mockClear());
  const loc = () => ({ lat: 28.0, lng: -81.0, updatedAt: minutesAgo(0.1).toISOString() });
  const guardedStore = (store) => pingTechLocation.mockImplementation(async (args) => {
    if (args.requireBouncieImei != null && store.mappedImei !== args.requireBouncieImei) return null;
    store.techStatus = { lat: args.lat, lng: args.lng };
    return store.techStatus;
  });

  test('the fallback write carries the IMEI the point was fetched from', async () => {
    mockTechStatus(undefined, 'OLD-DEVICE');
    await resolveFreshTechPosition({ techId: 't1', bouncieImei: '  OLD-DEVICE ', bouncieService: bouncie(loc()) });
    expect(pingTechLocation).toHaveBeenCalledWith(expect.objectContaining({ tech_id: 't1', requireBouncieImei: 'OLD-DEVICE' }));
  });

  test('race: the mapping changes while the old device is being fetched -> the point is DISCARDED (null) and never cached', async () => {
    const store = { mappedImei: 'OLD-DEVICE', techStatus: null };
    guardedStore(store);
    mockTechStatus(undefined, () => ({ bouncie_imei: store.mappedImei }));
    const svc = { getLocationByImei: jest.fn(async () => { store.mappedImei = 'NEW-DEVICE'; return loc(); }) };
    const out = await resolveFreshTechPosition({ techId: 't1', bouncieImei: 'OLD-DEVICE', bouncieService: svc });
    await new Promise((resolve) => setImmediate(resolve));
    expect(out).toBeNull(); // fails closed: no map point, no ETA
    expect(store.techStatus).toBeNull();
    expect(pingTechLocation).not.toHaveBeenCalled();
  });

  test('no remap in flight: the coordinates are returned and the guarded write lands', async () => {
    const store = { mappedImei: 'OLD-DEVICE', techStatus: null };
    guardedStore(store);
    mockTechStatus(undefined, () => ({ bouncie_imei: store.mappedImei }));
    const out = await resolveFreshTechPosition({ techId: 't1', bouncieImei: 'OLD-DEVICE', bouncieService: bouncie(loc()) });
    await new Promise((resolve) => setImmediate(resolve));
    expect(out.source).toBe('bouncie_api');
    expect(store.techStatus).toEqual({ lat: 28.0, lng: -81.0 });
  });

  test('the mapping cannot be verified (read fails / technician row missing): the fetched point is discarded', async () => {
    mockTechStatus(undefined, () => { throw new Error('db down'); });
    expect(await resolveFreshTechPosition({ techId: 't1', bouncieImei: 'OLD-DEVICE', bouncieService: bouncie(loc()) })).toBeNull();
    mockTechStatus(undefined, () => null);
    expect(await resolveFreshTechPosition({ techId: 't1', bouncieImei: 'OLD-DEVICE', bouncieService: bouncie(loc()) })).toBeNull();
    expect(pingTechLocation).not.toHaveBeenCalled();
  });
});
