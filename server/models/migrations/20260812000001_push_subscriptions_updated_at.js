/**
 * push_subscriptions.updated_at — the device heartbeat column.
 *
 * The native-subscribe upsert bumps it on every app launch (registration
 * re-fires per session), and push-channel-routing requires a heartbeat
 * inside 72h before a push_first send may replace an SMS: provider
 * acceptance proves APNs/FCM took the request, not that the OS displayed
 * it, so "the app was recently open under intact permission" is the
 * missing half of delivery confidence.
 *
 * Backfill = created_at ON PURPOSE (not now()): existing rows must read as
 * STALE until their app actually launches again — backfilling now() would
 * grant every historical token, including long-uninstalled ones, a fresh
 * 72-hour window of SMS-suppressing trust it never earned.
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('push_subscriptions', 'updated_at');
  if (!has) {
    await knex.schema.alterTable('push_subscriptions', (t) => {
      t.timestamp('updated_at').defaultTo(knex.fn.now());
    });
    await knex('push_subscriptions').update({ updated_at: knex.ref('created_at') });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('push_subscriptions', 'updated_at');
  if (has) {
    await knex.schema.alterTable('push_subscriptions', (t) => t.dropColumn('updated_at'));
  }
};
