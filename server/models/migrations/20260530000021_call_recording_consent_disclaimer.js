/**
 * Restore the call-recording consent disclaimer migration expected by
 * production's knex migration history.
 *
 * The runtime gates customer-insight mining on this column when it exists.
 * Keep this idempotent so environments that already ran the original
 * migration validate cleanly, while fresh databases still get the column.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  const hasColumn = await knex.schema.hasColumn('call_log', 'call_recording_consent_disclaimer_played');
  if (hasColumn) return;

  await knex.schema.alterTable('call_log', (table) => {
    table.boolean('call_recording_consent_disclaimer_played').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_log'))) return;
  const hasColumn = await knex.schema.hasColumn('call_log', 'call_recording_consent_disclaimer_played');
  if (!hasColumn) return;

  await knex.schema.alterTable('call_log', (table) => {
    table.dropColumn('call_recording_consent_disclaimer_played');
  });
};
