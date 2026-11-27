/**
 * product_mix_rules on real Postgres: migration 20261127143000 runs inside a scratch schema (first on the search path)
 * over minimal products_catalog / technicians tables, then services/product-mix-rules.js reads and writes through the
 * same transaction. Each test runs in one transaction that is rolled back, so nothing real is read or written.
 * CI runs it in the server-db job, which selects every suite with the `const SKIP` line below.
 */
const SKIP = !process.env.DATABASE_URL;

let mockTrx = null;
jest.mock('../models/db', () => new Proxy(function db() {}, {
  apply: (_target, _this, args) => mockTrx(...args),
  get: (_target, prop) => (typeof mockTrx[prop] === 'function' ? mockTrx[prop].bind(mockTrx) : mockTrx[prop]),
}));
const mockAudit = { fail: false, events: [] };
jest.mock('../services/audit-log', () => ({
  recordAuditEvent: jest.fn(async (event) => {
    if (mockAudit.fail) throw new Error('audit_log write failed');
    mockAudit.events.push(event);
  }),
}));

// The seed logs each skipped or added row; keep the test output quiet.
beforeAll(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); });

const migration = require('../models/migrations/20261127143000_product_mix_rules');
const mix = require('../services/product-mix-rules');

(SKIP ? describe.skip : describe)('product_mix_rules (real PG)', () => {
  let knex;
  const ids = {};

  beforeAll(() => {
    const { hostname } = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) throw new Error('DATABASE_URL must point to loopback PostgreSQL');
    knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
  });

  beforeEach(async () => {
    mockTrx = await knex.transaction();
    const schema = `mix_rules_test_${process.pid}`;
    await mockTrx.raw(`CREATE SCHEMA ${schema}`);
    await mockTrx.raw(`SET LOCAL search_path TO ${schema}, public`);
    await mockTrx.raw(`
      CREATE TABLE technicians (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE products_catalog (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(150) NOT NULL, category varchar(30),
        active_ingredient varchar(150), moa_group varchar(30), irac_group varchar(10), formulation varchar(50),
        mixing_order_category varchar(50), allows_surfactant boolean,
        do_not_tank_mix_with jsonb, compatibility_notes text, active boolean DEFAULT true
      );
    `);
    const products = [
      { key: 'celsius', name: 'Celsius WG', category: 'herbicide' },
      { key: 'certainty', name: 'Certainty Turf Herbicide', category: 'herbicide' },
      { key: 'nis', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' },
      { key: 'fert', name: 'LESCO 12-0-0 Chelated Iron Plus', category: 'fertilizer', mixing_order_category: 'liquid_fertilizer' },
      { key: 'tetrino', name: 'Tetrino Insecticide', category: 'insecticide' },
      { key: 'copper', name: 'Southern Ag Copper Fungicide 27.15%', category: 'fungicide', active_ingredient: 'Copper' },
      { key: 'oil', name: 'TriTek Spray Oil Emulsion (OMRI)', category: 'insecticide', active_ingredient: 'Mineral oil' },
      { key: 'bifenthrin', name: 'LESCO Crosscheck Plus', category: 'insecticide', active_ingredient: 'Bifenthrin', moa_group: '3A' },
      { key: 'kflow', name: 'LESCO K-Flow 0-0-25', category: 'fertilizer', allows_surfactant: false },
      { key: 'typed', name: 'Typed IRAC insecticide', category: 'insecticide', irac_group: '28+3A' },
    ];
    for (const { key, ...row } of products) {
      const [inserted] = await mockTrx('products_catalog').insert(row).returning('id');
      ids[key] = inserted.id;
    }
    await migration.up(mockTrx);
  });

  afterEach(async () => { await mockTrx.rollback(); mockTrx = null; mockAudit.fail = false; mockAudit.events = []; });
  afterAll(async () => { await knex.destroy(); });

  test('the seed adds the quoted rules for the products present, and a second run adds nothing', async () => {
    const count = async () => Number((await mockTrx('product_mix_rules').count('* as n'))[0].n);
    // Celsius + fertilizer, Celsius + Certainty, Celsius + NIS, Certainty + NIS, Tetrino alone, copper + oil, TriTek + pyrethroid.
    expect(await count()).toBe(7);
    await migration.up(mockTrx);
    expect(await count()).toBe(7);
  });

  test('the constraints refuse a reversed pair, both targets, an unknown verdict and a second row for a pair', async () => {
    const [lo, hi] = [ids.celsius, ids.fert].sort();
    const attempt = async (row) => {
      await mockTrx.raw('SAVEPOINT attempt');
      try { await mockTrx('product_mix_rules').insert({ verdict: 'ok', reason: 'x', ...row }); return 'ok'; } catch (err) { return err.constraint || err.code; } finally { await mockTrx.raw('ROLLBACK TO SAVEPOINT attempt'); }
    };
    expect(await attempt({ product_a_id: hi, product_b_id: lo })).toBe('product_mix_rules_pair_order_check');
    expect(await attempt({ product_a_id: lo, product_b_id: hi, group_b: 'oil' })).toBe('product_mix_rules_one_target_check');
    expect(await attempt({ product_a_id: lo, group_b: 'paint' })).toBe('product_mix_rules_group_check');
    expect(await attempt({ product_a_id: lo, product_b_id: hi, verdict: 'maybe' })).toBe('product_mix_rules_verdict_check');
    const [c1, c2] = [ids.celsius, ids.certainty].sort();
    expect(await attempt({ product_a_id: c1, product_b_id: c2 })).toBe('product_mix_rules_one_per_pair');
  });

  test('checkMix answers from the seeded rules, in either order', async () => {
    const result = await mix.checkMix([ids.fert, ids.celsius, ids.oil, ids.copper, ids.bifenthrin]);
    const pair = (a, b) => result.pairs.find((p) => [p.productAId, p.productBId].sort().join() === [a, b].sort().join());
    expect(pair(ids.celsius, ids.fert)).toMatchObject({ verdict: 'never', reason: 'Do not tank mix Celsius with fertilizer.' });
    expect(pair(ids.oil, ids.copper)).toMatchObject({ verdict: 'never', reason: 'Keep copper out of oil tanks.' });
    expect(pair(ids.oil, ids.bifenthrin)).toMatchObject({ verdict: 'never' });
    expect(pair(ids.fert, ids.copper)).toMatchObject({ verdict: 'unknown' });
    const tetrino = await mix.checkMix([ids.certainty, ids.tetrino]);
    expect(tetrino.pairs[0]).toMatchObject({ verdict: 'never', reason: 'Apply Tetrino alone. Do not mix it with any other product.' });
  });

  test('upsert keeps one row per pair, reactivates a removed rule, and a removed rule stops answering', async () => {
    const created = await mix.upsertRule({ productAId: ids.fert, productBId: ids.copper, verdict: 'caution', reason: 'Jar test first.', jarTestRequired: true });
    expect((await mix.checkMix([ids.copper, ids.fert])).pairs[0]).toMatchObject({ verdict: 'caution', jarTestRequired: true });
    await mix.deactivateRule(created.id);
    expect((await mix.checkMix([ids.copper, ids.fert])).pairs[0].verdict).toBe('unknown');
    expect((await mix.listRules()).some((r) => r.id === created.id)).toBe(false);
    const again = await mix.upsertRule({ productAId: ids.copper, productBId: ids.fert, verdict: 'never', reason: 'Owner said no.' });
    expect(again.id).toBe(created.id);
    expect(again).toMatchObject({ verdict: 'never', active: true });
    await expect(mix.upsertRule({ productAId: ids.celsius, productBId: ids.certainty, verdict: 'ok', reason: 'x' }, { id: created.id }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
  test('the label fields are read: allows_surfactant = false and a typed irac_group', async () => {
    const result = await mix.checkMix([ids.kflow, ids.nis, ids.typed, ids.oil]);
    const pair = (a, b) => result.pairs.find((p) => [p.productAId, p.productBId].sort().join() === [a, b].sort().join());
    expect(pair(ids.kflow, ids.nis)).toMatchObject({ verdict: 'caution', source: 'catalog' });
    expect(pair(ids.typed, ids.oil)).toMatchObject({ verdict: 'never', reason: 'No oil and pyrethroid in the same tank.' });
  });

  test('two creates for the same new target leave one row; the second is recorded as an update', async () => {
    const first = await mix.upsertRule({ productAId: ids.copper, groupB: 'fertilizer', verdict: 'caution', reason: 'First.' });
    const second = await mix.upsertRule({ productAId: ids.copper, groupB: 'fertilizer', verdict: 'never', reason: 'Second.' });
    expect(second.id).toBe(first.id);
    const rows = await mockTrx('product_mix_rules').where({ product_a_id: ids.copper, group_b: 'fertilizer' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: 'never', reason: 'Second.' });
    expect(mockAudit.events.map((e) => [e.action, e.critical])).toEqual([['product_mix_rules.created', true], ['product_mix_rules.updated', true]]);
    expect(mockAudit.events[1].metadata.before).toMatchObject({ verdict: 'caution', reason: 'First.' });
  });

  test('a lost audit event rolls the rule change back (create, edit and remove)', async () => {
    mockAudit.fail = true;
    await expect(mix.upsertRule({ productAId: ids.copper, groupB: 'fertilizer', verdict: 'never', reason: 'x' })).rejects.toThrow('audit_log write failed');
    expect(await mockTrx('product_mix_rules').where({ product_a_id: ids.copper, group_b: 'fertilizer' })).toHaveLength(0);
    const seeded = await mockTrx('product_mix_rules').where({ product_a_id: ids.tetrino, group_b: 'any' }).first();
    await expect(mix.upsertRule({ productAId: ids.tetrino, groupB: 'any', verdict: 'ok', reason: 'x' }, { id: seeded.id })).rejects.toThrow('audit_log write failed');
    await expect(mix.deactivateRule(seeded.id)).rejects.toThrow('audit_log write failed');
    expect(await mockTrx('product_mix_rules').where({ id: seeded.id }).first()).toMatchObject({ verdict: 'never', active: true });
  });

  test('an edit onto another row\'s product + group target is a 409', async () => {
    const tetrino = await mockTrx('product_mix_rules').where({ product_a_id: ids.tetrino, group_b: 'any' }).first();
    await expect(mix.upsertRule({ productAId: ids.celsius, groupB: 'fertilizer', verdict: 'ok', reason: 'x' }, { id: tetrino.id }))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});
