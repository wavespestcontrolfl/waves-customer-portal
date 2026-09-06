// The wizard-dedupe marker (leads.extracted_data->>'duplicate_of_lead_id',
// #3834) is walked from the root DOWN by the prospect scope
// (lead-statuses.js wonDescendantSql — an open root with a live won repeat
// counts once) and from the repeat UP by the staleness sweep; the downward
// join is a plain text comparison on the key so this expression index
// serves it instead of a per-row scan of leads. Partial: only rows that
// carry the marker (server-filed repeats) are indexed.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('leads'))) return;
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_leads_duplicate_marker
    ON leads ((extracted_data->>'duplicate_of_lead_id'))
    WHERE (extracted_data->>'duplicate_of_lead_id') IS NOT NULL`);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_leads_duplicate_marker');
};
