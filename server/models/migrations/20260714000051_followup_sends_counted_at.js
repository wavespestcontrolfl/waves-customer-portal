'use strict';

/**
 * counted_at on estimate_followup_sends (codex 2736 r6): marks whether a
 * send's follow_up_count/last_follow_up_at bump has been applied to the
 * estimate. The bump is a single atomic statement (stamp + counters
 * together), so a transient failure leaves a clean uncounted row that
 * repairSendBookkeeping heals precisely — no timestamp-guard heuristics
 * that a newer send could mask, and payment_step_abandoned rows heal the
 * same way. Backfill: every pre-existing row was bumped inline by its
 * sender, so it counts as counted.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('estimate_followup_sends'))) return;
  if (!(await knex.schema.hasColumn('estimate_followup_sends', 'counted_at'))) {
    await knex.schema.alterTable('estimate_followup_sends', (t) => {
      t.timestamp('counted_at', { useTz: true });
    });
    await knex('estimate_followup_sends')
      .whereNull('counted_at')
      .update({ counted_at: knex.raw('sent_at') });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('estimate_followup_sends'))) return;
  if (await knex.schema.hasColumn('estimate_followup_sends', 'counted_at')) {
    await knex.schema.alterTable('estimate_followup_sends', (t) => {
      t.dropColumn('counted_at');
    });
  }
};
