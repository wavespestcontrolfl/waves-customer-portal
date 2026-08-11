// Call-attribution provenance: which call_log row created a lead's funnel
// row. The google-call bridge's repoint reconciliation must identify THE
// EXACT row this call's attribution created — a settled stamp repointed (or
// cleared) by a later force-reprocess moves the call's paid attribution to
// a different lead (or none), and a heuristic fingerprint (lead + source +
// date + absent click ids) could delete a same-day row another paid call
// legitimately owns, or miss a row lead-funnel-bridge already advanced past
// funnel_stage='lead' (codex P1, PR #3303). Nullable and forward-only:
// pre-existing rows keep NULL and are conservatively never reconciled; the
// bridge also backfills the stamp onto an existing row on its next pass.
// FK with ON DELETE SET NULL so purging call history never breaks funnel
// analytics.
exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('ad_service_attribution');
  if (!has) return;
  const hasCol = await knex.schema.hasColumn('ad_service_attribution', 'source_call_id');
  if (hasCol) return;
  await knex.schema.alterTable('ad_service_attribution', (t) => {
    t.uuid('source_call_id').references('id').inTable('call_log').onDelete('SET NULL');
  });
  // UNIQUE (pre-push P1 r17): source_call_id is documented and queried as
  // identifying THE exact row a call created — concurrent attribution
  // attempts targeting different leads must not insert two rows for one
  // call (recovery reads .first() and the twin double-counts). A violation
  // surfaces as an insert error recordCallPpcAttribution already catches.
  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS ad_service_attribution_source_call_index ON ad_service_attribution (source_call_id) WHERE source_call_id IS NOT NULL',
  );
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('ad_service_attribution');
  if (!has) return;
  const hasCol = await knex.schema.hasColumn('ad_service_attribution', 'source_call_id');
  if (!hasCol) return;
  await knex.raw('DROP INDEX IF EXISTS ad_service_attribution_source_call_index');
  await knex.schema.alterTable('ad_service_attribution', (t) => {
    t.dropColumn('source_call_id');
  });
};
