// Web quote-funnel additional-property capture (intake-normalize's
// normalizeWebAdditionalProperties): input concerns for the visitor-typed
// "also cover my other property" boxes. All fixtures are synthetic —
// repository policy prohibits real lead addresses in tests.
const { normalizeWebAdditionalProperties, normalizeAdditionalProperties } = require('../utils/intake-normalize');

describe('normalizeWebAdditionalProperties', () => {
  test('normalizes a structured entry and a bare string into the call-pipeline entry shape', () => {
    const out = normalizeWebAdditionalProperties({
      additional_properties: [
        { line1: '456 Oak Avenue', city: 'Sarasota', state: 'FL', zip: '34236', place_id: 'place_abc123' },
        '123 main street sarasota fl 34236',
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      address_line1: '456 Oak Ave',
      address_line2: null,
      city: 'Sarasota',
      state: 'FL',
      zip: '34236',
      place_id: 'place_abc123',
    });
    expect(out[1]).toMatchObject({ address_line1: '123 Main St', city: 'Sarasota', zip: '34236', place_id: null });
  });

  test('output entries carry the same canonical keys as call-extracted entries', () => {
    const [web] = normalizeWebAdditionalProperties({ additional_properties: ['123 Main St, Sarasota, FL 34236'] });
    const [call] = normalizeAdditionalProperties([{ address_line1: '123 Main St', city: 'Sarasota', state: 'FL', zip: '34236' }]);
    const webKeys = Object.keys(web).filter((k) => k !== 'place_id').sort();
    expect(webKeys).toEqual(Object.keys(call).sort());
  });

  test('folds a singular second_property into the list', () => {
    const out = normalizeWebAdditionalProperties({ second_property: '123 Main St, Sarasota, FL 34236' });
    expect(out).toHaveLength(1);
    expect(out[0].address_line1).toBe('123 Main St');
  });

  test('drops entries that duplicate the primary address or each other', () => {
    const out = normalizeWebAdditionalProperties({
      additional_properties: [
        '123 Main Street, Sarasota, FL 34236',
        '456 Oak Avenue, Sarasota, FL 34236',
        '456 Oak Ave, Sarasota, FL 34236',
      ],
    }, '123 Main St, Sarasota, FL 34236');
    expect(out).toHaveLength(1);
    expect(out[0].address_line1).toBe('456 Oak Ave');
  });

  test('drops prose that is not an addressable street line', () => {
    expect(normalizeWebAdditionalProperties({ additional_properties: ['the house next door'] })).toEqual([]);
    expect(normalizeWebAdditionalProperties({ additional_properties: [''] })).toEqual([]);
  });

  test('fails closed on an entry whose inline and dedicated units disagree', () => {
    expect(normalizeWebAdditionalProperties({
      additional_properties: [{ line1: '123 Main St Apt 4', line2: 'Unit 5', city: 'Sarasota', state: 'FL', zip: '34236' }],
    })).toEqual([]);
  });

  test('caps the stored list at 3 entries', () => {
    const out = normalizeWebAdditionalProperties({
      additional_properties: [
        '101 Elm St, Sarasota, FL 34236',
        '102 Elm St, Sarasota, FL 34236',
        '103 Elm St, Sarasota, FL 34236',
        '104 Elm St, Sarasota, FL 34236',
      ],
    });
    expect(out).toHaveLength(3);
  });

  test('accepts addressLine1/addressLine2 camelCase spellings', () => {
    const out = normalizeWebAdditionalProperties({
      additionalProperties: [{ addressLine1: '123 Main St', addressLine2: 'Unit 2', city: 'Sarasota', state: 'FL', zip: '34236' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ address_line1: '123 Main St', address_line2: 'Unit 2', city: 'Sarasota' });
  });

  test('bounds structured component lengths, not just the raw string', () => {
    const huge = `123 ${'A'.repeat(5000)} St`;
    const out = normalizeWebAdditionalProperties({
      additional_properties: [{ line1: huge, city: 'B'.repeat(5000), state: 'FL', zip: '34236', place_id: 'C'.repeat(5000) }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].address_line1.length).toBeLessThanOrEqual(300);
    expect(out[0].city.length).toBeLessThanOrEqual(300);
    expect(out[0].place_id.length).toBeLessThanOrEqual(300);
  });

  test('tolerates junk shapes without throwing', () => {
    expect(normalizeWebAdditionalProperties({})).toEqual([]);
    expect(normalizeWebAdditionalProperties()).toEqual([]);
    expect(normalizeWebAdditionalProperties({ additional_properties: 'not-an-array 123 Main St, Sarasota, FL 34236' })).toHaveLength(1);
    expect(normalizeWebAdditionalProperties({ additional_properties: [null, 42, [], {}] })).toEqual([]);
  });
});
