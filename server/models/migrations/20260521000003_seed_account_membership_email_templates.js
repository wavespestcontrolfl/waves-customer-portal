/**
 * Seed editable account, portal request, and membership lifecycle templates.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_VARIABLES = [
  'first_name',
  'customer_name',
  'customer_portal_url',
  'company_phone',
  'company_email',
];

const PREVIEW_PAYLOAD = {
  first_name: 'Stan',
  customer_name: 'Stan Example',
  customer_portal_url: 'https://portal.wavespestcontrol.com/login',
  manage_preferences_url: 'https://portal.wavespestcontrol.com/?tab=visits',
  portal_requests_url: 'https://portal.wavespestcontrol.com/login',
  company_phone: '(941) 555-0000',
  company_email: SERVICE_FROM,
  account_section: 'Reminder settings',
  change_summary: 'Your 72-Hour Appointment Reminder was turned off.',
  changed_items_summary: '72-Hour Appointment Reminder: On to Off',
  changed_at: 'May 20, 2026',
  property_label: 'Primary property',
  request_id: 'REQ-1001',
  request_type: 'Schedule Change',
  request_subject: 'Move upcoming quarterly service',
  request_summary: 'Please move next week\'s visit to Friday morning if possible.',
  request_status: 'New',
  submitted_at: 'May 20, 2026',
  updated_at: 'May 21, 2026',
  response_time: '24 hours',
  membership_name: 'WaveGuard Gold',
  membership_tier: 'Gold',
  membership_status: 'Active',
  membership_change_summary: 'Tier: Silver to Gold; Monthly rate: $129.00 to $159.00',
  old_membership_tier: 'Silver',
  new_membership_tier: 'Gold',
  old_monthly_rate: '$129.00',
  new_monthly_rate: '$159.00',
  monthly_rate: '$159.00',
  billing_cadence: 'monthly',
  included_services: 'Quarterly pest control, lawn care, mosquito control',
  effective_date: 'May 20, 2026',
  renewal_date: 'June 20, 2026',
  renewal_days_out: '30',
  renewal_notice_window: '30 days',
  last_service_date: 'June 13, 2026',
  paused_until: 'July 20, 2026',
  pause_reason: 'Customer requested seasonal pause',
  cancellation_effective_date: 'May 31, 2026',
  reactivated_at: 'May 20, 2026',
};

const TEMPLATES = [
  {
    key: 'account.updated',
    name: 'Account Info Updated',
    category: 'account',
    sensitivity: 'account',
    description: 'Confirmation sent when a customer updates portal settings or communication preferences.',
    required: ['first_name', 'change_summary'],
    optional: [
      'account_section',
      'changed_items_summary',
      'changed_at',
      'property_label',
      'manage_preferences_url',
    ],
    subject: 'Your Waves account settings were updated',
    preview: 'A Waves account setting was updated.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'We are confirming that a Waves account setting was updated.' },
      { type: 'details', rows: [
        { label: 'Section', value: '{{account_section}}' },
        { label: 'What changed', value: '{{changed_items_summary}}' },
        { label: 'Property', value: '{{property_label}}' },
        { label: 'Updated', value: '{{changed_at}}' },
      ] },
      { type: 'paragraph', content: '{{change_summary}}' },
      { type: 'paragraph', content: 'If you made this change, no action is needed.' },
      { type: 'small_note', content: 'If you did not make this change, reply to this email or contact Waves right away.' },
      { type: 'cta', label: 'Manage account', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'account.request_received',
    name: 'Portal Request Received',
    category: 'account',
    sensitivity: 'account',
    description: 'Confirmation sent when a customer submits a request from the portal.',
    required: ['first_name', 'request_subject'],
    optional: [
      'request_id',
      'request_type',
      'request_summary',
      'request_status',
      'submitted_at',
      'response_time',
      'portal_requests_url',
    ],
    subject: 'We received your Waves request',
    preview: 'Your request has been sent to the Waves team.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'We received your request and sent it to the Waves team for review.' },
      { type: 'details', rows: [
        { label: 'Request', value: '{{request_subject}}' },
        { label: 'Type', value: '{{request_type}}' },
        { label: 'Status', value: '{{request_status}}' },
        { label: 'Submitted', value: '{{submitted_at}}' },
        { label: 'Expected response', value: '{{response_time}}' },
      ] },
      { type: 'paragraph', content: '{{request_summary}}' },
      { type: 'paragraph', content: 'If you need to add details, reply to this email or contact Waves.' },
      { type: 'cta', label: 'Open customer portal', url_variable: 'portal_requests_url' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'account.request_updated',
    name: 'Portal Request Updated',
    category: 'account',
    sensitivity: 'account',
    description: 'Notice sent when a customer request is reviewed, scheduled, or resolved.',
    required: ['first_name', 'request_subject', 'request_status'],
    optional: [
      'request_id',
      'request_type',
      'request_summary',
      'updated_at',
      'portal_requests_url',
    ],
    subject: 'Your Waves request was updated',
    preview: 'There is an update on your Waves request.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'There is an update on your Waves request.' },
      { type: 'details', rows: [
        { label: 'Request', value: '{{request_subject}}' },
        { label: 'Type', value: '{{request_type}}' },
        { label: 'Status', value: '{{request_status}}' },
        { label: 'Updated', value: '{{updated_at}}' },
      ] },
      { type: 'paragraph', content: '{{request_summary}}' },
      { type: 'cta', label: 'Open customer portal', url_variable: 'portal_requests_url' },
      { type: 'small_note', content: 'Questions or need help? Reply to this email and our team will be happy to help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'membership.started',
    name: 'Membership Started',
    category: 'membership',
    sensitivity: 'account',
    description: 'Confirmation sent when a WaveGuard membership starts.',
    required: ['first_name'],
    optional: [
      'membership_name',
      'membership_tier',
      'membership_status',
      'effective_date',
      'monthly_rate',
      'billing_cadence',
      'included_services',
    ],
    subject: 'Your Waves membership is active',
    preview: 'Your WaveGuard membership is now active.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves membership is now active.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{membership_name}}' },
        { label: 'Status', value: '{{membership_status}}' },
        { label: 'Effective date', value: '{{effective_date}}' },
        { label: 'Rate', value: '{{monthly_rate}}' },
        { label: 'Billing cadence', value: '{{billing_cadence}}' },
        { label: 'Included services', value: '{{included_services}}' },
      ] },
      { type: 'paragraph', content: 'You can review your services, visits, invoices, and account settings in your customer portal.' },
      { type: 'cta', label: 'View membership', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'membership.updated',
    name: 'Membership Updated',
    category: 'membership',
    sensitivity: 'account',
    description: 'Confirmation sent when a WaveGuard plan, rate, or included service changes.',
    required: ['first_name'],
    optional: [
      'membership_name',
      'membership_status',
      'membership_change_summary',
      'old_membership_tier',
      'new_membership_tier',
      'old_monthly_rate',
      'new_monthly_rate',
      'effective_date',
      'included_services',
    ],
    subject: 'Your Waves membership was updated',
    preview: 'Your WaveGuard membership details were updated.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves membership details were updated.' },
      { type: 'details', rows: [
        { label: 'Summary', value: '{{membership_change_summary}}' },
        { label: 'Previous tier', value: '{{old_membership_tier}}' },
        { label: 'New tier', value: '{{new_membership_tier}}' },
        { label: 'Previous rate', value: '{{old_monthly_rate}}' },
        { label: 'New rate', value: '{{new_monthly_rate}}' },
        { label: 'Effective date', value: '{{effective_date}}' },
        { label: 'Included services', value: '{{included_services}}' },
      ] },
      { type: 'cta', label: 'View membership', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'If you have questions about this update, reply to this email and our team will help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'membership.renewal_reminder',
    name: 'Membership Renewal Reminder',
    category: 'membership',
    sensitivity: 'account',
    description: 'Reminder sent before a membership or annual prepay term renews.',
    required: ['first_name'],
    optional: [
      'membership_name',
      'membership_tier',
      'renewal_date',
      'renewal_days_out',
      'renewal_notice_window',
      'last_service_date',
      'monthly_rate',
      'billing_cadence',
    ],
    subject: 'Your Waves membership renewal is coming up',
    preview: 'Your WaveGuard membership renewal is approaching.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves membership renewal is coming up.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{membership_name}}' },
        { label: 'Renewal date', value: '{{renewal_date}}' },
        { label: 'Notice window', value: '{{renewal_notice_window}}' },
        { label: 'Current rate', value: '{{monthly_rate}}' },
        { label: 'Last scheduled service', value: '{{last_service_date}}' },
      ] },
      { type: 'paragraph', content: 'No action is needed if you want service to continue as scheduled.' },
      { type: 'paragraph', content: 'If you want to pause, cancel, change services, or discuss your renewal, reply to this email before the renewal date.' },
      { type: 'cta', label: 'View membership', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'membership.canceled',
    name: 'Membership Canceled',
    category: 'membership',
    sensitivity: 'account',
    description: 'Confirmation sent after a membership cancellation is completed.',
    required: ['first_name'],
    optional: [
      'membership_name',
      'membership_tier',
      'membership_status',
      'cancellation_effective_date',
      'pause_reason',
    ],
    subject: 'Your Waves membership has been canceled',
    preview: 'Your WaveGuard membership cancellation has been processed.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves membership cancellation has been processed.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{membership_name}}' },
        { label: 'Status', value: '{{membership_status}}' },
        { label: 'Effective date', value: '{{cancellation_effective_date}}' },
        { label: 'Reason', value: '{{pause_reason}}' },
      ] },
      { type: 'paragraph', content: 'Any remaining open invoices or scheduled follow-up items will still need to be resolved separately.' },
      { type: 'small_note', content: 'If this cancellation was not expected, reply to this email and our team will help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'membership.paused',
    name: 'Service Paused',
    category: 'membership',
    sensitivity: 'account',
    description: 'Notice sent when service is paused or placed on hold.',
    required: ['first_name'],
    optional: [
      'membership_name',
      'membership_tier',
      'membership_status',
      'effective_date',
      'paused_until',
      'pause_reason',
    ],
    subject: 'Your Waves service is paused',
    preview: 'Your Waves service has been paused or placed on hold.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves service has been paused or placed on hold.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{membership_name}}' },
        { label: 'Status', value: '{{membership_status}}' },
        { label: 'Paused on', value: '{{effective_date}}' },
        { label: 'Paused until', value: '{{paused_until}}' },
        { label: 'Reason', value: '{{pause_reason}}' },
      ] },
      { type: 'paragraph', content: 'Future service may remain on hold until the pause is removed or the account issue is resolved.' },
      { type: 'cta', label: 'View account', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'Need help reactivating service? Reply to this email and our team will help.' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
  },
  {
    key: 'membership.reactivated',
    name: 'Service Reactivated',
    category: 'membership',
    sensitivity: 'account',
    description: 'Notice sent when paused service is reactivated.',
    required: ['first_name'],
    optional: [
      'membership_name',
      'membership_tier',
      'membership_status',
      'reactivated_at',
      'monthly_rate',
      'billing_cadence',
    ],
    subject: 'Your Waves service is active again',
    preview: 'Your Waves service has been reactivated.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}},' },
      { type: 'paragraph', content: 'Your Waves service has been reactivated.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{membership_name}}' },
        { label: 'Status', value: '{{membership_status}}' },
        { label: 'Reactivated', value: '{{reactivated_at}}' },
        { label: 'Rate', value: '{{monthly_rate}}' },
        { label: 'Billing cadence', value: '{{billing_cadence}}' },
      ] },
      { type: 'paragraph', content: 'You can view upcoming visits and account details in your customer portal.' },
      { type: 'cta', label: 'View account', url_variable: 'customer_portal_url' },
      { type: 'signature', content: 'Thank you, The Waves Team' },
    ],
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
    mode: 'service',
    purpose: t.category,
    legal_classification: 'transactional_relationship',
    audience: 'customer',
    message_priority: 'normal',
    content_sensitivity: t.sensitivity || 'account',
    send_stream: 'transactional_required',
    suppression_group_key: 'transactional_required',
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
    [template] = await knex('email_templates').insert({ ...row, created_at: new Date() }).returning('*');
  }

  let version = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  if (version) {
    await knex('email_template_versions').where({ id: version.id }).update({
      status: 'active',
      subject: t.subject,
      preview_text: t.preview || null,
      blocks: JSON.stringify(t.blocks || []),
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
      preview_text: t.preview || null,
      blocks: JSON.stringify(t.blocks || []),
      text_body: null,
      published_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
  }

  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version?.id || template.active_version_id,
    last_published_at: new Date(),
    updated_at: new Date(),
  });

  const existingFixture = await knex('email_template_fixtures')
    .where({ template_id: template.id, is_default: true })
    .first();
  const payload = JSON.stringify(PREVIEW_PAYLOAD);
  if (existingFixture) {
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
      name: 'Happy path',
      payload,
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload,
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
  for (const template of TEMPLATES) {
    await upsertTemplate(knex, template);
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
  SHARED_VARIABLES,
  PREVIEW_PAYLOAD,
  templateRow,
};
