exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('bouncie_oauth_tokens'))) {
    await knex.schema.createTable('bouncie_oauth_tokens', (t) => {
      t.string('provider', 30).primary();
      t.text('access_token');
      t.text('refresh_token');
      t.timestamp('expires_at');
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
  }

  if (await knex.schema.hasTable('bouncie_webhook_log')) {
    const hasDedupeKey = await knex.schema.hasColumn('bouncie_webhook_log', 'dedupe_key');
    if (!hasDedupeKey) {
      await knex.schema.alterTable('bouncie_webhook_log', (t) => {
        t.string('dedupe_key', 64);
      });
    }
    await knex.raw('DROP INDEX IF EXISTS idx_bouncie_webhook_log_dedupe_key');
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bouncie_webhook_log_dedupe_key
      ON bouncie_webhook_log(dedupe_key)
    `);
  }

  if (await knex.schema.hasTable('system_settings')) {
    const settings = [
      ['geofence.auto_flip_on_departure', 'false'],
      ['geofence.auto_flip_dry_run', 'true'],
      ['geofence.auto_flip_dwell_minutes', '10'],
      ['geofence.auto_flip_horizon_hours', '4'],
      ['geofence.auto_flip_cooldown_minutes', '30'],
    ];
    for (const [key, value] of settings) {
      await knex('system_settings')
        .insert({ key, value, category: 'geofence', updated_at: new Date() })
        .onConflict('key')
        .ignore();
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('bouncie_webhook_log')) {
    await knex.raw('DROP INDEX IF EXISTS idx_bouncie_webhook_log_dedupe_key');
    if (await knex.schema.hasColumn('bouncie_webhook_log', 'dedupe_key')) {
      await knex.schema.alterTable('bouncie_webhook_log', (t) => {
        t.dropColumn('dedupe_key');
      });
    }
  }
  await knex.schema.dropTableIfExists('bouncie_oauth_tokens');
};
