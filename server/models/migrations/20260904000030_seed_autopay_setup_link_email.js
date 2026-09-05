/**
 * Seed the editable, Waves-branded "set up Auto Pay" link email — the email
 * arm of the standalone Auto Pay setup link (GATE_AUTOPAY_SETUP_LINK,
 * server/services/autopay-setup-link.js). Pairs with the autopay_setup_link
 * SMS template: the Customers page offers copy / text / email of the same
 * 30-day /secure/:token link, and the email delivery renders THIS template
 * through the email template library (audited email_messages row,
 * suppressions, provider retry).
 *
 * Copy mirrors the lane- and tender-neutral SMS body (each completed service
 * is paid automatically; "payment method", since the page is card-only
 * unless GATE_ACCEPT_ACH_CAPTURE is on AND the customer's ACH state is
 * healthy; nothing is charged today; card numbers are never taken by phone).
 *
 * Classified service_operational, like autopay.setup_invitation: an
 * invitation is operational outreach, not a required transactional record,
 * so it honors the operational unsubscribe. Same upsert shape as the other
 * seeded service templates.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const VARIABLES = [
  'first_name',
  'secure_link',
  'expires_on',
];

const REQUIRED = [
  'first_name',
  'secure_link',
];

const OPTIONAL = VARIABLES.filter((key) => !REQUIRED.includes(key));

const TEMPLATES = [
  {
    key: 'payment.autopay_setup_link',
    name: 'Auto Pay Setup Link',
    description: 'Branded email carrying the customer\'s secure Auto Pay setup link (pairs with the autopay_setup_link SMS).',
    subject: 'Set up Auto Pay for your Waves service',
    preview: 'Save a payment method once and each completed service is paid automatically.',
    cta: 'Set up Auto Pay',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}},' },
      { type: 'paragraph', content: 'Here is your secure link to set up Auto Pay for your Waves service. Save a payment method once and each completed service is paid automatically — no invoices to chase and nothing to remember.' },
      { type: 'paragraph', content: 'Nothing is charged today. Your payment details go straight to our payment processor, Stripe — we never take card numbers by phone or email.' },
      { type: 'details', rows: [{ label: 'Link expires', value: '{{expires_on}}' }] },
      { type: 'cta', label: 'Set up Auto Pay', url_variable: 'secure_link' },
      { type: 'small_note', content: 'This link is personal to your account. If you did not expect it or have questions, just reply to this message and we will help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
];

function fixture() {
  return {
    first_name: 'Taylor',
    secure_link: 'https://portal.wavespestcontrol.com/secure/example-token',
    expires_on: 'October 4, 2026',
  };
}

function templateRow(t) {
  return {
    template_key: t.key,
    name: t.name,
    description: t.description,
    mode: 'service',
    purpose: 'billing',
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: 'financial',
    send_stream: 'service_operational',
    suppression_group_key: 'service_operational',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: t.cta,
    default_cta_url_variable: 'secure_link',
    allowed_variables: JSON.stringify(VARIABLES),
    required_variables: JSON.stringify(REQUIRED),
    optional_variables: JSON.stringify(OPTIONAL),
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
    [template] = await knex('email_templates').insert({
      ...row,
      created_at: new Date(),
    }).returning('*');
  }

  let version = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  if (version) {
    await knex('email_template_versions').where({ id: version.id }).update({
      status: 'active',
      subject: t.subject,
      preview_text: t.preview,
      blocks: JSON.stringify(t.blocks),
      text_body: null,
      published_at: new Date(),
      updated_at: new Date(),
    });
  } else {
    const latest = await knex('email_template_versions')
      .where({ template_id: template.id })
      .max('version_number as max')
      .first();
    const nextVersion = Number(latest?.max || 0) + 1;
    [version] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: nextVersion,
      status: 'active',
      subject: t.subject,
      preview_text: t.preview,
      blocks: JSON.stringify(t.blocks),
      text_body: null,
      published_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
  }

  const activeVersionId = version?.id || template.active_version_id;
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: activeVersionId,
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  const existingFixture = await knex('email_template_fixtures')
    .where({ template_id: template.id, is_default: true })
    .first();
  const payload = fixture();
  if (existingFixture) {
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
      name: 'Happy path',
      payload: JSON.stringify(payload),
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload: JSON.stringify(payload),
      is_default: true,
      created_at: new Date(),
      updated_at: new Date(),
    });
  }
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (!hasTables) return;

  for (const t of TEMPLATES) {
    await upsertTemplate(knex, t);
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await knex('email_templates')
    .whereIn('template_key', TEMPLATES.map((t) => t.key))
    .del();
};

exports.__private = {
  TEMPLATES,
  VARIABLES,
  REQUIRED,
  OPTIONAL,
  templateRow,
};
