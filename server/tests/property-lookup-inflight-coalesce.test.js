/**
 * In-flight coalescing at the performPropertyLookup seam.
 *
 * A quote call fires BOTH the call-time property lookup and the estimator's
 * direct performPropertyLookup; the pending-ledger check in
 * call-property-lookup only defends one ordering, so the shared mechanism
 * must coalesce concurrent same-address callers itself (codex P1). Pins:
 * the mode gate (refresh/cacheOnly/persist:false never coalesce), the join
 * path returning a CLONE of the in-flight result (no cross-caller
 * aliasing), and rejection propagating to joiners. The join tests seed the
 * in-flight map directly — if the joiner ever fell through to the real
 * pipeline it would hit the unmocked provider stack and fail loudly.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn(() => { throw new Error('db must not be touched on the join path'); });
  fn.raw = jest.fn();
  fn.fn = { now: jest.fn(() => 'NOW') };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const route = require('../routes/property-lookup-v2');
const { performPropertyLookup } = route;
const { inFlightLookups, lookupCoalesceKey } = route._private;

const ADDR = '4720 60th St W, Bradenton, FL 34210';

afterEach(() => {
  inFlightLookups.clear();
});

describe('lookupCoalesceKey', () => {
  test('default mode keys by canonical address hash; variants collapse', () => {
    const a = lookupCoalesceKey(ADDR, {});
    const b = lookupCoalesceKey('4720 60TH ST W, bradenton, fl 34210', {});
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(b);
  });

  test('refresh, cacheOnly, and persist:false never coalesce', () => {
    expect(lookupCoalesceKey(ADDR, { refresh: true })).toBeNull();
    expect(lookupCoalesceKey(ADDR, { cacheOnly: true })).toBeNull();
    expect(lookupCoalesceKey(ADDR, { persist: false })).toBeNull();
  });
});

describe('join path', () => {
  test('a concurrent same-address caller adopts the in-flight result as a CLONE', async () => {
    const key = lookupCoalesceKey(ADDR, {});
    const shared = { enriched: { lat: 27.5, lng: -82.5 }, satellite: { inServiceArea: true } };
    let release;
    inFlightLookups.set(key, new Promise((resolve) => { release = resolve; }));

    const joiner = performPropertyLookup(ADDR);
    release(shared);
    const res = await joiner;

    expect(res).toEqual(shared);
    expect(res).not.toBe(shared);
    // One caller's mutation must never alias into another's result.
    res.enriched.lat = 0;
    expect(shared.enriched.lat).toBe(27.5);
  });

  test('an in-flight failure propagates to joiners (same outcome as running it)', async () => {
    const key = lookupCoalesceKey(ADDR, {});
    const failing = Promise.reject(new Error('trio timeout'));
    failing.catch(() => {}); // test-side guard only
    inFlightLookups.set(key, failing);

    await expect(performPropertyLookup(ADDR)).rejects.toThrow('trio timeout');
  });
});
