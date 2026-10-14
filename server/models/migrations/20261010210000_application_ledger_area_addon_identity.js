/**
 * The compliance ledger keeps BOTH applications when a host treatment and an attached area add-on use the same product.
 *
 * `service_products.area_addon_key` (20261009200000) lets one service record carry two rows of one catalog product: the host's
 * own (Snapshot on a Tree & Shrub visit) and the add-on's (Bed Pre-Emergent, also Snapshot). The ledger's stable identity
 * (20260705000402) was one row per (service_record_id, product_id), so the writer's ON CONFLICT DO NOTHING dropped the second
 * application: the FDACS export and the yearly-limit history then showed one application where two were made.
 *
 * This adds `property_application_history.area_addon_key` (the catalog service key of the add-on, NULL for a host's own row)
 * and widens the stable identity to (service_record_id, product_id, add-on). A host row and every row written before this
 * migration have a NULL key, so their identity is exactly what it was.
 *
 * down() restores the old identity only when no record holds two rows of one product (it would not build otherwise); the
 * column is dropped only when it is empty, so a rollback never deletes which add-on an application belonged to.
 */
const TABLE = 'property_application_history';
const COL = 'area_addon_key';
const OLD_INDEX = 'uq_property_application_history_record_product';
const NEW_INDEX = 'uq_property_application_history_record_product_addon';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COL))) {
    await knex.schema.alterTable(TABLE, (t) => { t.string(COL, 80).nullable(); });
  }
  await knex.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${NEW_INDEX} ON ${TABLE} (service_record_id, product_id, (COALESCE(${COL}, ''))) `
    + 'WHERE product_id IS NOT NULL'
  );
  await knex.raw(`DROP INDEX IF EXISTS ${OLD_INDEX}`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  const hasCol = await knex.schema.hasColumn(TABLE, COL);
  const doubled = await knex.raw(
    `SELECT 1 FROM ${TABLE} WHERE product_id IS NOT NULL GROUP BY service_record_id, product_id HAVING COUNT(*) > 1 LIMIT 1`
  );
  if (!(doubled.rows || []).length) {
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${OLD_INDEX} ON ${TABLE} (service_record_id, product_id) WHERE product_id IS NOT NULL`);
    await knex.raw(`DROP INDEX IF EXISTS ${NEW_INDEX}`);
  }
  if (!hasCol) return;
  const tagged = await knex(TABLE).whereNotNull(COL).first('id');
  if (!tagged) await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COL); });
};
