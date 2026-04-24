/**
 * Invoice Follow-up Sequence Config
 *
 * Each step defines when it fires (days after the invoice was sent) and what
 * the SMS says. Editing this file is the ONLY place sequence behavior changes.
 *
 * The cron runs Tue–Fri at 10:00 AM America/New_York (no weekend nags, DST-safe).
 * A step is eligible to fire when:
 *    now >= sent_at + daysAfterSend
 *
 * Variables available in the `body` template:
 *    {{name}}         — customer first name (falls back to "there")
 *    {{invoiceTitle}} — invoice.title (falls back to "your service")
 *    {{amount}}       — formatted like "127.50"
 *    {{serviceDate}}  — "April 3, 2026" if invoice.service_date is set, else ""
 *    {{payUrl}}       — https://portal.wavespestcontrol.com/pay/<token>
 */

module.exports = {
  // Days/hours the sequence is allowed to send SMS (America/New_York).
  // Cron handles the day-of-week; these are the additional hour filters.
  sendWindow: {
    daysOfWeek: [2, 3, 4, 5], // Tue, Wed, Thu, Fri
    hour: 10,                  // fires at 10 AM America/New_York (DST-safe)
  },

  // Thank-you SMS disabled — Stripe auto-emails a receipt and the pay link
  // they already have flips to a "Paid ✓" view with the full service report.
  // Avoids a third notification for the same payment.
  thankYou: {
    enabled: false,
    template_key: 'invoice_thank_you',
    body: '',
  },

  // The touches. Order matters; step_index maps to this array.
  // Cadence is anchored to invoice.sent_at so labels match operator intuition:
  // "3-day friendly nudge" = 3 days after the invoice went out.
  steps: [
    {
      id: 'd3_friendly',
      template_key: 'invoice_followup_3day',
      daysAfterSend: 3,
      label: '3-day friendly nudge',
      body:
        `Hi {{name}}, still showing an open balance on your invoice for {{invoiceTitle}} — ` +
        `\${{amount}}. Secure pay link: {{payUrl}}\n\nIf something's off, just reply and ` +
        `we'll sort it. — Waves`,
    },
    {
      id: 'd7_reminder',
      template_key: 'invoice_followup_7day',
      daysAfterSend: 7,
      label: '7-day reminder',
      body:
        `Hi {{name}}, just a friendly reminder from Waves — your invoice for ` +
        `{{invoiceTitle}}{{serviceDateClause}} is still open. You can pay here: ` +
        `{{payUrl}}\n\nQuestions? Reply to this message. — Waves`,
    },
    {
      id: 'd14_firmer',
      template_key: 'invoice_followup_14day',
      daysAfterSend: 14,
      label: '14-day check-in',
      body:
        `Hi {{name}}, checking in on your Waves invoice for ` +
        `{{invoiceTitle}}{{serviceDateClause}} — we'd appreciate payment at your ` +
        `earliest convenience: {{payUrl}}\n\nReply if you need anything. — Waves`,
    },
    {
      id: 'd30_final',
      template_key: 'invoice_followup_30day',
      daysAfterSend: 30,
      label: '30-day final notice',
      body:
        `Hi {{name}}, this is a final notice on your Waves invoice for ` +
        `{{invoiceTitle}}{{serviceDateClause}}. Please pay now to keep the ` +
        `account in good standing: {{payUrl}}\n\nReply to discuss a payment plan. — Waves`,
    },
  ],

  // After how many failed autopay attempts do we release the sequence from
  // autopay hold and start sending manual reminders?
  autopayFailureThreshold: 3,
};
