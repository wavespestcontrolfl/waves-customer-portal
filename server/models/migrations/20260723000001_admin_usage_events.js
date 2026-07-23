/**
 * admin_usage_events — first-party page-view log for the admin portal.
 *
 * Answers "which admin surfaces get used on a regular recurring basis" so
 * the owner can arrange the dashboard/nav around real usage. PostHog is
 * deliberately never initialized on /admin (privacy gate in
 * client/src/lib/analytics/posthog.js), so this table is the only
 * navigation record. Rows carry NO customer data: normalized page keys and
 * ID-stripped path patterns only — never query strings or free text.
 *
 * Writes flow through POST /api/admin/usage/track (admin-authenticated,
 * fire-and-forget from AdminLayoutV2); reads through
 * GET /api/admin/usage/summary. Volume is tiny (2–3 staff), so no
 * retention/partitioning concerns.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('admin_usage_events');
  if (has) return;

  await knex.raw('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  await knex.schema.createTable('admin_usage_events', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    t.uuid('technician_id').notNullable().references('id').inTable('technicians');
    t.string('event_type', 24).notNullable().defaultTo('page_view');
    // First path segment after /admin ('dashboard', 'customers', …).
    t.string('page_key', 64).notNullable();
    // ID-stripped route pattern ('/admin/customers/:id'), no query/hash.
    t.string('path', 160);
    // Sanitized ?tab= value when present ('leads', 'board', …).
    t.string('tab', 32);
    // How the page was reached: sidebar | tabbar | more | palette | load | in-app.
    t.string('source', 24);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.index(['technician_id', 'created_at']);
    t.index(['page_key', 'created_at']);
    t.index(['created_at']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('admin_usage_events');
};
