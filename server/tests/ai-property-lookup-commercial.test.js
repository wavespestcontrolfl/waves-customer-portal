const { _private } = require('../services/property-lookup/ai-property-lookup');

describe('AI property lookup commercial facts', () => {
  test('treats a commercial-only property type as a usable lookup fact without losing subtype text', () => {
    const parsed = _private.parsePropertyJSON(JSON.stringify({
      squareFootage: null,
      lotSize: null,
      yearBuilt: null,
      bedrooms: null,
      bathrooms: null,
      stories: null,
      propertyType: 'Restaurant',
      constructionMaterial: null,
      source: 'https://example.test/business',
      confidence: 'medium',
    }));

    expect(parsed.propertyType).toBe('Restaurant');
    expect(_private.hasAnyPropertyFact(parsed)).toBe(true);
    expect(_private.normalizeLookupPropertyType('Warehouse')).toBe('Warehouse');
    expect(_private.normalizeLookupPropertyType('Medical Office')).toBe('Medical Office');
    expect(_private.normalizeLookupPropertyType('Commercial Office')).toBe('Office');
    expect(_private.normalizeLookupPropertyType('Commercial')).toBe('Commercial');
  });

  test('still rejects empty AI lookup payloads with no property facts', () => {
    const parsed = _private.parsePropertyJSON(JSON.stringify({
      squareFootage: null,
      lotSize: null,
      yearBuilt: null,
      bedrooms: null,
      bathrooms: null,
      stories: null,
      propertyType: null,
      constructionMaterial: null,
      source: null,
      confidence: 'low',
    }));

    expect(_private.hasAnyPropertyFact(parsed)).toBe(false);
  });
});
