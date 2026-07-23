// Square is fully phased out, but payment_methods.processor still carries the
// legacy 'square' column default. Every live insert path sets processor
// explicitly ('stripe' in services/stripe.js), so this only affects rows
// inserted WITHOUT a processor — which today silently become non-chargeable
// "square" methods that autopayActivePredicate() rejects (QA finding behind
// PR #2939: seeded demo data hit exactly this and read as 0% autopay).
// Existing rows are deliberately untouched: historical Square rows are
// payment provenance, not a defect.
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('payment_methods');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('payment_methods', 'processor');
  if (!hasColumn) return;
  await knex.raw(`ALTER TABLE payment_methods ALTER COLUMN processor SET DEFAULT 'stripe'`);
};

// Down drops the default instead of restoring 'square' — reviving a retired
// processor's default would recreate the failure mode this migration removes.
// The column is nullable, so a processor-less insert after rollback lands as
// NULL: still non-chargeable, but visibly "unset" (and surfaced by the
// billing-health "Can't charge" bucket) rather than masquerading as a valid
// retired processor.
exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('payment_methods');
  if (!hasTable) return;
  const hasColumn = await knex.schema.hasColumn('payment_methods', 'processor');
  if (!hasColumn) return;
  await knex.raw('ALTER TABLE payment_methods ALTER COLUMN processor DROP DEFAULT');
};
