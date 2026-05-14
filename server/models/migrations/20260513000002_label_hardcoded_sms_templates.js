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
  'self_booking_confirmation',
  'reschedule_options_weather',
  'reschedule_options_access',
  'reschedule_options_general',
  'reschedule_confirmed_sms_reply',
  'reschedule_call_requested',
  'tech_en_route',
  'tech_arrived',
  'service_complete',

  // billing
  'invoice_sent',
  'invoice_receipt',
  'invoice_followup_3day',
  'invoice_followup_7day',
  'invoice_followup_14day',
  'invoice_followup_30day',
  'late_payment_7d',
  'late_payment_14d',
  'late_payment_30d',
  'late_payment_60d',
  'late_payment_90d',
  'billing_reminder',

  // estimates
  'estimate_followup_unviewed',
  'estimate_followup_viewed',
  'estimate_followup_final',
  'estimate_followup_expiring',

  // reviews / referrals / retention
  'review_request',
  'referral_nudge',
  'renewal_reminder',
  'seasonal_reactivation',

  // operational / dead-code paths kept for completeness
  'service_reminder_legacy',
  'seasonal_alert',
  'onboarding_welcome',
];

const SUFFIX = ' (hardcoded)';

const NEW_TEMPLATES = [
  {
    template_key: 'onboarding_welcome',
    name: 'Onboarding Welcome',
    category: 'service',
    body: 'Welcome to Waves, {first_name}! Your first {service_type} is {service_date}{tech_clause}. Log into your portal anytime: portal.wavespestcontrol.com',
    variables: ['first_name', 'service_type', 'service_date', 'tech_clause'],
    sort_order: 0,
  },
  {
    template_key: 'tech_arrived',
    name: 'Tech Arrived',
    category: 'service',
    body: 'Hello {first_name}! {tech_name} has arrived and is servicing your property.\n\nQuestions or requests? Reply to this message. Reply STOP to opt out.',
    variables: ['first_name', 'tech_name'],
    sort_order: 4,
  },
  {
    template_key: 'billing_reminder',
    name: 'Billing Reminder (WaveGuard Monthly)',
    category: 'billing',
    body: 'Hi {first_name}, your {waveguard_tier} WaveGuard monthly charge of ${amount} will be processed on {charge_date}.\n\nManage your payment method in your customer portal or call (941) 318-7612.',
    variables: ['first_name', 'waveguard_tier', 'amount', 'charge_date'],
    sort_order: 18,
  },
  {
    template_key: 'service_reminder_legacy',
    name: 'Service Reminder (Legacy 24h)',
    category: 'service',
    body: 'Hi {first_name}! Your {service_type} is scheduled for tomorrow {time_window}.\n\nTechnician: {tech_name}\n\nPlease ensure gates are unlocked and pets are secured. Reply CONFIRM to confirm or call (941) 318-7612 to reschedule.',
    variables: ['first_name', 'service_type', 'time_window', 'tech_name'],
    sort_order: 6,
  },
  {
    template_key: 'seasonal_alert',
    name: 'Seasonal Alert / Tip',
    category: 'retention',
    body: 'Hi {first_name}! {tip}\n\nQuestions? Reply to this text or call (941) 318-7612.',
    variables: ['first_name', 'tip'],
    sort_order: 50,
  },
  {
    template_key: 'seasonal_reactivation',
    name: 'Seasonal Reactivation',
    category: 'retention',
    body: "Hi {first_name}! {hook_text}. We'd love to get you back on the schedule{address_clause}. Reply YES or call {call_number} to book. - Waves Pest Control",
    variables: ['first_name', 'hook_text', 'address_clause', 'call_number'],
    sort_order: 51,
  },
  // Re-seed invoice_followup_{7,14,30}day — deleted by migration
  // 20260415000007 and never restored. The follow-up engine references
  // these keys, and the inline fallback is gone in this PR.
  {
    template_key: 'invoice_followup_7day',
    name: 'Invoice Follow-Up — 7 Day',
    category: 'billing',
    body: 'Hi {first_name}, just a friendly reminder from Waves — your invoice for {invoice_title}{service_date_clause} is still open. You can pay here: {pay_url}\n\nQuestions? Reply to this message. — Waves',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
    sort_order: 20,
  },
  {
    template_key: 'invoice_followup_14day',
    name: 'Invoice Follow-Up — 14 Day',
    category: 'billing',
    body: "Hi {first_name}, checking in on your Waves invoice for {invoice_title}{service_date_clause} — we'd appreciate payment at your earliest convenience: {pay_url}\n\nReply if you need anything. — Waves",
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
    sort_order: 21,
  },
  {
    template_key: 'invoice_followup_30day',
    name: 'Invoice Follow-Up — 30 Day',
    category: 'billing',
    body: 'Hi {first_name}, this is a final notice on your Waves invoice for {invoice_title}{service_date_clause}. Please pay now to keep the account in good standing: {pay_url}\n\nReply to discuss a payment plan. — Waves',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
    sort_order: 22,
  },
];

// Bring late_payment_* and invoice_followup_3day bodies onto the
// {service_date_clause} variable shape that the new call sites pass.
// Existing rows seeded by 20260415000011 use {service_date}, which would
// now leave an unresolved placeholder and silently null out every reminder.
const BODY_REWRITES = [
  {
    template_key: 'late_payment_7d',
    body: 'Hello {first_name}! This is a reminder from Waves. Your invoice for {invoice_title}{service_date_clause} is now 7 days overdue.\n\nPlease make your payment here: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
  },
  {
    template_key: 'late_payment_14d',
    body: 'Hello {first_name}, this is a reminder from Waves. Your invoice for {invoice_title}{service_date_clause} is now 14 days overdue.\n\nPlease make your payment as soon as possible at: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
  },
  {
    template_key: 'late_payment_30d',
    body: 'Hello {first_name}, this is a final reminder from Waves. Your invoice for {invoice_title}{service_date_clause} is now 30 days overdue.\n\nPlease make your payment immediately at: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
  },
  {
    template_key: 'late_payment_60d',
    body: 'Hello {first_name}, this is an urgent notice from Waves. Your invoice for {invoice_title}{service_date_clause} is now 60 days overdue.\n\nPlease make payment or contact us immediately to avoid further action: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
  },
  {
    template_key: 'late_payment_90d',
    body: 'Hello {first_name}, your invoice from Waves for {invoice_title}{service_date_clause} is now 90 days overdue.\n\nFinal notice: This account will be sent to collections if payment is not received today. Please pay now: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!',
    variables: ['first_name', 'invoice_title', 'service_date_clause', 'pay_url'],
  },
  {
    template_key: 'invoice_followup_3day',
    body: "Hi {first_name}, still showing an open balance on your invoice for {invoice_title} — \${amount}. Secure pay link: {pay_url}\n\nIf something's off, just reply and we'll sort it. — Waves",
    variables: ['first_name', 'invoice_title', 'amount', 'pay_url'],
  },
];

exports.up = async function (knex) {
  // Create the table on environments where the lazy ensureTable in
  // server/routes/admin-sms-templates.js has never run (fresh DBs, preview
  // envs). Without this, removing the inline fallbacks in the same PR would
  // silently drop every customer SMS until someone visited the admin UI.
  if (!(await knex.schema.hasTable('sms_templates'))) {
    await knex.schema.createTable('sms_templates', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('template_key', 80).unique().notNullable();
      t.string('name', 200).notNullable();
      t.string('category', 30).notNullable();
      t.text('body').notNullable();
      t.text('description');
      t.jsonb('variables');
      t.boolean('is_active').defaultTo(true);
      t.boolean('is_internal').defaultTo(false);
      t.integer('sort_order').defaultTo(100);
      t.timestamps(true, true);
    });
  }

  // Insert any new templates that don't yet exist.
  for (const t of NEW_TEMPLATES) {
    const existing = await knex('sms_templates').where({ template_key: t.template_key }).first();
    if (existing) continue;
    await knex('sms_templates').insert({
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

  // Rewrite bodies of templates whose previous variable shape no longer
  // matches what the call sites pass. Without this, getTemplate() returns
  // null on the unresolved {service_date} placeholder and every send is
  // silently dropped. Idempotent: skip rows already on the new shape.
  for (const r of BODY_REWRITES) {
    const row = await knex('sms_templates').where({ template_key: r.template_key }).first();
    if (!row) continue;
    if (row.body === r.body) continue;
    await knex('sms_templates')
      .where({ template_key: r.template_key })
      .update({ body: r.body, variables: JSON.stringify(r.variables), updated_at: new Date() });
  }

  // Switch tech_en_route to {track_clause} so legacy callers without a
  // tracking token render cleanly (no orphan "Track live: " line).
  // Idempotent: skips if the body is already on the new shape.
  const techEnRoute = await knex('sms_templates').where({ template_key: 'tech_en_route' }).first();
  if (techEnRoute && !/\{track_clause\}/.test(techEnRoute.body)) {
    await knex('sms_templates')
      .where({ template_key: 'tech_en_route' })
      .update({
        body: 'Hello {first_name}! {tech_name} is on the way.\n\n{eta_line}{track_clause}Questions or requests? Reply to this message. Reply STOP to opt out.',
        variables: JSON.stringify(['first_name', 'tech_name', 'eta_line', 'track_clause']),
        updated_at: new Date(),
      });
  }

  // Append " (hardcoded)" to the name of every migrated template.
  // Idempotent: only updates rows whose name doesn't already end with the suffix.
  for (const key of HARDCODED_TEMPLATE_KEYS) {
    const row = await knex('sms_templates').where({ template_key: key }).first();
    if (!row) continue;
    if (row.name && row.name.endsWith(SUFFIX)) continue;
    await knex('sms_templates')
      .where({ template_key: key })
      .update({ name: `${row.name}${SUFFIX}`, updated_at: new Date() });
  }
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  // Strip the suffix on rollback. Leave inserted-new rows in place.
  for (const key of HARDCODED_TEMPLATE_KEYS) {
    const row = await knex('sms_templates').where({ template_key: key }).first();
    if (!row || !row.name || !row.name.endsWith(SUFFIX)) continue;
    await knex('sms_templates')
      .where({ template_key: key })
      .update({
        name: row.name.slice(0, -SUFFIX.length),
        updated_at: new Date(),
      });
  }
};
