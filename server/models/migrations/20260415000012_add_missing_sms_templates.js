/**
 * Add the SMS templates that were still hardcoded across server code —
 * invoice receipts, estimate follow-ups, health alert outreach, and the
 * review-request 48h follow-up. Each service/route will now renderTemplate()
 * from the DB with these as the source of truth (and matching fallbacks).
 */
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const templates = [
    // ── billing ─────────────────────────────────────────────────
    {
      template_key: 'invoice_receipt',
      name: 'Payment Receipt',
      category: 'billing',
      body: 'Payment received — thank you, {first_name}!\n\nInvoice: {invoice_number}\nAmount: ${amount}{card_line}\n\nView receipt: {receipt_url}\n\nYour property is protected. See you at your next service!\n\n— Waves Pest Control',
      variables: ['first_name', 'invoice_number', 'amount', 'card_line', 'receipt_url'],
      sort_order: 17,
    },

    // ── estimates ───────────────────────────────────────────────
    {
      template_key: 'estimate_followup_unviewed',
      name: 'Estimate Follow-Up — Unviewed (24h)',
      category: 'estimates',
      body: 'Hey {first_name}! Just wanted to make sure you saw your Waves Pest Control estimate 🌊\n\n{estimate_url}\n\nTake a look when you get a chance — we\'re here if you have any questions! (941) 318-7612',
      variables: ['first_name', 'estimate_url'],
      sort_order: 22,
    },
    {
      template_key: 'estimate_followup_viewed',
      name: 'Estimate Follow-Up — Viewed Not Accepted (48h)',
      category: 'estimates',
      body: 'Hi {first_name}! I noticed you checked out your Waves estimate — any questions I can answer? 🌊\n\n{estimate_url}\n\nI\'m happy to walk through it with you. Just reply here or call (941) 318-7612.\n\n— Adam, Waves Pest Control',
      variables: ['first_name', 'estimate_url'],
      sort_order: 23,
    },
    {
      template_key: 'estimate_followup_final',
      name: 'Estimate Follow-Up — Final Nudge (5d)',
      category: 'estimates',
      body: 'Hey {first_name} — last check-in from me! Your Waves estimate is still available:\n\n{estimate_url}\n\nWe\'d love to earn your business. No pressure at all — just reply if you\'d like to move forward or have any questions.\n\n— Adam 🌊',
      variables: ['first_name', 'estimate_url'],
      sort_order: 24,
    },
    {
      template_key: 'estimate_followup_expiring',
      name: 'Estimate Follow-Up — Expiring',
      category: 'estimates',
      body: 'Hi {first_name}! Just a heads up — your Waves Pest Control estimate expires on {expires_at}.\n\n{estimate_url}\n\nLet us know if you\'d like to move forward! (941) 318-7612 🌊',
      variables: ['first_name', 'estimate_url', 'expires_at'],
      sort_order: 25,
    },

    // ── reviews ─────────────────────────────────────────────────
    {
      template_key: 'review_request_followup',
      name: 'Review Request — 48h Non-Responder',
      category: 'reviews',
      body: 'No pressure at all, {first_name} — but if you get a sec, your review helps other SWFL families find a pest company they can trust → {review_url} 🌊',
      variables: ['first_name', 'review_url'],
      sort_order: 31,
    },

    // ── retention / health ──────────────────────────────────────
    {
      template_key: 'health_check_in',
      name: 'Health — Check In',
      category: 'retention',
      body: 'Hi {first_name}, this is Adam from Waves Pest Control. Just checking in — everything going well with your service? Let us know if you need anything!',
      variables: ['first_name'],
      sort_order: 41,
    },
    {
      template_key: 'health_retention_offer',
      name: 'Health — Retention Offer',
      category: 'retention',
      body: 'Hi {first_name}, Adam here from Waves. We value your business and want to make sure you\'re getting the best experience. Would you be open to a quick call to discuss how we can better serve you?',
      variables: ['first_name'],
      sort_order: 42,
    },
    {
      template_key: 'health_rebook',
      name: 'Health — Rebook',
      category: 'retention',
      body: 'Hi {first_name}! It\'s been a while since your last service visit. We\'d love to get you back on the schedule. Reply or call us to book your next treatment!',
      variables: ['first_name'],
      sort_order: 43,
    },
    {
      template_key: 'health_payment_reminder',
      name: 'Health — Payment Reminder',
      category: 'retention',
      body: 'Hi {first_name}, this is Waves Pest Control. We noticed a billing issue on your account. Please give us a call at your convenience so we can get it sorted. Thank you!',
      variables: ['first_name'],
      sort_order: 44,
    },
    {
      template_key: 'health_apology',
      name: 'Health — Apology / Feedback',
      category: 'retention',
      body: 'Hi {first_name}, Adam from Waves here. I wanted to personally reach out — we always want you to be 100% satisfied. I\'d love to hear your feedback. Mind if I give you a call?',
      variables: ['first_name'],
      sort_order: 45,
    },
    {
      template_key: 'health_welcome_followup',
      name: 'Health — Welcome Follow-Up',
      category: 'retention',
      body: 'Hi {first_name}! Adam from Waves Pest Control. Just wanted to follow up on your service and make sure everything met your expectations. We\'re here for you!',
      variables: ['first_name'],
      sort_order: 46,
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
  // no-op
};
