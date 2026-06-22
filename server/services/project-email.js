const crypto = require('crypto');
const logger = require('./logger');
const db = require('../models/db');
const EmailTemplateLibrary = require('./email-template-library');
const { getPrimaryContact, getServiceContact } = require('./customer-contact');
const { getProjectType } = require('./project-types');
const { portalUrl } = require('../utils/portal-url');
const { formatDisplayDate } = require('../utils/date-only');
const { invoiceAmountDue } = require('./invoice-helpers');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const CONTACT_EMAIL = 'contact@wavespestcontrol.com';
const SERVICE_GROUP = 'service_operational';
const TRANSACTIONAL_GROUP = 'transactional_required';

const PREP_TEMPLATE_BY_PROJECT_TYPE = Object.freeze({
  rodent_exclusion: 'prep.rodent',
  rodent_trapping: 'prep.rodent',
  flea: 'prep.flea',
  pest_inspection: 'prep.interior_pest',
  one_time_pest_treatment: 'prep.interior_pest',
  cockroach: 'prep.cockroach',
  one_time_lawn_treatment: 'prep.lawn',
  mosquito_event: 'prep.mosquito',
  termite_inspection: 'prep.termite',
  termite_treatment: 'prep.termite',
  pre_treatment_termite_certificate: 'prep.termite',
  bed_bug: 'prep.bed_bug',
  wildlife_trapping: 'prep.wildlife',
});

const PREP_TEMPLATE_KEYS = new Set(Object.values(PREP_TEMPLATE_BY_PROJECT_TYPE));

function clean(value) {
  return String(value || '').trim();
}

function cleanEmail(value) {
  return clean(value).toLowerCase();
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value));
}

function firstToken(value) {
  return clean(value).split(/\s+/)[0] || '';
}

function safeKey(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function sendAttemptKey() {
  return `${new Date().toISOString()}:${crypto.randomBytes(4).toString('hex')}`;
}

function customerName(customer = {}) {
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim()
    || clean(customer.company_name)
    || 'Waves customer';
}

function propertyAddress(customer = {}, project = {}) {
  const findings = asObject(project.findings);
  const projectAddress = clean(
    findings.property_address
    || findings.treatment_address
    || findings.service_address
  );
  if (projectAddress) return projectAddress;
  return [
    customer.address_line1,
    [customer.city, customer.state].filter(Boolean).join(', '),
    customer.zip,
  ].filter(Boolean).join(' ');
}

function displayDate(value) {
  if (!value) return '';
  return formatDisplayDate(value, { fallback: '' });
}

function projectTypeLabel(project = {}) {
  return getProjectType(project.project_type)?.label || clean(project.project_type) || 'Waves service';
}

function projectTitle(project = {}) {
  return clean(project.title) || projectTypeLabel(project);
}

function resolveProjectEmailRecipient(customer = {}) {
  const serviceEmail = clean(customer.service_contact_email);
  if (isEmailLike(serviceEmail)) {
    const service = getServiceContact(customer);
    return {
      email: cleanEmail(service.email),
      name: clean(service.name) || clean(customer.first_name),
      role: service.role || 'service_contact',
    };
  }

  const primary = getPrimaryContact(customer);
  return {
    email: isEmailLike(primary.email) ? cleanEmail(primary.email) : '',
    name: clean(primary.name) || clean(customer.first_name),
    role: primary.role || 'primary',
  };
}

function resolvePortalInviteRecipient(customer = {}) {
  const primary = getPrimaryContact(customer);
  return {
    email: isEmailLike(primary.email) ? cleanEmail(primary.email) : '',
    name: clean(primary.name) || clean(customer.first_name),
    role: primary.role || 'primary',
  };
}

function buildProjectPayload({
  project = {},
  customer = {},
  reportUrl = '',
  portalInviteUrl = '',
  recipient: explicitRecipient = null,
} = {}) {
  const recipient = explicitRecipient || resolveProjectEmailRecipient(customer);
  const firstName = firstToken(recipient.name) || firstToken(customer.first_name) || 'there';
  const typeLabel = projectTypeLabel(project);
  const serviceDate = displayDate(project.project_date || project.created_at);
  return {
    first_name: firstName,
    customer_name: customerName(customer),
    customer_email: recipient.email || cleanEmail(customer.email),
    customer_phone: clean(customer.phone),
    customer_portal_url: portalUrl('/?tab=dashboard'),
    portal_invite_url: portalInviteUrl || portalUrl('/login?next=%2F%3Ftab%3Ddashboard'),
    prep_url: project?.prep_token ? portalUrl(`/prep/${project.prep_token}`) : null,
    report_url: reportUrl,
    report_type: typeLabel,
    project_type: typeLabel,
    project_title: projectTitle(project),
    inspection_date: serviceDate,
    project_date: serviceDate,
    service_date: serviceDate,
    prepared_date: displayDate(new Date()),
    property_address: propertyAddress(customer, project),
    technician_name: clean(project.tech_name || project.technician_name),
    company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
    company_email: CONTACT_EMAIL,
  };
}

function normalizeTemplateResult(result = {}) {
  if (result.sent) {
    return {
      ok: true,
      messageId: result.message?.provider_message_id || result.messageId || null,
      deduped: !!result.deduped,
    };
  }
  return {
    ok: false,
    blocked: !!result.blocked,
    deduped: !!result.deduped,
    reason: result.reason || result.message?.error_message || 'email_not_sent',
    messageId: result.message?.provider_message_id || result.messageId || null,
  };
}

async function sendProjectTemplate({
  project,
  customer,
  templateKey,
  payload,
  suppressionGroupKey,
  categories = [],
  idempotencyKey,
  triggerEventId,
  recipient: explicitRecipient = null,
  attachments = [],
}) {
  const recipient = explicitRecipient || resolveProjectEmailRecipient(customer);
  if (!isEmailLike(recipient.email)) {
    return { ok: false, skipped: true, reason: 'missing_email' };
  }

  try {
    const result = await EmailTemplateLibrary.sendTemplate({
      templateKey,
      to: recipient.email,
      payload,
      recipientType: 'customer',
      recipientId: customer?.id || project?.customer_id || null,
      triggerEventId: triggerEventId || `${templateKey}:${project?.id || customer?.id || 'manual'}`,
      idempotencyKey,
      categories,
      suppressionGroupKey,
      attachments,
    });
    return normalizeTemplateResult(result);
  } catch (err) {
    logger.error(`[project-email] ${templateKey} failed for project ${project?.id || 'unknown'}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

function prepTemplateForProjectType(projectType) {
  return PREP_TEMPLATE_BY_PROJECT_TYPE[projectType] || null;
}

function isPrepTemplateKey(value) {
  return PREP_TEMPLATE_KEYS.has(String(value || ''));
}

async function ensurePrepToken(projectId) {
  const existing = await db('projects').select('prep_token').where({ id: projectId }).first();
  if (existing?.prep_token) return existing.prep_token;

  const token = crypto.randomBytes(16).toString('hex');
  const updated = await db('projects')
    .where({ id: projectId })
    .whereNull('prep_token')
    .update({ prep_token: token })
    .returning(['prep_token']);

  if (updated?.length) return updated[0].prep_token || token;

  const afterRace = await db('projects').select('prep_token').where({ id: projectId }).first();
  if (!afterRace?.prep_token) throw new Error(`Failed to ensure prep_token for project ${projectId}`);
  return afterRace.prep_token;
}

async function sendProjectReportReady({
  project,
  customer,
  reportUrl,
  isResend = false,
  idempotencyKey,
  attachments = [],
  // Explicit recipient override (third-party report copies). Default
  // resolution (service contact → primary) stays the customer recipient.
  recipient = null,
} = {}) {
  const payload = buildProjectPayload({ project, customer, reportUrl, recipient });
  const suffix = isResend ? `resend:${new Date().toISOString()}` : `initial:${safeKey(project?.report_token || project?.id)}`;
  return sendProjectTemplate({
    project,
    customer,
    templateKey: 'project.report_ready',
    payload,
    suppressionGroupKey: SERVICE_GROUP,
    categories: ['project_report', `project_type_${safeKey(project?.project_type)}`],
    triggerEventId: `project_report.ready:${project?.id || 'unknown'}`,
    idempotencyKey: idempotencyKey || `project.report_ready:${project?.id || 'unknown'}:${suffix}`,
    attachments,
    recipient,
  });
}

/**
 * Combined "report + invoice" delivery: ONE branded email carrying both the
 * official report PDF and the invoice PDF, with the report link and the pay
 * link in the payload. Reuses the existing (seeded) project.report_ready
 * template so no new template has to ship — the attachments and the extra
 * payload fields ride along on it.
 */
async function sendProjectReportWithInvoice({
  project,
  customer,
  reportUrl,
  payUrl,
  invoice,
  attachments = [],
  reportAttached = false,
  idempotencyKey,
  // Explicit recipient override (billing-contact copy). Default resolution
  // (service contact → primary) stays the customer recipient.
  recipient = null,
} = {}) {
  // The template's attachments sentence is a variable, not hardcoded copy: only
  // WDO sends carry a report PDF attachment (the FDACS-13645), so a non-WDO send
  // attaches just the invoice PDF and the report is delivered as a link. Pick the
  // sentence that matches what's actually attached so we never tell a customer a
  // report PDF is attached when it isn't.
  const attachmentsNote = reportAttached
    ? 'The official report PDF and your invoice PDF are attached to this email.'
    : 'Your invoice PDF is attached, and you can view your full report online using the link below.';
  const payload = {
    ...buildProjectPayload({ project, customer, reportUrl, recipient }),
    invoice_url: payUrl || '',
    pay_url: payUrl || '',
    invoice_number: clean(invoice?.invoice_number),
    // Amount due (total − applied account credit), not gross — credit is
    // auto-applied before this email is built, and the charge paths bill this.
    amount_due: invoice ? `$${invoiceAmountDue(invoice).toFixed(2)}` : '',
    attachments_note: attachmentsNote,
  };
  return sendProjectTemplate({
    project,
    customer,
    templateKey: 'project.report_with_invoice',
    payload,
    suppressionGroupKey: SERVICE_GROUP,
    categories: ['project_report', 'project_report_with_invoice', `project_type_${safeKey(project?.project_type)}`],
    triggerEventId: `project_report.with_invoice:${project?.id || 'unknown'}`,
    idempotencyKey: idempotencyKey
      || `project.report_with_invoice:${project?.id || 'unknown'}:${safeKey(invoice?.id || invoice?.invoice_number)}:${sendAttemptKey()}`,
    attachments,
    recipient,
  });
}

async function sendPrepGuide({
  project,
  customer,
  templateKey,
  idempotencyKey,
} = {}) {
  const resolvedTemplateKey = templateKey || prepTemplateForProjectType(project?.project_type);
  if (!isPrepTemplateKey(resolvedTemplateKey)) {
    return { ok: false, skipped: true, reason: 'unsupported_prep_template' };
  }
  if (project?.id) {
    project.prep_token = await ensurePrepToken(project.id);
    await db('projects').where({ id: project.id }).update({ prep_template_key: resolvedTemplateKey });
  }
  const payload = buildProjectPayload({ project, customer });
  return sendProjectTemplate({
    project,
    customer,
    templateKey: resolvedTemplateKey,
    payload,
    suppressionGroupKey: SERVICE_GROUP,
    categories: ['project_prep', `project_type_${safeKey(project?.project_type)}`],
    triggerEventId: `project_prep.ready:${project?.id || 'unknown'}:${resolvedTemplateKey}`,
    idempotencyKey: idempotencyKey || `project.prep:${project?.id || 'unknown'}:${resolvedTemplateKey}:${sendAttemptKey()}`,
  });
}

async function sendPortalInvite({
  project,
  customer,
  portalInviteUrl,
  idempotencyKey,
} = {}) {
  const recipient = resolvePortalInviteRecipient(customer);
  const payload = buildProjectPayload({
    project,
    customer,
    portalInviteUrl: portalInviteUrl || portalUrl('/login?next=%2F%3Ftab%3Ddashboard'),
    recipient,
  });
  return sendProjectTemplate({
    project,
    customer,
    templateKey: 'portal.invite',
    payload,
    suppressionGroupKey: TRANSACTIONAL_GROUP,
    categories: ['portal_invite', 'project_portal_invite'],
    triggerEventId: `portal.invite:${customer?.id || project?.customer_id || 'unknown'}`,
    idempotencyKey: idempotencyKey || `portal.invite:${customer?.id || project?.customer_id || 'unknown'}:project:${project?.id || 'unknown'}:${sendAttemptKey()}`,
    recipient,
  });
}

module.exports = {
  PREP_TEMPLATE_BY_PROJECT_TYPE,
  buildProjectPayload,
  ensurePrepToken,
  isPrepTemplateKey,
  prepTemplateForProjectType,
  resolveProjectEmailRecipient,
  resolvePortalInviteRecipient,
  sendProjectReportReady,
  sendProjectReportWithInvoice,
  sendPrepGuide,
  sendPortalInvite,
  _private: {
    propertyAddress,
    projectTypeLabel,
    normalizeTemplateResult,
  },
};
