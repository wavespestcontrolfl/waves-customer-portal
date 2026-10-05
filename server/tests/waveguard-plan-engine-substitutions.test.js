// getAppointmentSubstitutions: original product id → the active substitution
// row with its `substitute` catalog product. With a catalog list in hand (the
// plan's read) the substitutes come from it; with none (null, the lawn-fast
// context's protocol window) the substitutes' rows are read from the catalog,
// so the one mechanism serves both callers. Synthetic data only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { getAppointmentSubstitutions } = require('../services/waveguard-plan-engine');

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VISIT = uuid(1);
const ORIGINAL = uuid(11);
const SUBSTITUTE = uuid(12);
const row = { id: uuid(99), scheduled_service_id: VISIT, original_product_id: ORIGINAL, substitute_product_id: SUBSTITUTE, rate_per_1000: '3.0000', rate_unit: 'fl oz', active: true, original_product_name: 'Original', substitute_product_name: 'Substitute' };
const substitute = { id: SUBSTITUTE, name: 'Substitute', default_rate_per_1000: '0.5000', rate_unit: 'fl oz' };

// A knex whose first query answers the substitution rows and whose second (if
// any) answers the catalog read; records which tables were asked.
function fakeKnex({ substitutions = [row], catalog = [substitute], hasTable = true } = {}) {
  const asked = [];
  const chain = (data) => {
    const c = {};
    for (const m of ['leftJoin', 'where', 'whereIn', 'select']) c[m] = () => c;
    c.then = (ok, err) => Promise.resolve(data).then(ok, err);
    c.catch = (err) => Promise.resolve(data).catch(err);
    return c;
  };
  const knex = jest.fn((table) => { asked.push(table); return chain(table.startsWith('lawn_protocol_product_substitutions') ? substitutions : catalog); });
  knex.schema = { hasTable: async () => hasTable };
  // savepointRead runs the query under a savepoint when the connection is a transaction; a plain handle runs it directly.
  return { knex, asked };
}

test('with a catalog list, the substitute comes from it and no catalog read is made', async () => {
  const { knex, asked } = fakeKnex();
  const map = await getAppointmentSubstitutions(knex, VISIT, [substitute]);
  expect(map.get(ORIGINAL)).toMatchObject({ substitute_product_id: SUBSTITUTE, rate_per_1000: '3.0000', substitute });
  expect(asked.filter((t) => t === 'products_catalog')).toHaveLength(0);
});

test('with no catalog list (null), the substitutes\' rows are read from the catalog', async () => {
  const { knex, asked } = fakeKnex();
  const map = await getAppointmentSubstitutions(knex, VISIT, null);
  expect(map.get(ORIGINAL).substitute).toEqual(substitute);
  expect(asked).toContain('products_catalog');
});

test('a substitute the catalog list does not carry is left out; no substitution rows read nothing more', async () => {
  const { knex } = fakeKnex();
  expect((await getAppointmentSubstitutions(knex, VISIT, [])).size).toBe(0);
  const empty = fakeKnex({ substitutions: [] });
  expect((await getAppointmentSubstitutions(empty.knex, VISIT, null)).size).toBe(0);
  expect(empty.asked.filter((t) => t === 'products_catalog')).toHaveLength(0);
});

test('without the table there are no substitutions', async () => {
  const { knex } = fakeKnex({ hasTable: false });
  expect((await getAppointmentSubstitutions(knex, VISIT, null)).size).toBe(0);
});
