/**
 * Termite annual plan — slice 5, Codex #4921 r3 structural fix.
 *
 * Rounds 1-3 each found a new edge case in the same class: an exact-day or
 * narrow notice window with no durable record that a notice was owed. This
 * migration adds the two columns the unified termite notice-obligation pass
 * (checkAndSend) needs to close that class for good, rather than patching
 * one more window:
 *
 * - annual_prepay_terms.notice_30_late_sent_at — mirrors
 *   notice_45_late_sent_at (20260926000104) for the 30-day rung: a 30-day
 *   notice delivered fewer than 30 days before term_end (because the term
 *   was first seen inside its own 30-day window, or a retry landed late).
 *   Recorded here, never as the notice_30_sent_at witness, so the catch-up
 *   loop never re-sends it and staff can see the promise was missed. The
 *   renewal-charge gate (slice 6b) only reads notice_45_sent_at, so a late
 *   30-day send does not by itself block auto-charge the way a late 45-day
 *   send does — this column exists for the durable record and its own
 *   admin escalation, not to gate billing.
 *
 * - annual_prepay_terms.notice_missed_escalated_at — stamped once a term
 *   reaches its own term_end with the 45-day and/or 30-day rung NEVER
 *   delivered (neither the on-time nor the late column set) — a durable
 *   safety net for a rung whose daily retry never got a confirmed send
 *   before the renewal date arrived. Stamped only after a CONFIRMED
 *   notifyAdmin insert (same non-null-result pattern as
 *   notice_45_late_escalated_at), so a transient notification-insert
 *   failure is retried on the next sweep instead of silently losing the
 *   escalation.
 *
 * Additive, nullable, hasTable/hasColumn-guarded — safe to run more than
 * once and safe on a database that predates the table.
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (!(await knex.schema.hasColumn('annual_prepay_terms', 'notice_30_late_sent_at'))) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.timestamp('notice_30_late_sent_at', { useTz: true });
    });
  }
  if (!(await knex.schema.hasColumn('annual_prepay_terms', 'notice_missed_escalated_at'))) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.timestamp('notice_missed_escalated_at', { useTz: true });
    });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  if (await knex.schema.hasColumn('annual_prepay_terms', 'notice_30_late_sent_at')) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.dropColumn('notice_30_late_sent_at');
    });
  }
  if (await knex.schema.hasColumn('annual_prepay_terms', 'notice_missed_escalated_at')) {
    await knex.schema.alterTable('annual_prepay_terms', (t) => {
      t.dropColumn('notice_missed_escalated_at');
    });
  }
};
