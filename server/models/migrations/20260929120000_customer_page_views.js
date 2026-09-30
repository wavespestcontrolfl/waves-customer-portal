/**
 * customer_page_views — one row per real customer open of a token page.
 *
 * Shared by every page that records views through
 * server/services/customer-page-views.js: the token pages (appointment,
 * reschedule, reservice, secure-card, track, inspection) and, in later PRs,
 * the portal ('portal:<route>') and the activity timeline.
 *
 * `page` is deliberately free text, not an enum or CHECK: a new page adds a
 * new value with no migration. `subject_type` / `subject_id` name what the
 * page was about (scheduled_service, customer, lead, ...) and are text so a
 * non-uuid subject never needs a schema change. customer_id is nullable (a
 * lead's inspection page has no customer yet) and cascades on delete so a
 * hard customer erase removes their view trail.
 *
 * ip_hash is a sha256 of the client IP (same as short_code_clicks) — a
 * distinct-viewer signal without storing the address itself.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('customer_page_views')) return;
  await knex.schema.createTable('customer_page_views', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('CASCADE');
    t.text('page').notNullable();
    t.text('subject_type');
    t.text('subject_id');
    t.text('ip_hash');
    t.text('user_agent');
    t.timestamp('viewed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(
    'CREATE INDEX customer_page_views_customer_viewed_idx ON customer_page_views (customer_id, viewed_at DESC)',
  );
  await knex.raw(
    'CREATE INDEX customer_page_views_subject_idx ON customer_page_views (subject_type, subject_id)',
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('customer_page_views');
};
