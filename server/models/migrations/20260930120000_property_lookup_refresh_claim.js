// Forced live-refresh claim for property lookups (reviewed property areas,
// dark GATE_PROPERTY_SERVICE_AREAS). Its own column: the attempt stamps
// (last_attempt_at/_status) are rewritten by every lookup outcome, cache hits
// included, so they cannot hold a paid-refresh cooldown. Nullable, no default.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('property_lookups'))) return;
  if (!(await knex.schema.hasColumn('property_lookups', 'live_refresh_claimed_at'))) {
    await knex.schema.alterTable('property_lookups', (t) => t.timestamp('live_refresh_claimed_at', { useTz: true }).nullable());
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('property_lookups'))) return;
  if (await knex.schema.hasColumn('property_lookups', 'live_refresh_claimed_at')) {
    await knex.schema.alterTable('property_lookups', (t) => t.dropColumn('live_refresh_claimed_at'));
  }
};
