'use strict';

/**
 * Seed the BANK variant of the Auto Pay enrollment confirmation (portal
 * ACH Auto Pay lane, 2026-07-13). The card sender (#2698) deliberately
 * skips bank enrollments — card wording over an ACH debit authorization
 * would be wrong on both counts — and this template is the owner-approved
 * bank variant it deferred to.
 *
 *   autopay.enrollment_confirmation_ach — the customer's COPY of the ACH
 *     debit authorization they just granted. NACHA's copy-of-authorization
 *     promise is honored proactively: the locked ACH consent text rides
 *     verbatim as {{authorization_text}} and the email states it IS the
 *     customer's copy.
 *
 * Seeded ACTIVE for admin preview; the sender is gated OFF behind
 * GATE_CARD_ENROLLMENT_EMAILS (same gate as the card variant — one owner
 * switch for the whole authorization-copy behavior), and an ACH enrollment
 * can only exist once GATE_PORTAL_ACH_AUTOPAY ships the portal surface.
 * Copy standard: no witty copy; company = "Waves Pest Control"; billing@
 * appears only inside the authorization text.
 *
 * Same upsert mechanics as 20260713010010 (card-enrollment seed).
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const BILLING_EMAIL = 'billing@wavespestcontrol.com';
const REAL_PHONE = '(941) 297-5749';

const SHARED_VARIABLES = ['first_name', 'customer_portal_url', 'company_phone', 'company_email'];

const TEMPLATES = [
  {
    key: 'autopay.enrollment_confirmation_ach',
    name: 'Auto Pay Enrolled (Bank) — Your Authorization Copy',
    category: 'billing',
    // Member of the admin route's SENSITIVITIES enum (learned on #2698 r3:
    // an out-of-enum seed makes later admin saves fail validation).
    sensitivity: 'financial',
    stream: 'transactional_required',
    description: "Sent when a customer's bank account is enrolled in Auto Pay: confirms the enrollment and gives them a copy of the exact ACH debit authorization they agreed to (NACHA copy-of-authorization). Gated behind GATE_CARD_ENROLLMENT_EMAILS.",
    required: ['first_name', 'bank_line', 'debit_timing_line', 'authorization_text'],
    optional: [],
    subject: 'Auto Pay is set up on your Waves account',
    preview: 'Your bank account on file, and a copy of the authorization you approved.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, Auto Pay is now set up on your account using {{bank_line}}.' },
      { type: 'heading', content: 'How Auto Pay works' },
      // SENDER-COMPOSED by billing mode (same rule as the card variant's
      // charge_timing_line): monthly accounts are debited by the monthly
      // cron, not per completed service.
      { type: 'paragraph', content: '{{debit_timing_line}}' },
      { type: 'paragraph', content: 'Bank payments have no card surcharge. A bank debit can take a few business days to clear after it starts.' },
      { type: 'heading', content: 'Your authorization' },
      { type: 'paragraph', content: '{{authorization_text}}' },
      { type: 'paragraph', content: 'This email is your copy of that authorization — keep it for your records. You can turn Auto Pay off or remove your bank account anytime in the Waves app or your customer portal.' },
      { type: 'cta', label: 'Manage my payment methods', url_variable: 'customer_portal_url' },
      { type: 'signature', content: '— Waves Pest Control' },
    ],
    fixture: {
      first_name: 'Taylor',
      bank_line: 'your Chase Bank account ending 6789',
      debit_timing_line: "After each completed service, your bank account is debited that service's amount automatically, and you get a receipt every time.",
      authorization_text: 'By checking this box, I authorize Waves Pest Control, LLC to initiate electronic ACH debits from the bank account identified above for each invoice in the amount of that invoice, on or after its due date…',
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

// Test-only (knex ignores extra exports): lets the suite pin that every
// seeded field stays inside the admin route's validation enums.
exports._TEMPLATES = TEMPLATES;
