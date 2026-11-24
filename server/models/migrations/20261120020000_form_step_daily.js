/**
 * form_step_daily — anonymous, cookie-free quote-form and quiz step counts
 * (owner *build* 2026-11-19, quiz funnel scope; a near copy of
 * blog_read_depth_daily).
 *
 * One row per (day, site, form, step); `count` is incremented in place by
 * the route's upsert (INSERT ... ON CONFLICT DO UPDATE SET count = count +
 * 1). `day` is the America/New_York calendar day the beacon landed on,
 * computed in SQL by the writer — never derived from request data, and never
 * a per-visitor identifier of any kind (see server/routes/
 * public-form-steps.js and docs/public-route-contracts.md).
 *
 * No created_at / updated_at: the table holds daily totals only. A
 * timestamp would record when a bucket's first or latest event landed, and
 * for a bucket of one `lead` that is the time of that lead.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('form_step_daily', (t) => {
    t.date('day').notNullable();
    t.text('site').notNullable();
    t.text('form').notNullable();
    t.text('step').notNullable();
    t.integer('count').notNullable().defaultTo(0);
    t.primary(['day', 'site', 'form', 'step']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('form_step_daily');
};
