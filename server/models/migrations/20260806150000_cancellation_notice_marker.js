'use strict';

// Dedicated cancellation-notice claim (codex #3233 r1 P1, r3 P2s).
//
// appointment_reminders.cancelled cannot carry send-once semantics: the
// status-sync trigger (20260720000000) sets it during the cancel transition
// itself — before any route or post-commit hook runs — so "already
// cancelled" is true on every normal cancel and says nothing about whether
// a notice went out.
//
// Two-part claim:
//   cancellation_notice_at    — claim timestamp, taken atomically
//   cancellation_notice_state — 'pending' | 'pending_notify' | 'sent' | 'suppressed'
//   ('pending_notify' = caller-owned claim whose route INTENDS a text —
//    crash recovery sends regardless of prior delivery evidence)
// A claim is taken WHERE at IS NULL, or WHERE state='pending' and the
// claim is stale (>15 min) — a process crash between claim and provider
// acceptance must not permanently look like a completed notice (r3).
// 'suppressed' is a durable decision and is never reclaimed.
//
// The partial index backs the shared-writer hook's per-cancel delivery
// lookup on messaging_audit_log.appointment_id — without it every
// gated cancellation would scan the ever-growing audit table (r3).

exports.up = async (knex) => {
  await knex.schema.alterTable('appointment_reminders', (t) => {
    t.timestamp('cancellation_notice_at', { useTz: true }).nullable();
    t.string('cancellation_notice_state', 16).nullable();
  });
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_messaging_audit_appointment_id ON messaging_audit_log (appointment_id) WHERE appointment_id IS NOT NULL',
  );
  // The 15-minute stale-claim sweep filters/orders by (state, at) — without
  // this partial index it would scan the whole reminders table every tick.
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS idx_appt_reminders_cancel_pending ON appointment_reminders (cancellation_notice_at) WHERE cancellation_notice_state IN ('pending', 'pending_notify')",
  );
};

exports.down = async (knex) => {
  await knex.raw('DROP INDEX IF EXISTS idx_appt_reminders_cancel_pending');
  await knex.raw('DROP INDEX IF EXISTS idx_messaging_audit_appointment_id');
  await knex.schema.alterTable('appointment_reminders', (t) => {
    t.dropColumn('cancellation_notice_at');
    t.dropColumn('cancellation_notice_state');
  });
};
