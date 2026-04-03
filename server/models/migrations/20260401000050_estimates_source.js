/**
 * Migration 050 — Add source tracking to estimates
 */
exports.up = async function (knex) {
  const cols = await knex('estimates').columnInfo();
  await knex.schema.alterTable('estimates', t => {
    if (!cols.source) t.string('source').defaultTo('manual'); // manual, lead_webhook, voice_agent, self_booked
    if (!cols.service_interest) t.text('service_interest');
    if (!cols.lead_source) t.string('lead_source'); // google_ads, organic, referral, domain_website
    if (!cols.lead_source_detail) t.string('lead_source_detail');
    if (!cols.urgency) t.integer('urgency');
    if (!cols.is_priority) t.boolean('is_priority').defaultTo(false);
  });
};

exports.down = async function (knex) {
  const cols = await knex('estimates').columnInfo();
  await knex.schema.alterTable('estimates', t => {
    if (cols.source) t.dropColumn('source');
    if (cols.service_interest) t.dropColumn('service_interest');
    if (cols.lead_source) t.dropColumn('lead_source');
    if (cols.lead_source_detail) t.dropColumn('lead_source_detail');
    if (cols.urgency) t.dropColumn('urgency');
    if (cols.is_priority) t.dropColumn('is_priority');
  });
};
