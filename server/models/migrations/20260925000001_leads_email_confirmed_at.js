/**
 * leads.email_confirmed_at — email-specific correction provenance.
 *
 * Codex round-4 P1 on the V1/V2 email-disagreement hold (PR #4802,
 * admin-triage.js's emailDisagreementConfirmed): for a customer-less
 * voicemail lead (no first_touch_holds row at all — the correction path is
 * editing the LEAD's email, not a customer record), "the lead's
 * updated_at is later than the card's created_at" was GENERIC row
 * provenance — admin-leads.js's PUT /:id bumps updated_at on any allowed
 * field (status, notes, assignment, ...) and voicemail-lead-sms.js's own
 * bookkeeping writes bump it too, so an unrelated edit after a fresh card
 * would falsely confirm it. This column is stamped ONLY when the lead's
 * email field itself actually changes (PUT /api/admin/leads/:id, guarded
 * on `updates.email !== current.email`), giving the disagreement-card
 * confirmation check an email-specific signal instead of the row's general
 * last-write timestamp.
 *
 * Idempotent (hasTable + hasColumn); no backfill — existing rows have no
 * recorded email-change event, so they read as unconfirmed by this signal,
 * which is correct (this column proves a POST-CARD correction, not merely
 * that an address exists).
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('leads');
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn('leads', 'email_confirmed_at');
  if (!hasColumn) {
    await knex.schema.alterTable('leads', (t) => {
      t.timestamp('email_confirmed_at', { useTz: true }).nullable().defaultTo(null);
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('leads');
  if (!hasTable) return;

  if (await knex.schema.hasColumn('leads', 'email_confirmed_at')) {
    await knex.schema.alterTable('leads', (t) => { t.dropColumn('email_confirmed_at'); });
  }
};
