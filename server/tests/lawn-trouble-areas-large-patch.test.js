// The large patch evidence a rule asks of a "fungus" trouble area (lawn-trouble-areas isLargePatchTarget / loadActiveLargePatch), used by the
// November nitrogen cut and the December potassium bag. Pure target matching here; the ledger read is tested against real rows in
// lawn-v13-nov-large-patch-n.db.test.js and lawn-v13-dec-large-patch-k.plan.db.test.js. Synthetic data only.
jest.mock('../models/db', () => jest.fn());
const areas = require('../services/lawn-trouble-areas');

describe('isLargePatchTarget', () => {
  test.each([
    'Large patch', 'large patch', 'LARGE PATCH', 'Large-patch', 'large_patch', 'large patch (fungal) activity', 'Brown patch', 'brown_patch', 'Rhizoctonia', 'Rhizoctonia blight',
    'Dollar spot, Large patch',
  ])('%j is a large patch', (target) => {
    expect(areas.isLargePatchTarget(target)).toBe(true);
  });

  test.each([
    'Gray leaf spot', 'Pythium root rot', 'Dollar spot', 'Fairy ring', 'Rust', 'Take-all root rot', 'Southern chinch bugs', 'Fungus', 'Patch', 'Largepatches', '', '  ', null, undefined,
  ])('%j is not', (target) => {
    expect(areas.isLargePatchTarget(target)).toBe(false);
  });
});

describe('loadActiveLargePatch', () => {
  // A knex whose ledger query returns the given rows (newest first, as the real order by does) and records its filters.
  const ledgerKnex = (rows) => {
    const calls = [];
    const query = {};
    for (const method of ['where', 'whereNull', 'whereIn', 'whereRaw', 'orderByRaw']) query[method] = jest.fn((...args) => { calls.push([method, ...args]); return query; });
    query.select = jest.fn(async () => rows);
    const knex = jest.fn((table) => { calls.push(['table', table]); return query; });
    return { knex, calls };
  };
  const PROPERTY = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  afterEach(() => jest.restoreAllMocks());

  test('no active fungus area: no ledger read', async () => {
    jest.spyOn(areas, 'loadActive').mockResolvedValue([{ id: 'a', place: 'front', type: 'take_all' }, { id: 'b', place: 'back', type: 'weeds' }]);
    const { knex } = ledgerKnex([]);
    expect(await areas.loadActiveLargePatch(knex, PROPERTY)).toEqual([]);
    expect(knex).not.toHaveBeenCalled();
  });

  test('the newest named target at each place decides; the ledger is read for fungicides, not retracted, with a target, for the areas places only', async () => {
    jest.spyOn(areas, 'loadActive').mockResolvedValue([
      { id: 'a', place: 'front', type: 'fungus' }, { id: 'b', place: 'back', type: 'fungus' }, { id: 'c', place: 'left_side', type: 'fungus' }, { id: 'd', place: 'right_side', type: 'take_all' },
    ]);
    const { knex, calls } = ledgerKnex([
      { treated_place: 'front', target_pest: 'Gray leaf spot' }, { treated_place: 'front', target_pest: 'Large patch' },
      { treated_place: 'back', target_pest: 'Brown patch' }, { treated_place: 'back', target_pest: 'Dollar spot' },
    ]);
    const found = await areas.loadActiveLargePatch(knex, PROPERTY);
    expect(found.map((area) => area.id)).toEqual(['b']);
    expect(calls).toEqual(expect.arrayContaining([
      ['table', 'property_application_history'], ['where', { property_id: PROPERTY }], ['whereNull', 'retracted_at'], ['whereIn', 'treated_place', ['front', 'back', 'left_side']],
    ]));
    expect(calls.filter((call) => call[0] === 'whereRaw').map((call) => call[1])).toEqual(["lower(category) = 'fungicide'", "btrim(coalesce(target_pest, '')) <> ''"]);
  });

  test('an area with no ledger row is not a large patch (the disease is unknown), and a failed read throws', async () => {
    jest.spyOn(areas, 'loadActive').mockResolvedValue([{ id: 'a', place: 'front', type: 'fungus' }]);
    expect(await areas.loadActiveLargePatch(ledgerKnex([]).knex, PROPERTY)).toEqual([]);
    const failing = { knex: jest.fn(() => { throw Object.assign(new Error('db down'), { code: 'ECONNRESET' }); }) };
    await expect(areas.loadActiveLargePatch(failing.knex, PROPERTY)).rejects.toThrow('db down');
  });
});
