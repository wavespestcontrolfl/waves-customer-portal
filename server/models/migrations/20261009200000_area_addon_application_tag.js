/**
 * Which area add-on an application row belongs to (Codex round 8 on #6135).
 *
 * A visit can carry several chemical add-ons, and each one needs its own application row. The
 * closeout counted "an application row exists" as one fact, so a visit with two chemical add-ons
 * closed green with one treatment undocumented. This adds the tag the closeout reads:
 *
 *   service_products.area_addon_key   the catalog service key of the add-on (area_addon_<key>)
 *
 * Nullable. NULL on every row recorded before this migration and on every row that is not an
 * add-on's (a host visit's own products). Written by complete-scheduled-service.js only when the
 * add-on is actually on the visit (the visit's own area_addon_scope or a scheduled_service_addons
 * row); a client-supplied tag for an add-on the visit does not carry is dropped. Additive and
 * reversible; no CHECK constraint (the tag is validated at write time against the visit).
 */
const TABLE = 'service_products';
const COL = 'area_addon_key';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (await knex.schema.hasColumn(TABLE, COL)) return;
  await knex.schema.alterTable(TABLE, (t) => { t.string(COL, 80).nullable(); });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, COL))) return;
  await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COL); });
};
