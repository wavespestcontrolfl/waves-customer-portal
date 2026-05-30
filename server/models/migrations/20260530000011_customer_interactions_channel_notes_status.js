/**
 * Add the `channel` and `status` columns that the CRM-interaction write path
 * has assumed for a long time but that `customer_interactions` (created in
 * 20260401000023_crm.js with only interaction_type/subject/body/metadata)
 * never actually had.
 *
 * 13 insert sites across the workflow engine, lead attribution, health alerts,
 * invoice follow-ups and renewal/account/payment emails write `channel` and/or
 * `status`. Every one threw `column "channel" does not exist` and the row was
 * silently dropped — the automated customer-interaction timeline recorded
 * nothing. (The descriptive text those inserts used to put in a non-existent
 * `notes` column is written to the existing `body` column in the companion
 * code change, so the timeline/profile readers — which render `body` — show
 * it; that's why no `notes` column is added here.)
 *
 * Both columns are nullable with no default: a metadata-only ALTER that cannot
 * affect existing rows, reads, or queries.
 *
 * Idempotent: up() only adds columns that are missing and tags each one it
 * adds with a column comment, so down() drops ONLY the columns this migration
 * created — never a pre-existing column in a partially-applied environment.
 */

const REPAIR_TAG = 'repair:20260530000011';
const COLUMNS = ['channel', 'status'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_interactions'))) return;

  const toAdd = [];
  for (const c of COLUMNS) {
    if (!(await knex.schema.hasColumn('customer_interactions', c))) toAdd.push(c);
  }
  if (!toAdd.length) return;

  await knex.schema.alterTable('customer_interactions', (t) => {
    if (toAdd.includes('channel')) t.string('channel', 30); // 'sms' | 'email' | 'voice' | 'internal' | 'lead_source'
    if (toAdd.includes('status')) t.string('status', 30); // 'pending' | 'completed' | 'opted_in' | ...
  });

  // Mark the columns THIS migration added so the rollback can't drop a column
  // that already existed before the repair ran.
  for (const c of toAdd) {
    await knex.raw('COMMENT ON COLUMN customer_interactions.?? IS ?', [c, REPAIR_TAG]);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_interactions'))) return;

  const toDrop = [];
  for (const c of COLUMNS) {
    if (!(await knex.schema.hasColumn('customer_interactions', c))) continue;
    const res = await knex.raw(
      "SELECT col_description('customer_interactions'::regclass, a.attnum) AS comment "
      + 'FROM pg_attribute a '
      + "WHERE a.attrelid = 'customer_interactions'::regclass AND a.attname = ?",
      [c],
    );
    if (res.rows && res.rows[0] && res.rows[0].comment === REPAIR_TAG) toDrop.push(c);
  }
  if (!toDrop.length) return;

  await knex.schema.alterTable('customer_interactions', (t) => {
    for (const c of toDrop) t.dropColumn(c);
  });
};
