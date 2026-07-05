/**
 * message_drafts → campaign dimension (existing-customer campaign drafts V1).
 *
 * The campaign lane writes owner-approval drafts instead of auto-sending:
 *   campaign_type  which campaign wrote the draft ('reactivation' | 'upsell';
 *                  NULL = legacy inbound-reply / non-campaign draft)
 *   purpose        messaging-policy purpose the approve route must send under
 *                  (e.g. 'marketing'). NULL = legacy behavior (audience 'lead',
 *                  purpose 'conversational') — the inbound-reply lane is
 *                  unchanged.
 *   source_ref     provenance pointer, 'table:id' (e.g. 'upsell_opportunities:123',
 *                  'customers:456') — used for never-re-pitch dedupe.
 *
 * Index on (campaign_type, status) serves the campaign approval queue and the
 * generator's cooldown lookups.
 */
exports.up = async function (knex) {
  const cols = await knex('message_drafts').columnInfo();
  await knex.schema.alterTable('message_drafts', (t) => {
    if (!cols.campaign_type) t.string('campaign_type', 30);
    if (!cols.purpose) t.string('purpose', 40);
    if (!cols.source_ref) t.string('source_ref', 120);
  });

  await knex.raw(
    'CREATE INDEX IF NOT EXISTS message_drafts_campaign_status_idx ON message_drafts (campaign_type, status)'
  );
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS message_drafts_campaign_status_idx');

  const cols = await knex('message_drafts').columnInfo();
  await knex.schema.alterTable('message_drafts', (t) => {
    if (cols.campaign_type) t.dropColumn('campaign_type');
    if (cols.purpose) t.dropColumn('purpose');
    if (cols.source_ref) t.dropColumn('source_ref');
  });
};
