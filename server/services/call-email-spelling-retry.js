/**
 * Automation-path resend to the other spelling of a call-captured email (owner 2026-11-05, GATE_CALL_BOUNCE_OTHER_SPELLING):
 * "if first email fails, then second email tries; if email goes through, we replace the email that worked into the
 * customer profile". No read-back card, no ACT email on this path.
 *
 * The first email a new lead gets goes out through automation-runner (automation_step_sends), not the email_messages
 * ledger email-bounce-recovery.js works from. When that send hard-bounces and the call that supplied the address
 * recorded `ai_extraction.email_spelling_settled` (the two extraction passes disagreed until the spelled letters settled
 * it), the webhook (routes/webhooks-sendgrid.js handleAutomationEvent, in its event transaction) calls these functions:
 *
 *   onAutomationHardBounce  the bounced step is sent again, to the other spelling, on the next runner tick
 *                           (rewindEnrollmentToStep), and a call_email_spelling_retries row (UNIQUE customer +
 *                           bounced address) records it, so it happens at most once. Or, when the bounced send was
 *                           itself that retry, the row becomes `failed`.
 *   onAutomationDelivered   a send to the retry address DELIVERED: the customer email that held the bounced address
 *                           is replaced with it (the same fanout the rescue's auto-apply uses), the row is
 *                           `committed`, and one audit row is written.
 *
 * Same safety as the ledger path: a positive link (the enrollment's customer is the source call's customer and holds the
 * bounced address as primary email), not the same Gmail inbox, no active suppression on the other spelling, not owned by
 * another customer or lead, never tried before for this customer + address, fail closed (any error before the first
 * write returns "no retry" and the webhook does what it does today). Gate off = today's behavior.
 */
const db = require('../models/db');
const logger = require('./logger');
const { callBounceOtherSpellingLive } = require('../config/feature-gates');

const TABLE = 'call_email_spelling_retries';
const CHANNEL = 'automation';
const NO_RETRY = Object.freeze({ retried: false });

const norm = (value) => String(value || '').trim().toLowerCase();

function enrollmentRole(enrollment) {
  const meta = enrollment?.metadata;
  if (meta && typeof meta === 'object') return meta.recipient_role || null;
  try { return JSON.parse(meta || '{}').recipient_role || null; } catch { return null; }
}

/** The settled other spelling for this send's customer + address, after every safety check, or null. */
async function eligibleOtherSpelling({ enrollment, bounced }, client) {
  if (!enrollment?.customer_id || !['active', 'completed'].includes(enrollment.status)) return null;
  // A step addressed to an on-location contact follows that contact's own address rules; the holder's address only.
  if (norm(enrollment.email) !== bounced || enrollmentRole(enrollment)) return null;
  const template = await client('automation_templates').where({ key: enrollment.template_key }).first('asm_group');
  // Marketing-stream bounces belong to the suppression ledger and never rewrite a contact's email.
  if (!template || String(template.asm_group || 'service').trim().toLowerCase() === 'newsletter') return null;
  const customer = await client('customers').where({ id: enrollment.customer_id }).whereNull('deleted_at').first('id', 'email');
  if (!customer || norm(customer.email) !== bounced) return null;

  const recovery = require('./email-bounce-recovery');
  const { findSourceCall } = require('./email-bounce-reverify');
  const call = await findSourceCall({
    bouncedEmail: bounced, customerId: customer.id, onlyCustomerId: customer.id, requireRecording: false, requireSettled: true,
  });
  if (!call || String(call.customer_id || '') !== String(customer.id)) return null;
  const other = recovery.settledOtherSpelling(call.ai_extraction, bounced);
  if (!other) return null;

  const { suppressionCoversEmail } = require('../utils/email-equivalence');
  const suppressed = await client('email_suppressions').where(suppressionCoversEmail(other)).where({ status: 'active' }).first('id');
  if (suppressed) return null;
  if (await recovery.correctedAddressOwnedByOther(other, customer.id, client)) return null;
  return { other, sourceCallId: call.id, customerId: customer.id };
}

async function startRetry({ sendRow, bounced }, client) {
  const enrollment = await client('automation_enrollments').where({ id: sendRow.enrollment_id }).forUpdate().first();
  if (!enrollment || !sendRow.step_id) return NO_RETRY;
  const found = await eligibleOtherSpelling({ enrollment, bounced }, client);
  if (!found) return NO_RETRY;

  const [row] = await client(TABLE).insert({
    customer_id: found.customerId,
    source_call_id: found.sourceCallId,
    bounced_email: bounced,
    retry_email: found.other,
    channel: CHANNEL,
    origin_send_id: sendRow.id,
    status: 'resending',
  }).onConflict(['customer_id', 'bounced_email']).ignore().returning(['id']);
  if (!row) return NO_RETRY; // tried before for this customer + address: never twice

  const { rewindEnrollmentToStep } = require('./automation-runner');
  const rewound = await rewindEnrollmentToStep({ enrollment, stepId: sendRow.step_id, email: found.other }, client);
  if (!rewound) {
    // A later step already went out or the cursor moved: nothing is re-sent, the webhook cancels as it does today.
    await client(TABLE).where({ id: row.id }).update({ status: 'skipped', reason: 'sequence_cursor_moved', updated_at: new Date() });
    return NO_RETRY;
  }
  // The customer's other live enrollments to the same address follow it (no step is re-sent for them).
  await client('automation_enrollments')
    .where({ customer_id: found.customerId, status: 'active' })
    .whereNot({ id: enrollment.id })
    .whereRaw('LOWER(email) = ?', [bounced])
    .whereRaw("COALESCE(metadata->>'recipient_role', '') = ''")
    .update({ email: found.other, updated_at: new Date() });
  logger.info(`[call-email-spelling-retry] automation step re-queued for customer ${found.customerId} to the other spelling`);
  return { retried: true, retryEmail: found.other };
}

/** A send to a retry address hard-bounced: the row fails. Returns { retryFailed, bouncedEmail } or null. */
async function settleRetryBounce({ sendRow, address }, client) {
  const row = await client(TABLE).where({ retry_email: address, channel: CHANNEL, status: 'resending' }).forUpdate().first();
  if (!row) return null;
  const own = await client('automation_enrollments').where({ id: sendRow.enrollment_id, customer_id: row.customer_id }).first('id');
  if (!own) return null;
  await client(TABLE).where({ id: row.id }).update({
    status: 'failed', reason: 'retry_address_bounced', retry_send_id: sendRow.id, updated_at: new Date(),
  });
  return { retryFailed: true, bouncedEmail: row.bounced_email };
}

/**
 * The webhook's hard-bounce hook for an automation send (the caller passes true bounces only: ev.type === 'bounce').
 * Returns { retried: true, retryEmail } (re-queued: the caller must not cancel, alert or rescue), { retryFailed: true,
 * bouncedEmail } (the retry address bounced: the caller cancels as today and alerts, no rescue or card), or { retried:
 * false } (today's behavior). Never throws: a failure before the first write returns "no retry".
 */
async function onAutomationHardBounce({ ev, sendRow }, client = db) {
  if (!callBounceOtherSpellingLive()) return NO_RETRY;
  const bounced = norm(ev?.email || sendRow?.email);
  if (!bounced || !sendRow?.enrollment_id || norm(sendRow.email) !== bounced) return NO_RETRY;
  try {
    // One savepoint: any error rolls the attempt back whole and the bounce is handled as before.
    return await client.transaction(async (sp) => (
      await settleRetryBounce({ sendRow, address: bounced }, sp) || await startRetry({ sendRow, bounced }, sp)
    ));
  } catch (err) {
    logger.warn(`[call-email-spelling-retry] failed closed: ${err.code || err.name}`);
    return NO_RETRY;
  }
}

/**
 * A send DELIVERED. When it went to a retry address that is still `resending`, replace the customer email that held
 * the bounced address (only if it still does: a hand edit wins) through the canonical fanout with the narrowed review
 * scope, so an automated correction never settles a read-back card. Runs in the event transaction; an error rolls
 * the event back and SendGrid redelivers it. Gated like the start: unsetting the gate stops the commit too.
 */
async function onAutomationDelivered({ sendRow }, client = db) {
  if (!callBounceOtherSpellingLive()) return { committed: false }; // gate off = today's behavior (the kill switch stops the commit too)
  const address = norm(sendRow?.email);
  if (!address || !sendRow?.enrollment_id) return { committed: false };
  const row = await client(TABLE).where({ retry_email: address, channel: CHANNEL, status: 'resending' }).forUpdate().first();
  if (!row) return { committed: false };
  const own = await client('automation_enrollments').where({ id: sendRow.enrollment_id, customer_id: row.customer_id }).first('id');
  if (!own) return { committed: false };

  const settle = (status, reason) => client(TABLE).where({ id: row.id })
    .update({ status, reason, retry_send_id: sendRow.id, committed_at: status === 'committed' ? new Date() : null, updated_at: new Date() });
  const before = await client('customers').where({ id: row.customer_id }).forUpdate().first();
  if (!before) { await settle('skipped', 'customer_gone'); return { committed: false }; }
  const { lockCustomerEmail } = require('../utils/customer-comms-lock');
  await lockCustomerEmail(client, address);
  // Re-judged at commit: the address may have been claimed since the send. The mail already delivered, but no record moves.
  if (await require('./email-bounce-recovery').correctedAddressOwnedByOther(address, row.customer_id, client)) {
    await settle('skipped', 'owned_by_other');
    return { committed: false };
  }
  const updated = await client('customers').where({ id: row.customer_id }).whereRaw('LOWER(email) = ?', [norm(row.bounced_email)])
    .update({ email: address, updated_at: new Date() });
  if (Number(updated) !== 1) { await settle('skipped', 'email_changed'); return { committed: false }; }

  await require('./customer-email-fanout').propagateCustomerEmailChange({
    before: { ...before, email: norm(row.bounced_email) },
    after: { id: row.customer_id, email: address },
    source: 'call-email-spelling-retry',
    reviewReasonCodes: ['customer_email_missing'],
  }, client);
  await settle('committed', null);
  await require('./audit-log').recordAuditEvent({
    trx: client,
    critical: true,
    actor_type: 'system',
    action: 'customer.email_replaced_after_bounce_retry',
    resource_type: 'customer',
    resource_id: row.customer_id,
    metadata: {
      bounced_email: row.bounced_email, retry_email: address, source_call_id: row.source_call_id,
      channel: CHANNEL, origin_send_id: row.origin_send_id, retry_send_id: sendRow.id,
    },
  });
  logger.info(`[call-email-spelling-retry] customer ${row.customer_id} email replaced after the other spelling delivered`);
  return { committed: true };
}

module.exports = { onAutomationHardBounce, onAutomationDelivered, CHANNEL, TABLE };
