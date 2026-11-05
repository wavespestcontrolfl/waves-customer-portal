'use strict';

/**
 * Moving, the app-made new-home estimate (owner 2026-11-04, option A of the
 * hands-off moves page; dark behind GATE_MOVING_AUTO_ESTIMATE): once a customer
 * sends a move with an address in our area, the app prices the new home itself
 * (services/moving-auto-estimate.js).
 *  - auto_estimate_at: when the job claimed the move, before the paid property
 *    lookup, so a move gets at most one automatic attempt.
 *  - auto_estimate_state: 'drafted' (the estimate is saved on the move) or
 *    'office' (the app did not price it; the office prices it by hand);
 *    auto_estimate_note: what the office is told for an 'office' move.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('customer_moves', (t) => {
    t.timestamp('auto_estimate_at', { useTz: true }).nullable();
    t.string('auto_estimate_state', 16).nullable();
    t.string('auto_estimate_note', 300).nullable();
  });
  await knex.raw(`ALTER TABLE customer_moves ADD CONSTRAINT customer_moves_auto_estimate_state_check
    CHECK (auto_estimate_state IS NULL OR auto_estimate_state IN ('drafted', 'office'))`);
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE customer_moves DROP CONSTRAINT IF EXISTS customer_moves_auto_estimate_state_check');
  await knex.schema.alterTable('customer_moves', (t) => {
    t.dropColumn('auto_estimate_at');
    t.dropColumn('auto_estimate_state');
    t.dropColumn('auto_estimate_note');
  });
};
