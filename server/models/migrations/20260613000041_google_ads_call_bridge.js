exports.up = async function up(knex) {
  const hasCallLog = await knex.schema.hasTable('call_log');
  if (!hasCallLog) return;

  const cols = await knex('call_log').columnInfo();

  await knex.schema.alterTable('call_log', (t) => {
    if (!cols.google_ads_call_resource_name) t.string('google_ads_call_resource_name', 255);
    if (!cols.google_ads_call_started_at) t.timestamp('google_ads_call_started_at');
    if (!cols.google_ads_call_duration_seconds) t.integer('google_ads_call_duration_seconds');
    if (!cols.google_ads_call_status) t.string('google_ads_call_status', 50);
    if (!cols.google_ads_bridge_confidence) t.integer('google_ads_bridge_confidence');
    if (!cols.google_ads_bridged_at) t.timestamp('google_ads_bridged_at');
  });

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_call_log_google_ads_resource
    ON call_log (google_ads_call_resource_name)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_call_log_google_ads_bridged_at
    ON call_log (google_ads_bridged_at DESC)
  `);
};

exports.down = async function down(knex) {
  const hasCallLog = await knex.schema.hasTable('call_log');
  if (!hasCallLog) return;

  await knex.raw('DROP INDEX IF EXISTS idx_call_log_google_ads_bridged_at');
  await knex.raw('DROP INDEX IF EXISTS idx_call_log_google_ads_resource');

  const cols = await knex('call_log').columnInfo();
  await knex.schema.alterTable('call_log', (t) => {
    if (cols.google_ads_bridged_at) t.dropColumn('google_ads_bridged_at');
    if (cols.google_ads_bridge_confidence) t.dropColumn('google_ads_bridge_confidence');
    if (cols.google_ads_call_status) t.dropColumn('google_ads_call_status');
    if (cols.google_ads_call_duration_seconds) t.dropColumn('google_ads_call_duration_seconds');
    if (cols.google_ads_call_started_at) t.dropColumn('google_ads_call_started_at');
    if (cols.google_ads_call_resource_name) t.dropColumn('google_ads_call_resource_name');
  });
};
