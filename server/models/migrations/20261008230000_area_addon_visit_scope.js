/**
 * What the estimate sold for an area add-on, on the booked visit (Codex round 6 on #6135).
 *
 * The accepted estimate knows the treated area, the tier it priced at and, for the insect
 * spot, the grass that authorized the St. Augustine-only rate. The booking kept only the
 * duration and the price, so dispatch and the job card could not say how much was sold or
 * show the grass evidence. `scheduled_services` has no free-form metadata column
 * (20260921000002 says so), so the scope gets its own:
 *
 *   scheduled_services.area_addon_scope        the add-on that IS the appointment
 *   scheduled_service_addons.area_addon_scope  each add-on row on the appointment
 *
 * Shape (jsonb, nullable): { v: 1, addOnKey, catalogServiceKey, areaSqFt, tierSqFt, grassType }.
 * Written in the booking transaction by area-addon-visit-rows.js; read by the job card.
 * NULL on every other row and on every row booked before this migration. Additive and
 * reversible; no CHECK constraint (this table's convention for its JSON columns).
 */
const TABLES = ['scheduled_services', 'scheduled_service_addons'];
const COL = 'area_addon_scope';

exports.up = async function up(knex) {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (await knex.schema.hasColumn(table, COL)) continue;
    await knex.schema.alterTable(table, (t) => { t.jsonb(COL).nullable(); });
  }
};

exports.down = async function down(knex) {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (!(await knex.schema.hasColumn(table, COL))) continue;
    await knex.schema.alterTable(table, (t) => { t.dropColumn(COL); });
  }
};
