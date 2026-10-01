/**
 * Termite annual plan — the automatic renewal charge (slice 6b, dark behind
 * GATE_TERMITE_ANNUAL_PLAN). Follows 20260926050000, which is now PUSHED
 * and frozen (PR #4971) — every column here is new; nothing in 050000 is
 * edited.
 *
 * annual_prepay_terms.renewal_no_witness_belled_at /
 * annual_prepay_terms.renewal_unanchored_belled_at /
 * annual_prepay_terms.renewal_stale_overdue_belled_at — Codex round-6 P1:
 * 050000's single renewal_exception_belled_at/renewal_exception_kind pair
 * excluded a term from ALL three exception-bell scans (bellNoWitnessTerms /
 * bellUnanchoredOriginalTerms / bellStaleOverdueTerms) the moment ANY one of
 * them belled it — so a term belled for kind A (say, no-witness) that later
 * gets FIXED for A but then legitimately matches kind B (unanchored, or
 * stale-overdue) would never be scanned for B either: the shared column was
 * already set, so every scan's `whereNull` skipped the row silently,
 * forever. The three kinds are mutually exclusive by construction at any
 * given moment (their WHERE clauses partition on notice_45_sent_at /
 * renewed_from_term_id+installation_anchored_at / term_end vs cutoff), but a
 * term's underlying facts can change OVER TIME and move it from one kind's
 * bucket into another's — exactly the case one shared column can't tell
 * apart. One column per kind — each scan stamps and excludes on its OWN
 * column only, so a term already belled for kind A remains fully eligible
 * to be scanned and belled for kind B whenever it comes to match B's
 * conditions later. 050000's renewal_exception_belled_at/
 * renewal_exception_kind columns are left in place, UNUSED — no live code
 * reads or writes them from this migration forward; dropping them isn't
 * done here since 050000 is frozen and no read/write path depends on
 * removing them. Additive, nullable.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_no_witness_belled_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('renewal_no_witness_belled_at', { useTz: true });
      });
    }
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_unanchored_belled_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('renewal_unanchored_belled_at', { useTz: true });
      });
    }
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_stale_overdue_belled_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('renewal_stale_overdue_belled_at', { useTz: true });
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_no_witness_belled_at')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_no_witness_belled_at');
      });
    }
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_unanchored_belled_at')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_unanchored_belled_at');
      });
    }
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_stale_overdue_belled_at')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_stale_overdue_belled_at');
      });
    }
  }
};
