// ONE canonical bahia predicate (isBahiaGrass) and ONE gate-aware check (lawnV13NoBahiaProgram /
// bahiaHasNoProgram), used by every site: grass context, plan engine, completion actions, estimate
// review, protocol reader, operating layer, pricing, ranges, knowledge, AI context, the turf-profile
// route and the pricing cache. A lawn recorded as D, d_bahia, Argentine or Pensacola is bahia everywhere.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn((r, s, n) => n()), requireAdmin: jest.fn(), requireTechOrAdmin: jest.fn((r, s, n) => n()),
}));
jest.mock('../services/technician-visit-scope', () => ({ technicianServicesCustomer: async () => true }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const {
  isBahiaGrass, lawnV13NoBahiaProgram, bahiaHasNoProgram,
} = require('../services/lawn-program');
const { resolveTrackKey, normalizeGrassType, loadCustomerGrassContext, recordedGrassNamesBahia } = require('../services/lawn-grass-context');
const { getProtocol, normalizeLawnTrack } = require('../services/protocol-reader');
const engine = require('../services/waveguard-plan-engine');
const { estimateHasBahiaLawn } = require('../services/estimate-bahia-review');
const { estimatePricingCacheKey } = require('../services/estimate-pricing-cache');

const BAHIA = ['D', 'd', 'd_bahia', 'D_Bahia', 'd-bahia', 'bahia', 'BAHIA', 'Bahia', 'bahiagrass', 'Argentine Bahia', 'Pensacola', 'Pensacola bahia'];
const NOT_BAHIA = ['A', 'B', 'C1', 'C2', 'st_augustine', 'St. Augustine', 'bermuda', 'zoysia', 'mixed', 'unknown', 'centipede', '', null, undefined];

afterEach(() => { delete process.env.GATE_LAWN_V13; });

describe('the canonical predicate', () => {
  test.each(BAHIA)('isBahiaGrass(%j) is true', (value) => expect(isBahiaGrass(value)).toBe(true));
  test.each(NOT_BAHIA)('isBahiaGrass(%j) is false', (value) => expect(isBahiaGrass(value)).toBe(false));

  test('the gate-aware check follows GATE_LAWN_V13 and the program, never the alias', () => {
    expect(lawnV13NoBahiaProgram()).toBe(false);
    expect(bahiaHasNoProgram('D')).toBe(false);
    process.env.GATE_LAWN_V13 = 'true';
    expect(lawnV13NoBahiaProgram()).toBe(true);
    for (const value of BAHIA) expect(bahiaHasNoProgram(value)).toBe(true);
    for (const value of NOT_BAHIA) expect(bahiaHasNoProgram(value)).toBe(false);
  });
});

describe('grass context (C)', () => {
  test.each(BAHIA)('normalizeGrassType(%j) is bahia', (value) => expect(normalizeGrassType(value)).toBe('bahia'));

  test.each(BAHIA)('gate on: track_key %j, legacy lawn text %j: no track', async (code) => {
    process.env.GATE_LAWN_V13 = 'true';
    expect(resolveTrackKey(code, null)).toBeNull();
    expect(resolveTrackKey('st_augustine', code)).toBeNull();
    expect(recordedGrassNamesBahia({ track_key: code }, null)).toBe(true);
    expect(recordedGrassNamesBahia(null, code)).toBe(true);
    const fakeKnex = (table) => {
      const row = table === 'customer_turf_profiles' ? null : { lawn_type: code };
      const b = { where: () => b, first: () => Promise.resolve(row), catch: () => b };
      b.then = (resolve) => Promise.resolve(row).then(resolve);
      return b;
    };
    const ctx = await loadCustomerGrassContext('cust-1', fakeKnex);
    expect(ctx).toMatchObject({ grassType: 'bahia', trackKey: null, noProgram: true });
    // a recorded profile outranks the legacy text
    expect(recordedGrassNamesBahia({ grass_type: 'zoysia' }, code)).toBe(false);
  });

  test('gate off: a D legacy lawn text resolves to the old bahia track', () => {
    expect(resolveTrackKey(null, normalizeGrassType('D'))).toBe('bahia');
    // and a recorded track key keeps its old meaning: only a real track key resolves
    expect(resolveTrackKey('D', null)).toBeNull();
  });
});

describe('plan engine', () => {
  const date = new Date(Date.UTC(2026, 1, 15, 16));
  test.each(BAHIA)('gate on: %j in track_key or grass_type, or legacy text, has no program', (code) => {
    process.env.GATE_LAWN_V13 = 'true';
    for (const [profile, legacy] of [[{ track_key: code }, null], [{ grass_type: code, track_key: 'st_augustine' }, null], [null, code]]) {
      expect(engine.selectProtocolVisit(profile, date, legacy)).toMatchObject({ trackKey: null, track: null, v13NoProgram: true });
    }
  });
});

describe('protocol reader', () => {
  test.each(BAHIA)('gate on: %j has no program and is not offered', (code) => {
    process.env.GATE_LAWN_V13 = 'true';
    expect(normalizeLawnTrack(code)).toBe('bahia');
    const result = getProtocol({ service_type: 'lawn', lawn_track: code });
    expect(result.no_program).toBe(true);
    expect(result.protocol).toBeUndefined();
  });
});

describe('estimate review detection', () => {
  test.each(BAHIA)('%j on a lawn line is a bahia lawn plan', (code) => {
    expect(estimateHasBahiaLawn({ engineInputs: { services: { lawn: { track: code } } } })).toBe(true);
    expect(estimateHasBahiaLawn({ inputs: { svcLawn: true, grassType: code } })).toBe(true);
  });
  test.each(NOT_BAHIA.filter(Boolean))('%j is not', (code) => {
    expect(estimateHasBahiaLawn({ engineInputs: { services: { lawn: { track: code } } } })).toBe(false);
  });
});

describe('pricing and ranges follow the same predicate', () => {
  const { priceLawnCare } = require('../services/pricing-engine/service-pricing');
  test.each(['D', 'bahia', 'BAHIA'])('gate on: track %s is parked for review', (track) => {
    process.env.GATE_LAWN_V13 = 'true';
    expect(priceLawnCare({ turfSf: 4500, turfConfidence: 'HIGH' }, { track }).manualReviewReasons).toContain('lawn_v13_bahia_no_program');
  });
});

describe('turf-profile route tells the client (B)', () => {
  const router = require('../routes/admin-customer-turf-profile');
  const get = router.stack.find((layer) => layer.route?.methods.get).route.stack.at(-1).handle;
  const call = async (profile, lawnType) => {
    db.mockImplementation((table) => {
      const row = table === 'customers' ? { id: 'c1', lawn_type: lawnType } : (table === 'customer_turf_profiles' ? profile : null);
      const b = { where: () => b, first: () => Promise.resolve(row) };
      return b;
    });
    const res = { json: jest.fn(), status() { return this; } };
    await get({ params: { customerId: 'c1' } }, res, (err) => { throw err; });
    return res.json.mock.calls[0][0];
  };

  test('gate off: never a no-program lawn (the client keeps its old resolution)', async () => {
    expect((await call({ grass_type: 'bahia' }, null)).lawn_v13_no_program).toBe(false);
  });

  test.each([
    [{ grass_type: 'bahia', track_key: 'st_augustine' }, null, true],
    [{ grass_type: 'zoysia', track_key: 'D' }, null, true],
    [{ grass_type: 'st_augustine' }, null, false],
    [null, 'D', true],
    [null, 'Zoysia', false],
  ])('gate on: profile %j with legacy text %j -> %s', async (profile, lawnType, expected) => {
    process.env.GATE_LAWN_V13 = 'true';
    const body = await call(profile, lawnType);
    expect(body.lawn_v13_no_program).toBe(expected);
    expect(body).toHaveProperty('profile');
  });
});

describe('estimate pricing cache key (F)', () => {
  test('the gate state is part of the key, so unsetting it takes effect on the next read', () => {
    const estimate = { id: 'est-1', updated_at: '2026-10-06T12:00:00Z' };
    const off = estimatePricingCacheKey(estimate);
    process.env.GATE_LAWN_V13 = 'true';
    const on = estimatePricingCacheKey(estimate);
    expect(on).not.toBe(off);
    delete process.env.GATE_LAWN_V13;
    expect(estimatePricingCacheKey(estimate)).toBe(off);
    // a row with no version still keys on the gate, and clearing by id still reaches both
    expect(estimatePricingCacheKey({ id: 'est-2' })).toBe('est-2');
    process.env.GATE_LAWN_V13 = 'true';
    expect(estimatePricingCacheKey({ id: 'est-2' })).toBe('est-2:lawn-v13');
  });

  test('a cached bundle built with the gate on is not served once the gate is unset', () => {
    const { setEstimatePricingCache, getEstimatePricingCache, clearEstimatePricingCache } = require('../services/estimate-pricing-cache');
    const estimate = { id: 'est-3', updated_at: '2026-10-06T12:00:00Z' };
    process.env.GATE_LAWN_V13 = 'true';
    setEstimatePricingCache(estimate, { reviewed: true });
    expect(getEstimatePricingCache(estimate)).toEqual({ reviewed: true });
    delete process.env.GATE_LAWN_V13;
    expect(getEstimatePricingCache(estimate)).toBeNull();
    clearEstimatePricingCache('est-3');
    process.env.GATE_LAWN_V13 = 'true';
    expect(getEstimatePricingCache(estimate)).toBeNull();
  });
});
