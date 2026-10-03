/**
 * Review-ask payment hold timer (GATE_REVIEW_ASK_TECH_VOICE, owner ruling
 * 2026-10-01: "the ask waits for the hold to clear, inside its normal window,
 * or is dropped").
 *
 *   payment_hold_step  — the cadence step a payment hold first held.
 *   payment_hold_since — when that hold began. The step is dropped 3 days
 *                        later, even if the hold cleared in between.
 *
 * Their own columns, not the decision record: every other deferral rewrites
 * `decision`, which would restart the 3-day window.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('review_sequences'))) return;
  if (!(await knex.schema.hasColumn('review_sequences', 'payment_hold_step'))) {
    await knex.schema.alterTable('review_sequences', (t) => {
      t.integer('payment_hold_step').nullable();
    });
  }
  if (!(await knex.schema.hasColumn('review_sequences', 'payment_hold_since'))) {
    await knex.schema.alterTable('review_sequences', (t) => {
      t.timestamp('payment_hold_since', { useTz: true }).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('review_sequences'))) return;
  for (const column of ['payment_hold_since', 'payment_hold_step']) {
    if (await knex.schema.hasColumn('review_sequences', column)) {
      await knex.schema.alterTable('review_sequences', (t) => { t.dropColumn(column); });
    }
  }
};
