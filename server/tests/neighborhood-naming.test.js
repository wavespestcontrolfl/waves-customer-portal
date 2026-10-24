// Name handling for GATE_NEIGHBORHOOD_NAMING: Sarasota plat numbers → names, and
// the customer's own words → a community name. All names are synthetic or
// public plat names; nothing here reaches the network (fetch is stubbed).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { callerCommunityName } = require('../services/neighborhood-naming');
const { withPlatName } = require('../services/neighborhood-access');
const { lookupSarasotaPlatNames } = require('../services/property-lookup/county-parcel-gis');
const gates = require('../config/feature-gates');

describe('callerCommunityName', () => {
  test.each([
    ['Willow Hollow', 'Willow Hollow'],
    ['willow hollow subdivision', 'Willow Hollow'],
    ['the Willow Hollow community', 'Willow Hollow'],
    ["St. Andrew's Preserve", 'St Andrews Preserve'],
    ['Heron Pointe at Cedar Ranch Phase 2', 'Heron Pointe at Cedar Ranch'],
    ['Oakwood Glen HOA', 'Oakwood Glen'],
  ])('%s → %s', (words, name) => {
    expect(callerCommunityName(words, 'Bradenton')).toBe(name);
  });

  // A street, a town, a shrug or a paragraph is never a community.
  test.each([
    '', null, 'none', 'not sure', "don't know", 'N/A', 'Not in a subdivision', '1234',
    '123 Main Street', 'Lakewood Ranch', 'Parrish', 'Manatee County', 'ab',
    'it is that big neighborhood off the main road by the school and the church',
  ])('%p is no community', (words) => {
    expect(callerCommunityName(words, 'Bradenton')).toBeNull();
  });

  test("the home's own city is not a community either", () => {
    expect(callerCommunityName('Samplevale', 'Samplevale')).toBeNull();
    expect(callerCommunityName('Samplevale Reserve', 'Samplevale')).toBe('Samplevale Reserve');
  });

  test('a caller phrase folds to the same community name as the county roll', () => {
    const { neighborhoodNameFromSubdivision } = require('../services/neighborhood-access');
    expect(callerCommunityName('Wild Blue at Waterside phase 2a', 'Venice'))
      .toBe(neighborhoodNameFromSubdivision('WILD BLUE AT WATERSIDE PHASE 2A'));
  });
});

describe('withPlatName', () => {
  const parcel = (subdivision, county = 'Sarasota') => ({ county, subdivision, situsAddress: '1 SAMPLE WAY' });

  test('a plat number takes its plat name; the roll subdivision stays the number', async () => {
    const platLookup = jest.fn(async () => ['WILD BLUE AT WATERSIDE PHASE 2A']);
    const out = await withPlatName(parcel('3491'), platLookup);
    expect(platLookup).toHaveBeenCalledWith('3491');
    expect(out).toMatchObject({ subdivision: '3491', platName: 'WILD BLUE AT WATERSIDE PHASE 2A' });
  });

  test('every phase row under one number names one community', async () => {
    const out = await withPlatName(parcel('3072'), async () => ['GRAN PARADISO PHASE 1', 'GRAN PARADISO PHASE 2-F', 'GRAN PARADISO PHASE 4E']);
    expect(out.platName).toBe('GRAN PARADISO PHASE 1');
  });

  test.each([
    ['two different communities under one number', ['OAKS 2 PHASE 1', 'PALMER LAKE A REPLAT']],
    ['no row on the plat layer', []],
  ])('%s names nothing', async (_label, names) => {
    const out = await withPlatName(parcel('3072'), async () => names);
    expect(out.platName).toBeUndefined();
  });

  test.each([
    ['a name already', parcel('OAKWOOD GLEN PH II PB60/1')],
    ['the zero plat', parcel('0000')],
    ['NOT IN SUBDIVISION', parcel('NOT IN SUBDIVISION 0/0')],
    ['another county', parcel('3491', 'Manatee')],
  ])('%s never calls the plat layer', async (_label, p) => {
    const platLookup = jest.fn();
    expect(await withPlatName(p, platLookup)).toBe(p);
    expect(platLookup).not.toHaveBeenCalled();
  });

  test('a plat layer failure throws, so no caller reads it as "no name"', async () => {
    await expect(withPlatName(parcel('3491'), async () => { throw new Error('down'); })).rejects.toThrow('down');
  });
});

describe('lookupSarasotaPlatNames', () => {
  const realFetch = global.fetch;
  const answer = (features, ok = true) => jest.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => ({ features }) }));
  afterEach(() => { global.fetch = realFetch; });

  test('asks the plat layer by number, returns sorted unique names, and remembers a hit', async () => {
    global.fetch = answer([{ attributes: { sub_name: 'B PHASE 2' } }, { attributes: { sub_name: 'B PHASE 1' } }, { attributes: { sub_name: 'B PHASE 2' } }]);
    expect(await lookupSarasotaPlatNames('4001')).toEqual(['B PHASE 1', 'B PHASE 2']);
    expect(String(global.fetch.mock.calls[0][0])).toContain('where=max_sub_id%3D%274001%27');
    await lookupSarasotaPlatNames('4001');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a number with no row answers [] and is asked again next time', async () => {
    global.fetch = answer([]);
    expect(await lookupSarasotaPlatNames('4002')).toEqual([]);
    await lookupSarasotaPlatNames('4002');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('an HTTP error or a layer error throws', async () => {
    global.fetch = answer([], false);
    await expect(lookupSarasotaPlatNames('4003')).rejects.toThrow('503');
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ error: { message: 'boom' } }) }));
    await expect(lookupSarasotaPlatNames('4003')).rejects.toThrow('boom');
  });

  test('anything but digits never reaches the query string', async () => {
    global.fetch = answer([]);
    expect(await lookupSarasotaPlatNames("1' OR '1'='1")).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('GATE_NEIGHBORHOOD_NAMING', () => {
  const saved = { a: process.env.GATE_NEIGHBORHOOD_ACCESS, n: process.env.GATE_NEIGHBORHOOD_NAMING };
  afterEach(() => {
    for (const [k, v] of [['GATE_NEIGHBORHOOD_ACCESS', saved.a], ['GATE_NEIGHBORHOOD_NAMING', saved.n]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test.each([
    ['true', 'true', true],
    ['true', undefined, false],
    ['true', 'yes', false],
    [undefined, 'true', false],
  ])('access=%s naming=%s → %s', (access, naming, live) => {
    for (const [k, v] of [['GATE_NEIGHBORHOOD_ACCESS', access], ['GATE_NEIGHBORHOOD_NAMING', naming]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    expect(gates.neighborhoodNamingLive()).toBe(live);
  });
});
