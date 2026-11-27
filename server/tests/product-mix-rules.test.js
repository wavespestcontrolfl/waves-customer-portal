/**
 * services/product-mix-rules.js without a database: checkMix's precedence (pair rule, then group rules, then the
 * catalog's free text, else unknown), order independence, inactive rules, unknown ids, and the write validation.
 * The same reads run on real Postgres in product-mix-rules-postgres.test.js (CI server-db job).
 */
const mockTables = { products_catalog: [], product_mix_rules: [] };

// A small query builder over mockTables: where (object or column/value), whereIn, andWhere(fn) with orWhereIn
// inside, select, then. Enough for checkMix's two reads.
function mockQuery(table) {
  const filters = [];
  const q = {
    where(a, b) { filters.push(typeof a === 'object' ? (r) => Object.entries(a).every(([k, v]) => r[k] === v) : (r) => r[a] === b); return q; },
    whereIn(col, values) { filters.push((r) => values.includes(r[col])); return q; },
    andWhere(fn) {
      const ors = [];
      const sub = {
        whereIn(col, values) { ors.push((r) => values.includes(r[col])); return sub; },
        orWhereIn(col, values) { ors.push((r) => values.includes(r[col])); return sub; },
      };
      fn(sub);
      filters.push((r) => ors.some((f) => f(r)));
      return q;
    },
    select() { return q; },
    then(resolve, reject) { return Promise.resolve(mockTables[table].filter((r) => filters.every((f) => f(r)))).then(resolve, reject); },
  };
  return q;
}
jest.mock('../models/db', () => {
  const db = jest.fn((table) => mockQuery(table));
  db.fn = { now: () => 'NOW' };
  return db;
});
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const mix = require('../services/product-mix-rules');
const migration = require('../models/migrations/20261127143000_product_mix_rules');

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CELSIUS = { id: id(1), name: 'Celsius WG', category: 'herbicide', compatibility_notes: null, do_not_tank_mix_with: null };
const CERTAINTY = { id: id(2), name: 'Certainty Turf Herbicide', category: 'herbicide' };
const FERT = { id: id(3), name: 'LESCO 12-0-0 Chelated Iron Plus', category: 'fertilizer', mixing_order_category: 'liquid_fertilizer' };
const SPEEDZONE = { id: id(4), name: 'SpeedZone Southern EW', category: 'herbicide', do_not_tank_mix_with: ['Additives that alter spray-solution pH below 5 or above 8.'] };
const DEMAND = { id: id(5), name: 'Demand CS', category: 'insecticide', compatibility_notes: 'Compatible with most insecticides and IGRs.' };
const OIL = { id: id(6), name: 'TriTek Spray Oil Emulsion (OMRI)', category: 'insecticide', active_ingredient: 'Mineral oil' };
const COPPER = { id: id(7), name: 'Southern Ag Copper Fungicide 27.15%', category: 'fungicide', active_ingredient: 'Copper diammonia diacetate complex' };
const rule = (n, fields) => ({ id: id(100 + n), active: true, jar_test_required: false, source: 'owner', product_b_id: null, group_b: null, ...fields });

beforeEach(() => {
  mockTables.products_catalog = [CELSIUS, CERTAINTY, FERT, SPEEDZONE, DEMAND, OIL, COPPER];
  mockTables.product_mix_rules = [
    rule(1, { product_a_id: CELSIUS.id, product_b_id: CERTAINTY.id, verdict: 'caution', reason: 'Approved weed mix, not in summer.' }),
    rule(2, { product_a_id: CELSIUS.id, group_b: 'fertilizer', verdict: 'never', reason: 'Do not tank mix Celsius with fertilizer.' }),
    rule(3, { product_a_id: COPPER.id, group_b: 'oil', verdict: 'never', reason: 'Keep copper out of oil tanks.', jar_test_required: true }),
    rule(4, { product_a_id: CERTAINTY.id, group_b: 'fertilizer', verdict: 'ok', reason: 'Old rule.', active: false }),
  ];
});

const pairOf = (result, a, b) => result.pairs.find((p) => [p.productAId, p.productBId].sort().join() === [a.id, b.id].sort().join());

describe('checkMix', () => {
  test('a pair rule answers its pair', async () => {
    const result = await mix.checkMix([CELSIUS.id, CERTAINTY.id]);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ verdict: 'caution', reason: 'Approved weed mix, not in summer.', productAName: 'Celsius WG', productBName: 'Certainty Turf Herbicide' });
    expect(result.pairs[0].entries[0]).toMatchObject({ kind: 'pair', ruleId: id(101) });
  });

  test('a group rule matches a product by its catalog category, from either side of the pair', async () => {
    const forward = pairOf(await mix.checkMix([CELSIUS.id, FERT.id]), CELSIUS, FERT);
    const backward = pairOf(await mix.checkMix([FERT.id, CELSIUS.id]), CELSIUS, FERT);
    expect(forward).toMatchObject({ verdict: 'never', reason: 'Do not tank mix Celsius with fertilizer.' });
    expect(backward).toMatchObject({ verdict: 'never', reason: 'Do not tank mix Celsius with fertilizer.' });
  });

  test('a group rule matches by active ingredient (oil, copper) and carries the jar test flag', async () => {
    const pair = pairOf(await mix.checkMix([OIL.id, COPPER.id]), OIL, COPPER);
    expect(pair).toMatchObject({ verdict: 'never', jarTestRequired: true });
  });

  test('the order of the list does not change any answer', async () => {
    const a = await mix.checkMix([CELSIUS.id, CERTAINTY.id, FERT.id]);
    const b = await mix.checkMix([FERT.id, CERTAINTY.id, CELSIUS.id]);
    for (const [x, y] of [[CELSIUS, CERTAINTY], [CELSIUS, FERT], [CERTAINTY, FERT]]) {
      expect(pairOf(a, x, y).verdict).toBe(pairOf(b, x, y).verdict);
      expect(pairOf(a, x, y).reason).toBe(pairOf(b, x, y).reason);
    }
    expect(a.pairs).toHaveLength(3);
  });

  test('an inactive rule is ignored: the pair reads unknown', async () => {
    const pair = pairOf(await mix.checkMix([CERTAINTY.id, FERT.id]), CERTAINTY, FERT);
    expect(pair).toMatchObject({ verdict: 'unknown', reason: mix.UNKNOWN.reason, entries: [] });
  });

  test('the catalog free text (do not tank mix, compatibility notes) shows as caution with source catalog', async () => {
    const result = await mix.checkMix([SPEEDZONE.id, DEMAND.id]);
    expect(result.pairs[0].verdict).toBe('caution');
    expect(result.pairs[0].entries.map((e) => e.source)).toEqual(['catalog', 'catalog']);
    expect(result.catalogNotes.map((n) => n.reason)).toEqual([
      'Label: do not tank mix with Additives that alter spray-solution pH below 5 or above 8.',
      'Label note: Compatible with most insecticides and IGRs.',
    ]);
  });

  test('a pair rule wins over a catalog note, which stays listed', async () => {
    mockTables.product_mix_rules.push(rule(5, { product_a_id: SPEEDZONE.id, product_b_id: DEMAND.id, verdict: 'ok', reason: 'Owner checked.' }));
    const pair = (await mix.checkMix([DEMAND.id, SPEEDZONE.id])).pairs[0];
    expect(pair).toMatchObject({ verdict: 'ok', reason: 'Owner checked.' });
    expect(pair.entries.map((e) => e.kind)).toEqual(['pair', 'catalog', 'catalog']);
  });

  test('an id that is not a product never throws: it is listed as not found and its pairs read unknown', async () => {
    const result = await mix.checkMix([CELSIUS.id, 'not-a-uuid', id(999)]);
    expect(result.products).toEqual([
      { id: CELSIUS.id, name: 'Celsius WG', found: true },
      { id: 'not-a-uuid', name: null, found: false },
      { id: id(999), name: null, found: false },
    ]);
    expect(result.pairs.every((p) => p.verdict === 'unknown')).toBe(true);
    await expect(mix.checkMix([])).resolves.toMatchObject({ pairs: [] });
    await expect(mix.checkMix(undefined)).resolves.toMatchObject({ pairs: [] });
  });
});

describe('normalizeRuleInput', () => {
  const base = { productAId: CELSIUS.id, productBId: CERTAINTY.id, verdict: 'never', reason: 'Short reason.' };

  test('stores a pair with the smaller id first, whatever order it was entered in', () => {
    expect(mix.normalizeRuleInput({ ...base, productAId: CERTAINTY.id, productBId: CELSIUS.id }))
      .toMatchObject({ product_a_id: CELSIUS.id, product_b_id: CERTAINTY.id, group_b: null, source: 'owner', jar_test_required: false });
  });

  test.each([
    [{ verdict: 'maybe' }, /ok, caution or never/],
    [{ reason: '' }, /short reason/],
    [{ reason: 'x'.repeat(201) }, /200 characters/],
    [{ productBId: null, groupB: null }, /not both/],
    [{ groupB: 'oil' }, /not both/],
    [{ productBId: null, groupB: 'paint' }, /Unknown product group/],
    [{ productBId: CELSIUS.id }, /two different/],
    [{ productAId: 'abc' }, /first product/],
  ])('refuses %j', (patch, message) => {
    expect(() => mix.normalizeRuleInput({ ...base, ...patch })).toThrow(message);
    try { mix.normalizeRuleInput({ ...base, ...patch }); } catch (err) { expect(err.statusCode).toBe(400); }
  });

  test('accepts a reason of exactly 200 characters and a product + group rule', () => {
    expect(mix.normalizeRuleInput({ ...base, reason: 'x'.repeat(200) }).reason).toHaveLength(200);
    expect(mix.normalizeRuleInput({ ...base, productBId: '', groupB: 'any' })).toMatchObject({ product_b_id: null, group_b: 'any' });
  });
});

test('the service groups and verdicts match the migration check lists', () => {
  expect(mix.GROUP_KEYS).toEqual(migration._GROUPS);
  expect(mix.VERDICTS).toEqual(migration._VERDICTS);
});
