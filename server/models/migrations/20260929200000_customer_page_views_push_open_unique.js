/**
 * One push:open row per (customer, push notification), enforced by the database.
 *
 * services/customer-page-views.js dedupes a push open forever with a
 * NOT EXISTS check, which two concurrent beacons for the same notification can
 * both pass. This partial unique index is the real guard; the insert now says
 * ON CONFLICT ... DO NOTHING against it. Scoped to page = 'push:open' with a
 * subject id: token pages and portal tab views legitimately repeat (they dedupe
 * by a time window, not forever) and rows without a subject id are unconstrained.
 *
 * push:open rows are only written behind the dark GATE_PORTAL_ACTIVITY, so none
 * should exist in production. The migration is safe regardless: exact duplicates
 * (same customer, page, subject id) are deleted first, keeping the earliest row
 * (viewed_at, then id), so CREATE UNIQUE INDEX can never fail on old data.
 * The subject-id predicate matches the insert's ON CONFLICT target exactly.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_page_views'))) return;
  await knex.raw(`
    DELETE FROM customer_page_views d
    USING (
      SELECT id, row_number() OVER (
        PARTITION BY customer_id, page, subject_id ORDER BY viewed_at ASC, id ASC
      ) AS rn
      FROM customer_page_views
      WHERE page = 'push:open' AND subject_id IS NOT NULL
    ) ranked
    WHERE d.id = ranked.id AND ranked.rn > 1
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS customer_page_views_push_open_uniq
    ON customer_page_views (customer_id, page, subject_id)
    WHERE page = 'push:open' AND subject_id IS NOT NULL
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS customer_page_views_push_open_uniq');
};
