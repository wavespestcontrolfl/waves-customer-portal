/**
 * disclaimed_number_holds — the NUMBER-keyed record of a caller disclaiming
 * the number they called from ("this is our office line, it's not mine")
 * with no spoken callback of their own (callback_number_needed;
 * call-triage-flags.js's callerIdDisclaimedNeedsCallback). PR #4807,
 * codex round 6.
 *
 * Why a table keyed on the number, not another scheduled_services column:
 * rounds 2–6 each found a NEW sender the appointment-scoped hold
 * (20260925000100's callback_number_hold_at, frozen — already pushed) could
 * not see — most recently estimate/invoice follow-ups, which carry no visit
 * id at all yet text customers.phone, which for a call-created customer IS
 * the disclaimed number. The invariant is about the destination number, so
 * the durable state is too: sendCustomerMessage checks every SMS `to`
 * against this table (disclaimed-number-holds.js's
 * disclaimedNumberBlocksSend), at the pipeline AND again at the provider
 * boundary, whatever metadata the sender carries.
 *
 * Row lifecycle:
 *   - written (idempotently) by call-recording-processor.js wherever the
 *     callback_number_needed hold is armed — after customer resolution,
 *     inside the booking transaction, and the post-commit fallback;
 *     one row per (number, source call).
 *   - ACTIVE while cleared_at IS NULL. A force-reprocess that raises the
 *     flag again re-arms a cleared row (held_at bumped, cleared_* nulled).
 *   - cleared by the office resolving the callback_number_needed card
 *     (admin-triage.js). A customer phone EDIT clears nothing: the old
 *     number was never verified, and the new number simply has no row.
 *
 * Deliberately NOT customer-scoped for blocking: the invariant is "never
 * text a number a caller disclaimed until someone verifies it", and a
 * customer-scoped read would let a duplicate/merged customer record (or a
 * lead carrying the same ANI) straight past it. customer_id is recorded
 * context (which account the call resolved to), not a filter. No FK on
 * customer_id / source_call_log_id: a customer delete/merge or a call_log
 * prune must never cascade away a hold and silently re-open texting.
 */
exports.up = async function up(knex) {
  if (await knex.schema.hasTable('disclaimed_number_holds')) return;
  await knex.schema.createTable('disclaimed_number_holds', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('phone_e164', 20).notNullable();
    t.uuid('customer_id').nullable();
    t.uuid('source_call_log_id').notNullable();
    t.timestamp('held_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('cleared_at', { useTz: true }).nullable();
    t.string('cleared_by', 100).nullable();
    t.string('clear_reason', 100).nullable();
    t.timestamps(true, true);
    // One row per (number, call): the idempotency key every writer upserts on.
    t.unique(['phone_e164', 'source_call_log_id'], { indexName: 'disclaimed_number_holds_phone_call_uniq' });
  });
  // The send-path read: "is there an ACTIVE hold on this number".
  await knex.raw(
    'CREATE INDEX disclaimed_number_holds_active_phone_idx ON disclaimed_number_holds (phone_e164) WHERE cleared_at IS NULL',
  );
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('disclaimed_number_holds');
};
