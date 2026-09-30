const crypto = require('crypto');
const db = require('../models/db');
const EmailTemplates = require('./email-template-library');
const logger = require('./logger');
const { scrubSentryText } = require('../utils/sentry-scrub');
const { estimateFollowupBlockedReason } = require('./estimate-comms-eligibility');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const { formatDisplayDate, dateOnlyString } = require('../utils/date-only');
const { etDateString } = require('../utils/datetime-et');
const { emailTemplateAutomationsMode } = require('../config/feature-gates');
// Light at load (the readers behind each builder are required lazily); the
// key set below decides WHICH runs ever touch the email division.
const { RESERVATION_LIFETIME_MS } = require('./email-division/reservation-lifetime');
const {
  hasPayloadBuilder, buildEmailDivisionPayload, ledgerGuardsFor, ONCE_ALREADY_DELIVERED, ONCE_IN_FLIGHT,
  ESTIMATE_RECIPIENT_CHANGED, ESTIMATE_NOT_EXPIRED, ESTIMATE_EXPIRY_SUPERSEDED,
} = require('./email-division/payload-builders');

// Mirrors ASSIGNMENT_TERMINAL_STATUSES in routes/admin-schedule.js — an
// appointment in any of these states is no longer an upcoming visit.
const APPOINTMENT_CLOSED_STATUSES = ['cancelled', 'completed', 'rescheduled', 'skipped', 'no_show'];

// 'shadow' is a terminal outcome too (the shadow-mode counterpart of
// 'sent') — a shadow run is done, never picked up again by processDueRuns
// or re-executed by loadRunAndAutomation.
const FINAL_STATUSES = new Set(['sent', 'blocked', 'skipped', 'failed', 'shadow']);
const RUNNABLE_STATUSES = ['queued', 'scheduled', 'retry_scheduled'];
const DEFAULT_RETRY_POLICY = { max_attempts: 2, backoff_minutes: [15, 60] };
// A 'running' run is reclaimed only after the marketing ledger's reservation
// lease has expired too (its value is read, not restated): the run's claim
// starts BEFORE the ledger reserves, so an equal timer would reclaim a crashed
// run while its own reservation is still live. The margin covers the gap
// between the claim and the reservation.
const STALE_CLAIM_MARGIN_MS = 5 * 60 * 1000;
const RUNNING_STALE_AFTER_MS = Math.max(30 * 60 * 1000, RESERVATION_LIFETIME_MS + STALE_CLAIM_MARGIN_MS);

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
  'estimate.expired': {
    entityType: 'estimate',
    entityIdKeys: ['estimate_id', 'id'],
    recipientType: 'lead',
    recipientIdKeys: ['customer_id', 'lead_id'],
    emailKeys: ['customer_email', 'email'],
  },
  // A customer's first performed visit on a service line. Mapped for the
  // email division's lc.first_visit_pest; the producer call (an emitter at
  // the completion site) is a separate step — see
  // email-template-automation-emitters.js emitVisitCompletedFirst.
  'visit.completed_first': {
    entityType: 'service_record',
    entityIdKeys: ['service_record_id', 'id'],
    recipientType: 'customer',
    recipientIdKeys: ['customer_id'],
    emailKeys: ['customer_email', 'email'],
  },
  'review.linked_5star': {
    entityType: 'review',
    entityIdKeys: ['review_id', 'id'],
    recipientType: 'customer',
    recipientIdKeys: ['customer_id'],
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

function contextFor({ triggerEventKey, triggerEventId, entityType, entityId, payload, recipient, automation, mode }) {
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
  // Stamped at CREATION time so a delayed/retried run remembers the mode
  // that promised its outcome (codex P1): 'shadow' must finalize shadow
  // however long it sits in run_after, even if the gate flips to 'true'
  // before it becomes due. Only the shadow->live promotion path
  // (createRunUnlocked) may advance this to 'live' — see there. Never
  // referenced by an idempotency_key_template (no catalog row predates
  // this field), so adding it here cannot change any existing dedup key.
  if (mode) context.origin_mode = mode;
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
    // Stable token the lifecycle emitters classify on (a permanent
    // condition: the intent marker settles 'unrecoverable', never retried).
    err.code = 'AUTOMATION_RECIPIENT_EMAIL_REQUIRED';
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

// Newer emitters (e.g. review.linked_5star) deliberately pass only ids —
// recipient EMAIL resolution is centralized HERE rather than duplicated per
// emitter.
// recipientFor() stays a pure, DB-free function (its own contract, see
// above); this is the one place processTrigger reaches the database before
// the automations loop, and only when there is nothing to resolve from the
// payload/recipient already. No-op (returns payload unchanged) whenever an
// email is already resolvable, or no customer id is available to look up.
async function resolveEmailForTrigger(eventKey, payload, recipient) {
  const mapping = TRIGGER_MAPPINGS[eventKey] || {};
  const already = cleanString(recipient?.email || firstDefined(payload, mapping.emailKeys) || payload?.recipient_email);
  if (already) return payload;
  const customerId = cleanString(recipient?.id || firstDefined(payload, mapping.recipientIdKeys), '');
  if (!customerId) return payload;
  let row;
  try {
    // Live customers only (pre-push audit P1) — the same whereNull('deleted_at')
    // predicate every customer-addressed sender uses (automation-enroll.js's
    // review thank-you enrollment, prep-guide-sender.js). A soft-deleted /
    // merged-away customer resolves NO address, so recipientFor's
    // recipient-email-required error skips the trigger instead of mailing a
    // retired record.
    row = await db('customers').where({ id: customerId }).whereNull('deleted_at').first('email');
  } catch (err) {
    // A FAILED lookup is not "this customer has no email" (codex P2 round 5
    // on #5154): swallowing it let recipientFor raise the deterministic
    // AUTOMATION_RECIPIENT_EMAIL_REQUIRED (status 400), which the lifecycle
    // emitter settles 'unrecoverable' on first sight — one DB hiccup
    // permanently lost the event. Rethrown as a TRANSIENT error (status
    // 503, its own code, never 400) so every caller's retry path handles it
    // like any other infrastructure failure: the emitter counts a failed
    // attempt and the intent sweep replays the marker.
    const safe = scrubSentryText(err && err.message ? err.message : err);
    logger.warn(`[email-template-automation] recipient email lookup failed for ${eventKey} customer ${customerId}: ${safe}`);
    throw Object.assign(new Error(`recipient email lookup failed: ${safe}`), {
      status: 503,
      code: 'AUTOMATION_RECIPIENT_LOOKUP_FAILED',
      retryable: true,
    });
  }
  if (row && row.email) return { ...payload, customer_email: row.email };
  return payload;
}

async function loadAutomations(triggerEventKey, automationKey) {
  let query = db('email_template_automations as a')
    .leftJoin('email_templates as t', 't.template_key', 'a.template_key')
    .leftJoin('email_template_versions as v', 'v.id', 't.active_version_id')
    .select(
      'a.*',
      't.active_version_id as active_version_id',
      't.status as template_status',
      't.send_stream as template_send_stream',
      't.suppression_group_key as template_suppression_group_key',
      't.mode as template_mode',
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
    const insertEvent = async (c) => {
      const [event] = await c('email_template_automation_run_events').insert({
        run_id: runId,
        event_type: eventType,
        message: message || null,
        metadata: JSON.stringify(metadata || {}),
      }).returning('*');
      return event || null;
    };
    // Best-effort logging must never POISON a caller's transaction (r17
    // pre-push P1): in Postgres a failed statement aborts the enclosing
    // transaction even though the JS error is caught below — the caller
    // would then COMMIT an aborted transaction and silently lose the run
    // row this event annotates. A nested knex transaction (SAVEPOINT)
    // scopes the failure to the event insert alone: its rollback releases
    // the savepoint and the outer transaction stays healthy. The pooled
    // path keeps the plain insert — there is no enclosing transaction to
    // protect.
    if (conn.isTransaction) {
      return await conn.transaction((sp) => insertEvent(sp));
    }
    return await insertEvent(conn);
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
      // Another holder ALONE is not staleness (r30): shared household
      // addresses and different-by-design recipients (a tenant with their
      // own customer record) are supported. The post-undo shape has
      // MERGE-SPECIFIC evidence — a live holder who is the restored LOSER
      // of an undone merge whose winner is this run's customer — checked
      // across EVERY holder in one joined query (r31: sampling a single
      // holder could pick the spouse and miss the restored loser sharing
      // the same mailbox). Unreadable → conservative block only when a
      // bare holder exists.
      let undoneHolder = null;
      try {
        undoneHolder = await conn('customers as c')
          .join('customer_merge_journal as j', function joinUndone() {
            this.on('j.loser_customer_id', 'c.id');
          })
          .where('j.winner_customer_id', recipient.id)
          .whereNotNull('j.undone_at')
          .whereRaw('lower(c.email) = ?', [payloadEmail])
          .whereNot('c.id', recipient.id)
          .where('c.active', true)
          .whereNull('c.deleted_at')
          .first('c.id');
      } catch {
        try {
          undoneHolder = await conn('customers')
            .whereRaw('lower(email) = ?', [payloadEmail])
            .whereNot({ id: recipient.id })
            .where('active', true)
            .whereNull('deleted_at')
            .first('id');
        } catch { /* both unreadable → keep the payload attribution */ }
      }
      if (undoneHolder) {
        // Recorded (audit trail) but never sent: a 'skipped' row fails
        // executeRun's status claim, so no delivery can follow.
        return {
          recipient,
          blockReason: 'recipient address was restored to the merged-away customer by an undo (stale pre-undo address)',
        };
      }
    }
  } catch {
    // Unreadable → keep the payload attribution (unchanged behavior).
  }
  return { recipient, blockReason: null };
}

async function createRun({ automation, triggerEventKey, triggerEventId, entityType, entityId, recipient, payload, context, idempotencyKey, runAfter, status, exitReason, retryPolicy, mode }) {
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
  // customer is mid-transaction). Key derivation + lock-order contract are
  // centralized in utils/customer-comms-lock.js.
  // No recipient id = unlinked run — lock-free. A NON-customer id keeps
  // the lead UUID in recipient_id (a lead-backed run must never have its
  // id stripped by the customer revalidation) but is NO LONGER assumed
  // unrelated to a merge-undo (r21): a LINKED lead's run delivers the
  // customer's sequence, and the undo's queued-run probe now follows
  // leads.customer_id — so the insert must fence through that owner. An
  // unlinked lead (no customer_id) or a genuinely non-lead id stays
  // lock-free; a failed owner lookup queues unfenced with a loud log
  // (sends are never blocked into failure — r14 posture).
  if (!recipient.id || recipient.idIsCustomer === false) {
    let leadOwnerCustomerId = null;
    if (recipient.id && recipient.idIsCustomer === false
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(recipient.id))) {
      try {
        const leadRow = await db('leads').where({ id: recipient.id }).first('customer_id');
        leadOwnerCustomerId = (leadRow && leadRow.customer_id) || null;
      } catch (lookupErr) {
        logger.warn(`[template-executor] lead owner lookup failed for recipient ${recipient.id} — queuing unfenced: ${lookupErr.message}`);
      }
    }
    if (leadOwnerCustomerId) {
      return db.transaction(async (trx) => {
        await lockCustomerComms(trx, leadOwnerCustomerId);
        // Re-resolve UNDER the lock (r22 — the resolve → lock → re-resolve
        // idiom): the pre-lock owner lookup may predate an undo this
        // acquisition just waited out. A repointed lead fences its NEW
        // owner too (this trx holds only advisory keys, and an undo takes
        // exactly one comms key — a blocking second acquire cannot cycle).
        let ownerNow = leadOwnerCustomerId;
        try {
          // r42: LOOP to a fixpoint — each new-owner acquire can itself
          // wait out ANOTHER undo that repoints the lead again, so a
          // single re-read can still insert against a stale owner.
          // Re-read until the owner is one whose key this trx already
          // holds (advisory keys are held to commit, so a held owner
          // cannot have an undo mid-flight). Cap guards degenerate
          // ping-pong; exhausting it queues with the last-read owner and
          // a loud log (r14 posture: sends are never blocked into
          // failure — the mailbox check below still gates delivery).
          const heldOwners = new Set([String(leadOwnerCustomerId)]);
          for (let hop = 0; ; hop += 1) {
            const freshLead = await trx('leads').where({ id: recipient.id }).first('customer_id');
            ownerNow = (freshLead && freshLead.customer_id) || null;
            if (!ownerNow || heldOwners.has(String(ownerNow))) break;
            if (hop >= 3) {
              logger.warn(`[template-executor] lead ${recipient.id} owner still moving after ${hop} comms-fence hops — queuing under last-read owner ${ownerNow}`);
              break;
            }
            await lockCustomerComms(trx, ownerNow);
            heldOwners.add(String(ownerNow));
          }
        } catch { ownerNow = leadOwnerCustomerId; }
        // Mailbox revalidation, same rule as resolveRecipientUnderLock: an
        // address that NOW belongs to a live customer other than the run's
        // owner is someone else's registered mailbox — typically the
        // restored loser of the undo we waited out, holding back the
        // inherited email this terminal lead captured pre-undo (terminal
        // leads are outside the undo's identity probes by design, so this
        // post-wait check is the only gate).
        let leadBlockReason = null;
        const leadPayloadEmail = String(recipient.email || '').trim().toLowerCase();
        if (leadPayloadEmail && ownerNow) {
          try {
            // Merge-specific evidence across EVERY live holder (r30/r31)
            // — see resolveRecipientUnderLock for the sampling rationale.
            const undoneLeadHolder = await trx('customers as c')
              .join('customer_merge_journal as j', function joinUndone() {
                this.on('j.loser_customer_id', 'c.id');
              })
              .where('j.winner_customer_id', ownerNow)
              .whereNotNull('j.undone_at')
              .whereRaw('lower(c.email) = ?', [leadPayloadEmail])
              .whereNot('c.id', ownerNow)
              .where('c.active', true)
              .whereNull('c.deleted_at')
              .first('c.id');
            if (undoneLeadHolder) leadBlockReason = 'recipient address was restored to the merged-away customer by an undo (stale pre-undo address)';
          } catch { /* unreadable → keep the payload attribution (unchanged behavior) */ }
        }
        return createRunUnlocked({
          conn: trx, automation, triggerEventKey, triggerEventId, entityType, entityId,
          recipient, payload, context, idempotencyKey, runAfter,
          status: leadBlockReason ? 'skipped' : status,
          exitReason: leadBlockReason || exitReason,
          retryPolicy, mode,
        });
      });
    }
    return createRunUnlocked({
      conn: db, automation, triggerEventKey, triggerEventId, entityType, entityId,
      recipient, payload, context, idempotencyKey, runAfter, status, exitReason, retryPolicy, mode,
    });
  }
  return db.transaction(async (trx) => {
    await lockCustomerComms(trx, recipient.id);
    const { recipient: lockedRecipient, blockReason } = await resolveRecipientUnderLock(trx, recipient);
    return createRunUnlocked({
      conn: trx, automation, triggerEventKey, triggerEventId, entityType, entityId,
      recipient: lockedRecipient, payload, context, idempotencyKey, runAfter,
      // A blocked recipient records the run as SKIPPED rather than queued —
      // the row stays as an audit trail, and a 'skipped' status fails
      // executeRun's claim so nothing can deliver to the stale address.
      status: blockReason ? 'skipped' : status,
      exitReason: blockReason || exitReason,
      retryPolicy, mode,
    });
  });
}

// The one place every automation-derived run FIELD is built, used by BOTH
// the fresh insert below and the shadow->live promotion (codex P1: the two
// must not drift — a promotion that hand-rolled its own subset once left
// template_key/template_version_id at their shadow-era values while the
// live automation had since republished a corrected template, so the
// first live attempt sent stale content under the CURRENT automation's
// suppression settings). Everything the automation itself decides —
// template identity/version, automation_key/id, max_attempts — reflects
// THIS call's automation row; recipient/payload/context reflect THIS
// call's freshly resolved values.
function automationRunFields({ automation, triggerEventKey, triggerEventId, entityType, entityId, recipient, idempotencyKey, runAfter, status, exitReason, retryPolicy, payload, context }) {
  return {
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
  };
}

// SQL twin of promotableShadowStatus's would-block test, used inside the
// promotion UPDATE so the fact is re-checked atomically with the write.
const LATEST_EVENT_IS_WOULD_BLOCK_SQL = `(
  SELECT e.event_type FROM email_template_automation_run_events e
  WHERE e.run_id = email_template_automation_runs.id
    AND e.event_type <> 'deduped'
  ORDER BY e.created_at DESC LIMIT 1
) = 'would_block'`;

// SQL twin of the origin check in promotableShadowStatus: only a run CREATED
// in shadow (context.origin_mode, stamped by contextFor) is shadow evidence.
// A live-origin run that a rollback to shadow finalized 'shadow' or
// skipped/would_block is a dropped live send, not shadow evidence.
const SHADOW_ORIGIN_SQL = `email_template_automation_runs.context->>'origin_mode' = 'shadow'`;

// Which prior-run status (if any) a live attempt may promote in place. Only
// a run that (1) belongs to THIS automation — idempotency_key_template is not
// unique across the automations on a trigger, and promotion rewrites the
// row's automation/template fields, so another automation's evidence must
// never be adopted — and (2) was CREATED in shadow (context.origin_mode; a
// live-origin run a rollback finalized 'shadow' or skipped/would_block is a
// dropped live send, not shadow evidence) is promotable, and then only as:
// 'shadow' (a would-send), or 'skipped' when the run's LATEST lifecycle event
// (a replay's own 'deduped' audit row never counts) is the shadow preflight's
// 'would_block' — never a genuine condition/exit skip, never a live block
// (markRunSkipped logs its own later event). Any other status is not
// promotable.
async function promotableShadowStatus(conn, existing, automation) {
  if (existing.automation_key !== automation.automation_key) return null;
  if (asObject(existing.context).origin_mode !== 'shadow') return null;
  if (existing.status === 'shadow') return 'shadow';
  if (existing.status !== 'skipped') return null;
  const latest = await conn('email_template_automation_run_events')
    .where({ run_id: existing.id })
    .whereNot({ event_type: 'deduped' })
    .orderBy('created_at', 'desc')
    .first();
  return latest && latest.event_type === 'would_block' ? 'skipped' : null;
}

// The run's first lifecycle event, shared by a fresh insert and a promotion
// so a promoted run reads exactly like a freshly created one. The parent run
// row was written through `conn`; when conn is a transaction this event MUST
// ride it (FK to an uncommitted parent).
function logRunPlanned(run, { automation, status, exitReason, runAfter }, conn) {
  return logRunEvent(run.id, status === 'skipped' ? 'skipped' : 'queued', exitReason || `Automation run ${status}`, {
    automation_key: automation.automation_key,
    run_after: runAfter,
  }, conn);
}

async function createRunUnlocked({ conn, automation, triggerEventKey, triggerEventId, entityType, entityId, recipient, payload, context, idempotencyKey, runAfter, status, exitReason, retryPolicy, mode }) {
  const existing = await conn('email_template_automation_runs').where({ idempotency_key: idempotencyKey }).first();
  if (existing) {
    // A run already finalized 'shadow' (would-send, nothing dispatched)
    // never blocks a LATER live attempt for the same idempotency key — two
    // weeks of shadow volume must not silently swallow the first real send
    // once the gate flips to 'true'. Simplest correct rule, no orphaned
    // second row and no unique-constraint race: PROMOTE the same row back
    // to a fresh runnable state (this live attempt's status/run_after/
    // payload/context), rather than inserting a new row or deduping this
    // one away. Only a genuinely 'live' attempt promotes — a shadow replay
    // (mode still 'shadow') and an off-mode replay (mode 'off': nothing
    // should be created or dispatched at all) keep the ordinary dedupe path
    // below, same as any replay of an already-live/terminal row.
    //
    // A shadow WOULD-BLOCK row promotes too (pre-live fix): finalizeShadowRun
    // settles a blocked shadow attempt as status 'skipped' (a disabled
    // template, missing unsubscribe configuration, a withheld annual
    // offer...), and the operator fixing exactly that before flipping the
    // gate must let the SAME trigger go out live instead of staying a
    // terminal would_block. A genuine condition/exit skip is NOT promotable:
    // it never logs a 'would_block' event.
    const promotableFrom = mode === 'live' ? await promotableShadowStatus(conn, existing, automation) : null;
    if (promotableFrom) {
      // The UPDATE's WHERE also re-checks the status (codex P1): two
      // concurrent replays can both read this same shadow row before
      // either writes. An unconditional update here would let the SECOND
      // replay blindly overwrite whatever the FIRST one already advanced
      // the row to (running/sent) and re-arm it for a duplicate send.
      // Zero rows back means this replay lost that race — fall through to
      // an ordinary dedupe against the row as it now stands, never a
      // fabricated runnable row.
      let promoteQuery = conn('email_template_automation_runs')
        .where({ id: existing.id, status: promotableFrom, automation_key: automation.automation_key })
        .whereRaw(SHADOW_ORIGIN_SQL);
      if (promotableFrom === 'skipped') {
        // Re-check the would-block fact in the statement itself: the row is
        // still promotable only while its latest ledger event is the shadow
        // would_block (a live skip since then logs its own event).
        promoteQuery = promoteQuery.whereRaw(LATEST_EVENT_IS_WOULD_BLOCK_SQL);
      }
      const promotedRows = await promoteQuery
        .update({
          // Built from the SAME field set the fresh insert below uses
          // (codex P1) — template_key/template_version_id/automation_id/
          // max_attempts refresh to THIS live attempt's automation row, not
          // the shadow-era values, and recipient/payload/context (whose
          // origin_mode is already 'live' — contextFor stamped it from this
          // call's own `mode`) refresh to this attempt's freshly resolved
          // values. Never the stale address/content a corrected template
          // or a since-changed recipient would otherwise leave behind.
          ...automationRunFields({ automation, triggerEventKey, triggerEventId, entityType, entityId, recipient, idempotencyKey, runAfter, status, exitReason, retryPolicy, payload, context }),
          attempts: 0,
          last_error: null,
          updated_at: new Date(),
        }).returning('*');
      if (promotedRows.length) {
        await logRunEvent(existing.id, 'promoted_from_shadow', 'Prior shadow run promoted to a live attempt on the same idempotency key', {
          trigger_event_key: triggerEventKey,
          trigger_event_id: triggerEventId || null,
          from_status: promotableFrom,
        }, conn);
        await logRunPlanned(promotedRows[0], { automation, status, exitReason, runAfter }, conn);
        return { run: promotedRows[0], deduped: false };
      }
      const current = await conn('email_template_automation_runs').where({ id: existing.id }).first();
      await logRunEvent((current || existing).id, 'deduped', 'Automation trigger replay ignored by idempotency key (lost the shadow-promotion race)', {
        trigger_event_key: triggerEventKey,
        trigger_event_id: triggerEventId || null,
      }, conn);
      return { run: current || existing, deduped: true };
    }
    // conn, never the global pool — see logRunEvent's contract (the parent
    // run may be uncommitted in THIS transaction; a pooled insert deadlocks).
    // A key shared with ANOTHER automation's run names that automation, so
    // the audit row explains why this automation created nothing.
    const collidesWith = existing.automation_key !== automation.automation_key ? existing.automation_key : null;
    await logRunEvent(existing.id, 'deduped', collidesWith
      ? `Automation trigger replay ignored by idempotency key (key already owned by automation ${collidesWith})`
      : 'Automation trigger replay ignored by idempotency key', {
      trigger_event_key: triggerEventKey,
      trigger_event_id: triggerEventId || null,
      ...(collidesWith ? { colliding_automation_key: collidesWith } : {}),
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
  const [run] = await conn('email_template_automation_runs')
    .insert(automationRunFields({ automation, triggerEventKey, triggerEventId, entityType, entityId, recipient, idempotencyKey, runAfter, status, exitReason, retryPolicy, payload, context }))
    .onConflict('idempotency_key').ignore().returning('*');
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
  await logRunPlanned(run, { automation, status, exitReason, runAfter }, conn);
  return { run, deduped: false };
}

// Normalizes a processTrigger call (camelCase and snake_case aliases) and
// rejects a call with no trigger key. Pure input handling: nothing here reads
// the gate, the DB, or any automation.
function parseTriggerRequest({
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
  return {
    eventKey,
    eventId: cleanString(triggerEventId || snakeTriggerEventId, ''),
    targetAutomationKey: cleanString(automationKey || snakeAutomationKey, ''),
    entityType: entityType || snakeEntityType,
    entityId: entityId || snakeEntityId,
    payload,
    recipient,
    executeImmediately,
    now,
  };
}

// Everything ONE automation decides about ONE trigger before a run row
// exists: recipient, entity, idempotency key, and whether the run starts
// skipped (exit/condition), scheduled (delayed) or queued. Throws (status
// 400) for a blank idempotency template; the caller isolates that failure to
// this automation.
function planAutomationRun(automation, trigger, mode) {
  const { eventKey, eventId, payload, recipient, now } = trigger;
  const resolvedRecipient = recipientFor(eventKey, { payload, recipient }, automation);
  const entity = entityFor(eventKey, { payload, entityType: trigger.entityType, entityId: trigger.entityId });
  const context = contextFor({
    triggerEventKey: eventKey,
    triggerEventId: eventId,
    entityType: entity.entityType,
    entityId: entity.entityId,
    payload,
    recipient: resolvedRecipient,
    automation,
    mode,
  });
  const idempotencyTemplate = cleanString(automation.idempotency_key_template);
  if (!idempotencyTemplate) {
    const err = new Error(`automation ${automation.automation_key} does not define an idempotency key template`);
    err.status = 400;
    throw err;
  }
  const exitReason = conditionFailureFor(asObject(automation.conditions), payload, now)
    || exitReasonFor(asObject(automation.exit_conditions), payload);
  const delayMs = Math.max(0, Number(automation.delay_minutes || 0)) * 60 * 1000;
  const runAfter = new Date(now.getTime() + delayMs);
  const scheduled = runAfter > now;
  return {
    entity,
    recipient: resolvedRecipient,
    retryPolicy: retryPolicyFor(automation),
    context,
    idempotencyKey: renderIdempotencyKey(idempotencyTemplate, context),
    runAfter,
    exitReason,
    // A skipped run is never scheduled or executed, whatever its delay.
    status: exitReason ? 'skipped' : (scheduled ? 'scheduled' : 'queued'),
  };
}

// Plans, creates, and (when it is due now and the caller wants it) executes
// the run for one automation. Any throw belongs to this automation alone.
async function processAutomation(automation, trigger, mode) {
  const plan = planAutomationRun(automation, trigger, mode);
  const created = await createRun({
    automation,
    triggerEventKey: trigger.eventKey,
    triggerEventId: trigger.eventId,
    entityType: plan.entity.entityType,
    entityId: plan.entity.entityId,
    recipient: plan.recipient,
    payload: trigger.payload,
    context: plan.context,
    idempotencyKey: plan.idempotencyKey,
    runAfter: plan.runAfter,
    status: plan.status,
    exitReason: plan.exitReason,
    retryPolicy: plan.retryPolicy,
    mode,
  });
  const runsNow = plan.status === 'queued' && !created.deduped && trigger.executeImmediately;
  const run = runsNow ? await executeRun(created.run, { automation }) : created.run;
  return { automation_key: automation.automation_key, run, deduped: runsNow ? false : created.deduped };
}

// The FIRST collected failure is rethrown (direct callers keep the same
// throw/status contract), carrying the per-automation detail on
// err.automationFailures so the lifecycle emitters can tell a fixable
// automation-configuration failure from a permanent recipient one.
function aggregateFailure(failures, results) {
  const first = failures[0].error;
  const thrown = first instanceof Error ? first : new Error(String(first));
  thrown.automationFailures = failures.map(({ automation_key: automationKey, error }) => ({
    automation_key: automationKey,
    status: error && error.status ? Number(error.status) : null,
    code: (error && error.code) || null,
    message: error && error.message ? error.message : String(error),
  }));
  thrown.partialResults = results;
  return thrown;
}

async function processTrigger(args) {
  const trigger = parseTriggerRequest(args);
  const { eventKey } = trigger;
  // Read once per trigger call — mode can only change process-wide anyway,
  // and every automation matched below needs the same answer for the
  // shadow-promotion dedupe rule (createRunUnlocked). Fail-closed FIRST:
  // 'off' means no run is created, promoted, or dispatched — a caller that
  // still reaches this function despite the gate being off (a stale
  // frozen boolean, a caller that skipped its own isEnabled check) gets a
  // pure no-op, not a live send (codex P1: the boolean gate alone does not
  // stop dispatch once execution reaches the executor).
  const mode = emailTemplateAutomationsMode();
  if (mode === 'off') {
    // disabled:true tells a caller holding a durable intent marker that
    // NOTHING was evaluated (codex P1 round 4) — distinct from a live
    // zero-automation result — so it leaves the marker pending for replay
    // instead of settling it 'processed'.
    return { trigger_event_key: eventKey, automation_count: 0, results: [], disabled: true };
  }
  const automations = await loadAutomations(eventKey, trigger.targetAutomationKey);
  // DB hit only when something actually matched — an unknown/unwired
  // trigger key stays a pure, zero-write no-op (loadAutomations returns []).
  if (automations.length) {
    trigger.payload = await resolveEmailForTrigger(eventKey, trigger.payload, trigger.recipient);
  }

  // Per-automation isolation (pre-live fix): one automation's failure — a
  // blank idempotency template, a key variable the payload never provides, a
  // DB hiccup on its run — must not stop the LATER automations on the same
  // trigger from being visited, or a shared pending intent marker could never
  // reach them. Every automation is attempted; failures are collected and
  // rethrown together by aggregateFailure after the loop.
  const results = [];
  const failures = [];
  for (const automation of automations) {
    try {
      results.push(await processAutomation(automation, trigger, mode));
    } catch (err) {
      failures.push({ automation_key: automation.automation_key, error: err });
      logger.warn(`[email-template-automation] ${eventKey}/${automation.automation_key} failed, continuing with remaining automations: ${scrubSentryText(err && err.message ? err.message : err)}`);
    }
  }
  if (failures.length) throw aggregateFailure(failures, results);
  return { trigger_event_key: eventKey, automation_count: automations.length, results };
}

async function loadAutomationForRun(run) {
  return db('email_template_automations as a')
    .leftJoin('email_templates as t', 't.template_key', 'a.template_key')
    .leftJoin('email_templates as rt', function pinnedTemplate() { this.on('rt.template_key', '=', db.raw('?', [run.template_key])); })
    .leftJoin('email_template_versions as v', 'v.id', 't.active_version_id')
    .select(
      'a.*',
      't.active_version_id as active_version_id',
      // The run's PINNED template (run.template_key is what dispatch sends),
      // not the automation's current one: the admin API lets an automation's
      // template change while runs are still queued, and the class a send is
      // judged under must follow the content actually being sent.
      'rt.send_stream as template_send_stream',
      'rt.suppression_group_key as template_suppression_group_key',
      'rt.mode as template_mode',
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
    // estimate.expired's defining fact ONLY (codex P1 round 3 on #5154—
    // scoped to that ONE trigger key: every other estimate-entity
    // automation, e.g. estimate.extension_notice/estimate.viewed_gone_quiet,
    // legitimately runs with the estimate at 'sent'/'viewed'/anything, so a
    // blanket "must still be expired" check on every estimate run would
    // wrongly block them). Staff can revive an expired estimate back to
    // sent/viewed through POST /:id/extend before a delayed or retried
    // estimate.expired run comes due — extendEstimate changes the row's
    // status and texts the customer a new deadline, but nothing here
    // enforced that THAT run's own defining fact ("this estimate is still
    // expired") still held at execution. Enforced exactly like the review
    // branch below enforces ITS defining facts: __blocked skips the run
    // instead of sending stale expiration copy right after the customer was
    // told their estimate was extended.
    if (run.trigger_event_key === 'estimate.expired') {
      if (!row) return { __blocked: 'linked estimate no longer exists' };
      if (row.status !== 'expired') {
        return { __blocked: `linked estimate is no longer expired (status is ${row.status})` };
      }
    }
    if (!row) return {};
    // Every estimate-entity automation (estimate.sent / viewed /
    // expiring_soon / auto_renewed / expired — all follow-up outreach) obeys
    // the ONE shared follow-up rule the engagement engine, follow-up cron,
    // auto-renew and extension flow read (codex P1 round 6 on #5154):
    // estimate-comms-eligibility.js — never an archived estimate (staff
    // parked it; archiving an expired estimate leaves status 'expired'),
    // never one stamped estimate_data.noEngagementAutomation. Judged HERE,
    // against the live row, so a pending, delayed or retried run re-judges
    // it at execution, whatever was true when it was created.
    const followupBlocked = estimateFollowupBlockedReason(row);
    if (followupBlocked) return { __blocked: followupBlocked };
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

  // review.linked_5star's revalidation (codex P1): unlike every other
  // entity type above, a review can be legitimately un-attributed,
  // reattributed to a DIFFERENT customer, edited below five stars, or
  // dismissed/removed from Google in the window between queueing (a delay
  // or a retry) and dispatch — sending stale five-star follow-up copy off
  // the ORIGINAL match would be wrong. __blocked signals executeRun to
  // markRunSkipped with a stable reason instead of a normal field refresh.
  if (entityType === 'review') {
    const row = await loadEntityRow('google_reviews', id);
    if (!row) return { __blocked: 'linked review no longer exists' };
    if (row.dismissed) return { __blocked: 'linked review was dismissed' };
    if (row.missing_since) return { __blocked: 'linked review is no longer visible on Google' };
    if (Number(row.star_rating) !== 5) return { __blocked: 'linked review is no longer five-star' };
    if (String(row.customer_id || '') !== String(run.recipient_id || '')) {
      return { __blocked: 'linked review is attributed to a different customer now' };
    }
    return {};
  }

  return {};
}

// Hand back a FRESH prep-page claim the run never delivered on — fenced
// like the manual sender's releasePrepPage: never a delivered or opened
// page. Fail-soft.
async function releaseFreshPrepClaim(run) {
  try {
    await db('scheduled_services')
      .where({ id: run.entity_id, prep_template_key: run.template_key })
      .whereNull('prep_sent_at')
      .whereNull('prep_first_viewed_at')
      .whereRaw('COALESCE(prep_view_count, 0) = 0')
      .update({ prep_template_key: null });
  } catch (releaseErr) {
    logger.warn(`[email-template-automations] prep page release failed for service ${run.entity_id}: ${releaseErr.message}`);
  }
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

function isPrepRun(run) {
  return String(run.entity_type || '') === 'scheduled_service' && String(run.template_key || '').startsWith('prep.');
}

// One prep page per visit, across lanes: the run ATOMICALLY claims the
// visit's /prep/:token page for its guide before dispatch — an unkeyed page
// is keyed now (FRESH), a page already keyed to this guide passes, and a
// page another guide owns (a manual send's claim, or another automation's
// delivery) is refused, or the run would email a link that renders that
// other guide. A read-then-send would race a manual claim landing in
// between (pre-push Codex P1 on 235f8e5a5); the post-send stamp
// (markServicePrepSent) then never retargets an owned page (GH Codex #3856
// r19 P0). A same-guide page already STAMPED delivered (prep_sent_at — the
// manual sender's or composer's text / email landed after this run was
// queued; run creation takes no prep-send lock) is not sent again: the run
// is skipped as already delivered (GH Codex #3856 r26 P1).
// Returns { owned, fresh } or { owned: false, delivered: true }; a non-prep
// run owns nothing fresh.
async function claimPrepPageForRun(run) {
  if (!isPrepRun(run)) return { owned: true, fresh: false };
  const fresh = await db('scheduled_services')
    .where({ id: run.entity_id })
    .whereNull('prep_template_key')
    .update({ prep_template_key: run.template_key })
    .returning('id');
  if (fresh.length > 0) return { owned: true, fresh: true };
  const owned = await db('scheduled_services')
    .where({ id: run.entity_id, prep_template_key: run.template_key })
    .first('id', 'prep_sent_at');
  if (!owned) return { owned: false, fresh: false };
  if (owned.prep_sent_at) return { owned: false, fresh: false, delivered: true };
  return { owned: true, fresh: false };
}

// A FRESH claim is provisional until the guide delivers. Did THIS attempt
// prove nothing left? A throw BEFORE dispatch (onQueued never fired), or a
// definite provider rejection after it (the shared SendGrid classifier:
// 400/401/403/404/405/413/415/422/429 — a timeout-style 408 and every 5xx
// stay ambiguous). Ambiguous keeps the page: it may be in the customer's
// hands (pre-push Codex P1 on e493a0711; GH Codex #3856 r22 P2).
function prepUndelivered(claim, dispatched, err) {
  return claim.fresh && (!dispatched || require('./sendgrid-mail').isDefiniteRejection(err));
}

// After the library returned: a blocked send on a fresh claim hands the
// page back (fenced like the manual sender's releasePrepPage — never a
// delivered or opened page) so a later guide for the visit isn't refused
// over a send nobody received (pre-push Codex P1 on 61bff479f). A CONFIRMED
// send stamps the visit's prep_sent_at (the tracker's "prep actually went
// out" proof) and aligns the rendered guide to the delivered template.
// Queue time is too early — a queued run can still skip, suppress, or fail.
// Fail-soft: a stamp hiccup never fails a run that already sent.
async function settlePrepAfterSend(run, claim, status) {
  if (!isPrepRun(run)) return;
  if (status !== 'sent') {
    if (claim.fresh) await releaseFreshPrepClaim(run);
    return;
  }
  try {
    const { markServicePrepSent } = require('./project-email');
    await markServicePrepSent(run.entity_id, run.template_key);
  } catch (stampErr) {
    logger.warn(`[email-template-automations] prep_sent_at stamp failed for service ${run.entity_id}: ${stampErr.message}`);
  }
}

async function finalizeSentRun(run, result) {
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
  return { status, updated: updated || { ...run, status } };
}

// Shadow mode's dispatch counterpart to finalizeSentRun — never calls the
// email library, never claims/touches the prep page, never takes the
// prep-send lock. The 'would_send' event's metadata is deliberately
// audit-safe: automation/template/trigger identity and entity ids, plus the
// recipient email's DOMAIN and a short sha256 prefix of the lowercased
// address — never the address itself.
function recipientDomain(email) {
  const parts = String(email || '').trim().toLowerCase().split('@');
  return parts.length === 2 ? parts[1] : '';
}
function recipientHash(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex').slice(0, 12);
}
// Delivery-guards slice (re-cut of #4569): an estimate-triggered automation
// run (auto-renew's estimate.auto_renewed, expiring reminders, etc.) shares
// the same chokepoint every other estimate sender routes through — this
// executor is generic across entity types, so only an 'estimate' run carries
// its id through. ONE function for both the live send (dispatchRun) and the
// shadow preflight, so the two always guard the same estimate.
function annualGuardArgsFor(run) {
  return run.entity_type === 'estimate' && run.entity_id ? { estimateId: run.entity_id } : {};
}

// Email-division ledger fence (codex P1 round 7 on #5154; owner ruling
// 2026-09-28: FENCE now, wire later — the wiring is below). This executor is
// not the email division's ledger: a run whose template resolves to a
// marketing stream (the library's own isMarketingSend over the resolved
// template and the automation's suppression group) must send ONLY through
// email-division/ledger.js sendWithLedger (eligibility, frequency caps,
// reservation idempotency, the final recipient/consent fence).
//
// The fence stays for every template the ledger does not own: the library
// refuses the send (ledger_required — no provider call, no email_messages
// row) on the live path and on the shadow preflight alike, and the run
// settles skipped.
const EXECUTOR_SEND_POLICY = Object.freeze({ marketingRequiresLedger: true });
function isLedgerRequiredRefusal(err) {
  const code = EmailTemplates.LEDGER_REQUIRED_CODE;
  return !!code && err?.code === code;
}

// The WIRING: the email division's own template keys dispatch through
// sendWithLedger instead of the direct sendTemplate call, and the library
// fence is lifted for that path ONLY. Decided from the template key alone
// (no database read) so every other run is byte-identical to before:
//   nurture.*  -> the 'nurture' ledger stream (marketing_nurture)
//   lc.*       -> the 'lifecycle' ledger stream (service_operational for the
//                 relationship keys; the ledger resolves referral / win-back
//                 keys to their marketing groups itself)
// The ledger stream's own group (eligibility.groupKeyFor) is what the send
// answers to; sendWithLedger passes it to the library as the suppression
// group, so the automation row's own group never overrides the ledger's.
const LEDGER_STREAM_BY_PREFIX = Object.freeze([['nurture.', 'nurture'], ['lc.', 'lifecycle']]);
function ledgerStreamFor(templateKey) {
  const key = String(templateKey || '');
  const match = LEDGER_STREAM_BY_PREFIX.find(([prefix]) => key.startsWith(prefix));
  return match ? match[1] : null;
}
// The send policy a run's library call carries: the ledger-routed path lifts
// the fence (it IS the ledger); everything else keeps it.
function sendPolicyFor(run) {
  return ledgerStreamFor(run.template_key) ? {} : EXECUTOR_SEND_POLICY;
}

// The class the ledger judges a send under. The prefix decides the ledger STREAM,
// never whether the mail is marketing: a template whose OWN stream is marketing_*
// (or whose mode is 'marketing') must be judged as marketing mail — opt-in
// (marketing_offers), the caps, the marketing unsubscribe group — even under an
// lc.* key, or the lifted fence would send it as plain relationship mail.
// Read from the template columns the automation load already selects (no extra
// query). undefined = let the ledger decide from stream and key.
// The classification is the LIBRARY's own (isMarketingSend), asked of each of the
// template's two stream fields — the library reads the group key OVER the stream,
// so a template with send_stream 'service_operational' and suppression group
// 'marketing_nurture' must not slip through as relationship mail here while a
// different sender would call it marketing: EITHER field marketing_*, or mode
// 'marketing', is marketing.
function ledgerMarketingClassFor(automation = {}) {
  const template = {
    mode: automation.template_mode,
    send_stream: automation.template_send_stream,
    suppression_group_key: automation.template_suppression_group_key,
  };
  const marketing = EmailTemplates.isMarketingSend(template, template.suppression_group_key)
    || EmailTemplates.isMarketingSend(template, template.send_stream);
  return marketing ? 'marketing' : undefined;
}

// Shadow's read-only mirror of the ledger's eligibility step: would
// reserveWithCap refuse this customer? Reads only (eligibleForEmail takes no
// lock and writes nothing), never reserves, never sends. A lookup failure is
// not a verdict — shadow fails OPEN on infrastructure, like every other
// best-effort check here.
async function shadowLedgerEligibility(run, stream, automation) {
  try {
    const { eligibleForEmail, REASONS } = require('./email-division/eligibility');
    const verdict = await eligibleForEmail({
      customerId: run.recipient_id, stream, emailKey: run.template_key, marketingClass: ledgerMarketingClassFor(automation),
    });
    if (verdict.ok || verdict.reason === REASONS.LOOKUP_FAILED) return { ok: true };
    return { ok: false, reason: `email division ledger: ${verdict.reason}`, code: 'ledger_ineligible' };
  } catch (err) {
    logger.warn(`[email-template-automation] shadow ledger eligibility failed for run ${run.id}: ${scrubSentryText(err && err.message ? err.message : err)}`);
    return { ok: true };
  }
}

// Runs the SAME pre-provider checks dispatchRun's sendTemplate call would
// hit (codex P2): disabled/missing template, required-variable validation,
// recipient suppression, and the estimate annual-offer guard. A block
// records the same audit-safe would_send metadata under event type
// 'would_block' with the library's own reason instead of finalizing
// 'shadow' — a suppressed recipient, an invalid template or a withheld
// annual offer no longer counts as rollout-readiness evidence it isn't.
// Never calls the provider, never writes email_messages, never throws into
// the caller: a preflight infrastructure hiccup (not a real block — the
// annual guard's own lookup failing included) fails OPEN to would_send,
// same posture as every other best-effort check in this file — an
// evidence-collection bug must not make shadow mode itself unreliable.
async function shadowPreflight(run, executionPayload, automation) {
  try {
    const stream = ledgerStreamFor(run.template_key);
    // The ledger-routed live path sends under the LEDGER's group for this
    // stream/key, not the automation row's: the preflight judges the same one.
    let suppressionGroupKey = automation.suppression_group_key || undefined;
    if (stream) {
      const { groupKeyFor, resolveMarketingClass } = require('./email-division/eligibility');
      suppressionGroupKey = groupKeyFor(stream, run.template_key, resolveMarketingClass(stream, run.template_key, ledgerMarketingClassFor(automation)));
    }
    const preflight = await EmailTemplates.preflightTemplateSend({
      templateKey: run.template_key,
      versionId: run.template_version_id || undefined,
      payload: executionPayload,
      to: run.recipient_email,
      suppressionGroupKey,
      // The same estimate id the live dispatchRun hands the annual-offer
      // guard (codex P2 round 5) — preflightTemplateSend runs the guard
      // itself (sendgrid-mail.js applyAnnualOfferGuard), so a withheld offer
      // is a would_block here exactly as it is a block live.
      ...annualGuardArgsFor(run),
      ...sendPolicyFor(run),
    });
    if (!preflight.ok || !stream) return preflight;
    // What reserveWithCap / the recipient fence would say live.
    return (await ledgerRecipientRefusal(run)) || shadowLedgerEligibility(run, stream, automation);
  } catch (err) {
    logger.warn(`[email-template-automation] shadow preflight failed for run ${run.id}: ${scrubSentryText(err && err.message ? err.message : err)}`);
    return { ok: true };
  }
}
// `refusal` is a verdict the caller already reached (a payload builder's
// skip): it settles exactly like a preflight refusal — would_block evidence,
// promotable in place once whatever blocked it is fixed (#5418).
async function finalizeShadowRun(run, automation, executionPayload = {}, refusal = null) {
  const preflight = refusal || await shadowPreflight(run, executionPayload, automation);
  const wouldSendMetadata = {
    automation_key: automation.automation_key,
    template_key: run.template_key,
    trigger_event_key: run.trigger_event_key,
    entity_type: run.entity_type || null,
    entity_id: run.entity_id || null,
    recipient_domain: recipientDomain(run.recipient_email),
    recipient_hash: recipientHash(run.recipient_email),
  };
  if (!preflight.ok) {
    const [blocked] = await db('email_template_automation_runs').where({ id: run.id }).update({
      status: 'skipped',
      exit_reason: preflight.reason || 'would_block',
      last_error: null,
      completed_at: new Date(),
      updated_at: new Date(),
    }).returning('*');
    await logRunEvent(run.id, 'would_block', preflight.reason || 'Shadow mode: the live send would have blocked pre-provider', {
      ...wouldSendMetadata,
      guard: isLedgerRequiredRefusal(preflight) ? 'ledger_required' : (preflight.code || 'preflight'),
    });
    return blocked || { ...run, status: 'skipped', exit_reason: preflight.reason || 'would_block' };
  }
  const [updated] = await db('email_template_automation_runs').where({ id: run.id }).update({
    status: 'shadow',
    last_error: null,
    completed_at: new Date(),
    updated_at: new Date(),
  }).returning('*');
  await logRunEvent(run.id, 'would_send', 'Shadow mode: would have sent — nothing dispatched', wouldSendMetadata);
  return updated || { ...run, status: 'shadow' };
}

// The ledger sends to the address its eligibility judged: the customer's
// own email. A run built for a DIFFERENT inbox (a lead's estimate address
// that is not the customer record's) must not be redirected there with a
// payload made for someone else's address — it is refused, never re-addressed.
// Returns null when the addresses agree, else a refusal.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function ledgerRecipientRefusal(run) {
  // A lead-type recipient id that is not a customers row never reaches the
  // database (a non-uuid id would throw, and a thrown lookup would retry a
  // fact no retry can change).
  if (!UUID_RE.test(String(run.recipient_id || ''))) {
    return { ok: false, reason: 'the run has no customer record to send to (the ledger needs one)', code: 'ledger_no_customer' };
  }
  const customer = await db('customers').where({ id: run.recipient_id }).first('email');
  const own = String(customer?.email || '').trim().toLowerCase();
  if (own && own === String(run.recipient_email || '').trim().toLowerCase()) return null;
  return {
    ok: false,
    reason: 'the run\'s recipient is not the customer record\'s own email address',
    code: 'ledger_recipient_mismatch',
  };
}

// A ledger DUPLICATE is an earlier operation under this run's key. Which one
// decides the run — never a blanket skip:
//   - a DIFFERENT owner (another run's message, another recipient): terminal skip;
//   - a confirmed delivery (ledger row sent, or the delivery authority shows the
//     message accepted / handed off): the run finalizes SENT with that message;
//   - a policy skip the ledger already recorded: terminal skip with its reason;
//   - an OUTSTANDING reservation (a crashed or still-running earlier attempt,
//     unexpired by construction — reserveWithCap settles expired ones first):
//     the run DEFERS through the existing bounded retry, so a crashed run that
//     was reclaimed is retried once the reservation settles instead of being
//     skipped forever without a send.
// A run is finalized SENT only on CONFIRMED delivery: a message the provider
// accepted (sent_at), or a ledger row sent by the normal settle or reconciled
// from an accepted message — never the ledger's uncertain completion
// (provider_handoff_uncertain), which exists to keep the caps honest.
const LEDGER_UNCERTAIN_REASON = 'provider_handoff_uncertain';
function ledgerDeliveryConfirmed(row, message) {
  if (message?.sent_at) return true;
  return row?.status === 'sent' && row.reason !== LEDGER_UNCERTAIN_REASON;
}
function deliveryUncertainError() {
  return Object.assign(new Error('email division delivery is unconfirmed: the provider handoff started but no acceptance was recorded'), { code: 'LEDGER_DELIVERY_UNCERTAIN' });
}

async function settleLedgerDuplicate(run, row) {
  const mine = String(run.recipient_email || '').trim().toLowerCase();
  if (String(row.recipient_email || '').trim().toLowerCase() !== mine) {
    return { skipReason: 'email division ledger: the reservation under this key belongs to a different recipient', skipGuard: 'ledger_duplicate_other_owner' };
  }
  const message = await db('email_messages').where({ idempotency_key: run.idempotency_key })
    .first('id', 'automation_run_id', 'sent_at', 'provider_handoff_phase');
  if (message?.automation_run_id && String(message.automation_run_id) !== String(run.id)) {
    return { skipReason: 'email division ledger: the message under this key belongs to a different run', skipGuard: 'ledger_duplicate_other_owner' };
  }
  if (ledgerDeliveryConfirmed(row, message)) {
    const messageId = row.email_message_id || message?.id || null;
    // The message is confirmed delivered but the ledger row was never settled
    // (markSent failed, or the worker died): complete it from the message so the
    // send counts toward the caps now rather than at the lease sweep. Best-effort
    // — the run IS delivered, and the sweep reconciles the same way if this fails.
    if (row.status !== 'sent' && message?.sent_at) {
      try {
        await require('./email-division/ledger').reconcileFromMessage(row.id);
      } catch (err) {
        logger.warn(`[email-template-automation] ledger reconcile failed for run ${run.id}: ${scrubSentryText(err && err.message ? err.message : err)}`);
      }
    }
    return { result: { sent: true, message: messageId ? { id: messageId } : null } };
  }
  // Handed to the provider but never confirmed (started, no sent_at; or the
  // ledger's own uncertain completion): not a delivery, and not retried blind.
  if (row.status === 'sent' || message?.provider_handoff_phase === 'started') throw deliveryUncertainError();
  if (row.status === 'reserved') {
    throw Object.assign(new Error('email division reservation under this key is still outstanding'), { code: 'LEDGER_RESERVATION_OUTSTANDING' });
  }
  return { skipReason: `email division ledger: an earlier attempt under this key settled ${row.status}${row.reason ? ` (${row.reason})` : ''}`, skipGuard: 'ledger_duplicate' };
}

// The run was built (payload, links) for an address the customer no longer
// has: a terminal skip, never a retarget — a later event builds a new run.
function recipientChangedSkip() {
  return {
    skipReason: 'the run was built for a previous email address: the customer\'s address changed before the send, so it was not sent',
    skipGuard: 'ledger_recipient_changed',
  };
}

// The estimate a nurture run is about changed hands (customer or email) or is no
// longer expired between the build and the provider boundary: terminal, never
// retargeted — its bearer link must not reach the old recipient.
function estimateChangedSkip(reason) {
  return {
    skipReason: {
      [ESTIMATE_NOT_EXPIRED]: 'the estimate is no longer expired; not sent',
      [ESTIMATE_EXPIRY_SUPERSEDED]: 'the estimate was extended and expired again since this run was created; a newer run owns the touch',
    }[reason] || 'the estimate\'s customer or email changed since this run was created; not sent to the old recipient',
    skipGuard: 'estimate_recipient_changed',
  };
}

// Ledger-routed dispatch (the wiring PR). Everything the library's
// sendTemplate does before the provider — template/version resolution,
// render + required variables, the unsubscribe/ASM compliance guard,
// recipient suppression, the placeholder guards, and the annual-offer guard
// inside sendOne — still runs: sendWithLedger calls sendTemplate itself, with
// the fence lifted (the ledger is the thing the fence pointed at) and the
// reservation's own idempotency key (= this run's key). What changes is the
// step BEFORE it: eligibility, the frequency caps and the reservation, and
// the consent re-check at the provider boundary.
//
// Returns { result } shaped like sendTemplate's result (dispatchRun settles it
// the usual way), { skipReason, skipGuard } for a refusal that is a POLICY
// verdict (terminal, never retried — cap, ineligible, fenced, duplicate), or
// throws for a failure the run's bounded retry policy handles (a provider /
// library error the ledger settled 'failed', or an eligibility lookup that
// could not read).
// A delivery this run's key already confirmed — checked BEFORE the current-address
// refusal: a run that was delivered and then crashed before finalizing must
// finalize SENT even if the customer changed email since (the address refusal is
// about a send that has not happened). Only a confirmed delivery short-circuits;
// every other duplicate state is judged by the normal path below.
async function confirmedLedgerDelivery(run) {
  if (!UUID_RE.test(String(run.recipient_id || '')) || !run.idempotency_key) return null;
  const row = await db('marketing_email_ledger').where({ idempotency_key: run.idempotency_key }).first();
  if (!row || String(row.customer_id) !== String(run.recipient_id)) return null;
  let settled;
  try {
    settled = await settleLedgerDuplicate(run, row);
  } catch {
    return null; // outstanding / uncertain: the normal path decides
  }
  return settled.result?.sent ? settled : null;
}

async function dispatchThroughLedger(run, automation, executionPayload, stream, onQueued) {
  const delivered = await confirmedLedgerDelivery(run);
  if (delivered) return delivered;
  const refusal = await ledgerRecipientRefusal(run);
  if (refusal) return { skipReason: refusal.reason, skipGuard: refusal.code };

  const { sendWithLedger } = require('./email-division/ledger');
  const { REASONS } = require('./email-division/eligibility');
  const out = await sendWithLedger({
    customerId: run.recipient_id,
    stream,
    emailKey: run.template_key,
    marketingClass: ledgerMarketingClassFor(automation),
    idempotencyKey: run.idempotency_key,
    // The address this run's payload was BUILT for. The ledger compares it at
    // the reservation and again at the provider handoff and refuses on a
    // mismatch — an email change after the build must never retarget it.
    expectedRecipientEmail: run.recipient_email,
    // Once per customer / estimate, decided inside the reservation under the
    // customer's advisory lock (null for a template with no such rule).
    ...ledgerGuardsFor(run),
    template: {
      templateKey: run.template_key,
      versionId: run.template_version_id || undefined,
      payload: executionPayload,
      triggerEventId: run.trigger_event_id,
      automationRunId: run.id,
      categories: ['email_template_automation', `automation_${run.automation_key}`],
      onQueued,
      ...annualGuardArgsFor(run),
    },
  });
  if (out.sent) return { result: { sent: true, message: out.message } };
  if (out.duplicate) return settleLedgerDuplicate(run, out.row);
  if (!out.row) {
    // Denied before any reservation (ineligible, a cap, a key conflict).
    if (out.reason === REASONS.LOOKUP_FAILED) {
      throw Object.assign(new Error('email division eligibility lookup failed'), { code: 'LEDGER_LOOKUP_FAILED' });
    }
    if (out.reason === REASONS.RECIPIENT_CHANGED) return recipientChangedSkip();
    if (out.reason === ESTIMATE_RECIPIENT_CHANGED || out.reason === ESTIMATE_NOT_EXPIRED || out.reason === ESTIMATE_EXPIRY_SUPERSEDED) return estimateChangedSkip(out.reason);
    if (out.reason === ONCE_ALREADY_DELIVERED) {
      return { skipReason: 'this customer (or estimate) already has a sent email of this kind; not sent again', skipGuard: 'already_delivered' };
    }
    if (out.reason === ONCE_IN_FLIGHT) {
      // A qualifying sibling holds a live reservation: this run waits for its
      // outcome through the bounded retry (sent -> skipped next time; failed or
      // abandoned -> this run sends). Never a terminal skip.
      throw Object.assign(new Error('another email of this kind is in flight for this customer (or estimate)'), { code: 'LEDGER_SIBLING_IN_FLIGHT' });
    }
    return { skipReason: `email division ledger refused the send: ${out.reason}`, skipGuard: 'ledger_refused' };
  }
  // A reservation existed: its settled status says what happened. The ledger
  // settles a fence / library block 'skipped', an abort or a dispatch error
  // 'failed', and a send the delivery authority shows went out 'sent'.
  const settled = await db('marketing_email_ledger').where({ id: out.row.id }).first('status', 'reason', 'email_message_id');
  if (settled?.status === 'sent' && ledgerDeliveryConfirmed(settled, null)) {
    return { result: { sent: true, message: settled.email_message_id ? { id: settled.email_message_id } : null } };
  }
  // A 'sent' row that is only an UNCERTAIN completion (the handoff started, the
  // provider failed or the response was lost) keeps counting toward the caps,
  // but is not a delivery: the run takes the same failed / hold path the direct
  // dispatch takes.
  if (settled?.status === 'sent') throw out.error || deliveryUncertainError();
  if (settled?.status === 'skipped' && settled.reason === REASONS.RECIPIENT_CHANGED) return recipientChangedSkip();
  if (settled?.status === 'skipped' && (settled.reason === ESTIMATE_RECIPIENT_CHANGED || settled.reason === ESTIMATE_NOT_EXPIRED || settled.reason === ESTIMATE_EXPIRY_SUPERSEDED)) {
    return estimateChangedSkip(settled.reason);
  }
  if (settled?.status === 'skipped') {
    return { skipReason: `email division ledger refused the send: ${settled.reason || out.reason}`, skipGuard: 'ledger_refused' };
  }
  // 'failed' (or an unsettled row): a thrown error takes the run's normal
  // bounded retry / final-failure path.
  throw out.error || Object.assign(new Error(`email division send failed: ${out.reason || 'unknown'}`), { code: 'LEDGER_SEND_FAILED' });
}

// Claim → send → settle / release for a prep run happen under the manual
// sender's per-customer `prep-send:<customer>` lock — the same lease the
// Communications composer's prep-link send and the Send prep guide button
// take — so neither can text this visit's page between this run's fresh
// claim and its release (pre-push Codex P1 on d5c33f299). A held lease is a
// transient failure: nothing was claimed, so the retry path re-runs the
// attempt later. Non-prep runs and prep runs without a customer recipient
// take no lock (there is no manual path to collide with).
const PREP_LOCK_HELD = 'prep send lock held by another sender';
async function withPrepSendLock(run, fn) {
  const customerId = isPrepRun(run) && String(run.recipient_type || '') === 'customer' ? run.recipient_id : null;
  if (!customerId) return fn();
  const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');
  const out = await runExclusive(`prep-send:${customerId}`, fn, { recordHealth: false, waitForSlot: false });
  if (wasLockSkipped(out)) throw new Error(PREP_LOCK_HELD);
  return out;
}

// One attempt's claim → provider → finalize, with the fresh-claim release
// on a conclusive no-delivery (prepUndelivered). Returns the finalized run
// row, or { skipReason } when the page belongs to another guide; rethrows a
// send failure for executeRun's retry / fail decision.
async function dispatchRun(run, automation, executionPayload) {
  const prepClaim = await claimPrepPageForRun(run);
  if (!prepClaim.owned) return { skipReason: prepClaim.delivered ? 'prep guide already delivered for this visit' : 'prep page owned by another guide' };
  let prepDispatched = false;
  try {
    // Fires immediately before the provider call — the dispatch boundary.
    const onQueued = () => { prepDispatched = true; };
    const ledgerStream = ledgerStreamFor(run.template_key);
    let result;
    if (ledgerStream) {
      const routed = await dispatchThroughLedger(run, automation, executionPayload, ledgerStream, onQueued);
      if (routed.skipReason) return { skipReason: routed.skipReason, skipGuard: routed.skipGuard };
      ({ result } = routed);
    } else {
      result = await EmailTemplates.sendTemplate({
        templateKey: run.template_key,
        versionId: run.template_version_id || undefined,
        to: run.recipient_email,
        payload: executionPayload,
        recipientType: run.recipient_type,
        recipientId: run.recipient_id,
        triggerEventId: run.trigger_event_id,
        automationRunId: run.id,
        idempotencyKey: run.idempotency_key,
        categories: ['email_template_automation', `automation_${run.automation_key}`],
        suppressionGroupKey: automation.suppression_group_key || undefined,
        onQueued,
        ...annualGuardArgsFor(run),
        ...sendPolicyFor(run),
      });
    }
    // Pre-push audit P1: a pre-dispatch abort (result.aborted — the annual
    // guard's own row lookup threw, or any other onQueued-style abort) is
    // NOT sent and NOT a deliberate block; finalizeSentRun only
    // distinguishes those two, so it would otherwise record a delivered
    // 'sent' run for a request that never reached the provider. Throw so it
    // retries through the SAME thrown-error path (scheduleRetry /
    // finalizeFailedRun below) as a genuine provider failure.
    if (result.aborted) {
      throw Object.assign(new Error(result.error || result.reason || 'email send aborted before dispatch'), {
        code: result.guardError ? 'ANNUAL_OFFER_GUARD_FAILED' : 'SEND_ABORTED_BEFORE_DISPATCH',
      });
    }
    const { status, updated } = await finalizeSentRun(run, result);
    await settlePrepAfterSend(run, prepClaim, status);
    return { updated };
  } catch (err) {
    // A fresh claim this attempt conclusively did not deliver on is handed
    // back NOW — before a retry as much as before the final failure: a
    // retried attempt finds the page keyed and reads it as owned-not-fresh,
    // so a claim carried into the retry would survive a conclusive final
    // failure and pin the visit to a guide nobody received (GH Codex #3856
    // r24 P2). The retry re-claims fresh, or is skipped if another guide
    // took the page meanwhile — the right answer either way.
    if (prepUndelivered(prepClaim, prepDispatched, err)) await releaseFreshPrepClaim(run);
    throw err;
  }
}

// The prep-send lease was held by a manual or composer send: nothing was
// claimed and the provider was never reached, so this is not a delivery
// attempt — the run goes back to runnable a minute out with its attempt
// count restored, never spending the retry budget on contention (GH Codex
// #3856 r27 P2).
const PREP_LOCK_DEFER_MS = 60 * 1000;
// Back to runnable a little later with the attempt count restored: not a
// delivery attempt, so it never spends the retry budget.
async function deferRun(run, attemptNumber, now, { delayMs, lastError, message }) {
  const runAfter = new Date(now.getTime() + delayMs);
  const [deferred] = await db('email_template_automation_runs').where({ id: run.id }).update({
    status: 'retry_scheduled',
    attempts: attemptNumber - 1,
    run_after: runAfter,
    next_retry_at: runAfter,
    last_error: lastError,
    updated_at: new Date(),
  }).returning('*');
  await logRunEvent(run.id, 'retry_scheduled', message, { next_retry_at: runAfter, attempt_consumed: false });
  return deferred || { ...run, status: 'retry_scheduled' };
}
function deferForPrepLock(run, attemptNumber, now) {
  return deferRun(run, attemptNumber, now, {
    delayMs: PREP_LOCK_DEFER_MS, lastError: PREP_LOCK_HELD, message: 'Deferred: prep send lock held by another sender',
  });
}

// A live ledger reservation (another attempt of this run's own send, e.g. a
// crashed worker's, or a live once-per-customer / estimate sibling) holds the send: wait for it the way a held prep lease waits — attempt restored, nothing
// spent. Bounded: the reservation lease (RESERVATION_LIFETIME_MS) is the most
// any one reservation can stay live, and the deferral count is capped at the
// number of delays that fit in it (plus slack); past the cap the normal
// retry / failure path decides, so this can never loop forever.
const LEDGER_DEFER_MS = 2 * 60 * 1000;
const LEDGER_DEFER_MESSAGE = 'Deferred: email division reservation outstanding';
const LEDGER_MAX_DEFERRALS = Math.ceil(RESERVATION_LIFETIME_MS / LEDGER_DEFER_MS) + 2;
const LEDGER_DEFER_CODES = new Set(['LEDGER_RESERVATION_OUTSTANDING', 'LEDGER_SIBLING_IN_FLIGHT']);
async function deferForLedger(run, attemptNumber, now, err) {
  const used = await db('email_template_automation_run_events')
    .where({ run_id: run.id, event_type: 'retry_scheduled' })
    .where('message', LEDGER_DEFER_MESSAGE)
    .count('* as n')
    .first();
  if (Number(used?.n || 0) >= LEDGER_MAX_DEFERRALS) return null;
  return deferRun(run, attemptNumber, now, { delayMs: LEDGER_DEFER_MS, lastError: err.message, message: LEDGER_DEFER_MESSAGE });
}

async function finalizeFailedRun(run, err, attemptNumber, retryPolicy) {
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
  return failed || { ...run, status: 'failed', last_error: err.message };
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

async function loadRunAndAutomation(runOrId, automation) {
  const run = typeof runOrId === 'string'
    ? await db('email_template_automation_runs').where({ id: runOrId }).first()
    : runOrId;
  if (!run) throw notFound('automation run not found');
  const resolvedAutomation = FINAL_STATUSES.has(run.status) ? null : (automation || await loadAutomationForRun(run));
  if (!resolvedAutomation && !FINAL_STATUSES.has(run.status)) throw notFound('automation not found for run');
  return { run, resolvedAutomation };
}

// origin_mode (stamped at creation) OUTRANKS the current gate read for
// 'shadow' — see the long note at its call site in executeRun.
function dispatchModeFor(run) {
  const dispatchMode = emailTemplateAutomationsMode();
  return { dispatchMode, shadowRun: asObject(run.context).origin_mode === 'shadow' || dispatchMode === 'shadow' };
}

// The email division's payload builders (nurture.* / lc.* templates with a
// real trigger): the run carries ids, the builder reads Waves' own data into
// the template's payload and SKIPS — never retried — when a required
// condition is not met. Runs on the shadow path too (read-only: shadow never
// mints or calls out), so shadow reports exactly what live would do: a live
// skip settles 'skipped' (guard payload_builder), a shadow skip is would_block
// evidence, promotable once the data supports the send. No builder for the
// key -> payload untouched. Returns { payload } to continue, or { settled }
// (the finalized run row).
async function applyPayloadBuilder(run, automation, payload, shadowRun, attemptNumber) {
  if (!hasPayloadBuilder(run.template_key)) return { payload };
  const built = await buildEmailDivisionPayload({ run, payload, mode: shadowRun ? 'shadow' : 'live' });
  if (!built.skip) return { payload: built.payload };
  if (shadowRun) {
    return { settled: await finalizeShadowRun(run, automation, payload, { ok: false, reason: built.reason, code: 'payload_builder' }) };
  }
  return {
    settled: await markRunSkipped(run, built.reason, { guard: 'payload_builder', code: built.code, attempt: attemptNumber }),
  };
}

const GATE_OFF_REASON = 'email template automations gate is off';

async function executeRun(runOrId, { automation, now = new Date() } = {}) {
  const { run, resolvedAutomation } = await loadRunAndAutomation(runOrId, automation);
  if (FINAL_STATUSES.has(run.status)) return run;
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

  // Gate OFF terminalizes, before anything else (codex P1 round 6 on
  // #5154): the scheduler now runs processDueRuns in off mode too, ONLY so
  // due delayed/retry runs are settled skipped (guard gate_off) instead of
  // sitting runnable through the outage and then sending stale copy the
  // moment the gate returns — the same drop-on-rollback posture as the
  // live -> shadow rollback below. No entity reads, no shadow preflight, no
  // provider call. A skipped run is terminal, so re-enabling the gate never
  // sends it.
  if (emailTemplateAutomationsMode() === 'off') {
    return markRunSkipped(claimedRun, GATE_OFF_REASON, { guard: 'gate_off', attempt: attemptNumber });
  }

  try {
    const storedPayload = asObject(claimedRun.payload);
    const livePayload = await livePayloadForRun(claimedRun, storedPayload);
    // Hard invariant, not a catalog-configurable exit/condition (codex P1):
    // a review.linked_5star run whose review was reattributed, edited below
    // five stars, dismissed, or removed since it was queued — or an
    // estimate.expired run whose estimate was revived through /extend or no
    // longer exists (codex P1 round 3) — must never dispatch on stale
    // evidence. livePayloadForRun's 'review'/'estimate' branches signal this
    // with __blocked rather than a normal field refresh.
    if (livePayload.__blocked) {
      return markRunSkipped(claimedRun, livePayload.__blocked, {
        guard: `${String(claimedRun.entity_type || 'entity')}_invalid`,
        attempt: attemptNumber,
      });
    }
    let executionPayload = { ...storedPayload, ...livePayload };
    const exitReason = exitReasonFor(asObject(resolvedAutomation.exit_conditions), executionPayload);
    if (exitReason) {
      return markRunSkipped(claimedRun, exitReason, { guard: 'exit_conditions', attempt: attemptNumber });
    }
    const conditionFailure = conditionFailureFor(asObject(resolvedAutomation.conditions), executionPayload, now);
    if (conditionFailure) {
      return markRunSkipped(claimedRun, conditionFailure, { guard: 'conditions', attempt: attemptNumber });
    }
    // Shadow/off chokepoint: the run has cleared every guard a live send
    // would clear (exit conditions, conditions) and is exactly at the point
    // dispatchRun would call the email library. This single spot covers
    // BOTH callers of executeRun (processTrigger's immediate path and
    // processDueRuns' due-run sweep), since both funnel through here.
    // origin_mode (stamped at creation, contextFor) OUTRANKS the current
    // gate read for 'shadow' (codex P1): a run created while shadow was
    // promised to finalize as would_send must keep that promise even if a
    // delay/retry lets the gate flip to 'true' before it becomes due — only
    // the shadow->live promotion path may advance origin_mode to 'live'.
    // Absent a stamp (rows predating this fix) falls through to today's
    // current-gate read.
    // Rollback semantics (documented per pre-push audit): the current-gate
    // read also means a LIVE-origin run that comes due after the gate is
    // rolled back true -> shadow finalizes 'shadow', unsent. Deliberate:
    // shadow is the stop-sending lever, and a rollback that let already
    // queued live sends keep going would not stop anything. That run's send
    // is dropped, not deferred — its trigger's intent marker was settled
    // 'processed' when the run was created, so nothing replays it; a later
    // re-flip to live sends only events from then on.
    const { dispatchMode, shadowRun } = dispatchModeFor(claimedRun);
    const built = await applyPayloadBuilder(claimedRun, resolvedAutomation, executionPayload, shadowRun, attemptNumber);
    if (built.settled) return built.settled;
    executionPayload = built.payload;
    if (shadowRun) {
      return finalizeShadowRun(claimedRun, resolvedAutomation, executionPayload);
    }
    // Fail-closed (codex P1): a run already sitting in the queue (created
    // while the gate was on) must not dispatch a real email just because
    // the gate read 'off' by the time this run became due — the boolean
    // entry callers gate creation on is a load-time snapshot in non-prod
    // (always true) and can be stale in prod too. Skipped, not silently
    // dropped: the row + event stay as an audit trail of what didn't send.
    if (dispatchMode === 'off') {
      return markRunSkipped(claimedRun, GATE_OFF_REASON, { guard: 'gate_off', attempt: attemptNumber });
    }
    const outcome = await withPrepSendLock(claimedRun, () => dispatchRun(claimedRun, resolvedAutomation, executionPayload));
    if (outcome.skipReason) {
      return markRunSkipped(claimedRun, outcome.skipReason, { guard: outcome.skipGuard || 'prep_page_owned', attempt: attemptNumber });
    }
    return outcome.updated;
  } catch (err) {
    if (err.message === PREP_LOCK_HELD) return deferForPrepLock(claimedRun, attemptNumber, now);
    if (LEDGER_DEFER_CODES.has(err.code)) {
      const deferred = await deferForLedger(claimedRun, attemptNumber, now, err);
      if (deferred) return deferred;
    }
    // A deterministic refusal, not a failure: never retried (the template's
    // stream cannot change under a retry), settled skipped with its own
    // guard so it reads as "belongs to the ledger", not "broke".
    if (isLedgerRequiredRefusal(err)) {
      return markRunSkipped(claimedRun, err.message, { guard: 'ledger_required', attempt: attemptNumber });
    }
    if (attemptNumber < retryPolicy.maxAttempts) {
      return scheduleRetry(claimedRun, err, attemptNumber, retryPolicy, now);
    }
    return finalizeFailedRun(claimedRun, err, attemptNumber, retryPolicy);
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
  RUNNABLE_STATUSES,
  RUNNING_STALE_AFTER_MS,
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
