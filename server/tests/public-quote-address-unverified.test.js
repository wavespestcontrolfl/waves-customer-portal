// Quote intake: the lookup's county-roll house-number audit becomes a lead
// flag (live 2026-09-14: a typo'd house number that does not exist on an
// established street became the lead and customer address, and the estimate
// went out to it — the address panel had flagged it, the intake never read
// the flag). Pins the pure derivation; the route stamps it on the lead's
// extracted_data as address_unverified.
const { _internals } = require('../routes/public-quote');
const { snapshotCoversAddress, recoverAddressUnverified, nextAddressUnverified, countyRollAnswered, flagCoversAddress, samePremiseDisplay, parseDisplayAddress, buildAddressVerdict, cleanVerdictCovers } = require('../services/lead-address-unverified');

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
    expect(r).toMatchObject({ address_line1: null, zip: null });
    const stamped = deriveAddressUnverified({ fieldVerifyFlags: [ADDRESS_FLAG], addressAudit: AUDIT }, { line1: ' 1260 Example St ', zip: '34219-1234' });
    expect(stamped).toMatchObject({ address_line1: '1260 Example St', zip: '34219' });
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
    // An inline unit added between lookup and calculate is the same audited number.
    expect(snapshotCoversAddress(snapshot, { line1: '1260 Example St Apt 4', zip: '34219' })).toBe(true);
    expect(flagCoversAddress({ source: 'county_roll', reason: 'r', address_line1: '1260 Example St', zip: '34219' }, { line1: '1260 Example St Apt 4', zip: '34219' })).toBe(true);
    expect(flagCoversAddress({ source: 'county_roll', reason: 'r', address_line1: '1260 Example Street', zip: '34219' }, { line1: '1260 Example St', zip: '34219' })).toBe(true);
  });

  test('a changed street or ZIP between the two stages does not carry a flag over', () => {
    expect(snapshotCoversAddress(snapshot, { line1: '1250 Example St', zip: '34219' })).toBe(false);
    // A ZIP-less pair that changed city alone is a different premise.
    expect(snapshotCoversAddress({ address: { line1: '1260 Example St', city: 'Parrish' } }, { line1: '1260 Example St', city: 'Bradenton' })).toBe(false);
    expect(snapshotCoversAddress({ address: { line1: '1260 Example St', city: 'Parrish' } }, { line1: '1260 Example St', city: 'PARRISH' })).toBe(true);
    expect(snapshotCoversAddress({ address: { line1: '1260 Example St', city: 'Parrish', state: 'FL' } }, { line1: '1260 Example St', city: 'Parrish', state: 'GA' })).toBe(false);
    expect(snapshotCoversAddress({ address: { line1: '1260 Example St', city: 'Parrish', state: 'FL' } }, { line1: '1260 Example St', city: 'Parrish', state: 'fl' })).toBe(true);
    expect(snapshotCoversAddress(snapshot, { line1: '1260 Example St', zip: '34221' })).toBe(false);
    expect(snapshotCoversAddress({}, { line1: '1260 Example St', zip: '34219' })).toBe(false);
    expect(snapshotCoversAddress(snapshot, null)).toBe(false);
  });
});

describe('recoverAddressUnverified', () => {
  test('recovers only the server-written flag, never the snapshot\'s enriched profile', () => {
    // A repeated /calculate leaves the CLIENT's ep under `enriched` —
    // an address flag planted there must not become a staff warning.
    const planted = { fieldVerifyFlags: [{ field: 'address', priority: 'HIGH', reason: 'planted by the client' }], addressAudit: { county: '<script>' } };
    expect(recoverAddressUnverified({ enriched: planted })).toBeNull();
    expect(recoverAddressUnverified({ enriched: planted, address_unverified: null })).toBeNull();
    const stored = deriveAddressUnverified({ fieldVerifyFlags: [ADDRESS_FLAG], addressAudit: AUDIT });
    expect(recoverAddressUnverified({ enriched: planted, address_unverified: stored })).toEqual(stored);
  });

  test('a malformed stored flag is dropped, an oversized one is trimmed', () => {
    expect(recoverAddressUnverified({ address_unverified: { reason: 'x' } })).toBeNull();
    expect(recoverAddressUnverified({ address_unverified: { source: 'county_roll' } })).toBeNull();
    const r = recoverAddressUnverified({ address_unverified: { source: 'county_roll', reason: 'r'.repeat(1000), county: 'c'.repeat(100), nearest_numbers: [1, 2, 3, 4, 5, 6, 7] } });
    expect(r.reason).toHaveLength(600);
    expect(r.county).toHaveLength(40);
    expect(r.nearest_numbers).toEqual(['1', '2', '3', '4', '5']);
  });
});

describe('nextAddressUnverified', () => {
  const prior = { source: 'county_roll', reason: 'earlier verdict', address_line1: '1260 Example St' };

  test('a fresh verdict wins; a clean roll answer clears a prior flag', () => {
    expect(nextAddressUnverified({ enriched: { fieldVerifyFlags: [ADDRESS_FLAG], addressAudit: AUDIT }, profileFound: true, prior })?.reason).toBe(ADDRESS_FLAG.reason);
    expect(nextAddressUnverified({ enriched: { fieldVerifyFlags: [], addressAudit: { ...AUDIT, hasExactMatch: true } }, profileFound: true, prior })).toBeNull();
  });

  test('a roll that never answered (outage, or no cached profile) keeps the prior flag', () => {
    expect(countyRollAnswered({ fieldVerifyFlags: [] })).toBe(false);
    expect(countyRollAnswered({ addressAudit: AUDIT })).toBe(true);
    // A county-backed record that agreed with the typed number skips the
    // audit — that is an answer and clears a prior flag; 'unanswered' does not.
    expect(countyRollAnswered({ fieldVerifyFlags: [], addressVerdict: 'county_record' })).toBe(true);
    expect(countyRollAnswered({ fieldVerifyFlags: [], addressVerdict: 'unanswered' })).toBe(false);
    expect(nextAddressUnverified({ enriched: { fieldVerifyFlags: [], addressVerdict: 'county_record' }, profileFound: true, prior })).toBeNull();
    expect(nextAddressUnverified({ enriched: { fieldVerifyFlags: [], addressVerdict: 'unanswered' }, profileFound: true, prior })).toBe(prior);
    expect(nextAddressUnverified({ enriched: { fieldVerifyFlags: [] }, profileFound: true, prior })).toBe(prior);
    expect(nextAddressUnverified({ enriched: null, profileFound: false, prior })).toBe(prior);
    expect(nextAddressUnverified({ enriched: { fieldVerifyFlags: [] }, profileFound: true, prior: null })).toBeNull();
  });
});

describe('flagCoversAddress', () => {
  const flag = { source: 'county_roll', reason: 'r', address_line1: '1260 Example St', city: 'Parrish', state: 'FL', zip: '34219' };

  test('judged on the flag\'s own stamp, so a corrected prefill address drops the old flag', () => {
    expect(flagCoversAddress(flag, { line1: '1260 EXAMPLE ST', city: 'Parrish', state: 'FL', zip: '34219' })).toBe(true);
    expect(flagCoversAddress(flag, { line1: '1250 Example St', city: 'Parrish', state: 'FL', zip: '34219' })).toBe(false);
    expect(flagCoversAddress(flag, { line1: '1260 Example St', city: 'Bradenton' })).toBe(false);
    // An older flag without a stamp defers to the caller's snapshot check.
    expect(flagCoversAddress({ source: 'county_roll', reason: 'r' }, { line1: '1250 Example St' })).toBe(true);
    expect(flagCoversAddress(null, { line1: '1260 Example St' })).toBe(false);
  });
});

describe('samePremiseDisplay', () => {
  test('a unit added on a repeat run is the same audited premise; a new number or town is not', () => {
    expect(samePremiseDisplay('1260 Example St, Parrish, FL 34219', '1260 Example St Apt 4, Parrish, FL 34219')).toBe(true);
    expect(samePremiseDisplay('1260 Example St, Parrish, FL 34219', '1260 EXAMPLE ST., Parrish, FL 34219')).toBe(true);
    // A unit emitted as its own segment must not be read as the city.
    expect(samePremiseDisplay('1260 Example St, Parrish, FL 34219', '1260 Example St, Apt 4, Parrish, FL 34219')).toBe(true);
    expect(samePremiseDisplay('1260 Example St, Apt 4, Parrish, FL 34219', '1260 Example St, Apt 4, Bradenton, FL 34219')).toBe(false);
    expect(samePremiseDisplay('1260 Example St, Parrish, FL 34219', '1250 Example St, Parrish, FL 34219')).toBe(false);
    expect(samePremiseDisplay('1260 Example St, Parrish, FL 34219', '1260 Example St, Bradenton, FL 34219')).toBe(false);
    expect(samePremiseDisplay('1260 Example St, Parrish, FL 34219', '1260 Example St, Parrish, FL 34221')).toBe(false);
    expect(samePremiseDisplay('', '1260 Example St, Parrish, FL 34219')).toBe(false);
    // A five-digit house number is not the ZIP.
    expect(samePremiseDisplay('12345 Example St, Parrish, FL 34219', '12345 Example St, Parrish, FL 34221')).toBe(false);
    expect(samePremiseDisplay('12345 Example St, Parrish, FL 34219', '12345 Example St, Parrish, FL 34219-1234')).toBe(true);
  });

  test('the strict form needs a complete locality on both sides', () => {
    expect(samePremiseDisplay('1260 Example St', '1260 Example St, Parrish, FL 34219')).toBe(true);
    expect(samePremiseDisplay('1260 Example St', '1260 Example St, Parrish, FL 34219', { requireLocality: true })).toBe(false);
    expect(samePremiseDisplay('1260 Example St, Parrish', '1260 Example St, Parrish, FL 34219', { requireLocality: true })).toBe(false);
    expect(samePremiseDisplay('1260 Example St, Parrish, FL 34219', '1260 Example St Apt 2, Parrish, FL 34219', { requireLocality: true })).toBe(true);
  });
});

describe('address verdict', () => {
  const address = { line1: '1260 Example St', city: 'Parrish', state: 'FL', zip: '34219' };

  test('flagged / clean / unanswered, stamped with the judged address', () => {
    expect(buildAddressVerdict({ flag: { reason: 'r' }, enriched: { addressAudit: AUDIT }, profileFound: true, address }).status).toBe('flagged');
    expect(buildAddressVerdict({ flag: null, enriched: { addressAudit: { ...AUDIT, hasExactMatch: true } }, profileFound: true, address })).toMatchObject({ status: 'clean', address_line1: '1260 Example St', city: 'Parrish', state: 'FL', zip: '34219' });
    expect(buildAddressVerdict({ flag: null, enriched: { fieldVerifyFlags: [] }, profileFound: true, address }).status).toBe('unanswered');
    expect(buildAddressVerdict({ flag: null, enriched: null, profileFound: false, address }).status).toBe('unanswered');
  });

  test('a clean verdict covers only its own premise', () => {
    const clean = buildAddressVerdict({ flag: null, enriched: { addressAudit: { ...AUDIT, hasExactMatch: true } }, profileFound: true, address });
    expect(cleanVerdictCovers({ address_verdict: clean }, address)).toBe(true);
    expect(cleanVerdictCovers({ address_verdict: clean }, { ...address, line1: '1260 Example St Apt 4' })).toBe(true);
    expect(cleanVerdictCovers({ address_verdict: clean }, { ...address, line1: '1250 Example St' })).toBe(false);
    expect(cleanVerdictCovers({ address_verdict: { ...clean, status: 'unanswered' } }, address)).toBe(false);
    expect(cleanVerdictCovers({}, address)).toBe(false);
  });
});

describe('assertEstimateSendable refuses a flagged address', () => {
  test('the send guard names the correction path', () => {
    const { _internals } = require('../routes/admin-estimates');
    const base = { status: 'draft', archived_at: null, estimate_data: { addressUnverified: true } };
    expect(() => _internals.assertEstimateSendable(base)).toThrow(/Correct the address/);
    try { _internals.assertEstimateSendable(base); } catch (e) { expect(e.code).toBe('ADDRESS_UNVERIFIED'); }
  });
});

describe('parseDisplayAddress', () => {
  test('unit segments and the state/ZIP tail are read correctly', () => {
    expect(parseDisplayAddress('1260 Example St, Apt 4, Parrish, FL 34219')).toMatchObject({ streetLine: '1260 Example St', city: 'Parrish', state: 'FL', zip: '34219' });
    expect(parseDisplayAddress('12345 Example St, Parrish, FL 34219-1234')).toMatchObject({ city: 'Parrish', zip: '34219' });
    expect(parseDisplayAddress('')).toMatchObject({ streetLine: '', city: '', zip: '' });
  });
});
