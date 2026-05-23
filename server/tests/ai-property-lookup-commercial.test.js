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

  test('normalizes common AI lot-size aliases into square feet', () => {
    expect(_private.parsePropertyJSON(JSON.stringify({
      homeSqFt: '2,195',
      lotSqFt: '6,698 sqft',
      propertyType: 'Single Family',
      source: 'https://www.realtor.com/realestateandhomes-detail/example',
      confidence: 'medium',
    }))).toMatchObject({
      squareFootage: 2195,
      lotSize: 6698,
    });

    expect(_private.parsePropertyJSON(JSON.stringify({
      living_area_sqft: 2195,
      lot_size_acres: 0.1537649,
      propertyType: 'Single Family',
      source: 'https://www.realtor.com/realestateandhomes-detail/example',
      confidence: 'medium',
    })).lotSize).toBe(6698);

    expect(_private.parsePropertyJSON(JSON.stringify({
      squareFootage: 2195,
      lotSize: 'N/A',
      lotSqFt: '6,698 sqft lot',
      propertyType: 'Single Family',
      source: 'https://www.realtor.com/realestateandhomes-detail/example',
      confidence: 'medium',
    })).lotSize).toBe(6698);

    expect(_private.parsePropertyJSON(JSON.stringify({
      squareFootage: 'N/A',
      homeSqFt: '2,195',
      lotSqFt: '6,698 sqft lot',
      propertyType: 'Single Family',
      source: 'https://www.realtor.com/realestateandhomes-detail/example',
      confidence: 'medium',
    }))).toMatchObject({
      squareFootage: 2195,
      lotSize: 6698,
    });

    expect(_private.parsePropertyJSON(JSON.stringify({
      squareFootage: 2195,
      lotSize: { squareFeet: 'N/A', valueSqft: '6,698 sqft' },
      propertyType: 'Single Family',
      source: 'https://www.realtor.com/realestateandhomes-detail/example',
      confidence: 'medium',
    })).lotSize).toBe(6698);

    expect(_private.parsePropertyJSON(JSON.stringify({
      squareFootage: 2195,
      lotSize: { acres: 'N/A', value_acres: 0.1537649 },
      propertyType: 'Single Family',
      source: 'https://www.realtor.com/realestateandhomes-detail/example',
      confidence: 'medium',
    })).lotSize).toBe(6698);
  });

  test('does not report perfect quality when a critical property field is missing', () => {
    const quality = _private.buildPropertyDataQuality({
      squareFootage: { score: 100, fieldVerify: false, sourceType: 'listing' },
      stories: { score: 100, fieldVerify: false, sourceType: 'listing' },
      propertyType: { score: 100, fieldVerify: false, sourceType: 'listing' },
    }, ['gemini', 'claude']);

    expect(quality.level).toBe('medium');
    expect(quality.score).toBe(75);
    expect(quality.verifiedCriticalFields).toBe(3);
    expect(quality.missingCriticalFields).toContain('lotSize');
  });

  test('keeps missing and verify-needed critical fields separate', () => {
    const quality = _private.buildPropertyDataQuality({
      squareFootage: { score: 60, fieldVerify: true, sourceType: 'listing' },
      stories: { score: 100, fieldVerify: false, sourceType: 'listing' },
      propertyType: { score: 100, fieldVerify: false, sourceType: 'listing' },
    }, ['gemini', 'claude']);

    expect(quality.missingCriticalFields).toEqual(['lotSize']);
    expect(quality.verifyCriticalFields).toEqual(['squareFootage']);
    expect(quality.verifiedCriticalFields).toBe(2);
  });

  test('allows medium quality when two critical fields are strongly verified', () => {
    const quality = _private.buildPropertyDataQuality({
      squareFootage: { score: 100, fieldVerify: false, sourceType: 'listing' },
      propertyType: { score: 100, fieldVerify: false, sourceType: 'listing' },
    }, ['gemini']);

    expect(quality.level).toBe('medium');
    expect(quality.score).toBe(50);
    expect(quality.verifiedCriticalFields).toBe(2);
  });
});
