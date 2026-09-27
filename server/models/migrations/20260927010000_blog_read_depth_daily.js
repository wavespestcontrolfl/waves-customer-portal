/**
 * blog_read_depth_daily — anonymous, cookie-free blog scroll-depth counts
 * (owner-approved 2026-09-27, "E2: cookie-free read-depth counts").
 *
 * One row per (day, site, path, milestone); `count` is incremented in place
 * by the route's upsert (INSERT ... ON CONFLICT DO UPDATE SET count =
 * count + 1). `day` is the America/New_York calendar day the beacon landed
 * on, computed in SQL by the writer — never derived from request data, and
 * never a per-visitor identifier of any kind (see server/routes/
 * public-blog-read-depth.js and docs/public-route-contracts.md).
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('blog_read_depth_daily', (t) => {
    t.date('day').notNullable();
    t.text('site');
    t.text('path');
    t.text('milestone');
    t.integer('count').notNullable().defaultTo(0);
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.primary(['day', 'site', 'path', 'milestone']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('blog_read_depth_daily');
};
