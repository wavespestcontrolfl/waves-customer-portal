const { normStreet, addressKey, streetKey, normalizeZip, normalizeOccupancy, isNewAddress, OCCUPANCY_TYPES } = require('../services/customer-properties');

describe('address key normalization (suffix + ZIP)', () => {
  test('normalizeZip takes the 5-digit form (ZIP+4 insensitive)', () => {
    expect(normalizeZip('34205-1234')).toBe('34205');
    expect(normalizeZip('34205')).toBe('34205');
    expect(normalizeZip('')).toBe('');
  });
  test('addressKey is ZIP+4-insensitive', () => {
    const a = { address_line1: '100 Main St', city: 'Bradenton', zip: '34205' };
    const b = { address_line1: '100 Main St', city: 'Bradenton', zip: '34205-1234' };
    expect(addressKey(a)).toBe(addressKey(b));
  });
  test('streetKey canonicalizes suffixes (St==Street) but keeps St!=Ave', () => {
    expect(streetKey('123 Main St')).toBe(streetKey('123 Main Street'));
    expect(streetKey('123 Main St')).not.toBe(streetKey('123 Main Ave'));
  });
  test('streetKey strips a trailing unit so a street-only compare ignores units', () => {
    expect(streetKey('100 Main St Apt 4')).toBe(streetKey('100 Main St'));
    expect(streetKey('100 Main St #4')).toBe(streetKey('100 Main Street'));
    // but addressKey (full) still keeps the unit distinct
    expect(addressKey({ address_line1: '100 Main St', address_line2: 'Apt 4', city: 'Bradenton' }))
      .not.toBe(addressKey({ address_line1: '100 Main St', city: 'Bradenton' }));
  });
});

describe('customer-properties pure helpers', () => {
  test('normStreet ignores case/space/punctuation but keeps the house number', () => {
    // spacing/punctuation/case variants of the SAME street collapse together
    expect(normStreet('12338 Ambercreek Cir')).toBe('12338ambercreekcir');
    expect(normStreet('12338  amber-creek  CIR.')).toBe('12338ambercreekcir');
    // 12338 vs 12398 must stay distinct (the Raymond rental-vs-home case)
    expect(normStreet('12338 Amber Creek Cir')).not.toBe(normStreet('12398 Amber Creek Cir'));
  });

  test('addressKey distinguishes by unit + city + ZIP, not just street', () => {
    const a = { address_line1: '100 Main St', city: 'Bradenton', zip: '34205' };
    const b = { address_line1: '100 Main St', city: 'Sarasota', zip: '34236' };
    expect(addressKey(a)).not.toBe(addressKey(b));                              // same street, different city/ZIP
    const unitA = { address_line1: '100 Main St', address_line2: 'Unit A', city: 'Bradenton' };
    const unitB = { address_line1: '100 Main St', address_line2: 'Unit B', city: 'Bradenton' };
    expect(addressKey(unitA)).not.toBe(addressKey(unitB));                      // different unit
    // null/empty components don't change the key vs. omitting them
    expect(addressKey({ address_line1: '100 Main St', address_line2: null, city: 'Bradenton', zip: null }))
      .toBe(addressKey({ address_line1: '100 Main St', city: 'Bradenton' }));
  });

  test('addressKey collapses interchangeable unit designators (Apt/Unit/Ste/# → same), keeps real units distinct', () => {
    const base = { address_line1: '100 Main St', city: 'Bradenton', zip: '34205' };
    const k = (u) => addressKey({ ...base, address_line2: u });
    expect(k('Apt 4')).toBe(k('Unit 4'));   // interchangeable designators
    expect(k('Apt 4')).toBe(k('Ste 4'));
    expect(k('Apt 4')).toBe(k('#4'));
    expect(k('Apt 4')).toBe(k('4'));
    expect(k('Apt 4')).not.toBe(k('Apt 5'));               // different unit stays distinct
    expect(k('Apt 4')).not.toBe(addressKey(base));         // unit vs no-unit stays distinct
  });

  test('addressKey canonicalizes street suffixes (St==Street) but keeps streets distinct (St!=Ave)', () => {
    const base = { city: 'Bradenton', zip: '34205' };
    expect(addressKey({ ...base, address_line1: '123 Main St' }))
      .toBe(addressKey({ ...base, address_line1: '123 Main Street' }));   // abbreviation == expansion
    expect(addressKey({ ...base, address_line1: '123 Main St' }))
      .not.toBe(addressKey({ ...base, address_line1: '123 Main Ave' }));  // different street, NOT merged
  });

  test('normalizeOccupancy coerces unknown values', () => {
    for (const t of OCCUPANCY_TYPES) expect(normalizeOccupancy(t)).toBe(t);
    expect(normalizeOccupancy('rental')).toBe('unknown');
    expect(normalizeOccupancy(undefined)).toBe('unknown');
    expect(normalizeOccupancy(null)).toBe('unknown');
  });

  test('isNewAddress — true only for a street that is a NEW full address', () => {
    const existing = [{ address_line1: '12338 Ambercreek Cir', city: 'Lakewood Ranch', zip: '34211' }];
    expect(isNewAddress(existing, { address_line1: '12398 Amber Creek Circle', city: 'Lakewood Ranch', zip: '34211' })).toBe(true);  // his home — new
    expect(isNewAddress(existing, { address_line1: '12338 Amber Creek Cir', city: 'Lakewood Ranch', zip: '34211' })).toBe(false);    // same full address
    expect(isNewAddress(existing, { address_line1: '' })).toBe(false);                                                                // nothing to add
    // same street, DIFFERENT city = a new property (was a false-dup before)
    expect(isNewAddress([{ address_line1: '100 Main St', city: 'Bradenton' }], { address_line1: '100 Main St', city: 'Sarasota' })).toBe(true);
    expect(isNewAddress([], { address_line1: '12398 Amber Creek Cir' })).toBe(true);
    expect(isNewAddress(null, { address_line1: '1 Main St' })).toBe(true);
  });
});
