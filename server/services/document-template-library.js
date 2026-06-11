const {
  BUSINESS_NAME,
  BUSINESS_EMAIL,
  BUSINESS_PHONE,
  ESIGN_DISCLOSURE,
} = require('./contracts');

const TEMPLATE_KEY_RE = /^[a-z0-9][a-z0-9._-]{1,118}[a-z0-9]$/;
const STATUSES = new Set(['draft', 'active', 'paused', 'archived']);
const DELIVERY_CHANNELS = new Set(['email', 'sms', 'both']);
const DEFAULT_REMINDER_SCHEDULE_DAYS = [1, 3, -1];
const MAX_DOCUMENT_EXPIRE_DAYS = 14;
const VIEW_ONLY_TEMPLATE_CATEGORY = 'marketing';
const VIEW_ONLY_TEMPLATE_DOCUMENT_TYPE = 'customer_guide';

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (Array.isArray(value) || (typeof value === 'object' && !(value instanceof Date))) return value;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function jsonb(value, fallback) {
  const safe = value === undefined ? fallback : value;
  return JSON.stringify(safe, (key, next) => {
    if (typeof next === 'number' && !Number.isFinite(next)) return null;
    return next;
  });
}

function cleanString(value, fallback = '') {
  const str = String(value ?? '').trim();
  return str || fallback;
}

function cleanArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return [...new Set(value.map(item => cleanString(item)).filter(Boolean))];
  }
  if (typeof value === 'string') {
    const parsed = parseJson(value, null);
    if (Array.isArray(parsed)) return cleanArray(parsed);
    return cleanArray(value.split(','));
  }
  return [];
}

function cleanNumberArray(value, fallback = []) {
  const source = Array.isArray(value) ? value : parseJson(value, value);
  if (Array.isArray(source) && source.length === 0) return [];
  const raw = Array.isArray(source)
    ? source
    : String(source || '').split(',');
  const values = raw
    .map(item => Number(String(item).trim()))
    .filter(number => Number.isFinite(number) && Number.isInteger(number) && number !== 0 && number >= -30 && number <= 365);
  return [...new Set(values)].sort((a, b) => a - b).length ? [...new Set(values)].sort((a, b) => a - b) : fallback;
}

function normalizeDeliveryChannel(value, fallback = 'email') {
  const channel = cleanString(value, fallback).toLowerCase();
  return DELIVERY_CHANNELS.has(channel) ? channel : fallback;
}

function normalizeExpireAfterDays(value, fallback = 14) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(MAX_DOCUMENT_EXPIRE_DAYS, Math.floor(number)));
}

function normalizeTemplateKey(value) {
  const key = cleanString(value).toLowerCase().replace(/\s+/g, '_');
  if (!TEMPLATE_KEY_RE.test(key)) {
    const err = new Error('Template key must be 3-120 lowercase characters and may use dots, dashes, or underscores.');
    err.status = 400;
    throw err;
  }
  return key;
}

function normalizeStatus(value, fallback = 'active') {
  const status = cleanString(value, fallback).toLowerCase();
  if (!STATUSES.has(status)) {
    const err = new Error(`Unsupported document template status '${status}'.`);
    err.status = 400;
    throw err;
  }
  return status;
}

function canDisableTemplateSignature(template = {}) {
  return template.category === VIEW_ONLY_TEMPLATE_CATEGORY
    && template.document_type === VIEW_ONLY_TEMPLATE_DOCUMENT_TYPE;
}

function assertTemplateSignatureMode(template = {}) {
  if (template.requires_signature !== false || canDisableTemplateSignature(template)) return;
  const err = new Error('Only marketing customer-guide document templates can disable e-signature.');
  err.status = 400;
  throw err;
}

function validateTemplatePayload(body = {}, { partial = false } = {}) {
  const payload = {};
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'templateKey') || Object.prototype.hasOwnProperty.call(body, 'template_key')) {
    payload.template_key = normalizeTemplateKey(body.templateKey || body.template_key);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'name')) {
    payload.name = cleanString(body.name);
    if (!payload.name) {
      const err = new Error('Template name is required.');
      err.status = 400;
      throw err;
    }
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'category')) {
    payload.category = cleanString(body.category, 'general').toLowerCase().replace(/\s+/g, '_');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'documentType') || Object.prototype.hasOwnProperty.call(body, 'document_type')) {
    payload.document_type = cleanString(body.documentType || body.document_type, 'other').toLowerCase().replace(/\s+/g, '_');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'status')) {
    payload.status = normalizeStatus(body.status, 'active');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'description')) {
    payload.description = cleanString(body.description) || null;
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'requiresSignature') || Object.prototype.hasOwnProperty.call(body, 'requires_signature')) {
    payload.requires_signature = (body.requiresSignature ?? body.requires_signature) !== false;
    if (!partial) assertTemplateSignatureMode(payload);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'audience')) {
    payload.audience = cleanString(body.audience, 'customer').toLowerCase().replace(/\s+/g, '_');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'variables')) {
    payload.variables = cleanArray(body.variables);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'tags')) {
    payload.tags = cleanArray(body.tags);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'defaultDeliveryChannel') || Object.prototype.hasOwnProperty.call(body, 'default_delivery_channel')) {
    payload.default_delivery_channel = normalizeDeliveryChannel(body.defaultDeliveryChannel || body.default_delivery_channel, 'email');
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'reminderScheduleDays') || Object.prototype.hasOwnProperty.call(body, 'reminder_schedule_days')) {
    payload.reminder_schedule_days = cleanNumberArray(body.reminderScheduleDays ?? body.reminder_schedule_days, DEFAULT_REMINDER_SCHEDULE_DAYS);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'expireAfterDays') || Object.prototype.hasOwnProperty.call(body, 'expire_after_days')) {
    payload.expire_after_days = normalizeExpireAfterDays(body.expireAfterDays ?? body.expire_after_days, 14);
  }
  return payload;
}

function validateVersionPayload(body = {}, { partial = false } = {}) {
  const payload = {};
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'title')) {
    payload.title = cleanString(body.title);
    if (!payload.title) {
      const err = new Error('Document title is required.');
      err.status = 400;
      throw err;
    }
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'body')) {
    payload.body = cleanString(body.body);
    if (!payload.body) {
      const err = new Error('Document body is required.');
      err.status = 400;
      throw err;
    }
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'signerDisclosure')) {
    payload.signer_disclosure = cleanString(body.signerDisclosure, ESIGN_DISCLOSURE);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'variables')) {
    payload.variables = cleanArray(body.variables);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, 'requiredFields')) {
    payload.required_fields = cleanArray(body.requiredFields).length
      ? cleanArray(body.requiredFields)
      : ['initials', 'signedName'];
  }
  return payload;
}

function getPathValue(source, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  let current = source;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function renderDocumentText(text, context = {}) {
  const used = new Set();
  const unresolved = new Set();
  const rendered = String(text || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key) => {
    const value = getPathValue(context, key);
    used.add(key);
    if (value == null || value === '') {
      unresolved.add(key);
      return match;
    }
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value);
  });
  return { rendered, usedVariables: [...used].sort(), unresolvedVariables: [...unresolved].sort() };
}

function renderDocumentTemplate({ template = {}, version = {}, context = {} } = {}) {
  const title = renderDocumentText(version.title || template.name || 'Document', context);
  const body = renderDocumentText(version.body || '', context);
  return {
    title: title.rendered,
    body: body.rendered,
    usedVariables: [...new Set([...title.usedVariables, ...body.usedVariables])].sort(),
    unresolvedVariables: [...new Set([...title.unresolvedVariables, ...body.unresolvedVariables])].sort(),
    renderSummary: {
      templateKey: template.template_key || template.templateKey || null,
      templateVersionId: version.id || null,
      versionNumber: version.version_number || version.versionNumber || null,
      unresolvedVariables: [...new Set([...title.unresolvedVariables, ...body.unresolvedVariables])].sort(),
    },
  };
}

function customerName(customer = {}) {
  return cleanString(`${customer.first_name || customer.firstName || ''} ${customer.last_name || customer.lastName || ''}`)
    || cleanString(customer.company_name || customer.companyName)
    || 'Customer';
}

function customerAddress(customer = {}) {
  return [
    customer.address_line1 || customer.addressLine1 || customer.address,
    customer.address_line2 || customer.addressLine2,
    [customer.city, customer.state || 'FL', customer.zip || customer.postal_code].filter(Boolean).join(' '),
  ].filter(Boolean).join(', ');
}

function buildCustomerDocumentContext(customer = {}, values = {}) {
  const extra = parseJson(values, {}) || {};
  const extraService = extra.service && typeof extra.service === 'object' ? extra.service : {};
  const extraAgreement = extra.agreement && typeof extra.agreement === 'object' ? extra.agreement : {};
  const extraInspection = extra.inspection && typeof extra.inspection === 'object' ? extra.inspection : {};
  return {
    ...extra,
    business: {
      name: BUSINESS_NAME,
      email: BUSINESS_EMAIL,
      phone: BUSINESS_PHONE,
    },
    customer: {
      id: customer.id || null,
      name: customerName(customer),
      first_name: customer.first_name || customer.firstName || '',
      last_name: customer.last_name || customer.lastName || '',
      email: customer.email || '',
      phone: customer.phone || '',
      address: customerAddress(customer),
    },
    service: {
      ...extraService,
      name: extraService.name || extra.serviceName || customer.waveguard_tier || 'Waves service',
      date: extraService.date || extra.serviceDate || '',
    },
    agreement: {
      ...extraAgreement,
      start_date: extraAgreement.start_date || extra.agreementStartDate || extra.startDate || '',
    },
    inspection: {
      ...extraInspection,
      date: extraInspection.date || extra.inspectionDate || '',
    },
  };
}

function serializeTemplate(row = {}, activeVersion = null) {
  if (!row) return null;
  return {
    id: row.id,
    template_key: row.template_key,
    templateKey: row.template_key,
    name: row.name,
    category: row.category,
    documentType: row.document_type,
    status: row.status,
    description: row.description || '',
    requiresSignature: row.requires_signature !== false,
    audience: row.audience || 'customer',
    variables: cleanArray(parseJson(row.variables, [])),
    tags: cleanArray(parseJson(row.tags, [])),
    defaultDeliveryChannel: normalizeDeliveryChannel(row.default_delivery_channel || row.defaultDeliveryChannel, 'email'),
    reminderScheduleDays: cleanNumberArray(row.reminder_schedule_days ?? row.reminderScheduleDays, DEFAULT_REMINDER_SCHEDULE_DAYS),
    expireAfterDays: normalizeExpireAfterDays(row.expire_after_days || row.expireAfterDays, 14),
    activeVersionId: row.active_version_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    activeVersion: activeVersion ? serializeVersion(activeVersion) : undefined,
  };
}

function serializeVersion(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    templateId: row.template_id,
    versionNumber: Number(row.version_number || 0),
    title: row.title,
    body: row.body,
    signerDisclosure: row.signer_disclosure || ESIGN_DISCLOSURE,
    variables: cleanArray(parseJson(row.variables, [])),
    requiredFields: cleanArray(parseJson(row.required_fields, [])),
    createdBy: row.created_by || null,
    publishedAt: row.published_at || null,
    createdAt: row.created_at || null,
  };
}

module.exports = {
  ESIGN_DISCLOSURE,
  assertTemplateSignatureMode,
  buildCustomerDocumentContext,
  canDisableTemplateSignature,
  cleanArray,
  cleanNumberArray,
  DEFAULT_REMINDER_SCHEDULE_DAYS,
  jsonb,
  normalizeDeliveryChannel,
  normalizeExpireAfterDays,
  normalizeStatus,
  normalizeTemplateKey,
  renderDocumentTemplate,
  renderDocumentText,
  serializeTemplate,
  serializeVersion,
  validateTemplatePayload,
  validateVersionPayload,
};
