/**
 * Migration — clear the inert seasonal_channel default
 *
 * Migration 104 added seasonal_channel with DEFAULT 'email', but no shipped
 * surface ever wrote it: the only writer (/api/notification-prefs) belongs to
 * a client component that was never imported, so every existing 'email' value
 * is the column default, not a customer choice. Now that the real senders
 * honor the column ('email' suppresses the seasonal SMS leg), those inert
 * defaults would silently disable seasonal SMS account-wide. Reset them to
 * NULL (= historical both-channels behavior) and drop the default so new rows
 * stay unset until the customer explicitly picks a channel in the portal.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('notification_prefs', 'seasonal_channel');
  if (!hasCol) return;

  await knex('notification_prefs')
    .where({ seasonal_channel: 'email' })
    .update({ seasonal_channel: null });
  await knex.raw('ALTER TABLE notification_prefs ALTER COLUMN seasonal_channel DROP DEFAULT');
};

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('notification_prefs');
  if (!hasTable) return;
  const hasCol = await knex.schema.hasColumn('notification_prefs', 'seasonal_channel');
  if (!hasCol) return;

  // Restores the schema default only — the pre-migration per-row 'email'
  // values are indistinguishable from real choices and are not recreated.
  await knex.raw("ALTER TABLE notification_prefs ALTER COLUMN seasonal_channel SET DEFAULT 'email'");
};
