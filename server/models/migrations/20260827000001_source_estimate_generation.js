/**
 * Parent-scoped quote GENERATION marker for self-booked visits (codex
 * #3504 r22–r24 P0s).
 *
 * A quote-wizard draft is a shared, reusable row: /calculate revives and
 * rewrites the same estimate for the customer's next quote, so nothing on
 * the draft (archived_at, updated_at, content) can prove that the draft
 * still belongs to an OLDER booking that points at it through
 * source_estimate_id. The stranded-activation recovery must retire a
 * completed-then-stranded visit's self-book handoff (or the customer can
 * rebook the FULL program on top of a performed first application), but
 * it must never archive a NEWER quote the customer has since issued.
 *
 * source_estimate_generation is stamped on the parent at booking INSERT
 * with the trusted draft's updated_at as read for pricing. Every later
 * refresh rewrites the draft's updated_at, so "live draft updated_at ==
 * parent's stamped generation" is immutable, parent-owned proof that the
 * live draft is the exact generation this visit was booked from. NULL
 * (pre-column rows, non-wizard pricing) fails closed: never retire.
 *
 * wizard_recovery_reconciled_at (codex #3504 r26): the stranded-activation
 * sweep's durable "I already reconciled this row" marker. Reconciling used
 * to take the row out of the sweep's claim by clearing its pay-at-visit
 * billing fields — which also erased a staff-approved reprice's intended
 * auto-invoice. With the marker, a reconcile that cannot prove the price
 * is the activation-minted amount leaves billing UNTOUCHED (office
 * verifies) and still leaves the claim.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (await knex.schema.hasColumn('scheduled_services', 'source_estimate_generation')) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.timestamp('source_estimate_generation', { useTz: true }).nullable();
  });
  if (!(await knex.schema.hasColumn('scheduled_services', 'wizard_recovery_reconciled_at'))) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.timestamp('wizard_recovery_reconciled_at', { useTz: true }).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('scheduled_services'))) return;
  if (!(await knex.schema.hasColumn('scheduled_services', 'source_estimate_generation'))) return;
  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('source_estimate_generation');
  });
  if (await knex.schema.hasColumn('scheduled_services', 'wizard_recovery_reconciled_at')) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.dropColumn('wizard_recovery_reconciled_at');
    });
  }
};
