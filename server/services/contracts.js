const crypto = require('crypto');
const { CONSENT_TEXT, CONSENT_VERSION, getConsentText } = require('./payment-method-consent-text');
const { publicPortalUrl } = require('../utils/portal-url');

const BUSINESS_NAME = 'Waves Pest Control, LLC';
const BUSINESS_EMAIL = 'billing@wavespestcontrol.com';
const BUSINESS_PHONE = '(941) 318-7612';
const CONTRACT_TOKEN_BYTES = 32;
const CONTRACT_TOKEN_TTL_DAYS = 14;
const CONTRACT_TOKEN_MAX_TTL_DAYS = 14;

const ESIGN_DISCLOSURE = [
  'I agree to receive and sign this authorization electronically.',
  'I understand that my electronic signature, typed name, initials, and submission of this form',
  'show my intent to sign and have the same effect as a handwritten signature for this authorization.',
].join(' ');

function clean(value) {
  const str = String(value || '').trim();
  return str || null;
}

function signerName(customer = {}) {
  return clean(`${customer.first_name || customer.firstName || ''} ${customer.last_name || customer.lastName || ''}`)
    || clean(customer.company_name || customer.companyName)
    || 'Customer';
}

function dateLabel(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

function paymentMethodLabel(method = {}) {
  if (!method) return 'No payment method selected';
  const methodType = method.method_type || method.methodType;
  if (methodType === 'ach' || methodType === 'us_bank_account') {
    return `${method.bank_name || method.bankName || 'Bank account'} ending ${method.bank_last_four || method.lastFour || '----'}`;
  }
  return `${method.card_brand || method.cardBrand || 'Card'} ending ${method.last_four || method.lastFour || '----'}`;
}

function buildAutopayContractSnapshot({
  customer,
  paymentMethod,
  serviceName,
  renewalDate,
  cancellationDeadline,
}) {
  const recipient = signerName(customer);
  const serviceLabel = clean(serviceName) || 'Waves pest control or lawn service';
  const renewalLabel = dateLabel(renewalDate);
  const deadlineLabel = dateLabel(cancellationDeadline);
  const renewalBlock = renewalLabel
    ? [
      `Service renewal: The current service agreement for ${serviceLabel} is set to renew on ${renewalLabel}.`,
      deadlineLabel
        ? `To change or cancel before renewal, contact Waves by ${deadlineLabel}.`
        : 'To change or cancel before renewal, contact Waves before the renewal deadline shown in the customer account.',
      'Unless cancelled, the service agreement may renew according to the agreement terms shown in the customer portal or service agreement.',
    ].join(' ')
    : `Service renewal: Renewal timing and cancellation deadlines remain controlled by the customer's service agreement and account record.`;

  const methodConsentText = getConsentText(paymentMethod?.method_type || paymentMethod?.methodType);
  return [
    'AutoPay Authorization',
    `Business: ${BUSINESS_NAME}, ${BUSINESS_EMAIL}, ${BUSINESS_PHONE}.`,
    `Recipient: ${recipient}${customer?.email ? `, ${customer.email}` : ''}${customer?.phone ? `, ${customer.phone}` : ''}.`,
    `Payment method: ${paymentMethodLabel(paymentMethod)}.`,
    `Saved payment authorization: ${methodConsentText}`,
    renewalBlock,
    `Cancellation and revocation: The customer may revoke future automatic payment authorization by replying to a Waves message, emailing ${BUSINESS_EMAIL}, calling ${BUSINESS_PHONE}, or using the customer portal. Revocation applies to future automatic charges and does not cancel amounts already due for completed services.`,
    'Payment data security: Waves stores processor-safe payment tokens and card or bank labels only. Raw card numbers, CVV codes, and bank account numbers are not stored in this contract record.',
    `Electronic signature consent: ${ESIGN_DISCLOSURE}`,
  ].join('\n\n');
}

function mintContractToken() {
  return crypto.randomBytes(CONTRACT_TOKEN_BYTES).toString('base64url');
}

function hashContractToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function contractExpiresAt(now = new Date(), ttlDays = CONTRACT_TOKEN_TTL_DAYS, options = {}) {
  const days = Number(ttlDays);
  const configuredMaxDays = Number(options.maxDays ?? CONTRACT_TOKEN_MAX_TTL_DAYS);
  const maxDays = Number.isFinite(configuredMaxDays) && configuredMaxDays > 0
    ? Math.floor(configuredMaxDays)
    : CONTRACT_TOKEN_MAX_TTL_DAYS;
  const safeDays = Number.isFinite(days) && days > 0 ? Math.min(maxDays, Math.floor(days)) : CONTRACT_TOKEN_TTL_DAYS;
  return new Date(now.getTime() + safeDays * 24 * 60 * 60 * 1000);
}

function documentRequiresSignature(row = {}) {
  if (row.requires_signature_snapshot !== undefined && row.requires_signature_snapshot !== null) {
    return row.requires_signature_snapshot !== false;
  }
  if (row.requiresSignature !== undefined && row.requiresSignature !== null) {
    return row.requiresSignature !== false;
  }
  if (row.requires_signature !== undefined && row.requires_signature !== null) {
    return row.requires_signature !== false;
  }
  if (row.document_template_requires_signature !== undefined && row.document_template_requires_signature !== null) {
    return row.document_template_requires_signature !== false;
  }
  return true;
}

function documentContractExpiresAt(now = new Date(), ttlDays = CONTRACT_TOKEN_TTL_DAYS) {
  return contractExpiresAt(now, ttlDays);
}

function publicContractUrl(token) {
  return `${publicPortalUrl()}/contract/${encodeURIComponent(token)}`;
}

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function serializeContract(row, options = {}) {
  if (!row) return null;
  const includeDocumentSnapshots = options.includeDocumentSnapshots ?? options.includeAudit !== false;
  const isDocumentTemplate = row.contract_type === 'document_template';
  const requiresSignature = isDocumentTemplate ? documentRequiresSignature(row) : true;
  return {
    id: row.id,
    customerId: row.customer_id,
    paymentMethodId: row.payment_method_id,
    createdBy: row.created_by,
    contractType: row.contract_type,
    title: row.title,
    status: row.status,
    recipientName: row.recipient_name,
    recipientEmail: row.recipient_email,
    recipientPhone: row.recipient_phone,
    serviceName: row.service_name,
    renewalDate: row.renewal_date,
    cancellationDeadline: row.cancellation_deadline,
    autoRenewalNoticeRequired: !!row.auto_renewal_notice_required,
    autoRenewalNoticeSentAt: isoDate(row.auto_renewal_notice_sent_at),
    consentTextVersion: row.consent_text_version,
    consentTextSnapshot: row.consent_text_snapshot,
    contractTextSnapshot: row.contract_text_snapshot,
    esignDisclosureSnapshot: row.esign_disclosure_snapshot,
    documentTemplateId: row.document_template_id || null,
    documentTemplateVersionId: row.document_template_version_id || null,
    documentTemplateKey: row.document_template_key || null,
    documentTemplateCategory: row.document_template_category || null,
    documentTemplateDocumentType: row.document_template_document_type || null,
    requiresSignature,
    ...(includeDocumentSnapshots ? {
      documentVariablesSnapshot: row.document_variables_snapshot || {},
      documentRenderSummary: row.document_render_summary || {},
    } : {}),
    shareTokenExpiresAt: isoDate(row.share_token_expires_at),
    sharedAt: isoDate(row.shared_at),
    viewedAt: isoDate(row.viewed_at),
    signedAt: isoDate(row.signed_at),
    signedName: row.signed_name,
    recipientInitials: row.recipient_initials,
    ...(options.includeAudit === false ? {} : {
      signerIp: row.signer_ip,
      signerUserAgent: row.signer_user_agent,
    }),
    cancelledAt: isoDate(row.cancelled_at),
    cancelledReason: row.cancelled_reason,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at),
    paymentMethodLabel: row.payment_method_label || null,
    cardBrand: row.card_brand || null,
    lastFour: row.last_four || row.bank_last_four || null,
    methodType: row.method_type || null,
    bankName: row.bank_name || null,
    signingUrl: options.signingUrl || null,
    events: options.events || undefined,
  };
}

module.exports = {
  BUSINESS_NAME,
  BUSINESS_EMAIL,
  BUSINESS_PHONE,
  CONSENT_TEXT,
  CONSENT_VERSION,
  getConsentText,
  ESIGN_DISCLOSURE,
  CONTRACT_TOKEN_TTL_DAYS,
  buildAutopayContractSnapshot,
  contractExpiresAt,
  documentContractExpiresAt,
  documentRequiresSignature,
  hashContractToken,
  mintContractToken,
  paymentMethodLabel,
  publicContractUrl,
  serializeContract,
  signerName,
};
