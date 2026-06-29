/**
 * Abandoned-booking recovery.
 *
 * A public /book self-booking is high intent — the visitor entered their
 * contact info and picked a slot. Some never tap "Confirm". Today that drop-off
 * is lost (and, since #2198, it's often a paid ad click we now ATTRIBUTE — so
 * losing it wastes tracked ad spend). This adds:
 *   - booking_intents: a partial capture written when the visitor reaches the
 *     contact step, marked converted when they actually book.
 *   - the recovery SMS template (touch 1, ~1h) + email template (touch 2, ~24h).
 *
 * The recovery cron (services/booking-abandon-recovery.js) chases un-converted
 * intents. Mirrors the estimate deposit-abandonment follow-up
 * (20260612000024) — per-stage claim flags, transactional consent, quiet hours.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SMS_TEMPLATE = {
  template_key: 'booking_abandonment_recovery',
  name: 'Booking Recovery — Almost Booked',
  category: 'appointments',
  body: "Hi {first_name}! You were almost booked with Waves for {service_type} — your spot isn't reserved yet. Pick a time and you're all set: {booking_url}\n\nReply here with any questions.",
  variables: JSON.stringify(['first_name', 'service_type', 'booking_url']),
  sort_order: 28,
};

const EMAIL_TEMPLATE = {
  key: 'booking.abandonment_recovery',
  name: 'Booking Recovery — Almost Booked',
  category: 'appointment',
  sensitivity: 'service',
  description: 'Second-touch email for a /book visitor who picked a slot but never confirmed.',
  required: ['first_name'],
  optional: ['service_type', 'booking_url'],
  subject: 'You were almost booked with Waves',
  preview: "Your spot isn't reserved yet — finish booking in a couple of taps.",
  blocks: [
    { type: 'paragraph', content: 'Hello {{first_name}},' },
    { type: 'paragraph', content: "You were almost booked with Waves for {{service_type}} — but your spot isn't reserved yet." },
    { type: 'paragraph', content: 'It only takes a couple of taps to pick a time that works and lock it in.' },
    { type: 'cta', label: 'Finish booking', url_variable: 'booking_url' },
    { type: 'small_note', content: 'Questions or need help finding a time? Just reply to this email and our team will help.' },
    { type: 'signature', content: 'Thank you, The Waves Team' },
  ],
};

const SHARED_VARIABLES = [
  'first_name', 'customer_name', 'customer_portal_url', 'company_phone', 'company_email',
];
const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  customer_name: 'Stan Example',
  customer_portal_url: 'https://portal.wavespestcontrol.com/book',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
  service_type: 'Quarterly Pest Control',
  booking_url: 'https://portal.wavespestcontrol.com/book?source=booking_recovery',
};

function emailTemplateRow(t) {
  const allowed = [...new Set([...SHARED_VARIABLES, ...(t.required || []), ...(t.optional || [])])];
  const required = [...new Set(t.required || [])];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description || null,
    mode: 'service',
    purpose: t.category,
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: t.sensitivity || 'service',
    // A re-engagement nudge — NOT a required transactional notice. Use the
    // service_operational stream/group so a SendGrid unsubscribe is honored
    // (transactional_required bypasses unsubscribe suppressions; see
    // email-template-library.activeSuppressionFor).
    send_stream: 'service_operational',
    suppression_group_key: 'service_operational',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: null,
    default_cta_url_variable: null,
    allowed_variables: JSON.stringify(allowed),
    required_variables: JSON.stringify(required),
    optional_variables: JSON.stringify(optional),
    status: 'active',
    updated_at: new Date(),
  };
}

async function upsertEmailTemplate(knex, t) {
  const existing = await knex('email_templates').where({ template_key: t.key }).first();
  const row = emailTemplateRow(t);
  let template = existing;
  if (template) {
    await knex('email_templates').where({ id: template.id }).update(row);
    template = await knex('email_templates').where({ id: template.id }).first();
  } else {
    [template] = await knex('email_templates').insert({ ...row, created_at: new Date() }).returning('*');
  }

  let version = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  if (version) {
    await knex('email_template_versions').where({ id: version.id }).update({
      status: 'active', subject: t.subject, preview_text: t.preview || null,
      blocks: JSON.stringify(t.blocks || []), text_body: null,
      published_at: new Date(), updated_at: new Date(),
    });
  } else {
    const latest = await knex('email_template_versions')
      .where({ template_id: template.id }).max('version_number as max').first();
    [version] = await knex('email_template_versions').insert({
      template_id: template.id, version_number: Number(latest?.max || 0) + 1,
      status: 'active', subject: t.subject, preview_text: t.preview || null,
      blocks: JSON.stringify(t.blocks || []), text_body: null,
      published_at: new Date(), created_at: new Date(), updated_at: new Date(),
    }).returning('*');
  }

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version?.id || template.active_version_id,
    last_published_at: new Date(), updated_at: new Date(),
  });

  const fixture = await knex('email_template_fixtures')
    .where({ template_id: template.id, is_default: true }).first();
  const payload = JSON.stringify(PREVIEW_PAYLOAD);
  if (fixture) {
    await knex('email_template_fixtures').where({ id: fixture.id })
      .update({ name: 'Happy path', payload, updated_at: new Date() });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: template.id, name: 'Happy path', payload, is_default: true,
      created_at: new Date(), updated_at: new Date(),
    });
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('booking_intents'))) {
    await knex.schema.createTable('booking_intents', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('session_id');                    // stable per /book session — upsert key, so a corrected phone updates the SAME row (no orphaned mistyped-number intent)
      t.string('phone').notNullable();           // recovery key (as entered)
      t.string('first_name');
      t.string('last_name');
      t.string('email');
      t.string('address_line1');
      t.string('city');
      t.string('state');
      t.string('zip');
      t.decimal('lat', 10, 7);
      t.decimal('lng', 10, 7);
      t.string('service_type');
      t.string('slot_date');                     // YYYY-MM-DD (best-effort; may be taken by send time)
      t.string('slot_start');                    // HH:MM
      t.string('slot_end');
      t.string('source');
      t.jsonb('attribution');                    // first-touch attribution from the funnel
      t.uuid('customer_id');                     // set if the funnel matched an existing customer
      t.timestamp('captured_at').defaultTo(knex.fn.now());
      t.timestamp('last_activity_at').defaultTo(knex.fn.now());
      t.boolean('followup_sms_sent').defaultTo(false);   // stage-1 claim flag
      t.timestamp('followup_sms_sent_at');               // when the SMS actually went out — gates the email to ~23h later even if the SMS fired late
      t.boolean('followup_email_sent').defaultTo(false); // stage-2 claim flag
      t.timestamp('converted_at');               // set when this person actually books
      t.uuid('converted_booking_id');
      t.boolean('suppressed').defaultTo(false);  // manual / opt-out kill
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('updated_at').defaultTo(knex.fn.now());
      t.index(['phone']);
      t.index(['session_id']);
      // The recovery scan: open, un-suppressed intents in a recency window.
      t.index(['converted_at', 'suppressed', 'captured_at']);
    });
  }

  // SMS template (touch 1)
  if (await knex.schema.hasTable('sms_templates')) {
    const existing = await knex('sms_templates').where({ template_key: SMS_TEMPLATE.template_key }).first();
    const row = { ...SMS_TEMPLATE, updated_at: new Date() };
    if (existing) {
      await knex('sms_templates').where({ template_key: SMS_TEMPLATE.template_key }).update(row);
    } else {
      await knex('sms_templates').insert({ ...row, created_at: new Date() });
    }
  }

  // Email template (touch 2)
  const hasEmailTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (hasEmailTables) {
    await upsertEmailTemplate(knex, EMAIL_TEMPLATE);
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('booking_intents');
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: SMS_TEMPLATE.template_key }).del();
  }
  if (await knex.schema.hasTable('email_templates')) {
    await knex('email_templates').where({ template_key: EMAIL_TEMPLATE.key }).del();
  }
};
