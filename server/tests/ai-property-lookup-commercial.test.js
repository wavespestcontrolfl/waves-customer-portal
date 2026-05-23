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
    expect(_private.shouldQueryManateePAO('123 Main St, Lakewood Ranch, FL 34240')).toBe(true);
    expect(_private.shouldQueryManateePAO('123 Main St, Tallevast, FL')).toBe(true);
    expect(_private.shouldQueryManateePAO('123 Main St, Sarasota, FL 34231')).toBe(false);
    expect(_private.shouldQueryManateePAO('123 Main St, Venice, FL')).toBe(false);
  });

  test('builds PAO address candidates with normalized suffixes and directions', () => {
    expect(_private.manateeAddressSearchCandidates('8920 49th Avenue East, Bradenton, FL 34211')).toEqual([
      '8920 49TH AVE E',
      '8920 49TH',
    ]);
    expect(_private.manateeAddressSearchCandidates('123 St George Drive, Bradenton, FL 34211')).toEqual([
      '123 ST GEORGE DR',
      '123 ST GEORGE',
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
    expect(_private.pickManateeSearchResult(searchResults, '123 Main St, Apt 2, Sarasota, FL 34243')).toMatchObject({
      parcelId: '222',
      city: 'SARASOTA',
    });
    expect(_private.pickManateeSearchResult(searchResults, '123 Main St, Sarasota FL 34243')).toMatchObject({
      parcelId: '222',
      city: 'SARASOTA',
    });
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

  test('does not treat saint street-name tokens as terminal suffixes', () => {
    const searchResults = {
      cols: [
        { title: 'Parcel ID' },
        { title: 'Property Type' },
        { title: 'Owner(s)' },
        { title: 'Situs Address' },
        { title: 'Postal City' },
      ],
      rows: [
        ['111', 'REAL PROPERTY', '', ';123 ST GEORGE ST;', 'BRADENTON'],
      ],
    };

    expect(_private.pickManateeSearchResult(searchResults, '123 St George Dr, Bradenton, FL 34211')).toBeNull();
  });

  test('rejects ambiguous PAO prefix matches without a unique discriminator', () => {
    const searchResults = {
      cols: [
        { title: 'Parcel ID' },
        { title: 'Property Type' },
        { title: 'Owner(s)' },
        { title: 'Situs Address' },
        { title: 'Postal City' },
      ],
      rows: [
        ['111', 'REAL PROPERTY', '', ';123 MAIN ST E;', 'BRADENTON'],
        ['222', 'REAL PROPERTY', '', ';123 MAIN ST W;', 'BRADENTON'],
      ],
    };

    expect(_private.pickManateeSearchResult(searchResults, '123 Main St, Bradenton, FL 34211')).toBeNull();
  });

  test('uses requested city only as a unique PAO tie-breaker', () => {
    const searchResults = {
      cols: [
        { title: 'Parcel ID' },
        { title: 'Property Type' },
        { title: 'Owner(s)' },
        { title: 'Situs Address' },
        { title: 'Postal City' },
      ],
      rows: [
        ['111', 'REAL PROPERTY', '', ';123 MAIN ST;', 'PALMETTO'],
        ['222', 'REAL PROPERTY', '', ';123 MAIN ST;', 'BRADENTON'],
      ],
    };

    expect(_private.pickManateeSearchResult(searchResults, '123 Main St, Bradenton, FL 34211')).toMatchObject({
      parcelId: '222',
      city: 'BRADENTON',
    });
  });

  test('requires city match when Manatee lookup is enabled by city fallback', () => {
    const searchResults = {
      cols: [
        { title: 'Parcel ID' },
        { title: 'Property Type' },
        { title: 'Owner(s)' },
        { title: 'Situs Address' },
        { title: 'Postal City' },
      ],
      rows: [
        ['111', 'REAL PROPERTY', '', ';123 MAIN ST;', 'PALMETTO'],
        ['222', 'REAL PROPERTY', '', ';123 MAIN ST;', 'LAKEWOOD RANCH'],
      ],
    };

    expect(_private.pickManateeSearchResult(searchResults, '123 Main St, Lakewood Ranch, FL 34240')).toMatchObject({
      parcelId: '222',
      city: 'LAKEWOOD RANCH',
    });
    expect(_private.pickManateeSearchResult({
      ...searchResults,
      rows: [searchResults.rows[0]],
    }, '123 Main St, Lakewood Ranch, FL 34240')).toBeNull();
  });

  test('deduplicates identical PAO search rows before deciding uniqueness', () => {
    const searchResults = {
      cols: [
        { title: 'Parcel ID' },
        { title: 'Property Type' },
        { title: 'Owner(s)' },
        { title: 'Situs Address' },
        { title: 'Postal City' },
      ],
      rows: [
        ['222', 'REAL PROPERTY', '', ';123 MAIN ST;', 'BRADENTON'],
        ['222', 'REAL PROPERTY', '', ';123 MAIN ST;', 'BRADENTON'],
      ],
    };

    expect(_private.pickManateeSearchResult(searchResults, '123 Main St, Bradenton, FL 34211')).toMatchObject({
      parcelId: '222',
      city: 'BRADENTON',
    });
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

  test('chooses dominant PAO building row before classifying parcel', () => {
    const mixedUseBuildings = {
      ...manateeBuildings,
      rows: [
        ['RES', '1', 'RESIDENTIAL', '2017', '2017', 1, '2943', '1200', '2/1/0', 'MASONRY/STUCCO', 'SHINGLES COMP', 'HIP AND/OR GABLE'],
        ['COM', '2', 'WAREHOUSE', '2017', '2017', 1, '6000', '5000', '', 'METAL', 'METAL', 'METAL'],
      ],
    };

    expect(_private.parseManateePaoRecord({
      address: '123 Mixed Use St, Bradenton, FL 34211',
      search: manateeSearch,
      land: manateeLand,
      buildings: mixedUseBuildings,
    })).toMatchObject({
      squareFootage: 5000,
      propertyType: 'Warehouse',
      constructionMaterial: 'METAL',
    });
  });

  test('treats PAO land SqFootage as square feet', () => {
    const smallPaoLand = {
      ...manateeLand,
      rows: [
        ['1', 'UNIT', '20', '20', '25', '0.0115', '500', '1.00', ''],
      ],
    };

    expect(_private.parseManateePaoRecord({
      address: '123 Small Lot St, Bradenton, FL 34211',
      search: manateeSearch,
      land: smallPaoLand,
      buildings: manateeBuildings,
    }).lotSize).toBe(500);
  });

  test('caps aggregate PAO land SqFootage at the pricing limit', () => {
    const largePaoLand = {
      ...manateeLand,
      rows: [
        ['1', 'UNIT', '100', '100', '1500', '3.4435', '150,000', '1.00', ''],
        ['2', 'UNIT', '100', '100', '1000', '2.2957', '100,000', '1.00', ''],
      ],
    };

    expect(_private.parseManateePaoRecord({
      address: '123 Large Lot St, Bradenton, FL 34211',
      search: manateeSearch,
      land: largePaoLand,
      buildings: manateeBuildings,
    }).lotSize).toBe(200000);
  });

  test('keeps Manatee residential subtypes in estimator categories', () => {
    const withClassification = (classification) => ({
      ...manateeBuildings,
      rows: [
        ['RES', '1', classification, '2017', '2017', 1, '2943', '2310', '4/2/0', 'MASONRY/STUCCO', 'SHINGLES COMP', 'HIP AND/OR GABLE'],
      ],
    });

    expect(_private.parseManateePaoRecord({
      address: '123 Duplex St, Bradenton, FL 34211',
      search: manateeSearch,
      land: manateeLand,
      buildings: withClassification('RESIDENTIAL DUPLEX'),
    }).propertyType).toBe('Duplex');

    expect(_private.parseManateePaoRecord({
      address: '123 Townhome St, Bradenton, FL 34211',
      search: manateeSearch,
      land: manateeLand,
      buildings: withClassification('TOWNHOUSE'),
    }).propertyType).toBe('Townhome');
  });

  test('keeps Manatee commercial subtypes in estimator categories', () => {
    const withType = (type, classification) => ({
      ...manateeBuildings,
      rows: [
        [type, '1', classification, '2017', '2017', 1, '2943', '2310', '4/2/0', 'MASONRY/STUCCO', 'SHINGLES COMP', 'HIP AND/OR GABLE'],
      ],
    });

    expect(_private.parseManateePaoRecord({
      address: '123 Warehouse St, Bradenton, FL 34211',
      search: manateeSearch,
      land: manateeLand,
      buildings: withType('COM', 'WAREHOUSE'),
    }).propertyType).toBe('Warehouse');

    expect(_private.parseManateePaoRecord({
      address: '123 Office St, Bradenton, FL 34211',
      search: manateeSearch,
      land: manateeLand,
      buildings: withType('COM', 'COMMERCIAL OFFICE'),
    }).propertyType).toBe('Office');

    expect(_private.parseManateePaoRecord({
      address: '123 Office Condo St, Bradenton, FL 34211',
      search: manateeSearch,
      land: manateeLand,
      buildings: withType('COM', 'OFFICE CONDOMINIUM'),
    }).propertyType).toBe('Office');

    expect(_private.parseManateePaoRecord({
      address: '123 Common Area St, Bradenton, FL 34211',
      search: manateeSearch,
      land: manateeLand,
      buildings: withType('RES', 'COMMON AREA'),
    }).propertyType).toBe('HOA Common Area');
  });

  test('does not classify wood-frame stucco as CBS', () => {
    const withConstruction = (construction) => ({
      ...manateeBuildings,
      rows: [
        ['RES', '1', 'RESIDENTIAL', '2017', '2017', 1, '2943', '2310', '4/2/0', construction, 'SHINGLES COMP', 'HIP AND/OR GABLE'],
      ],
    });

    expect(_private.parseManateePaoRecord({
      address: '123 Frame St, Bradenton, FL 34211',
      search: manateeSearch,
      land: manateeLand,
      buildings: withConstruction('WOOD FRAME/STUCCO'),
    }).constructionMaterial).toBe('WOOD_FRAME');

    expect(_private.parseManateePaoRecord({
      address: '123 Stucco St, Bradenton, FL 34211',
      search: manateeSearch,
      land: manateeLand,
      buildings: withConstruction('STUCCO'),
    }).constructionMaterial).toBeNull();
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
