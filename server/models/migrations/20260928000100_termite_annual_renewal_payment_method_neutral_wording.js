/**
 * Termite annual plan — the automatic renewal charge (slice 6b, dark behind
 * GATE_TERMITE_ANNUAL_PLAN). Follows 20260926050000 (PUSHED and frozen, PR
 * #4971) — that migration's own template seed is never edited in place;
 * this migration only UPDATES the row it left behind and adds one new
 * column.
 *
 * sms_templates row `termite_annual_renewal_charge_failed` — Codex #4971
 * r17 P2: the decline notice said "we tried to charge your card on file",
 * but the renewal charge also debits ACH/us_bank_account payment methods on
 * file (recurring-card-on-file.js resolves either a card or a bank account),
 * so a customer paying by bank transfer got a notice naming the wrong
 * instrument. Reworded to the payment-method-neutral "we tried to charge
 * your payment method on file" — the rest of the copy (amount, pay link,
 * reply-to-message close) is byte-identical, and no signature is added
 * (owner ruling: no signature on texts). down() restores the exact prior
 * text.
 *
 * annual_prepay_terms.renewal_parent_deleted_conflict_belled_at — Codex
 * #4971 r17 P2 (finding 5): recordParentRenewedIfEligible's deleted-account
 * conflict (a successor's payment settles after the customer's account was
 * deleted) rings a staff bell (paid_after_parent_ended) and leaves the
 * parent undecided so a human resolves it — but with no persisted marker,
 * reconcileParentRenewedStamps' own bounded LIMIT 200 scan re-selected that
 * SAME row forever (the parent never leaves ACTIVE_STATUSES/renewal_decision
 * IS NULL on its own), starving any newer row past the limit from ever being
 * reached. Stamped once the bell has actually been asked for (fresh or
 * deduped — either way staff has been told, same "was staff told" rule
 * renewal_late_paid_belled_at / renewal_exception_belled_at already use),
 * and the reconcile scan excludes on the column directly in SQL. Undeleting
 * the account is NOT what clears this — a human resolves it via the bell (a
 * staff decision recorded elsewhere, e.g. the parent's own renewal
 * decision, naturally moves the parent out of the scan's own
 * ACTIVE_STATUSES/renewal_decision-null predicate regardless of this stamp).
 * Additive, nullable.
 */
const TEMPLATE_KEY = 'termite_annual_renewal_charge_failed';
const OLD_BODY = "Hi {first_name}, we tried to charge your card on file ${amount} to renew your Waves Subterranean Termite Protection plan, but it didn't go through. Please pay here to keep your coverage active: {pay_url}.\n\nQuestions or need help? Just reply to this message.";
const NEW_BODY = "Hi {first_name}, we tried to charge your payment method on file ${amount} to renew your Waves Subterranean Termite Protection plan, but it didn't go through. Please pay here to keep your coverage active: {pay_url}.\n\nQuestions or need help? Just reply to this message.";
const COLUMN = 'renewal_parent_deleted_conflict_belled_at';

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    const cols = await knex('sms_templates').columnInfo();
    const now = new Date();
    await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).update({
      body: NEW_BODY,
      ...(cols.updated_at ? { updated_at: now } : {}),
    });
  }

  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (!(await knex.schema.hasColumn('annual_prepay_terms', COLUMN))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => t.timestamp(COLUMN, { useTz: true }));
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (await knex.schema.hasColumn('annual_prepay_terms', COLUMN)) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => t.dropColumn(COLUMN));
    }
  }

  if (await knex.schema.hasTable('sms_templates')) {
    const cols = await knex('sms_templates').columnInfo();
    const now = new Date();
    await knex('sms_templates').where({ template_key: TEMPLATE_KEY }).update({
      body: OLD_BODY,
      ...(cols.updated_at ? { updated_at: now } : {}),
    });
  }
};
