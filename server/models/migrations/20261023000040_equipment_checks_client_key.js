'use strict';

/**
 * equipment_checks.client_key — the page's idempotency key for one truck check
 * (docs/tool-inventory-tracker-scope.md PR 1; Codex P2 on #6497). A retry
 * after a lost response carries the same key and gets the same check back,
 * so one check never records twice or rings the office twice. Unique per
 * truck while set; older rows stay null.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('equipment_checks'))) return;
  if (!(await knex.schema.hasColumn('equipment_checks', 'client_key'))) {
    await knex.schema.alterTable('equipment_checks', (t) => { t.string('client_key', 64).nullable(); });
  }
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS equipment_checks_vehicle_client_key_idx ON equipment_checks (vehicle_id, client_key) WHERE client_key IS NOT NULL');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('equipment_checks'))) return;
  await knex.raw('DROP INDEX IF EXISTS equipment_checks_vehicle_client_key_idx');
  if (await knex.schema.hasColumn('equipment_checks', 'client_key')) {
    await knex.schema.alterTable('equipment_checks', (t) => { t.dropColumn('client_key'); });
  }
};
