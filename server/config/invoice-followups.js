/**
 * Invoice Follow-up Sequence Config
 *
 * Each step defines when it fires (days after the invoice was sent) and which
 * sms_templates row supplies the body. Edit copy in the admin SMS Templates UI
 * (template_key fields below); edit cadence here.
 *
 * The cron runs Tue–Fri at 10:00 AM America/New_York (no weekend nags, DST-safe).
 * A step is eligible to fire when:
 *    now >= sent_at + daysAfterSend
 */

module.exports = {
  sendWindow: {
    daysOfWeek: [2, 3, 4, 5], // Tue, Wed, Thu, Fri
    hour: 10,                  // fires at 10 AM America/New_York (DST-safe)
  },

  // Thank-you SMS disabled — Stripe auto-emails a receipt and the pay link
  // they already have flips to a "Paid ✓" view with the full service report.
  thankYou: {
    enabled: false,
    template_key: 'invoice_thank_you',
  },

  // The touches. Order matters; step_index maps to this array.
  // Cadence is anchored to invoice.sent_at so labels match operator intuition:
  // "3-day friendly nudge" = 3 days after the invoice went out.
  steps: [
    { id: 'd3_friendly',  template_key: 'invoice_followup_3day',  daysAfterSend: 3,  label: '3-day friendly nudge' },
    { id: 'd7_reminder',  template_key: 'invoice_followup_7day',  daysAfterSend: 7,  label: '7-day reminder' },
    { id: 'd14_firmer',   template_key: 'invoice_followup_14day', daysAfterSend: 14, label: '14-day check-in' },
    { id: 'd30_final',    template_key: 'invoice_followup_30day', daysAfterSend: 30, label: '30-day final notice' },
  ],

  // GATE_DUNNING_LADDER_90 (dark; dunning unification, owner rulings
  // 2026-09-27): the ladder owns an overdue invoice through Day 90 with
  // touches a week or more apart, and Day 90 is the only final notice. The
  // first four steps keep their ids, so step_index and the ledger keys built
  // from step ids stay stable across the switch; only their days and labels
  // move. `steps` above stays the legacy cadence that the gate-off path and
  // the 2026-04 backfill migration read.
  stepsThrough90: [
    { id: 'd3_friendly',      template_key: 'invoice_followup_3day',  daysAfterSend: 3,  label: '3-day friendly nudge' },
    { id: 'd7_reminder',      template_key: 'invoice_followup_7day',  daysAfterSend: 10, label: '10-day reminder' },
    { id: 'd14_firmer',       template_key: 'invoice_followup_14day', daysAfterSend: 17, label: '17-day check-in' },
    { id: 'd30_final',        template_key: 'invoice_followup_30day', daysAfterSend: 30, label: '30-day reminder' },
    { id: 'd60_reminder',     template_key: 'invoice_followup_60day', daysAfterSend: 60, label: '60-day reminder' },
    { id: 'd90_final_notice', template_key: 'invoice_followup_90day', daysAfterSend: 90, label: '90-day final notice' },
  ],

  // After how many failed autopay attempts do we release the sequence from
  // autopay hold and start sending manual reminders?
  autopayFailureThreshold: 3,
};
