/**
 * Companion typed sections for combined services
 * (docs/design/combined-service-completions.md).
 *
 * companion_types — JSONB, nullable. Shape:
 *   [{ "type": "<typed findings type>", "delivery": "auto_send" | "internal_only" | "disabled" }]
 *
 * Plain schema migration, no data: the mechanism ships DARK — no profile row
 * carries companion_types until the cutover migration (after the owner
 * confirms the combined-customer mappings). serializeProfile parses the
 * column fail-safe (unknown types dropped, bad delivery → internal_only).
 */

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('service_completion_profiles');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('service_completion_profiles', 'companion_types');
  if (hasColumn) return;
  await knex.schema.alterTable('service_completion_profiles', (t) => {
    t.jsonb('companion_types');
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('service_completion_profiles');
  if (!hasTable) return;
  if (await knex.schema.hasColumn('service_completion_profiles', 'companion_types')) {
    await knex.schema.alterTable('service_completion_profiles', (t) => {
      t.dropColumn('companion_types');
    });
  }
};
