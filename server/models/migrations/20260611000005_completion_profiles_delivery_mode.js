/**
 * service_completion_profiles.delivery_mode
 *
 * Per-service-type delivery control for typed specialty completions:
 *   - auto_send      → report token + PDF + SMS + email on completion (default)
 *   - internal_only  → report is rendered and stored (token + PDF) but no
 *                      customer SMS/email — the Phase-1b shadow mode
 *   - disabled       → no customer report artifacts at all (kill switch)
 *
 * An enum-style varchar (not a boolean) because the rollout specifically
 * needs "render and store, but don't send yet," which a single boolean can't
 * express alongside "feature off." Recurring service-report profiles keep
 * auto_send and are unaffected — the column is only consulted for typed
 * (findings-schema) completions.
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('service_completion_profiles');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('service_completion_profiles', 'delivery_mode');
  if (hasColumn) return;

  await knex.schema.alterTable('service_completion_profiles', (t) => {
    t.string('delivery_mode', 20).notNullable().defaultTo('auto_send');
  });
  await knex.raw(`
    ALTER TABLE service_completion_profiles
    ADD CONSTRAINT chk_service_completion_profiles_delivery_mode
    CHECK (delivery_mode IN ('auto_send', 'internal_only', 'disabled'))
  `);
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('service_completion_profiles');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('service_completion_profiles', 'delivery_mode');
  if (!hasColumn) return;
  await knex.raw(`
    ALTER TABLE service_completion_profiles
    DROP CONSTRAINT IF EXISTS chk_service_completion_profiles_delivery_mode
  `);
  await knex.schema.alterTable('service_completion_profiles', (t) => {
    t.dropColumn('delivery_mode');
  });
};
