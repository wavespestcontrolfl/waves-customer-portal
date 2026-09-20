// On-file address satisfaction (2026-09-20 call-agent audit, finding 1): a
// linked, actively served customer with an address on file who stated no
// address on the call owes no address review — the four recoverable address
// flags leave the routing verdict and the card set, recorded on the verdict.
const {
  canAutoRoute, onFileAddressSatisfaction,
} = require('../services/call-triage-flags');

const ANI = '+19415550100';
const KNOWN = { hasAddress: true, addressLine1: '100 Example Street', addressCity: 'Parrish', addressZip: '34219' };
const ADDRESS_FLAGS = ['address_unverifiable', 'missing_service_address', 'address_unverified', 'low_confidence_address'];

function unconfirmed(flags, extra = {}) {
  return {
    triage_flags: flags,
    confidence: { overall: 0.9 },
    scheduling: { status: 'none' },
    consent: {},
    ...extra,
  };
}

describe('onFileAddressSatisfaction', () => {
  test('strips the four recoverable address flags for a known customer who stated no address', () => {
    const r = onFileAddressSatisfaction([...ADDRESS_FLAGS, 'quote_promised'], unconfirmed([]), { knownCustomer: KNOWN });
    expect(r.satisfied).toEqual(ADDRESS_FLAGS);
    expect(r.flags).toEqual(['quote_promised']);
  });
  test('never touches out_of_service_area', () => {
    const r = onFileAddressSatisfaction(['out_of_service_area', 'missing_service_address'], unconfirmed([]), { knownCustomer: KNOWN });
    expect(r.flags).toEqual(['out_of_service_area']);
    expect(r.satisfied).toEqual(['missing_service_address']);
  });
  test('a new caller (no on-file address) keeps every flag', () => {
    expect(onFileAddressSatisfaction(ADDRESS_FLAGS, unconfirmed([]), {}).satisfied).toEqual([]);
    expect(onFileAddressSatisfaction(ADDRESS_FLAGS, unconfirmed([]), { knownCustomer: { hasAddress: false } }).satisfied).toEqual([]);
  });
  test('a NEW address stated on the call keeps the flags (V2 extraction)', () => {
    const ex = unconfirmed([], { property: { service_address: { street_line_1: '55 Other Road', city: 'Bradenton', postal_code: '34203' } } });
    expect(onFileAddressSatisfaction(ADDRESS_FLAGS, ex, { knownCustomer: KNOWN }).satisfied).toEqual([]);
  });
  test('a NEW address surviving only in the merged V1 record keeps the flags', () => {
    const rec = { address_line1: '55 Other Road', city: 'Bradenton', zip: '34203' };
    expect(onFileAddressSatisfaction(ADDRESS_FLAGS, unconfirmed([]), { knownCustomer: KNOWN, canonicalRecord: rec }).satisfied).toEqual([]);
  });
  test('a restatement of the on-file address still counts as no new address', () => {
    const ex = unconfirmed([], { property: { service_address: { street_line_1: '100 Example St', city: 'Parrish', postal_code: '34219' } } });
    expect(onFileAddressSatisfaction(ADDRESS_FLAGS, ex, { knownCustomer: KNOWN }).satisfied).toEqual(ADDRESS_FLAGS);
  });
});

describe('canAutoRoute with the on-file address', () => {
  test('an unconfirmed existing-customer call blocks on not_confirmed with NO address flags and records what was satisfied', () => {
    const r = canAutoRoute(unconfirmed(['address_unverifiable', 'missing_service_address']), {
      callerAni: ANI, contactPhone: ANI, knownCustomer: KNOWN,
    });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('not_confirmed');
    expect(r.schedulingStatus).toBe('none');
    expect(r.appointmentBlockingFlags).toBeUndefined();
    expect(r.onFileAddressSatisfiedFlags).toEqual(['address_unverifiable', 'missing_service_address']);
  });
  test('a cancellation from a known customer is not address-blocked', () => {
    const r = canAutoRoute(unconfirmed(['address_unverifiable', 'cancellation_request'], { scheduling: { status: 'cancel_requested' } }), {
      callerAni: ANI, contactPhone: ANI, knownCustomer: KNOWN,
    });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toEqual(['cancellation_request']);
    expect(r.onFileAddressSatisfiedFlags).toEqual(['address_unverifiable']);
  });
  test('the same call from a NEW caller keeps the address block', () => {
    const r = canAutoRoute(unconfirmed(['address_unverifiable', 'missing_service_address']), { callerAni: ANI, contactPhone: ANI });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('triage_flags');
    expect(r.appointmentBlockingFlags).toEqual(expect.arrayContaining(['address_unverifiable', 'missing_service_address']));
    expect(r.onFileAddressSatisfiedFlags).toBeUndefined();
  });
  test('a known customer who stated a new, unvalidated address keeps the address block', () => {
    const ex = unconfirmed(['address_unverifiable'], { property: { service_address: { street_line_1: '55 Other Road', city: 'Bradenton' } } });
    const r = canAutoRoute(ex, { callerAni: ANI, contactPhone: ANI, knownCustomer: KNOWN });
    expect(r.reason).toBe('triage_flags');
    expect(r.appointmentBlockingFlags).toEqual(expect.arrayContaining(['address_unverifiable']));
  });
  test('a CONFIRMED booking is untouched: without fail-open the address flags still block', () => {
    const ex = unconfirmed(['address_unverifiable'], { scheduling: { status: 'confirmed', confirmed_start_at: '2026-09-22T09:00:00-04:00' } });
    const r = canAutoRoute(ex, { callerAni: ANI, contactPhone: ANI, knownCustomer: KNOWN, failOpen: false });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toEqual(expect.arrayContaining(['address_unverifiable']));
    expect(r.onFileAddressSatisfiedFlags).toBeUndefined();
  });
  test('a CONFIRMED booking with NO start time is still a confirmed booking: address flags stay (codex r2 P2)', () => {
    const ex = unconfirmed(['address_unverifiable'], { scheduling: { status: 'confirmed', confirmed_start_at: null } });
    const r = canAutoRoute(ex, { callerAni: ANI, contactPhone: ANI, knownCustomer: KNOWN });
    expect(r.allowed).toBe(false);
    expect(r.appointmentBlockingFlags).toEqual(expect.arrayContaining(['address_unverifiable']));
    expect(r.onFileAddressSatisfiedFlags).toBeUndefined();
  });
  test('a CONFIRMED booking under fail-open still carries the advisory read-back (failedOpenFlags), not the satisfied list', () => {
    const ex = unconfirmed(['address_unverifiable'], { scheduling: { status: 'confirmed', confirmed_start_at: '2026-09-22T09:00:00-04:00' } });
    const r = canAutoRoute(ex, { callerAni: ANI, contactPhone: ANI, knownCustomer: KNOWN, failOpen: true });
    expect(r.failedOpenFlags).toEqual(expect.arrayContaining(['address_unverifiable']));
    expect(r.onFileAddressSatisfiedFlags).toBeUndefined();
  });
});
