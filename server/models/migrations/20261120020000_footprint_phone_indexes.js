// Pre-push audit r23 on the repeat silent caller rule (GATE_MISSED_CALL_SPAM_REPEAT):
// the record check (missed-call-bell.js whereNoFootprint) proves a number has no row
// in any table with a phone column, so the absence case reads every such table. Same
// remedy as 20260927000006 (outbound return-message probes): an expression index the
// planner can match, here on the phone columns of the footprint tables that hold the
// most rows and grow with customers. Production, 2026-11-19: customers 1,735 rows,
// customer_accounts 1,716, property_preferences 1,698, estimates 1,294, leads 1,099;
// the 48 footprint tables hold 11,190 rows, 4,258 of them created in the last 90 days.
// The expression MUST match FOOTPRINT_PHONE_SQL in missed-call-bell.js character for
// character, or the planner will not use the index: a conventional extension suffix
// removed (pre-push audit r24), then the last 10 digits. It differs from
// 20260927000006's leads_phone_last10_index, so leads.phone gets its own here. Knex
// reads ? as a binding, so the pattern writes {0,1}.
// Each table holds under 2,000 rows, so a plain CREATE INDEX (as in 20260927000006,
// inside the migration's transaction) blocks writes to it for milliseconds.
const INDEXED = [
  ['customers', 'phone'],
  ['customers', 'secondary_phone'],
  ['customers', 'service_contact_phone'],
  ['customers', 'service_contact2_phone'],
  ['customers', 'service_contact3_phone'],
  ['customer_accounts', 'phone'],
  ['property_preferences', 'hoa_phone'],
  ['estimates', 'customer_phone'],
  ['estimates', 'customer_phone_typed'],
  ['leads', 'phone'],
];
const indexName = (table, column) => `${table}_${column}_footprint_index`;

exports.up = async function up(knex) {
  for (const [table, column] of INDEXED) {
    if (!(await knex.schema.hasTable(table)) || !(await knex.schema.hasColumn(table, column))) continue;
    await knex.raw("CREATE INDEX IF NOT EXISTS ?? ON ?? ((right(regexp_replace(regexp_replace(??, '\\s*(ext(ension){0,1}\\.{0,1}|x|#)\\s*:{0,1}\\s*\\d+\\s*$', '', 'i'), '\\D', '', 'g'), 10)))",
      [indexName(table, column), table, column]);
  }
};

exports.down = async function down(knex) {
  for (const [table, column] of [...INDEXED].reverse()) {
    await knex.raw('DROP INDEX IF EXISTS ??', [indexName(table, column)]);
  }
};
