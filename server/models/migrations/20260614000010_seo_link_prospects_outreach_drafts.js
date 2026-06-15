/**
 * Migration — outreach draft columns for seo_link_prospects (Backlink Manager M3b)
 *
 * Approval-gated editorial outreach: a one-to-one draft (recipient/subject/body)
 * is parked on the prospect by Hermes (worker /report 'drafted') or an operator,
 * then an operator approves the send with an explicit click. These columns hold
 * the draft + its approval state; the send itself reuses the existing
 * outreach_thread_ref / outreach_sent_at columns from the M1 schema.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('seo_link_prospects', (t) => {
    t.text('outreach_to_email');
    t.text('outreach_subject');
    t.text('outreach_body');
    // none → drafted → sending → sent (skipped = operator declined). Drives the
    // approval queue and the idempotent drafted→sending→sent send compare-and-swap.
    t.string('outreach_status').notNullable().defaultTo('none');
    // Dedicated send-claim token, set when a send claims the row (drafted→sending).
    // Rollback/finalize predicate on it so they only ever affect THEIR OWN claim —
    // a column no other writer touches (unlike the shared updated_at).
    t.text('outreach_send_token');
    // When a send was last ATTEMPTED (set at claim time). The daily rate-limit counts
    // by this so an attempt counts against the cap regardless of outcome — including a
    // send_error that may have reached Gmail before timing out. Cleared on re-draft.
    t.timestamp('outreach_attempted_at');
  });
  // Partial-ish index for the approval-queue lookup (WHERE outreach_status='drafted').
  await knex.schema.raw(
    'CREATE INDEX IF NOT EXISTS seo_link_prospects_outreach_status_idx ON seo_link_prospects (outreach_status)'
  );
};

exports.down = async function (knex) {
  await knex.schema.raw('DROP INDEX IF EXISTS seo_link_prospects_outreach_status_idx');
  await knex.schema.alterTable('seo_link_prospects', (t) => {
    t.dropColumn('outreach_to_email');
    t.dropColumn('outreach_subject');
    t.dropColumn('outreach_body');
    t.dropColumn('outreach_status');
    t.dropColumn('outreach_send_token');
    t.dropColumn('outreach_attempted_at');
  });
};
