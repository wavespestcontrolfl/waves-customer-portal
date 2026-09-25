/**
 * Termite annual plan — schema foundation (owner rulings 2026-09-24: Formosan
 * included (A-5), one annual inspection stands (A-6), A-13 = auto-charge the
 * saved method at renewal under Auto Pay consent captured at acceptance, A-11
 * = owner reviews the v3 agreement wording himself). This slice adds only the
 * five columns the renewal/agreement design (§A2, §A4) depends on; nothing
 * reads or writes them yet and `GATE_TERMITE_ANNUAL_PLAN` stays off.
 *
 * annual_prepay_terms.annual_plan_version — the annual-plan stamp snapshotted
 *   onto the term at creation. NULL for every lawn / mosquito / rodent /
 *   quarterly prepay term (this table is shared across all of them); the
 *   renewal transition and every ladder/consumer filter on this stamp being
 *   present, so an unstamped term is never touched by termite-annual-plan
 *   logic. Nullable string, no default — matches `plan_label` / `status`
 *   sibling column style on this table.
 *
 * annual_prepay_terms.renewed_from_term_id — FK to the parent term this one
 *   renewed from. The table has no predecessor/successor relation today and
 *   matching by customer + service type + dates is ambiguous for a
 *   multi-property account with overlapping termite terms; the deadline job,
 *   the online-nonrenewal endpoint, and the post-grace charge re-check all
 *   need to find the successor (or parent) through one unambiguous column.
 *   UNIQUE — one successor per parent. ON DELETE SET NULL — a deleted parent
 *   term must never take its successor down with it.
 *
 * annual_prepay_terms.notice_45_sent_at — the extended renewal-notice ladder
 *   (§A2: 45 and 30 days before the cancellation deadline, replacing the
 *   default 30-day-only notice for this plan) adds a rung alongside the
 *   existing notice_30_sent_at / notice_15_sent_at / notice_7_sent_at
 *   witnesses; same nullable timestamp shape as those three (see
 *   20260514000001_annual_prepay_terms.js).
 *
 * customer_contracts.annual_plan_version — the same stamp, snapshotted onto
 *   the signed agreement so a contract's plan vintage is legible without a
 *   join back to the term (and survives independently of it).
 *
 * annual_prepay_terms.renewal_charge_consent_at — Auto Pay consent captured
 *   at acceptance (ruling A-13). The renewal auto-charge job requires this
 *   column non-null before it will submit a saved-card charge for a
 *   successor term; NULL means invoice-and-wait only, never a silent charge.
 *
 * All five are additive, nullable, and guarded with hasTable/hasColumn so
 * this migration is safe to run more than once and safe on a database that
 * predates either table.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'annual_plan_version'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.string('annual_plan_version', 40);
      });
    }

    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'notice_45_sent_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('notice_45_sent_at', { useTz: true });
      });
    }

    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewal_charge_consent_at'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.timestamp('renewal_charge_consent_at', { useTz: true });
      });
    }

    if (!(await knex.schema.hasColumn('annual_prepay_terms', 'renewed_from_term_id'))) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.uuid('renewed_from_term_id')
          .nullable()
          .references('id')
          .inTable('annual_prepay_terms')
          .onDelete('SET NULL');
        t.unique(['renewed_from_term_id'], 'annual_prepay_terms_renewed_from_term_unique');
      });
    }
  }

  if (await knex.schema.hasTable('customer_contracts')) {
    if (!(await knex.schema.hasColumn('customer_contracts', 'annual_plan_version'))) {
      await knex.schema.alterTable('customer_contracts', (t) => {
        t.string('annual_plan_version', 40);
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('customer_contracts')) {
    if (await knex.schema.hasColumn('customer_contracts', 'annual_plan_version')) {
      await knex.schema.alterTable('customer_contracts', (t) => {
        t.dropColumn('annual_plan_version');
      });
    }
  }

  if (await knex.schema.hasTable('annual_prepay_terms')) {
    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewed_from_term_id')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropUnique(['renewed_from_term_id'], 'annual_prepay_terms_renewed_from_term_unique');
        t.dropColumn('renewed_from_term_id');
      });
    }

    if (await knex.schema.hasColumn('annual_prepay_terms', 'renewal_charge_consent_at')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('renewal_charge_consent_at');
      });
    }

    if (await knex.schema.hasColumn('annual_prepay_terms', 'notice_45_sent_at')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('notice_45_sent_at');
      });
    }

    if (await knex.schema.hasColumn('annual_prepay_terms', 'annual_plan_version')) {
      await knex.schema.alterTable('annual_prepay_terms', (t) => {
        t.dropColumn('annual_plan_version');
      });
    }
  }
};
