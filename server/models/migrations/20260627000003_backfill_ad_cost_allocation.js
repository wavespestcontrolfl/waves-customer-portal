/**
 * Backfill ad_service_attribution.ad_cost from historical ad spend.
 *
 * Going forward the daily 6:25am cron recomputes the trailing window after the
 * ad syncs. This one-time pass allocates ALL historical paid-channel spend
 * (ad_performance_daily) across that channel-month's leads, so the /admin/ads
 * CAC / ROAS / LTV:CAC views read real numbers for past periods too.
 *
 * Idempotent / re-runnable: allocateAdCosts recomputes from current spend + lead
 * counts. down() is a no-op — this is a data backfill, not a schema change.
 */

const { allocateAdCosts } = require('../../services/ad-cost-allocation');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('ad_service_attribution'))) return;
  await allocateAdCosts(knex); // no sinceDate → all-time
};

exports.down = async function down() {
  // Data backfill only; nothing to reverse.
};
