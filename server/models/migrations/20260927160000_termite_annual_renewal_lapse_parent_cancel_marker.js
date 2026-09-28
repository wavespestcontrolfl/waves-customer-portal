/**
 * Termite annual plan — the automatic renewal charge (slice 6b, dark behind
 * GATE_TERMITE_ANNUAL_PLAN). Follows 20260926050000 / 050001 / 050002,
 * 20260927020000, 20260927040000 and 20260927050000, all PUSHED and frozen
 * (PR #4971) — this column is new; nothing in those files is edited.
 *
 * annual_prepay_terms.renewal_lapse_parent_cancelled_at — Codex #4971 r13
 * P1: provenance for the grace lapse's own parent cancel. The lapse records
 * the parent's 'cancel' decision as its last effect, and a crash between
 * that write and the lapse's completion stamp is resumed by the recovery
 * leg — which used to accept ANY cancelled / 'cancel' parent as that same
 * lapse's earlier write. An admin cancel landing after the lapse was
 * selected read exactly the same, so the lapse voided the renewal and
 * ordered station retrieval where the external cancellation's own path
 * (withdraw the renewal, no retrieval, no parent decision) belonged. The
 * lapse now stamps this column on the SUCCESSOR in the same transaction as
 * the parent cancel it writes; only a cancel carrying it is resumed as the
 * lapse's own.
 *
 * Additive and nullable.
 */
const COLUMN = 'renewal_lapse_parent_cancelled_at';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', COLUMN))) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => t.timestamp(COLUMN, { useTz: true }));
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (await knex.schema.hasColumn('annual_prepay_terms', COLUMN)) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => t.dropColumn(COLUMN));
  }
};
