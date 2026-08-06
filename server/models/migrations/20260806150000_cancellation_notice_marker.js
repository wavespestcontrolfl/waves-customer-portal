'use strict';

// Dedicated cancellation-notice marker (codex #3233 r1 P1).
//
// appointment_reminders.cancelled cannot carry send-once semantics: the
// status-sync trigger (20260720000000) sets it during the cancel transition
// itself — before any route or post-commit hook runs — so "already
// cancelled" is true on every normal cancel and says nothing about whether
// a notice went out. This column is claimed atomically
// (WHERE cancellation_notice_at IS NULL) by whichever caller handles the
// notice first — send OR deliberate suppression both claim, so a
// notifyCustomer:false route decision blocks a later auto-send.

exports.up = (knex) => knex.schema.alterTable('appointment_reminders', (t) => {
  t.timestamp('cancellation_notice_at', { useTz: true }).nullable();
});

exports.down = (knex) => knex.schema.alterTable('appointment_reminders', (t) => {
  t.dropColumn('cancellation_notice_at');
});
