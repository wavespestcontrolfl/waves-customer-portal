/**
 * Companion to 20260924000021 (payments.payment_method_id → ON DELETE SET
 * NULL). Payment history reads brand/last-four from the joined
 * payment_methods row and falls back to the payments snapshot once the
 * method is removed — but StripeService.charge and
 * chargeInvoiceWithSavedCard never wrote card_last_four (only card_brand),
 * and the succeeded webhook leaves an already-paid row alone. Without this
 * backfill, removing a card would erase the only stored last-four for
 * those payments (GH codex r2 P2).
 *
 * Fill-only: copies from the still-linked method into NULL snapshot
 * columns and never overwrites a value the payment already carries.
 * down() is a no-op — the copied values are true for the payment and
 * cannot be told apart from ones written at charge time.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payments'))) return;
  if (!(await knex.schema.hasColumn('payments', 'card_last_four'))) return;

  await knex.raw(`
    UPDATE payments p
    SET card_last_four = COALESCE(p.card_last_four, pm.last_four),
        card_brand = COALESCE(p.card_brand, pm.card_brand)
    FROM payment_methods pm
    WHERE p.payment_method_id = pm.id
      AND ((p.card_last_four IS NULL AND pm.last_four IS NOT NULL)
        OR (p.card_brand IS NULL AND pm.card_brand IS NOT NULL))
  `);
};

exports.down = async function down() {};
