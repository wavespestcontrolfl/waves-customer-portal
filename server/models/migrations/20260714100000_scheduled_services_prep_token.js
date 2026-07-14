/**
 * Prep tokens for scheduled-service-based prep sends.
 *
 * The booking-triggered (appointment-tagger) and manual (Communications
 * "Send prep") prep emails operate on scheduled_services rows with no
 * project attached, so the project-scoped prep_token never applied to them
 * and their {{prep_url}} CTA fell back to the login-gated portal visits
 * tab. Mirror the projects prep columns onto scheduled_services so those
 * sends can link the public /prep/:token page too.
 *
 * prep_guide_views grows a nullable scheduled_service_id (and project_id
 * relaxes to nullable) so both token owners share the analytics table —
 * exactly one of the two is set per row. The table is empty in prod as of
 * 2026-07-14, so relaxing the constraint rewrites nothing.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('scheduled_services')) {
    const [hasToken, hasKey, hasExpires, hasFirstViewed, hasViewCount] = await Promise.all([
      knex.schema.hasColumn('scheduled_services', 'prep_token'),
      knex.schema.hasColumn('scheduled_services', 'prep_template_key'),
      knex.schema.hasColumn('scheduled_services', 'prep_expires_at'),
      knex.schema.hasColumn('scheduled_services', 'prep_first_viewed_at'),
      knex.schema.hasColumn('scheduled_services', 'prep_view_count'),
    ]);
    if (!hasToken || !hasKey || !hasExpires || !hasFirstViewed || !hasViewCount) {
      await knex.schema.alterTable('scheduled_services', (t) => {
        if (!hasToken) t.string('prep_token', 32).nullable().unique();
        if (!hasKey) t.string('prep_template_key', 64).nullable();
        if (!hasExpires) t.timestamp('prep_expires_at').nullable();
        if (!hasFirstViewed) t.timestamp('prep_first_viewed_at').nullable();
        if (!hasViewCount) t.integer('prep_view_count').defaultTo(0);
      });
    }
  }

  if (await knex.schema.hasTable('prep_guide_views')) {
    const hasServiceId = await knex.schema.hasColumn('prep_guide_views', 'scheduled_service_id');
    if (!hasServiceId) {
      await knex.schema.alterTable('prep_guide_views', (t) => {
        t.uuid('scheduled_service_id').nullable()
          .references('id').inTable('scheduled_services').onDelete('CASCADE');
        t.uuid('project_id').nullable().alter();
        t.index(['scheduled_service_id', 'viewed_at']);
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('prep_guide_views')) {
    if (await knex.schema.hasColumn('prep_guide_views', 'scheduled_service_id')) {
      await knex('prep_guide_views').whereNull('project_id').del();
      await knex.schema.alterTable('prep_guide_views', (t) => {
        t.dropIndex(['scheduled_service_id', 'viewed_at']);
        t.dropColumn('scheduled_service_id');
        t.uuid('project_id').notNullable().alter();
      });
    }
  }

  if (await knex.schema.hasTable('scheduled_services')) {
    const columns = ['prep_token', 'prep_template_key', 'prep_expires_at', 'prep_first_viewed_at', 'prep_view_count'];
    const present = await Promise.all(columns.map((c) => knex.schema.hasColumn('scheduled_services', c)));
    if (present.some(Boolean)) {
      await knex.schema.alterTable('scheduled_services', (t) => {
        columns.forEach((c, i) => { if (present[i]) t.dropColumn(c); });
      });
    }
  }
};
