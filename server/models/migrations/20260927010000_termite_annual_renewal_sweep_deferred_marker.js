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
 * Additive, nullable.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_sweep_deferred_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('renewal_sweep_deferred_at', { useTz: true });
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_sweep_deferred_at')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_sweep_deferred_at');
      });
    }
  }
};
