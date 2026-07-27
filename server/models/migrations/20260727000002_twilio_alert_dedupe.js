/**
 * Dedicated dedupe state for Twilio failure alerts (bell audit 07-24,
 * #2994 follow-up).
 *
 * The previous dedupe read the last 24h of `notifications` rows back by
 * `metadata->'payload'->>'dedupeKey'`, which broke three ways at once:
 * it raced concurrent failures (both readers see "no row", both alert),
 * it silently disabled dedupe whenever no admin had bell_enabled (no row
 * ever written to read back), and the payload sanitizer could mangle the
 * stored key so it never matched again. A dedicated table with an atomic
 * claim retires all three.
 *
 * One row per hashed dedupe key (`twilio:<16-hex>` — never a raw phone
 * number). `last_alerted_at` is the start of the current alert window;
 * the claim statement is a single INSERT ... ON CONFLICT DO UPDATE ...
 * WHERE outside-window ... RETURNING, so exactly one concurrent caller
 * wins the window. Rows are pruned opportunistically by the service.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('twilio_alert_dedupe')) return;

  await knex.schema.createTable('twilio_alert_dedupe', (t) => {
    t.text('dedupe_key').primary();
    t.timestamp('last_alerted_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  // Prune query is "delete rows whose window ended long ago".
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_twilio_alert_dedupe_last_alerted ON twilio_alert_dedupe(last_alerted_at)'
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('twilio_alert_dedupe'))) return;
  await knex.raw('DROP INDEX IF EXISTS idx_twilio_alert_dedupe_last_alerted');
  await knex.schema.dropTable('twilio_alert_dedupe');
};
