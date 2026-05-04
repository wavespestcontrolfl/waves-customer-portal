/**
 * Sync every SMS template body to the admin-edited source-of-truth.
 * The admin UI at /admin/communications → SMS Templates is where Waves
 * curates brand voice. This migration takes those edits and hardcodes
 * them so a fresh deploy / database rebuild matches production exactly.
 *
 * Every entry is an UPDATE (or INSERT if missing). Existing customized
 * rows in the DB will be overwritten — that is the intent.
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const templates = [
    // ── automations ─────────────────────────────────────────────
    {
      template_key: 'auto_new_recurring',
      name: 'New Recurring Customer',
      category: 'automations',
      body: 'Hello {first_name}! Welcome to a safer, pest-free home with Waves! Check your inbox, we just emailed you our welcome guide.\n\nIf you have any questions or need assistance, simply reply to this message.',
      variables: ['first_name'],
      sort_order: 40,
    },
    {
      template_key: 'auto_lawn_service',
      name: 'Lawn Care Onboarding',
      category: 'automations',
      body: 'Hello {first_name}! Welcome to a better lawn with Waves! We just emailed you our lawn care welcome guide + expert tips for the best results for your lawn!\n\nIf you have any questions or need assistance, simply reply to this message.',
      variables: ['first_name'],
      sort_order: 41,
    },
    {
      template_key: 'auto_new_appointment',
      name: 'New First-Time Appointment',
      category: 'automations',
      body: 'Hello {first_name}! We just emailed you a breakdown of what to expect with your upcoming service with Waves!\n\nIf you have any questions or need assistance, simply reply to this message.',
      variables: ['first_name'],
      sort_order: 42,
    },
    {
      template_key: 'auto_bed_bug',
      name: 'Bed Bug Treatment',
      category: 'automations',
      body: "Hello {first_name}! Let's get your home bed bug-free. We just emailed you your Waves treatment guide—please review it to help us get the best results for your home!\n\nIf you have any questions or need assistance, simply reply to this message.",
      variables: ['first_name'],
      sort_order: 43,
    },
    {
      template_key: 'auto_cockroach',
      name: 'Cockroach Control',
      category: 'automations',
      body: "Hello {first_name}! Let's get your home cockroach-free. We just emailed you your Waves treatment guide—please review it to help us get the best results for your home!\n\nIf you have any questions or need assistance, simply reply to this message.",
      variables: ['first_name'],
      sort_order: 44,
    },
    {
      template_key: 'auto_new_lead',
      name: 'New Lead',
      category: 'automations',
      body: 'Hello {first_name}! Thanks for your interest in Waves Pest Control. We just sent you an email with more info about our services.\n\nIf you have any questions or need assistance, simply reply to this message.',
      variables: ['first_name'],
      sort_order: 45,
    },
    {
      template_key: 'auto_service_renewal',
      name: 'Service Renewal Reminder',
      category: 'automations',
      body: 'Hello {first_name}! Your Waves service is coming up for renewal. We just emailed you the details — take a look when you get a chance.\n\nIf you have any questions or need assistance, simply reply to this message.',
      variables: ['first_name'],
      sort_order: 46,
    },

    // ── billing ─────────────────────────────────────────────────
    {
      template_key: 'invoice_sent',
      name: 'Invoice Sent',
      category: 'billing',
      body: 'Hello {first_name}! Your invoice for {service_type} completed on {service_date} is ready: {pay_url}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!',
      variables: ['first_name', 'service_type', 'service_date', 'pay_url'],
      sort_order: 10,
    },
    {
      template_key: 'payment_failed',
      name: 'Payment Failed',
      category: 'billing',
      body: "Hello {first_name}, your payment for {service_type} completed on {service_date} didn't go through. Please update your payment method or pay here: {pay_url}.\n\nIf you have any questions or need assistance, simply reply to this message.",
      variables: ['first_name', 'service_type', 'service_date', 'pay_url'],
      sort_order: 11,
    },
    {
      template_key: 'late_payment_7d',
      name: 'Late Payment — 7 Day',
      category: 'billing',
      body: 'Hello {first_name}! This is a reminder from Waves. Your invoice for {invoice_title} completed on {service_date} is now 7 days overdue.\n\nPlease make your payment here: {pay_url}\n\nQuestions or requests? Reply to this message.',
      variables: ['first_name', 'invoice_title', 'service_date', 'pay_url'],
      sort_order: 12,
    },
    {
      template_key: 'late_payment_14d',
      name: 'Late Payment — 14 Day',
      category: 'billing',
      body: 'Hello {first_name}, this is a reminder from Waves. Your invoice for {invoice_title} completed on {service_date} is now 14 days overdue.\n\nPlease make your payment as soon as possible at: {pay_url}\n\nQuestions or requests? Reply to this message.',
      variables: ['first_name', 'invoice_title', 'service_date', 'pay_url'],
      sort_order: 13,
    },
    {
      template_key: 'late_payment_30d',
      name: 'Late Payment — 30 Day',
      category: 'billing',
      body: 'Hello {first_name}, this is a final reminder from Waves. Your invoice for {invoice_title} completed on {service_date} is now 30 days overdue.\n\nPlease make your payment immediately at: {pay_url}\n\nQuestions or requests? Reply to this message.',
      variables: ['first_name', 'invoice_title', 'service_date', 'pay_url'],
      sort_order: 14,
    },
    {
      template_key: 'late_payment_60d',
      name: 'Late Payment — 60 Day',
      category: 'billing',
      body: 'Hello {first_name}, this is an urgent notice from Waves. Your invoice for {invoice_title} completed on {service_date} is now 60 days overdue.\n\nPlease make payment or contact us immediately to avoid further action: {pay_url}\n\nQuestions or requests? Reply to this message.',
      variables: ['first_name', 'invoice_title', 'service_date', 'pay_url'],
      sort_order: 15,
    },
    {
      template_key: 'late_payment_90d',
      name: 'Late Payment — 90 Day',
      category: 'billing',
      body: 'Hello {first_name}, your invoice from Waves for {invoice_title} completed on {service_date} is now 90 days overdue.\n\nFinal notice: This account will be sent to collections if payment is not received today. Please pay now: {pay_url}\n\nQuestions or requests? Reply to this message.',
      variables: ['first_name', 'invoice_title', 'service_date', 'pay_url'],
      sort_order: 16,
    },
    {
      template_key: 'invoice_followup_3day',
      name: 'Invoice — 3-Day Friendly Nudge',
      category: 'billing',
      body: "Hello {first_name}, we're still showing an open balance on your {invoice_title} invoice. Pay securely here: {pay_url}\n\nIf something's off, just reply and we'll sort it. Questions or requests? Reply to this message.",
      variables: ['first_name', 'invoice_title', 'amount', 'pay_url'],
      sort_order: 18,
    },

    // ── estimates ───────────────────────────────────────────────
    {
      template_key: 'estimate_sent',
      name: 'Estimate Sent',
      category: 'estimates',
      body: 'Hello {first_name}! Your Waves estimate is ready: {estimate_url}\n\nQuestions or requests? Reply to this message. Thank you for considering Waves!',
      variables: ['first_name', 'estimate_url'],
      sort_order: 20,
    },
    {
      template_key: 'lead_auto_reply_biz',
      name: 'Lead Auto-Reply (Business Hours)',
      category: 'estimates',
      body: 'Hello {first_name}! Waves here! We received your quote request. A specialist will be calling soon. Thank you!',
      variables: ['first_name'],
      sort_order: 21,
    },

    // ── internal ────────────────────────────────────────────────
    {
      template_key: 'admin_new_lead',
      name: 'New Lead Alert',
      category: 'internal',
      body: '🔔 New lead! {name} 📞 {phone} 📍 {address} 🌐 {source}',
      variables: ['name', 'phone', 'address', 'source'],
      sort_order: 60,
    },

    // ── referrals ───────────────────────────────────────────────
    {
      template_key: 'referral_nudge',
      name: 'Referral Nudge',
      category: 'referrals',
      body: 'Hello {first_name}! Share your link — they get $25 off, you get $25: {referral_link}',
      variables: ['first_name', 'referral_link'],
      sort_order: 31,
    },

    // ── retention ───────────────────────────────────────────────
    {
      template_key: 'churn_save_step1',
      name: 'Churn Save — Step 1',
      category: 'retention',
      body: 'Hello {first_name}, this is Adam from Waves. Just checking in — anything we can do better? Reply here.',
      variables: ['first_name'],
      sort_order: 40,
    },

    // ── reviews ─────────────────────────────────────────────────
    {
      template_key: 'review_request',
      name: 'Review Request',
      category: 'reviews',
      body: "Hello {first_name}! How was your service? We'd love your feedback: {review_url}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!",
      variables: ['first_name', 'review_url'],
      sort_order: 30,
    },

    // ── service ─────────────────────────────────────────────────
    {
      template_key: 'appointment_confirmation',
      name: 'Appointment Confirmation',
      category: 'service',
      body: 'Hello {first_name}! Your {service_type} with Waves is confirmed for {date} at {time}.\n\nQuestions or requests? Reply to this message.',
      variables: ['first_name', 'service_type', 'date', 'time'],
      sort_order: 1,
    },
    {
      template_key: 'reminder_72h',
      name: '72-Hour Reminder',
      category: 'service',
      body: 'Hello {first_name}! This is a reminder from Waves that your {service_type} appointment is scheduled for {day} at {time}. Expect your technician to arrive within a two-hour window of your scheduled start time. Need to reschedule? Log into your Waves Customer Portal at portal.wavespestcontrol.com.\n\nQuestions or requests? Reply to this message.',
      variables: ['first_name', 'service_type', 'day', 'time'],
      sort_order: 2,
    },
    {
      template_key: 'tech_en_route',
      name: 'Tech En Route',
      category: 'service',
      body: 'Hello {first_name}! Your Waves technician is on the way. ETA: ~{eta_minutes} minutes. Log into the Waves Customer Portal at portal.wavespestcontrol.com to track your technician live.\n\nQuestions or requests? Reply to this message.',
      variables: ['first_name', 'eta_minutes'],
      sort_order: 3,
    },
    {
      template_key: 'reminder_24h',
      name: '24-Hour Reminder',
      category: 'service',
      body: 'Hello {first_name}! This is a reminder from Waves that your {service_type} appointment is scheduled for tomorrow at {time}. Expect your technician to arrive within a two-hour window of your scheduled start time. Your technician will text you when they are 15 minutes out.\n\nQuestions or requests? Reply to this message.',
      variables: ['first_name', 'service_type', 'time'],
      sort_order: 4,
    },
    {
      template_key: 'service_complete',
      name: 'Service Complete',
      category: 'service',
      body: 'Hello {first_name}! Your service report is ready. View it here: portal.wavespestcontrol.com\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!',
      variables: ['first_name'],
      sort_order: 5,
    },
    {
      template_key: 'appointment_call_confirmed',
      name: 'Appointment Confirmed (Call)',
      category: 'service',
      body: 'Hello {first_name}! Your {service_type} with Waves is confirmed for {date} at {time}.\n\nQuestions or requests? Reply to this message.',
      variables: ['first_name', 'service_type', 'date', 'time'],
      sort_order: 6,
    },
    {
      template_key: 'missed_call',
      name: 'Missed Call Follow-Up',
      category: 'service',
      body: 'Hello {first_name}, this is Waves. Sorry we missed your call. How can we help?',
      variables: ['first_name'],
      sort_order: 7,
    },
    {
      template_key: 'appointment_rescheduled',
      name: 'Appointment Rescheduled',
      category: 'service',
      body: 'Hello {first_name}! Your {service_type} with Waves has been rescheduled to {day}, {date} at {time}.\n\nNeed to change it again? Log into your Waves Customer Portal at portal.wavespestcontrol.com.\n\nQuestions or requests? Reply to this message.',
      variables: ['first_name', 'service_type', 'day', 'date', 'time'],
      sort_order: 8,
    },
    {
      template_key: 'appointment_cancelled',
      name: 'Appointment Cancelled',
      category: 'service',
      body: "Hello {first_name}! Your {service_type} with Waves scheduled for {day}, {date} has been cancelled.\n\nWant to reschedule? Reply to this message and we'll get you back on the calendar.",
      variables: ['first_name', 'service_type', 'day', 'date'],
      sort_order: 9,
    },
  ];

  for (const t of templates) {
    const row = {
      template_key: t.template_key,
      name: t.name,
      category: t.category,
      body: t.body,
      variables: JSON.stringify(t.variables),
      sort_order: t.sort_order,
      updated_at: new Date(),
    };
    const existing = await knex('sms_templates').where({ template_key: t.template_key }).first();
    if (existing) {
      await knex('sms_templates').where({ template_key: t.template_key }).update(row);
    } else {
      await knex('sms_templates').insert({ ...row, created_at: new Date() });
    }
  }
};

exports.down = async function () {
  // no-op — this migration is non-destructive in terms of schema and only
  // resets copy. Rolling back would restore stale bodies, which is not useful.
};
