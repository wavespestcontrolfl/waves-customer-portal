/**
 * Deepen customer-facing quote and estimate emails.
 *
 * Keeps existing template keys stable while publishing new active versions
 * with richer context, clearer next steps, and low-pressure follow-up copy.
 * Adds quote.request_received for website quote submissions.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const TEMPLATES = [
  {
    key: 'quote.request_received',
    name: 'Quote Request Received',
    description: 'Confirmation email after a website quote request or calculator submission.',
    purpose: 'estimate',
    audience: 'lead',
    mode: 'service',
    stream: 'service_operational',
    required: ['first_name', 'requested_services'],
    optional: ['property_address', 'price_summary', 'next_step_summary', 'booking_url', 'support_phone'],
    subject: 'We received your Waves quote request',
    preview: 'Your request is saved. Here is what happens next.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, thanks for reaching out to Waves. We received your quote request and saved the details for our team.' },
      {
        type: 'details',
        rows: [
          { label: 'Requested service', value: '{{requested_services}}' },
          { label: 'Property', value: '{{property_address}}' },
          { label: 'Estimate', value: '{{price_summary}}' },
        ],
      },
      { type: 'paragraph', content: 'Next step: {{next_step_summary}}' },
      { type: 'cta', label: 'Book service', url_variable: 'booking_url' },
      { type: 'small_note', content: 'Questions or changes? Reply to this email and we will help.' },
    ],
    fixture: {
      first_name: 'Taylor',
      requested_services: 'Pest Control + Lawn Care',
      property_address: '123 Palm Ave, Sarasota, FL 34236',
      price_summary: '$89/mo',
      next_step_summary: 'You can book online now, or reply here if anything needs to be adjusted first.',
      booking_url: 'https://portal.wavespestcontrol.com/book?service=pest_control&source=quote-wizard',
      support_phone: '(941) 555-0100',
    },
  },
  {
    key: 'estimate.delivery',
    required: ['first_name', 'estimate_url'],
    optional: ['price_summary', 'service_summary', 'property_address', 'next_step_summary'],
    subject: 'Your Waves estimate is ready',
    preview: 'Review your service estimate, what is included, and the next step.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your customized Waves estimate is ready for review.' },
      {
        type: 'details',
        rows: [
          { label: 'Service', value: '{{service_summary}}' },
          { label: 'Property', value: '{{property_address}}' },
          { label: 'Estimated price', value: '{{price_summary}}' },
        ],
      },
      { type: 'paragraph', content: 'Inside the estimate you can review the service breakdown, compare any available options, and choose the plan or visit that fits your home.' },
      { type: 'paragraph', content: '{{next_step_summary}}' },
      { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
      { type: 'small_note', content: 'Questions, timing concerns, or changes to the property details? Reply here and our team will help before you accept.' },
    ],
    fixture: {
      first_name: 'Taylor',
      estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      price_summary: '$89/mo',
      service_summary: 'Quarterly Pest Control',
      property_address: '123 Palm Ave, Sarasota, FL 34236',
      next_step_summary: 'When you are ready, open the estimate and accept it online. We will collect the final setup details after that.',
    },
  },
  {
    key: 'estimate.unviewed_followup',
    required: ['first_name', 'estimate_url'],
    optional: ['service_summary', 'property_address', 'price_summary'],
    subject: 'Your Waves estimate is ready to review',
    preview: 'A quick note in case the estimate link got buried.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, just making sure your Waves estimate made it to you.' },
      {
        type: 'details',
        rows: [
          { label: 'Service', value: '{{service_summary}}' },
          { label: 'Property', value: '{{property_address}}' },
          { label: 'Estimate', value: '{{price_summary}}' },
        ],
      },
      { type: 'paragraph', content: 'The link has the service details, pricing, and next steps in one place. If anything looks off or you want us to adjust the recommendation, reply here.' },
      { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
    ],
    fixture: {
      first_name: 'Taylor',
      estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      service_summary: 'Quarterly Pest Control',
      property_address: '123 Palm Ave, Sarasota, FL 34236',
      price_summary: '$89/mo',
    },
  },
  {
    key: 'estimate.viewed_followup',
    required: ['first_name', 'estimate_url'],
    optional: ['service_summary', 'property_address', 'price_summary'],
    subject: 'Questions about your Waves estimate?',
    preview: 'We can help with service details, timing, pricing, or scheduling.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, thanks for taking a look at your Waves estimate.' },
      {
        type: 'details',
        rows: [
          { label: 'Service', value: '{{service_summary}}' },
          { label: 'Property', value: '{{property_address}}' },
          { label: 'Estimate', value: '{{price_summary}}' },
        ],
      },
      { type: 'paragraph', content: 'If you are comparing options, the big things to check are what is included, how often we service the property, and whether the timing works for you.' },
      { type: 'paragraph', content: 'Reply here with any question about coverage, prep, pricing, or scheduling. We can also adjust the estimate if the property details changed.' },
      { type: 'cta', label: 'Review estimate', url_variable: 'estimate_url' },
    ],
    fixture: {
      first_name: 'Taylor',
      estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      service_summary: 'Quarterly Pest Control',
      property_address: '123 Palm Ave, Sarasota, FL 34236',
      price_summary: '$89/mo',
    },
  },
  {
    key: 'estimate.followup_final',
    required: ['first_name', 'estimate_url'],
    optional: ['service_summary', 'property_address', 'price_summary'],
    subject: 'Last check-in on your Waves estimate',
    preview: 'No pressure. Your estimate is still available if you want to revisit it.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, one last quick check-in on your Waves estimate.' },
      {
        type: 'details',
        rows: [
          { label: 'Service', value: '{{service_summary}}' },
          { label: 'Property', value: '{{property_address}}' },
          { label: 'Estimate', value: '{{price_summary}}' },
        ],
      },
      { type: 'paragraph', content: 'No pressure at all. If now is not the right time, that is OK.' },
      { type: 'paragraph', content: 'If you were waiting because of timing, price, service details, or a property-specific question, reply here. We can talk through it or adjust the estimate before you decide.' },
      { type: 'cta', label: 'Review estimate', url_variable: 'estimate_url' },
    ],
    fixture: {
      first_name: 'Taylor',
      estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      service_summary: 'Quarterly Pest Control',
      property_address: '123 Palm Ave, Sarasota, FL 34236',
      price_summary: '$89/mo',
    },
  },
  {
    key: 'estimate.expiring_notice',
    required: ['first_name', 'estimate_url', 'expires_at'],
    optional: ['service_summary', 'property_address', 'price_summary'],
    subject: 'Your Waves estimate expires {{expires_at}}',
    preview: 'Your estimate is still available for review until {{expires_at}}.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves estimate is available until {{expires_at}}.' },
      {
        type: 'details',
        rows: [
          { label: 'Service', value: '{{service_summary}}' },
          { label: 'Property', value: '{{property_address}}' },
          { label: 'Estimate', value: '{{price_summary}}' },
        ],
      },
      { type: 'paragraph', content: 'After that date, we may need to refresh the estimate before scheduling so pricing, availability, and property details are still accurate.' },
      { type: 'paragraph', content: 'If you need more time or want something adjusted, reply here and we will help.' },
      { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
    ],
    fixture: {
      first_name: 'Taylor',
      estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      expires_at: 'June 12',
      service_summary: 'Quarterly Pest Control',
      property_address: '123 Palm Ave, Sarasota, FL 34236',
      price_summary: '$89/mo',
    },
  },
  {
    key: 'estimate.extension_notice',
    required: ['first_name', 'estimate_url', 'new_expires_at'],
    optional: ['service_summary', 'property_address', 'price_summary'],
    subject: 'Your Waves estimate was extended',
    preview: 'We extended your estimate so the link stays available.',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your Waves estimate was set to expire, so we extended it through {{new_expires_at}}.' },
      {
        type: 'details',
        rows: [
          { label: 'Service', value: '{{service_summary}}' },
          { label: 'Property', value: '{{property_address}}' },
          { label: 'Estimate', value: '{{price_summary}}' },
        ],
      },
      { type: 'paragraph', content: 'Nothing else changed. The link below has the same service details and pricing we already sent.' },
      { type: 'paragraph', content: 'Reply here if anything about the property, timing, or service needs to be updated before you move forward.' },
      { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
    ],
    fixture: {
      first_name: 'Taylor',
      estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      new_expires_at: 'June 19',
      service_summary: 'Quarterly Pest Control',
      property_address: '123 Palm Ave, Sarasota, FL 34236',
      price_summary: '$89/mo',
    },
  },
];

function json(value) {
  return JSON.stringify(value || (Array.isArray(value) ? [] : {}));
}

function templateRow(t) {
  const allowed = [...(t.required || []), ...(t.optional || [])];
  return {
    template_key: t.key,
    name: t.name || t.key,
    description: t.description || null,
    mode: t.mode || 'service',
    purpose: t.purpose || 'estimate',
    legal_classification: t.legal || 'transactional_relationship',
    audience: t.audience || 'lead',
    message_priority: 'normal',
    content_sensitivity: 'normal',
    send_stream: t.stream || 'service_operational',
    suppression_group_key: t.stream || 'service_operational',
    layout_wrapper_id: 'service_default_v1',
    from_name: 'Waves Pest Control',
    from_email: SERVICE_FROM,
    reply_to: SERVICE_FROM,
    default_cta_label: t.ctaLabel || null,
    default_cta_url_variable: t.ctaUrlVariable || null,
    allowed_variables: json(allowed),
    required_variables: json(t.required || []),
    optional_variables: json(t.optional || []),
    status: 'active',
  };
}

async function publishTemplateVersion(knex, t) {
  let template = await knex('email_templates').where({ template_key: t.key }).first();
  const row = templateRow(t);

  if (!template) {
    [template] = await knex('email_templates').insert(row).returning('*');
  } else {
    await knex('email_templates').where({ id: template.id }).update({
      allowed_variables: row.allowed_variables,
      required_variables: row.required_variables,
      optional_variables: row.optional_variables,
      default_cta_label: t.ctaLabel === undefined ? template.default_cta_label : row.default_cta_label,
      default_cta_url_variable: t.ctaUrlVariable === undefined ? template.default_cta_url_variable : row.default_cta_url_variable,
      status: 'active',
      updated_at: new Date(),
    });
    template = await knex('email_templates').where({ id: template.id }).first();
  }

  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const versionNumber = (latest?.version_number || 0) + 1;

  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: versionNumber,
    status: 'active',
    subject: t.subject,
    preview_text: t.preview || null,
    blocks: json(t.blocks || []),
    text_body: null,
    validation_snapshot: json({
      ok: true,
      referenced_variables: [...(t.required || []), ...(t.optional || [])].sort(),
      disallowed_variables: [],
      missing_required_in_template: [],
    }),
    published_at: new Date(),
  }).returning('*');

  await knex('email_template_versions')
    .where({ template_id: template.id })
    .whereNot({ id: version.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: new Date() });

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    status: 'active',
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  const existingFixture = await knex('email_template_fixtures')
    .where({ template_id: template.id, is_default: true })
    .first();
  if (existingFixture) {
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
      payload: json(t.fixture || {}),
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload: json(t.fixture || {}),
      is_default: true,
    });
  }
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (!hasTables) return;

  for (const template of TEMPLATES) {
    await publishTemplateVersion(knex, template);
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('email_templates');
  if (!hasTable) return;
  await knex('email_templates').where({ template_key: 'quote.request_received' }).del();
};
