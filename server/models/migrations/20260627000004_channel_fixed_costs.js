/**
 * Per-channel fixed acquisition costs — the non-ad-platform side of "all-in CAC".
 *
 * ad_performance_daily covers paid-platform spend, but the true cost to acquire
 * also includes fixed monthly costs that don't flow through the ad platforms:
 * an SEO retainer (organic), an ad-management fee (google_ads), tooling, etc.
 * Those live in a separate system (lead_source_costs, keyed to lead_sources rows
 * resolved by phone/domain) that does NOT map to the ad-attribution channel
 * vocabulary — and has no Google Ads row at all. So this is keyed directly by the
 * SAME channel string the ads views use (lead_source: google_ads / google_lsa /
 * organic / facebook / …), one current monthly amount per channel.
 *
 * A period's fixed cost = monthly_amount × months in the window; folded into the
 * channel's all-in spend alongside ad_performance_daily spend.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('channel_fixed_costs')) return;
  await knex.schema.createTable('channel_fixed_costs', (t) => {
    t.increments('id').primary();
    t.string('channel', 50).notNullable().unique(); // lead_source vocab: google_ads / organic / facebook / …
    t.decimal('monthly_amount', 10, 2).notNullable().defaultTo(0); // current fixed cost per month
    t.text('note');
    t.timestamps(true, true);
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('channel_fixed_costs');
};
