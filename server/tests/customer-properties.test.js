const { normStreet, addressKey, normalizeOccupancy, isNewAddress, OCCUPANCY_TYPES } = require('../services/customer-properties');

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
