/**
 * Invoice Follow-up Sequence Config
 *
 * Each step defines when it fires (days after the invoice's due date) and what
 * the SMS says. Editing this file is the ONLY place sequence behavior changes.
 *
 * The cron runs Tue–Fri at 10:00 AM America/New_York (no weekend nags).
 * A step is eligible to fire when:
 *    now >= due_date + daysAfterDue
 *
 * Variables available in the `body` template:
 *    {{name}}         — customer first name (falls back to "there")
 *    {{invoiceTitle}} — invoice.title (falls back to "your service")
 *    {{amount}}       — formatted like "127.50"
 *    {{serviceDate}}  — "April 3, 2026" if invoice.service_date is set, else ""
 *    {{payUrl}}       — https://portal.wavespestcontrol.com/pay/<token>
 */

module.exports = {
  // Days/hours the sequence is allowed to send SMS (America/New_York)
  // Cron handles the day-of-week; these are the additional hour filters.
  sendWindow: {
    daysOfWeek: [2, 3, 4, 5], // Tue, Wed, Thu, Fri
    hour: 10,                  // fires at 10 AM
  },

  // Thank-you message sent when an invoice is paid AFTER at least one reminder fired.
  thankYou: {
    enabled: true,
    template_key: 'invoice_thank_you',
    body:
      `{{name}}, got it — thank you for the payment! Your account is all caught up. ` +
      `See you at your next service. — Waves 🌊`,
  },

  // The touches. Order matters; step_index maps to this array.
  steps: [
    {
      id: 'due_today',
      template_key: 'invoice_due_today',
      daysAfterDue: 0,
      label: 'Due-date reminder',
      body:
        `Hi {{name}}! Quick reminder from Waves — your invoice for {{invoiceTitle}} ` +
        `(\${{amount}}) is due today. Pay here: {{payUrl}}\n\nAlready paid? Disregard — ` +
        `takes a few hours to clear. Reply with any questions. — Waves`,
    },
    {
      id: 'd3_friendly',
      template_key: 'invoice_followup_3day',
      daysAfterDue: 3,
      label: '3-day friendly nudge',
      body:
        `Hi {{name}}, still showing an open balance on your invoice for {{invoiceTitle}} — ` +
        `\${{amount}}. Secure pay link: {{payUrl}}\n\nIf something's off, just reply and ` +
        `we'll sort it. — Waves`,
    },
    {
      id: 'd7_firmer',
      template_key: 'invoice_followup_7day',
      daysAfterDue: 7,
      label: '7-day follow-up',
      body:
        `Hello {{name}}, this is a reminder from Waves. Your invoice for {{invoiceTitle}}` +
        `{{serviceDateClause}} is now 7 days overdue.\n\nPlease make your payment here: ` +
        `{{payUrl}}\n\nQuestions? Reply to this message. Thank you for choosing Waves!`,
    },
    {
      id: 'd14_urgent',
      template_key: 'invoice_followup_14day',
      daysAfterDue: 14,
      label: '14-day urgent',
      body:
        `Hello {{name}}, your invoice for {{invoiceTitle}}{{serviceDateClause}} is now ` +
        `14 days overdue. Please make payment as soon as possible: {{payUrl}}\n\n` +
        `Questions? Reply to this message. — Waves`,
    },
    {
      id: 'd30_final',
      template_key: 'invoice_followup_30day',
      daysAfterDue: 30,
      label: '30-day final notice',
      body:
        `Hello {{name}}, this is a final reminder. Your invoice for {{invoiceTitle}}` +
        `{{serviceDateClause}} is 30 days overdue. Please pay immediately to avoid ` +
        `collections: {{payUrl}}\n\nReply to discuss or request a payment plan. — Waves`,
    },
  ],

  // After how many failed autopay attempts do we release the sequence from
  // autopay hold and start sending manual reminders?
  autopayFailureThreshold: 3,
};
