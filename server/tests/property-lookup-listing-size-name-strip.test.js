/**
 * A listing suite size (PR 5b) is persisted on the cached record like a
 * license size, but it names no business of its own: the Places listing
 * name that served as a match hint is stripped from it (nothing from Places
 * is stored). Only a DBPR license row keeps the name it vouched for.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const mock = jest.fn(() => { throw new Error('db not expected'); });
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  return mock;
});
const resolved = { current: null };
jest.mock('../services/commercial-suite-size', () => ({
  resolveCommercialSuiteSize: jest.fn(async () => resolved.current),
  SOURCES: { LISTING_VERIFIED_TEXT: 'listing_verified_text', LICENSE_SEATS: 'license_seats', SUITE_TYPE_DEFAULT: 'suite_type_default' },
}));

const { applyCommercialSuiteSize, commercialSuiteSizeStampIsFresh, listingSizeVerifyFlag } = require('../routes/property-lookup-v2')._private;
const { translateV2CallToV1Input } = require('../routes/property-lookup-v2');
const savedGate = process.env.GATE_LOOKUP_LISTING_SIZE;
afterEach(() => { if (savedGate === undefined) delete process.env.GATE_LOOKUP_LISTING_SIZE; else process.env.GATE_LOOKUP_LISTING_SIZE = savedGate; });

function profile() {
  return {
    homeSqFt: 0,
    commercialSubtype: 'office_retail',
    fieldVerifyFlags: [],
    _commercialSuiteCandidate: { address: '14617 SR 70 E, Bradenton, FL 34202', unitHint: '103', businessNameHint: 'Example Salon', commercialSubtype: 'office_retail' },
  };
}

test('a listing size drops the Places name hint, keeps the link, and flags the field MEDIUM with the link', async () => {
  resolved.current = { value: 1350, source: 'listing_verified_text', confidence: 'medium', businessName: 'Example Salon', url: 'https://www.loopnet.com/x', evidence: [{ source: 'listing_verified_text', detail: 'public listing', url: 'https://www.loopnet.com/x' }] };
  const p = await applyCommercialSuiteSize(profile(), {});
  expect(p.suiteSize).toMatchObject({ value: 1350, source: 'listing_verified_text', businessName: null, url: 'https://www.loopnet.com/x' });
  expect(p.homeSqFt).toBe(1350);
  const flag = p.fieldVerifyFlags.find((f) => f.field === 'homeSqFt');
  expect(flag).toMatchObject({ priority: 'MEDIUM', url: 'https://www.loopnet.com/x' });
  expect(flag.reason).toContain('1,350 sq ft');
  expect(flag.reason).toContain('confirm on site');
});

test('a license size keeps the name the public record vouched for', async () => {
  resolved.current = { value: 1400, source: 'license_seats', confidence: 'medium', businessName: 'Example Salon', seats: 25, evidence: [] };
  const p = await applyCommercialSuiteSize(profile(), {});
  expect(p.suiteSize).toMatchObject({ value: 1400, source: 'license_seats', businessName: 'Example Salon' });
  expect(p.fieldVerifyFlags.find((f) => f.field === 'homeSqFt')).toBeUndefined();
});

test('a persisted listing stamp is honoured only while the gate is on (kill switch stops cached listing sizes at once)', () => {
  const stamp = { value: 1350, source: 'listing_verified_text', resolvedAt: new Date().toISOString(), unitKey: '103' };
  process.env.GATE_LOOKUP_LISTING_SIZE = 'true';
  expect(commercialSuiteSizeStampIsFresh(stamp)).toBe(true);
  delete process.env.GATE_LOOKUP_LISTING_SIZE;
  expect(commercialSuiteSizeStampIsFresh(stamp)).toBe(false);
  // A license stamp is unaffected by this gate.
  expect(commercialSuiteSizeStampIsFresh({ value: 1400, source: 'license_seats', resolvedAt: new Date().toISOString() })).toBe(true);
  // And a listing stamp older than 90 days is stale even with the gate on.
  process.env.GATE_LOOKUP_LISTING_SIZE = 'true';
  expect(commercialSuiteSizeStampIsFresh({ ...stamp, resolvedAt: new Date(Date.now() - 91 * 24 * 3600 * 1000).toISOString() })).toBe(false);
});

test('the flag a reused cached listing stamp gets is the same one the fresh path adds', () => {
  const flag = listingSizeVerifyFlag({ value: 1350, url: 'https://www.loopnet.com/x' });
  expect(flag).toEqual({ field: 'homeSqFt', priority: 'MEDIUM', url: 'https://www.loopnet.com/x', reason: 'Suite size 1,350 sq ft read from a public listing (https://www.loopnet.com/x) — confirm on site before pricing' });
});

test('the pricing boundary refuses a profile that still carries a listing size after the gate went off (409 LISTING_SIZE_OFF)', () => {
  const p = { isCommercial: true, commercialSubtype: 'office_retail', homeSqFt: 1350, footprint: 1350, suiteSize: { value: 1350, source: 'listing_verified_text', url: 'https://www.loopnet.com/x' } };
  delete process.env.GATE_LOOKUP_LISTING_SIZE;
  expect(() => translateV2CallToV1Input(p, ['PEST'], {})).toThrow(expect.objectContaining({ code: 'LISTING_SIZE_OFF', statusCode: 409, failClosed: true }));
  process.env.GATE_LOOKUP_LISTING_SIZE = 'true';
  expect(() => translateV2CallToV1Input(p, ['PEST'], {})).not.toThrow(expect.objectContaining({ code: 'LISTING_SIZE_OFF' }));
  // A license size is not held to this gate.
  const lic = { ...p, suiteSize: { value: 1400, source: 'license_seats' } };
  delete process.env.GATE_LOOKUP_LISTING_SIZE;
  expect(() => translateV2CallToV1Input(lic, ['PEST'], {})).not.toThrow(expect.objectContaining({ code: 'LISTING_SIZE_OFF' }));
});

test('a license-backed listing size keeps the license\'s name and reads as a restaurant for the subtype', async () => {
  resolved.current = { value: 1350, source: 'listing_verified_text', confidence: 'medium', businessName: 'Example Taco Shop', businessType: 'restaurant_food', licenseBacked: true, seats: 25, url: 'https://www.loopnet.com/x', evidence: [] };
  const p = await applyCommercialSuiteSize(profile(), {});
  expect(p.suiteSize).toMatchObject({ value: 1350, source: 'listing_verified_text', businessName: 'Example Taco Shop', licenseBacked: true });
  expect(p.commercialSubtype).toBe('restaurant');
});
