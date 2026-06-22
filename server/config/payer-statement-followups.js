/**
 * Payer statement dunning config (Phase 2 — P4).
 *
 * Each step fires `daysAfterDue` days after the statement's `due_date` (NOT after
 * it was sent — the AP was already notified at close; dunning begins only once the
 * NET window lapses). Anchoring to `due_date` makes the cadence terms-aware for
 * free: a net30 statement is dunned 15 days later in absolute time than a net15
 * one, because its due_date is later.
 *
 * Copy tone lives here (`reminderLine`) rather than in N separate email templates:
 * ONE `payer.statement.followup` template renders the per-step line. Edit cadence
 * + tone here; edit layout/CTA in the email template.
 *
 * The cron runs Tue–Fri at 10:00 AM America/New_York (no weekend nags, DST-safe),
 * mirroring the invoice follow-up window. A step is eligible when:
 *    now >= due_date + daysAfterDue  AND  status IN (sent, viewed)  AND  unpaid
 */

module.exports = {
  sendWindow: {
    daysOfWeek: [2, 3, 4, 5], // Tue, Wed, Thu, Fri
    hour: 10,                  // fires at 10 AM America/New_York (DST-safe)
  },

  // The touches. Order matters; step_index maps to this array. Anchored to
  // due_date, so a net15 and a net30 statement share the same offsets but dun at
  // different absolute times. `reminderLine` is the lead sentence in the email.
  steps: [
    {
      id: 'due0_reminder',
      daysAfterDue: 0,
      label: 'Due-date reminder',
      reminderLine: 'this is a friendly reminder that your Waves Pest Control statement {{statement_number}} ({{amount_due}}) is now due.',
    },
    {
      id: 'due15_firmer',
      daysAfterDue: 15,
      label: '15-day past-due notice',
      reminderLine: 'your Waves Pest Control statement {{statement_number}} ({{amount_due}}) is now {{days_past_due}} days past due. Please arrange payment at your earliest convenience.',
    },
    {
      id: 'due30_final',
      daysAfterDue: 30,
      label: '30-day final notice',
      reminderLine: 'this is a final notice — your Waves Pest Control statement {{statement_number}} ({{amount_due}}) is {{days_past_due}} days past due. Please remit payment or contact us to avoid a hold on future service.',
    },
  ],
};
