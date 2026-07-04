/**
 * Unit-aware customer matching for self-booking.
 *
 * Street + zip alone is not identity in a multi-unit building: the address
 * lookup used to match any customer on the same street line, so a visitor in
 * Apt B could be linked to (and confirm a booking under) Apt A's account.
 * addressMatchesCustomer / findUniqueCustomerByAddress now reject a match
 * when BOTH sides carry a unit and they disagree; a blank side stays
 * compatible because most on-file addresses predate unit capture.
 */
const {
  addressMatchesCustomer, unitsConflict, stripInlineUnitFromLine, narrowCandidatesByUnit,
} = require('../routes/booking')._internals;

describe('unitsConflict', () => {
  test('no conflict when either side is blank', () => {
    expect(unitsConflict('', 'Apt 4')).toBe(false);
    expect(unitsConflict('Apt 4', '')).toBe(false);
    expect(unitsConflict(null, null)).toBe(false);
  });

  test('normalized forms of the same unit do not conflict', () => {
    expect(unitsConflict('Apt 4B', 'apt 4b')).toBe(false);
    expect(unitsConflict('Unit 4B', '#4B')).toBe(false);
    expect(unitsConflict('4b', 'Unit 4B')).toBe(false);
  });

  test('different units conflict', () => {
    expect(unitsConflict('Apt A', 'Apt B')).toBe(true);
    expect(unitsConflict('Unit 101', '#102')).toBe(true);
  });

  test('designator + hash notation is the same unit ("Apt #4" vs "#4")', () => {
    expect(unitsConflict('Apt #4', '#4')).toBe(false);
    expect(unitsConflict('Suite #210', 'Ste 210')).toBe(false);
  });

  test('structural designators are NOT interchangeable with apt/unit (codex rd4)', () => {
    expect(unitsConflict('Bldg 2', 'Apt 2')).toBe(true);
    expect(unitsConflict('Floor 2', 'Unit 2')).toBe(true);
    expect(unitsConflict('Bldg 2', 'Bldg 2')).toBe(false);
  });

  test('structural aliases do not conflict with themselves (codex rd5)', () => {
    expect(unitsConflict('Building 2', 'Bldg 2')).toBe(false);
    expect(unitsConflict('Floor 2', 'Fl 2')).toBe(false);
  });
});

describe('addressMatchesCustomer with units', () => {
  const customer = {
    address_line1: '123 Main St',
    address_line2: 'Apt A',
    zip: '34231',
  };

  test('same street, disagreeing unit → no match (Apt B is not Apt A)', () => {
    expect(addressMatchesCustomer(customer, '123 Main St', '34231', 'Apt B')).toBe(false);
  });

  test('same street, same unit (any normalized spelling) → match', () => {
    expect(addressMatchesCustomer(customer, '123 Main St', '34231', 'apt a')).toBe(true);
    expect(addressMatchesCustomer(customer, '123 Main St', '34231', '#A')).toBe(true);
  });

  test('blank submitted unit keeps the pre-unit-capture behavior', () => {
    expect(addressMatchesCustomer(customer, '123 Main St', '34231', '')).toBe(true);
    expect(addressMatchesCustomer(customer, '123 Main St', '34231', undefined)).toBe(true);
  });

  test('customer without a unit on file accepts a submitted unit', () => {
    const noUnit = { ...customer, address_line2: null };
    expect(addressMatchesCustomer(noUnit, '123 Main St', '34231', 'Apt B')).toBe(true);
  });

  test('street mismatch still fails regardless of units', () => {
    expect(addressMatchesCustomer(customer, '999 Oak Ave', '34231', 'Apt A')).toBe(false);
  });
});

describe('legacy inline units in address_line1 (pre-capture records)', () => {
  const legacy = {
    address_line1: '123 Main St Apt A',
    address_line2: null,
    zip: '34231',
  };

  test('split submission (street + dedicated unit) matches its own legacy record', () => {
    expect(addressMatchesCustomer(legacy, '123 Main St', '34231', 'Apt A')).toBe(true);
    expect(addressMatchesCustomer(legacy, '123 Main St', '34231', '#A')).toBe(true);
  });

  test('a different unit still conflicts with the inline one', () => {
    expect(addressMatchesCustomer(legacy, '123 Main St', '34231', 'Apt B')).toBe(false);
  });

  test('street-only submission stays compatible (blank side rule)', () => {
    expect(addressMatchesCustomer(legacy, '123 Main St', '34231', '')).toBe(true);
  });

  test('inline-on-both-sides still matches (old behavior preserved)', () => {
    expect(addressMatchesCustomer(legacy, '123 Main St Apt A', '34231', '')).toBe(true);
  });

  test('multi-part inline units match their split submission (codex rd3)', () => {
    const multi = { address_line1: '123 Main St Bldg 2 Apt 4', address_line2: null, zip: '34231' };
    expect(addressMatchesCustomer(multi, '123 Main St', '34231', 'Bldg 2 Apt 4')).toBe(true);
    expect(addressMatchesCustomer(multi, '123 Main St', '34231', 'Apt 9')).toBe(false);
  });

  test('comma-notation legacy records match their split submission (codex rd5)', () => {
    const commaLegacy = { address_line1: '123 Main St, Apt B', address_line2: null, zip: '34231' };
    expect(addressMatchesCustomer(commaLegacy, '123 Main St', '34231', 'Apt B')).toBe(true);
    expect(addressMatchesCustomer(commaLegacy, '123 Main St', '34231', 'Apt A')).toBe(false);
  });

  test('two disagreeing units in one submission is ambiguous → no match (codex rd5)', () => {
    const aptA = { address_line1: '123 Main St', address_line2: 'Apt A', zip: '34231' };
    expect(addressMatchesCustomer(aptA, '123 Main St Apt B', '34231', 'Apt A')).toBe(false);
    // Agreeing inline + dedicated units are fine.
    expect(addressMatchesCustomer(aptA, '123 Main St Apt A', '34231', '#A')).toBe(true);
  });
});

describe('narrowCandidatesByUnit (unique-match narrowing)', () => {
  const aptA = { id: 1, address_line1: '123 Main St', address_line2: 'Apt A', zip: '34231' };
  const streetOnly = { id: 2, address_line1: '123 Main St', address_line2: null, zip: '34231' };
  const aptB = { id: 3, address_line1: '123 Main St', address_line2: 'Apt B', zip: '34231' };

  test('an exact unit match beats a blank-unit legacy record (codex rd5)', () => {
    expect(narrowCandidatesByUnit([aptA, streetOnly], 'Apt A')).toEqual([aptA]);
  });

  test('no exact match → blank-unit records stay compatible', () => {
    expect(narrowCandidatesByUnit([streetOnly], 'Apt A')).toEqual([streetOnly]);
  });

  test('conflicting units are excluded entirely', () => {
    expect(narrowCandidatesByUnit([aptB], 'Apt A')).toEqual([]);
  });

  test('no submitted unit → all candidates stay', () => {
    expect(narrowCandidatesByUnit([aptA, streetOnly], '')).toEqual([aptA, streetOnly]);
  });
});

describe('stripInlineUnitFromLine (double-entry dedup at insert)', () => {
  test('strips an inline unit that value-matches the dedicated field', () => {
    expect(stripInlineUnitFromLine('123 Main St Apt 4', 'Apt 4')).toBe('123 Main St');
    expect(stripInlineUnitFromLine('123 Main St Apt 4', '#4')).toBe('123 Main St');
  });

  test('preserves trailing city/state text past the first comma', () => {
    expect(stripInlineUnitFromLine('123 Main St Apt 4, Sarasota, FL 34231', 'Apt 4'))
      .toBe('123 Main St, Sarasota, FL 34231');
  });

  test('a DIFFERENT inline unit is left untouched (conflict path handles it)', () => {
    expect(stripInlineUnitFromLine('123 Main St Apt 4', 'Apt 9')).toBe('123 Main St Apt 4');
  });

  test('no dedicated unit → line untouched', () => {
    expect(stripInlineUnitFromLine('123 Main St Apt 4', '')).toBe('123 Main St Apt 4');
    expect(stripInlineUnitFromLine('123 Main St', 'Apt 4')).toBe('123 Main St');
  });
});
