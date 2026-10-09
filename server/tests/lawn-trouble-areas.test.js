// Places and trouble areas of the lawn Fast Complete sheet (GATE_LAWN_TROUBLE_AREAS, owner 2026-10-09), without a
// database: the gate, the closed lists, the type of an area, the /complete preflight of the places and the context block's
// failure handling. The SQL (per-place limits, the store, the ledger) is proven in lawn-trouble-areas.db.test.js and
// complete-scheduled-service-lawn-places-postgres.test.js. Synthetic data.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/application-limits', () => ({ checkLimits: jest.fn() }));
jest.mock('../services/waveguard-plan-engine', () => ({ v13VisitLimits: jest.fn() }));
jest.mock('../services/complete-scheduled-service', () => ({
  normalizeServiceReportApplicationMethod: (value) => String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_'),
}));

const limits = require('../services/application-limits');
const engine = require('../services/waveguard-plan-engine');
const areas = require('../services/lawn-trouble-areas');
const { lawnTroubleAreasLive } = require('../config/feature-gates');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P_CEL = uuid(1);
const svc = { id: uuid(9), customer_id: 'cust-1', property_id: uuid(8), scheduled_date: '2026-10-05' };
const GATES = ['GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_V13'];
const on = () => { for (const name of GATES) process.env[name] = 'true'; };

beforeEach(() => {
  jest.clearAllMocks();
  limits.checkLimits.mockResolvedValue({ allowed: true, blocks: [], warnings: [] });
  on();
});
afterEach(() => { for (const name of GATES) delete process.env[name]; });

describe('lawnTroubleAreasLive: strict, and only with the spot rules and the v13 program', () => {
  const set = (own, spot, v13) => {
    for (const [name, value] of [['GATE_LAWN_TROUBLE_AREAS', own], ['GATE_LAWN_SPOT_RULES', spot], ['GATE_LAWN_V13', v13]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  };
  test.each([
    ['true', 'true', 'true', true],
    ['true', 'true', undefined, false],
    ['true', undefined, 'true', false],
    ['true', undefined, undefined, false],
    [undefined, 'true', 'true', false],
    ['1', 'true', 'true', false],
    ['TRUE', 'true', 'true', false],
    ['true', 'true', '1', false],
  ])('own=%s spot rules=%s v13=%s is live: %s', (own, spot, v13, live) => {
    set(own, spot, v13);
    expect(lawnTroubleAreasLive()).toBe(live);
  });
});

describe('the closed lists', () => {
  test('four places, the sheet draws no place of its own', () => {
    expect(areas.PLACES.map((p) => p.id)).toEqual(['front', 'back', 'left_side', 'right_side']);
    expect(areas.placeChoices()).toEqual([{ id: 'front', label: 'Front' }, { id: 'back', label: 'Back' }, { id: 'left_side', label: 'Left side' }, { id: 'right_side', label: 'Right side' }]);
    expect(areas.isPlace('back')).toBe(true);
    for (const bad of ['roof', '', null, undefined, 3, 'Back']) expect(areas.isPlace(bad)).toBe(false);
  });

  test('the six types, the same as the table\'s CHECK', () => {
    expect(areas.TYPE_IDS).toEqual(['weeds', 'fungus', 'take_all', 'chinch', 'other_insect', 'dry_spot']);
    const migration = require('../models/migrations/20261009110000_lawn_trouble_areas');
    expect(migration.TYPES).toEqual(areas.TYPE_IDS);
    expect(migration.PLACES).toEqual(areas.PLACE_IDS);
    expect(migration.SOURCES).toEqual([...areas.SOURCES]);
  });
});

describe('troubleTypeFor: the sheet\'s hint when it is on the list, else the catalog category', () => {
  test.each([
    [{ category: 'herbicide' }, 'weeds'],
    [{ category: 'Fungicide' }, 'fungus'],
    [{ category: 'insecticide' }, 'other_insect'],
    [{ category: 'insecticide', hint: 'chinch' }, 'chinch'],
    [{ category: 'fungicide', hint: 'take_all' }, 'take_all'],
    [{ category: 'adjuvant', hint: 'weeds' }, 'weeds'],
    [{ category: 'insecticide', hint: 'moss' }, 'other_insect'],
    [{ category: 'adjuvant' }, null],
    [{ category: 'fertilizer' }, null],
    [{}, null],
  ])('%j is %s', (input, expected) => {
    expect(areas.troubleTypeFor(input)).toBe(expected);
  });
});

describe('what a completion stores', () => {
  test('storedPlace: a closed-list place, on a spot row only', () => {
    expect(areas.storedPlace('spot_treatment', 'front')).toBe('front');
    expect(areas.storedPlace('spot_treatment', 'roof')).toBeNull();
    expect(areas.storedPlace('spot_treatment', null)).toBeNull();
    expect(areas.storedPlace('broadcast_spray', 'front')).toBeNull();
  });

  test('areaRowsOf: only spot rows with a place that resolve to a type; the hints come from the request row', () => {
    const catalog = new Map([[P_CEL, { category: 'herbicide' }], [uuid(2), { category: 'insecticide' }], [uuid(3), { category: 'fertilizer' }]]);
    const inserted = [
      { product_id: P_CEL, treated_place: 'front', application_method: 'spot_treatment' },
      { product_id: uuid(2), treated_place: 'back', application_method: 'spot_treatment' },
      { product_id: uuid(3), treated_place: 'back', application_method: 'spot_treatment' },
      { product_id: P_CEL, treated_place: null, application_method: 'spot_treatment' },
      { product_id: P_CEL, treated_place: 'front', application_method: 'broadcast_spray' },
    ];
    const request = [{ productId: uuid(2).toUpperCase(), troubleType: 'chinch', troubleSource: 'guide_card' }, { productId: P_CEL }];
    expect(areas.areaRowsOf({ requestRows: request, inserted, catalog })).toEqual([
      { place: 'front', type: 'weeds', source: undefined },
      { place: 'back', type: 'chinch', source: 'guide_card' },
    ]);
  });
});

describe('blockedMap: the products a TYPED limit closes at a place', () => {
  const CAP = [{ type: 'annual_max_apps', message: 'Celsius: 2/2 — LIMIT REACHED.' }];
  const none = new Map();
  test('lists the closed places by product; an open place, an unreadable limit and a product open everywhere are not listed', () => {
    const wide = new Map([[P_CEL, CAP], [uuid(2), CAP], [uuid(3), [{ message: 'could not be read' }]]]);
    const byPlace = {
      front: new Map([[P_CEL, CAP], [uuid(2), CAP], [uuid(3), [{ message: 'could not be read' }]]]),
      back: none, left_side: none, right_side: new Map([[P_CEL, [{ type: 'min_interval_days', message: 'wait' }]]]),
    };
    expect(areas.blockedMap({ wide, byPlace })).toEqual({
      [P_CEL]: { front: 'Celsius: 2/2 — LIMIT REACHED.', right_side: 'wait' },
      [uuid(2)]: { front: 'Celsius: 2/2 — LIMIT REACHED.' },
    });
  });
});

describe('cappedByPlace: the plan\'s own limit reader, once for the lawn and again only for what is capped', () => {
  const CAP = [{ type: 'annual_max_apps', message: 'x' }];
  const products = [{ id: P_CEL, name: 'Celsius WG' }, { id: uuid(2), name: 'Other' }];
  test('nothing capped: one read; every place is the lawn-wide answer', async () => {
    engine.v13VisitLimits.mockResolvedValue({ capped: new Map(), warnings: [], blocks: [] });
    const result = await areas.cappedByPlace({ knex: {}, svc, products, rows: new Map() });
    expect(engine.v13VisitLimits).toHaveBeenCalledTimes(1);
    expect(Object.keys(result.byPlace)).toEqual(areas.PLACE_IDS);
  });

  test('something capped: each place re-reads only the capped products, with the place as the sixth argument', async () => {
    engine.v13VisitLimits.mockImplementation(async (knex, service, items, rows, targets, options) => ({
      capped: new Map(!options?.place || options.place === 'front' ? [[P_CEL, CAP]] : []), warnings: [], blocks: [],
    }));
    const result = await areas.cappedByPlace({ knex: {}, svc, products: [...products, products[0]], rows: new Map() });
    const calls = engine.v13VisitLimits.mock.calls;
    expect(calls).toHaveLength(5);
    expect(calls[0][2].map((line) => line.product.id)).toEqual([P_CEL, uuid(2)]);
    for (const call of calls.slice(1)) expect(call[2].map((line) => line.product.id)).toEqual([P_CEL]);
    expect(calls.slice(1).map((call) => call[5])).toEqual(areas.PLACE_IDS.map((place) => ({ place })));
    expect(areas.blockedMap(result)).toEqual({ [P_CEL]: { front: 'x' } });
  });
});

describe('preflightPlaces: the /complete check of the places', () => {
  const spot = (extra = {}) => ({ productId: P_CEL, name: 'Celsius WG', applicationMethod: 'spot_treatment', ...extra });
  const run = (products) => areas.preflightPlaces({ knex: {}, svc, products });

  test('gate off: nothing is looked at', async () => {
    delete process.env.GATE_LAWN_TROUBLE_AREAS;
    expect(await run([spot()])).toBeNull();
    expect(limits.checkLimits).not.toHaveBeenCalled();
  });

  test('a spot row needs a place on the list', async () => {
    expect(await run([spot()])).toMatchObject({ status: 400, payload: { code: 'lawn_place_required', error: 'Pick where on the lawn Celsius WG went.' } });
    expect(await run([spot({ areaPlace: '  ' })])).toMatchObject({ status: 400, payload: { code: 'lawn_place_required' } });
    expect(await run([spot({ areaPlace: 'roof' })])).toMatchObject({ status: 400, payload: { code: 'lawn_place_invalid' } });
    expect(limits.checkLimits).not.toHaveBeenCalled();
  });

  test('a whole-lawn row is not judged by place, however it is spelled; a row that is not an object is ignored', async () => {
    expect(await run([spot({ applicationMethod: 'Broadcast Spray' }), spot({ applicationMethod: undefined }), null, 'x'])).toBeNull();
    expect(limits.checkLimits).not.toHaveBeenCalled();
  });

  test('the limit reader is asked at the place, as a proposal on the visit\'s date, the visit\'s own rows left out, with the row\'s own dose', async () => {
    expect(await run([spot({ areaPlace: 'back', rate: 0.147, rateUnit: 'oz' })])).toBeNull();
    expect(limits.checkLimits).toHaveBeenCalledTimes(1);
    const [customerId, productId, day, knex, options] = limits.checkLimits.mock.calls[0];
    expect([customerId, productId, knex]).toEqual(['cust-1', P_CEL, {}]);
    expect(day.getUTCFullYear()).toBe(2026);
    expect(options).toEqual({ propertyId: svc.property_id, place: 'back', proposal: true, proposed: { ratePer1000: 0.147, unit: 'oz' }, excludeScheduledServiceId: svc.id });
  });

  test('a rate the sheet spelled with an underscore is read as the cap reads units; no rate sends no dose (the program\'s own dose counts)', async () => {
    await run([spot({ areaPlace: 'back', rate: 1, rateUnit: 'fl_oz' }), spot({ productId: uuid(2), areaPlace: 'back' })]);
    expect(limits.checkLimits.mock.calls[0][4].proposed).toEqual({ ratePer1000: 1, unit: 'fl oz' });
    expect(limits.checkLimits.mock.calls[1][4].proposed).toBeUndefined();
  });

  test.each(['annual_max_apps', 'min_interval_days', 'annual_max_rate'])('a %s block at the place refuses with the limit\'s own words', async (type) => {
    limits.checkLimits.mockResolvedValue({ allowed: false, blocks: [{ type, message: 'Celsius WG: LIMIT REACHED.' }], warnings: [] });
    expect(await run([spot({ areaPlace: 'front' })])).toEqual({
      status: 400,
      payload: { error: 'Celsius WG: LIMIT REACHED. Choose another place, or take it off the sheet.', code: 'lawn_place_limit', productId: P_CEL, place: 'front', limitType: type },
    });
  });

  test('a limit that is not about the product\'s own applications (MOA rotation) does not refuse here', async () => {
    limits.checkLimits.mockResolvedValue({ allowed: false, blocks: [{ type: 'moa_rotation_max', message: 'rotate' }], warnings: [] });
    expect(await run([spot({ areaPlace: 'front' })])).toBeNull();
  });

  test('a limit read that fails refuses nothing (the existing "unknown": recorded and flagged), and the next row is still judged', async () => {
    limits.checkLimits.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce({ allowed: false, blocks: [{ type: 'annual_max_apps', message: 'closed' }], warnings: [] });
    expect(await run([spot({ areaPlace: 'front' }), spot({ productId: uuid(2), areaPlace: 'front' })])).toMatchObject({ status: 400, payload: { productId: uuid(2) } });
  });

  test('the same product at the same place is read once', async () => {
    await run([spot({ areaPlace: 'front' }), spot({ areaPlace: 'front' })]);
    expect(limits.checkLimits).toHaveBeenCalledTimes(1);
  });
});

describe('buildContextBlock', () => {
  const failures = () => new Set();
  test('gate off: nothing', async () => {
    delete process.env.GATE_LAWN_TROUBLE_AREAS;
    expect(await areas.buildContextBlock({ knex: jest.fn(), svc, products: [], rows: new Map(), readFailures: failures() })).toEqual({});
  });

  test('a failed read of the limits is named and sends no closed place (the sheet\'s own unreadable handling stands); the places still show', async () => {
    engine.v13VisitLimits.mockRejectedValue(new Error('db down'));
    const knex = Object.assign(jest.fn(() => { const q = {}; for (const m of ['where', 'orderByRaw']) q[m] = () => q; q.select = async () => []; return q; }), {});
    const readFailures = failures();
    const { troubleAreas } = await areas.buildContextBlock({ knex, svc, products: [{ id: P_CEL, name: 'x' }], rows: new Map(), readFailures });
    expect(troubleAreas).toMatchObject({ v: 1, known: [], knownUnavailable: false, blocked: {} });
    expect(troubleAreas.places).toHaveLength(4);
    expect([...readFailures]).toEqual(['trouble_area_limits']);
  });
});
