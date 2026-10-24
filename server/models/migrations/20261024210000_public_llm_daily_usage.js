/**
 * Shared daily counters for the public paid-LLM routes
 * (middleware/public-llm-shared-cap.js, GATE_PUBLIC_LLM_SHARED_CAP).
 *
 * Security audit run 2 (2026-10-22): the per-IP daily limiters on Ask Waves and
 * the photo-assessment funnels use express-rate-limit's in-memory store, so
 * their counts are per process, reset on every deploy, and nothing caps the
 * total across IPs. This table holds ONE row per (bucket, Eastern calendar day)
 * so every process shares the same spend ceiling.
 *
 *   bucket      which budget the row counts ('ask-waves', 'photo-assessment')
 *   day         America/New_York calendar date the counted requests arrived on
 *   count       requests counted so far that day (the middleware bumps it with
 *               one atomic INSERT ... ON CONFLICT DO UPDATE ... RETURNING)
 *   updated_at  last bump
 *
 * Holds counters only: no customer data, no IP, no message text. Idempotent
 * create; down() drops the table.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('public_llm_daily_usage')) return;
  await knex.schema.createTable('public_llm_daily_usage', (t) => {
    t.text('bucket').notNullable();
    t.date('day').notNullable();
    t.integer('count').notNullable().defaultTo(0);
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
    t.primary(['bucket', 'day']);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('public_llm_daily_usage');
};
