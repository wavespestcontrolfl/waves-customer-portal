/**
 * ad_service_attribution.lead_id — link a funnel row to the specific lead.
 *
 * The table previously keyed attribution only by customer_id, so a customer with
 * two Google Ads leads on the same day (e.g. a web form AND a phone call) could
 * not be told apart. Call attribution now writes/dedupes by lead_id (one funnel
 * row per lead), which both distinguishes separate paid-call leads and makes the
 * bridge re-run / dedicated-number paths idempotent on the same call.
 *
 * Nullable + onDelete SET NULL: existing web rows (which never set it) stay
 * lead_id NULL and are unaffected.
 *
 * UNIQUE index (not plain): enforces at most one funnel row per lead, so two
 * overlapping call-bridge/apply requests can't both insert a row for the same
 * lead (recordCallPpcAttribution also uses ON CONFLICT (lead_id) DO NOTHING).
 * Postgres treats NULLs as distinct, so the many NULL-lead_id web rows are
 * unaffected — only non-null lead_ids are deduped.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('ad_service_attribution');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('ad_service_attribution', 'lead_id');
  if (hasColumn) return;
  await knex.schema.alterTable('ad_service_attribution', (t) => {
    t.uuid('lead_id').references('id').inTable('leads').onDelete('SET NULL');
    t.unique('lead_id', { indexName: 'uq_ad_service_attribution_lead' });
  });
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('ad_service_attribution');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('ad_service_attribution', 'lead_id');
  if (!hasColumn) return;
  await knex.schema.alterTable('ad_service_attribution', (t) => {
    t.dropColumn('lead_id');
  });
};
