/**
 * Termite annual plan — the automatic renewal charge (slice 6b, dark behind
 * GATE_TERMITE_ANNUAL_PLAN). Follows 20260928020000 and every earlier
 * slice-6b migration, all PUSHED and frozen (PR #4971) — this column is
 * new; nothing in those files is edited.
 *
 * annual_prepay_terms.renewal_noticed_fee — Codex #4971 round-23 P1
 * (charge.js:1003). The 45-day termite renewal notice quotes the term's
 * prepay_amount to the customer but only a timestamp was witnessed; a staff
 * edit of prepay_amount after that notice and before the renewal date made
 * the successor invoice and the automatic saved-method charge use a fee the
 * customer was never told. Stamped by stampTermNoticeWitness on the 45-day
 * rung (the fee as rendered), read by mintRenewalSuccessor: a parent whose
 * current fee no longer matches it is NOT minted or charged automatically
 * (fee_changed_after_notice bell, sweep-deferred) until the fee matches.
 *
 * Additive and nullable.
 */
const COLUMN = 'renewal_noticed_fee';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', COLUMN))) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => t.decimal(COLUMN, 10, 2));
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (await knex.schema.hasColumn('annual_prepay_terms', COLUMN)) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => t.dropColumn(COLUMN));
  }
};
