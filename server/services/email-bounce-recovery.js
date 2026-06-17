/**
 * Email bounce → transcription recovery.
 *
 * When a transactional/service email HARD-bounces because the recipient address
 * has a domain-level transcription typo (e.g. "jane@gmial.com" captured on a
 * phone call), this service:
 *   1. corrects the DOMAIN only (never the local part — see email-typo-correction.js)
 *   2. re-sends the EXACT stored snapshot (html/text/subject) to the fixed address
 *   3. once the corrected address actually DELIVERS, overwrites the stored
 *      customer email and records an audit trail.
 *
 * Behaviour is fully automatic above a confidence threshold (default: high).
 * Env:
 *   EMAIL_BOUNCE_RECOVERY          'off' to disable entirely (default on)
 *   EMAIL_RECOVERY_MIN_CONFIDENCE  'high' (default) | 'medium' | 'low'
 *
 * Wiring: called best-effort from the SendGrid event webhook AFTER the event's
 * DB transaction commits — never inside it, because the re-send is a network
 * call. See server/routes/webhooks-sendgrid.js.
 */

const db = require('../models/db');
const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const emailLib = require('./email-template-library');
const NotificationService = require('./notification-service');
const { correctEmailDomain, meetsConfidence } = require('../utils/email-typo-correction');

const RECOVERY_CATEGORY = 'bounce_recovery';
// Customer columns that can hold a sendable address. We overwrite whichever one
// held the bounced address. Hardcoded constant — safe to interpolate into SQL.
const CUSTOMER_EMAIL_FIELDS = ['email', 'service_contact_email', 'service_contact2_email', 'service_contact3_email'];

function recoveryEnabled() {
  return String(process.env.EMAIL_BOUNCE_RECOVERY || '').toLowerCase() !== 'off';
}

function minConfidence() {
  const v = String(process.env.EMAIL_RECOVERY_MIN_CONFIDENCE || 'high').toLowerCase();
  return ['high', 'medium', 'low'].includes(v) ? v : 'high';
}

function redactEmail(value) {
  if (!value || typeof value !== 'string') return '';
  const [local, domain] = value.split('@');
  if (!domain) return '[redacted]';
  return `${local.slice(0, 2)}***@${domain}`;
}

/**
 * Is this a TRUE hard bounce (address/domain bad), as opposed to a soft
 * 'blocked' (IP reputation / rate-limit, transient) or a 'dropped' due to an
 * existing suppression (no signal the address itself is wrong)? Mirrors the
 * bounce branch of webhooks-sendgrid.js `suppressionForEmailEvent`.
 */
function isHardBounceEvent(ev) {
  const event = String(ev?.event || '').toLowerCase();
  const reason = String(ev?.reason || ev?.response || ev?.type || '').trim().toLowerCase();
  if (event === 'bounce') {
    const type = String(ev?.type || '').trim().toLowerCase();
    return !type || type === 'bounce' || type === 'hard';
  }
  if (event === 'dropped') {
    return reason === 'bounced address' || reason === 'invalid';
  }
  return false;
}

function parseJsonArray(value) {
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

/** True when an email_messages row is itself a recovery re-send (loop guard). */
function isRecoveryMessage(message) {
  return parseJsonArray(message?.categories).includes(RECOVERY_CATEGORY);
}

function uniqueCategories(values = []) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const s = String(v || '').trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function mergeMeta(rec, extra) {
  let base = {};
  const raw = rec?.metadata;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) base = raw;
  else if (typeof raw === 'string') {
    try { base = JSON.parse(raw) || {}; } catch { base = {}; }
  }
  return JSON.stringify({ ...base, ...extra });
}

/**
 * Pure decision: given a correction candidate, the configured threshold, and
 * whether the corrected address is itself suppressed, decide what to do.
 * Extracted so the gating logic is unit-testable without a DB.
 */
function decideRecoveryAction({ candidate, suppressed, min = 'high' }) {
  if (!candidate) return { action: 'skip', status: 'no_candidate' };
  if (!meetsConfidence(candidate.confidence, min)) {
    return { action: 'skip', status: 'skipped_low_confidence' };
  }
  if (suppressed) return { action: 'skip', status: 'corrected_suppressed' };
  return { action: 'send', status: 'resent' };
}

function asmGroupIdForStream(streamKey) {
  const s = String(streamKey || '').toLowerCase();
  if (s === 'transactional_required') return 0; // bypass suppression groups
  if (s.startsWith('marketing_')) return sendgrid.newsletterGroupId();
  return sendgrid.serviceGroupId();
}

/** Does the corrected address have an active suppression that should block a resend? */
async function correctedAddressSuppressed(bouncedMessage, correctedEmail) {
  try {
    const loaded = bouncedMessage.template_key
      ? await emailLib.loadTemplateByKey(bouncedMessage.template_key)
      : null;
    if (loaded?.template) {
      const supp = await emailLib.activeSuppressionFor(
        loaded.template,
        correctedEmail,
        bouncedMessage.suppression_group_key_snapshot || undefined,
      );
      return !!supp;
    }
  } catch (err) {
    logger.warn(`[bounce-recovery] suppression check fell back: ${err.message}`);
  }
  const row = await db('email_suppressions')
    .whereRaw('LOWER(email) = ?', [String(correctedEmail).trim().toLowerCase()])
    .where({ status: 'active' })
    .whereIn('suppression_type', ['bounce', 'spam_complaint', 'do_not_email'])
    .first()
    .catch(() => null);
  return !!row;
}

/** Resolve the customer + which email column held the bounced address. */
async function resolveCustomerEmailField(bouncedMessage, bouncedEmail) {
  let customer = null;
  if (String(bouncedMessage.recipient_type || '').toLowerCase() === 'customer' && bouncedMessage.recipient_id) {
    customer = await db('customers').where({ id: bouncedMessage.recipient_id }).first().catch(() => null);
  }
  if (!customer) {
    customer = await db('customers')
      .where((q) => {
        for (const f of CUSTOMER_EMAIL_FIELDS) q.orWhereRaw(`LOWER(${f}) = ?`, [bouncedEmail]);
      })
      .first()
      .catch(() => null);
  }
  if (!customer) return null;
  const field = CUSTOMER_EMAIL_FIELDS.find(
    (f) => String(customer[f] || '').trim().toLowerCase() === bouncedEmail,
  ) || null;
  return { customerId: customer.id, field };
}

/** Re-send the original message's stored snapshot to the corrected address. */
async function resendSnapshot(bouncedMessage, correctedEmail, recoveryId) {
  const now = new Date();
  const categories = uniqueCategories([...parseJsonArray(bouncedMessage.categories), RECOVERY_CATEGORY]);
  const idempotencyKey = `bounce_recovery:${bouncedMessage.id}`;

  const row = {
    provider: 'sendgrid',
    template_id: bouncedMessage.template_id || null,
    template_version_id: bouncedMessage.template_version_id || null,
    template_key: bouncedMessage.template_key || null,
    suppression_group_key_snapshot: bouncedMessage.suppression_group_key_snapshot || '',
    recipient_type: bouncedMessage.recipient_type || null,
    recipient_id: bouncedMessage.recipient_id || null,
    recipient_email_snapshot: correctedEmail,
    from_name_snapshot: bouncedMessage.from_name_snapshot || 'Waves Pest Control',
    from_email_snapshot: bouncedMessage.from_email_snapshot || 'contact@wavespestcontrol.com',
    reply_to_snapshot: bouncedMessage.reply_to_snapshot || 'contact@wavespestcontrol.com',
    subject_snapshot: bouncedMessage.subject_snapshot || '',
    html_snapshot: bouncedMessage.html_snapshot || null,
    text_snapshot: bouncedMessage.text_snapshot || null,
    payload_snapshot: JSON.stringify({
      bounce_recovery: true,
      recovery_id: recoveryId,
      original_message_id: bouncedMessage.id,
      original_email: bouncedMessage.recipient_email_snapshot || null,
    }),
    categories: JSON.stringify(categories),
    status: 'queued',
    idempotency_key: idempotencyKey,
    queued_at: now,
    created_at: now,
    updated_at: now,
  };

  let message;
  try {
    [message] = await db('email_messages').insert(row).returning('*');
  } catch (err) {
    // A prior partial attempt may already have created the row.
    const existing = await db('email_messages').where({ idempotency_key: idempotencyKey }).first().catch(() => null);
    if (!existing) throw err;
    if (existing.status === 'sent' && existing.provider_message_id) {
      return { ok: true, messageRowId: existing.id, reused: true };
    }
    message = existing;
  }

  try {
    const result = await sendgrid.sendOne({
      to: correctedEmail,
      fromEmail: message.from_email_snapshot,
      fromName: message.from_name_snapshot,
      replyTo: message.reply_to_snapshot,
      subject: message.subject_snapshot,
      html: bouncedMessage.html_snapshot || undefined,
      text: bouncedMessage.text_snapshot || undefined,
      categories,
      asmGroupId: asmGroupIdForStream(bouncedMessage.suppression_group_key_snapshot),
    });
    await db('email_messages').where({ id: message.id }).update({
      status: 'sent',
      provider_message_id: result.messageId,
      sent_at: new Date(),
      updated_at: new Date(),
    });
    return { ok: true, messageRowId: message.id };
  } catch (err) {
    await db('email_messages').where({ id: message.id }).update({
      status: 'failed',
      error_message: String(err.message || err).slice(0, 1000),
      updated_at: new Date(),
    }).catch(() => {});
    return { ok: false, error: String(err.message || err) };
  }
}

/**
 * Entry point for a hard-bounce event on a tracked email_messages row.
 * Best-effort; never throws.
 */
async function attemptRecovery(bouncedMessage, ev = {}) {
  try {
    if (!recoveryEnabled()) return { skipped: 'disabled' };
    if (!bouncedMessage || !bouncedMessage.id) return { skipped: 'no_message' };

    // Loop guard: a recovery re-send that itself bounced must NOT recurse.
    if (isRecoveryMessage(bouncedMessage)) {
      return await handleRecoveryBounce(bouncedMessage, ev);
    }

    const bouncedEmail = String(bouncedMessage.recipient_email_snapshot || '').trim().toLowerCase();
    if (!bouncedEmail) return { skipped: 'no_recipient' };

    // One recovery per original message (idempotent across webhook redelivery).
    const inserted = await db('email_bounce_recoveries')
      .insert({
        original_message_id: bouncedMessage.id,
        bounced_email: bouncedEmail,
        status: 'pending',
        metadata: JSON.stringify({
          bounce_event_id: ev.sg_event_id || null,
          bounce_reason: ev.reason || ev.response || ev.type || null,
        }),
      })
      .onConflict('original_message_id')
      .ignore()
      .returning('id');
    if (!inserted.length) return { skipped: 'already_attempted' };
    const recoveryId = inserted[0].id || inserted[0];

    const candidate = correctEmailDomain(bouncedEmail);
    const match = await resolveCustomerEmailField(bouncedMessage, bouncedEmail);
    const suppressed = candidate ? await correctedAddressSuppressed(bouncedMessage, candidate.corrected) : false;
    const decision = decideRecoveryAction({ candidate, suppressed, min: minConfidence() });

    const baseUpdate = {
      corrected_email: candidate?.corrected || null,
      correction_rule: candidate?.rule || null,
      confidence: candidate?.confidence || null,
      customer_id: match?.customerId || null,
      customer_email_field: match?.field || null,
      updated_at: new Date(),
    };

    if (decision.action === 'skip') {
      await db('email_bounce_recoveries').where({ id: recoveryId }).update({ ...baseUpdate, status: decision.status });
      if (decision.status === 'no_candidate' || decision.status === 'corrected_suppressed') {
        await alertUnrecoverableBounce({ bouncedMessage, bouncedEmail, customerId: match?.customerId, status: decision.status });
      }
      logger.info(`[bounce-recovery] ${decision.status} for ${redactEmail(bouncedEmail)} (${bouncedMessage.template_key || 'email'})`);
      return { skipped: decision.status };
    }

    const sendResult = await resendSnapshot(bouncedMessage, candidate.corrected, recoveryId);
    if (!sendResult.ok) {
      await db('email_bounce_recoveries').where({ id: recoveryId }).update({
        ...baseUpdate,
        status: 'send_failed',
        metadata: mergeMeta({ metadata: baseUpdate.metadata }, { send_error: sendResult.error }),
      });
      logger.warn(`[bounce-recovery] resend failed for ${redactEmail(candidate.corrected)}: ${sendResult.error}`);
      return { error: sendResult.error };
    }

    await db('email_bounce_recoveries').where({ id: recoveryId }).update({
      ...baseUpdate,
      status: 'resent',
      recovery_message_id: sendResult.messageRowId,
    });
    logger.info(`[bounce-recovery] re-sent ${bouncedMessage.template_key || 'email'} ${redactEmail(bouncedEmail)} → ${redactEmail(candidate.corrected)} (${candidate.rule}/${candidate.confidence})`);
    return { resent: true, corrected: candidate.corrected, rule: candidate.rule };
  } catch (err) {
    logger.error(`[bounce-recovery] attemptRecovery failed: ${err.message}`);
    return { error: err.message };
  }
}

/**
 * The recovery re-send DELIVERED. Commit the correction to the customer record
 * (auto-overwrite the column that held the bad address) and audit it.
 * Idempotent; best-effort; never throws.
 */
async function commitRecoveryOnDelivery(recoveryMessage) {
  try {
    if (!recoveryMessage?.id) return;
    const rec = await db('email_bounce_recoveries').where({ recovery_message_id: recoveryMessage.id }).first();
    if (!rec) return;
    if (rec.record_updated || rec.status === 'committed') return; // already done

    const correctedEmail = String(rec.corrected_email || recoveryMessage.recipient_email_snapshot || '').trim().toLowerCase();
    const bouncedEmail = String(rec.bounced_email || '').trim().toLowerCase();

    let recordUpdated = false;
    let updatedField = null;

    if (rec.customer_id && rec.customer_email_field && correctedEmail
        && CUSTOMER_EMAIL_FIELDS.includes(rec.customer_email_field)) {
      const field = rec.customer_email_field;
      // Guard the UNIQUE primary email column: never overwrite onto an address
      // already owned by a different customer.
      if (field === 'email') {
        const clash = await db('customers')
          .whereRaw('LOWER(email) = ?', [correctedEmail])
          .whereNot({ id: rec.customer_id })
          .first('id')
          .catch(() => null);
        if (clash) {
          await db('email_bounce_recoveries').where({ id: rec.id }).update({
            status: 'delivered',
            updated_at: new Date(),
            metadata: mergeMeta(rec, { commit_skipped: 'email_in_use' }),
          });
          await alertEmailCollision({ recovery: rec, correctedEmail });
          return;
        }
      }
      // Only overwrite if the column STILL holds the bad address — a human edit
      // may have raced us, in which case we leave their value alone.
      const affected = await db('customers')
        .where({ id: rec.customer_id })
        .whereRaw(`LOWER(${field}) = ?`, [bouncedEmail])
        .update({ [field]: correctedEmail, updated_at: new Date() })
        .catch((err) => {
          logger.warn(`[bounce-recovery] customer ${field} overwrite failed: ${err.message}`);
          return 0;
        });
      recordUpdated = Number(affected) > 0;
      updatedField = recordUpdated ? field : null;
    }

    await db('email_bounce_recoveries').where({ id: rec.id }).update({
      status: 'committed',
      record_updated: recordUpdated,
      committed_at: new Date(),
      updated_at: new Date(),
      metadata: mergeMeta(rec, { committed_field: updatedField }),
    });

    await notifyRecoverySuccess({ recovery: rec, bouncedEmail, correctedEmail, recordUpdated, field: updatedField });
    logger.info(`[bounce-recovery] committed ${redactEmail(bouncedEmail)} → ${redactEmail(correctedEmail)} (record_updated=${recordUpdated})`);
  } catch (err) {
    logger.error(`[bounce-recovery] commitRecoveryOnDelivery failed: ${err.message}`);
  }
}

/** The recovery re-send itself hard-bounced — record it and alert a human. */
async function handleRecoveryBounce(recoveryMessage, ev) {
  try {
    const rec = await db('email_bounce_recoveries').where({ recovery_message_id: recoveryMessage.id }).first().catch(() => null);
    if (rec && rec.status !== 'redelivered_bounced') {
      await db('email_bounce_recoveries').where({ id: rec.id }).update({
        status: 'redelivered_bounced',
        updated_at: new Date(),
        metadata: mergeMeta(rec, { redeliver_bounce_reason: ev?.reason || ev?.response || ev?.type || null }),
      });
      await alertUnrecoverableBounce({
        bouncedMessage: recoveryMessage,
        bouncedEmail: recoveryMessage.recipient_email_snapshot,
        customerId: rec.customer_id,
        status: 'redelivered_bounced',
      });
    }
  } catch (err) {
    logger.error(`[bounce-recovery] handleRecoveryBounce failed: ${err.message}`);
  }
  return { skipped: 'recovery_message_rebounced' };
}

// --- admin notifications (deduped) ---------------------------------------

async function adminAlertDeduped({ dedupeKey, windowHours = 168, category = 'alert', title, body, link, metadata = {} }) {
  try {
    const existing = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
      .where('created_at', '>=', db.raw("now() - (?::int * interval '1 hour')", [windowHours]))
      .first('id')
      .catch(() => null);
    if (existing) return;
    await NotificationService.notifyAdmin(category, title, body, { link, metadata: { dedupeKey, ...metadata } });
  } catch (err) {
    logger.warn(`[bounce-recovery] admin alert failed: ${err.message}`);
  }
}

async function alertUnrecoverableBounce({ bouncedMessage, bouncedEmail, customerId, status }) {
  // Marketing bounces are noise here — the suppression ledger already handles them.
  const stream = String(bouncedMessage?.suppression_group_key_snapshot || '').toLowerCase();
  if (stream.startsWith('marketing_')) return;
  const email = String(bouncedEmail || '').trim().toLowerCase();
  if (!email) return;
  const reasonLabel = status === 'redelivered_bounced'
    ? 'the corrected address also bounced'
    : 'no safe address correction was possible';
  await adminAlertDeduped({
    dedupeKey: `bounce-recovery-unrecoverable:${email}`,
    windowHours: 168,
    category: 'alert',
    title: 'Email bounced — needs a correct address',
    body: `${email} hard-bounced on a ${bouncedMessage?.template_key || 'service'} email and ${reasonLabel}. Check/update the address on file.`,
    link: customerId ? `/admin/customers/${customerId}` : '/admin/communications',
    metadata: { customer_id: customerId || null, original_message_id: bouncedMessage?.id || null, status },
  });
}

async function alertEmailCollision({ recovery, correctedEmail }) {
  await adminAlertDeduped({
    dedupeKey: `bounce-recovery-collision:${recovery.id}`,
    windowHours: 168,
    category: 'alert',
    title: 'Bounced email recovered, but address is in use',
    body: `A bounced email was re-sent and delivered to ${correctedEmail}, but that address already belongs to another customer, so the record was not updated. Reconcile manually.`,
    link: recovery.customer_id ? `/admin/customers/${recovery.customer_id}` : '/admin/communications',
    metadata: { customer_id: recovery.customer_id || null, recovery_id: recovery.id },
  });
}

async function notifyRecoverySuccess({ recovery, bouncedEmail, correctedEmail, recordUpdated, field }) {
  await adminAlertDeduped({
    dedupeKey: `bounce-recovery-committed:${recovery.id}`,
    windowHours: 24,
    category: 'system',
    title: 'Recovered a bounced email',
    body: `Corrected ${bouncedEmail} → ${correctedEmail} (${recovery.correction_rule || 'domain fix'}) and the re-send delivered.${recordUpdated ? ` Updated ${field} on the customer record.` : ''}`,
    link: recovery.customer_id ? `/admin/customers/${recovery.customer_id}` : '/admin/communications',
    metadata: { customer_id: recovery.customer_id || null, recovery_id: recovery.id, record_updated: recordUpdated },
  });
}

module.exports = {
  RECOVERY_CATEGORY,
  recoveryEnabled,
  minConfidence,
  isHardBounceEvent,
  isRecoveryMessage,
  decideRecoveryAction,
  asmGroupIdForStream,
  attemptRecovery,
  commitRecoveryOnDelivery,
  handleRecoveryBounce,
  // exported for tests
  resolveCustomerEmailField,
  correctedAddressSuppressed,
  CUSTOMER_EMAIL_FIELDS,
};
