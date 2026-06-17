const db = require('../models/db');
const EmailTemplates = require('./email-template-library');
const logger = require('./logger');

const FINAL_STATUSES = new Set(['sent', 'blocked', 'skipped', 'failed']);
const RUNNABLE_STATUSES = ['queued', 'scheduled', 'retry_scheduled'];
const DEFAULT_RETRY_POLICY = { max_attempts: 2, backoff_minutes: [15, 60] };
const RUNNING_STALE_AFTER_MS = 30 * 60 * 1000;

const TRIGGER_MAPPINGS = {
  'estimate.sent': {
    entityType: 'estimate',
    entityIdKeys: ['estimate_id', 'id'],
    recipientType: 'lead',
    recipientIdKeys: ['customer_id', 'lead_id'],
    emailKeys: ['customer_email', 'email'],
  },
  'estimate.viewed': {
    entityType: 'estimate',
    entityIdKeys: ['estimate_id', 'id'],
    recipientType: 'lead',
    recipientIdKeys: ['customer_id', 'lead_id'],
    emailKeys: ['customer_email', 'email'],
  },
  'estimate.expiring_soon': {
    entityType: 'estimate',
    entityIdKeys: ['estimate_id', 'id'],
    recipientType: 'lead',
    recipientIdKeys: ['customer_id', 'lead_id'],
    emailKeys: ['customer_email', 'email'],
  },
  'estimate.auto_renewed': {
    entityType: 'estimate',
    entityIdKeys: ['estimate_id', 'id'],
    recipientType: 'lead',
    recipientIdKeys: ['customer_id', 'lead_id'],
    emailKeys: ['customer_email', 'email'],
  },
  'invoice.sent': {
    entityType: 'invoice',
    entityIdKeys: ['invoice_id', 'id'],
    recipientType: 'customer',
    recipientIdKeys: ['customer_id'],
    emailKeys: ['customer_email', 'email'],
  },
  'invoice.paid': {
    entityType: 'invoice',
    entityIdKeys: ['invoice_id', 'id'],
    recipientType: 'customer',
    recipientIdKeys: ['customer_id'],
    emailKeys: ['customer_email', 'email'],
  },
  'payment.failed': {
    entityType: 'payment',
    entityIdKeys: ['payment_id', 'id'],
    recipientType: 'customer',
    recipientIdKeys: ['customer_id'],
    emailKeys: ['customer_email', 'email'],
  },
  'service_report.ready': {
    entityType: 'service_record',
    entityIdKeys: ['service_record_id', 'id'],
    recipientType: 'customer',
    recipientIdKeys: ['customer_id'],
    emailKeys: ['customer_email', 'email'],
  },
  'project_report.ready': {
    entityType: 'project',
    entityIdKeys: ['project_id', 'id'],
    recipientType: 'customer',
    recipientIdKeys: ['customer_id'],
    emailKeys: ['customer_email', 'email'],
  },
  'appointment.booked': {
    entityType: 'scheduled_service',
    entityIdKeys: ['scheduled_service_id', 'appointment_id', 'id'],
    recipientType: 'customer',
    recipientIdKeys: ['customer_id'],
    emailKeys: ['customer_email', 'email'],
  },
  'customer.recurring_created': {
    entityType: 'customer',
    entityIdKeys: ['customer_id', 'id'],
    recipientType: 'customer',
    recipientIdKeys: ['customer_id', 'id'],
    emailKeys: ['customer_email', 'email'],
  },
};

function cleanString(value, fallback = '') {
  if (value == null) return fallback;
  return String(value).trim();
}

function asObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return value.split(',').map((v) => v.trim()).filter(Boolean);
    }
  }
  return [];
}

function firstDefined(source, keys = []) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function normalizeStatus(value) {
  return cleanString(value).toLowerCase();
}

function boolValue(value) {
  if (value === true || value === false) return value;
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(v)) return true;
  if (['false', '0', 'no'].includes(v)) return false;
  return null;
}

function estimateViewedValue(payload = {}) {
  if (payload.viewed_at) return true;
  if (normalizeStatus(payload.estimate_status || payload.status) === 'viewed') return true;
  const value = boolValue(payload.estimate_viewed);
  return value == null ? false : value;
}

function eventSeen(payload, eventKey) {
  const events = asArray(payload.events || payload.event_keys || payload.stop_events);
  return events.includes(eventKey);
}

function exitReasonFor(exitConditions, payload = {}) {
  const stopIf = asArray(exitConditions.stop_if || exitConditions.stopIf);
  if (!stopIf.length) return null;

  for (const eventKey of stopIf) {
    if (eventSeen(payload, eventKey)) return `exit event already present: ${eventKey}`;
  }

  const estimateStatus = normalizeStatus(payload.estimate_status || payload.status);
  if (stopIf.includes('estimate.accepted') && estimateStatus === 'accepted') return 'estimate already accepted';
  if (stopIf.includes('estimate.archived') && ['archived', 'cancelled', 'declined'].includes(estimateStatus)) return `estimate status is ${estimateStatus}`;
  if (stopIf.includes('estimate.expired') && estimateStatus === 'expired') return 'estimate already expired';
  if (stopIf.includes('estimate.viewed') && estimateViewedValue(payload)) return 'estimate already viewed';

  const invoiceStatus = normalizeStatus(payload.invoice_status || payload.status);
  if (stopIf.includes('invoice.paid') && invoiceStatus === 'paid') return 'invoice already paid';
  if (stopIf.includes('invoice.voided') && ['void', 'voided', 'cancelled'].includes(invoiceStatus)) return `invoice status is ${invoiceStatus}`;

  if (stopIf.includes('payment_method.updated') && (payload.payment_method_updated_at || boolValue(payload.payment_method_updated) === true)) {
    return 'payment method already updated';
  }

  const appointmentStatus = normalizeStatus(payload.appointment_status || payload.service_status || payload.status);
  if (stopIf.includes('appointment.cancelled') && appointmentStatus === 'cancelled') return 'appointment already cancelled';

  const customerStatus = normalizeStatus(payload.customer_status || payload.status);
  if (stopIf.includes('customer.cancelled') && (customerStatus === 'cancelled' || payload.active === false)) return 'customer cancelled';

  return null;
}

function conditionFailureFor(conditions, payload = {}, now = new Date()) {
  const estimateStatusList = asArray(conditions.estimate_status);
  if (estimateStatusList.length) {
    const status = normalizeStatus(payload.estimate_status || payload.status);
    if (!status || !estimateStatusList.map(normalizeStatus).includes(status)) {
      return `estimate_status must be one of ${estimateStatusList.join(', ')}`;
    }
  }

  if (conditions.estimate_viewed !== undefined) {
    const actual = estimateViewedValue(payload);
    if (actual !== !!conditions.estimate_viewed) return `estimate_viewed must be ${!!conditions.estimate_viewed}`;
  }

  if (conditions.renewal_count_gt !== undefined) {
    const value = Number(payload.renewal_count || 0);
    if (!Number.isFinite(value) || value <= Number(conditions.renewal_count_gt)) {
      return `renewal_count must be greater than ${conditions.renewal_count_gt}`;
    }
  }


  if (conditions.expires_within_days !== undefined) {
    const raw = payload.expires_at || payload.new_expires_at;
    const expiresAt = raw ? new Date(raw) : null;
    if (!expiresAt || Number.isNaN(expiresAt.getTime())) return 'expires_at is required';
    const end = new Date(now.getTime() + Number(conditions.expires_within_days) * 24 * 60 * 60 * 1000);
    if (expiresAt < now || expiresAt > end) return `expires_at must be within ${conditions.expires_within_days} day(s)`;
  }

  const invoiceStatusList = asArray(conditions.invoice_status);
  if (invoiceStatusList.length) {
    const status = normalizeStatus(payload.invoice_status || payload.status);
    if (!status || !invoiceStatusList.map(normalizeStatus).includes(status)) {
      return `invoice_status must be one of ${invoiceStatusList.join(', ')}`;
    }
  }

  const paymentStatusList = asArray(conditions.payment_status);
  if (paymentStatusList.length) {
    const status = normalizeStatus(payload.payment_status || payload.status);
    if (!status || !paymentStatusList.map(normalizeStatus).includes(status)) {
      return `payment_status must be one of ${paymentStatusList.join(', ')}`;
    }
  }

  const serviceStatusList = asArray(conditions.service_status);
  if (serviceStatusList.length) {
    const status = normalizeStatus(payload.service_status || payload.status);
    if (!status || !serviceStatusList.map(normalizeStatus).includes(status)) {
      return `service_status must be one of ${serviceStatusList.join(', ')}`;
    }
  }

  const reportStatusList = asArray(conditions.report_status);
  if (reportStatusList.length) {
    const status = normalizeStatus(payload.report_status || payload.status);
    if (!status || !reportStatusList.map(normalizeStatus).includes(status)) {
      return `report_status must be one of ${reportStatusList.join(', ')}`;
    }
  }

  const serviceTypeContains = asArray(conditions.service_type_contains);
  if (serviceTypeContains.length) {
    const serviceType = normalizeStatus(payload.service_type || payload.service_label || payload.name);
    if (!serviceTypeContains.some((needle) => serviceType.includes(normalizeStatus(needle)))) {
      return `service_type must include ${serviceTypeContains.join(' or ')}`;
    }
  }

  const customerTypeList = asArray(conditions.customer_type);
  if (customerTypeList.length) {
    const customerType = normalizeStatus(payload.customer_type || payload.type || (payload.recurring ? 'recurring' : ''));
    if (!customerType || !customerTypeList.map(normalizeStatus).includes(customerType)) {
      return `customer_type must be one of ${customerTypeList.join(', ')}`;
    }
  }

  return null;
}

function retryPolicyFor(automation) {
  const policy = asObject(automation.retry_policy, DEFAULT_RETRY_POLICY);
  const maxAttempts = Math.max(1, Math.min(Number(policy.max_attempts || DEFAULT_RETRY_POLICY.max_attempts), 8));
  const backoffMinutes = asArray(policy.backoff_minutes || DEFAULT_RETRY_POLICY.backoff_minutes)
    .map((n) => Math.max(1, Number(n)))
    .filter((n) => Number.isFinite(n));
  return { maxAttempts, backoffMinutes: backoffMinutes.length ? backoffMinutes : DEFAULT_RETRY_POLICY.backoff_minutes };
}

function staleRunningCutoff(now = new Date()) {
  return new Date(now.getTime() - RUNNING_STALE_AFTER_MS);
}

function contextFor({ triggerEventKey, triggerEventId, entityType, entityId, payload, recipient, automation }) {
  const context = {
    ...(payload || {}),
    trigger_event_key: triggerEventKey,
    trigger_event_id: triggerEventId || '',
    automation_key: automation.automation_key,
    template_key: automation.template_key,
    // Do NOT add template_version_id here — it would reset dedup on every template publish. Version stays in the run row + send snapshot.
    recipient_email: recipient.email,
    recipient_type: recipient.type || automation.audience || '',
    recipient_id: recipient.id || '',
  };
  if (entityType) context.entity_type = entityType;
  if (entityId) {
    context.entity_id = entityId;
    context[`${entityType}_id`] = context[`${entityType}_id`] || entityId;
  }
  return context;
}

function safeIdempotencyValue(value) {
  return String(value)
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._:-]/g, '_');
}

function renderIdempotencyKey(template, context) {
  const missing = new Set();
  const rendered = cleanString(template).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, key) => {
    const value = context[key];
    if (value === undefined || value === null || String(value).trim() === '') {
      missing.add(key);
      return '';
    }
    return safeIdempotencyValue(value);
  });
  if (missing.size) {
    const err = new Error(`idempotency key missing variable(s): ${[...missing].join(', ')}`);
    err.status = 400;
    throw err;
  }
  if (!/^[a-zA-Z0-9._:-]{8,260}$/.test(rendered)) {
    const err = new Error('idempotency key must be 8-260 chars and contain only letters, numbers, dot, underscore, colon, or hyphen');
    err.status = 400;
    throw err;
  }
  return rendered;
}

function recipientFor(triggerEventKey, input = {}, automation = {}) {
  const payload = input.payload || {};
  const mapping = TRIGGER_MAPPINGS[triggerEventKey] || {};
  const rawRecipient = input.recipient || {};
  const email = cleanString(rawRecipient.email || firstDefined(payload, mapping.emailKeys) || payload.recipient_email).toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    const err = new Error('recipient email is required for automation execution');
    err.status = 400;
    throw err;
  }
  return {
    email,
    type: cleanString(rawRecipient.type || rawRecipient.recipient_type || mapping.recipientType || automation.audience || 'customer'),
    id: cleanString(rawRecipient.id || rawRecipient.recipient_id || firstDefined(payload, mapping.recipientIdKeys), ''),
  };
}

function entityFor(triggerEventKey, input = {}) {
  const payload = input.payload || {};
  const mapping = TRIGGER_MAPPINGS[triggerEventKey] || {};
  const entityType = cleanString(input.entityType || input.entity_type || mapping.entityType, '');
  const entityId = cleanString(input.entityId || input.entity_id || firstDefined(payload, mapping.entityIdKeys), '');
  return { entityType, entityId };
}

async function loadAutomations(triggerEventKey, automationKey) {
  let query = db('email_template_automations as a')
    .leftJoin('email_templates as t', 't.template_key', 'a.template_key')
    .leftJoin('email_template_versions as v', 'v.id', 't.active_version_id')
    .select(
      'a.*',
      't.active_version_id as active_version_id',
      't.status as template_status',
      'v.id as template_version_id',
      'v.version_number as active_version_number',
    )
    .where('a.trigger_event_key', triggerEventKey)
    .where('a.status', 'active');
  if (automationKey) query = query.where('a.automation_key', automationKey);
  return query.orderBy('a.delay_minutes', 'asc').orderBy('a.automation_key', 'asc');
}

async function logRunEvent(runId, eventType, message, metadata = {}) {
  if (!runId) return null;
  try {
    const [event] = await db('email_template_automation_run_events').insert({
      run_id: runId,
      event_type: eventType,
      message: message || null,
      metadata: JSON.stringify(metadata || {}),
    }).returning('*');
    return event || null;
  } catch (err) {
    logger.warn(`[email-template-automation] failed to log ${eventType} for run ${runId}: ${err.message}`);
    return null;
  }
}

async function createRun({ automation, triggerEventKey, triggerEventId, entityType, entityId, recipient, payload, context, idempotencyKey, runAfter, status, exitReason, retryPolicy }) {
  const existing = await db('email_template_automation_runs').where({ idempotency_key: idempotencyKey }).first();
  if (existing) {
    await logRunEvent(existing.id, 'deduped', 'Automation trigger replay ignored by idempotency key', {
      trigger_event_key: triggerEventKey,
      trigger_event_id: triggerEventId || null,
    });
    return { run: existing, deduped: true };
  }

  let run;
  try {
    [run] = await db('email_template_automation_runs').insert({
      automation_id: automation.id || null,
      automation_key: automation.automation_key,
      trigger_event_key: triggerEventKey,
      trigger_event_id: triggerEventId || null,
      entity_type: entityType || null,
      entity_id: entityId || null,
      template_key: automation.template_key,
      template_version_id: automation.active_version_id || automation.template_version_id || null,
      recipient_type: recipient.type || null,
      recipient_id: recipient.id || null,
      recipient_email: recipient.email,
      idempotency_key: idempotencyKey,
      status,
      run_after: runAfter,
      max_attempts: retryPolicy.maxAttempts,
      exit_reason: exitReason || null,
      payload: JSON.stringify(payload || {}),
      context: JSON.stringify(context || {}),
      completed_at: status === 'skipped' ? new Date() : null,
    }).returning('*');
  } catch (err) {
    if (err.code === '23505' || /email_template_automation_runs.*idempotency_key|idempotency_key.*unique/i.test(err.message || '')) {
      const replayed = await db('email_template_automation_runs').where({ idempotency_key: idempotencyKey }).first();
      if (replayed) {
        await logRunEvent(replayed.id, 'deduped', 'Automation trigger replay ignored by idempotency key', {
          trigger_event_key: triggerEventKey,
          trigger_event_id: triggerEventId || null,
          race_recovered: true,
        });
        return { run: replayed, deduped: true };
      }
    }
    throw err;
  }
  await logRunEvent(run.id, status === 'skipped' ? 'skipped' : 'queued', exitReason || `Automation run ${status}`, {
    automation_key: automation.automation_key,
    run_after: runAfter,
  });
  return { run, deduped: false };
}

async function processTrigger({
  triggerEventKey,
  trigger_event_key: snakeTriggerEventKey,
  triggerEventId,
  trigger_event_id: snakeTriggerEventId,
  automationKey,
  automation_key: snakeAutomationKey,
  entityType,
  entity_type: snakeEntityType,
  entityId,
  entity_id: snakeEntityId,
  payload = {},
  recipient,
  executeImmediately = true,
  now = new Date(),
} = {}) {
  const eventKey = cleanString(triggerEventKey || snakeTriggerEventKey);
  if (!eventKey) {
    const err = new Error('triggerEventKey is required');
    err.status = 400;
    throw err;
  }
  const eventId = cleanString(triggerEventId || snakeTriggerEventId, '');
  const targetAutomationKey = cleanString(automationKey || snakeAutomationKey, '');
  const automations = await loadAutomations(eventKey, targetAutomationKey);
  const results = [];

  for (const automation of automations) {
    const resolvedRecipient = recipientFor(eventKey, { payload, recipient }, automation);
    const entity = entityFor(eventKey, {
      payload,
      entityType: entityType || snakeEntityType,
      entityId: entityId || snakeEntityId,
    });
    const retryPolicy = retryPolicyFor(automation);
    const context = contextFor({
      triggerEventKey: eventKey,
      triggerEventId: eventId,
      entityType: entity.entityType,
      entityId: entity.entityId,
      payload,
      recipient: resolvedRecipient,
      automation,
    });
    const idempotencyTemplate = cleanString(automation.idempotency_key_template);
    if (!idempotencyTemplate) {
      const err = new Error(`automation ${automation.automation_key} does not define an idempotency key template`);
      err.status = 400;
      throw err;
    }
    const idempotencyKey = renderIdempotencyKey(idempotencyTemplate, context);
    const conditions = asObject(automation.conditions);
    const exitConditions = asObject(automation.exit_conditions);
    const conditionFailure = conditionFailureFor(conditions, payload, now);
    const exitReason = conditionFailure || exitReasonFor(exitConditions, payload);
    const delayMs = Math.max(0, Number(automation.delay_minutes || 0)) * 60 * 1000;
    const runAfter = new Date(now.getTime() + delayMs);
    const status = exitReason ? 'skipped' : (runAfter > now ? 'scheduled' : 'queued');
    const created = await createRun({
      automation,
      triggerEventKey: eventKey,
      triggerEventId: eventId,
      entityType: entity.entityType,
      entityId: entity.entityId,
      recipient: resolvedRecipient,
      payload,
      context,
      idempotencyKey,
      runAfter,
      status,
      exitReason,
      retryPolicy,
    });

    if (created.deduped || status === 'skipped' || status === 'scheduled' || !executeImmediately) {
      results.push({ automation_key: automation.automation_key, run: created.run, deduped: created.deduped });
      continue;
    }

    const executed = await executeRun(created.run, { automation });
    results.push({ automation_key: automation.automation_key, run: executed, deduped: false });
  }

  return {
    trigger_event_key: eventKey,
    automation_count: automations.length,
    results,
  };
}

async function loadAutomationForRun(run) {
  return db('email_template_automations as a')
    .leftJoin('email_templates as t', 't.template_key', 'a.template_key')
    .leftJoin('email_template_versions as v', 'v.id', 't.active_version_id')
    .select(
      'a.*',
      't.active_version_id as active_version_id',
      'v.id as template_version_id',
      'v.version_number as active_version_number',
    )
    .where('a.automation_key', run.automation_key)
    .first();
}

function relationMissing(err) {
  return /relation .* does not exist/i.test(err?.message || '');
}

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
}

function setLiveValue(target, key, value) {
  if (value !== undefined) target[key] = value;
}

async function loadEntityRow(table, id) {
  if (!id) return null;
  try {
    return await db(table).where({ id }).first();
  } catch (err) {
    if (relationMissing(err)) return null;
    throw err;
  }
}

async function livePayloadForRun(run, storedPayload = {}) {
  const entityType = String(run.entity_type || '').toLowerCase();
  const id = run.entity_id;
  if (!entityType || !id) return {};

  if (entityType === 'estimate') {
    const row = await loadEntityRow('estimates', id);
    if (!row) return {};
    const live = {};
    setLiveValue(live, 'estimate_id', row.id);
    if (hasOwn(row, 'status')) {
      setLiveValue(live, 'estimate_status', row.status);
      setLiveValue(live, 'status', row.status);
    }
    if (hasOwn(row, 'viewed_at')) {
      setLiveValue(live, 'viewed_at', row.viewed_at);
      setLiveValue(live, 'estimate_viewed', !!row.viewed_at);
    }
    if (hasOwn(row, 'renewal_count')) setLiveValue(live, 'renewal_count', row.renewal_count);
    if (hasOwn(row, 'expires_at')) setLiveValue(live, 'expires_at', row.expires_at);
    return live;
  }

  if (entityType === 'invoice') {
    const row = await loadEntityRow('invoices', id);
    if (!row) return {};
    const live = {};
    setLiveValue(live, 'invoice_id', row.id);
    if (hasOwn(row, 'status')) {
      setLiveValue(live, 'invoice_status', row.status);
      setLiveValue(live, 'status', row.status);
    }
    if (hasOwn(row, 'paid_at')) setLiveValue(live, 'paid_at', row.paid_at);
    if (hasOwn(row, 'customer_id')) setLiveValue(live, 'customer_id', row.customer_id);
    return live;
  }

  if (entityType === 'payment') {
    const row = await loadEntityRow('payments', id);
    const live = {};
    if (row) {
      setLiveValue(live, 'payment_id', row.id);
      if (hasOwn(row, 'status')) {
        setLiveValue(live, 'payment_status', row.status);
        setLiveValue(live, 'status', row.status);
      }
      if (hasOwn(row, 'customer_id')) setLiveValue(live, 'customer_id', row.customer_id);
      if (hasOwn(row, 'invoice_id')) setLiveValue(live, 'invoice_id', row.invoice_id);
    }

    const invoiceId = live.invoice_id || storedPayload.invoice_id;
    const invoice = await loadEntityRow('invoices', invoiceId);
    if (invoice) {
      setLiveValue(live, 'invoice_id', invoice.id);
      if (hasOwn(invoice, 'status')) setLiveValue(live, 'invoice_status', invoice.status);
      if (hasOwn(invoice, 'paid_at')) setLiveValue(live, 'paid_at', invoice.paid_at);
      if (hasOwn(invoice, 'customer_id')) setLiveValue(live, 'customer_id', invoice.customer_id);
    }
    return live;
  }

  if (entityType === 'service_record') {
    const row = await loadEntityRow('service_records', id);
    if (!row) return {};
    const live = {};
    setLiveValue(live, 'service_record_id', row.id);
    if (hasOwn(row, 'status')) {
      setLiveValue(live, 'service_status', row.status);
      setLiveValue(live, 'status', row.status);
    }
    return live;
  }

  if (entityType === 'project') {
    const row = await loadEntityRow('projects', id);
    if (!row) return {};
    const live = {};
    setLiveValue(live, 'project_id', row.id);
    const reportStatus = hasOwn(row, 'report_status') && row.report_status != null && String(row.report_status).trim() !== ''
      ? row.report_status
      : row.status;
    setLiveValue(live, 'report_status', reportStatus);
    if (hasOwn(row, 'status')) setLiveValue(live, 'status', row.status);
    return live;
  }

  if (entityType === 'scheduled_service') {
    const row = await loadEntityRow('scheduled_services', id);
    if (!row) return {};
    const live = {};
    setLiveValue(live, 'scheduled_service_id', row.id);
    if (hasOwn(row, 'status')) {
      setLiveValue(live, 'appointment_status', row.status);
      setLiveValue(live, 'service_status', row.status);
      setLiveValue(live, 'status', row.status);
    }
    if (hasOwn(row, 'service_type')) setLiveValue(live, 'service_type', row.service_type);
    return live;
  }

  if (entityType === 'customer') {
    const row = await loadEntityRow('customers', id);
    if (!row) return {};
    const live = {};
    setLiveValue(live, 'customer_id', row.id);
    if (hasOwn(row, 'status')) {
      setLiveValue(live, 'customer_status', row.status);
      setLiveValue(live, 'status', row.status);
    }
    if (hasOwn(row, 'active')) setLiveValue(live, 'active', row.active);
    if (hasOwn(row, 'recurring')) setLiveValue(live, 'recurring', row.recurring);
    if (hasOwn(row, 'customer_type')) {
      setLiveValue(live, 'customer_type', row.customer_type);
    } else if (hasOwn(row, 'recurring')) {
      setLiveValue(live, 'customer_type', row.recurring ? 'recurring' : '');
    }
    return live;
  }

  return {};
}

async function markRunSkipped(run, reason, metadata = {}) {
  const [skipped] = await db('email_template_automation_runs').where({ id: run.id }).update({
    status: 'skipped',
    exit_reason: reason,
    completed_at: new Date(),
    updated_at: new Date(),
  }).returning('*');
  await logRunEvent(run.id, 'skipped', reason, metadata);
  return skipped || { ...run, status: 'skipped', exit_reason: reason };
}

async function scheduleRetry(run, err, attemptNumber, retryPolicy, now = new Date()) {
  const index = Math.max(0, attemptNumber - 1);
  const minutes = retryPolicy.backoffMinutes[Math.min(index, retryPolicy.backoffMinutes.length - 1)] || 15;
  const nextRetryAt = new Date(now.getTime() + minutes * 60 * 1000);
  const [updated] = await db('email_template_automation_runs').where({ id: run.id }).update({
    status: 'retry_scheduled',
    run_after: nextRetryAt,
    next_retry_at: nextRetryAt,
    last_error: err.message.slice(0, 2000),
    updated_at: new Date(),
  }).returning('*');
  await logRunEvent(run.id, 'retry_scheduled', `Retry ${attemptNumber + 1} scheduled`, {
    error: err.message,
    next_retry_at: nextRetryAt,
  });
  return updated;
}

async function executeRun(runOrId, { automation, now = new Date() } = {}) {
  const run = typeof runOrId === 'string'
    ? await db('email_template_automation_runs').where({ id: runOrId }).first()
    : runOrId;
  if (!run) {
    const err = new Error('automation run not found');
    err.status = 404;
    throw err;
  }
  if (FINAL_STATUSES.has(run.status)) return run;
  const resolvedAutomation = automation || await loadAutomationForRun(run);
  if (!resolvedAutomation) {
    const err = new Error('automation not found for run');
    err.status = 404;
    throw err;
  }
  const automationStatus = normalizeStatus(resolvedAutomation.status || 'active');
  if (automationStatus !== 'active') {
    return markRunSkipped(run, `automation status is ${automationStatus}`, { guard: 'automation_status' });
  }

  const retryPolicy = retryPolicyFor(resolvedAutomation);
  const attemptNumber = Number(run.attempts || 0) + 1;
  const staleBefore = staleRunningCutoff(now);
  const [running] = await db('email_template_automation_runs')
    .where({ id: run.id })
    .whereIn('status', [...RUNNABLE_STATUSES, 'running'])
    .where((builder) => {
      builder
        .where((due) => due.whereIn('status', RUNNABLE_STATUSES).where('run_after', '<=', now))
        .orWhere((stale) => stale.where({ status: 'running' }).where('updated_at', '<=', staleBefore));
    })
    .update({
      status: 'running',
      attempts: attemptNumber,
      last_error: null,
      updated_at: new Date(),
    })
    .returning('*');
  if (!running) {
    const current = await db('email_template_automation_runs').where({ id: run.id }).first();
    return current || run;
  }
  await logRunEvent(run.id, 'attempt_started', `Attempt ${attemptNumber} started`, {
    attempt: attemptNumber,
  });
  const claimedRun = { ...run, ...running };

  try {
    const storedPayload = asObject(claimedRun.payload);
    const executionPayload = {
      ...storedPayload,
      ...await livePayloadForRun(claimedRun, storedPayload),
    };
    const exitReason = exitReasonFor(asObject(resolvedAutomation.exit_conditions), executionPayload);
    if (exitReason) {
      return markRunSkipped(claimedRun, exitReason, { guard: 'exit_conditions', attempt: attemptNumber });
    }
    const conditionFailure = conditionFailureFor(asObject(resolvedAutomation.conditions), executionPayload, now);
    if (conditionFailure) {
      return markRunSkipped(claimedRun, conditionFailure, { guard: 'conditions', attempt: attemptNumber });
    }

    const result = await EmailTemplates.sendTemplate({
      templateKey: claimedRun.template_key,
      versionId: claimedRun.template_version_id || undefined,
      to: claimedRun.recipient_email,
      payload: executionPayload,
      recipientType: claimedRun.recipient_type,
      recipientId: claimedRun.recipient_id,
      triggerEventId: claimedRun.trigger_event_id,
      automationRunId: claimedRun.id,
      idempotencyKey: claimedRun.idempotency_key,
      categories: ['email_template_automation', `automation_${claimedRun.automation_key}`],
      suppressionGroupKey: resolvedAutomation.suppression_group_key || undefined,
    });
    const status = result.blocked ? 'blocked' : 'sent';
    const [updated] = await db('email_template_automation_runs').where({ id: run.id }).update({
      status,
      email_message_id: result.message?.id || null,
      last_error: result.blocked ? result.reason || 'suppressed' : null,
      completed_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
    await logRunEvent(run.id, status, result.blocked ? result.reason || 'Email suppressed' : 'Email sent', {
      email_message_id: result.message?.id || null,
      provider_message_id: result.message?.provider_message_id || null,
      deduped: !!result.deduped,
    });
    return updated || { ...running, status };
  } catch (err) {
    if (attemptNumber < retryPolicy.maxAttempts) {
      return scheduleRetry(claimedRun, err, attemptNumber, retryPolicy, now);
    }
    const [failed] = await db('email_template_automation_runs').where({ id: run.id }).update({
      status: 'failed',
      last_error: err.message.slice(0, 2000),
      completed_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
    await logRunEvent(run.id, 'failed', err.message, {
      attempt: attemptNumber,
      max_attempts: retryPolicy.maxAttempts,
    });
    return failed || { ...running, status: 'failed', last_error: err.message };
  }
}

async function processDueRuns({ limit = 50, now = new Date() } = {}) {
  let due;
  try {
    const staleBefore = staleRunningCutoff(now);
    due = await db('email_template_automation_runs')
      .whereIn('status', [...RUNNABLE_STATUSES, 'running'])
      .where((builder) => {
        builder
          .where((runnable) => runnable.whereIn('status', RUNNABLE_STATUSES).where('run_after', '<=', now))
          .orWhere((stale) => stale.where({ status: 'running' }).where('updated_at', '<=', staleBefore));
      })
      .orderBy('run_after', 'asc')
      .limit(Math.min(Number(limit) || 50, 200));
  } catch (err) {
    if (/relation .*email_template_automation_runs.* does not exist/i.test(err.message || '')) {
      return { processed: 0, reason: 'automation run table missing' };
    }
    throw err;
  }

  let processed = 0;
  const results = [];
  for (const run of due) {
    try {
      const result = await executeRun(run, { now });
      processed += 1;
      results.push(result);
    } catch (err) {
      logger.error(`[email-template-automation] run ${run.id} failed: ${err.message}`);
      results.push({ id: run.id, status: 'error', error: err.message });
    }
  }
  return { processed, results };
}

async function listRuns({ automationKey, limit = 100 } = {}) {
  let query = db('email_template_automation_runs')
    .orderBy('created_at', 'desc')
    .limit(Math.min(Number(limit) || 100, 500));
  if (automationKey) query = query.where({ automation_key: automationKey });
  return query;
}

module.exports = {
  TRIGGER_MAPPINGS,
  processTrigger,
  processDueRuns,
  executeRun,
  listRuns,
  renderIdempotencyKey,
  conditionFailureFor,
  exitReasonFor,
  recipientFor,
  entityFor,
};
