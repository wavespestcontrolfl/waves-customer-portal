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
  submittedUnitConflictsWithCustomer, carriedVisitUnit,
} = require('../routes/booking')._internals;
const { splitStreetLineUnit } = require('../utils/address-normalizer');

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

  test('comma-separated MULTI-PART legacy units match their split submission (codex rd7)', () => {
    const legacy = { address_line1: '123 Main St, Bldg 2, Apt 4', address_line2: null, zip: '34231' };
    expect(addressMatchesCustomer(legacy, '123 Main St', '34231', 'Bldg 2 Apt 4')).toBe(true);
    expect(addressMatchesCustomer(legacy, '123 Main St', '34231', 'Bldg 2 Apt 9')).toBe(false);
  });

  test('a one-line FL address (state+ZIP tail) does not manufacture a unit conflict (codex rd7)', () => {
    expect(splitStreetLineUnit('123 Main St Sarasota FL 34236').unit).toBe('');
    expect(unitsConflict(splitStreetLineUnit('123 Main St Sarasota FL 34236').unit, 'Apt A')).toBe(false);
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

  test('strips a comma-separated inline unit segment (codex rd6)', () => {
    expect(stripInlineUnitFromLine('123 Main St, Apt B', 'Apt B')).toBe('123 Main St');
    expect(stripInlineUnitFromLine('123 Main St, Apt B, Sarasota', '#B')).toBe('123 Main St, Sarasota');
    // A non-unit second segment (city) stays put.
    expect(stripInlineUnitFromLine('123 Main St, Sarasota', 'Apt B')).toBe('123 Main St, Sarasota');
  });

  test('strips a multi-part unit spanning several comma segments (codex rd8)', () => {
    expect(stripInlineUnitFromLine('123 Main St, Bldg 2, Apt 4', 'Bldg 2 Apt 4')).toBe('123 Main St');
    expect(stripInlineUnitFromLine('123 Main St, Bldg 2, Apt 4, Sarasota', 'Bldg 2 Apt 4'))
      .toBe('123 Main St, Sarasota');
  });

  test('strips a mid-line duplicate hidden by a one-line address tail (codex rd13)', () => {
    expect(stripInlineUnitFromLine('123 Main St Apt A Sarasota FL 34236', 'Apt A'))
      .toBe('123 Main St, Sarasota, FL 34236');
    // A DIFFERENT mid-line unit stays put — the conflict guard owns that case.
    expect(stripInlineUnitFromLine('123 Main St Apt A Sarasota FL 34236', 'Apt 9'))
      .toBe('123 Main St Apt A Sarasota FL 34236');
  });
});

describe('submittedUnitConflictsWithCustomer (resolved-customer guard)', () => {
  const aptA = { address_line1: '123 Main St', address_line2: 'Apt A', zip: '34231' };

  test('conflicting unit on the same street → conflict (codex rd8)', () => {
    expect(submittedUnitConflictsWithCustomer(aptA, { address_line1: '123 Main St', address_line2: 'Apt B' })).toBe(true);
  });

  test('agreeing unit in any notation → no conflict', () => {
    expect(submittedUnitConflictsWithCustomer(aptA, { address_line1: '123 Main St', address_line2: '#A' })).toBe(false);
  });

  test('a different street is not a unit statement about this record', () => {
    expect(submittedUnitConflictsWithCustomer(aptA, { address_line1: '999 Other Rd', address_line2: 'Apt B' })).toBe(false);
  });

  test('blank on-file unit → no conflict (backfill path owns that case)', () => {
    const streetOnly = { address_line1: '123 Main St', address_line2: null };
    expect(submittedUnitConflictsWithCustomer(streetOnly, { address_line1: '123 Main St', address_line2: 'Apt B' })).toBe(false);
  });

  test('no submitted unit → no conflict', () => {
    expect(submittedUnitConflictsWithCustomer(aptA, { address_line1: '123 Main St', address_line2: '' })).toBe(false);
    expect(submittedUnitConflictsWithCustomer(aptA, null)).toBe(false);
  });

  test('legacy inline on-file unit still conflicts', () => {
    const inline = { address_line1: '123 Main St Apt A', address_line2: null };
    expect(submittedUnitConflictsWithCustomer(inline, { address_line1: '123 Main St', address_line2: 'Apt B' })).toBe(true);
  });

  test('unit submitted only INLINE in the street line still conflicts (codex rd9)', () => {
    expect(submittedUnitConflictsWithCustomer(aptA, { address_line1: '123 Main St Apt B', address_line2: '' })).toBe(true);
    expect(submittedUnitConflictsWithCustomer(aptA, { address_line1: '123 Main St Apt A', address_line2: '' })).toBe(false);
  });

  test('whitespace-only dedicated field cannot mask an inline unit (codex rd12)', () => {
    expect(submittedUnitConflictsWithCustomer(aptA, { address_line1: '123 Main St Apt B', address_line2: '   ' })).toBe(true);
    expect(submittedUnitConflictsWithCustomer(aptA, { address_line1: '123 Main St Apt A', address_line2: '   ' })).toBe(false);
  });

  test('one-line submitted address with a mid-line unit still conflicts (codex rd13)', () => {
    expect(submittedUnitConflictsWithCustomer(aptA, { address_line1: '123 Main St Apt B Sarasota FL 34236', address_line2: '' })).toBe(true);
    expect(submittedUnitConflictsWithCustomer(aptA, { address_line1: '123 Main St Apt A Sarasota FL 34236', address_line2: '' })).toBe(false);
  });
});

describe('carriedVisitUnit (no-backfill unit rides on the visit, codex rd10)', () => {
  const streetOnly = { address_line1: '123 Main St', address_line2: null };

  test('same-street submission against a unit-less record carries the unit', () => {
    expect(carriedVisitUnit(streetOnly, { address_line1: '123 Main St', address_line2: 'Apt B' })).toBe('Apt B');
    // Inline-only submissions carry too.
    expect(carriedVisitUnit(streetOnly, { address_line1: '123 Main St Apt B', address_line2: '' })).toBe('Apt B');
  });

  test('record already carrying a unit (dedicated or legacy inline) carries nothing', () => {
    const aptA = { address_line1: '123 Main St', address_line2: 'Apt A' };
    const inlineA = { address_line1: '123 Main St Apt A', address_line2: null };
    expect(carriedVisitUnit(aptA, { address_line1: '123 Main St', address_line2: 'Apt A' })).toBe('');
    expect(carriedVisitUnit(inlineA, { address_line1: '123 Main St', address_line2: 'Apt A' })).toBe('');
  });

  test('a different street or no submitted unit carries nothing', () => {
    expect(carriedVisitUnit(streetOnly, { address_line1: '999 Other Rd', address_line2: 'Apt B' })).toBe('');
    expect(carriedVisitUnit(streetOnly, { address_line1: '123 Main St', address_line2: '' })).toBe('');
    expect(carriedVisitUnit(streetOnly, null)).toBe('');
  });

  test('whitespace-only dedicated field falls through to the inline unit (codex rd12)', () => {
    expect(carriedVisitUnit(streetOnly, { address_line1: '123 Main St Apt B', address_line2: '   ' })).toBe('Apt B');
  });

  test('one-line submission with a mid-line unit still carries it (codex rd13)', () => {
    expect(carriedVisitUnit(streetOnly, { address_line1: '123 Main St Apt B Sarasota FL 34231', address_line2: '' })).toBe('Apt B');
  });
});
