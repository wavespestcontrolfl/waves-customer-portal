/**
 * Outbound link click tracking for customer prep guides (GATE_OUTLINK_TRACKING).
 *
 * outbound_links: the ONLY destinations /go/:code will ever redirect to. A row
 * is a registered outside URL (Amazon, Chewy, Elanco, ...) keyed by a code that
 * is derived from the URL itself, so registering the same link twice is one row.
 * The redirect route resolves by code alone and never accepts a URL from the
 * request, which is what keeps it from being an open redirect.
 *
 * outbound_link_clicks: one row per HUMAN click (bot/preview UAs get none,
 * same filter as short_code_clicks). Attribution columns are filled only when
 * the click URL carried a valid signed context; ip_hash is a sha256, never a
 * raw address.
 *
 * No content change: template versions are untouched. Links are rewritten at
 * render time only, and only while the gate is on.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('outbound_links'))) {
    await knex.schema.createTable('outbound_links', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('code', 32).notNullable().unique();
      t.text('target_url').notNullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
  }

  if (!(await knex.schema.hasTable('outbound_link_clicks'))) {
    await knex.schema.createTable('outbound_link_clicks', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('outbound_link_id').notNullable()
        .references('id').inTable('outbound_links').onDelete('CASCADE');
      t.timestamp('clicked_at').notNullable().defaultTo(knex.fn.now());
      // Prep template key ('prep.flea') the link was rendered from.
      t.string('template_key', 80);
      // Where it was rendered: 'email' | 'page'.
      t.string('surface', 16);
      t.uuid('scheduled_service_id')
        .references('id').inTable('scheduled_services').onDelete('SET NULL');
      t.uuid('project_id')
        .references('id').inTable('projects').onDelete('SET NULL');
      t.uuid('customer_id')
        .references('id').inTable('customers').onDelete('SET NULL');
      // sha256 hex of the client IP — never the raw IP.
      t.string('ip_hash', 64);
      t.text('user_agent');
      t.index(['outbound_link_id', 'clicked_at']);
      t.index(['customer_id']);
      t.index(['clicked_at']);
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('outbound_link_clicks');
  await knex.schema.dropTableIfExists('outbound_links');
};
