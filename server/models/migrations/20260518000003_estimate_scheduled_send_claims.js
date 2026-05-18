/**
 * Scheduled estimate send claim state.
 *
 * Cron workers need an atomic "sending" claim so multiple app instances do
 * not deliver the same scheduled estimate. Failed scheduled sends also need a
 * terminal state instead of retrying every five minutes forever.
 */
exports.up = async function (knex) {
  const hasAttempts = await knex.schema.hasColumn('estimates', 'scheduled_send_attempts');
  const hasLastError = await knex.schema.hasColumn('estimates', 'last_send_error');

  if (!hasAttempts || !hasLastError) {
    await knex.schema.alterTable('estimates', (t) => {
      if (!hasAttempts) t.integer('scheduled_send_attempts').notNullable().defaultTo(0);
      if (!hasLastError) t.text('last_send_error');
    });
  }

  await knex.raw('ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_status_check');
  await knex.raw(`
    ALTER TABLE estimates
      ADD CONSTRAINT estimates_status_check
      CHECK (status IN (
        'draft',
        'scheduled',
        'sending',
        'send_failed',
        'sent',
        'viewed',
        'accepted',
        'declined',
        'expired'
      ))
  `);

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_estimates_scheduled_send_due
      ON estimates (status, scheduled_at)
      WHERE scheduled_at IS NOT NULL
  `);
};

exports.down = async function (knex) {
  await knex.raw(`UPDATE estimates SET status = 'scheduled' WHERE status IN ('sending', 'send_failed')`);
  await knex.raw('DROP INDEX IF EXISTS idx_estimates_scheduled_send_due');
  await knex.raw('ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_status_check');
  await knex.raw(`
    ALTER TABLE estimates
      ADD CONSTRAINT estimates_status_check
      CHECK (status IN (
        'draft',
        'scheduled',
        'sent',
        'viewed',
        'accepted',
        'declined',
        'expired'
      ))
  `);

  const hasAttempts = await knex.schema.hasColumn('estimates', 'scheduled_send_attempts');
  const hasLastError = await knex.schema.hasColumn('estimates', 'last_send_error');
  if (hasAttempts || hasLastError) {
    await knex.schema.alterTable('estimates', (t) => {
      if (hasAttempts) t.dropColumn('scheduled_send_attempts');
      if (hasLastError) t.dropColumn('last_send_error');
    });
  }
};
