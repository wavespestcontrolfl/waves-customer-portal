/**
 * Seed the editable, Waves-branded ACH micro-deposit verification email. Paired
 * with the `bank_verification_incomplete` SMS, it is the email arm of the
 * micro-deposit dunning diversion (GATE_MICRODEPOSIT_DUNNING_DIVERSION): when an
 * invoice is blocked only on an unfinished bank verification, the dunning sweeps
 * send THIS instead of a generic "overdue" email.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const VARIABLES = [
  'first_name',
  'invoice_title',
  'amount_due',
  'billing_url',
];

const REQUIRED = [
  'first_name',
  'billing_url',
];

const OPTIONAL = VARIABLES.filter((key) => !REQUIRED.includes(key));

const TEMPLATES = [
  {
    key: 'payment.microdeposit_verification',
    name: 'Bank Verification Incomplete',
    description: 'Branded email re-nudge to finish ACH micro-deposit verification (pairs with the bank_verification_incomplete SMS).',
    subject: 'One more step to finish your payment',
    preview: 'Verify the two small deposits in your bank account.',
    cta: 'Check payment status',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}},' },
      { type: 'paragraph', content: 'Your payment for {{invoice_title}} is almost done — we just need you to verify your bank account before it can go through.' },
      { type: 'paragraph', content: 'Our payment processor, Stripe, sent two small deposits to your account. In 1–2 business days, look for them on your bank statement, then enter the two amounts using the verification link in the email Stripe sent you. As soon as you confirm them, your payment completes automatically — there is nothing more for you to pay.' },
      { type: 'details', rows: [{ label: 'Amount', value: '{{amount_due}}' }, { label: 'Service', value: '{{invoice_title}}' }] },
      { type: 'cta', label: 'Check payment status', url_variable: 'billing_url' },
      { type: 'small_note', content: 'Can’t find Stripe’s verification email, or have questions? Just reply to this message and we will help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
];

function fixture() {
  return {
    first_name: 'Taylor',
    invoice_title: 'Quarterly Pest Control',
    amount_due: '$129.00',
    billing_url: 'https://portal.wavespestcontrol.com/billing',
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
    message_priority: 'high',
    content_sensitivity: 'financial',
    send_stream: 'transactional_required',
    suppression_group_key: 'transactional_required',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: t.cta,
    default_cta_url_variable: 'billing_url',
    allowed_variables: JSON.stringify(VARIABLES),
    required_variables: JSON.stringify(REQUIRED),
    optional_variables: JSON.stringify(OPTIONAL),
    status: 'active',
    updated_at: new Date(),
  };
}

async function ensureTransactionalGroup(knex) {
  if (!(await knex.schema.hasTable('email_preference_groups'))) return;
  const row = {
    key: 'transactional_required',
    name: 'Required account notices',
    description: 'Security, payment, legal, and account notices that must reach the customer.',
    send_stream: 'transactional_required',
    user_can_unsubscribe: false,
    sort_order: 10,
    updated_at: new Date(),
  };
  const existing = await knex('email_preference_groups').where({ key: row.key }).first();
  if (existing) {
    await knex('email_preference_groups').where({ key: row.key }).update(row);
  } else {
    await knex('email_preference_groups').insert({ ...row, created_at: new Date() });
  }
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

  await ensureTransactionalGroup(knex);
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
