import { describe, expect, it } from 'vitest';
import { ROUTE_SNAPSHOT_KEY, formatSnapshotTime, loadRouteSnapshot, saveRouteSnapshot, savedRouteNotice } from './routeSnapshot';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k), map };
}

describe('routeSnapshot', () => {
  it('round-trips the payload for the same tech and day', () => {
    const storage = memoryStorage();
    saveRouteSnapshot({ techId: 't1', date: '2026-10-02', data: { services: [{ id: 'a' }] } }, storage);
    const snapshot = loadRouteSnapshot({ techId: 't1', date: '2026-10-02' }, storage);
    expect(snapshot.data.services).toEqual([{ id: 'a' }]);
    expect(typeof snapshot.savedAt).toBe('string');
  });

  it('never restores another day or another technician', () => {
    const storage = memoryStorage();
    saveRouteSnapshot({ techId: 't1', date: '2026-10-01', data: { services: [] } }, storage);
    expect(loadRouteSnapshot({ techId: null, date: '2026-10-01' }, storage)).toBeNull();
    expect(storage.map.has(ROUTE_SNAPSHOT_KEY)).toBe(true);
    expect(loadRouteSnapshot({ techId: 't1', date: '2026-10-02' }, storage)).toBeNull();
    // A mismatched copy is deleted, not just skipped.
    expect(storage.map.has(ROUTE_SNAPSHOT_KEY)).toBe(false);
    saveRouteSnapshot({ techId: 't1', date: '2026-10-01', data: { services: [] } }, storage);
    expect(loadRouteSnapshot({ techId: 't2', date: '2026-10-01' }, storage)).toBeNull();
    expect(storage.map.has(ROUTE_SNAPSHOT_KEY)).toBe(false);
  });

  it('treats corrupt or partial storage as no snapshot', () => {
    expect(loadRouteSnapshot({ techId: 't1', date: '2026-10-02' }, memoryStorage({ [ROUTE_SNAPSHOT_KEY]: '{not json' }))).toBeNull();
    expect(loadRouteSnapshot({ techId: 't1', date: '2026-10-02' }, memoryStorage({ [ROUTE_SNAPSHOT_KEY]: JSON.stringify({ techId: 't1', date: '2026-10-02' }) }))).toBeNull();
  });

  it('survives a storage that throws', () => {
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
    expect(() => saveRouteSnapshot({ techId: 't1', date: '2026-10-02', data: {} }, broken)).not.toThrow();
    expect(loadRouteSnapshot({ techId: 't1', date: '2026-10-02' }, broken)).toBeNull();
  });

  it('labels the saved time in Eastern time', () => {
    expect(formatSnapshotTime('2026-10-02T11:42:00.000Z')).toBe('7:42 AM');
    expect(savedRouteNotice('2026-10-02T11:42:00.000Z')).toBe('No connection — showing your route as saved at 7:42 AM. Changes since then are not shown.');
    expect(formatSnapshotTime('garbage')).toBe('');
  });
});
