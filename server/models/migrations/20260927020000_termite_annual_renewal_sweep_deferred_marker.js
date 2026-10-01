/**
 * Termite annual plan — the automatic renewal charge (slice 6b, dark behind
 * GATE_TERMITE_ANNUAL_PLAN). Follows 20260926050000 / 050001 / 050002, all
 * PUSHED and frozen (PR #4971) — this column is new; nothing in those files
 * is edited.
 *
 * annual_prepay_terms.renewal_sweep_deferred_at — Codex #4971 round-3 P2
 * (item 4, "keep deferred rows from pinning the recovery page"): the
 * renewal sweep's bounded recovery scans (the renewal-candidate mint scan,
 * leg 7a never-attempted, leg 7b never-reached-Stripe, and the missed-lapse
 * recovery) each order by a fixed timestamp and LIMIT. A row a pass has to
 * DEFER for a condition that clears on its own (a charge reconciliation
 * pending, an ACH still clearing, a parent in dispute, a failed delivery)
 * keeps matching, so once more than `limit` of them pile up the same oldest
 * page is retried forever and newer rows are never reached. Each deferral
 * now stamps this column, and every one of those scans orders by it
 * (NULLS FIRST) ahead of its own order: rows never deferred always come
 * first, deferred rows rotate least-recently-deferred first. Ordering only —
 * it never excludes a row and never changes what a pass does with it.
 *
 * annual_prepay_terms.renewal_charge_failure_kind / _reason / _handled_at —
 * Codex #4971 pre-push P1: a renewal charge that reached Stripe but did not
 * pay (a genuine decline, a refusal, an ambiguous result) owes staff a bell
 * and, for a decline/refusal, the customer a pay link. That follow-through
 * is persisted (kind + reason) BEFORE it runs and marked handled only once
 * it verifiably happened, so leg 7c can re-run a follow-through whose bell
 * or delivery failed — never the charge itself.
 *
 * All additive and nullable.
 */
const COLUMNS = [
  ['renewal_sweep_deferred_at', (t) => t.timestamp('renewal_sweep_deferred_at', { useTz: true })],
  ['renewal_charge_failure_kind', (t) => t.text('renewal_charge_failure_kind')],
  ['renewal_charge_failure_reason', (t) => t.text('renewal_charge_failure_reason')],
  ['renewal_charge_failure_handled_at', (t) => t.timestamp('renewal_charge_failure_handled_at', { useTz: true })],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  for (const [name, add] of COLUMNS) {
    if (!(await knex.schema.hasColumn('annual_prepay_terms', name))) {
      await knex.schema.alterTable('annual_prepay_terms', add);
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  for (const [name] of [...COLUMNS].reverse()) {
    if (await knex.schema.hasColumn('annual_prepay_terms', name)) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => t.dropColumn(name));
    }
  }
};
