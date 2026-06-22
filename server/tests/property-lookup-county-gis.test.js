/**
 * County parcel GIS lookup (Manatee / Sarasota / Charlotte).
 *
 * Each county's own continuously-maintained parcel polygon layer carries new
 * plats sooner than the annual FDOR statewide roll and exposes the land-use
 * DESCRIPTION ("Half Duplex/Paired Villa", "Condominia") that the numeric
 * DOR-code map can't split from a detached home. Resolved by geocoded point
 * (point-in-polygon), which sidesteps the address-string PAO miss.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const countyGis = require('../services/property-lookup/county-parcel-gis');
const { _private: aiPrivate } = require('../services/property-lookup/ai-property-lookup');
const { buildEnrichedProfile } = require('../routes/property-lookup-v2');

const {
  lookupCountyParcelByPoint,
  countyUseDescToPropertyType,
  normalizeCountyName,
  _private: { paoParcelIdFrom },
} = countyGis;

const {
  buildCadastralRecord, applyCountyGisTypeOverride, mergePropertyRecords, preserveCountyGisLandUse,
} = aiPrivate;

// A square ring (WGS84 lng/lat) around the test point, so pickParcelFeature's
// point-in-polygon test matches and polygonAreaSqft is > 0.
const PT = { lat: 27.4, lng: -82.4 };
const RING = [[
  [-82.401, 27.399], [-82.399, 27.399], [-82.399, 27.401], [-82.401, 27.401], [-82.401, 27.399],
]];

function mockArcgis(attributes) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ features: [{ attributes, geometry: { rings: RING } }] }),
  });
}

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; jest.clearAllMocks(); delete process.env.COUNTY_PARCEL_GIS_DISABLED; });

describe('countyUseDescToPropertyType', () => {
  test('maps SWFL county land-use descriptions (Manatee never says "townhouse")', () => {
    expect(countyUseDescToPropertyType('Half Duplex/Paired Villa (1554)')).toBe('Townhome');
    expect(countyUseDescToPropertyType('Condominia Improved (1554)')).toBe('Condo');
    expect(countyUseDescToPropertyType('Single Family Residential (1554)')).toBe('Single Family');
    expect(countyUseDescToPropertyType('TOWNHOUSE')).toBe('Townhome');
    expect(countyUseDescToPropertyType('Interior Townhome')).toBe('Interior Townhome');
    expect(countyUseDescToPropertyType('Duplex')).toBe('Duplex');
    expect(countyUseDescToPropertyType('Apartment 10+ units')).toBe('Multifamily');
  });

  test('returns null for non-residential / vacant / numeric-only / empty', () => {
    expect(countyUseDescToPropertyType('Municipal (1555)')).toBeNull();
    expect(countyUseDescToPropertyType('Vacant Residential Platted (1554)')).toBeNull();
    expect(countyUseDescToPropertyType('Improved Residential Common Area')).toBeNull();
    expect(countyUseDescToPropertyType('0100')).toBeNull();
    expect(countyUseDescToPropertyType('')).toBeNull();
    expect(countyUseDescToPropertyType(null)).toBeNull();
  });
});

describe('normalizeCountyName / paoParcelIdFrom', () => {
  test('normalizes geocoder county strings', () => {
    expect(normalizeCountyName('Manatee County')).toBe('Manatee');
    expect(normalizeCountyName('sarasota')).toBe('Sarasota');
    expect(normalizeCountyName('Charlotte County')).toBe('Charlotte');
    expect(normalizeCountyName('Hillsborough')).toBeNull();
  });

  test('PAO parcel id must be digit-only (else fail closed to address search)', () => {
    expect(paoParcelIdFrom('3331410104')).toBe('3331410104');
    expect(paoParcelIdFrom('0123-45-678X')).toBeNull();
    expect(paoParcelIdFrom('')).toBeNull();
  });
});

describe('lookupCountyParcelByPoint', () => {
  test('Manatee: normalizes the rich roll record (type from description, stories, pool)', async () => {
    mockArcgis({
      PARID: '3331410104',
      SITUS_ADDRESS: '17742 LUCAYA DR',
      SITUS_POSTAL_CITY: 'BRADENTON',
      SITUS_POSTAL_ZIP: '34202',
      LAND_SQFT_CAMA: 7200,
      BLDGS_SQFT_LIVING: 2450,
      BLDG_R1_STORIES: 2,
      BLDG_R1_YRBUILT: 2020,
      BLDGS_LIVINGUNITS: 1,
      CUR_DOR_LUC_CODE: '01',
      CUR_MAN_LUC_DESC: 'Half Duplex/Paired Villa (1554)',
      PAR_SUBDIV_NAME: 'ISLES AT LAKEWOOD RANCH PHASE I-A',
      PAR_SWIMPOOL_FLAG: 'N',
      CUR_ROLL_YEAR: 2026,
    });

    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee County' });
    expect(global.fetch).toHaveBeenCalledTimes(1); // hinted: only Manatee queried
    expect(global.fetch.mock.calls[0][0]).toContain('gis.manateepao.gov');
    expect(parcel).toMatchObject({
      county: 'Manatee',
      parcelId: '3331410104',
      paoParcelId: '3331410104',
      situsAddress: '17742 LUCAYA DR',
      situsCity: 'BRADENTON',
      situsZip: '34202',
      lotSqft: 7200,
      livingAreaSqft: 2450,
      stories: 2,
      yearBuilt: 2020,
      dorUseCode: '01',
      landUseDescription: 'Half Duplex/Paired Villa (1554)',
      subdivision: 'ISLES AT LAKEWOOD RANCH PHASE I-A',
      poolFlag: false,
      gisProvider: 'manatee_gis',
    });
    expect(parcel.polygonAreaSqft).toBeGreaterThan(0);
  });

  test('Charlotte: no land figure → lot size derived from the polygon geometry', async () => {
    mockArcgis({
      ACCOUNT: '402217351013',
      FullPropertyAddress: '123 MAIN ST',
      city: 'PUNTA GORDA',
      zipcode: '33950',
      usecode: '0100',
      description: 'SINGLE FAMILY',
      subneighborhood: 'BURNT STORE',
    });
    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Charlotte' });
    expect(parcel.county).toBe('Charlotte');
    expect(parcel.lotSqft).toBeGreaterThan(0); // from polygon, not a roll field
    expect(parcel.lotSqft).toBe(parcel.polygonAreaSqft);
    expect(parcel.landUseDescription).toBe('SINGLE FAMILY');
  });

  test('parses regardless of ArcGIS attribute key case (codex P2 hardening)', async () => {
    // Same Sarasota fields but UPPERCASE keys — the case-insensitive getter must
    // still resolve them so a server casing quirk never silently disables a county.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ features: [{
        attributes: { ID: '0009112081', ACCOUNT: '0000008112', FULLADDRESS: '1 BAY ST', LOCCITY: 'VENICE', LSQFT: 6000, STCD: '0100', YRBL: 2018 },
        geometry: { rings: RING },
      }] }),
    });
    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' });
    expect(parcel).toMatchObject({
      county: 'Sarasota', parcelId: '0009112081', paoParcelId: '0009112081',
      situsAddress: '1 BAY ST', situsCity: 'VENICE', lotSqft: 6000, yearBuilt: 2018, dorUseCode: '0100',
    });
  });

  test('no features at the point → null', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ features: [] }) });
    expect(await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee' })).toBeNull();
  });

  test('kill switch returns null without any network call', async () => {
    process.env.COUNTY_PARCEL_GIS_DISABLED = '1';
    global.fetch = jest.fn();
    expect(await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Manatee' })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('fails open to null on a network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('boom'));
    expect(await lookupCountyParcelByPoint(PT.lat, PT.lng, { county: 'Sarasota' })).toBeNull();
  });

  test('shared deadline: a budget too small to query returns null without a fetch (codex P1)', async () => {
    global.fetch = jest.fn();
    // No hint → would fan out to 3 counties; a sub-threshold budget must not
    // start any query (preserve the FDOR/PAO fallback budget).
    expect(await lookupCountyParcelByPoint(PT.lat, PT.lng, { timeoutMs: 100 })).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('without a county hint, tries the serviced counties until one matches', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ features: [] }) }) // Manatee miss
      .mockResolvedValueOnce({ ok: true, json: async () => ({ features: [{ attributes: { account: '999', id: '888', lsqft: 5000, stcd: '01' }, geometry: { rings: RING } }] }) }); // Sarasota hit
    const parcel = await lookupCountyParcelByPoint(PT.lat, PT.lng);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(parcel.county).toBe('Sarasota');
    expect(parcel.paoParcelId).toBe('888'); // digit id, not account
  });
});

describe('buildCadastralRecord with a county GIS parcel', () => {
  test('county GIS parcel → propertyType from description, _source county, stories carried', () => {
    const parcel = {
      county: 'Manatee',
      parcelId: '3331410104',
      paoParcelId: '3331410104',
      situsAddress: '17742 LUCAYA DR',
      situsCity: 'BRADENTON',
      situsZip: '34202',
      lotSqft: 7200,
      livingAreaSqft: 2450,
      stories: 2,
      yearBuilt: 2020,
      dorUseCode: '01', // DOR can't tell villa from SFR...
      landUseDescription: 'Half Duplex/Paired Villa (1554)', // ...but the description can
      subdivision: 'ISLES AT LAKEWOOD RANCH PHASE I-A',
      polygonAreaSqft: 7100,
      sourceUrl: 'https://gis.manateepao.gov/arcgis/rest/services/Website/WebLayers/MapServer/0',
      gisProvider: 'manatee_gis',
    };
    const record = buildCadastralRecord(parcel, '17742 Lucaya Dr, Bradenton, FL 34202');
    expect(record.propertyType).toBe('Townhome'); // description beat the ambiguous DOR code
    expect(record.stories).toBe(2);
    expect(record.squareFootage).toBe(2450);
    expect(record.lotSize).toBe(7200);
    expect(record._source).toBe('county');
    // county GIS host classifies as county (100) for per-field evidence weight
    expect(record._fieldEvidence.propertyType[0].sourceType).toBe('county');
    expect(record._fieldEvidence.propertyType[0].sourceQuality).toBe(100);
    expect(record._aiProviders).toEqual(['manatee_gis']);
  });

  test('the use-description type wins a same-weight PAO merge tie (codex P1)', () => {
    // PAO address search reports generic "Single Family"; county GIS reports a
    // paired villa. Both are county/100, so the merge ties to PAO by order —
    // the override lets the authoritative land-use description win the type.
    const gisParcel = {
      county: 'Manatee', parcelId: '1', situsAddress: '17742 LUCAYA DR', situsCity: 'BRADENTON', situsZip: '34202',
      lotSqft: 7200, livingAreaSqft: 2450, stories: 2, yearBuilt: 2020, dorUseCode: '01',
      landUseDescription: 'Half Duplex/Paired Villa (1554)',
      sourceUrl: 'https://gis.manateepao.gov/arcgis/rest/services/Website/WebLayers/MapServer/0',
      gisProvider: 'manatee_gis',
    };
    const cadastralRecord = buildCadastralRecord(gisParcel, 'addr');
    const fdorParcel = {
      county: 'Manatee', parcelId: '1', situsAddress: '17742 LUCAYA DR', situsCity: 'BRADENTON', situsZip: '34202',
      lotSqft: 7200, livingAreaSqft: 2500, yearBuilt: 2020, dorUseCode: '01',
      sourceUrl: 'https://www.manateepao.gov/x', // classifies as county (PAO)
    };
    // Stand in for the PAO record: a county-weighted record reporting SFR.
    const paoRecord = buildCadastralRecord(fdorParcel, 'addr');
    paoRecord.propertyType = 'Single Family';
    paoRecord._fieldEvidence.propertyType = [{ field: 'propertyType', value: 'Single Family', provider: 'manatee_pao', url: 'https://www.manateepao.gov/x', sourceType: 'county', sourceQuality: 100, providerConfidence: 'high' }];

    const merged = mergePropertyRecords([paoRecord, cadastralRecord], 'addr');
    expect(merged.propertyType).toBe('Single Family'); // tie went to PAO order...
    applyCountyGisTypeOverride(merged, cadastralRecord);
    expect(merged.propertyType).toBe('Townhome'); // ...override lets the description win
    expect(merged._fieldEvidence.propertyType.fieldVerify).toBe(false);
  });

  test('override does NOT overwrite an already-specific conflicting type, but flags it (codex P1)', () => {
    const gisParcel = {
      county: 'Manatee', parcelId: '1', situsAddress: '1 A ST', situsCity: 'BRADENTON', situsZip: '34202',
      lotSqft: 7200, dorUseCode: '01', landUseDescription: 'Half Duplex/Paired Villa (1554)',
      sourceUrl: 'https://gis.manateepao.gov/x', gisProvider: 'manatee_gis',
    };
    const cadastralRecord = buildCadastralRecord(gisParcel, 'addr'); // -> Townhome, _typeFromUseDesc
    // A specific, conflicting live result (e.g. PAO/AI) already won the merge.
    const merged = {
      propertyType: 'Condo',
      _aiProviders: ['manatee_pao'],
      _fieldEvidence: { propertyType: { value: 'Condo', sourceType: 'county', fieldVerify: false, disagreement: false, evidence: [] } },
    };
    applyCountyGisTypeOverride(merged, cadastralRecord);
    expect(merged.propertyType).toBe('Condo'); // NOT overwritten with Townhome
    expect(merged._fieldEvidence.propertyType.fieldVerify).toBe(true); // conflict surfaced
    expect(merged._fieldEvidence.propertyType.disagreement).toBe(true);
  });

  test('override does not touch a "Commercial" merged type', () => {
    const cadastralRecord = buildCadastralRecord({
      county: 'Manatee', parcelId: '1', situsAddress: '1 A ST', situsCity: 'BRADENTON', situsZip: '34202',
      lotSqft: 7200, dorUseCode: '01', landUseDescription: 'Half Duplex/Paired Villa (1554)',
      sourceUrl: 'https://gis.manateepao.gov/x', gisProvider: 'manatee_gis',
    }, 'addr');
    const merged = { propertyType: 'Commercial', _aiProviders: [], _fieldEvidence: { propertyType: { value: 'Commercial', sourceType: 'county', fieldVerify: false, evidence: [] } } };
    applyCountyGisTypeOverride(merged, cadastralRecord);
    expect(merged.propertyType).toBe('Commercial');
  });

  test('override never downgrades an already-specific type and skips DOR-only types', () => {
    // GIS type came from the DOR code (not the description) → no override flag.
    const dorOnly = buildCadastralRecord({
      county: 'Sarasota', parcelId: '9', situsAddress: '1 A ST', situsCity: 'VENICE', situsZip: '34285',
      lotSqft: 8000, livingAreaSqft: 1800, yearBuilt: 2001, dorUseCode: '01',
      sourceUrl: 'https://ags3.scgov.net/x', gisProvider: 'sarasota_gis',
    }, 'addr');
    expect(dorOnly._typeFromUseDesc).toBe(false);
    const merged = { propertyType: 'Condo', _fieldEvidence: { propertyType: { value: 'Condo' } } };
    applyCountyGisTypeOverride(merged, dorOnly);
    expect(merged.propertyType).toBe('Condo'); // untouched — not description-derived
  });

  test('commercial/municipal land-use routes to the commercial path, not Single Family (codex P1)', () => {
    const mk = (desc) => buildCadastralRecord({
      county: 'Manatee', parcelId: '1', situsAddress: '500 MAIN ST', situsCity: 'BRADENTON', situsZip: '34205',
      lotSqft: 20000, dorUseCode: '11', landUseDescription: desc,
      sourceUrl: 'https://gis.manateepao.gov/x', gisProvider: 'manatee_gis',
    }, 'addr');

    for (const desc of ['Commercial Retail (1100)', 'Municipal (1555)', 'Improved Residential Common Area (1554)']) {
      const record = mk(desc);
      expect(record._raw.landUse).toBe(desc); // surfaced where detectCategory reads it
      const profile = buildEnrichedProfile(record, {}, 27.4, -82.4);
      expect(profile.category).toBe('COMMERCIAL');
      expect(profile.isCommercial).toBe(true);
      expect(profile.propertyType).toBe('Commercial');
    }
  });

  test('commercial GIS land-use survives a PAO-wins merge and still routes commercial (codex P1)', () => {
    // GIS says Commercial; PAO has pricing core and wins the merge, so its _raw
    // is the base — preserveCountyGisLandUse must carry the GIS land-use across.
    const gis = buildCadastralRecord({
      county: 'Manatee', parcelId: '1', situsAddress: '500 MAIN ST', situsCity: 'BRADENTON', situsZip: '34205',
      lotSqft: 20000, dorUseCode: '11', landUseDescription: 'Commercial Retail (1100)',
      sourceUrl: 'https://gis.manateepao.gov/x', gisProvider: 'manatee_gis',
    }, 'addr');
    // Stand-in PAO record with pricing core + generic residential _raw.
    const pao = buildCadastralRecord({
      county: 'Manatee', parcelId: '1', situsAddress: '500 MAIN ST', situsCity: 'BRADENTON', situsZip: '34205',
      lotSqft: 20000, livingAreaSqft: 3000, yearBuilt: 2010, dorUseCode: '01',
      sourceUrl: 'https://www.manateepao.gov/x',
    }, 'addr');
    pao.propertyType = 'Single Family';

    const merged = mergePropertyRecords([pao, gis], 'addr');
    preserveCountyGisLandUse(merged, gis);
    expect(String(merged._raw.landUse).toLowerCase()).toContain('commercial');
    const profile = buildEnrichedProfile(merged, {}, 27.4, -82.4);
    expect(profile.category).toBe('COMMERCIAL');
  });

  test('county-assessed pool flag is carried as hasPool (codex P2)', () => {
    const withPool = buildCadastralRecord({
      county: 'Manatee', parcelId: '1', situsAddress: '1 A ST', situsCity: 'BRADENTON', situsZip: '34202',
      lotSqft: 7200, livingAreaSqft: 2000, yearBuilt: 2021, dorUseCode: '01',
      landUseDescription: 'Single Family Residential (1554)', poolFlag: true,
      sourceUrl: 'https://gis.manateepao.gov/x', gisProvider: 'manatee_gis',
    }, 'addr');
    expect(withPool.hasPool).toBe(true);
    expect(withPool._fieldEvidence.hasPool[0].sourceType).toBe('county');

    const noFlag = buildCadastralRecord({
      county: 'Manatee', parcelId: '2', situsAddress: '2 A ST', situsCity: 'BRADENTON', situsZip: '34202',
      lotSqft: 7200, livingAreaSqft: 2000, yearBuilt: 2021, dorUseCode: '01',
      sourceUrl: 'https://services9.arcgis.com/x/Florida_Statewide_Cadastral/FeatureServer/0',
    }, 'addr');
    expect(noFlag.hasPool).toBeNull(); // FDOR has no pool flag → tri-state null
  });

  test('a residential paired villa is NOT misrouted to commercial', () => {
    const record = buildCadastralRecord({
      county: 'Manatee', parcelId: '1', situsAddress: '17742 LUCAYA DR', situsCity: 'BRADENTON', situsZip: '34202',
      lotSqft: 7200, livingAreaSqft: 2450, stories: 2, yearBuilt: 2020, dorUseCode: '01',
      landUseDescription: 'Half Duplex/Paired Villa (1554)',
      sourceUrl: 'https://gis.manateepao.gov/x', gisProvider: 'manatee_gis',
    }, 'addr');
    const profile = buildEnrichedProfile(record, {}, 27.4, -82.4);
    expect(profile.category).toBe('RESIDENTIAL');
    expect(profile.propertyType).toBe('Townhome');
  });

  test('FDOR cadastral parcel (no gisProvider) still labels as cadastral', () => {
    const parcel = {
      county: 'Manatee', parcelId: '123', situsAddress: '1 A ST', situsCity: 'BRADENTON', situsZip: '34205',
      lotSqft: 8000, livingAreaSqft: 1800, yearBuilt: 2005, dorUseCode: '01',
      sourceUrl: 'https://services9.arcgis.com/x/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0',
    };
    const record = buildCadastralRecord(parcel, '1 A St');
    expect(record._source).toBe('cadastral');
    expect(record.propertyType).toBe('Single Family'); // DOR 01 → SFR
    expect(record._fieldEvidence.propertyType[0].sourceType).toBe('cadastral');
  });
});
