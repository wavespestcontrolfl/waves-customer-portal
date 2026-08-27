/**
 * Durable park stamp for one-time card holds (owner ruling 2026-08-26,
 * GATE_CARD_HOLD_PARK_ON_CANCEL).
 *
 * Parking a hold on cancel deliberately leaves status='held' so the
 * stranded-hold detection lane and the ops repair script keep seeing it —
 * but "held with nothing written" made the park decision invisible to
 * REPLAYS: a cancellation retried later (the Intelligence Bar replay path,
 * a second click) would re-evaluate the fee window against a later `now`,
 * and a cancel that was parked FREE outside the window could be charged
 * the late-cancel fee once the replay lands inside it (pre-push P0).
 *
 * parked_at is the durable decision: once stamped, cancellation handling
 * returns the park verbatim and never re-runs the fee evaluation.
 * park_reason records which leg parked (cancel_outside_window /
 * cancel_past_start / waived_cancel / reschedule_request). The ops repoint
 * script clears both when the hold moves to its successor visit.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('estimate_card_holds', (t) => {
    t.timestamp('parked_at').nullable();
    t.string('park_reason', 40).nullable();
  });
};

exports.down = async function down(knex) {
  // Parked rows are 'held' rows whose UN-chargeability lives entirely in
  // these columns — dropping them naked would hand old code fully
  // chargeable holds and re-open the replay fee bug the stamp exists to
  // close. Terminally release every parked row FIRST, so the rollback
  // leaves nothing chargeable that the forward world had fenced off.
  await knex('estimate_card_holds')
    .whereNotNull('parked_at')
    .where({ status: 'held' })
    .update({ status: 'released', updated_at: knex.fn.now() });
  await knex.schema.alterTable('estimate_card_holds', (t) => {
    t.dropColumn('parked_at');
    t.dropColumn('park_reason');
  });
};
