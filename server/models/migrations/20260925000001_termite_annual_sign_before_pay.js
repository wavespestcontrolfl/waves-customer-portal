/**
 * Termite annual plan — sign-before-pay schema (slice 3a, owner ruling
 * 2026-09-24: BUILD NOW, dark behind GATE_TERMITE_ANNUAL_PLAN). On accept, a
 * Subterranean Termite Protection annual-plan estimate creates its
 * scheduled_services as usual but DEFERS the prepay term + annual-fee
 * invoice until the customer e-signs the annual agreement
 * (server/services/estimate-converter.js + termite-annual-activation.js).
 *
 * estimates.annual_plan_activation_status — the deferral state machine:
 *   NULL (every non-annual-plan estimate, and every estimate accepted
 *     before this slice) → 'awaiting_signature' (converter deferred the
 *     money at accept) → 'activated' (termite-annual-activation.js ran the
 *     deferred term/invoice after signature). Nullable varchar, no CHECK
 *     constraint — this table already carries several free-text status-like
 *     columns (e.g. status itself) without one, and a hard-coded list here
 *     would need its own migration the day slice 3b adds a third state
 *     (e.g. 'expired').
 *
 * estimates.annual_plan_activated_at — when activation completed. Nullable
 *   timestamptz, same shape as annual_prepay_terms.notice_45_sent_at etc.
 *   from 20260924030001.
 *
 * No new link from customer_contracts back to its source estimate: the
 * termite program agreement already snapshots the source estimate id at
 * document_variables_snapshot.estimate.id (termite-program-agreement.js),
 * so termite-annual-activation.js reads that instead of adding a column.
 *
 * Both columns are additive, nullable, and guarded with hasTable/hasColumn
 * so this migration is safe to run more than once and safe on a database
 * that predates the estimates table (it never has, but the guard matches
 * the sibling migration's convention).
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('estimates')) {
    if (!(await knex.schema.hasColumn('estimates', 'annual_plan_activation_status'))) {
      await knex.schema.alterTable('estimates', (t) => {
        t.string('annual_plan_activation_status', 30);
      });
    }

    if (!(await knex.schema.hasColumn('estimates', 'annual_plan_activated_at'))) {
      await knex.schema.alterTable('estimates', (t) => {
        t.timestamp('annual_plan_activated_at', { useTz: true });
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('estimates')) {
    if (await knex.schema.hasColumn('estimates', 'annual_plan_activated_at')) {
      await knex.schema.alterTable('estimates', (t) => {
        t.dropColumn('annual_plan_activated_at');
      });
    }

    if (await knex.schema.hasColumn('estimates', 'annual_plan_activation_status')) {
      await knex.schema.alterTable('estimates', (t) => {
        t.dropColumn('annual_plan_activation_status');
      });
    }
  }
};
