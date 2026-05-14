/**
 * Migration: Label every SMS template that came from a hardcoded fallback
 * with a " (hardcoded)" suffix in the `name` field, and seed any new keys
 * needed for templates that previously lived only as inline strings.
 *
 * Companion change: every call site listed below has had its inline fallback
 * string removed. The DB row in sms_templates is now the only source of copy
 * for these messages — disabling/editing the row controls the live behavior.
 */

const HARDCODED_TEMPLATE_KEYS = [
  // appointment / scheduling
  "self_booking_confirmation",
  "reschedule_options_weather",
  "reschedule_options_access",
  "reschedule_options_general",
  "reschedule_confirmed_sms_reply",
  "reschedule_call_requested",
  "tech_en_route",
  "tech_arrived",
  "service_complete",

  // billing
  "invoice_sent",
  "invoice_receipt",
  "invoice_followup_3day",
  "invoice_followup_7day",
  "invoice_followup_14day",
  "invoice_followup_30day",
  "late_payment_7d",
  "late_payment_14d",
  "late_payment_30d",
  "late_payment_60d",
  "late_payment_90d",
  "billing_reminder",

  // estimates
  "estimate_followup_unviewed",
  "estimate_followup_viewed",
  "estimate_followup_final",
  "estimate_followup_expiring",

  // reviews / referrals / retention
  "review_request",
  "referral_nudge",
  "renewal_reminder",
  "seasonal_reactivation",

  // operational / dead-code paths kept for completeness
  "service_reminder_legacy",
  "seasonal_alert",
  "onboarding_welcome",
];

const SUFFIX = " (hardcoded)";

const NEW_TEMPLATES = [
  {
    template_key: "onboarding_welcome",
    name: "Onboarding Welcome",
    category: "service",
    body: "Welcome to Waves, {first_name}! Your first {service_type} is {service_date}{tech_clause}. Log into your portal anytime: portal.wavespestcontrol.com",
    variables: ["first_name", "service_type", "service_date", "tech_clause"],
    sort_order: 0,
  },
  {
    template_key: "tech_arrived",
    name: "Tech Arrived",
    category: "service",
    body: "Hello {first_name}! {tech_name} has arrived and is servicing your property.\n\nQuestions or requests? Reply to this message. Reply STOP to opt out.",
    variables: ["first_name", "tech_name"],
    sort_order: 4,
  },
  {
    template_key: "billing_reminder",
    name: "Billing Reminder (WaveGuard Monthly)",
    category: "billing",
    body: "Hi {first_name}, your {waveguard_tier} WaveGuard monthly charge of ${amount} will be processed on {charge_date}.\n\nManage your payment method in your customer portal or call (941) 318-7612.",
    variables: ["first_name", "waveguard_tier", "amount", "charge_date"],
    sort_order: 18,
  },
  {
    template_key: "service_reminder_legacy",
    name: "Service Reminder (Legacy 24h)",
    category: "service",
    body: "Hi {first_name}! Your {service_type} is scheduled for tomorrow {time_window}.\n\nTechnician: {tech_name}\n\nPlease ensure gates are unlocked and pets are secured. Reply CONFIRM to confirm or call (941) 318-7612 to reschedule.",
    variables: ["first_name", "service_type", "time_window", "tech_name"],
    sort_order: 6,
  },
  {
    template_key: "seasonal_alert",
    name: "Seasonal Alert / Tip",
    category: "retention",
    body: "Hi {first_name}! {tip}\n\nQuestions? Reply to this text or call (941) 318-7612.",
    variables: ["first_name", "tip"],
    sort_order: 50,
  },
  {
    template_key: "seasonal_reactivation",
    name: "Seasonal Reactivation",
    category: "retention",
    body: "Hi {first_name}! {hook_text}. We'd love to get you back on the schedule{address_clause}. Reply YES or call {call_number} to book. - Waves Pest Control",
    variables: ["first_name", "hook_text", "address_clause", "call_number"],
    sort_order: 51,
  },
  // Re-seed invoice_followup_{7,14,30}day — deleted by migration
  // 20260415000007 and never restored. The follow-up engine references
  // these keys, and the inline fallback is gone in this PR.
  {
    template_key: "invoice_followup_7day",
    name: "Invoice Follow-Up — 7 Day",
    category: "billing",
    body: "Hi {first_name}, just a friendly reminder from Waves — your invoice for {invoice_title}{service_date_clause} is still open. You can pay here: {pay_url}\n\nQuestions? Reply to this message. — Waves",
    variables: [
      "first_name",
      "invoice_title",
      "service_date_clause",
      "pay_url",
    ],
    sort_order: 20,
  },
  {
    template_key: "invoice_followup_14day",
    name: "Invoice Follow-Up — 14 Day",
    category: "billing",
    body: "Hi {first_name}, checking in on your Waves invoice for {invoice_title}{service_date_clause} — we'd appreciate payment at your earliest convenience: {pay_url}\n\nReply if you need anything. — Waves",
    variables: [
      "first_name",
      "invoice_title",
      "service_date_clause",
      "pay_url",
    ],
    sort_order: 21,
  },
  {
    template_key: "invoice_followup_30day",
    name: "Invoice Follow-Up — 30 Day",
    category: "billing",
    body: "Hi {first_name}, this is a final notice on your Waves invoice for {invoice_title}{service_date_clause}. Please pay now to keep the account in good standing: {pay_url}\n\nReply to discuss a payment plan. — Waves",
    variables: [
      "first_name",
      "invoice_title",
      "service_date_clause",
      "pay_url",
    ],
    sort_order: 22,
  },
];

const REQUIRED_TEMPLATE_SEEDS = [
  {
    template_key: "self_booking_confirmation",
    name: "Self-Booking Confirmation",
    category: "service",
    body: "Hello {first_name}! Your Waves appointment is confirmed for {date}, {time} at {address}. Confirmation: {confirmation_code}.\n\nNeed to change it? Reply RESCHEDULE. Questions or requests? Reply to this message.",
    variables: ["first_name", "date", "time", "address", "confirmation_code"],
    sort_order: 13,
  },
  {
    template_key: "reschedule_options_weather",
    name: "Reschedule Options - Weather",
    category: "service",
    body: "Hello {first_name}, due to weather your {service_type} on {original_date} needs to move.\n\nWe have:\n1. {option_1}\n2. {option_2}\n\nReply 1 or 2, or suggest a day. Questions or requests? Reply to this message.",
    variables: [
      "first_name",
      "service_type",
      "original_date",
      "option_1",
      "option_2",
    ],
    sort_order: 8,
  },
  {
    template_key: "reschedule_options_access",
    name: "Reschedule Options - Access Issue",
    category: "service",
    body: "Hello {first_name}, we stopped by for your {service_type} but {access_issue}. We can come back:\n\n1. {option_1}\n2. {option_2}\n\nReply 1 or 2. Questions or requests? Reply to this message.",
    variables: [
      "first_name",
      "service_type",
      "access_issue",
      "option_1",
      "option_2",
    ],
    sort_order: 9,
  },
  {
    template_key: "reschedule_options_general",
    name: "Reschedule Options - General",
    category: "service",
    body: "Hello {first_name}, your {service_type} on {original_date} needs to be rescheduled.{reason_text}\n\n1. {option_1}\n2. {option_2}\n\nReply 1 or 2. Questions or requests? Reply to this message.",
    variables: [
      "first_name",
      "service_type",
      "original_date",
      "reason_text",
      "option_1",
      "option_2",
    ],
    sort_order: 10,
  },
  {
    template_key: "reschedule_confirmed_sms_reply",
    name: "Reschedule Confirmed - SMS Reply",
    category: "service",
    body: "Confirmed! Your service is rescheduled for {date}, {time}.\n\nWe'll remind you the day before. Questions or requests? Reply to this message.",
    variables: ["date", "time"],
    sort_order: 11,
  },
  {
    template_key: "reschedule_call_requested",
    name: "Reschedule - Call Requested Reply",
    category: "service",
    body: "No problem! We'll give you a call shortly.\n\nQuestions or requests? Reply to this message.",
    variables: [],
    sort_order: 12,
  },
  {
    template_key: "tech_en_route",
    name: "Tech En Route",
    category: "service",
    body: "Hello {first_name}! {tech_name} is on the way.\n\n{eta_line}{track_clause}Questions or requests? Reply to this message. Reply STOP to opt out.",
    variables: ["first_name", "tech_name", "eta_line", "track_clause"],
    sort_order: 3,
  },
  {
    template_key: "service_complete",
    name: "Service Complete",
    category: "service",
    body: "Hello {first_name}! Your service report is ready. View it here: portal.wavespestcontrol.com\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!",
    variables: ["first_name"],
    sort_order: 4,
  },
  {
    template_key: "invoice_sent",
    name: "Invoice Sent",
    category: "billing",
    body: "Hi {first_name}! Your invoice for {service_type} completed on {service_date} is ready: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!",
    variables: ["first_name", "service_type", "service_date", "pay_url"],
    sort_order: 10,
  },
  {
    template_key: "invoice_receipt",
    name: "Payment Receipt",
    category: "billing",
    body: "Payment received — thank you, {first_name}!\n\nInvoice: {invoice_number}\nAmount: ${amount}{card_line}\n\nView receipt: {receipt_url}\n\nYour property is protected. See you at your next service!\n\n— Waves Pest Control",
    variables: [
      "first_name",
      "invoice_number",
      "amount",
      "card_line",
      "receipt_url",
    ],
    sort_order: 17,
  },
  {
    template_key: "invoice_followup_3day",
    name: "Invoice Follow-Up — 3 Day",
    category: "billing",
    body: "Hi {first_name}, still showing an open balance on your invoice for {invoice_title} — \${amount}. Secure pay link: {pay_url}\n\nIf something's off, just reply and we'll sort it. — Waves",
    variables: ["first_name", "invoice_title", "amount", "pay_url"],
    sort_order: 19,
  },
  {
    template_key: "late_payment_7d",
    name: "Late Payment — 7 Day",
    category: "billing",
    body: "Hello {first_name}! This is a reminder from Waves. Your invoice for {invoice_title}{service_date_clause} is now 7 days overdue.\n\nPlease make your payment here: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!",
    variables: [
      "first_name",
      "invoice_title",
      "service_date_clause",
      "pay_url",
    ],
    sort_order: 12,
  },
  {
    template_key: "late_payment_14d",
    name: "Late Payment — 14 Day",
    category: "billing",
    body: "Hello {first_name}, this is a reminder from Waves. Your invoice for {invoice_title}{service_date_clause} is now 14 days overdue.\n\nPlease make your payment as soon as possible at: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!",
    variables: [
      "first_name",
      "invoice_title",
      "service_date_clause",
      "pay_url",
    ],
    sort_order: 13,
  },
  {
    template_key: "late_payment_30d",
    name: "Late Payment — 30 Day",
    category: "billing",
    body: "Hello {first_name}, this is a final reminder from Waves. Your invoice for {invoice_title}{service_date_clause} is now 30 days overdue.\n\nPlease make your payment immediately at: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!",
    variables: [
      "first_name",
      "invoice_title",
      "service_date_clause",
      "pay_url",
    ],
    sort_order: 14,
  },
  {
    template_key: "late_payment_60d",
    name: "Late Payment — 60 Day",
    category: "billing",
    body: "Hello {first_name}, this is an urgent notice from Waves. Your invoice for {invoice_title}{service_date_clause} is now 60 days overdue.\n\nPlease make payment or contact us immediately to avoid further action: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!",
    variables: [
      "first_name",
      "invoice_title",
      "service_date_clause",
      "pay_url",
    ],
    sort_order: 15,
  },
  {
    template_key: "late_payment_90d",
    name: "Late Payment — 90 Day",
    category: "billing",
    body: "Hello {first_name}, your invoice from Waves for {invoice_title}{service_date_clause} is now 90 days overdue.\n\nFinal notice: This account will be sent to collections if payment is not received today. Please pay now: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!",
    variables: [
      "first_name",
      "invoice_title",
      "service_date_clause",
      "pay_url",
    ],
    sort_order: 16,
  },
  {
    template_key: "estimate_followup_unviewed",
    name: "Estimate Follow-Up — Unviewed 24h",
    category: "estimates",
    body: "Hey {first_name}! Just wanted to make sure you saw your Waves Pest Control estimate.\n\n{estimate_url}\n\nTake a look when you get a chance — we're here if you have any questions! (941) 318-7612",
    variables: ["first_name", "estimate_url"],
    sort_order: 26,
  },
  {
    template_key: "estimate_followup_viewed",
    name: "Estimate Follow-Up — Viewed Not Accepted 48h",
    category: "estimates",
    body: "Hi {first_name}! I noticed you checked out your Waves estimate — any questions I can answer?\n\n{estimate_url}\n\nI'm happy to walk through it with you. Just reply here or call (941) 318-7612.\n\n— Adam, Waves Pest Control",
    variables: ["first_name", "estimate_url"],
    sort_order: 27,
  },
  {
    template_key: "estimate_followup_final",
    name: "Estimate Follow-Up — Final Nudge 5d",
    category: "estimates",
    body: "Hey {first_name} — last check-in from me! Your Waves estimate is still available:\n\n{estimate_url}\n\nWe'd love to earn your business. No pressure at all — just reply if you'd like to move forward or have any questions.\n\n— Adam",
    variables: ["first_name", "estimate_url"],
    sort_order: 28,
  },
  {
    template_key: "estimate_followup_expiring",
    name: "Estimate Follow-Up — Expiring",
    category: "estimates",
    body: "Hi {first_name}! Just a heads up — your Waves Pest Control estimate expires on {expires_at}.\n\n{estimate_url}\n\nLet us know if you'd like to move forward! (941) 318-7612",
    variables: ["first_name", "estimate_url", "expires_at"],
    sort_order: 29,
  },
  {
    template_key: "review_request",
    name: "Review Request",
    category: "reviews",
    body: "Hi {first_name}! How was your service? We'd love your feedback: {review_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!",
    variables: ["first_name", "review_url"],
    sort_order: 30,
  },
  {
    template_key: "referral_nudge",
    name: "Referral Nudge",
    category: "referrals",
    body: "Hi {first_name}! Share your link — they get $25 off, you get $50: {referral_link}",
    variables: ["first_name", "referral_link"],
    sort_order: 31,
  },
  {
    template_key: "renewal_reminder",
    name: "Renewal Reminder",
    category: "retention",
    body: "Hello {first_name}! Your {renewal_label} {urgency}.\n\nDon't let your coverage lapse - reply RENEW or call us to take care of it. Questions or requests? Reply to this message.",
    variables: ["first_name", "renewal_label", "urgency"],
    sort_order: 48,
  },
];

// Bring late_payment_* bodies onto the {service_date_clause} variable shape
// that the new call sites pass. Existing rows seeded by 20260415000011 use
// {service_date}, which would now leave an unresolved placeholder and
// silently null out every reminder. Preserve operator-edited copy by only
// rewriting the legacy placeholder instead of replacing the whole body.
const BODY_REWRITES = [
  {
    template_key: "late_payment_7d",
    variables: [
      "first_name",
      "invoice_title",
      "service_date_clause",
      "pay_url",
    ],
  },
  {
    template_key: "late_payment_14d",
    variables: [
      "first_name",
      "invoice_title",
      "service_date_clause",
      "pay_url",
    ],
  },
  {
    template_key: "late_payment_30d",
    variables: [
      "first_name",
      "invoice_title",
      "service_date_clause",
      "pay_url",
    ],
  },
  {
    template_key: "late_payment_60d",
    variables: [
      "first_name",
      "invoice_title",
      "service_date_clause",
      "pay_url",
    ],
  },
  {
    template_key: "late_payment_90d",
    variables: [
      "first_name",
      "invoice_title",
      "service_date_clause",
      "pay_url",
    ],
  },
];

function rewriteLegacyServiceDateBody(body) {
  if (typeof body !== "string") return body;
  if (!/\{service_date\}/.test(body)) return body;
  return body
    .replace(/ completed on \{service_date\}/g, "{service_date_clause}")
    .replace(/\{service_date\}/g, "{service_date_clause}");
}

function rewriteLegacyTrackBody(body) {
  if (typeof body !== "string") return body;
  if (/\{track_clause\}/.test(body) || !/\{track_url\}/.test(body)) {
    return body;
  }
  return body.replace(/Track live: \{track_url\}\n\n/g, "{track_clause}");
}

exports.up = async function (knex) {
  // Create the table on environments where the lazy ensureTable in
  // server/routes/admin-sms-templates.js has never run (fresh DBs, preview
  // envs). Without this, removing the inline fallbacks in the same PR would
  // silently drop every customer SMS until someone visited the admin UI.
  if (!(await knex.schema.hasTable("sms_templates"))) {
    await knex.schema.createTable("sms_templates", (t) => {
      t.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
      t.string("template_key", 80).unique().notNullable();
      t.string("name", 200).notNullable();
      t.string("category", 30).notNullable();
      t.text("body").notNullable();
      t.text("description");
      t.jsonb("variables");
      t.boolean("is_active").defaultTo(true);
      t.boolean("is_internal").defaultTo(false);
      t.integer("sort_order").defaultTo(100);
      t.timestamps(true, true);
    });
  }

  // Insert any new templates that don't yet exist. REQUIRED_TEMPLATE_SEEDS
  // covers fresh/preview DBs where earlier seed migrations skipped because
  // sms_templates had not been created yet.
  for (const t of [...NEW_TEMPLATES, ...REQUIRED_TEMPLATE_SEEDS]) {
    const existing = await knex("sms_templates")
      .where({ template_key: t.template_key })
      .first();
    if (existing) continue;
    await knex("sms_templates").insert({
      template_key: t.template_key,
      name: t.name,
      category: t.category,
      body: t.body,
      variables: JSON.stringify(t.variables),
      sort_order: t.sort_order,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }

  // Rewrite only the legacy placeholder whose previous variable shape no
  // longer matches what the call sites pass. Without this, getTemplate()
  // returns null on unresolved {service_date} and every send is dropped.
  // Idempotent: skip rows already on the new shape and preserve edited copy.
  for (const r of BODY_REWRITES) {
    const row = await knex("sms_templates")
      .where({ template_key: r.template_key })
      .first();
    if (!row) continue;
    const rewrittenBody = rewriteLegacyServiceDateBody(row.body);
    if (rewrittenBody === row.body) continue;
    await knex("sms_templates")
      .where({ template_key: r.template_key })
      .update({
        body: rewrittenBody,
        variables: JSON.stringify(r.variables),
        updated_at: new Date(),
      });
  }

  // Switch the seeded tech_en_route link line to {track_clause} so legacy
  // callers without a tracking token render cleanly. Preserve custom copy:
  // only the old inline "Track live: {track_url}" phrase is rewritten.
  const techEnRoute = await knex("sms_templates")
    .where({ template_key: "tech_en_route" })
    .first();
  const rewrittenTrackBody = techEnRoute
    ? rewriteLegacyTrackBody(techEnRoute.body)
    : null;
  if (techEnRoute && rewrittenTrackBody !== techEnRoute.body) {
    await knex("sms_templates")
      .where({ template_key: "tech_en_route" })
      .update({
        body: rewrittenTrackBody,
        variables: JSON.stringify([
          "first_name",
          "tech_name",
          "eta_line",
          "track_clause",
        ]),
        updated_at: new Date(),
      });
  }

  // Append " (hardcoded)" to the name of every migrated template.
  // Idempotent: only updates rows whose name doesn't already end with the suffix.
  for (const key of HARDCODED_TEMPLATE_KEYS) {
    const row = await knex("sms_templates")
      .where({ template_key: key })
      .first();
    if (!row) continue;
    if (row.name && row.name.endsWith(SUFFIX)) continue;
    await knex("sms_templates")
      .where({ template_key: key })
      .update({ name: `${row.name}${SUFFIX}`, updated_at: new Date() });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable("sms_templates"))) return;
  // Strip the suffix on rollback. Leave inserted-new rows in place.
  for (const key of HARDCODED_TEMPLATE_KEYS) {
    const row = await knex("sms_templates")
      .where({ template_key: key })
      .first();
    if (!row || !row.name || !row.name.endsWith(SUFFIX)) continue;
    await knex("sms_templates")
      .where({ template_key: key })
      .update({
        name: row.name.slice(0, -SUFFIX.length),
        updated_at: new Date(),
      });
  }
};
