const { buildEnrichedProfile, _private: routePrivate } = require('../routes/property-lookup-v2');
const { _private } = require('../services/property-lookup/ai-property-lookup');

const { normalizeCountyRoof, roofStyleHintFromWords } = _private;
const { buildSatelliteVisionPrompt, normalizeSatelliteAnalysis, normalizeRoofTileStyle } = routePrivate;

const manateeBuildings = (material, type) => ({
  cols: ['Type', 'Bldg', 'Classification', 'Yrblt', 'Effyr', 'Stories', 'UnRoof', 'LivBus', 'Rooms', 'Const/ExtWall', 'RoofMaterial', 'RoofType']
    .map((title) => ({ title })),
  rows: [['RES', '1', 'RESIDENTIAL', '2017', '2017', 1, '2943', '2310', '4/2/0', 'MASONRY/STUCCO', material, type]],
});
const manateeLand = {
  cols: ['Land', 'Use', 'Width', 'Frontage', 'Depth', 'Acreage', 'SqFootage', 'Units', 'Influences'].map((title) => ({ title })),
  rows: [['1', 'UNIT', '70', '70', '120', '0.1928', '8,400', '1.00', '']],
};
const manatee = (material, type) => _private.parseManateePaoRecord({
  address: '100 Test Ave, Bradenton, FL 34211',
  search: { parcelId: '1', situsAddress: '100 TEST AVE', city: 'BRADENTON' },
  land: manateeLand,
  buildings: manateeBuildings(material, type),
});

const sarasotaDetail = `
  <li class="med bold">Situs Address:</li><li>200 TEST CIR VENICE, FL, 34293</li>
  <li><strong>Land Area:</strong> 3,839 Sq.Ft.</li>
  <li><strong>Property Use:</strong> 0100 - Single Family Detached</li>
  <table id="Buildings" class="grid">
    <thead><tr><th>Situs - click address for building details</th><th>Bldg #</th><th>Beds</th><th>Baths</th><th>Half Baths</th><th>Year Built</th><th>Eff Yr Built</th><th>Gross Area</th><th>Living Area</th><th>Stories</th></tr></thead>
    <tbody><tr><td><a href="/propertysearch/Building/Show?strap=1&num=1">200 TEST CIR VENICE, FL, 34293</a></td><td>1</td><td>3</td><td>2</td><td>1</td><td>2015</td><td>2015</td><td>2,490</td><td>1,850</td><td>2</td></tr></tbody>
  </table>`;
const sarasotaBuilding = (material, structure) => `
  <ul class="bullet">
    <li>Building Type: Single Family Detached</li>
    <li>Finished Area S.F: 1,850</li>
    <li>Year Built: 2015</li>
    <li>Roof Material:<span>${material} <br /></span></li>
    <li>Roof Structure:<span>${structure} <br /></span></li>
    <li>Exterior Walls:<span>Stucco <br /></span></li>
  </ul>`;
const sarasota = (material, structure) => _private.parseSarasotaPaoRecord({
  address: '200 Test Cir, Venice, FL 34293',
  search: { parcelId: '1', situsAddress: '200 TEST CIR VENICE, FL, 34293', city: 'VENICE' },
  detailHtml: sarasotaDetail,
  buildingDetailHtml: sarasotaBuilding(material, structure),
});

const charlotteDetail = (roofing) => `
  <div><strong>Property Address:&nbsp;</strong></div><div>300 TEST ST<br /></div>
  <div><strong>Property City & Zip:&nbsp;</strong></div><div>PORT CHARLOTTE 33954&nbsp;</div>
  <div><strong>Current Use:</strong></div><div>SINGLE FAMILY&nbsp;</div>
  <table class="prctable"><caption class="blockcaption">Building Information</caption>
    <tr><th>Building Number</th><th>Description</th><th>Quality</th><th>Building Use</th><th>Year Built</th><th>Year Cond</th><th>Floors</th><th>Rooms</th><th>Bedrooms</th><th>Plumbing Fixtures</th><th>Area</th><th>A/C Area</th><th>Total Area</th></tr>
    <tr><td>1</td><td>SINGLE FAMILY RES</td><td>2.5</td><td>0100</td><td>1983</td><td>1983</td><td>2</td><td>0</td><td>6</td><td>11</td><td>2544</td><td>2544</td><td>3552</td></tr>
  </table>
  <table class="prctable"><caption class="blockcaption">Building Component Information</caption>
    <tr><th>Bld #</th><th>Code</th><th>Description</th><th>Category</th><th>Area</th><th>Percent</th><th>Year Built</th><th>Year Cond</th><th>Type</th></tr>
    <tr><td>1</td><td>109</td><td>Frame, Stucco</td><td>Exterior Walls</td><td>0</td><td>100</td><td>1983</td><td>1983</td><td>Construction Component</td></tr>
    <tr><td>1</td><td>208</td><td>${roofing}</td><td>Roofing</td><td>0</td><td>100</td><td>1983</td><td>1983</td><td>Construction Component</td></tr>
  </table>`;
const charlotte = (roofing) => _private.parseCharlottePaoRecord({
  address: '300 Test St, Port Charlotte, FL 33954',
  search: { parcelId: '1', situsAddress: '300 TEST ST', city: 'Port Charlotte', zipCode: '33954' },
  detailHtml: charlotteDetail(roofing),
  ownership: null,
});

describe('county roof words kept beside the collapsed roofType', () => {
  it('Manatee keeps RoofMaterial and RoofType and still collapses tile to TILE', () => {
    const parsed = manatee('TILE BARREL', 'HIP AND/OR GABLE');
    expect(parsed.roofType).toBe('TILE');
    expect(parsed.countyRoofRaw).toEqual({ material: 'TILE BARREL', structure: 'HIP AND/OR GABLE', source: 'manatee' });
    expect(parsed.roofStyleHint).toBe('barrel_tile');
  });

  it('Sarasota keeps Roof Material and Roof Structure', () => {
    const parsed = sarasota('Concrete flat tile', 'Hip');
    expect(parsed.roofType).toBe('TILE');
    expect(parsed.countyRoofRaw).toEqual({ material: 'Concrete flat tile', structure: 'Hip', source: 'sarasota' });
    expect(parsed.roofStyleHint).toBe('flat_tile');
  });

  it('Charlotte keeps the Roofing component description', () => {
    const parsed = charlotte('Clay Tile');
    expect(parsed.roofType).toBe('TILE');
    expect(parsed.countyRoofRaw).toEqual({ material: 'Clay Tile', structure: null, source: 'charlotte' });
    expect(parsed.roofStyleHint).toBe('clay_tile');
  });

  it('a shingle roof keeps its words with no style hint, and old roofType values', () => {
    expect(manatee('SHINGLES COMP', 'HIP AND/OR GABLE')).toMatchObject({ roofType: 'SHINGLE', roofStyleHint: null });
    expect(sarasota('Asphalt or fbrgls shingles', 'Gable')).toMatchObject({
      roofType: 'SHINGLE',
      countyRoofRaw: { source: 'sarasota' },
      roofStyleHint: null,
    });
    expect(charlotte('Composition Shingle')).toMatchObject({ roofType: 'SHINGLE', roofStyleHint: null });
  });

  it('survives shaping and the merge so the profile can read it', () => {
    const parsed = sarasota('Spanish tile', 'Gable');
    const record = _private.shapeAsPropertyRecord(parsed, '200 Test Cir, Venice, FL 34293', 'sarasota_pao');
    const merged = _private.mergePropertyRecords([record], '200 Test Cir, Venice, FL 34293');
    expect(merged.countyRoofRaw).toEqual(parsed.countyRoofRaw);
    expect(merged.roofStyleHint).toBe('barrel_tile');
    expect(merged.roofType).toBe('TILE');
  });
});

describe('roofStyleHintFromWords', () => {
  it.each([
    [['TILE BARREL'], 'barrel_tile'],
    [['S-TILE'], 'barrel_tile'],
    [['Concrete S Tile'], 'barrel_tile'],
    [['Spanish Tile'], 'barrel_tile'],
    [['Mission tile'], 'barrel_tile'],
    [['CLAY BARREL'], 'barrel_tile'],
    [['Flat Tile'], 'flat_tile'],
    [['CONCRETE FLAT'], 'flat_tile'],
    [['Clay Tile'], 'clay_tile'],
    [['TILE CLAY'], 'clay_tile'],
    [['CONCRETE TILE'], null],
    [['SHINGLES COMP', 'HIP AND/OR GABLE'], null],
    [['BUILT-UP', 'FLAT'], null],
    // Each field is read alone: a concrete material on a flat structure is not flat tile.
    [['CONCRETE', 'FLAT'], null],
    [[null, undefined], null],
  ])('%j -> %s', (words, expected) => {
    expect(roofStyleHintFromWords(...words)).toBe(expected);
  });
});

describe('normalizeCountyRoof is unchanged', () => {
  it.each([
    ['TILE CONCRETE', 'TILE'],
    ['clay', 'TILE'],
    ['Barrel tile', 'TILE'],
    ['SHINGLES COMP HIP AND/OR GABLE', 'SHINGLE'],
    ['Asphalt or fbrgls shingles Gable', 'SHINGLE'],
    ['METAL', 'METAL'],
    ['BUILT-UP FLAT', 'FLAT'],
    ['  Thatch  ', 'Thatch'],
    ['', null],
    [null, null],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeCountyRoof(input)).toBe(expected);
  });
});

describe('satellite roofTileStyle', () => {
  it('prompt keeps the roofMaterial enum, adds one tile-only field, and stays one prompt', () => {
    const prompt = buildSatelliteVisionPrompt('1 Test St', null);
    expect(prompt).toContain('"roofMaterial": "TILE" | "SHINGLE" | "METAL" | "FLAT" | "UNKNOWN"');
    expect(prompt).toContain('"roofTileStyle": "BARREL" | "FLAT" | "UNKNOWN"');
    expect(prompt).toMatch(/ONLY when roofMaterial is TILE/);
    expect(prompt.match(/roofTileStyle/g)).toHaveLength(1);
  });

  it('validates the value on parse; a missing answer stays missing', () => {
    expect(normalizeSatelliteAnalysis({ roofTileStyle: 'barrel' }).roofTileStyle).toBe('BARREL');
    expect(normalizeSatelliteAnalysis({ roofTileStyle: ' FLAT ' }).roofTileStyle).toBe('FLAT');
    expect(normalizeSatelliteAnalysis({ roofTileStyle: 'SPANISH' }).roofTileStyle).toBe('UNKNOWN');
    expect(normalizeSatelliteAnalysis({ roofTileStyle: 7 }).roofTileStyle).toBe('UNKNOWN');
    expect(normalizeSatelliteAnalysis({ roofTileStyle: '' }).roofTileStyle).toBe('UNKNOWN');
    expect('roofTileStyle' in normalizeSatelliteAnalysis({ roofMaterial: 'SHINGLE' })).toBe(false);
    expect(normalizeRoofTileStyle(undefined)).toBe('UNKNOWN');
  });
});

describe('lookup profile carries the roof reads', () => {
  const raw = { material: 'TILE BARREL', structure: 'HIP', source: 'manatee' };

  it('exposes the county words, the hint and the photo style without changing roofType', () => {
    const enriched = buildEnrichedProfile(
      { roofType: 'TILE', countyRoofRaw: raw, roofStyleHint: 'barrel_tile' },
      { roofMaterial: 'TILE', roofTileStyle: 'BARREL', confidenceScore: 80 },
      27.44, -82.39,
    );
    expect(enriched.roofType).toBe('TILE');
    expect(enriched.countyRoofRaw).toEqual(raw);
    expect(enriched.roofStyleHint).toBe('barrel_tile');
    expect(enriched.roofTileStyle).toBe('BARREL');
  });

  it('is null when nothing was read, and ignores a style read beside a non-tile roof', () => {
    const none = buildEnrichedProfile({ roofType: 'SHINGLE' }, { roofMaterial: 'SHINGLE', confidenceScore: 80 }, 27.44, -82.39);
    expect(none).toMatchObject({ roofType: 'SHINGLE', countyRoofRaw: null, roofStyleHint: null, roofTileStyle: null });
    const stray = buildEnrichedProfile({}, { roofMaterial: 'SHINGLE', roofTileStyle: 'FLAT', confidenceScore: 80 }, 27.44, -82.39);
    expect(stray.roofTileStyle).toBeNull();
  });
});

describe('Charlotte roof words follow the primary building', () => {
  const rows = [
    { 'Bld #': '1', Category: 'Roofing', Description: 'Composition Shingle' },
    { 'Bld #': '2', Category: 'Roofing', Description: 'Clay Barrel Tile' },
  ];
  it('reads the Roofing row whose Bld # matches the primary Building Number', () => {
    expect(_private.findCharlottePrimaryRoofing(rows, { 'Building Number': '2' })).toBe('Clay Barrel Tile');
    expect(_private.findCharlottePrimaryRoofing(rows, { 'Building Number': '1' })).toBe('Composition Shingle');
  });
  it('falls back to the parcel\'s first Roofing row when no row names the building', () => {
    expect(_private.findCharlottePrimaryRoofing(rows, { 'Building Number': '7' })).toBe('Composition Shingle');
    expect(_private.findCharlottePrimaryRoofing(rows, {})).toBe('Composition Shingle');
  });
});
