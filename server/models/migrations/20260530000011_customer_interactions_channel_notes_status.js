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
 * affect existing rows, reads, or queries. up() only adds the columns that are
 * missing, so it is idempotent.
 *
 * Forward-only repair: down() is an intentional no-op. `channel`/`status` are
 * columns the write path requires; dropping them on rollback would re-break
 * every interaction insert, and in a partially-applied / migration-corrupt
 * environment a blind drop could remove a column this migration never created.
 * (No environment had these columns before this migration ran.)
 */

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
};

exports.down = async function down() {
  // Intentional no-op — see header. Forward-only additive repair.
};
