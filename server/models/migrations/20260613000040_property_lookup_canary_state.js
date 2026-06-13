/**
 * Per-check state for the property-lookup parser canary.
 *
 * The canary used to raise an admin notification on EVERY failing check,
 * including the transient county-site blips (a 20s fetch timeout, a momentary
 * empty response) that its own throw/no-record path already flags as
 * "watch tomorrow, not act now". Two consecutive nights of Sarasota PAO
 * slowness (2026-06-12/13) paged the owner twice for what a live re-run
 * proved was a healthy parser — exactly the noise this table removes.
 *
 * It mirrors the consecutive-failure escalation event-source-health.js uses
 * for the newsletter scrapers: count "can't reach the data" failures per
 * check, stay silent until a check has failed N nights in a row, then raise
 * ONE notification (plus a weekly re-ping while still broken). Genuine parser
 * regressions — a record returns but a surface that used to parse is gone, or
 * FDOR resolves to the wrong parcel id — still alert on the first run and
 * never touch this counter.
 *
 *   check_key            — stable id per canary check: 'fdor_point' or
 *                          'golden:<County>'.
 *   consecutive_failures — transient ("can't reach the data") failures in a
 *                          row; reset to 0 on any run that reaches the data
 *                          (a clean pass OR a regression).
 *   last_status          — 'ok' | 'transient' | 'regression' from the last run.
 *   last_detail          — most recent failure text (county-only, PII-safe —
 *                          never the lookup URL/parcel; same rule as the alert).
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('property_lookup_canary_state')) return;
  await knex.schema.createTable('property_lookup_canary_state', (t) => {
    t.text('check_key').primary();
    t.integer('consecutive_failures').notNullable().defaultTo(0);
    t.text('last_status');
    t.text('last_detail');
    t.timestamp('last_run_at', { useTz: true });
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('property_lookup_canary_state');
};
