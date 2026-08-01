const db = require('../models/db');
const EmailTemplates = require('./email-template-library');
const logger = require('./logger');
const { formatDisplayDate, dateOnlyString } = require('../utils/date-only');
const { etDateString } = require('../utils/datetime-et');

// Mirrors ASSIGNMENT_TERMINAL_STATUSES in routes/admin-schedule.js — an
// appointment in any of these states is no longer an upcoming visit.
const APPOINTMENT_CLOSED_STATUSES = ['cancelled', 'completed', 'rescheduled', 'skipped', 'no_show'];

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
  if (stopIf.includes('appointment.closed') && APPOINTMENT_CLOSED_STATUSES.includes(appointmentStatus)) {
    return `appointment status is ${appointmentStatus}`;
  }
  if (stopIf.includes('appointment.past') && payload.service_date_ymd && payload.service_date_ymd < etDateString()) {
    return 'appointment date already passed';
  }

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
  const type = cleanString(rawRecipient.type || rawRecipient.recipient_type || mapping.recipientType || automation.audience || 'customer');
  // WHICH source produced the id decides whether the under-lock customer
  // revalidation applies (r15): recipientIdKeys can carry BOTH
  // 'customer_id' and 'lead_id', and the recipient TYPE ('lead') does not
  // say which one matched — a lead-type recipient legitimately rides a
  // customers-row id when the lead is linked. Only an id that provably
  // names a customers row gets revalidated; lead/other identifiers are
  // untouched by a customer-merge undo and must never be stripped by it.
  let id = cleanString(rawRecipient.id || rawRecipient.recipient_id, '');
  let idIsCustomer = null;
  if (id) {
    // Explicit typed recipient (admin trigger): trust its declared type.
    idIsCustomer = type === 'customer';
  } else {
    for (const key of mapping.recipientIdKeys || []) {
      const value = payload?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        id = cleanString(value, '');
        idIsCustomer = key === 'customer_id';
        break;
      }
    }
  }
  return { email, type, id, idIsCustomer };
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

/**
 * @param conn knex connection OR the caller's transaction. MUST be the
 *   transaction whenever the parent run row was written in one:
 *   email_template_automation_run_events.run_id references
 *   email_template_automation_runs(id) (20260518000002), so logging an
 *   event for an UNCOMMITTED parent through the global pool deadlocks —
 *   the pooled connection waits on our transaction's uncommitted row while
 *   our transaction waits on that connection's insert. Defaults to `db` so
 *   callers outside a transaction are unchanged.
 */
async function logRunEvent(runId, eventType, message, metadata = {}, conn = db) {
  if (!runId) return null;
  try {
    const [event] = await conn('email_template_automation_run_events').insert({
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

/**
 * Re-resolve the recipient's ATTRIBUTION under the comms advisory lock.
 *
 * recipientFor() is a pure payload-derived function (no DB access), so
 * re-deriving it under the lock would return the same values — it cannot
 * detect that the payload's customer id went stale. The authoritative check
 * is a real READ of the customer row, performed strictly INSIDE the lock:
 * only then is it guaranteed to reflect a completed customer-merge undo
 * rather than the pre-undo world the trigger payload was built from.
 *
 * Delivery semantics are deliberately untouched — recipient_email stays the
 * payload's address (automations legitimately mail an address that differs
 * from customers.email: a tenant's estimate under a landlord's record).
 * Only the ATTRIBUTION is corrected: a recipient id whose customer row is
 * gone or merged-away is dropped to unlinked rather than pinning the run to
 * a retired row. Best-effort: an unreadable customers table keeps the
 * payload's id (today's behavior) — the LOCK, not this read, is what closes
 * the race; this read only refines who the row is attributed to.
 */
async function resolveRecipientUnderLock(conn, recipient) {
  if (!recipient.id) return { recipient, blockReason: null };
  try {
    const row = await conn('customers')
      .where({ id: recipient.id })
      .first('id', 'email', 'deleted_at');
    if (!row || row.deleted_at) {
      return { recipient: { ...recipient, id: '' }, blockReason: null };
    }
    // The payload's address may legitimately differ from customers.email
    // (a tenant's estimate under a landlord's record) — that case must keep
    // sending. What must NOT send is the post-undo shape: the payload
    // carries an address this customer USED to hold and that a merge undo
    // has since handed back to the restored customer. The two are told
    // apart by asking who owns the address NOW: an address belonging to
    // ANOTHER LIVE CUSTOMER is never a legitimate "different by design"
    // recipient for this one — it is someone else's registered mailbox.
    // (True third-party addresses like a tenant's are not customer rows,
    // so they fall through and still send.)
    const payloadEmail = String(recipient.email || '').trim().toLowerCase();
    const liveEmail = String(row.email || '').trim().toLowerCase();
    if (payloadEmail && payloadEmail !== liveEmail) {
      const otherOwner = await conn('customers')
        .whereRaw('lower(email) = ?', [payloadEmail])
        .whereNot({ id: recipient.id })
        .where('active', true)
        .whereNull('deleted_at')
        .first('id');
      if (otherOwner) {
        // Recorded (audit trail) but never sent: a 'skipped' row fails
        // executeRun's status claim, so no delivery can follow.
        return {
          recipient,
          blockReason: 'recipient address now belongs to a different live customer (stale pre-undo address)',
        };
      }
    }
  } catch {
    // Unreadable → keep the payload attribution (unchanged behavior).
  }
  return { recipient, blockReason: null };
}

async function createRun({ automation, triggerEventKey, triggerEventId, entityType, entityId, recipient, payload, context, idempotencyKey, runAfter, status, exitReason, retryPolicy }) {
  // LOCK ORDER: the advisory lock is the transaction's FIRST statement —
  // before the idempotency read, before the recipient's customer row is
  // read, and before the insert. Resolving recipient state first and
  // locking second is the race this exists to close: with an undo holding
  // the lock, a writer that had ALREADY read the pre-undo recipient state
  // would wait, then insert that stale winner-owned row AFTER the undo
  // committed — a row the undo's probe could never have seen. The
  // recipient id arriving here is only a LOCK KEY (payload-derived, pure);
  // the value the insert is attributed to comes from
  // resolveRecipientUnderLock's read, which happens under the lock.
  //
  // Serializes against an in-flight customer-merge UNDO probing this
  // recipient's queued sends (customer-dedupe.js revertMerge, email guard):
  // runs are keyed by recipient_id — a STRING customer id with no FK — so
  // no row lock can fence this insert against that probe. Behavior is
  // otherwise identical (the lock only blocks while an undo of THIS
  // customer is mid-transaction). KEY DERIVATION (must stay byte-identical
  // to customer-dedupe.js and routes/booking.js — extend ALL in the same
  // commit): pg_advisory_xact_lock(hashtextextended(
  //   'customer-comms:' || <customer id>, 0)) — transaction-scoped.
  // No recipient id = unlinked run, and a NON-customer id (a lead's, or an
  // explicitly typed non-customer recipient — recipientFor's idIsCustomer)
  // cannot collide with a customer-merge undo at all: the undo's probes
  // match customers-row ids only. Both keep the original lock-free path —
  // and, critically, a lead-backed run must never have its id stripped by
  // the customer revalidation.
  if (!recipient.id || recipient.idIsCustomer === false) {
    return createRunUnlocked({
      conn: db, automation, triggerEventKey, triggerEventId, entityType, entityId,
      recipient, payload, context, idempotencyKey, runAfter, status, exitReason, retryPolicy,
    });
  }
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`customer-comms:${recipient.id}`]);
    const { recipient: lockedRecipient, blockReason } = await resolveRecipientUnderLock(trx, recipient);
    return createRunUnlocked({
      conn: trx, automation, triggerEventKey, triggerEventId, entityType, entityId,
      recipient: lockedRecipient, payload, context, idempotencyKey, runAfter,
      // A blocked recipient records the run as SKIPPED rather than queued —
      // the row stays as an audit trail, and a 'skipped' status fails
      // executeRun's claim so nothing can deliver to the stale address.
      status: blockReason ? 'skipped' : status,
      exitReason: blockReason || exitReason,
      retryPolicy,
    });
  });
}

async function createRunUnlocked({ conn, automation, triggerEventKey, triggerEventId, entityType, entityId, recipient, payload, context, idempotencyKey, runAfter, status, exitReason, retryPolicy }) {
  const existing = await conn('email_template_automation_runs').where({ idempotency_key: idempotencyKey }).first();
  if (existing) {
    // conn, never the global pool — see logRunEvent's contract (the parent
    // run may be uncommitted in THIS transaction; a pooled insert deadlocks).
    await logRunEvent(existing.id, 'deduped', 'Automation trigger replay ignored by idempotency key', {
      trigger_event_key: triggerEventKey,
      trigger_event_id: triggerEventId || null,
    }, conn);
    return { run: existing, deduped: true };
  }

  // A trigger replay can commit the same idempotency_key between the read
  // above and this insert. That race must NEVER surface as a raised unique
  // violation: when conn is the locked transaction (createRun's customer
  // path, r14), a raised 23505 ABORTS the transaction — every later
  // statement fails 25P02 until rollback, so a catch-then-select recovery
  // can never run there. ON CONFLICT (idempotency_key) DO NOTHING absorbs
  // the race inside the statement instead: zero rows back means a
  // concurrent replay won, and the recovery fetch + audit event run on a
  // still-healthy connection. Any OTHER error still throws and rolls the
  // transaction back as before.
  const [run] = await conn('email_template_automation_runs').insert({
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
  }).onConflict('idempotency_key').ignore().returning('*');
  if (!run) {
    const replayed = await conn('email_template_automation_runs').where({ idempotency_key: idempotencyKey }).first();
    if (!replayed) {
      // Conflicted yet unreadable — a replay claimed the key and vanished
      // (only a concurrent hard delete can produce this). Surface it; the
      // caller's transaction rolls back cleanly.
      throw new Error(`Automation run insert conflicted on idempotency key but the winning row is gone (${idempotencyKey})`);
    }
    await logRunEvent(replayed.id, 'deduped', 'Automation trigger replay ignored by idempotency key', {
      trigger_event_key: triggerEventKey,
      trigger_event_id: triggerEventId || null,
      race_recovered: true,
    }, conn);
    return { run: replayed, deduped: true };
  }
  // The parent run row was just inserted through `conn`; when conn is a
  // transaction this event MUST ride it (FK to an uncommitted parent).
  await logRunEvent(run.id, status === 'skipped' ? 'skipped' : 'queued', exitReason || `Automation run ${status}`, {
    automation_key: automation.automation_key,
    run_after: runAfter,
  }, conn);
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
    // Rendered appointment details refresh at send time: runs queue at
    // booking (delay/retry can defer the send), and a corrected slot or
    // address must not reach the customer with the values captured at
    // queue time.
    if (hasOwn(row, 'scheduled_date')) {
      const liveServiceDate = formatDisplayDate(row.scheduled_date, { fallback: '' });
      if (liveServiceDate) setLiveValue(live, 'service_date', liveServiceDate);
      const liveServiceDateYmd = dateOnlyString(row.scheduled_date);
      if (liveServiceDateYmd) setLiveValue(live, 'service_date_ymd', liveServiceDateYmd);
    }
    if (row.customer_id) {
      const customer = await loadEntityRow('customers', row.customer_id);
      const liveAddress = customer
        ? [customer.address_line1, customer.city, customer.zip].filter(Boolean).join(', ')
        : '';
      if (liveAddress) setLiveValue(live, 'property_address', liveAddress);
    }
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
    // Prep guides: a CONFIRMED send stamps the visit's prep_sent_at (the
    // tracker's "prep actually went out" proof) and aligns the rendered
    // guide to the delivered template. Queue time is too early — a queued
    // run can still skip, suppress, or fail right here. Fail-soft: a stamp
    // hiccup never fails a run that already sent.
    if (status === 'sent'
      && String(claimedRun.entity_type || '') === 'scheduled_service'
      && String(claimedRun.template_key || '').startsWith('prep.')) {
      try {
        const { markServicePrepSent } = require('./project-email');
        await markServicePrepSent(claimedRun.entity_id, claimedRun.template_key);
      } catch (stampErr) {
        logger.warn(`[email-template-automations] prep_sent_at stamp failed for service ${claimedRun.entity_id}: ${stampErr.message}`);
      }
    }
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

async function processDueRuns({ limit = 50, now = new Date(), preview = false, runIds = undefined } = {}) {
  // runIds binds a confirmed send to the exact runs the operator previewed:
  // the due/status conditions below still re-apply, so a previewed run the
  // scheduler already claimed is dropped and runs that became due after the
  // preview (not in runIds) are never sent unpreviewed. `undefined` = the
  // scheduler/cron path (full unscoped due batch). An ARRAY scopes to exactly
  // those ids — and an empty array is fail-closed: it sends nothing rather than
  // falling through to the whole batch.
  const scopeToIds = Array.isArray(runIds);
  if (scopeToIds && runIds.length === 0) {
    return preview ? { preview: true, dueCount: 0, runs: [] } : { processed: 0, results: [] };
  }
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
      .modify((q) => {
        if (scopeToIds) q.whereIn('id', runIds);
      })
      .orderBy('run_after', 'asc')
      .limit(Math.min(Number(limit) || 50, 200));
  } catch (err) {
    if (/relation .*email_template_automation_runs.* does not exist/i.test(err.message || '')) {
      return preview
        ? { preview: true, dueCount: 0, runs: [], reason: 'automation run table missing' }
        : { processed: 0, reason: 'automation run table missing' };
    }
    throw err;
  }

  // Dry run: report exactly which runs the same query would send, so the
  // operator can confirm before firing up to 200 customer emails. No side
  // effects — nothing is executed or mutated.
  if (preview) {
    return {
      preview: true,
      dueCount: due.length,
      runs: due.map((run) => ({
        id: run.id,
        recipient_email: run.recipient_email,
        automation_key: run.automation_key,
        template_key: run.template_key,
        status: run.status,
        run_after: run.run_after,
      })),
    };
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
  livePayloadForRun,
};
