/**
 * Lead / estimate linkage on email_messages.
 *
 * Mail sent to a prospect (an estimate delivery, an estimate follow-up, a
 * quote request receipt, an assessment report link) is recorded with
 * recipient_type 'lead' but, when the estimate has no customer yet, no
 * recipient_id: there is no customer id to name and the estimate id lived only
 * in trigger_event_id text. Those rows belonged to nobody once the prospect
 * became a customer under a different address.
 *
 * Two additive, nullable columns record what the send was about:
 *   lead_id      leads.id the mail was sent to (or whose estimate it concerned)
 *   estimate_id  estimates.id the mail was about
 * Both are set at the single send chokepoint (email-template-library.js
 * sendTemplate, via services/email-lead-links.js). recipient_type / recipient_id
 * are untouched, so every existing reader keeps its behavior. No foreign keys:
 * the columns are provenance, not ownership, and must survive a deleted lead or
 * estimate. Partial indexes keep the (mostly NULL) columns cheap; plain
 * transactional CREATE INDEX is fine at this table size.
 */
const TABLE = 'email_messages';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'lead_id'))) {
    await knex.schema.alterTable(TABLE, (t) => t.uuid('lead_id').nullable());
  }
  if (!(await knex.schema.hasColumn(TABLE, 'estimate_id'))) {
    await knex.schema.alterTable(TABLE, (t) => t.uuid('estimate_id').nullable());
  }
  await knex.raw('CREATE INDEX IF NOT EXISTS email_messages_lead_id_idx ON email_messages (lead_id) WHERE lead_id IS NOT NULL');
  await knex.raw('CREATE INDEX IF NOT EXISTS email_messages_estimate_id_idx ON email_messages (estimate_id) WHERE estimate_id IS NOT NULL');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw('DROP INDEX IF EXISTS email_messages_lead_id_idx');
  await knex.raw('DROP INDEX IF EXISTS email_messages_estimate_id_idx');
  if (await knex.schema.hasColumn(TABLE, 'lead_id')) {
    await knex.schema.alterTable(TABLE, (t) => t.dropColumn('lead_id'));
  }
  if (await knex.schema.hasColumn(TABLE, 'estimate_id')) {
    await knex.schema.alterTable(TABLE, (t) => t.dropColumn('estimate_id'));
  }
};
