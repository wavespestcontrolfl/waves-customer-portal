/**
 * How a lead's ad campaign was found (owner 2026-11-23, "lets fix these": ad leads carried a Google click id but no
 * campaign). Written only by services/ads/campaign-link.js, together with campaign_id, on a row whose campaign_id was
 * NULL: 'gclid_click_view' = Google's click record for the click id names the campaign; 'only_campaign_with_spend'
 * = the click is older than Google keeps click records (90 days) and one Google campaign alone had spend that day.
 * NULL = set by another writer (call bridge) or not linked. Nullable, no default, no backfill here.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasColumn('ad_service_attribution', 'campaign_link_basis')) return;
  await knex.schema.alterTable('ad_service_attribution', (t) => {
    t.string('campaign_link_basis', 40);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasColumn('ad_service_attribution', 'campaign_link_basis'))) return;
  await knex.schema.alterTable('ad_service_attribution', (t) => {
    t.dropColumn('campaign_link_basis');
  });
};
