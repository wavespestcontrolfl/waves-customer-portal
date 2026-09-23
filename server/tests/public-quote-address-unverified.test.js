// Quote intake: the lookup's county-roll house-number audit becomes a lead
// flag (live 2026-09-14: a typo'd house number that does not exist on an
// established street became the lead and customer address, and the estimate
// went out to it — the address panel had flagged it, the intake never read
// the flag). Pins the pure derivation; the route stamps it on the lead's
// extracted_data as address_unverified.
const { _internals } = require('../routes/public-quote');
const { snapshotCoversAddress } = require('../services/lead-address-unverified');

const { deriveAddressUnverified } = _internals;

const ADDRESS_FLAG = {
  field: 'address',
  reason: 'The Sample county roll could not match house number 1260 on EXAMPLE ST. Confirm the house number before pricing.',
  priority: 'HIGH',
};
const AUDIT = {
  county: 'Sample', typedZip: '34219', houseNumber: 1260, parcelCount: 109,
  streetLabel: 'EXAMPLE ST', streetExists: true, hasExactMatch: false, nearestNumbers: [1251, 1254, 1255],
};

describe('deriveAddressUnverified', () => {
  test('a HIGH address verify flag becomes a lead flag carrying the audit numbers', () => {
    const r = deriveAddressUnverified({ fieldVerifyFlags: [ADDRESS_FLAG, { field: 'lotSize', priority: 'HIGH', reason: 'x' }], addressAudit: AUDIT });
    expect(r).toMatchObject({
      source: 'county_roll',
      reason: ADDRESS_FLAG.reason,
      county: 'Sample',
      house_number: '1260',
      street_exists: true,
      nearest_numbers: ['1251', '1254', '1255'],
    });
    expect(typeof r.flagged_at).toBe('string');
  });

  test('a snapped-record audit (typed number resolved to a neighbour) is flagged the same way', () => {
    const r = deriveAddressUnverified({
      fieldVerifyFlags: [{ field: 'address', priority: 'HIGH', reason: 'Typed house number 1260, but the property record below describes 1250 — the geocoder snapped to a nearby premise.' }],
      addressAudit: { ...AUDIT, snappedRecord: { typed: '1260', record: '1250' } },
    });
    expect(r?.house_number).toBe('1260');
  });

  test('no address flag, or a roll that never answered, is not a flag', () => {
    expect(deriveAddressUnverified({ fieldVerifyFlags: [{ field: 'lotSize', priority: 'HIGH', reason: 'x' }], addressAudit: { ...AUDIT, hasExactMatch: true } })).toBeNull();
    expect(deriveAddressUnverified({ fieldVerifyFlags: [], addressAudit: null })).toBeNull();
    expect(deriveAddressUnverified({})).toBeNull();
    expect(deriveAddressUnverified(null)).toBeNull();
  });

  test('a MEDIUM or reason-less address flag does not flag the lead', () => {
    expect(deriveAddressUnverified({ fieldVerifyFlags: [{ field: 'address', priority: 'MEDIUM', reason: 'x' }] })).toBeNull();
    expect(deriveAddressUnverified({ fieldVerifyFlags: [{ field: 'address', priority: 'HIGH' }] })).toBeNull();
  });

  test('the flag stands on its own when the audit object is missing', () => {
    const r = deriveAddressUnverified({ fieldVerifyFlags: [ADDRESS_FLAG] });
    expect(r).toMatchObject({ reason: ADDRESS_FLAG.reason, county: null, house_number: null, nearest_numbers: [] });
  });
});

describe('snapshotCoversAddress', () => {
  const snapshot = { address: { line1: '1260 Example St', city: 'Parrish', state: 'FL', zip: '34219' } };

  test('same street line (spelling aside) and ZIP → the lookup-stage flag carries over', () => {
    expect(snapshotCoversAddress(snapshot, { line1: '1260 EXAMPLE ST.', zip: '34219-1234' })).toBe(true);
    expect(snapshotCoversAddress(snapshot, { line1: '1260 Example St', zip: '' })).toBe(true);
  });

  test('a changed street or ZIP between the two stages does not carry a flag over', () => {
    expect(snapshotCoversAddress(snapshot, { line1: '1250 Example St', zip: '34219' })).toBe(false);
    expect(snapshotCoversAddress(snapshot, { line1: '1260 Example St', zip: '34221' })).toBe(false);
    expect(snapshotCoversAddress({}, { line1: '1260 Example St', zip: '34219' })).toBe(false);
    expect(snapshotCoversAddress(snapshot, null)).toBe(false);
  });
});
