/**
 * Final customer email blocker cleanup.
 *
 * Removes review/demo placeholder fixture values, tightens account and
 * membership required variables where rows are always customer-visible, and
 * makes prep fixtures carry template-specific service labels.
 */

const SERVICE_FROM = 'contact@wavespestcontrol.com';
const SUPPORT_PHONE = '(941) 297-5749';
const PORTAL_URL = 'https://portal.wavespestcontrol.com';

const PREP_LABELS = {
  'prep.bed_bug': 'Bed Bug Treatment',
  'prep.cockroach': 'Cockroach Treatment',
  'prep.rodent': 'Rodent Exclusion',
  'prep.flea': 'Flea Treatment',
  'prep.mosquito': 'Mosquito Service',
  'prep.lawn': 'Lawn Treatment',
  'prep.termite': 'Termite Treatment',
  'prep.interior_pest': 'Interior Pest Treatment',
};

const ACCOUNT_TEMPLATES = {
  'account.request_received': {
    required: ['first_name', 'request_subject', 'request_type', 'request_status', 'submitted_at', 'response_time', 'portal_requests_url'],
    subject: 'We received your Waves request',
    preview_text: 'Your request has been sent to the Waves team.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, we received your request and sent it to the Waves team.' },
      { type: 'details', rows: [
        { label: 'Request', value: '{{request_subject}}' },
        { label: 'Type', value: '{{request_type}}' },
        { label: 'Status', value: '{{request_status}}' },
        { label: 'Submitted', value: '{{submitted_at}}' },
        { label: 'Expected response', value: '{{response_time}}' },
      ] },
      { type: 'paragraph', content: '{{request_summary}}' },
      { type: 'cta', label: 'Open request', url_variable: 'portal_requests_url' },
      { type: 'small_note', content: 'Need to add something? Reply to this email and we will attach it to the request.' },
    ],
    fixture: {
      first_name: 'Taylor',
      request_subject: 'Move upcoming quarterly service',
      request_type: 'Schedule change',
      request_status: 'New',
      submitted_at: 'May 20, 2026',
      response_time: 'Within 24 hours',
      request_summary: 'Friday morning works better.',
      portal_requests_url: PORTAL_URL,
      company_phone: SUPPORT_PHONE,
    },
  },
  'account.request_updated': {
    required: ['first_name', 'request_subject', 'request_type', 'request_status', 'updated_at', 'portal_requests_url'],
    subject: 'Your Waves request was updated',
    preview_text: 'There is an update on your Waves request.',
    blocks: [
      { type: 'paragraph', content: 'Hello {{first_name}}, there is an update on your Waves request.' },
      { type: 'details', rows: [
        { label: 'Request', value: '{{request_subject}}' },
        { label: 'Type', value: '{{request_type}}' },
        { label: 'Status', value: '{{request_status}}' },
        { label: 'Updated', value: '{{updated_at}}' },
      ] },
      { type: 'paragraph', content: '{{request_summary}}' },
      { type: 'cta', label: 'Open request', url_variable: 'portal_requests_url' },
      { type: 'small_note', content: 'Questions or changes? Reply here and our team will help.' },
    ],
    fixture: {
      first_name: 'Taylor',
      request_subject: 'Move upcoming quarterly service',
      request_type: 'Schedule change',
      request_status: 'Scheduled',
      updated_at: 'May 21, 2026',
      request_summary: 'Your visit has been moved to Friday morning.',
      portal_requests_url: PORTAL_URL,
      company_phone: SUPPORT_PHONE,
    },
  },
};

const MEMBERSHIP_TEMPLATES = {
  'membership.started': {
    required: ['first_name', 'membership_name', 'membership_status', 'effective_date', 'monthly_rate', 'billing_cadence', 'customer_portal_url'],
    fixture: membershipFixture(),
  },
  'membership.renewal_reminder': {
    required: ['first_name', 'membership_name', 'renewal_date', 'monthly_rate', 'billing_cadence', 'customer_portal_url'],
    fixture: {
      ...membershipFixture(),
      renewal_date: 'June 20, 2026',
      renewal_days_out: '30',
      renewal_notice_window: '30 days',
      last_service_date: 'June 13, 2026',
    },
  },
  'membership.paused': {
    required: ['first_name', 'membership_name', 'membership_status', 'effective_date', 'pause_reason', 'customer_portal_url'],
    fixture: {
      ...membershipFixture(),
      membership_status: 'Paused',
      effective_date: 'May 20, 2026',
      paused_until: 'July 20, 2026',
      pause_reason: 'Customer requested seasonal pause',
    },
  },
  'membership.reactivated': {
    required: ['first_name', 'membership_name', 'membership_status', 'reactivated_at', 'monthly_rate', 'billing_cadence', 'customer_portal_url'],
    fixture: {
      ...membershipFixture(),
      membership_status: 'Active',
      reactivated_at: 'May 20, 2026',
    },
  },
  'membership.canceled': {
    required: ['first_name', 'membership_name', 'membership_status', 'cancellation_effective_date'],
    fixture: {
      ...membershipFixture(),
      membership_status: 'Canceled',
      cancellation_effective_date: 'May 31, 2026',
      pause_reason: 'Customer requested cancellation',
    },
  },
};

function membershipFixture() {
  return {
    first_name: 'Taylor',
    membership_name: 'WaveGuard Gold',
    membership_tier: 'Gold',
    membership_status: 'Active',
    monthly_rate: '$159.00',
    billing_cadence: 'Monthly',
    included_services: 'Quarterly pest control, lawn care, mosquito control',
    effective_date: 'May 20, 2026',
    customer_portal_url: PORTAL_URL,
    company_phone: SUPPORT_PHONE,
  };
}

function json(value) {
  return JSON.stringify(value || (Array.isArray(value) ? [] : {}));
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function extractVariables(input, out = new Set()) {
  const text = typeof input === 'string' ? input : JSON.stringify(input || '');
  text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_, key) => {
    out.add(key);
    return '';
  });
  return out;
}

function variablesFor(template, version, required, extra = []) {
  const set = new Set([
    ...required,
    ...extra,
    'company_phone',
    'company_email',
  ]);
  extractVariables(version.subject, set);
  extractVariables(version.preview_text, set);
  extractVariables(version.text_body, set);
  for (const block of asArray(version.blocks)) extractVariables(block, set);
  return [...set].sort();
}

async function upsertFixture(knex, templateId, payload) {
  const fixture = await knex('email_template_fixtures')
    .where({ template_id: templateId, is_default: true })
    .first();
  if (fixture) {
    await knex('email_template_fixtures').where({ id: fixture.id }).update({
      payload: json(payload),
      updated_at: new Date(),
    });
  } else {
    await knex('email_template_fixtures').insert({
      template_id: templateId,
      name: 'Happy path',
      payload: json(payload),
      is_default: true,
    });
  }
}

async function publishVersion(knex, template, sourceVersion, changes) {
  const blocks = changes.blocks || asArray(sourceVersion.blocks);
  const subject = changes.subject || sourceVersion.subject;
  const previewText = changes.preview_text !== undefined ? changes.preview_text : sourceVersion.preview_text;
  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject,
    preview_text: previewText,
    blocks: json(blocks),
    text_body: changes.text_body !== undefined ? changes.text_body : sourceVersion.text_body,
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
  return version;
}

async function updateContract(knex, templateKey, required, fixture, extraAllowed = []) {
  const template = await knex('email_templates').where({ template_key: templateKey }).first();
  if (!template?.active_version_id) return;
  const version = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!version) return;
  const allowed = variablesFor(template, version, required, extraAllowed);
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: json(allowed),
    required_variables: json(required),
    optional_variables: json(allowed.filter((key) => !required.includes(key))),
    updated_at: new Date(),
  });
  await upsertFixture(knex, template.id, fixture);
}

async function updateAccountTemplate(knex, templateKey, config) {
  const template = await knex('email_templates').where({ template_key: templateKey }).first();
  if (!template?.active_version_id) return;
  const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!current) return;
  const version = await publishVersion(knex, template, current, config);
  const allowed = variablesFor(template, version, config.required);
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: json(allowed),
    required_variables: json(config.required),
    optional_variables: json(allowed.filter((key) => !config.required.includes(key))),
    default_cta_label: null,
    default_cta_url_variable: null,
    updated_at: new Date(),
  });
  await upsertFixture(knex, template.id, config.fixture);
}

async function updatePrepTemplate(knex, templateKey, label) {
  const template = await knex('email_templates').where({ template_key: templateKey }).first();
  if (!template?.active_version_id) return;
  const version = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!version) return;
  const required = ['first_name', 'prep_url', 'project_type', 'service_date'];
  const allowed = variablesFor(template, version, required, ['property_address', 'technician_name']);
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: json(allowed),
    required_variables: json(required),
    optional_variables: json(allowed.filter((key) => !required.includes(key))),
    default_cta_label: null,
    default_cta_url_variable: null,
    updated_at: new Date(),
  });
  await upsertFixture(knex, template.id, {
    first_name: 'Taylor',
    prep_url: PORTAL_URL,
    project_type: label,
    service_date: 'June 14, 2026',
    property_address: '123 Palm Ave, Sarasota, FL 34236',
    company_phone: SUPPORT_PHONE,
  });
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions')
    && await knex.schema.hasTable('email_template_fixtures');
  if (!hasTables) return;

  for (const [key, config] of Object.entries(ACCOUNT_TEMPLATES)) {
    await updateAccountTemplate(knex, key, config);
  }
  for (const [key, config] of Object.entries(MEMBERSHIP_TEMPLATES)) {
    await updateContract(knex, key, config.required, config.fixture);
  }
  for (const [key, label] of Object.entries(PREP_LABELS)) {
    await updatePrepTemplate(knex, key, label);
  }
};

exports.down = async function down() {
  // Historical template versions are intentionally retained.
};
