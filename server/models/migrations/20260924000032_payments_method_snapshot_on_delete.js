/**
 * Single chokepoint for payment history once a method can be removed
 * (payments.payment_method_id is ON DELETE SET NULL since 20260924000021).
 *
 * Patching each payments writer to snapshot the tender kept missing
 * writers (failed-attempt rows, ACH identity — GH codex r3 P2 x2), so the
 * snapshot is taken where the link is lost instead: a BEFORE DELETE
 * trigger on payment_methods copies the method's brand, last four,
 * method type and bank name into every linked payments row's NULL
 * snapshot columns, then the FK nulls the pointer. Any delete path
 * (portal removal, detach webhook, a manual delete) and any writer is
 * covered. Fill-only — a value the payment already carries is never
 * overwritten.
 *
 * payments gains payment_method_type and bank_name so an ACH payment
 * still reads as a bank payment after its method is gone; readers
 * COALESCE the live join first, then these snapshots.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payments'))) return;

  const hasType = await knex.schema.hasColumn('payments', 'payment_method_type');
  const hasBank = await knex.schema.hasColumn('payments', 'bank_name');
  if (!hasType || !hasBank) {
    await knex.schema.alterTable('payments', (t) => {
      if (!hasType) t.string('payment_method_type', 20).nullable();
      if (!hasBank) t.string('bank_name', 100).nullable();
    });
  }

  // Existing linked rows: fill the new columns (and any snapshot gap the
  // 000031 backfill did not cover) from the still-linked method.
  await knex.raw(`
    UPDATE payments p
    SET payment_method_type = COALESCE(p.payment_method_type, pm.method_type),
        bank_name = COALESCE(p.bank_name, pm.bank_name),
        card_brand = COALESCE(p.card_brand, pm.card_brand),
        card_last_four = COALESCE(p.card_last_four, pm.last_four)
    FROM payment_methods pm
    WHERE p.payment_method_id = pm.id
      AND ((p.payment_method_type IS NULL AND pm.method_type IS NOT NULL)
        OR (p.bank_name IS NULL AND pm.bank_name IS NOT NULL)
        OR (p.card_brand IS NULL AND pm.card_brand IS NOT NULL)
        OR (p.card_last_four IS NULL AND pm.last_four IS NOT NULL))
  `);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION payments_snapshot_removed_method() RETURNS trigger AS $$
    BEGIN
      UPDATE payments
      SET card_brand = COALESCE(card_brand, OLD.card_brand),
          card_last_four = COALESCE(card_last_four, OLD.last_four),
          payment_method_type = COALESCE(payment_method_type, OLD.method_type),
          bank_name = COALESCE(bank_name, OLD.bank_name)
      WHERE payment_method_id = OLD.id;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql
  `);
  await knex.raw('DROP TRIGGER IF EXISTS payment_methods_snapshot_before_delete ON payment_methods');
  await knex.raw(`
    CREATE TRIGGER payment_methods_snapshot_before_delete
    BEFORE DELETE ON payment_methods
    FOR EACH ROW EXECUTE FUNCTION payments_snapshot_removed_method()
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP TRIGGER IF EXISTS payment_methods_snapshot_before_delete ON payment_methods');
  await knex.raw('DROP FUNCTION IF EXISTS payments_snapshot_removed_method()');
  if (!(await knex.schema.hasTable('payments'))) return;
  const hasType = await knex.schema.hasColumn('payments', 'payment_method_type');
  const hasBank = await knex.schema.hasColumn('payments', 'bank_name');
  if (hasType || hasBank) {
    await knex.schema.alterTable('payments', (t) => {
      if (hasType) t.dropColumn('payment_method_type');
      if (hasBank) t.dropColumn('bank_name');
    });
  }
};
