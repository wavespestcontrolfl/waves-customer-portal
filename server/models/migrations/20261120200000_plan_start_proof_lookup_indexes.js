// Two lookups of the plan start proof (server/services/plan-start-eligibility.js)
// had no index to answer them. Neither index changes a query or a result.
//
// 1. day_agreement_decisions_customer_id_index: the proof reads the
//    day-agreement decisions of one account by customer_id
//    (hasCommercialDayAgreement). The table had indexes on id, source_key and
//    created_at only (20261020010000), so each account asked read every
//    decision.
// 2. scheduled_service_addons_scheduled_service_id_index: the proof joins the
//    visits of one account to their add-ons (hasCommercialAddon), and the
//    table had its primary key only (20260401000106). The index also serves
//    the foreign key's cascade and every other read of a visit's add-ons.
//
// The proof has no caller yet. The offer job that will call it asks once for
// each candidate account, so both indexes are in place before that job exists.
// Both tables are small (production, 2026-11-20: 240 and 52 rows), so a plain
// CREATE INDEX inside the migration's transaction holds its lock for
// milliseconds.
const INDEXES = [
  ['day_agreement_decisions', 'customer_id', 'day_agreement_decisions_customer_id_index'],
  ['scheduled_service_addons', 'scheduled_service_id', 'scheduled_service_addons_scheduled_service_id_index'],
];

exports.up = async function up(knex) {
  for (const [table, column, indexName] of INDEXES) {
    if (!(await knex.schema.hasTable(table)) || !(await knex.schema.hasColumn(table, column))) continue;
    await knex.raw('CREATE INDEX IF NOT EXISTS ?? ON ?? (??)', [indexName, table, column]);
  }
};

exports.down = async function down(knex) {
  for (const [, , indexName] of [...INDEXES].reverse()) {
    await knex.raw('DROP INDEX IF EXISTS ??', [indexName]);
  }
};
