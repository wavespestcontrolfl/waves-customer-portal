/**
 * Native iOS (APNs) push support on push_subscriptions.
 *
 * The table (20260401000031_pwa_push.js) was built for web-push, where the
 * whole PushSubscription lives in `subscription_data`. Native iOS pushes via
 * APNs with a raw device token instead, so we add:
 *   - platform     : 'web' (existing rows) | 'ios'
 *   - device_token : the raw APNs hex token (queryable; also mirrored into
 *                    subscription_data as JSON so the NOT NULL stays satisfied)
 * Web rows are untouched (platform defaults to 'web').
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('push_subscriptions', (t) => {
    t.string('platform', 10).notNullable().defaultTo('web');
    t.text('device_token');
  });
  // Dedup re-registrations of the same device. NON-partial on purpose: Postgres
  // treats NULLs as distinct in a unique index (default NULLS DISTINCT), so the
  // many web rows with device_token IS NULL never collide, while ios tokens stay
  // unique. A partial index (WHERE device_token IS NOT NULL) could NOT be
  // inferred by the `ON CONFLICT (device_token)` upsert in routes/push.js
  // without repeating the predicate — which would make every native-subscribe
  // fail "no unique or exclusion constraint matching the ON CONFLICT".
  await knex.schema.raw(
    `CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_device_token_uniq
     ON push_subscriptions (device_token)`
  );
};

exports.down = async function (knex) {
  await knex.schema.raw('DROP INDEX IF EXISTS push_subscriptions_device_token_uniq');
  await knex.schema.alterTable('push_subscriptions', (t) => {
    t.dropColumn('platform');
    t.dropColumn('device_token');
  });
};
