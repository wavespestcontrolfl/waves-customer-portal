// Lawn protocol v13: the stored reason on the Dylox 6.2 G count limit is corrected (migration 20261009174000) and the count stays 2,
// through the real migration on PostgreSQL (cloned schema). Synthetic data only. Self-skips without DATABASE_URL.
//
// Pinned: the row 20261009173000 wrote gets the corrected description and keeps value 2; a row with another description or another
// value is left; a second up changes nothing; down puts the old description back only while the row still reads as written.
const { createLawnHistoryDb } = require('./helpers/lawn-history-db');
const second = require('../models/migrations/20261009173000_lawn_v13_dylox_two_a_year');
const migration = require('../models/migrations/20261009174000_lawn_v13_dylox_two_a_year_description');

const TABLES = ['products_catalog', 'product_limits', 'lawn_protocol_audit_log'];
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('v13 Dylox 6.2 G count limit description migration through PostgreSQL', () => {
  let owned;
  let knex;
  let productId;

  beforeAll(async () => {
    owned = await createLawnHistoryDb(); knex = owned.knex;
    for (const table of TABLES) {
      await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [owned.schema, table, table]);
    }
    await knex.raw('ALTER TABLE ??.lawn_protocol_audit_log ALTER COLUMN lawn_protocol_id DROP NOT NULL', [owned.schema]).catch(() => {});
    const [made] = await knex('products_catalog').insert({ name: second.DYLOX, category: 'insecticide' }).returning('id');
    productId = made && typeof made === 'object' ? made.id : made;
  }, 60000);
  afterAll(async () => { if (owned) await owned.dispose(); });
  beforeEach(async () => {
    await knex('lawn_protocol_audit_log').del();
    await knex('product_limits').del();
  });

  const addLimit = async (fields = {}) => {
    const [made] = await knex('product_limits').insert({ product_id: productId, ...second.LIMIT, ...fields }).returning('id');
    return made && typeof made === 'object' ? made.id : made;
  };
  const read = (id) => knex('product_limits').where({ id }).first('limit_value', 'description');
  const audits = () => knex('lawn_protocol_audit_log').where({ action: migration.ACTION });

  it('corrects the description, keeps the count at 2, and is idempotent', async () => {
    const id = await addLimit();
    await migration.up(knex);
    await migration.up(knex);
    const row = await read(id);
    expect(Number(row.limit_value)).toBe(2);
    expect(row.description).toBe(migration.DESCRIPTION);
    expect(row.description).not.toMatch(/surface feeding/);
    expect(await audits()).toHaveLength(1);
  });

  it('leaves a row with another description or another value', async () => {
    const edited = await addLimit({ description: 'Office rule: two a year.' });
    const three = await addLimit({ limit_value: 3 });
    await migration.up(knex);
    expect((await read(edited)).description).toBe('Office rule: two a year.');
    expect((await read(three)).description).toBe(second.LIMIT.description);
    expect(await audits()).toHaveLength(0);
  });

  it('down puts the old description back only while the row still reads as written', async () => {
    const kept = await addLimit();
    const editedLater = await addLimit();
    await migration.up(knex);
    await knex('product_limits').where({ id: editedLater }).update({ description: 'Edited by the office.' });
    await migration.down(knex);
    expect((await read(kept)).description).toBe(second.LIMIT.description);
    expect((await read(editedLater)).description).toBe('Edited by the office.');
    expect(await audits()).toHaveLength(0);
  });
});
