/**
 * call_commitments.contact_check — the cached verdict of the model that judges
 * whether a person's later delivered text or call back kept a Waves "other"
 * promise made on a call (services/call-commitment-contact-check.js,
 * PROMISE_CONTACT_CHECK). Bookkeeping only, never a ledger fact: the verdict
 * that CLOSES a promise is stored as its fulfillment proof, exactly like every
 * other association close.
 *
 *   { version, evidence_hash, verdict, reason, record_type, record_id, quote,
 *     matched_at, retry_after, checked_at }
 *
 * The evidence hash covers the obligation and every witness the model saw, so
 * an unchanged promise with unchanged evidence is never judged twice, and a
 * provider failure carries a retry_after. NULL on every row that was never
 * judged (no backfill). Nullable, no default, so adding it is a metadata-only
 * change. Reversible: down drops the column.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('call_commitments'))) return;
  if (await knex.schema.hasColumn('call_commitments', 'contact_check')) return;
  await knex.schema.alterTable('call_commitments', (t) => { t.jsonb('contact_check'); });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('call_commitments'))) return;
  if (!(await knex.schema.hasColumn('call_commitments', 'contact_check'))) return;
  await knex.schema.alterTable('call_commitments', (t) => { t.dropColumn('contact_check'); });
};
