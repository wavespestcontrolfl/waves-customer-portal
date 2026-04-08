exports.up = async function(knex) {
  const hasGclid = await knex.schema.hasColumn('leads', 'gclid');
  const hasCampaignId = await knex.schema.hasColumn('leads', 'google_campaign_id');
  const hasAdGroupId = await knex.schema.hasColumn('leads', 'google_ad_group_id');
  const hasKeyword = await knex.schema.hasColumn('leads', 'google_keyword');

  await knex.schema.alterTable('leads', (table) => {
    if (!hasGclid) table.string('gclid', 200).nullable();
    if (!hasCampaignId) table.string('google_campaign_id', 100).nullable();
    if (!hasAdGroupId) table.string('google_ad_group_id', 100).nullable();
    if (!hasKeyword) table.string('google_keyword', 200).nullable();
  });
};

exports.down = async function(knex) {
  await knex.schema.alterTable('leads', (table) => {
    table.dropColumn('gclid');
    table.dropColumn('google_campaign_id');
    table.dropColumn('google_ad_group_id');
    table.dropColumn('google_keyword');
  });
};
