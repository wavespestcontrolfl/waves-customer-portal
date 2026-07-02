/**
 * Customer self-serve reschedule token on scheduled_services.
 *
 * Backs the /reschedule/:token public page linked from appointment
 * confirmation / 72h / 24h reminder texts and reminder emails. Mirrors the
 * track_view_token shape from 20260422000009 + 20260429000002:
 *   - 64-char hex bearer token (encode(gen_random_bytes(32), 'hex'))
 *   - unique partial index (legacy NULL rows exempt)
 *   - column DEFAULT so every future INSERT auto-generates one — no INSERT
 *     callsite has to remember to set it
 *   - backfill for today/future rows, ET-correct date filter (CURRENT_DATE
 *     evaluates in the session TZ — UTC on Railway — and would skip today's
 *     ET services between 8 PM and midnight ET)
 *
 * No expires_at column: link validity derives from the live appointment row
 * (reschedulable status + appointment not yet past), so there is nothing to
 * refresh on reschedule and the same link keeps working for "change it again".
 */

exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  await knex.raw(
    'ALTER TABLE scheduled_services ADD COLUMN IF NOT EXISTS reschedule_token varchar(64)'
  );

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_services_reschedule_token
      ON scheduled_services (reschedule_token)
      WHERE reschedule_token IS NOT NULL
  `);

  await knex.raw(`
    UPDATE scheduled_services
       SET reschedule_token = encode(gen_random_bytes(32), 'hex')
     WHERE reschedule_token IS NULL
       AND scheduled_date >= (NOW() AT TIME ZONE 'America/New_York')::date
  `);

  await knex.raw(`
    ALTER TABLE scheduled_services
      ALTER COLUMN reschedule_token
      SET DEFAULT encode(gen_random_bytes(32), 'hex')
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_scheduled_services_reschedule_token');
  await knex.raw('ALTER TABLE scheduled_services DROP COLUMN IF EXISTS reschedule_token');
};
