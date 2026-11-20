// Pre-push audit r26 on the repeat silent caller rule (GATE_MISSED_CALL_SPAM_REPEAT):
// the footprint's number (missed-call-bell.js FOOTPRINT_PHONE_SQL) now also removes
// an `extn`, a `;ext=` or `ext-` extension and any text after its digits, and takes
// at most 6 extension digits, so `Fax: 7275550611` keeps its number.
// 20261120020000 was pushed with the earlier expression and is not edited (a pushed
// migration is frozen), so this migration replaces its 10 indexes with ones on the new
// expression. The expression MUST match FOOTPRINT_PHONE_SQL character for character,
// or the planner will not use the index. Knex reads ? as a binding, so the patterns
// write {0,1}. Each table holds under 2,000 rows (20261120020000), so a plain CREATE
// INDEX inside the migration's transaction blocks writes to it for milliseconds.
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
const earlierName = (table, column) => `${table}_${column}_footprint_index`;
const indexName = (table, column) => `${table}_${column}_footprint_ext_index`;
// 20261120020000's pattern, for down().
const EARLIER_PATTERN = "'\\s*(ext(ension){0,1}\\.{0,1}|x|#)\\s*:{0,1}\\s*\\d+\\s*$'";
const PATTERN = "'\\s*(ext(ension|n){0,1}\\.{0,1}|x|#)\\s*[:=.-]{0,1}\\s*\\d{1,6}\\D*$'";
const createIndex = (pattern) => `CREATE INDEX IF NOT EXISTS ?? ON ?? ((right(regexp_replace(regexp_replace(??, ${pattern}, '', 'i'), '\\D', '', 'g'), 10)))`;

async function hasColumn(knex, table, column) {
  return (await knex.schema.hasTable(table)) && knex.schema.hasColumn(table, column);
}

exports.up = async function up(knex) {
  for (const [table, column] of INDEXED) {
    await knex.raw('DROP INDEX IF EXISTS ??', [earlierName(table, column)]);
    if (!(await hasColumn(knex, table, column))) continue;
    await knex.raw(createIndex(PATTERN), [indexName(table, column), table, column]);
  }
};

// Back to 20261120020000's indexes.
exports.down = async function down(knex) {
  for (const [table, column] of [...INDEXED].reverse()) {
    await knex.raw('DROP INDEX IF EXISTS ??', [indexName(table, column)]);
    if (!(await hasColumn(knex, table, column))) continue;
    await knex.raw(createIndex(EARLIER_PATTERN), [earlierName(table, column), table, column]);
  }
};
