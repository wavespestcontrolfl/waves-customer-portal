/**
 * Customer self-serve re-service token on customers.
 *
 * Backs the /reservice/:token public page — a standing, shareable link that
 * lets an ACTIVE recurring / WaveGuard customer book their free between-visit
 * re-service callback (pest_re_service / lawn_re_service) themselves, using
 * the same route-aware availability engine the public /book funnel and the
 * /reschedule/:token page run on.
 *
 * Mirrors the reschedule_token shape from 20260702000010 (which itself
 * mirrors track_view_token), but keyed on CUSTOMERS, not scheduled_services:
 * a re-service is a NEW visit, so there is no appointment row to hang a
 * token off until the customer books one.
 *   - 64-char hex bearer token (encode(gen_random_bytes(32), 'hex'))
 *   - unique partial index (legacy NULL rows exempt)
 *   - column DEFAULT so every future INSERT auto-generates one — no INSERT
 *     callsite has to remember to set it
 *   - backfill for every live (non-deleted) customer row: unlike the
 *     appointment token there is no date horizon to scope by — the link is
 *     standing for the life of the customer, like customer_cards.share_token
 *
 * No expires_at column: link validity derives from the customer's LIVE plan
 * state (the /api/public/reservice/:token route re-checks active recurring
 * coverage on every request), so a lapsed customer's old text renders the
 * friendly not-eligible state instead of a dead link, and a win-back
 * customer's link starts working again by itself.
 */

exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  await knex.raw(
    'ALTER TABLE customers ADD COLUMN IF NOT EXISTS reservice_token varchar(64)'
  );

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_reservice_token
      ON customers (reservice_token)
      WHERE reservice_token IS NOT NULL
  `);

  await knex.raw(`
    UPDATE customers
       SET reservice_token = encode(gen_random_bytes(32), 'hex')
     WHERE reservice_token IS NULL
       AND deleted_at IS NULL
  `);

  await knex.raw(`
    ALTER TABLE customers
      ALTER COLUMN reservice_token
      SET DEFAULT encode(gen_random_bytes(32), 'hex')
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_customers_reservice_token');
  await knex.raw('ALTER TABLE customers DROP COLUMN IF EXISTS reservice_token');
};
