const {
  lookupParcelByPoint,
  countyFromCoNo,
  normalizeParcelIdForPao,
  polygonAreaSqft,
  simplifyRing,
  _private: gisPrivate,
} = require('../services/property-lookup/parcel-gis');
const {
  lookupPropertyFromAITrio,
  _private: aiPrivate,
} = require('../services/property-lookup/ai-property-lookup');

const { pickParcelFeature, zipFromPhyZipcd } = gisPrivate;
const { buildCadastralRecord, canUseParcelGis, dorUcPropertyType, mergePropertyRecords } = aiPrivate;

// ~100ft x ~100ft square near Bradenton (lat 27.5). 1 degree lat ≈ 111320m.
const FT = 1 / (111320 * 3.28084); // degrees latitude per foot
const LAT0 = 27.5;
const LNG_FT = FT / Math.cos((LAT0 * Math.PI) / 180); // degrees longitude per foot
function squareRing(lat, lng, sizeFt) {
  return [
    [lng, lat],
    [lng + sizeFt * LNG_FT, lat],
    [lng + sizeFt * LNG_FT, lat + sizeFt * FT],
    [lng, lat + sizeFt * FT],
    [lng, lat],
  ];
}

function fdorFeature(attrs = {}, rings = null) {
  return {
    attributes: {
      PARCEL_ID: '3331410104',
      PARCELNO: '3331410104',
      CO_NO: 51,
      ASMNT_YR: 2025,
      PHY_ADDR1: '5510 LAKEWOOD RANCH BLVD',
      PHY_ADDR2: null,
      PHY_CITY: 'BRADENTON',
      PHY_ZIPCD: 34211,
      LND_SQFOOT: 10500,
      TOT_LVG_AR: 2200,
      ACT_YR_BLT: 2004,
      EFF_YR_BLT: 2004,
      NO_BULDNG: 1,
      NO_RES_UNT: 1,
      DOR_UC: '001',
      ...attrs,
    },
    geometry: { rings: rings || [squareRing(LAT0, -82.5, 100)] },
  };
}

describe('parcel-gis geometry helpers', () => {
  it('computes the area of a known square within 1%', () => {
    const area = polygonAreaSqft([squareRing(LAT0, -82.5, 100)]);
    expect(area).toBeGreaterThan(9900);
    expect(area).toBeLessThan(10100);
  });

  it('subtracts holes wound opposite the outer ring', () => {
    const outer = squareRing(LAT0, -82.5, 100);
    const hole = [...squareRing(LAT0 + 25 * FT, -82.5 + 25 * LNG_FT, 50)].reverse();
    const area = polygonAreaSqft([outer, hole]);
    expect(area).toBeGreaterThan(7400);
    expect(area).toBeLessThan(7600);
  });

  it('returns null on degenerate input', () => {
    expect(polygonAreaSqft(null)).toBeNull();
    expect(polygonAreaSqft([])).toBeNull();
    expect(polygonAreaSqft([[[1, 2], [3, 4]]])).toBeNull();
  });

  it('simplifyRing keeps endpoints and respects the cap', () => {
    const ring = Array.from({ length: 500 }, (_, i) => [i, i]);
    const simplified = simplifyRing(ring, 100);
    expect(simplified.length).toBe(100);
    expect(simplified[0]).toEqual([0, 0]);
    expect(simplified[99]).toEqual([499, 499]);
    expect(simplifyRing(ring, 2)).toEqual([]);
    expect(simplifyRing([[1, 1], [2, 2], [3, 3]], 100)).toEqual([[1, 1], [2, 2], [3, 3]]);
  });

  it('pickParcelFeature picks the smallest polygon containing the point (condo stacks)', () => {
    const px = -82.5 + 10 * LNG_FT;
    const py = LAT0 + 10 * FT;
    const master = fdorFeature({ PARCEL_ID: 'MASTER' }, [squareRing(LAT0, -82.5, 400)]);
    const unit = fdorFeature({ PARCEL_ID: 'UNIT' }, [squareRing(LAT0, -82.5, 40)]);
    const neighbor = fdorFeature({ PARCEL_ID: 'NEIGHBOR' }, [squareRing(LAT0 + 1000 * FT, -82.5, 20)]);
    const picked = pickParcelFeature([master, unit, neighbor], px, py);
    expect(picked.attributes.PARCEL_ID).toBe('UNIT');
  });
});

describe('parcel-gis attribute mapping', () => {
  it('maps probe-verified CO_NO codes', () => {
    expect(countyFromCoNo(51)).toBe('Manatee');
    expect(countyFromCoNo(68)).toBe('Sarasota');
    expect(countyFromCoNo(18)).toBe('Charlotte');
    expect(countyFromCoNo(11)).toBeNull();
    expect(countyFromCoNo(null)).toBeNull();
  });

  it('parcel IDs pass through unmodified (probe-verified identity mapping)', () => {
    expect(normalizeParcelIdForPao('Manatee', { PARCEL_ID: ' 3331410104 ' })).toBe('3331410104');
    expect(normalizeParcelIdForPao('Charlotte', { PARCEL_ID: '402217351013' })).toBe('402217351013');
    expect(normalizeParcelIdForPao('Sarasota', { PARCEL_ID: '2027070025' })).toBe('2027070025');
  });

  it('Sarasota rejects non-numeric IDs (detail route is digits-only)', () => {
    expect(normalizeParcelIdForPao('Sarasota', { PARCEL_ID: '2027-07-0025' })).toBeNull();
    expect(normalizeParcelIdForPao('Manatee', { PARCEL_ID: null, PARCELNO: '99' })).toBe('99');
    expect(normalizeParcelIdForPao('Manatee', {})).toBeNull();
  });

  it('coerces numeric PHY_ZIPCD to a 5-digit string', () => {
    expect(zipFromPhyZipcd(34211)).toBe('34211');
    expect(zipFromPhyZipcd('34211')).toBe('34211');
    expect(zipFromPhyZipcd(0)).toBeNull();
    expect(zipFromPhyZipcd(null)).toBeNull();
  });
});

describe('lookupParcelByPoint', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.PARCEL_GIS_DISABLED;
  });

  it('returns a shaped parcel on a hit', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ features: [fdorFeature()] }),
    }));

    const parcel = await lookupParcelByPoint(27.5, -82.5);
    expect(parcel).toMatchObject({
      parcelId: '3331410104',
      paoParcelId: '3331410104',
      county: 'Manatee',
      situsAddress: '5510 LAKEWOOD RANCH BLVD',
      situsCity: 'BRADENTON',
      situsZip: '34211',
      lotSqft: 10500,
      livingAreaSqft: 2200,
      yearBuilt: 2004,
      dorUseCode: '001',
      assessmentYear: 2025,
    });
    expect(parcel.polygon).toBeTruthy();
    expect(parcel.polygonAreaSqft).toBeGreaterThan(9000);
    expect(parcel.sourceUrl).toContain('Florida_Statewide_Cadastral');

    const calledUrl = String(global.fetch.mock.calls[0][0]);
    expect(calledUrl).toContain('inSR=4326');
    expect(calledUrl).toContain('outSR=4326');
    expect(calledUrl).toContain('esriSpatialRelIntersects');
  });

  it('returns null on empty result, out-of-area county, error payload, and timeout', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ features: [] }) }));
    expect(await lookupParcelByPoint(27.5, -82.5)).toBeNull();

    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ features: [fdorFeature({ CO_NO: 11 })] }) }));
    expect(await lookupParcelByPoint(27.5, -82.5)).toBeNull();

    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ error: { code: 400, message: 'bad' } }) }));
    expect(await lookupParcelByPoint(27.5, -82.5)).toBeNull();

    global.fetch = jest.fn((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    expect(await lookupParcelByPoint(27.5, -82.5, { timeoutMs: 50 })).toBeNull();
  });

  it('respects the kill switch and rejects bad coordinates', async () => {
    process.env.PARCEL_GIS_DISABLED = '1';
    global.fetch = jest.fn();
    expect(await lookupParcelByPoint(27.5, -82.5)).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();

    delete process.env.PARCEL_GIS_DISABLED;
    expect(await lookupParcelByPoint(NaN, -82.5)).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('cadastral evidence record', () => {
  const parcelFixture = {
    parcelId: '3331410104',
    paoParcelId: '3331410104',
    county: 'Manatee',
    sourceUrl: 'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0',
    situsAddress: '5510 LAKEWOOD RANCH BLVD',
    situsCity: 'BRADENTON',
    situsZip: '34211',
    lotSqft: 10500,
    livingAreaSqft: 2200,
    yearBuilt: 2004,
    dorUseCode: '001',
    assessmentYear: 2025,
    polygon: [squareRing(LAT0, -82.5, 100)],
    polygonAreaSqft: 10000,
  };

  it('maps DOR use codes conservatively', () => {
    expect(dorUcPropertyType('001')).toBe('Single Family');
    expect(dorUcPropertyType('1')).toBe('Single Family');
    expect(dorUcPropertyType('004')).toBe('Condo');
    expect(dorUcPropertyType('008')).toBe('Multifamily');
    expect(dorUcPropertyType('000')).toBeNull();
    expect(dorUcPropertyType('011')).toBeNull();
    expect(dorUcPropertyType(null)).toBeNull();
  });

  it('builds a cadastral-weighted record', () => {
    const record = buildCadastralRecord(parcelFixture, '5510 Lakewood Ranch Blvd');
    expect(record._provider).toBe('fdor_cadastral');
    expect(record._source).toBe('cadastral');
    expect(record._aiSourceType).toBe('cadastral');
    expect(record._aiSourceQuality).toBe(97);
    expect(record.squareFootage).toBe(2200);
    expect(record.lotSize).toBe(10500);
    expect(record.propertyType).toBe('Single Family');
    expect(record.yearBuilt).toBe(2004);
  });

  it('returns null when the roll has no usable facts', () => {
    expect(buildCadastralRecord({ ...parcelFixture, lotSqft: null, livingAreaSqft: null, yearBuilt: null, dorUseCode: '000' }, 'x')).toBeNull();
    expect(buildCadastralRecord(null, 'x')).toBeNull();
  });

  it('cadastral beats listing but loses to live county in the merge', () => {
    const cadastral = buildCadastralRecord(parcelFixture, '5510 Lakewood Ranch Blvd');

    const listing = {
      squareFootage: 1800,
      lotSize: 9000,
      _provider: 'openai',
      _source: 'ai',
      _aiConfidence: 'high',
      _aiSourceUrl: 'https://www.zillow.com/homedetails/5510-lakewood-ranch-blvd/123_zpid/',
      _aiSourceType: 'listing',
      _aiSourceQuality: 75,
    };
    const vsListing = mergePropertyRecords([listing, cadastral], '5510 Lakewood Ranch Blvd');
    expect(vsListing.squareFootage).toBe(2200);
    expect(vsListing._fieldEvidence.squareFootage.sourceType).toBe('cadastral');

    const county = {
      squareFootage: 2250,
      lotSize: 10600,
      _provider: 'manatee_pao',
      _source: 'county',
      _aiConfidence: 'high',
      _aiSourceUrl: 'https://www.manateepao.gov/parcel/?parid=3331410104',
      _aiSourceType: 'county',
      _aiSourceQuality: 100,
    };
    const vsCounty = mergePropertyRecords([cadastral, county], '5510 Lakewood Ranch Blvd');
    expect(vsCounty.squareFootage).toBe(2250);
    expect(vsCounty._fieldEvidence.squareFootage.sourceType).toBe('county');
  });
});

describe('GIS trust gate (canUseParcelGis)', () => {
  const base = { lat: 27.5, lng: -82.5, partialMatch: false, locationType: 'ROOFTOP' };

  it('requires a confident rooftop point', () => {
    expect(canUseParcelGis(base)).toBe(true);
    expect(canUseParcelGis({ ...base, locationType: 'RANGE_INTERPOLATED' })).toBe(false);
    expect(canUseParcelGis({ ...base, locationType: 'APPROXIMATE' })).toBe(false);
    expect(canUseParcelGis({ ...base, partialMatch: true })).toBe(false);
    expect(canUseParcelGis({ ...base, lat: NaN })).toBe(false);
    expect(canUseParcelGis(null)).toBe(false);
  });
});

describe('trio by-parcel routing', () => {
  const originalFetch = global.fetch;
  const savedKeys = {};
  const AI_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];

  beforeEach(() => {
    for (const key of AI_KEYS) {
      savedKeys[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    global.fetch = originalFetch;
    for (const key of AI_KEYS) {
      if (savedKeys[key] === undefined) delete process.env[key];
      else process.env[key] = savedKeys[key];
    }
  });

  const geo = {
    lat: 27.5,
    lng: -82.5,
    county: 'Manatee',
    state: 'FL',
    city: 'Bradenton',
    zip: '34211',
    formattedAddress: '5510 Lakewood Ranch Blvd, Bradenton, FL 34211, USA',
    partialMatch: false,
    locationType: 'ROOFTOP',
  };

  it('GIS hit skips the PAO address search and fetches details by parid', async () => {
    const fetchedUrls = [];
    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      fetchedUrls.push(urlText);
      if (urlText.includes('arcgis.com')) {
        return { ok: true, json: async () => ({ features: [fdorFeature()] }) };
      }
      if (urlText.includes('pao-model-land.php')) {
        return {
          ok: true,
          json: async () => ({
            cols: [{ title: 'SqFootage' }, { title: 'Type' }],
            rows: [['10,500', 'RES']],
          }),
        };
      }
      if (urlText.includes('pao-model-buildings.php')) {
        return {
          ok: true,
          json: async () => ({
            cols: [
              { title: 'LivBus' }, { title: 'Yrblt' }, { title: 'Stories' },
              { title: 'Rooms' }, { title: 'Type' },
            ],
            rows: [['2,200', '2004', '1', '3 Bed / 2 Bath', 'SINGLE FAMILY']],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${urlText}`);
    });

    const merged = await lookupPropertyFromAITrio('5510 lakewood rnch blvd bradenton', geo);

    // Detail endpoints hit directly by parid — no search POST.
    const manateeUrls = fetchedUrls.filter((u) => u.includes('manateepao.gov'));
    expect(manateeUrls.length).toBe(2);
    expect(manateeUrls.every((u) => u.includes('parid=3331410104'))).toBe(true);
    expect(fetchedUrls.some((u) => u.includes('parcel-search-results'))).toBe(false);

    // Cadastral evidence + parcel metadata survive the merge.
    expect(merged._provider).toContain('fdor_cadastral');
    expect(merged.squareFootage).toBe(2200);
    expect(merged._parcel).toMatchObject({
      parcelId: '3331410104',
      county: 'Manatee',
      polygonAreaSqft: expect.any(Number),
      vintage: 2025,
    });
    expect(Array.isArray(merged._parcel.polygon)).toBe(true);
  });

  it('GIS miss falls back to the address search path', async () => {
    const fetchedUrls = [];
    global.fetch = jest.fn(async (url) => {
      const urlText = String(url);
      fetchedUrls.push(urlText);
      if (urlText.includes('arcgis.com')) {
        return { ok: true, json: async () => ({ features: [] }) };
      }
      throw new Error('network disabled in test');
    });

    const merged = await lookupPropertyFromAITrio('5510 Lakewood Ranch Blvd, Bradenton, FL 34211', geo);
    expect(merged).toBeNull();
    // Address search attempted after the GIS miss.
    expect(fetchedUrls.some((u) => u.includes('parcel-search-results'))).toBe(true);
  });

  it('non-rooftop geocodes never touch the GIS layer', async () => {
    const fetchedUrls = [];
    global.fetch = jest.fn(async (url) => {
      fetchedUrls.push(String(url));
      throw new Error('network disabled in test');
    });

    await lookupPropertyFromAITrio('5510 Lakewood Ranch Blvd, Bradenton, FL 34211', {
      ...geo,
      locationType: 'APPROXIMATE',
    });
    expect(fetchedUrls.some((u) => u.includes('arcgis.com'))).toBe(false);
  });
});
