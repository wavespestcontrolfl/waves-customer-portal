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
    // The real query orders by application_date DESC; rows with no date keep their given order.
    query.select = jest.fn(async () => [...rows].sort((a, b) => String(b.application_date || '').localeCompare(String(a.application_date || ''))));
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
      { treated_place: 'front', target_pest: 'Gray leaf spot', application_date: '2026-12-02' }, { treated_place: 'front', target_pest: 'Large patch', application_date: '2026-11-02' },
      { treated_place: 'back', target_pest: 'Brown patch', application_date: '2026-12-02' }, { treated_place: 'back', target_pest: 'Dollar spot', application_date: '2026-11-02' },
    ]);
    const found = await areas.loadActiveLargePatch(knex, PROPERTY);
    expect(found.map((area) => area.id)).toEqual(['b']);
    expect(calls).toEqual(expect.arrayContaining([
      ['table', 'property_application_history'], ['where', { property_id: PROPERTY }], ['whereNull', 'retracted_at'], ['whereIn', 'treated_place', ['front', 'back', 'left_side']],
    ]));
    // Only the category is filtered: a newer fungicide application with NO target outranks an older large patch one.
    expect(calls.filter((call) => call[0] === 'whereRaw').map((call) => call[1])).toEqual(["lower(category) = 'fungicide'"]);
  });

  test('the newest application decides even when it names no target: an older large patch row is stale after it', async () => {
    jest.spyOn(areas, 'loadActive').mockResolvedValue([{ id: 'a', place: 'front', type: 'fungus' }, { id: 'b', place: 'back', type: 'fungus' }]);
    const { knex } = ledgerKnex([
      { treated_place: 'front', target_pest: null, application_date: '2026-12-02' }, { treated_place: 'front', target_pest: 'Large patch', application_date: '2026-11-02' },
      { treated_place: 'back', target_pest: '', application_date: '2026-12-02' }, { treated_place: 'back', target_pest: 'Brown patch', application_date: '2026-11-02' },
    ]);
    expect(await areas.loadActiveLargePatch(knex, PROPERTY)).toEqual([]);
  });

  test('asOf dates the evidence: only applications on or before that day are read; without asOf every application counts', async () => {
    jest.spyOn(areas, 'loadActiveAsOf').mockResolvedValue([{ id: 'a', place: 'front', type: 'fungus' }]);
    const dated = ledgerKnex([{ treated_place: 'front', target_pest: 'Large patch' }]);
    expect((await areas.loadActiveLargePatch(dated.knex, PROPERTY, { asOf: '2026-12-10' })).map((area) => area.id)).toEqual(['a']);
    expect(dated.calls).toEqual(expect.arrayContaining([['where', 'application_date', '<=', '2026-12-10']]));
    expect(areas.loadActiveAsOf).toHaveBeenCalledWith(dated.knex, PROPERTY, '2026-12-10');
    const undated = ledgerKnex([{ treated_place: 'front', target_pest: 'Large patch' }]);
    await areas.loadActiveLargePatch(undated.knex, PROPERTY);
    expect(undated.calls.some((call) => call[0] === 'where' && call[1] === 'application_date')).toBe(false);
  });

  test('several fungicides recorded at one place on the SAME day: large patch only when every one of them names it; a mix or a blank is ambiguous and fails closed, whatever the row order', async () => {
    jest.spyOn(areas, 'loadActive').mockResolvedValue([
      { id: 'a', place: 'front', type: 'fungus' }, { id: 'b', place: 'back', type: 'fungus' }, { id: 'c', place: 'left_side', type: 'fungus' }, { id: 'd', place: 'right_side', type: 'fungus' },
    ]);
    const day = '2026-12-02';
    const older = '2026-11-02';
    const rows = [
      // front: Large patch + Brown patch on the day (both large patch): counts.
      { treated_place: 'front', target_pest: 'Large patch', application_date: day }, { treated_place: 'front', target_pest: 'Brown patch', application_date: day },
      // back: Large patch + Dollar spot on the day (a mix): ambiguous, in either order.
      { treated_place: 'back', target_pest: 'Large patch', application_date: day }, { treated_place: 'back', target_pest: 'Dollar spot', application_date: day },
      // left: Gray leaf spot first, then Large patch, the same day: ambiguous.
      { treated_place: 'left_side', target_pest: 'Gray leaf spot', application_date: day }, { treated_place: 'left_side', target_pest: 'Large patch', application_date: day },
      // right: Large patch + a blank target the same day, and an older Large patch row: ambiguous (the older row does not rescue it).
      { treated_place: 'right_side', target_pest: null, application_date: day }, { treated_place: 'right_side', target_pest: 'Large patch', application_date: day },
      { treated_place: 'right_side', target_pest: 'Large patch', application_date: older },
    ];
    expect((await areas.loadActiveLargePatch(ledgerKnex(rows).knex, PROPERTY)).map((area) => area.id)).toEqual(['a']);
    // The same rows in the reverse order give the same answer: no row-order dependence.
    expect((await areas.loadActiveLargePatch(ledgerKnex([...rows].reverse()).knex, PROPERTY)).map((area) => area.id)).toEqual(['a']);
  });

  test('an area with no ledger row is not a large patch (the disease is unknown), and a failed read throws', async () => {
    jest.spyOn(areas, 'loadActive').mockResolvedValue([{ id: 'a', place: 'front', type: 'fungus' }]);
    expect(await areas.loadActiveLargePatch(ledgerKnex([]).knex, PROPERTY)).toEqual([]);
    const failing = { knex: jest.fn(() => { throw Object.assign(new Error('db down'), { code: 'ECONNRESET' }); }) };
    await expect(areas.loadActiveLargePatch(failing.knex, PROPERTY)).rejects.toThrow('db down');
  });
});

describe('loadActiveAsOf', () => {
  const PROPERTY = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  const recorder = (rows) => {
    const calls = [];
    const query = {};
    const nested = () => { const inner = {}; for (const method of ['whereNull', 'orWhereNull', 'orWhere', 'where', 'whereRaw']) inner[method] = jest.fn((...args) => { calls.push(['nested', method, ...(typeof args[0] === 'function' ? ['fn'] : args)]); if (typeof args[0] === 'function') args[0](inner); return inner; }); return inner; };
    for (const method of ['where', 'orderByRaw', 'whereRaw']) {
      query[method] = jest.fn((...args) => { calls.push([method, ...(typeof args[0] === 'function' ? ['fn'] : args)]); if (typeof args[0] === 'function') args[0](nested()); return query; });
    }
    query.select = jest.fn(async () => rows);
    const knex = jest.fn((table) => { calls.push(['table', table]); return query; });
    return { knex, calls };
  };

  test('without asOf it is loadActive (the current state)', async () => {
    jest.spyOn(areas, 'loadActive').mockResolvedValue([{ id: 'a' }]);
    expect(await areas.loadActiveAsOf({}, PROPERTY, null)).toEqual([{ id: 'a' }]);
    expect(areas.loadActive).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });

  test('with asOf it asks for areas first seen and last seen on or before the day, active, or cleared after that ET day (fail closed)', async () => {
    const { knex, calls } = recorder([{ id: 'a', place: 'front', type: 'fungus', last_treated_on: '2026-12-01', last_seen_on: '2026-12-01' }]);
    const found = await areas.loadActiveAsOf(knex, PROPERTY, '2026-12-10');
    expect(found.map((area) => area.id)).toEqual(['a']);
    expect(calls).toEqual(expect.arrayContaining([
      ['table', 'lawn_trouble_areas'], ['where', { property_id: PROPERTY }], ['where', 'first_seen_on', '<=', '2026-12-10'], ['where', 'last_seen_on', '<=', '2026-12-10'],
      ['nested', 'orWhere', 'last_treated_on', '<=', '2026-12-10'],
    ]));
    expect(calls.some((call) => call[0] === 'nested' && String(call[2]).includes("(cleared_at AT TIME ZONE 'America/New_York')::date > ?::date"))).toBe(true);
  });

  test('a malformed property id reads nothing', async () => {
    const { knex } = recorder([]);
    expect(await areas.loadActiveAsOf(knex, 'not-a-uuid', '2026-12-10')).toEqual([]);
    expect(knex).not.toHaveBeenCalled();
  });
});
