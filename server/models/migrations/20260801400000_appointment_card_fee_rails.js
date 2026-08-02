// Fee-rail columns for appointment_card_requests (card-on-file enforcement
// build, owner-approved 2026-08-01 — docs/appointment-deposit-scope.md).
//
// The /secure lane's SMS + page disclose a late-cancel/no-show fee, but the
// only charge path lives on estimate_card_holds — office/AI-booked visits
// secured through this table have no enforcement rail. These columns give
// the lane the same frozen-terms + idempotency anchors the card-hold rail
// uses:
//
//   no_show_fee_amount / cancel_window_hours / fee_agreed_at — the terms
//     shown on the /secure page, frozen at capture completion (the consent
//     moment). Stamped ONLY on 'completed' rows: a 'satisfied' row was
//     auto-secured from a saved card and never saw the disclosure, so it
//     must never be fee-charged. Config changes never move an agreed fee.
//   fee_status — NULL (no fee event) | charging | charged | charge_review
//     | waived. NULL -> 'charging' is the atomic charge claim.
//   no_show_payment_intent_id / fee_charged_amount / fee_charged_at —
//     charge idempotency + audit, mirroring estimate_card_holds.
//
// No backfill: rows completed before this migration cannot prove the fee
// was disclosed at their consent moment, so they stay NULL and the rail
// skips them (fail toward not charging).
const COLUMNS = [
  ['no_show_fee_amount', (t) => t.decimal('no_show_fee_amount', 10, 2)],
  ['cancel_window_hours', (t) => t.integer('cancel_window_hours')],
  ['fee_agreed_at', (t) => t.timestamp('fee_agreed_at', { useTz: true })],
  ['fee_status', (t) => t.string('fee_status', 24)],
  ['no_show_payment_intent_id', (t) => t.string('no_show_payment_intent_id', 100)],
  ['fee_charged_amount', (t) => t.decimal('fee_charged_amount', 10, 2)],
  ['fee_charged_at', (t) => t.timestamp('fee_charged_at', { useTz: true })],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('appointment_card_requests'))) return;
  for (const [name, add] of COLUMNS) {
    if (!(await knex.schema.hasColumn('appointment_card_requests', name))) {
      await knex.schema.alterTable('appointment_card_requests', (t) => {
        add(t);
      });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('appointment_card_requests'))) return;
  for (const [name] of COLUMNS) {
    if (await knex.schema.hasColumn('appointment_card_requests', name)) {
      await knex.schema.alterTable('appointment_card_requests', (t) => {
        t.dropColumn(name);
      });
    }
  }
};
