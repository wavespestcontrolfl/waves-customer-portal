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

describe('Manatee PAO property lookup facts', () => {
  const manateeSearch = {
    parcelId: '647302459',
    situsAddress: '8920 49TH AVE E',
    city: 'PALMETTO',
  };
  const manateeLand = {
    cols: [
      { title: 'Area' },
      { title: 'Type' },
      { title: 'ActFrontage' },
      { title: 'EffFrontage' },
      { title: 'Depth' },
      { title: 'Acreage' },
      { title: 'SqFootage' },
      { title: 'Units' },
      { title: 'Influences' },
    ],
    rows: [
      ['1', 'UNIT', '70', '70', '120', '0.1928', '8,400', '1.00', ''],
    ],
  };
  const manateeBuildings = {
    cols: [
      { title: 'Type' },
      { title: 'Bldg' },
      { title: 'Classification' },
      { title: 'Yrblt' },
      { title: 'Effyr' },
      { title: 'Stories' },
      { title: 'UnRoof' },
      { title: 'LivBus' },
      { title: 'Rooms' },
      { title: 'Const/ExtWall' },
      { title: 'RoofMaterial' },
      { title: 'RoofType' },
    ],
    rows: [
      ['RES', '1', 'RESIDENTIAL', '2017', '2017', 1, '2943', '2310', '4/2/0', 'MASONRY/STUCCO', 'SHINGLES COMP', 'HIP AND/OR GABLE'],
    ],
  };

  test('limits Manatee county lookup to likely Manatee addresses', () => {
    expect(_private.shouldQueryManateePAO('8920 49th Ave E, Bradenton, FL 34211')).toBe(true);
    expect(_private.shouldQueryManateePAO('123 Main St, Bradenton, FL')).toBe(true);
    expect(_private.shouldQueryManateePAO('8920 49th Ave E')).toBe(false);
    expect(_private.shouldQueryManateePAO('123 Main St, Sarasota, FL 34243')).toBe(true);
    expect(_private.shouldQueryManateePAO('123 Main St, Sarasota, FL 34231')).toBe(false);
    expect(_private.shouldQueryManateePAO('123 Main St, Venice, FL')).toBe(false);
  });

  test('builds PAO address candidates with normalized suffixes and directions', () => {
    expect(_private.manateeAddressSearchCandidates('8920 49th Avenue East, Bradenton, FL 34211')).toEqual([
      '8920 49TH AVE E',
      '8920 49TH',
    ]);
  });

  test('filters ambiguous PAO search rows by requested city', () => {
    const searchResults = {
      cols: [
        { title: 'Parcel ID' },
        { title: 'Property Type' },
        { title: 'Owner(s)' },
        { title: 'Situs Address' },
        { title: 'Postal City' },
      ],
      rows: [
        ['111', 'REAL PROPERTY', '', ';123 MAIN ST;', 'BRADENTON'],
        ['222', 'REAL PROPERTY', '', ';123 MAIN ST;', 'SARASOTA'],
      ],
    };

    expect(_private.pickManateeSearchResult(searchResults, '123 Main St, Sarasota, FL 34243')).toMatchObject({
      parcelId: '222',
      city: 'SARASOTA',
    });
    expect(_private.pickManateeSearchResult({
      ...searchResults,
      rows: [searchResults.rows[0]],
    }, '123 Main St, Sarasota, FL 34243')).toBeNull();
  });

  test('allows PAO postal-city aliases when a non-shared Manatee ZIP is present', () => {
    const searchResults = {
      cols: [
        { title: 'Parcel ID' },
        { title: 'Property Type' },
        { title: 'Owner(s)' },
        { title: 'Situs Address' },
        { title: 'Postal City' },
      ],
      rows: [
        ['647302459', 'REAL PROPERTY', '', ';8920 49TH AVE E;', 'PALMETTO'],
      ],
    };

    expect(_private.pickManateeSearchResult(searchResults, '8920 49th Ave E, Bradenton, FL 34211')).toMatchObject({
      parcelId: '647302459',
      city: 'PALMETTO',
    });
  });

  test('prefers exact PAO street matches and rejects wrong suffix matches', () => {
    const searchResults = {
      cols: [
        { title: 'Parcel ID' },
        { title: 'Property Type' },
        { title: 'Owner(s)' },
        { title: 'Situs Address' },
        { title: 'Postal City' },
      ],
      rows: [
        ['111', 'REAL PROPERTY', '', ';8920 49TH ST E;', 'BRADENTON'],
        ['222', 'REAL PROPERTY', '', ';8920 49TH AVE E;', 'PALMETTO'],
      ],
    };

    expect(_private.pickManateeSearchResult(searchResults, '8920 49th Ave E, Bradenton, FL 34211')).toMatchObject({
      parcelId: '222',
      city: 'PALMETTO',
    });
    expect(_private.pickManateeSearchResult({
      ...searchResults,
      rows: [searchResults.rows[0]],
    }, '8920 49th Ave E, Bradenton, FL 34211')).toBeNull();
  });

  test('parses Manatee land and building tables into estimator facts', () => {
    const parsed = _private.parseManateePaoRecord({
      address: '8920 49th Ave E, Bradenton, FL 34211',
      search: manateeSearch,
      land: manateeLand,
      buildings: manateeBuildings,
    });

    expect(parsed).toMatchObject({
      squareFootage: 2310,
      lotSize: 8400,
      yearBuilt: 2017,
      bedrooms: 4,
      bathrooms: 2,
      stories: 1,
      propertyType: 'Single Family',
      constructionMaterial: 'CBS',
      roofType: 'SHINGLE',
      county: 'Manatee',
      formattedAddress: '8920 49TH AVE E, PALMETTO, FL',
    });
    expect(parsed.source).toBe('https://www.manateepao.gov/parcel/?parid=647302459');
  });

  test('merged county records remain authoritative and high quality', () => {
    const parsed = _private.parseManateePaoRecord({
      address: '8920 49th Ave E, Bradenton, FL 34211',
      search: manateeSearch,
      land: manateeLand,
      buildings: manateeBuildings,
    });
    const record = _private.shapeAsPropertyRecord(parsed, '8920 49th Ave E, Bradenton, FL 34211', 'manatee_pao');
    const merged = _private.mergePropertyRecords([record], '8920 49th Ave E, Bradenton, FL 34211');

    expect(merged._source).toBe('county');
    expect(merged._provider).toBe('manatee_pao');
    expect(merged._raw._source).toBe('county');
    expect(merged._dataQuality).toMatchObject({
      level: 'high',
      score: 100,
      verifiedCriticalFields: 4,
      fieldVerifyCount: 0,
    });
    expect(merged._fieldEvidence.lotSize).toMatchObject({
      sourceType: 'county',
      fieldVerify: false,
      winningProvider: 'manatee_pao',
    });
  });

  test('AI records citing county URLs remain AI provenance', () => {
    const record = _private.shapeAsPropertyRecord({
      squareFootage: 2310,
      lotSize: 8400,
      yearBuilt: 2017,
      bedrooms: 4,
      bathrooms: 2,
      stories: 1,
      propertyType: 'Single Family',
      constructionMaterial: 'CBS',
      roofType: 'SHINGLE',
      source: 'https://www.manateepao.gov/parcel/?parid=647302459',
      confidence: 'high',
      county: 'Manatee',
    }, '8920 49th Ave E, Bradenton, FL 34211', 'openai');
    const merged = _private.mergePropertyRecords([record], '8920 49th Ave E, Bradenton, FL 34211');

    expect(record._source).toBe('ai');
    expect(record._raw._source).toBe('ai');
    expect(record._aiSourceType).toBe('county');
    expect(merged._source).toBe('ai');
    expect(merged._raw._source).toBe('ai_trio');
  });

  test('county early-return core requires lot size for pricing', () => {
    expect(_private.hasCountyPricingCore({
      squareFootage: 2310,
      lotSize: 8400,
      propertyType: 'Single Family',
    })).toBe(true);
    expect(_private.hasCountyPricingCore({
      squareFootage: 2310,
      stories: 1,
      propertyType: 'Single Family',
    })).toBe(false);
  });
});
