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
 * The table is ALSO the once-only claim of the tracked email_messages path (channel `email_message`, claimRetry/settleClaim
 * below, used by email-bounce-recovery.js): one row per customer + bounced address, whichever path takes it first.
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
const EMAIL_CHANNEL = 'email_message';
const NO_RETRY = Object.freeze({ retried: false });
// automation_enrollments.metadata key: the retry address this enrollment now mails (retry provenance).
const RETRY_PROVENANCE_KEY = 'spelling_retry_email';

const norm = (value) => String(value || '').trim().toLowerCase();

function enrollmentRole(enrollment) {
  const meta = enrollment?.metadata;
  if (meta && typeof meta === 'object') return meta.recipient_role || null;
  try { return JSON.parse(meta || '{}').recipient_role || null; } catch { return null; }
}

/**
 * THE once-only claim for BOTH delivery paths (automation_step_sends and the tracked email_messages recovery): one row per
 * customer + bounced address, taken with a single INSERT ... ON CONFLICT DO NOTHING on UNIQUE(customer_id, bounced_email),
 * so exactly one concurrent caller wins and the loser sends nothing. A row of any status, from either path, is a lost
 * claim ("tried before"). `resumeOriginId` (tracked path only) lets the SAME original message take its own still-`resending`
 * claim back when a dispute-hold park resumes it; it can never have sent anything yet. Returns { claimed, id }.
 */
async function claimRetry({ customerId, sourceCallId = null, bouncedEmail, retryEmail, channel, originId = null, resumeOriginId = null }, client = db) {
  const bounced = norm(bouncedEmail);
  const [row] = await client(TABLE).insert({
    customer_id: customerId,
    source_call_id: sourceCallId,
    bounced_email: bounced,
    retry_email: norm(retryEmail),
    channel,
    origin_send_id: originId,
    status: 'resending',
  }).onConflict(['customer_id', 'bounced_email']).ignore().returning(['id']);
  if (row) return { claimed: true, id: row.id };
  if (!resumeOriginId) return { claimed: false };
  const own = await client(TABLE)
    .where({ customer_id: customerId, bounced_email: bounced, channel, origin_send_id: resumeOriginId, status: 'resending' }).first('id');
  return own ? { claimed: true, id: own.id } : { claimed: false };
}

/**
 * Move a claim out of `resending` (only from there, so it is idempotent and a settled row never flips). The tracked path
 * finds its claim by customer + bounced address; failure to settle is logged, never thrown: the send already happened.
 */
async function settleClaim({ customerId, bouncedEmail, channel = EMAIL_CHANNEL }, { status, reason = null, retrySendId = null }, client = db) {
  try {
    await client(TABLE)
      .where({ customer_id: customerId, bounced_email: norm(bouncedEmail), channel, status: 'resending' })
      .update({
        status, reason, ...(retrySendId ? { retry_send_id: retrySendId } : {}),
        committed_at: status === 'committed' ? new Date() : null, updated_at: new Date(),
      });
  } catch (err) {
    logger.warn(`[call-email-spelling-retry] could not settle the claim as ${status}: ${err.code || err.name}`);
  }
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

const PREP_LOCK_WAIT_MS = 5000;
const PREP_LOCK_POLL_MS = 100;

/**
 * Take, for the rest of this transaction, the SAME Postgres advisory lock the runner holds for a customer-linked step from
 * its read through its send and cursor advance (`runExclusive('prep-send:<customer>')` -> pg_try_advisory_lock(
 * hashtext('cron:prep-send:<customer>')), cron-lock.js; cross-process, so it serializes this webhook with a runner in
 * another process). The transaction-scoped twin of the key conflicts with the runner's session lock. The wait is bounded
 * (the runner holds it across the provider request); false = not obtained, and the caller does not rewind.
 */
async function lockPrepSend(client, customerId, { waitMs = PREP_LOCK_WAIT_MS } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const res = await client.raw('SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked', [`cron:prep-send:${customerId}`]);
    if (res.rows[0]?.locked === true) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, PREP_LOCK_POLL_MS));
  }
}

async function startRetry({ sendRow, bounced }, client) {
  const peek = await client('automation_enrollments').where({ id: sendRow.enrollment_id }).first('customer_id');
  if (!peek?.customer_id || !sendRow.step_id) return NO_RETRY;
  // LOCK ORDER (webhook): event ledger row and send/suppression writes (already held by the event transaction) -> prep-send
  // advisory lock -> enrollment row FOR UPDATE -> claim row. The runner takes the prep-send lock first and writes enrollments
  // without row locks, so the two cannot wait on each other in a cycle. The cursor is read only AFTER the lock: a step the
  // runner sent first has moved it, and the rewind then refuses.
  if (!(await lockPrepSend(client, peek.customer_id))) {
    logger.warn('[call-email-spelling-retry] prep-send lock busy: no retry, the bounce is handled as before');
    return NO_RETRY;
  }
  const enrollment = await client('automation_enrollments').where({ id: sendRow.enrollment_id }).forUpdate().first();
  if (!enrollment) return NO_RETRY;
  const found = await eligibleOtherSpelling({ enrollment, bounced }, client);
  if (!found) return NO_RETRY;

  const row = await claimRetry({
    customerId: found.customerId, sourceCallId: found.sourceCallId, bouncedEmail: bounced, retryEmail: found.other, channel: CHANNEL, originId: sendRow.id,
  }, client);
  if (!row.claimed) return NO_RETRY; // tried before for this customer + address, by either path: never twice

  const { rewindEnrollmentToStep } = require('./automation-runner');
  // spelling_retry_email is the retry provenance the runner's send boundary reads (kill switch): see endGatedRetry.
  const rewound = await rewindEnrollmentToStep({
    enrollment, stepId: sendRow.step_id, email: found.other, metadata: { [RETRY_PROVENANCE_KEY]: found.other },
  }, client);
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
    .update({
      email: found.other,
      metadata: client.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ [RETRY_PROVENANCE_KEY]: found.other })]),
      updated_at: new Date(),
    });
  logger.info(`[call-email-spelling-retry] automation step re-queued for customer ${found.customerId} to the other spelling`);
  return { retried: true, retryEmail: found.other };
}

/**
 * Kill switch at the runner's send boundary (automation-runner.js, before the row is queued and again at the provider
 * boundary). The caller has already found that the gate is off and that the enrollment carries retry provenance for this
 * recipient. Only a claim that is STILL `resending` is ended (a committed or failed one means the address is settled and
 * the send proceeds): it becomes `skipped` / `gate_off` and every active enrollment of the customer addressed to the retry
 * address is cancelled the way today's hard bounce cancels (cancel_reason hard_bounce). True = the send must not happen.
 */
async function endGatedRetry({ customerId, retryEmail }, client = db) {
  const address = norm(retryEmail);
  const ended = await client(TABLE)
    .where({ customer_id: customerId, retry_email: address, channel: CHANNEL, status: 'resending' })
    .update({ status: 'skipped', reason: 'gate_off', updated_at: new Date() });
  if (Number(ended) === 0) return false;
  await client('automation_enrollments')
    .where({ customer_id: customerId, status: 'active' })
    .whereRaw('LOWER(email) = ?', [address])
    .update({
      status: 'cancelled', next_send_at: null, completed_at: new Date(),
      metadata: client.raw("jsonb_set(COALESCE(metadata,'{}'::jsonb), '{cancel_reason}', ?::jsonb, true)", [JSON.stringify('hard_bounce')]),
      updated_at: new Date(),
    });
  return true;
}

/** True while a claim for this customer + retry address is still `resending` (read-only, for the provider boundary). */
async function retryStillPending({ customerId, retryEmail }, client = db) {
  const row = await client(TABLE).where({ customer_id: customerId, retry_email: norm(retryEmail), channel: CHANNEL, status: 'resending' }).first('id');
  return !!row;
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

module.exports = {
  onAutomationHardBounce, onAutomationDelivered, claimRetry, settleClaim, endGatedRetry, retryStillPending, lockPrepSend, CHANNEL, EMAIL_CHANNEL, TABLE, RETRY_PROVENANCE_KEY,
};
