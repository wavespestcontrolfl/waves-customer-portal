'use strict';

/**
 * Plan-choice invite copy variants (owner-approved 2026-07-24, follow-on to
 * the secure-link plan choice #2980): when GATE_SECURE_PLAN_CHOICE is on
 * and the visit qualifies for the plan picker, the card-request funnel's
 * SMS + email legs send "pick how you'd like to pay" copy instead of the
 * plain "add a card on file" invite. Both messages stay truthful if the
 * page later falls back to card-only (no dollar amounts in the copy, and
 * the per-visit auto-charge claim is conditioned on choosing per visit —
 * the plan lane never offers itself to monthly-membership or annual-prepay
 * customers, so the Codex #2952 timing-line trap does not apply here).
 *
 * Dark posture — ONE copy lever, mirroring the base pair's two-switch launch:
 *   - SMS variant seeded INACTIVE — the sender falls back to the approved
 *     base secure_appointment_card copy until the owner reviews and
 *     activates the variant in /admin templates. The BASE template remains
 *     the lane's dark lever: an inactive base still blocks every send,
 *     variant active or not.
 *   - Email variant seeded active but only ever SELECTED when the plan-
 *     choice SMS copy ACTUALLY went out (probe fired AND the SMS variant
 *     was active) — the two legs of one invite can never contradict each
 *     other, and activating the SMS variant is the single copy lever. The
 *     whole email leg stays behind GATE_CARD_ENROLLMENT_EMAILS, and the
 *     probe requires GATE_SECURE_PLAN_CHOICE=true. Nothing sends from this
 *     migration alone.
 */

// GSM-7-safe (no em-dash/curly quotes — same 3-segment budget math as the
// base template: the UNSHORTENED /secure/<64-hex> link runs ~100 chars).
// No exact prices — card_request policy is allowExactPrice: false, and the
// page derives live pricing anyway.
const SMS_TEMPLATE = {
  template_key: 'secure_appointment_card_plans',
  name: 'Secure Appointment (plan choice link)',
  category: 'billing',
  body: "Hi {first_name}! To finish booking your {service_type} visit{date_line}, pick how you'd like to pay - prepay the year and save, or pay per visit with a card on file. Nothing is charged today unless you choose to prepay: {secure_link}\nWe never take card numbers by phone. Reply STOP to opt out.",
  variables: JSON.stringify(['first_name', 'service_type', 'date_line', 'secure_link']),
  is_active: false,
  sort_order: 33,
  updated_at: new Date(),
};

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const BILLING_EMAIL = 'billing@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const TEMPLATES = [
  {
    key: 'autopay.plan_choice_invitation',
    name: 'Plan Choice Invitation — Secure Card Link',
    category: 'billing',
    sensitivity: 'financial',
    // Invitation = operational outreach (same reasoning as
    // autopay.setup_invitation): respects the operational suppression
    // group, never the transactional_required stream.
    stream: 'service_operational',
    description: 'Plan-choice variant of the Auto Pay setup invitation: the /secure link opens the prepay vs. pay-per-visit picker (GATE_SECURE_PLAN_CHOICE). Selected by the sender only when the visit qualifies for the plan page; otherwise the base autopay.setup_invitation copy sends. Same GATE_CARD_ENROLLMENT_EMAILS lever and one-invite-per-visit idempotency as the base.',
    required: ['first_name', 'service_type', 'secure_link'],
    // charge_timing_line is allowed (the sender passes the same payload to
    // either template) but this copy does not use it: the plan lane only
    // offers itself to NULL/per-visit lanes, and the timing claim below is
    // conditioned on the customer choosing pay-per-visit.
    optional: ['date_line', 'charge_timing_line'],
    subject: 'Choose your plan for your Waves visits — see your pricing',
    preview: 'See your pricing and pick your plan — nothing charged today unless you prepay.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, here is your secure link to see your pricing and choose how you would like to pay for your {{service_type}} visit{{date_line}}.' },
      { type: 'heading', content: 'How it works' },
      { type: 'paragraph', content: 'Prepay the year and save, or pay per visit — a card on file means each completed service is charged automatically and you get a receipt every time. Nothing is charged today unless you choose to prepay. You can turn Auto Pay off or remove your card anytime in the Waves app or your customer portal.' },
      { type: 'cta', label: 'See my pricing & choose', url_variable: 'secure_link' },
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

// Same upsert mechanics as 20260721100010 (the seed migrations stay
// self-contained — copied, not imported).
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
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates')
      .insert({ ...SMS_TEMPLATE, created_at: new Date() })
      .onConflict('template_key')
      .merge(SMS_TEMPLATE);
  }

  const hasEmailTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (hasEmailTables) {
    for (const t of TEMPLATES) {
      await upsertTemplate(knex, t);
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: SMS_TEMPLATE.template_key }).del();
  }
  if (await knex.schema.hasTable('email_templates')) {
    // Archive rather than delete — send logs may reference the rows.
    await knex('email_templates')
      .whereIn('template_key', TEMPLATES.map((t) => t.key))
      .update({ status: 'archived', updated_at: new Date() });
  }
};

// Test-only (knex ignores extra exports): copy pins from one source of truth.
exports._SMS_TEMPLATE = SMS_TEMPLATE;
exports._TEMPLATES = TEMPLATES;
