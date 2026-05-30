/**
 * Add service_records.recap_sms_sent_at — the at-most-once claim marker
 * for the pest-control Service Recap customer text.
 *
 * Codex P1 (PR #1405): the recap submit path checked-then-inserted a
 * service_records row and then fired the recap SMS post-commit, with no
 * idempotency. A double-tap, browser retry, or admin+tech race could
 * duplicate the record AND text the customer twice.
 *
 * The duplicate-record half is serialized by a FOR UPDATE lock on the
 * parent scheduled_services row (services/pest-recap.js). This column
 * closes the double-text half: the recap submit claims recap_sms_sent_at
 * inside the same locked transaction, so only the first submit to win the
 * lock sends the text — every concurrent/retried submit sees the claim
 * and skips. If the post-commit send fails, the claim is released so a
 * later retry can re-attempt.
 *
 * Nullable timestamptz: NULL = no recap text has been sent for this
 * service yet. Old rows stay NULL, which is correct (they predate the
 * recap path and never auto-texted) — and a NULL claim is exactly what
 * lets a "completed earlier, text now" recap still send.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('service_records', 'recap_sms_sent_at'))) {
    await knex.schema.alterTable('service_records', (t) => {
      t.timestamp('recap_sms_sent_at', { useTz: true });
    });
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('service_records', 'recap_sms_sent_at')) {
    await knex.schema.alterTable('service_records', (t) => {
      t.dropColumn('recap_sms_sent_at');
    });
  }
};
