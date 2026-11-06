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
 * Every retry send is bound to its claim by SEND id (`retry_send_id`, bindAutomationRetrySend / bindTrackedRetrySend, written in
 * the transaction that creates the send row) and every delivered / bounced event finds its claim only through claimForSend:
 * channel + send id + the customer resolved first. Nothing is ever settled by address alone.
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
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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
 * Move a claim out of `resending` (only from there, so it is idempotent and a settled row never flips). The claim is found by
 * SEND, never by address alone: `sendId` is the retry send bound to it (delivery, bounce, gate-off at the boundary), or
 * `originId` (with `bouncedEmail`) is the original message whose own flow took the claim and has not bound a send yet (a staging
 * failure or refusal before anything went out). One of the two is required; a bound send id needs nothing else to find its claim. Failure to settle is logged, never thrown: the send already happened.
 */
async function settleClaim({ customerId, bouncedEmail, channel = EMAIL_CHANNEL, sendId = null, originId = null }, { status, reason = null }, client = db) {
  if (!sendId && !originId) return;
  try {
    const query = client(TABLE)
      .where({ customer_id: customerId, channel, status: 'resending' })
      .modify((q) => (sendId ? q.where({ retry_send_id: sendId }) : q.where({ bounced_email: norm(bouncedEmail), origin_send_id: originId }).whereNull('retry_send_id')));
    await applySettlement(query, { status, reason }, client, channel);
  } catch (err) {
    logger.warn(`[call-email-spelling-retry] could not settle the claim as ${status}: ${err.code || err.name}`);
  }
}

/**
 * THE chokepoint for leaving `resending` (every settlement of an automation claim goes through it): the claim moves, and its
 * enrollments are dealt with in the same call. A commit keeps them on the retry address (now the profile email) and clears
 * their retry provenance; ANY other outcome releases them (releaseRetryEnrollments), so an active enrollment never keeps mailing
 * the address of a claim that did not commit. The tracked path has no provenance enrollments and only moves the claim.
 */
async function applySettlement(query, { status, reason = null }, client = db, channel = CHANNEL) {
  const patch = { status, reason, committed_at: status === 'committed' ? new Date() : null, updated_at: new Date() };
  if (channel !== CHANNEL) {
    await query.update(patch);
    return [];
  }
  const rows = await query.update(patch).returning('*');
  for (const row of rows) {
    if (status === 'committed') await clearRetryProvenance({ customerId: row.customer_id, retryEmail: row.retry_email }, client);
    else await releaseRetryEnrollments({ customerId: row.customer_id, retryEmail: row.retry_email, reason }, client);
  }
  return rows;
}

// The customer's ACTIVE enrollments carrying retry provenance for this address.
function provenanceEnrollments(client, customerId, retryEmail) {
  return client('automation_enrollments')
    .where({ customer_id: customerId, status: 'active' })
    .whereRaw(`LOWER(COALESCE(metadata->>'${RETRY_PROVENANCE_KEY}', '')) = ?`, [norm(retryEmail)]);
}

/** A commit: the retry address is now the profile email; the enrollments keep it and lose the provenance. */
async function clearRetryProvenance({ customerId, retryEmail }, client = db) {
  await provenanceEnrollments(client, customerId, retryEmail)
    .update({ metadata: client.raw(`COALESCE(metadata, '{}'::jsonb) - '${RETRY_PROVENANCE_KEY}'`), updated_at: new Date() });
}

/**
 * The claim did NOT commit: end what it started for this customer's provenance enrollments (still active, still mailing the
 * retry address). Staff set a different valid primary email by hand (`email_changed`): retarget them to it, which is what the
 * customer-email fanout would have done had they still pointed at the old address (it matches only the previous primary).
 * Otherwise cancel them the way today's hard bounce does (cancel_reason hard_bounce). The provenance goes either way.
 */
async function releaseRetryEnrollments({ customerId, retryEmail, reason }, client = db) {
  let current = null;
  if (reason === 'email_changed') {
    const customer = await client('customers').where({ id: customerId }).whereNull('deleted_at').first('email');
    const email = norm(customer?.email);
    if (EMAIL_SHAPE_RE.test(email)) current = email;
  }
  const query = provenanceEnrollments(client, customerId, retryEmail);
  if (current) {
    await query.update({ email: current, metadata: client.raw(`COALESCE(metadata, '{}'::jsonb) - '${RETRY_PROVENANCE_KEY}'`), updated_at: new Date() });
    return;
  }
  await query.update({
    status: 'cancelled', next_send_at: null, completed_at: new Date(),
    metadata: client.raw(`jsonb_set(COALESCE(metadata,'{}'::jsonb) - '${RETRY_PROVENANCE_KEY}', '{cancel_reason}', ?::jsonb, true)`, [JSON.stringify('hard_bounce')]),
    updated_at: new Date(),
  });
}

/**
 * THE way a delivered or bounced event finds a claim: by channel + the retry SEND bound to it + the resolved customer. Never
 * by address, so a delayed event for an older send, a sibling's send, or another customer's pending claim on the same
 * alternate address settles nothing. Locks the claim row. Null = this send is not a bound, still-`resending` retry.
 */
async function claimForSend({ channel, sendId, customerId }, client = db) {
  if (!sendId || !customerId) return null;
  return (await client(TABLE).where({ channel, retry_send_id: sendId, customer_id: customerId, status: 'resending' }).forUpdate().first()) || null;
}

/**
 * Bind the automation retry send to its claim, in the same transaction that creates the send row (sendStepLocked), only
 * while the claim is still `resending` and unbound, the gate is on, and the send is the rewound step itself: the claim's
 * origin send belongs to THIS enrollment and THIS step. A sibling repointed without a resend, a later step, or any other
 * enrollment never binds. One UPDATE, so exactly one send can win the bind.
 */
async function bindAutomationRetrySend({ enrollment, step, sendId, recipient }, client = db) {
  if (!gateLive()) return false;
  const res = await client.raw(
    `UPDATE ${TABLE} c SET retry_send_id = ?, updated_at = now()
       FROM automation_step_sends o
      WHERE c.customer_id = ? AND c.retry_email = ? AND c.channel = ? AND c.status = 'resending' AND c.retry_send_id IS NULL
        AND o.id = c.origin_send_id AND o.enrollment_id = ? AND o.step_id = ?`,
    [sendId, enrollment.customer_id, norm(recipient), CHANNEL, enrollment.id, step.id],
  );
  return res.rowCount === 1;
}

/**
 * Bind the tracked recovery message to its claim, in the transaction that stages the message (insertRecoveryMessage): only
 * for the claim this original message took, still `resending`, unbound (or already bound to this very message: a held
 * recovery resumed), with the gate on. False = the message must not be staged or sent.
 */
async function bindTrackedRetrySend({ customerId, bouncedEmail, originId, sendId }, client = db) {
  if (!gateLive()) return false;
  const n = await client(TABLE)
    .where({ customer_id: customerId, bounced_email: norm(bouncedEmail), channel: EMAIL_CHANNEL, origin_send_id: originId, status: 'resending' })
    .whereRaw('(retry_send_id IS NULL OR retry_send_id = ?)', [sendId])
    .update({ retry_send_id: sendId, updated_at: new Date() });
  return Number(n) === 1;
}

/** GATE_CALL_BOUNCE_OTHER_SPELLING, read at call time: the one gate recheck every retry boundary goes through. */
function gateLive() {
  return callBounceOtherSpellingLive();
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

  if (await retryAddressProblem(other, customer.id, client)) return null;
  return { other, sourceCallId: call.id, customerId: customer.id };
}

/** Why the retry address may not be mailed right now: 'suppressed', 'owned_by_other' (another customer, lead or estimate), or null. */
async function retryAddressProblem(address, customerId, client) {
  const { suppressionCoversEmail } = require('../utils/email-equivalence');
  const suppressed = await client('email_suppressions').where(suppressionCoversEmail(address)).where({ status: 'active' }).first('id');
  if (suppressed) return 'suppressed';
  return (await require('./email-bounce-recovery').correctedAddressOwnedByOther(address, customerId, client)) ? 'owned_by_other' : null;
}

/**
 * The send-boundary verdict for a provenance-marked automation send, asked right before the queued retry step is created and
 * again right before the provider request (automation-runner.js). null = send. Otherwise the reason it must not go: the gate is
 * off; the claim is no longer `resending` (a settled claim is never a pass); the customer's primary email is no longer the
 * bounced address (staff changed it); or the retry address is now suppressed or belongs to someone else.
 */
async function retrySendVerdict({ customerId, retryEmail }, client = db) {
  if (!gateLive()) return 'gate_off';
  const address = norm(retryEmail);
  const claim = await client(TABLE).where({ customer_id: customerId, retry_email: address, channel: CHANNEL }).orderBy('created_at', 'desc').first();
  if (!claim || claim.status !== 'resending') return 'claim_settled';
  const customer = await client('customers').where({ id: customerId }).whereNull('deleted_at').first('email');
  if (!customer || norm(customer.email) !== norm(claim.bounced_email)) return 'email_changed';
  return retryAddressProblem(address, customerId, client);
}

/**
 * End a retry that must not send (the verdict above): the still-`resending` claim is skipped with the reason, which releases
 * the customer's provenance enrollments; a claim already settled only has its leftover enrollments released.
 */
async function stopRetry({ customerId, retryEmail, reason }, client = db) {
  const claim = await client(TABLE).where({ customer_id: customerId, retry_email: norm(retryEmail), channel: CHANNEL }).orderBy('created_at', 'desc').first();
  if (claim && claim.status === 'resending') {
    await applySettlement(client(TABLE).where({ id: claim.id, status: 'resending' }), { status: 'skipped', reason }, client);
    return;
  }
  await releaseRetryEnrollments({ customerId, retryEmail, reason }, client);
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
  // spelling_retry_email is the retry provenance the runner's send boundary reads (kill switch): see retrySendVerdict.
  const rewound = await rewindEnrollmentToStep({
    enrollment, stepId: sendRow.step_id, email: found.other, metadata: { [RETRY_PROVENANCE_KEY]: found.other },
  }, client);
  if (!rewound) {
    // A later step already went out or the cursor moved: nothing is re-sent, the webhook cancels as it does today.
    await applySettlement(client(TABLE).where({ id: row.id, status: 'resending' }), { status: 'skipped', reason: 'sequence_cursor_moved' }, client);
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

/** The retry send itself hard-bounced: its (bound) claim fails. Returns { retryFailed, bouncedEmail } or null. */
async function settleRetryBounce({ sendRow, customerId }, client) {
  const row = await claimForSend({ channel: CHANNEL, sendId: sendRow.id, customerId }, client);
  if (!row) return null;
  await applySettlement(client(TABLE).where({ id: row.id, status: 'resending' }), { status: 'failed', reason: 'retry_address_bounced' }, client);
  return { retryFailed: true, bouncedEmail: row.bounced_email };
}

/** The customer a send belongs to, resolved from its enrollment BEFORE any claim is looked up. */
async function enrollmentCustomerId(sendRow, client) {
  const enrollment = await client('automation_enrollments').where({ id: sendRow.enrollment_id }).first('customer_id');
  return enrollment?.customer_id || null;
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
      await settleRetryBounce({ sendRow, customerId: await enrollmentCustomerId(sendRow, sp) }, sp) || await startRetry({ sendRow, bounced }, sp)
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
  // Customer first, then the claim bound to THIS send: a delivery of any other send to this address settles nothing.
  const row = await claimForSend({ channel: CHANNEL, sendId: sendRow.id, customerId: await enrollmentCustomerId(sendRow, client) }, client);
  if (!row || norm(row.retry_email) !== address) return { committed: false };

  const settle = (status, reason) => applySettlement(client(TABLE).where({ id: row.id, status: 'resending' }), { status, reason }, client);
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
  onAutomationHardBounce, onAutomationDelivered, claimRetry, settleClaim, claimForSend, bindAutomationRetrySend, bindTrackedRetrySend, gateLive,
  retrySendVerdict, stopRetry, releaseRetryEnrollments, lockPrepSend, CHANNEL, EMAIL_CHANNEL, TABLE, RETRY_PROVENANCE_KEY,
};
