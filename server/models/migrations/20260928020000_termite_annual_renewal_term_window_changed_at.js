/**
 * Termite annual plan — the automatic renewal charge (slice 6b, dark behind
 * GATE_TERMITE_ANNUAL_PLAN). Follows 20260926050000 / 050001 / 050002,
 * 20260927020000, 20260927040000, 20260927050000, 20260927160000,
 * 20260927170000 and 20260928000100, all PUSHED and frozen (PR #4971) —
 * this column is new; nothing in those files is edited.
 *
 * annual_prepay_terms.term_window_changed_at — Codex #4971 round-20 P1
 * (finding 2, charge.js:1581). parentChangedAtSql (termite-annual-renewal-
 * charge.js) is the ONE "when did the parent stop authorizing its renewal"
 * definition, read by both paidAfterParentChanged and leg 7e's late-paid
 * backstop scan — but it had no arm for a term-window move
 * (parent_term_moved: annual-prepay-renewals.js's createTermForAnnualPrepay
 * editing an EXISTING term's term_start/term_end) on a parent that
 * otherwise still authorizes its renewal (still active/renewal_pending, or
 * renewed with a 'renew' decision) — every other arm in that LEAST(...)
 * only fires once the status itself stops authorizing. A renewal successor
 * paid AFTER such a window edit was therefore never dated as "paid after a
 * change": the refund-or-honor bell (bellLatePaidRenewal) never rang, and
 * recordParentRenewedIfEligible kept rejecting the same paid successor's
 * 'renew' stamp forever with no escalation.
 *
 * Stamped (column-tolerant) by createTermForAnnualPrepay's existing-term
 * edit branch whenever term_start or term_end actually CHANGES VALUE
 * (never on a same-value resupply) and read as one more arm of
 * parentChangedAtSql.
 *
 * Additive and nullable.
 */
const COLUMN = 'term_window_changed_at';

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
