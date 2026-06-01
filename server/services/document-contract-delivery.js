const db = require('../models/db');
const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const EmailService = require('./email');
const { wrapEmail, plainText } = require('./email-template');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { toE164 } = require('../utils/phone');
const {
  BUSINESS_PHONE,
  contractExpiresAt,
  hashContractToken,
  mintContractToken,
  publicContractUrl,
  serializeContract,
} = require('./contracts');

const TERMINAL_STATUSES = new Set(['signed', 'cancelled', 'voided']);
const DELIVERY_EVENTS = ['email_sent', 'sms_sent', 'reminder_sent', 'delivery_failed'];
const REMINDER_CLAIM_EVENT = 'reminder_claimed';
const AUTOMATION_BATCH_LIMIT = 50;
const REMINDER_CLAIM_STALE_MS = 2 * 60 * 60 * 1000;

function clean(value) {
  return String(value || '').trim();
}

function escapeHtml(value) {
  return clean(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstName(customer = {}) {
  return clean(customer.first_name || customer.firstName).split(/\s+/)[0] || 'there';
}

function customerName(customer = {}) {
  return clean(`${customer.first_name || ''} ${customer.last_name || ''}`)
    || clean(customer.company_name)
    || clean(customer.email)
    || 'Customer';
}

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function dateLabel(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/New_York',
  });
}

function requestStatus(contract = {}, now = new Date()) {
  const status = String(contract.status || 'draft').toLowerCase();
  if (TERMINAL_STATUSES.has(status)) return status;
  if (contract.share_token_expires_at && new Date(contract.share_token_expires_at) < now) return 'expired';
  return status || 'draft';
}

function statusFilter(query, status) {
  const value = String(status || 'open').toLowerCase();
  const now = new Date();
  if (value === 'all') return query;
  if (value === 'open') {
    return query
      .whereNotIn('cc.status', Array.from(TERMINAL_STATUSES))
      .where((builder) => {
        builder.whereNull('cc.share_token_expires_at').orWhere('cc.share_token_expires_at', '>=', now);
      });
  }
  if (value === 'expired') {
    return query
      .whereNotIn('cc.status', Array.from(TERMINAL_STATUSES))
      .whereNotNull('cc.share_token_expires_at')
      .where('cc.share_token_expires_at', '<', now);
  }
  return query.where('cc.status', value);
}

function requestBaseQuery() {
  return db('customer_contracts as cc')
    .leftJoin('customers as c', 'cc.customer_id', 'c.id')
    .leftJoin('document_templates as dt', 'cc.document_template_id', 'dt.id')
    .where('cc.contract_type', 'document_template')
    .whereNull('c.deleted_at');
}

function requestSelect(query) {
  return query.select(
    'cc.*',
    'c.first_name as customer_first_name',
    'c.last_name as customer_last_name',
    'c.company_name as customer_company_name',
    'c.email as customer_email',
    'c.phone as customer_phone',
    'c.address_line1 as customer_address_line1',
    'c.city as customer_city',
    'c.state as customer_state',
    'c.zip as customer_zip',
    'dt.default_delivery_channel as template_default_delivery_channel',
    'dt.reminder_schedule_days as template_reminder_schedule_days',
    'dt.expire_after_days as template_expire_after_days',
  );
}

function applyRequestSearch(query, search) {
  const term = clean(search);
  if (!term) return query;
  const needle = `%${term}%`;
  return query.where((builder) => {
    builder.whereILike('cc.title', needle)
      .orWhereILike('cc.document_template_key', needle)
      .orWhereILike('cc.recipient_email', needle)
      .orWhereILike('cc.recipient_phone', needle)
      .orWhereILike('c.first_name', needle)
      .orWhereILike('c.last_name', needle)
      .orWhereILike('c.email', needle)
      .orWhereILike('c.phone', needle)
      .orWhereRaw("CONCAT_WS(' ', c.first_name, c.last_name, c.company_name, c.address_line1, c.city, c.state, c.zip) ILIKE ?", [needle]);
  });
}

function customerFromRequestRow(row = {}) {
  return {
    id: row.customer_id,
    name: customerName({
      first_name: row.customer_first_name,
      last_name: row.customer_last_name,
      company_name: row.customer_company_name,
      email: row.customer_email,
    }),
    email: row.customer_email || null,
    phone: row.customer_phone || null,
    address: [
      row.customer_address_line1,
      [row.customer_city, row.customer_state].filter(Boolean).join(', '),
      row.customer_zip,
    ].filter(Boolean).join(' '),
  };
}

async function eventSummaryForContracts(contractIds = []) {
  if (!contractIds.length) return new Map();
  const events = await db('customer_contract_events')
    .whereIn('contract_id', contractIds)
    .whereIn('event_type', DELIVERY_EVENTS)
    .orderBy('created_at', 'asc');
  const byContract = new Map();
  for (const event of events) {
    const summary = byContract.get(event.contract_id) || {
      emailSent: 0,
      smsSent: 0,
      remindersSent: 0,
      deliveryFailures: 0,
      lastDeliveryEventAt: null,
      lastDeliveryEventType: null,
    };
    if (event.event_type === 'email_sent') summary.emailSent += 1;
    if (event.event_type === 'sms_sent') summary.smsSent += 1;
    if (event.event_type === 'reminder_sent') summary.remindersSent += 1;
    if (event.event_type === 'delivery_failed') summary.deliveryFailures += 1;
    summary.lastDeliveryEventAt = isoDate(event.created_at);
    summary.lastDeliveryEventType = event.event_type;
    byContract.set(event.contract_id, summary);
  }
  return byContract;
}

function serializeDocumentRequest(row, summary) {
  return {
    ...serializeContract(row),
    requestStatus: requestStatus(row),
    customer: customerFromRequestRow(row),
    deliverySummary: summary || {
      emailSent: 0,
      smsSent: 0,
      remindersSent: 0,
      deliveryFailures: 0,
      lastDeliveryEventAt: null,
      lastDeliveryEventType: null,
    },
  };
}

async function listDocumentRequests({ status = 'open', search = '', limit = 100, page = 1 } = {}) {
  const safeLimit = Math.max(1, Math.min(250, Number(limit) || 100));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;
  const filteredBase = applyRequestSearch(statusFilter(requestBaseQuery(), status), search);
  const countRow = await filteredBase.clone().countDistinct('cc.id as count').first();
  const rows = await requestSelect(filteredBase.clone())
    .orderBy('cc.created_at', 'desc')
    .limit(safeLimit)
    .offset(offset);
  const summary = await eventSummaryForContracts(rows.map((row) => row.id));
  return {
    requests: rows.map((row) => serializeDocumentRequest(row, summary.get(row.id))),
    total: Number(countRow?.count || 0),
    page: safePage,
    limit: safeLimit,
    totalPages: Math.max(1, Math.ceil(Number(countRow?.count || 0) / safeLimit)),
  };
}

async function documentRequestStats(now = new Date()) {
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const soon = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const [
    openRow,
    viewedRow,
    expiringRow,
    failedRow,
    signedRow,
  ] = await Promise.all([
    requestBaseQuery()
      .whereNotIn('cc.status', Array.from(TERMINAL_STATUSES))
      .where((builder) => {
        builder.whereNull('cc.share_token_expires_at').orWhere('cc.share_token_expires_at', '>=', now);
      })
      .countDistinct('cc.id as count')
      .first(),
    requestBaseQuery()
      .where('cc.status', 'viewed')
      .countDistinct('cc.id as count')
      .first(),
    requestBaseQuery()
      .whereNotIn('cc.status', Array.from(TERMINAL_STATUSES))
      .whereNotNull('cc.share_token_expires_at')
      .where('cc.share_token_expires_at', '>=', now)
      .where('cc.share_token_expires_at', '<=', soon)
      .countDistinct('cc.id as count')
      .first(),
    requestBaseQuery()
      .join('customer_contract_events as ce', 'cc.id', 'ce.contract_id')
      .where('ce.event_type', 'delivery_failed')
      .where('ce.created_at', '>=', weekStart)
      .countDistinct('cc.id as count')
      .first(),
    requestBaseQuery()
      .where('cc.status', 'signed')
      .where('cc.signed_at', '>=', weekStart)
      .countDistinct('cc.id as count')
      .first(),
  ]);
  return {
    open: Number(openRow?.count || 0),
    viewedUnsigned: Number(viewedRow?.count || 0),
    expiringSoon: Number(expiringRow?.count || 0),
    failedDelivery: Number(failedRow?.count || 0),
    signedThisWeek: Number(signedRow?.count || 0),
  };
}

function publicCustomer(row = {}) {
  return {
    id: row.customer_id,
    first_name: row.customer_first_name,
    last_name: row.customer_last_name,
    company_name: row.customer_company_name,
    email: row.customer_email,
    phone: row.customer_phone,
  };
}

async function insertContractEvent(conn, contract, eventType, req = {}, metadata = {}) {
  await conn('customer_contract_events').insert({
    contract_id: contract.id,
    customer_id: contract.customer_id,
    event_type: eventType,
    actor_type: req.actorType || 'admin',
    actor_id: req.technicianId || null,
    ip: req.ip || null,
    user_agent: typeof req.get === 'function' ? req.get('user-agent') || null : null,
    metadata: JSON.stringify(metadata),
  });
}

function deliveryError(message, status = 400, code = 'DOCUMENT_DELIVERY_ERROR') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function recipientFor(contract, customer, channel) {
  if (channel === 'email') return clean(contract.recipient_email || customer.email).toLowerCase();
  if (channel === 'sms') return clean(contract.recipient_phone || customer.phone);
  return '';
}

function trustedPhone(value) {
  const normalized = toE164(value);
  return /^\+\d{8,15}$/.test(normalized || '') ? normalized : null;
}

async function validatePreparedChannel(prepared, channel) {
  const recipient = recipientFor(prepared.contract, prepared.customer, channel);
  if (!recipient) {
    throw deliveryError(channel === 'email' ? 'No recipient email is available for this document request.' : 'No recipient phone is available for this document request.', 400, 'DOCUMENT_RECIPIENT_MISSING');
  }
  if (channel === 'email') {
    const prefs = await db('notification_prefs').where({ customer_id: prepared.contract.customer_id }).first().catch(() => null);
    if (prefs?.email_enabled === false) {
      throw deliveryError('Recipient has email notifications disabled.', 422, 'EMAIL_OPTED_OUT');
    }
  }
  if (channel === 'sms') {
    const recipientPhone = trustedPhone(recipient);
    const customerPhone = trustedPhone(prepared.customer.phone);
    if (!recipientPhone || !customerPhone || recipientPhone !== customerPhone) {
      throw deliveryError('SMS document links can only be sent to the customer phone on file.', 422, 'SMS_RECIPIENT_UNTRUSTED');
    }
  }
  return recipient;
}

async function prepareDelivery(contractId, req, { channel, action }) {
  const token = mintContractToken();
  const signingUrl = publicContractUrl(token);
  const row = await requestSelect(requestBaseQuery().where('cc.id', contractId)).first();

  if (!row) throw deliveryError('Document request not found', 404, 'DOCUMENT_REQUEST_NOT_FOUND');
  if (row.contract_type !== 'document_template') throw deliveryError('Only template-backed document requests can be delivered this way.', 409, 'NOT_DOCUMENT_TEMPLATE');
  if (TERMINAL_STATUSES.has(String(row.status || '').toLowerCase())) {
    throw deliveryError(`Cannot deliver a ${row.status} document request.`, 409, 'DOCUMENT_REQUEST_TERMINAL');
  }
  const expiresAt = contractExpiresAt(new Date(), row.template_expire_after_days || 14);

  return {
    contract: row,
    customer: publicCustomer(row),
    signingUrl,
    tokenHash: hashContractToken(token),
    expiresAt,
    action,
    channel,
  };
}

async function activatePreparedDelivery(prepared, req, { channel, action }, trx) {
  const locked = await trx('customer_contracts')
    .where({ id: prepared.contract.id })
    .forUpdate()
    .first();
  if (!locked) throw deliveryError('Document request not found', 404, 'DOCUMENT_REQUEST_NOT_FOUND');
  if (TERMINAL_STATUSES.has(String(locked.status || '').toLowerCase())) {
    throw deliveryError(`Cannot deliver a ${locked.status} document request.`, 409, 'DOCUMENT_REQUEST_TERMINAL');
  }
  const sharedAt = new Date();
  const previousDeliveryState = {
    status: locked.status,
    share_token_hash: locked.share_token_hash,
    share_token_expires_at: locked.share_token_expires_at,
    shared_at: locked.shared_at,
  };
  const nextStatus = String(locked.status || '').toLowerCase() === 'viewed' ? 'viewed' : 'sent';
  const existingExpiresAt = locked.share_token_expires_at ? new Date(locked.share_token_expires_at) : null;
  const hasLiveExistingWindow = existingExpiresAt && !Number.isNaN(existingExpiresAt.getTime()) && existingExpiresAt > sharedAt;
  const preservesExistingWindow = action === 'reminder' && hasLiveExistingWindow;
  const nextExpiresAt = preservesExistingWindow ? locked.share_token_expires_at : prepared.expiresAt;
  const nextSharedAt = preservesExistingWindow && locked.shared_at ? locked.shared_at : sharedAt;
  await trx('customer_contracts').where({ id: locked.id }).update({
    status: nextStatus,
    share_token_hash: prepared.tokenHash,
    share_token_expires_at: nextExpiresAt,
    shared_at: nextSharedAt,
    updated_at: sharedAt,
  });
  const updated = {
    ...prepared.contract,
    ...locked,
    status: nextStatus,
    share_token_hash: prepared.tokenHash,
    share_token_expires_at: nextExpiresAt,
    shared_at: nextSharedAt,
    updated_at: sharedAt,
  };
  await insertContractEvent(trx, updated, 'share_link_created', req, {
    expiresAt: new Date(nextExpiresAt).toISOString(),
    channel,
    action,
    deliveryGenerated: true,
    preservedExistingWindow: !!preservesExistingWindow,
  });
  return { ...prepared, contract: updated, previousDeliveryState };
}

async function restoreActivatedDelivery(activated) {
  const previous = activated.previousDeliveryState;
  if (!previous) return activated.contract;
  const restoredAt = new Date();
  const restored = {
    ...activated.contract,
    status: previous.status,
    share_token_hash: previous.share_token_hash,
    share_token_expires_at: previous.share_token_expires_at,
    shared_at: previous.shared_at,
    updated_at: restoredAt,
  };
  const updated = await db('customer_contracts')
    .where({ id: activated.contract.id, share_token_hash: activated.tokenHash })
    .update({
      status: previous.status,
      share_token_hash: previous.share_token_hash,
      share_token_expires_at: previous.share_token_expires_at,
      shared_at: previous.shared_at,
      updated_at: restoredAt,
    });
  return updated === 1 ? restored : activated.contract;
}

async function sendPreparedChannel(prepared, req, { channel, action, recipient }) {
  const safeRecipient = recipient || await validatePreparedChannel(prepared, channel);
  return channel === 'email'
    ? sendEmailDelivery({ ...prepared, recipient: safeRecipient })
    : sendSmsDelivery({ ...prepared, recipient: safeRecipient });
}

function emailPayload({ contract, customer, signingUrl, action }) {
  const reminder = action === 'reminder';
  const title = clean(contract.title) || 'Waves document';
  const titleHtml = escapeHtml(title);
  const subject = reminder ? `Reminder: ${title} from Waves` : `${title} from Waves`;
  const heading = reminder ? 'Document reminder' : 'Document ready for review';
  const intro = `Hi ${escapeHtml(firstName(customer))}, ${reminder ? 'this is a reminder that ' : ''}Waves has a document ready for your review and electronic signature.`;
  const lines = [
    ['Document', escapeHtml(title), true],
    ['Recipient', escapeHtml(clean(contract.recipient_name) || customerName(customer))],
    contract.share_token_expires_at ? ['Link expires', escapeHtml(dateLabel(contract.share_token_expires_at))] : null,
  ].filter(Boolean);
  const html = wrapEmail({
    preheader: reminder ? `${titleHtml} is still waiting for review.` : `${titleHtml} is ready to sign.`,
    heading,
    intro,
    lines,
    ctaHref: signingUrl,
    ctaLabel: 'Review and sign',
    footerNote: `Questions? Reply to this email or call ${escapeHtml(BUSINESS_PHONE)}.`,
  });
  const text = plainText([
    `Hi ${firstName(customer)},`,
    '',
    reminder
      ? `Reminder from Waves: ${title} is still waiting for review and signature.`
      : `Waves has a document ready for your review and electronic signature: ${title}.`,
    '',
    `Review and sign: ${signingUrl}`,
    '',
    `Questions? Reply to this email or call ${BUSINESS_PHONE}.`,
  ]);
  return { subject, heading, html, text };
}

async function sendEmailDelivery({ contract, customer, recipient, signingUrl, action }) {
  const payload = emailPayload({ contract, customer, signingUrl, action });
  if (sendgrid.isConfigured()) {
    const result = await sendgrid.sendOne({
      to: recipient,
      fromEmail: 'contact@wavespestcontrol.com',
      fromName: 'Waves Pest Control',
      replyTo: 'contact@wavespestcontrol.com',
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
      categories: ['document_request', action === 'reminder' ? 'document_reminder' : 'document_send'],
      asmGroupId: sendgrid.serviceGroupId(),
    });
    return { ok: true, provider: 'sendgrid', providerMessageId: result.messageId || null };
  }

  const fallback = await EmailService.send({
    to: recipient,
    subject: payload.subject,
    heading: payload.heading,
    body: `<p>${escapeHtml(payload.text).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`,
    ctaUrl: signingUrl,
    ctaLabel: 'Review and sign',
  });
  if (!fallback.ok) throw deliveryError(fallback.error || 'Email could not be sent.', 422, 'EMAIL_DELIVERY_FAILED');
  return { ok: true, provider: 'smtp_fallback', providerMessageId: null };
}

function smsBody({ contract, customer, signingUrl, action }) {
  const title = clean(contract.title) || 'Waves document';
  const prefix = action === 'reminder'
    ? `Hi ${firstName(customer)}, reminder from Waves: ${title} is still waiting for review and signature.`
    : `Hi ${firstName(customer)}, Waves has a document ready for your review and signature: ${title}.`;
  return `${prefix} ${signingUrl} Reply with any questions.`;
}

async function sendSmsDelivery({ contract, customer, recipient, signingUrl, action }) {
  const result = await sendCustomerMessage({
    to: recipient,
    body: smsBody({ contract, customer, signingUrl, action }),
    channel: 'sms',
    audience: 'customer',
    purpose: 'document_request',
    customerId: contract.customer_id,
    identityTrustLevel: 'phone_matches_customer',
    entryPoint: action === 'reminder' ? 'document_request_manual_reminder' : 'document_request_manual_send',
    metadata: {
      original_message_type: action === 'reminder' ? 'document_request_reminder' : 'document_request',
      contractId: contract.id,
      documentTemplateKey: contract.document_template_key || undefined,
      action,
    },
  });
  if (!result.sent) {
    const err = deliveryError(result.reason || result.code || 'SMS could not be sent.', 422, result.code || 'SMS_DELIVERY_FAILED');
    err.deliveryResult = result;
    throw err;
  }
  return {
    ok: true,
    provider: 'twilio',
    providerMessageId: result.providerMessageId || null,
    auditLogId: result.auditLogId || null,
    segmentCount: result.segmentCount,
  };
}

async function recordDeliveryFailure(contract, req, { channel, action, err }, conn = db) {
  await insertContractEvent(conn, contract, 'delivery_failed', req, {
    channel,
    action,
    code: err.code || 'DELIVERY_FAILED',
    reason: err.message,
    providerResult: err.deliveryResult || null,
  });
}

async function recordDeliverySuccess(contract, req, { channel, action, recipient, result, reminderOffsetDays = null }, conn = db) {
  const metadata = {
    channel,
    action,
    recipient,
    reminderOffsetDays,
    provider: result.provider,
    providerMessageId: result.providerMessageId || null,
    auditLogId: result.auditLogId || null,
    segmentCount: result.segmentCount || null,
  };
  await insertContractEvent(conn, contract, channel === 'email' ? 'email_sent' : 'sms_sent', req, metadata);
  if (action === 'reminder') {
    await insertContractEvent(conn, contract, 'reminder_sent', req, metadata);
  }
}

async function safeRecordDeliveryFailure(contract, req, options) {
  try {
    await recordDeliveryFailure(contract, req, options);
  } catch (err) {
    logger.warn(`[document-delivery] delivery failure event failed for contract ${contract.id}: ${err.message}`);
  }
}

async function safeRecordDeliverySuccess(contract, req, options) {
  try {
    await recordDeliverySuccess(contract, req, options);
  } catch (err) {
    logger.warn(`[document-delivery] delivery success event failed for contract ${contract.id}: ${err.message}`);
  }
}

async function activateCommittedDelivery(prepared, req, options) {
  return db.transaction((trx) => activatePreparedDelivery(prepared, req, options, trx));
}

async function deliverDocumentRequest(contractId, req = {}, { channel, action = 'send' } = {}) {
  if (!['email', 'sms'].includes(channel)) throw deliveryError('channel must be email or sms', 400, 'INVALID_CHANNEL');
  if (!['send', 'reminder'].includes(action)) throw deliveryError('action must be send or reminder', 400, 'INVALID_ACTION');

  const prepared = await prepareDelivery(contractId, req, { channel, action });
  let recipient;
  try {
    recipient = await validatePreparedChannel(prepared, channel);
  } catch (err) {
    await safeRecordDeliveryFailure(prepared.contract, req, { channel, action, err });
    logger.warn(`[document-delivery] ${channel} ${action} failed for contract ${contractId}: ${err.message}`);
    return {
      ok: false,
      error: err.message,
      code: err.code || 'DELIVERY_FAILED',
      signingUrl: null,
      contract: serializeContract(prepared.contract),
      delivery: {
        channel,
        action,
        status: 'failed',
      },
    };
  }

  const activated = await activateCommittedDelivery(prepared, req, { channel, action });
  try {
    const result = await sendPreparedChannel(activated, req, { channel, action, recipient });
    await safeRecordDeliverySuccess(activated.contract, req, {
      channel,
      action,
      recipient,
      result,
      reminderOffsetDays: req?.reminderOffsetDays ?? null,
    });

    return {
      ok: true,
      signingUrl: activated.signingUrl,
      contract: serializeContract(activated.contract, { signingUrl: activated.signingUrl }),
      delivery: {
        channel,
        action,
        status: 'sent',
        provider: result.provider,
        providerMessageId: result.providerMessageId || null,
      },
    };
  } catch (err) {
    await safeRecordDeliveryFailure(activated.contract, req, { channel, action, err });
    logger.warn(`[document-delivery] ${channel} ${action} failed for contract ${contractId}: ${err.message}`);
    const restored = await restoreActivatedDelivery(activated);
    return {
      ok: false,
      error: err.message,
      code: err.code || 'DELIVERY_FAILED',
      signingUrl: null,
      contract: serializeContract(restored),
      delivery: {
        channel,
        action,
        status: 'failed',
      },
    };
  }
}

async function deliverDocumentRequestChannels(contractId, req = {}, { channels = ['email'], action = 'send' } = {}) {
  const safeChannels = [...new Set(channels)].filter(channel => ['email', 'sms'].includes(channel));
  if (!safeChannels.length) throw deliveryError('channels must include email or sms', 400, 'INVALID_CHANNEL');
  if (!['send', 'reminder'].includes(action)) throw deliveryError('action must be send or reminder', 400, 'INVALID_ACTION');
  const prepared = await prepareDelivery(contractId, req, { channel: safeChannels[0], action });
  const deliveries = [];
  for (const channel of safeChannels) {
    try {
      const recipient = await validatePreparedChannel(prepared, channel);
      deliveries.push({ channel, recipient, valid: true });
    } catch (err) {
      await safeRecordDeliveryFailure(prepared.contract, req, { channel, action, err });
      logger.warn(`[document-delivery] ${channel} ${action} failed for contract ${contractId}: ${err.message}`);
      deliveries.push({ channel, ok: false, error: err.message, code: err.code || 'DELIVERY_FAILED' });
    }
  }
  const validDeliveries = deliveries.filter(delivery => delivery.valid);
  if (!validDeliveries.length) {
    return {
      ok: false,
      signingUrl: null,
      contract: serializeContract(prepared.contract),
      deliveries: deliveries.map(({ valid, recipient, ...delivery }) => delivery),
    };
  }

  const activated = await activateCommittedDelivery(prepared, req, { channel: validDeliveries[0].channel, action });
  for (const delivery of validDeliveries) {
    try {
      const result = await sendPreparedChannel(activated, req, {
        channel: delivery.channel,
        action,
        recipient: delivery.recipient,
      });
      await safeRecordDeliverySuccess(activated.contract, req, {
        channel: delivery.channel,
        action,
        recipient: delivery.recipient,
        result,
        reminderOffsetDays: req?.reminderOffsetDays ?? null,
      });
      Object.assign(delivery, { ok: true, provider: result.provider, providerMessageId: result.providerMessageId || null });
    } catch (err) {
      await safeRecordDeliveryFailure(activated.contract, req, { channel: delivery.channel, action, err });
      logger.warn(`[document-delivery] ${delivery.channel} ${action} failed for contract ${contractId}: ${err.message}`);
      Object.assign(delivery, { ok: false, error: err.message, code: err.code || 'DELIVERY_FAILED' });
    }
  }
  const ok = validDeliveries.some(delivery => delivery.ok);
  const responseContract = ok ? activated.contract : await restoreActivatedDelivery(activated);
  return {
    ok,
    signingUrl: ok ? activated.signingUrl : null,
    contract: serializeContract(responseContract, ok ? { signingUrl: activated.signingUrl } : undefined),
    deliveries: deliveries.map(({ valid, recipient, ...delivery }) => delivery),
  };
}

async function expireDocumentRequests({ now = new Date(), limit = AUTOMATION_BATCH_LIMIT } = {}) {
  const rows = await db('customer_contracts')
    .where({ contract_type: 'document_template' })
    .whereNotIn('status', ['signed', 'cancelled', 'voided', 'expired'])
    .whereNotNull('share_token_expires_at')
    .where('share_token_expires_at', '<', now)
    .orderBy('share_token_expires_at', 'asc')
    .limit(Math.max(1, Math.min(250, Number(limit) || AUTOMATION_BATCH_LIMIT)));
  let expired = 0;
  for (const row of rows) {
    await db.transaction(async (trx) => {
      const locked = await trx('customer_contracts').where({ id: row.id }).forUpdate().first();
      if (!locked || ['signed', 'cancelled', 'voided', 'expired'].includes(String(locked.status || '').toLowerCase())) return;
      if (!locked.share_token_expires_at || new Date(locked.share_token_expires_at) >= now) return;
      const existing = await trx('customer_contract_events')
        .where({ contract_id: locked.id, event_type: 'expired' })
        .first('id');
      await trx('customer_contracts').where({ id: locked.id }).update({
        status: 'expired',
        updated_at: now,
      });
      if (!existing) {
        await trx('customer_contract_events').insert({
          contract_id: locked.id,
          customer_id: locked.customer_id,
          event_type: 'expired',
          actor_type: 'system',
          metadata: JSON.stringify({ expiredAt: now.toISOString(), shareTokenExpiresAt: isoDate(locked.share_token_expires_at) }),
          created_at: now,
        });
      }
      expired += 1;
    });
  }
  return { expired };
}

function parseReminderSchedule(value) {
  const raw = Array.isArray(value) ? value : (() => {
    try { return JSON.parse(value || '[]'); } catch { return []; }
  })();
  return [...new Set((raw || [])
    .map(item => Number(item))
    .filter(number => Number.isInteger(number) && number !== 0 && number >= -30 && number <= 365))]
    .sort((a, b) => {
      if (a < 0 && b >= 0) return 1;
      if (a >= 0 && b < 0) return -1;
      return Math.abs(a) - Math.abs(b);
    });
}

function channelsFor(value) {
  const channel = clean(value || 'email').toLowerCase();
  if (channel === 'both') return ['email', 'sms'];
  if (channel === 'sms') return ['sms'];
  return ['email'];
}

function dueAtForOffset(contract, offsetDays) {
  const anchorValue = offsetDays > 0
    ? (contract.shared_at || contract.created_at)
    : contract.share_token_expires_at;
  if (!anchorValue) return null;
  const anchor = new Date(anchorValue);
  if (Number.isNaN(anchor.getTime())) return null;
  return new Date(anchor.getTime() + offsetDays * 24 * 60 * 60 * 1000);
}

async function reminderEventExists(contractId, offsetDays) {
  const row = await db('customer_contract_events')
    .where({ contract_id: contractId, event_type: 'reminder_sent' })
    .whereRaw("COALESCE(metadata->>'reminderOffsetDays', '') = ?", [String(offsetDays)])
    .first('id');
  return !!row;
}

function isUniqueViolation(err) {
  return err?.code === '23505';
}

async function claimReminderOffset(contract, offsetDays, req, now) {
  const insertClaim = () => insertContractEvent(db, contract, REMINDER_CLAIM_EVENT, req, {
    reminderOffsetDays: offsetDays,
    claimedAt: now.toISOString(),
  });
  try {
    await insertClaim();
    return true;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await db('customer_contract_events')
      .where({ contract_id: contract.id, event_type: REMINDER_CLAIM_EVENT })
      .whereRaw("COALESCE(metadata->>'reminderOffsetDays', '') = ?", [String(offsetDays)])
      .first('id', 'created_at');
    const createdAt = existing?.created_at ? new Date(existing.created_at) : null;
    const stale = createdAt && !Number.isNaN(createdAt.getTime()) && now.getTime() - createdAt.getTime() > REMINDER_CLAIM_STALE_MS;
    if (!stale || await reminderEventExists(contract.id, offsetDays)) return false;
    await db('customer_contract_events').where({ id: existing.id }).del();
    try {
      await insertClaim();
      return true;
    } catch (retryErr) {
      if (isUniqueViolation(retryErr)) return false;
      throw retryErr;
    }
  }
}

async function releaseReminderClaim(contractId, offsetDays) {
  try {
    await db('customer_contract_events')
      .where({ contract_id: contractId, event_type: REMINDER_CLAIM_EVENT })
      .whereRaw("COALESCE(metadata->>'reminderOffsetDays', '') = ?", [String(offsetDays)])
      .del();
  } catch (err) {
    logger.warn(`[document-delivery] reminder claim release failed for contract ${contractId}: ${err.message}`);
  }
}

async function hasPriorDelivery(contractId) {
  const row = await db('customer_contract_events')
    .where({ contract_id: contractId })
    .whereIn('event_type', ['email_sent', 'sms_sent'])
    .first('id');
  return !!row;
}

async function processDueDocumentReminders({ now = new Date(), limit = 25 } = {}) {
  const sendLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const pageSize = Math.max(sendLimit, 25);
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let offset = 0;

  while (sent + failed < sendLimit) {
    const rows = await requestSelect(requestBaseQuery())
      .whereIn('cc.status', ['sent', 'viewed'])
      .where((builder) => {
        builder.whereNull('cc.share_token_expires_at').orWhere('cc.share_token_expires_at', '>', now);
      })
      .orderBy('cc.created_at', 'asc')
      .limit(pageSize)
      .offset(offset);
    if (!rows.length) break;

    for (const contract of rows) {
      if (sent + failed >= sendLimit) break;
      const schedule = parseReminderSchedule(contract.template_reminder_schedule_days);
      if (!schedule.length) {
        skipped += 1;
        continue;
      }
      if (!(await hasPriorDelivery(contract.id))) {
        skipped += 1;
        continue;
      }
      let dueOffset = null;
      let reminderReq = null;
      for (const offsetDays of schedule) {
        const dueAt = dueAtForOffset(contract, offsetDays);
        if (dueAt && dueAt <= now && !(await reminderEventExists(contract.id, offsetDays))) {
          const candidateReq = {
            actorType: 'system',
            reminderOffsetDays: offsetDays,
            ip: null,
            get: () => null,
          };
          const claimed = await claimReminderOffset(contract, offsetDays, candidateReq, now);
          if (claimed) {
            dueOffset = offsetDays;
            reminderReq = candidateReq;
            break;
          }
        }
      }
      if (!dueOffset) {
        skipped += 1;
        continue;
      }
      const reminderChannels = channelsFor(contract.template_default_delivery_channel);
      let result;
      try {
        result = await deliverDocumentRequestChannels(contract.id, reminderReq, {
          channels: reminderChannels,
          action: 'reminder',
        });
      } catch (err) {
        await releaseReminderClaim(contract.id, dueOffset);
        logger.warn(`[document-delivery] reminder failed for contract ${contract.id}: ${err.message}`);
        failed += reminderChannels.length;
        continue;
      }
      if (!result.deliveries.some(delivery => delivery.ok)) {
        await releaseReminderClaim(contract.id, dueOffset);
      }
      sent += result.deliveries.filter(delivery => delivery.ok).length;
      failed += result.deliveries.filter(delivery => !delivery.ok).length;
    }

    if (rows.length < pageSize) break;
    offset += rows.length;
  }

  return { sent, failed, skipped };
}

async function processDocumentWorkflow(options = {}) {
  const expired = await expireDocumentRequests(options);
  const reminders = await processDueDocumentReminders(options);
  return { expired: expired.expired, reminders };
}

module.exports = {
  listDocumentRequests,
  documentRequestStats,
  deliverDocumentRequest,
  deliverDocumentRequestChannels,
  expireDocumentRequests,
  processDueDocumentReminders,
  processDocumentWorkflow,
  requestStatus,
  _internals: {
    emailPayload,
    parseReminderSchedule,
    smsBody,
    requestStatus,
  },
};
