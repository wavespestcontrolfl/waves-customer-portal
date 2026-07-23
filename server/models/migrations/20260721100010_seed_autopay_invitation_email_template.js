'use strict';

/**
 * Seed the Auto Pay setup INVITATION email template (owner directive
 * 2026-07-21, follow-on to the office card-link lane #2921):
 *
 *   autopay.setup_invitation — the email leg of the secure-card funnel.
 *     Carries the same /secure/:token link the SMS leg sends: the customer
 *     saves a card (nothing charged today), Auto Pay enrolls on save. Copy
 *     mirrors the approved secure_appointment_card SMS wording ("Nothing is
 *     charged today — your card is only charged after a completed service",
 *     "We never take card numbers by phone").
 *
 * Sender: requestCardForAppointment's email leg (owner delivery rule
 * 2026-07-23: an invite goes out on BOTH channels), fired only after a
 * confirmed-dispatched SMS and gated by GATE_CARD_ENROLLMENT_EMAILS —
 * the email leg rides the same one-invite
 * guard rails as requestCardForAppointment. Nothing can send to a customer
 * from this migration alone.
 *
 * Copy standard (2026-07-13 enrollment-email seed): no witty copy;
 * "completed service"; billing questions route to
 * billing@wavespestcontrol.com. Same upsert mechanics as 20260713010010.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const BILLING_EMAIL = 'billing@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const TEMPLATES = [
  {
    key: 'autopay.setup_invitation',
    name: 'Auto Pay Setup Invitation — Secure Card Link',
    category: 'billing',
    sensitivity: 'financial',
    // An invitation is operational outreach, not a required transactional
    // record — it must respect the operational suppression group, unlike
    // the enrollment-confirmation authorization copy.
    stream: 'service_operational',
    description: 'Invites a customer to add a card on file via their unique /secure link: nothing charged today, Auto Pay enrolls on save. Email leg of the appointment card-request funnel — sent alongside the SMS leg (secure_appointment_card) after the text is confirmed dispatched; gated by GATE_CARD_ENROLLMENT_EMAILS.',
    // charge_timing_line is sender-composed from the customer's ACTUAL
    // billing mode (chargeTimingLine — Codex #2952: a monthly-membership
    // customer is charged monthly dues on their billing day, so a
    // hard-coded "only charged after a completed service" would misstate
    // when they're charged).
    required: ['first_name', 'service_type', 'secure_link', 'charge_timing_line'],
    // date_line is clause-style like the SMS template: " on Tue, Jul 21"
    // or '' — the sender always passes it, possibly empty.
    optional: ['date_line'],
    subject: 'Set up Auto Pay for your Waves visits — nothing charged today',
    preview: 'Add your card securely — nothing is charged today.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, here is your secure link to add a card on file for your {{service_type}} visit{{date_line}}. Nothing is charged today.' },
      { type: 'heading', content: 'How it works' },
      { type: 'paragraph', content: 'Add your card once and Auto Pay takes care of the rest. {{charge_timing_line}} You can turn Auto Pay off or remove your card anytime in the Waves app or your customer portal.' },
      { type: 'cta', label: 'Add my card securely', url_variable: 'secure_link' },
      { type: 'paragraph', content: 'We never take card numbers by phone. This link is unique to your account — please do not forward it.' },
      { type: 'signature', content: '— The Waves Team' },
    ],
    fixture: {
      first_name: 'Taylor',
      service_type: 'Quarterly Pest Control',
      date_line: ' on Sat, Jul 25',
      charge_timing_line: "After each completed service, your card is charged that service's amount automatically, and you get a receipt every time.",
      secure_link: 'https://portal.wavespestcontrol.com/secure/EXAMPLE',
      customer_portal_url: 'https://portal.wavespestcontrol.com/login',
      company_email: BILLING_EMAIL,
    },
  },
];

function templateRow(t) {
  const allowed = [...new Set([...SHARED_VARIABLES, ...(t.required || []), ...(t.optional || [])])];
  const required = [...new Set(t.required || [])];
  const optional = allowed.filter((key) => !required.includes(key));
  return {
    template_key: t.key,
    name: t.name,
    description: t.description || null,
    mode: t.mode || 'service',
    purpose: t.category,
    legal_classification: t.legal || 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: t.sensitivity || 'account',
    send_stream: t.stream || 'service_operational',
    suppression_group_key: t.stream || 'service_operational',
    layout_wrapper_id: t.layout || 'service_default_v1',
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

async function upsertTemplate(knex, t) {
  const existing = await knex('email_templates').where({ template_key: t.key }).first();
  let template = existing;
  const row = templateRow(t);

  if (template) {
    await knex('email_templates').where({ id: template.id }).update(row);
    template = await knex('email_templates').where({ id: template.id }).first();
  } else {
    [template] = await knex('email_templates').insert({ ...row, created_at: new Date() }).returning('*');
  }

  let version = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  const versionFields = {
    status: 'active',
    subject: t.subject,
    preview_text: t.preview || null,
    blocks: JSON.stringify(t.blocks || []),
    text_body: null,
    published_at: new Date(),
    updated_at: new Date(),
  };
  if (version) {
    await knex('email_template_versions').where({ id: version.id }).update(versionFields);
  } else {
    const latest = await knex('email_template_versions')
      .where({ template_id: template.id })
      .max('version_number as max')
      .first();
    const nextVersion = Number(latest?.max || 0) + 1;
    [version] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: nextVersion,
      created_at: new Date(),
      ...versionFields,
    }).returning('*');
  }

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version?.id || template.active_version_id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  if (await knex.schema.hasTable('email_template_fixtures')) {
    const payload = { company_phone: REAL_PHONE, company_email: BILLING_EMAIL, ...(t.fixture || {}) };
    const fixture = await knex('email_template_fixtures')
      .where({ template_id: template.id, is_default: true })
      .first();
    if (fixture) {
      await knex('email_template_fixtures').where({ id: fixture.id }).update({
        payload: JSON.stringify(payload),
        updated_at: new Date(),
      });
    } else {
      await knex('email_template_fixtures').insert({
        template_id: template.id,
        name: 'Default preview',
        is_default: true,
        payload: JSON.stringify(payload),
        created_at: new Date(),
        updated_at: new Date(),
      });
    }
  }
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;
  for (const t of TEMPLATES) {
    await upsertTemplate(knex, t);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  // Archive rather than delete — send logs may reference the rows.
  await knex('email_templates')
    .whereIn('template_key', TEMPLATES.map((t) => t.key))
    .update({ status: 'archived', updated_at: new Date() });
};

// Test-only (knex ignores extra exports): lets the suite + the owner
// preview script pin the seeded copy from one source of truth.
exports._TEMPLATES = TEMPLATES;
