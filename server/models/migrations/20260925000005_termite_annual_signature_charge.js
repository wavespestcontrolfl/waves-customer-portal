/**
 * Termite annual plan — charge the saved payment method at signature
 * (owner ruling 2026-09-25 on #4819). 20260925000001..000004 are frozen
 * (pushed; the preview DB has already run them) and are never edited —
 * this is a NEW additive migration.
 *
 * estimates.annual_plan_signature_charge (jsonb) — the at-most-once claim
 * for the one automatic charge termite-annual-activation.js attempts on the
 * activated annual_prepay invoice. A compare-and-swap from NULL claims it
 * ({ status: 'claimed', claim_token, invoice_id, claimed_at }); the owner
 * then resolves it to paid | processing | declined | skipped | ambiguous.
 * A claimed-but-unresolved row is never re-charged (the process may have
 * died mid-charge) — staff reconcile it. Null on every other estimate.
 *
 * payment_method_consents.evidence_contract_id (uuid) — the signed
 * customer_contracts row a consent row's authorization comes from. The
 * signature-time charge records its consent through the ordinary consent
 * ledger with this pointer and the signed agreement's own text as the
 * snapshot; every existing row leaves it null.
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates either table.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('estimates')) {
    if (!(await knex.schema.hasColumn('estimates', 'annual_plan_signature_charge'))) {
      await knex.schema.alterTable('estimates', (t) => {
        t.jsonb('annual_plan_signature_charge');
      });
    }
  }
  if (await knex.schema.hasTable('payment_method_consents')) {
    if (!(await knex.schema.hasColumn('payment_method_consents', 'evidence_contract_id'))) {
      const hasContracts = await knex.schema.hasTable('customer_contracts');
      await knex.schema.alterTable('payment_method_consents', (t) => {
        const col = t.uuid('evidence_contract_id');
        if (hasContracts) col.references('id').inTable('customer_contracts').onDelete('SET NULL');
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('payment_method_consents')) {
    if (await knex.schema.hasColumn('payment_method_consents', 'evidence_contract_id')) {
      await knex.schema.alterTable('payment_method_consents', (t) => {
        t.dropColumn('evidence_contract_id');
      });
    }
  }
  if (await knex.schema.hasTable('estimates')) {
    if (await knex.schema.hasColumn('estimates', 'annual_plan_signature_charge')) {
      await knex.schema.alterTable('estimates', (t) => {
        t.dropColumn('annual_plan_signature_charge');
      });
    }
  }
};
