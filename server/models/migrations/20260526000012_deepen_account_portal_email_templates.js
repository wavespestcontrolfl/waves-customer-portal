/**
 * Deepen account, portal, and membership lifecycle emails.
 *
 * Publishes new active template versions while keeping stable template keys and
 * required variables compatible with the existing senders.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';

const SHARED_OPTIONAL = [
  'customer_name',
  'customer_email',
  'customer_phone',
  'customer_portal_url',
  'portal_invite_url',
  'manage_preferences_url',
  'portal_requests_url',
  'company_phone',
  'company_email',
  'property_label',
  'property_address',
  'account_section',
  'change_summary',
  'changed_items_summary',
  'changed_at',
  'request_id',
  'request_type',
  'request_subject',
  'request_summary',
  'request_status',
  'submitted_at',
  'updated_at',
  'response_time',
  'membership_name',
  'membership_tier',
  'membership_status',
  'membership_change_summary',
  'old_membership_tier',
  'new_membership_tier',
  'old_monthly_rate',
  'new_monthly_rate',
  'monthly_rate',
  'billing_cadence',
  'included_services',
  'effective_date',
  'renewal_date',
  'renewal_days_out',
  'renewal_notice_window',
  'last_service_date',
  'paused_until',
  'pause_reason',
  'cancellation_effective_date',
  'reactivated_at',
];

const TEMPLATES = [
  {
    key: 'account.updated',
    name: 'Account Info Updated',
    purpose: 'account',
    sensitivity: 'account',
    required: ['first_name', 'change_summary'],
    optional: ['account_section', 'changed_items_summary', 'changed_at', 'property_label', 'manage_preferences_url', 'company_phone'],
    subject: 'Your Waves account settings were updated',
    preview: 'A Waves account setting was updated.',
    ctaLabel: 'Manage account',
    ctaUrlVariable: 'customer_portal_url',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, this confirms a Waves account setting was updated.' },
      { type: 'details', rows: [
        { label: 'Section', value: '{{account_section}}' },
        { label: 'What changed', value: '{{changed_items_summary}}' },
        { label: 'Property', value: '{{property_label}}' },
        { label: 'Updated', value: '{{changed_at}}' },
      ] },
      { type: 'paragraph', content: '{{change_summary}}' },
      { type: 'cta', label: 'Manage account', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'If you made this change, no action is needed. If you did not make it, reply here or call {{company_phone}} right away.' },
    ],
    fixture: {
      first_name: 'Taylor',
      change_summary: 'Your 72-hour appointment reminder was turned off.',
      changed_items_summary: '72-hour appointment reminder: On to Off',
      account_section: 'Reminder settings',
      changed_at: 'May 20, 2026',
      property_label: 'Primary property',
      customer_portal_url: 'https://portal.wavespestcontrol.com',
      company_phone: '(941) 555-0100',
    },
  },
  {
    key: 'account.request_received',
    name: 'Portal Request Received',
    purpose: 'account',
    sensitivity: 'account',
    required: ['first_name', 'request_subject'],
    optional: ['request_id', 'request_type', 'request_summary', 'request_status', 'submitted_at', 'response_time', 'portal_requests_url', 'company_phone'],
    subject: 'We received your Waves request',
    preview: 'Your request has been sent to the Waves team.',
    ctaLabel: 'Open customer portal',
    ctaUrlVariable: 'portal_requests_url',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, we received your request and sent it to the Waves team for review.' },
      { type: 'details', rows: [
        { label: 'Request', value: '{{request_subject}}' },
        { label: 'Type', value: '{{request_type}}' },
        { label: 'Status', value: '{{request_status}}' },
        { label: 'Submitted', value: '{{submitted_at}}' },
        { label: 'Expected response', value: '{{response_time}}' },
      ] },
      { type: 'paragraph', content: '{{request_summary}}' },
      { type: 'cta', label: 'Open customer portal', url_variable: 'portal_requests_url' },
      { type: 'small_note', content: 'Need to add something? Reply to this email and we will attach it to the request.' },
    ],
    fixture: {
      first_name: 'Taylor',
      request_subject: 'Move upcoming quarterly service',
      request_type: 'Schedule Change',
      request_status: 'New',
      submitted_at: 'May 20, 2026',
      response_time: '24 hours',
      request_summary: 'Friday morning works better.',
      portal_requests_url: 'https://portal.wavespestcontrol.com',
    },
  },
  {
    key: 'account.request_updated',
    name: 'Portal Request Updated',
    purpose: 'account',
    sensitivity: 'account',
    required: ['first_name', 'request_subject', 'request_status'],
    optional: ['request_id', 'request_type', 'request_summary', 'updated_at', 'portal_requests_url', 'company_phone'],
    subject: 'Your Waves request was updated',
    preview: 'There is an update on your Waves request.',
    ctaLabel: 'Open customer portal',
    ctaUrlVariable: 'portal_requests_url',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, there is an update on your Waves request.' },
      { type: 'details', rows: [
        { label: 'Request', value: '{{request_subject}}' },
        { label: 'Type', value: '{{request_type}}' },
        { label: 'Status', value: '{{request_status}}' },
        { label: 'Updated', value: '{{updated_at}}' },
      ] },
      { type: 'paragraph', content: '{{request_summary}}' },
      { type: 'cta', label: 'Open customer portal', url_variable: 'portal_requests_url' },
      { type: 'small_note', content: 'Questions or changes? Reply here and our team will help.' },
    ],
    fixture: {
      first_name: 'Taylor',
      request_subject: 'Move upcoming quarterly service',
      request_status: 'Scheduled',
      request_type: 'Schedule Change',
      updated_at: 'May 21, 2026',
      request_summary: 'Your visit has been moved to Friday morning.',
      portal_requests_url: 'https://portal.wavespestcontrol.com',
    },
  },
  {
    key: 'portal.invite',
    name: 'Customer Portal Invite',
    purpose: 'account',
    sensitivity: 'account',
    stream: 'transactional_required',
    required: ['first_name', 'portal_invite_url'],
    optional: ['customer_name', 'customer_email', 'customer_phone', 'customer_portal_url', 'property_address', 'company_phone', 'company_email'],
    subject: 'Access your Waves customer portal',
    preview: 'Use your Waves customer portal for reports, services, invoices, and account settings.',
    ctaLabel: 'Open customer portal',
    ctaUrlVariable: 'portal_invite_url',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, your Waves customer portal is ready.' },
      { type: 'paragraph', content: 'Use the portal to view upcoming services, service reports, invoices, prep instructions, payment settings, and account preferences.' },
      { type: 'details', rows: [
        { label: 'Customer', value: '{{customer_name}}' },
        { label: 'Email', value: '{{customer_email}}' },
        { label: 'Property', value: '{{property_address}}' },
      ] },
      { type: 'cta', label: 'Open customer portal', url_variable: 'portal_invite_url' },
      { type: 'small_note', content: 'If you did not request portal access, reply to this email or call {{company_phone}}.' },
    ],
    fixture: {
      first_name: 'Taylor',
      portal_invite_url: 'https://portal.wavespestcontrol.com/login',
      customer_name: 'Taylor Morgan',
      customer_email: 'taylor@example.com',
      property_address: '123 Palm Ave, Bradenton, FL 34211',
      company_phone: '(941) 555-0100',
    },
  },
  {
    key: 'membership.started',
    name: 'Membership Started',
    purpose: 'membership',
    sensitivity: 'account',
    required: ['first_name'],
    optional: ['membership_name', 'membership_tier', 'membership_status', 'effective_date', 'monthly_rate', 'billing_cadence', 'included_services', 'customer_portal_url'],
    subject: 'Your Waves membership is active',
    preview: 'Your WaveGuard membership is now active.',
    ctaLabel: 'View membership',
    ctaUrlVariable: 'customer_portal_url',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, your Waves membership is active.' },
      { type: 'paragraph', content: 'Here is the membership information we have on file. You can review visits, reports, invoices, and account settings anytime in the portal.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{membership_name}}' },
        { label: 'Status', value: '{{membership_status}}' },
        { label: 'Effective date', value: '{{effective_date}}' },
        { label: 'Rate', value: '{{monthly_rate}}' },
        { label: 'Billing cadence', value: '{{billing_cadence}}' },
        { label: 'Included services', value: '{{included_services}}' },
      ] },
      { type: 'cta', label: 'View membership', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'Questions about what is included? Reply here and we will review it with you.' },
    ],
    fixture: membershipFixture(),
  },
  {
    key: 'membership.updated',
    name: 'Membership Updated',
    purpose: 'membership',
    sensitivity: 'account',
    required: ['first_name'],
    optional: ['membership_name', 'membership_status', 'membership_change_summary', 'old_membership_tier', 'new_membership_tier', 'old_monthly_rate', 'new_monthly_rate', 'effective_date', 'included_services', 'customer_portal_url'],
    subject: 'Your Waves membership was updated',
    preview: 'Your WaveGuard membership details were updated.',
    ctaLabel: 'View membership',
    ctaUrlVariable: 'customer_portal_url',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, your Waves membership details were updated.' },
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
      { type: 'small_note', content: 'If this does not match what you expected, reply here and our team will review it.' },
    ],
    fixture: {
      ...membershipFixture(),
      membership_change_summary: 'Tier: Silver to Gold; Monthly rate: $129.00 to $159.00',
      old_membership_tier: 'Silver',
      new_membership_tier: 'Gold',
      old_monthly_rate: '$129.00',
      new_monthly_rate: '$159.00',
    },
  },
  {
    key: 'membership.renewal_reminder',
    name: 'Membership Renewal Reminder',
    purpose: 'membership',
    sensitivity: 'account',
    required: ['first_name'],
    optional: ['membership_name', 'membership_tier', 'renewal_date', 'renewal_days_out', 'renewal_notice_window', 'last_service_date', 'monthly_rate', 'billing_cadence', 'customer_portal_url'],
    subject: 'Your Waves membership renewal is coming up',
    preview: 'Your WaveGuard membership renewal is approaching.',
    ctaLabel: 'View membership',
    ctaUrlVariable: 'customer_portal_url',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, your Waves membership renewal is coming up.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{membership_name}}' },
        { label: 'Renewal date', value: '{{renewal_date}}' },
        { label: 'Notice window', value: '{{renewal_notice_window}}' },
        { label: 'Current rate', value: '{{monthly_rate}}' },
        { label: 'Billing cadence', value: '{{billing_cadence}}' },
        { label: 'Last scheduled service', value: '{{last_service_date}}' },
      ] },
      { type: 'paragraph', content: 'No action is needed if you want service to continue as scheduled.' },
      { type: 'paragraph', content: 'If you want to pause, cancel, change services, or discuss the renewal, reply before the renewal date.' },
      { type: 'cta', label: 'View membership', url_variable: 'customer_portal_url' },
    ],
    fixture: {
      ...membershipFixture(),
      renewal_date: 'June 20, 2026',
      renewal_days_out: '30',
      renewal_notice_window: '30 days',
      last_service_date: 'June 13, 2026',
    },
  },
  {
    key: 'membership.canceled',
    name: 'Membership Canceled',
    purpose: 'membership',
    sensitivity: 'account',
    required: ['first_name'],
    optional: ['membership_name', 'membership_tier', 'membership_status', 'cancellation_effective_date', 'pause_reason', 'monthly_rate', 'billing_cadence', 'included_services'],
    subject: 'Your Waves membership has been canceled',
    preview: 'Your WaveGuard membership cancellation has been processed.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, your Waves membership cancellation has been processed.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{membership_name}}' },
        { label: 'Status', value: '{{membership_status}}' },
        { label: 'Effective date', value: '{{cancellation_effective_date}}' },
        { label: 'Reason', value: '{{pause_reason}}' },
      ] },
      { type: 'paragraph', content: 'Any remaining open invoices, scheduled follow-up items, or completed-service charges still need to be resolved separately.' },
      { type: 'small_note', content: 'If this cancellation was not expected, reply to this email and our team will help.' },
    ],
    fixture: { ...membershipFixture(), membership_status: 'Canceled', cancellation_effective_date: 'May 31, 2026', pause_reason: 'Customer requested cancellation' },
  },
  {
    key: 'membership.paused',
    name: 'Service Paused',
    purpose: 'membership',
    sensitivity: 'account',
    required: ['first_name'],
    optional: ['membership_name', 'membership_tier', 'membership_status', 'effective_date', 'paused_until', 'pause_reason', 'customer_portal_url', 'company_phone'],
    subject: 'Your Waves service is paused',
    preview: 'Your Waves service has been paused or placed on hold.',
    ctaLabel: 'View account',
    ctaUrlVariable: 'customer_portal_url',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, your Waves service has been paused or placed on hold.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{membership_name}}' },
        { label: 'Status', value: '{{membership_status}}' },
        { label: 'Paused on', value: '{{effective_date}}' },
        { label: 'Paused until', value: '{{paused_until}}' },
        { label: 'Reason', value: '{{pause_reason}}' },
      ] },
      { type: 'paragraph', content: 'Future service may remain on hold until the pause is removed or the account issue is resolved.' },
      { type: 'cta', label: 'View account', url_variable: 'customer_portal_url' },
      { type: 'small_note', content: 'Need help reactivating service? Reply here or call {{company_phone}}.' },
    ],
    fixture: { ...membershipFixture(), membership_status: 'Paused', effective_date: 'May 20, 2026', paused_until: 'July 20, 2026', pause_reason: 'Customer requested seasonal pause' },
  },
  {
    key: 'membership.reactivated',
    name: 'Service Reactivated',
    purpose: 'membership',
    sensitivity: 'account',
    required: ['first_name'],
    optional: ['membership_name', 'membership_tier', 'membership_status', 'reactivated_at', 'monthly_rate', 'billing_cadence', 'customer_portal_url'],
    subject: 'Your Waves service is active again',
    preview: 'Your Waves service has been reactivated.',
    ctaLabel: 'View account',
    ctaUrlVariable: 'customer_portal_url',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, your Waves service is active again.' },
      { type: 'details', rows: [
        { label: 'Plan', value: '{{membership_name}}' },
        { label: 'Status', value: '{{membership_status}}' },
        { label: 'Reactivated', value: '{{reactivated_at}}' },
        { label: 'Rate', value: '{{monthly_rate}}' },
        { label: 'Billing cadence', value: '{{billing_cadence}}' },
      ] },
      { type: 'paragraph', content: 'You can view upcoming visits, reports, invoices, and account details in your customer portal.' },
      { type: 'cta', label: 'View account', url_variable: 'customer_portal_url' },
    ],
    fixture: { ...membershipFixture(), membership_status: 'Active', reactivated_at: 'May 20, 2026' },
  },
];

function membershipFixture() {
  return {
    first_name: 'Taylor',
    membership_name: 'WaveGuard Gold',
    membership_tier: 'Gold',
    membership_status: 'Active',
    monthly_rate: '$159.00',
    billing_cadence: 'monthly',
    included_services: 'Quarterly pest control, lawn care, mosquito control',
    effective_date: 'May 20, 2026',
    customer_portal_url: 'https://portal.wavespestcontrol.com',
    company_phone: '(941) 555-0100',
  };
}

function json(value) {
  return JSON.stringify(value || (Array.isArray(value) ? [] : {}));
}

function templateRow(t, existing = {}) {
  const allowed = [...new Set([...(t.required || []), ...(t.optional || []), ...SHARED_OPTIONAL])];
  return {
    template_key: t.key,
    name: t.name || existing.name || t.key,
    description: t.description || existing.description || null,
    mode: existing.mode || 'service',
    purpose: t.purpose || existing.purpose || 'account',
    legal_classification: existing.legal_classification || 'transactional_relationship',
    audience: existing.audience || 'customer',
    message_priority: existing.message_priority || 'normal',
    content_sensitivity: t.sensitivity || existing.content_sensitivity || 'account',
    send_stream: t.stream || existing.send_stream || 'transactional_required',
    suppression_group_key: t.stream || existing.suppression_group_key || 'transactional_required',
    layout_wrapper_id: existing.layout_wrapper_id || 'service_default_v1',
    from_name: existing.from_name || 'Waves Pest Control',
    from_email: existing.from_email || SERVICE_FROM,
    reply_to: existing.reply_to || SERVICE_FROM,
    default_cta_label: t.ctaLabel || existing.default_cta_label || null,
    default_cta_url_variable: t.ctaUrlVariable || existing.default_cta_url_variable || null,
    allowed_variables: json(allowed),
    required_variables: json(t.required || []),
    optional_variables: json(allowed.filter((key) => !(t.required || []).includes(key))),
    status: 'active',
  };
}

async function publishTemplateVersion(knex, t) {
  let template = await knex('email_templates').where({ template_key: t.key }).first();
  const row = templateRow(t, template || {});
  if (!template) {
    [template] = await knex('email_templates').insert(row).returning('*');
  } else {
    await knex('email_templates').where({ id: template.id }).update({
      ...row,
      updated_at: new Date(),
    });
    template = await knex('email_templates').where({ id: template.id }).first();
  }

  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject: t.subject,
    preview_text: t.preview || null,
    blocks: json(t.blocks || []),
    text_body: null,
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
  const payload = json(t.fixture || {});
  if (existingFixture) {
    await knex('email_template_fixtures').where({ id: existingFixture.id }).update({
      payload,
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: template.id,
      name: 'Happy path',
      payload,
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

exports.down = async function down() {
  // Historical template versions are intentionally retained.
};
