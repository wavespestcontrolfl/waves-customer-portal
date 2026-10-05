/**
 * Address status line (address-match PR 4, GATE_LOOKUP_ADDRESS_STATUS): the
 * mapping from the provider-neutral validation result, the bounded and
 * memoized resolver, and the gate. No scope effect is tested by absence: the
 * module returns a small object and touches nothing else.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { resolveAddressStatus, addressStatusFromValidation, STATES, _private: { memo } } = require('../services/property-lookup/address-status');
const { deriveStatus } = require('../services/address-validation');

const saved = process.env.GATE_LOOKUP_ADDRESS_STATUS;
beforeEach(() => { process.env.GATE_LOOKUP_ADDRESS_STATUS = 'true'; memo.clear(); });
afterEach(() => { if (saved === undefined) delete process.env.GATE_LOOKUP_ADDRESS_STATUS; else process.env.GATE_LOOKUP_ADDRESS_STATUS = saved; });

const av = (over = {}) => ({ status: 'validated_accept', inServiceArea: true, county: 'Manatee', granularity: 'PREMISE', hasInferred: false, hasReplaced: false, hasUnconfirmed: false, missingComponents: [], addressUse: { business: null, residential: null, poBox: null }, ...over });

describe('addressStatusFromValidation', () => {
  test('confirmed, corrected, and Google\'s business / residential classification as given', () => {
    expect(addressStatusFromValidation(av({ addressUse: { business: true, residential: false } }))).toEqual({ state: STATES.CONFIRMED, use: { business: true, residential: false } });
    expect(addressStatusFromValidation(av({ status: 'corrected' }))).toEqual({ state: STATES.CONFIRMED, corrected: true, use: { business: null, residential: null } });
  });

  test('a premise whose only missing component is the unit is "building confirmed, unit missing"', () => {
    expect(addressStatusFromValidation(av({ status: 'ambiguous', missingComponents: ['subpremise'] })).state).toBe(STATES.UNIT_MISSING);
    // Anything else missing, an unconfirmed component, or no premise: needs confirmation.
    expect(addressStatusFromValidation(av({ status: 'ambiguous', missingComponents: ['subpremise', 'postal_code'] })).state).toBe(STATES.NEEDS_CONFIRMATION);
    expect(addressStatusFromValidation(av({ status: 'confirm_needed', missingComponents: ['subpremise'], hasUnconfirmed: true })).state).toBe(STATES.NEEDS_CONFIRMATION);
    expect(addressStatusFromValidation(av({ status: 'missing_component', granularity: 'ROUTE', missingComponents: ['street_number'] })).state).toBe(STATES.NEEDS_CONFIRMATION);
    expect(addressStatusFromValidation(av({ status: 'confirm_needed' })).state).toBe(STATES.NEEDS_CONFIRMATION);
  });

  test('outside the service area is its own state; an outage is never an address failure', () => {
    expect(addressStatusFromValidation(av({ status: 'out_of_service_area', inServiceArea: false })).state).toBe(STATES.OUTSIDE_SERVICE_AREA);
    for (const dead of [null, undefined, av({ status: 'api_unavailable' }), av({ status: 'not_attempted' })]) {
      expect(addressStatusFromValidation(dead)).toEqual({ state: STATES.UNAVAILABLE, use: { business: null, residential: null } });
    }
  });
});

describe('deriveStatus — Google address-use metadata', () => {
  test('carries metadata booleans, null when Google returned none', () => {
    const result = { verdict: { addressComplete: true, validationGranularity: 'PREMISE' }, address: { addressComponents: [] }, metadata: { business: true, residential: false } };
    expect(deriveStatus(result, 'Manatee').addressUse).toEqual({ business: true, residential: false, poBox: null });
    expect(deriveStatus({ verdict: {}, address: {} }, 'Manatee').addressUse).toEqual({ business: null, residential: null, poBox: null });
  });
});

describe('resolveAddressStatus', () => {
  test('gate off: null, no validation call', async () => {
    delete process.env.GATE_LOOKUP_ADDRESS_STATUS;
    const validate = jest.fn();
    expect(await resolveAddressStatus('100 Example St, Bradenton, FL 34202', { validate })).toBeNull();
    expect(validate).not.toHaveBeenCalled();
  });

  test('one call per address per 24 hours; a different spelling case or spacing is the same address', async () => {
    const validate = jest.fn(async () => av({ addressUse: { business: true, residential: null } }));
    let t = 1_000_000;
    const now = () => t;
    const first = await resolveAddressStatus('100 Example St, Bradenton, FL 34202', { validate, now });
    expect(first).toMatchObject({ state: STATES.CONFIRMED, use: { business: true, residential: null } });
    expect(first.checkedAt).toBe(new Date(1_000_000).toISOString());
    expect(validate.mock.calls[0][0]).toEqual(['100 Example St, Bradenton, FL 34202']);
    expect(validate.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    await resolveAddressStatus('100  example st, bradenton, fl 34202', { validate, now });
    expect(validate).toHaveBeenCalledTimes(1);
    t += 25 * 60 * 60 * 1000;
    await resolveAddressStatus('100 Example St, Bradenton, FL 34202', { validate, now });
    expect(validate).toHaveBeenCalledTimes(2);
  });

  test('a timeout or a thrown provider is "unavailable" and is not remembered', async () => {
    const hung = jest.fn(() => new Promise(() => {}));
    expect((await resolveAddressStatus('100 Example St', { validate: hung, timeoutMs: 20 })).state).toBe(STATES.UNAVAILABLE);
    const boom = jest.fn(async () => { throw new Error('provider down'); });
    expect((await resolveAddressStatus('100 Example St', { validate: boom })).state).toBe(STATES.UNAVAILABLE);
    const ok = jest.fn(async () => av());
    expect((await resolveAddressStatus('100 Example St', { validate: ok })).state).toBe(STATES.CONFIRMED);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  test('at the cap the provider call is aborted, and a second lookup of the same address joins the call in flight', async () => {
    let seen = null;
    const hung = jest.fn((lines, { signal }) => new Promise(() => { seen = signal; }));
    const a = resolveAddressStatus('100 Example St', { validate: hung, timeoutMs: 30 });
    const b = resolveAddressStatus('100 example st', { validate: hung, timeoutMs: 30 });
    expect((await a).state).toBe(STATES.UNAVAILABLE);
    expect((await b).state).toBe(STATES.UNAVAILABLE);
    expect(hung).toHaveBeenCalledTimes(1);
    expect(seen.aborted).toBe(true);
  });

  test('an empty address resolves null without a call', async () => {
    const validate = jest.fn();
    expect(await resolveAddressStatus('   ', { validate })).toBeNull();
    expect(validate).not.toHaveBeenCalled();
  });
});
