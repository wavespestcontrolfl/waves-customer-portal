/**
 * resolveFreshTechPosition reads the technician's CURRENT tracker mapping itself, in the same
 * statement as the tech_status cache (technicians LEFT JOIN tech_status), and derives the cache
 * cutoff from that current row (Codex round-44 P2 — the 5th/6th remap race). tech_status stores
 * no device identity, so a cached fix is trusted only if reported STRICTLY AFTER the mapping's last
 * change; a caller-passed `cachedNotBefore` can only tighten. The Bouncie fallback fetches for the
 * CURRENT IMEI and serves the point only if the row-locked guarded write RETURNS a row — a null, a
 * timeout or an error all mean "unverifiable": no position. Synthetic data only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/tech-status', () => ({ pingTechLocation: jest.fn() }));

const db = require('../models/db');
const { pingTechLocation } = require('../services/tech-status');
const { resolveFreshTechPosition } = require('../services/tracking-vehicle-location');

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);
// `received` = when the SERVER stored these coordinates (tech_status.location_received_at); defaults to the fix time.
const fixRow = (minutes = 1, received = minutes) => ({ lat: '27.1', lng: '-82.2', location_updated_at: minutesAgo(minutes), location_received_at: minutesAgo(received) });

// A mutable world the single joined query reads at call time.
let world;
let queries;
function install({ imei = 'DEV-A', changedAt = null, ts = null } = {}) {
  world = { tech: { bouncie_imei: imei, bouncie_imei_changed_at: changedAt }, ts };
  queries = [];
  db.mockImplementation((table) => {
    queries.push(table);
    if (table !== 'technicians as t') throw new Error(`unexpected table ${table}`);
    return {
      leftJoin: (joined, l, r) => {
        queries.push(`join:${joined}:${l}=${r}`);
        return { where: () => ({ first: async (...cols) => { queries.push(`cols:${cols.join(',')}`); return world.tech ? { ...world.tech, lat: null, lng: null, location_updated_at: null, location_received_at: null, ...(world.ts || {}) } : undefined; } }) };
      },
    };
  });
}
const bouncie = (loc, onCall) => ({ getLocationByImei: jest.fn(async (imei) => { if (onCall) onCall(imei); return loc; }) });
const freshLoc = () => ({ lat: 28.0, lng: -81.0, updatedAt: minutesAgo(0.1).toISOString() });

beforeEach(() => { db.mockReset(); pingTechLocation.mockReset(); });

describe('one statement: current mapping + cache', () => {
  test('the query joins technicians to tech_status and selects the mapping columns with the cache columns', async () => {
    install({ ts: fixRow(1) });
    await resolveFreshTechPosition({ techId: 't1' });
    expect(queries).toEqual(['technicians as t', 'join:tech_status as ts:ts.tech_id=t.id', 'cols:t.bouncie_imei,t.bouncie_imei_changed_at,ts.lat,ts.lng,ts.location_updated_at,ts.location_received_at']);
  });
  test('never remapped (NULL change time): a fresh cached fix is trusted, no fallback call', async () => {
    install({ ts: fixRow(1) });
    const svc = bouncie(null);
    const out = await resolveFreshTechPosition({ techId: 't1', bouncieService: svc });
    expect(out.source).toBe('tech_status');
    expect(svc.getLocationByImei).not.toHaveBeenCalled();
  });
  test('a fix reported AFTER the mapping change is trusted; one at/before it is bypassed for the device itself', async () => {
    install({ changedAt: minutesAgo(3), ts: fixRow(1) });
    expect((await resolveFreshTechPosition({ techId: 't1' })).source).toBe('tech_status');
    install({ changedAt: minutesAgo(2), ts: fixRow(3) });
    pingTechLocation.mockResolvedValue({ tech_id: 't1' });
    const svc = bouncie(freshLoc());
    const out = await resolveFreshTechPosition({ techId: 't1', bouncieService: svc });
    expect(out.source).toBe('bouncie_api');
    expect(svc.getLocationByImei).toHaveBeenCalledWith('DEV-A');
    // strict: equal instants are not "after"
    const t = minutesAgo(1);
    install({ changedAt: t, ts: { ...fixRow(1), location_updated_at: t, location_received_at: t } });
    pingTechLocation.mockResolvedValue({ tech_id: 't1' });
    expect((await resolveFreshTechPosition({ techId: 't1', bouncieService: bouncie(freshLoc()) })).source).toBe('bouncie_api');
  });
  test('a present-but-unreadable change time fails closed (cache bypassed)', async () => {
    install({ changedAt: 'garbage', ts: fixRow(1) });
    pingTechLocation.mockResolvedValue({ tech_id: 't1' });
    expect((await resolveFreshTechPosition({ techId: 't1', bouncieService: bouncie(freshLoc()) })).source).toBe('bouncie_api');
  });
  test('a caller-passed cachedNotBefore is only an EXTRA floor: it tightens, never loosens', async () => {
    install({ changedAt: minutesAgo(10), ts: fixRow(3) });
    pingTechLocation.mockResolvedValue({ tech_id: 't1' });
    // caller floor newer than the fix -> bypassed even though the current mapping allows it
    expect((await resolveFreshTechPosition({ techId: 't1', cachedNotBefore: minutesAgo(2), bouncieService: bouncie(freshLoc()) })).source).toBe('bouncie_api');
    // a caller floor OLDER than the current mapping change cannot loosen it
    install({ changedAt: minutesAgo(2), ts: fixRow(3) });
    expect((await resolveFreshTechPosition({ techId: 't1', cachedNotBefore: minutesAgo(30), bouncieService: bouncie(freshLoc()) })).source).toBe('bouncie_api');
  });
  test('the A->B remap AFTER the caller read its own row: the lookup uses the CURRENT change time, not the caller\'s stale one', async () => {
    // caller believed "never remapped" (passes null) but the mapping changed 30 s ago; the cached point is 2 min old (device A's)
    install({ imei: 'DEV-B', changedAt: new Date(Date.now() - 30e3), ts: fixRow(2) });
    pingTechLocation.mockResolvedValue({ tech_id: 't1' });
    const svc = bouncie(freshLoc());
    const out = await resolveFreshTechPosition({ techId: 't1', cachedNotBefore: null, bouncieService: svc });
    expect(out.source).toBe('bouncie_api');
    expect(svc.getLocationByImei).toHaveBeenCalledWith('DEV-B'); // the CURRENT mapped imei (the function takes no caller IMEI)
  });
  test('cache-only callers (allowBouncieFallback false) get null rather than a stale point', async () => {
    install({ changedAt: minutesAgo(1), ts: fixRow(3) });
    expect(await resolveFreshTechPosition({ techId: 't1', allowBouncieFallback: false })).toBeNull();
  });
  test('no technician row, or a failed read, means no position (cannot prove the vehicle)', async () => {
    install(); world.tech = null;
    expect(await resolveFreshTechPosition({ techId: 't1', bouncieService: bouncie(freshLoc()) })).toBeNull();
    db.mockImplementation(() => { throw new Error('db down'); });
    expect(await resolveFreshTechPosition({ techId: 't1', bouncieService: bouncie(freshLoc()) })).toBeNull();
  });
  test('a technician with no tracker configured has no fallback device', async () => {
    install({ imei: '  ', ts: null });
    const svc = bouncie(freshLoc());
    expect(await resolveFreshTechPosition({ techId: 't1', bouncieService: svc })).toBeNull();
    expect(svc.getLocationByImei).not.toHaveBeenCalled();
  });
});

describe('the cache needs BOTH a provider fix and a server receipt after the remap (round 45)', () => {
  const future = (seconds) => new Date(Date.now() + seconds * 1000);
  test('a FUTURE-skewed provider fix (accepted by the tracker up to 2 min ahead) that the server stored BEFORE the remap is bypassed', async () => {
    // remap 30 s ago; the old device's point was stored 2 min ago but carries a fix time 60 s in the FUTURE
    install({ imei: 'DEV-B', changedAt: new Date(Date.now() - 30e3), ts: { lat: '27.1', lng: '-82.2', location_updated_at: future(60), location_received_at: minutesAgo(2) } });
    pingTechLocation.mockResolvedValue({ tech_id: 't1' });
    const svc = bouncie(freshLoc());
    const out = await resolveFreshTechPosition({ techId: 't1', bouncieService: svc });
    expect(out.source).toBe('bouncie_api');
    expect(svc.getLocationByImei).toHaveBeenCalledWith('DEV-B');
  });
  test('a point the server stored AFTER the remap (and whose fix postdates it) is trusted', async () => {
    install({ changedAt: minutesAgo(3), ts: fixRow(1, 0.5) });
    expect((await resolveFreshTechPosition({ techId: 't1' })).source).toBe('tech_status');
  });
  test('a fix AFTER the remap but received BEFORE it (clock skew) is bypassed; a missing receipt cannot prove it either', async () => {
    pingTechLocation.mockResolvedValue({ tech_id: 't1' });
    install({ changedAt: minutesAgo(1), ts: { ...fixRow(0.5), location_received_at: minutesAgo(2) } });
    expect((await resolveFreshTechPosition({ techId: 't1', bouncieService: bouncie(freshLoc()) })).source).toBe('bouncie_api');
    install({ changedAt: minutesAgo(1), ts: { ...fixRow(0.5), location_received_at: null } });
    expect((await resolveFreshTechPosition({ techId: 't1', bouncieService: bouncie(freshLoc()) })).source).toBe('bouncie_api');
  });
  test('never remapped (NULL change time): the receipt is not consulted, so pre-migration rows keep working', async () => {
    install({ changedAt: null, ts: { ...fixRow(1), location_received_at: null } });
    expect((await resolveFreshTechPosition({ techId: 't1' })).source).toBe('tech_status');
  });
  test('tech_status.updated_at is never part of the decision (status-only writes restamp it)', async () => {
    // an old point, freshly restamped updated_at by a status-only write after the remap: still bypassed
    install({ changedAt: minutesAgo(1), ts: { ...fixRow(3), updated_at: new Date() } });
    pingTechLocation.mockResolvedValue({ tech_id: 't1' });
    expect((await resolveFreshTechPosition({ techId: 't1', bouncieService: bouncie(freshLoc()) })).source).toBe('bouncie_api');
  });
});

describe('the fallback is served only when the guarded write returns a row', () => {
  test('the write carries the IMEI the point was fetched from', async () => {
    install({ imei: ' DEV-A ', ts: null });
    pingTechLocation.mockResolvedValue({ tech_id: 't1' });
    await resolveFreshTechPosition({ techId: 't1', bouncieService: bouncie(freshLoc()) });
    expect(pingTechLocation).toHaveBeenCalledWith(expect.objectContaining({ tech_id: 't1', requireBouncieImei: 'DEV-A' }));
  });
  test('write returned a row: the point is served', async () => {
    install({ ts: null });
    pingTechLocation.mockResolvedValue({ tech_id: 't1', lat: 28 });
    const out = await resolveFreshTechPosition({ techId: 't1', bouncieService: bouncie(freshLoc()) });
    expect(out).toMatchObject({ source: 'bouncie_api', lat: 28.0, lng: -81.0 });
  });
  test('remap lands during the fetch: the guarded write returns null -> no position', async () => {
    install({ ts: null });
    pingTechLocation.mockImplementation(async (a) => (world.tech.bouncie_imei === a.requireBouncieImei ? { tech_id: 't1' } : null));
    const svc = bouncie(freshLoc(), () => { world.tech.bouncie_imei = 'DEV-B'; });
    expect(await resolveFreshTechPosition({ techId: 't1', bouncieService: svc })).toBeNull();
  });
  test('the guarded write times out (waiting on the technician row): no position, never the fetched point', async () => {
    install({ ts: null });
    pingTechLocation.mockReturnValue(new Promise(() => {}));
    const started = Date.now();
    expect(await resolveFreshTechPosition({ techId: 't1', bouncieService: bouncie(freshLoc()), timeoutMs: 40 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
  test('the guarded write throws: no position', async () => {
    install({ ts: null });
    pingTechLocation.mockRejectedValue(new Error('db down'));
    expect(await resolveFreshTechPosition({ techId: 't1', bouncieService: bouncie(freshLoc()) })).toBeNull();
  });
  test('the device returns nothing / a stale reading: no position and no write', async () => {
    install({ ts: null });
    expect(await resolveFreshTechPosition({ techId: 't1', bouncieService: bouncie(null) })).toBeNull();
    expect(await resolveFreshTechPosition({ techId: 't1', bouncieService: bouncie({ lat: 1, lng: 2, updatedAt: minutesAgo(30).toISOString() }) })).toBeNull();
    expect(pingTechLocation).not.toHaveBeenCalled();
  });
});
