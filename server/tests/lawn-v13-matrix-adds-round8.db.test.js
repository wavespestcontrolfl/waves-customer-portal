// Lawn protocol v13 matrix adds, Codex round 8, through PostgreSQL: the rotation reader on composite FRAC
// groups ("3 + 11") and the take-all pair evidence taken from the applied protocol row when Fast Complete
// records no targets. Owned schema (cloned table definitions), synthetic data. Self-skips without DATABASE_URL.
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const { evaluateWaveGuardManagerApprovals, latestComparableGroupApplication } = require('../services/waveguard-approval-engine');
const jobCard = require('../services/job-card');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
const TABLES = ['products_catalog', 'customers', 'scheduled_services', 'service_records', 'service_products',
  'lawn_protocol_service_completions', 'lawn_protocol_product_actuals', 'lawn_protocol_products', 'lawn_protocol_windows', 'lawn_protocols'];
const ARTAVIA = 'Artavia 2 SC (Azoxy)';
const HEADWAY = 'Headway Fungicide';

describeDb('rotation reads on composite groups and take-all evidence from the protocol row (round 8)', () => {
  let schema;
  let knex;
  let customerId;
  let propertyId;
  let artavia;
  let headway;
  let completion;
  let window;

  beforeAll(async () => {
    schema = `matrix_round8_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of TABLES) await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
    [artavia] = await knex('products_catalog').insert({ name: ARTAVIA, category: 'fungicide', frac_group: '11', active: true }).returning('*');
    [headway] = await knex('products_catalog').insert({ name: HEADWAY, category: 'fungicide', frac_group: '3 + 11', active: true }).returning('*');
    customerId = randomUUID();
    propertyId = randomUUID();
    const [proto] = await knex('lawn_protocols').insert({ protocol_key: 'k', version: '2026.10-v13', name: 'k', status: 'staged', grass_track: 'st_augustine', region: 'swfl' }).returning('*');
    [window] = await knex('lawn_protocol_windows').insert({ lawn_protocol_id: proto.id, month: 4, window_key: 'apr_v13_spreader_feeding', title: 'Apr', visit_type: 'x' }).returning('*');
    [completion] = await knex('lawn_protocol_service_completions').insert({ service_record_id: randomUUID() }).returning('*');
  }, 60000);
  afterAll(async () => { if (knex) { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); } });

  // A completed visit that applied `name`, ledgered under a staged row with `gates` (or none), with `targets`.
  async function priorApplication({ name, date, product, targets = [], gates = null, role = 'fungicide_spot' }) {
    const [visit] = await knex('scheduled_services').insert({ customer_id: customerId, property_id: propertyId, scheduled_date: date, service_type: 'Lawn Care' }).returning('*');
    const [record] = await knex('service_records').insert({ customer_id: customerId, scheduled_service_id: visit.id, service_date: date, service_type: 'Lawn Care', status: 'completed' }).returning('*');
    const [sp] = await knex('service_products').insert({ service_record_id: record.id, product_name: name, product_category: 'fungicide', targets }).returning('*');
    if (gates) {
      const [row] = await knex('lawn_protocol_products').insert({
        lawn_protocol_window_id: window.id, product_id: product.id, product_name: name, role, application_mode: 'spot', gates: JSON.stringify(gates),
      }).returning('*');
      await knex('lawn_protocol_product_actuals').insert({ lawn_protocol_service_completion_id: completion.id, service_product_id: sp.id, protocol_product_id: row.id, product_name: name });
    }
    return sp;
  }
  const reset = async () => {
    for (const table of ['lawn_protocol_product_actuals', 'service_products', 'service_records', 'scheduled_services']) await knex(table).del();
    await knex('lawn_protocol_products').del();
  };
  // The planned/applied row for the current application, as the closeout's plan carries it.
  const planWith = (product, gates, role = 'fungicide_spot') => ({ protocol: { structured: { products: gates ? [{ productId: product.id, role, gates }] : [] } } });
  const check = (product, { plan, targets = [], date = '2026-06-12' }) => evaluateWaveGuardManagerApprovals(knex, {
    customerId, service: { property_id: propertyId, service_type: 'Lawn Care' }, plan: plan || planWith(product, null), serviceDate: date, products: [{ productId: product.id, targets }],
  });
  const repeats = (result) => result.blocks.filter((block) => /^repeat_|rotation_approval$/.test(block.code)).map((block) => block.code);

  describe('2. composite group values reach the history reader', () => {
    beforeAll(async () => { await reset(); await priorApplication({ name: ARTAVIA, date: '2026-05-13', product: artavia }); });

    test('the helper finds a prior FRAC 11 application for the value "3 + 11", "3/11" and "11, 3"; a value sharing nothing finds none', async () => {
      for (const value of ['3 + 11', '3/11', '11, 3', '11']) {
        const last = await latestComparableGroupApplication(knex, customerId, headway, 'frac', value, '2026-06-12', { strict: true });
        expect({ value, product: last && last.product_name }).toEqual({ value, product: ARTAVIA });
      }
      expect(await latestComparableGroupApplication(knex, customerId, headway, 'frac', '7 + 13', '2026-06-12', { strict: true })).toBeNull();
      expect(await latestComparableGroupApplication(knex, customerId, headway, 'frac', '', '2026-06-12', { strict: true })).toBeNull();
    });

    test('the job card for Headway shows the rotation note for a prior Artavia', async () => {
      const note = await jobCard._test.rotationNote(knex, { customerId, scheduledDate: '2026-06-12' }, headway);
      expect(note).toBe(`FRAC 3 + 11 last used 2026-05-13 (${ARTAVIA})`);
    });
  });

  describe('3. take-all evidence from the applied protocol row when no targets are recorded', () => {
    const TAKE_ALL_APRIL = { trigger: 'mapped_take_all_spring_2' };
    const TAKE_ALL_MARCH = { trigger: 'mapped_take_all_spring_1' };

    test('Fast Complete Artavia (take-all row, no targets) then Headway (take-all row, no targets) 30 days later: exempt, no advisory', async () => {
      await reset();
      await priorApplication({ name: ARTAVIA, date: '2026-03-14', product: artavia, gates: TAKE_ALL_MARCH });
      const result = await check(headway, { plan: planWith(headway, TAKE_ALL_APRIL), date: '2026-04-13' });
      expect(repeats(result)).toEqual([]);
    });

    test('Headway on a large-patch row (no take-all) is a normal review', async () => {
      await reset();
      await priorApplication({ name: ARTAVIA, date: '2026-03-14', product: artavia, gates: TAKE_ALL_MARCH });
      const result = await check(headway, { plan: planWith(headway, { trigger: 'mapped_large_patch_with_velista' }), date: '2026-04-13' });
      expect(repeats(result)).toEqual(['fungicide_frac_rotation_approval']);
    });

    test('a prior Artavia on a large-patch row, or on no row at all, is no evidence either: normal review', async () => {
      await reset();
      await priorApplication({ name: ARTAVIA, date: '2026-03-14', product: artavia, gates: { trigger: 'active_large_patch' } });
      expect(repeats(await check(headway, { plan: planWith(headway, TAKE_ALL_APRIL), date: '2026-04-13' }))).toEqual(['fungicide_frac_rotation_approval']);
      await reset();
      await priorApplication({ name: ARTAVIA, date: '2026-03-14', product: artavia });
      expect(repeats(await check(headway, { plan: planWith(headway, TAKE_ALL_APRIL), date: '2026-04-13' }))).toEqual(['fungicide_frac_rotation_approval']);
    });

    test('no recorded targets and no protocol row on either side: no evidence (the rule as before)', async () => {
      await reset();
      await priorApplication({ name: ARTAVIA, date: '2026-03-14', product: artavia });
      expect(repeats(await check(headway, { plan: planWith(headway, null), date: '2026-04-13' }))).toEqual(['fungicide_frac_rotation_approval']);
    });

    test('recorded targets still decide: a non-take-all target beats a take-all row; a take-all target works without a row', async () => {
      await reset();
      await priorApplication({ name: ARTAVIA, date: '2026-03-14', product: artavia, gates: TAKE_ALL_MARCH });
      expect(repeats(await check(headway, { plan: planWith(headway, TAKE_ALL_APRIL), targets: ['Gray leaf spot'], date: '2026-04-13' }))).toEqual(['fungicide_frac_rotation_approval']);
      await reset();
      await priorApplication({ name: ARTAVIA, date: '2026-03-14', product: artavia, targets: ['Take-all root rot'] });
      expect(repeats(await check(headway, { plan: planWith(headway, null), targets: ['take-all'], date: '2026-04-13' }))).toEqual([]);
    });

    test('the rest of the exemption is unchanged: 28 to 45 days only, the second application only, the same property', async () => {
      await reset();
      await priorApplication({ name: ARTAVIA, date: '2026-03-14', product: artavia, gates: TAKE_ALL_MARCH });
      // 27 and 46 days: normal review.
      expect(repeats(await check(headway, { plan: planWith(headway, TAKE_ALL_APRIL), date: '2026-04-10' }))).toEqual(['fungicide_frac_rotation_approval']);
      expect(repeats(await check(headway, { plan: planWith(headway, TAKE_ALL_APRIL), date: '2026-04-29' }))).toEqual(['fungicide_frac_rotation_approval']);
      // A third pass (Artavia, Headway, then Headway again 30 days later) is a normal review.
      await priorApplication({ name: HEADWAY, date: '2026-04-13', product: headway, gates: TAKE_ALL_APRIL });
      expect(repeats(await check(headway, { plan: planWith(headway, TAKE_ALL_APRIL), date: '2026-05-13' }))).toEqual(['fungicide_frac_rotation_approval', 'fungicide_frac_rotation_approval']);
      // Another property's Artavia does not make this property's Headway a pair.
      await reset();
      const other = await priorApplication({ name: ARTAVIA, date: '2026-03-14', product: artavia, gates: TAKE_ALL_MARCH });
      await knex('scheduled_services').whereIn('id', knex('service_records').where({ id: other.service_record_id }).select('scheduled_service_id')).update({ property_id: randomUUID() });
      expect(repeats(await check(headway, { plan: planWith(headway, TAKE_ALL_APRIL), date: '2026-04-13' }))).toEqual(['fungicide_frac_rotation_approval']);
    });
  });
});
