/**
 * Resend of the FIRST EMAIL A NEW LEAD GETS to the other spelling of a call-captured address (owner 2026-11-05,
 * GATE_CALL_BOUNCE_OTHER_SPELLING): "if first email fails, then second email tries; if email goes through, we replace the email
 * that worked into the customer profile". Drip path only (automation_step_sends, sent by automation-runner); tracked
 * email_messages bounces keep their existing path (domain corrector, alert, call-audio re-verify card). No read-back card and
 * no ACT email on this path.
 *
 * When a drip send hard-bounces and the call that supplied the address recorded `ai_extraction.email_spelling_settled` (the two
 * extraction passes disagreed until the spelled letters settled it), the webhook (routes/webhooks-sendgrid.js
 * handleAutomationEvent, in its event transaction) calls these functions:
 *
 *   onAutomationHardBounce  the bounced step is sent again, to the other spelling, on the next runner tick
 *                           (rewindEnrollmentToStep), and a call_email_spelling_retries row (UNIQUE customer +
 *                           bounced address) records it, so it happens at most once. Or, when the bounced send was
 *                           itself that retry, the row becomes `failed`. A hard bounce for an address whose claim is still
 *                           `resending` is owned by that in-flight retry (no alert, rescue or card).
 *   onAutomationDelivered   a send to the retry address DELIVERED: the customer email that held the bounced address
 *                           is replaced with it (the same fanout the rescue's auto-apply uses), the row is
 *                           `committed`, and one audit row is written.
 *
 * Every retry send is bound to its claim by SEND id (`retry_send_id`, bindAutomationRetrySend, written in the transaction that
 * creates the send row) and every delivered / bounced event finds its claim only through claimForSend: send id + the customer
 * resolved first. Nothing is ever settled by address alone. (The table's `email_message` channel value is reserved and unused.)
 *
 * Safety: a positive link (the enrollment's customer is the source call's customer and holds the bounced address as primary
 * email), not the same Gmail inbox, no active suppression on the other spelling, not owned by another customer or lead, never
 * tried before for this customer + address, fail closed (any error before the first write returns "no retry" and the webhook
 * does what it does today). Gate off = today's behavior.
 */
const db = require('../models/db');
const logger = require('./logger');
const { callBounceOtherSpellingLive } = require('../config/feature-gates');
const { gmailCanonicalMailbox, sameGmailInbox } = require('../utils/email-equivalence');

const TABLE = 'call_email_spelling_retries';
const CHANNEL = 'automation';
// A claim still `resending` after this long is stranded by some path nobody foresaw (a hold, a crash, a cancel that did not settle).
// 72 h is SendGrid's own limit: it keeps retrying a deferred message for up to 72 hours before it drops it, so a retry send that
// is going to deliver or bounce has done so by then; the retry step itself is due the moment the bounce is processed (the drip's
// longest step delay never applies to it). Past the window the claim is stale: it no longer owns bounces and no longer lets a
// send through.
const CLAIM_STALE_MS = 72 * 3600 * 1000;
const NO_RETRY = Object.freeze({ retried: false });
// A hard bounce for an address whose claim is still in flight: the retry owns it, nothing is retried and nothing is raised.
const RETRY_OWNED = Object.freeze({ retried: false, retryOwned: true });
const EMAIL_SHAPE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// automation_enrollments.metadata key: the retry address this enrollment now mails (retry provenance).
const RETRY_PROVENANCE_KEY = 'spelling_retry_email';

const norm = (value) => String(value || '').trim().toLowerCase();

/**
 * THE read of a customer row in this service: a LIVE customer, i.e. not soft-deleted. The codebase retires an archived customer and a
 * merge loser alike by setting `deleted_at` (customer-dedupe.js retires the loser with deleted_at, email null, active false), and
 * every reader that must not match them filters `deleted_at IS NULL`. Candidate selection, the send verdict, the release/retarget
 * and the commit (under its row lock) all read and write customers only through this, so a customer archived or merged away
 * between the retry send and its delivery is rejected the same way it would be at the start. A query builder: chain .first(),
 * .forUpdate(), .update().
 */
const liveCustomer = (client, customerId) => client('customers').where({ id: customerId }).whereNull('deleted_at');

function enrollmentRole(enrollment) {
  const meta = enrollment?.metadata;
  if (meta && typeof meta === 'object') return meta.recipient_role || null;
  try { return JSON.parse(meta || '{}').recipient_role || null; } catch { return null; }
}

/**
 * THE once-only claim: one row per customer + bounced address, taken with a single INSERT ... ON CONFLICT DO NOTHING on
 * UNIQUE(customer_id, bounced_email), so exactly one concurrent caller wins and the loser sends nothing. A row of any status is a
 * lost claim ("tried before"). Returns { claimed, id }.
 */
async function claimRetry({ customerId, sourceCallId = null, bouncedEmail, retryEmail, originId = null }, client = db) {
  const [row] = await client(TABLE).insert({
    customer_id: customerId,
    source_call_id: sourceCallId,
    bounced_email: norm(bouncedEmail),
    retry_email: norm(retryEmail),
    channel: CHANNEL,
    origin_send_id: originId,
    status: 'resending',
  }).onConflict(['customer_id', 'bounced_email']).ignore().returning(['id']);
  return row ? { claimed: true, id: row.id } : { claimed: false };
}

/**
 * Move the claim bound to a send out of `resending` (only from there, so it is idempotent and a settled row never flips). Found
 * by SEND, never by address alone. Failure to settle is logged, never thrown: the send already happened.
 */
async function settleClaim({ customerId, sendId }, { status, reason = null }, client = db) {
  if (!sendId) return;
  try {
    const query = client(TABLE).where({ customer_id: customerId, channel: CHANNEL, status: 'resending', retry_send_id: sendId });
    await applySettlement(query, { status, reason }, client);
  } catch (err) {
    logger.warn(`[call-email-spelling-retry] could not settle the claim as ${status}: ${err.code || err.name}`);
  }
}

/**
 * THE chokepoint for leaving `resending` (every settlement of an automation claim goes through it): the claim moves, and its
 * enrollments are dealt with in the same call. A commit keeps them on the retry address (now the profile email) and clears
 * their retry provenance; ANY other outcome releases them (releaseRetryEnrollments), so an active enrollment never keeps mailing
 * the address of a claim that did not commit.
 */
async function applySettlement(query, { status, reason = null }, client = db) {
  const patch = { status, reason, committed_at: status === 'committed' ? new Date() : null, updated_at: new Date() };
  // The claim row is updated (and so locked) and its enrollments are dealt with in ONE transaction; with a root connection that
  // is a transaction of its own, with a transaction it is a savepoint of the caller's.
  return client.transaction(async (trx) => {
    const rows = await query.clone().transacting(trx).update(patch).returning('*');
    for (const row of rows) {
      if (status === 'committed') await clearRetryProvenance({ customerId: row.customer_id, retryEmail: row.retry_email }, trx);
      else await releaseRetryEnrollments({ customerId: row.customer_id, retryEmail: row.retry_email, reason }, trx);
    }
    return rows;
  });
}

// The customer's enrollments carrying retry provenance for this address: the ACTIVE ones (still able to send) or every OTHER
// status (completed, cancelled, failed: they cannot send, but they must not carry the marker into a later episode).
function provenanceEnrollments(client, customerId, retryEmail, { active = true } = {}) {
  const query = client('automation_enrollments')
    .where({ customer_id: customerId })
    .whereRaw(`LOWER(COALESCE(metadata->>'${RETRY_PROVENANCE_KEY}', '')) = ?`, [norm(retryEmail)]);
  return active ? query.where({ status: 'active' }) : query.whereNot({ status: 'active' });
}

const DROP_PROVENANCE_SQL = `COALESCE(metadata, '{}'::jsonb) - '${RETRY_PROVENANCE_KEY}'`;

/**
 * The claim settled, whatever the outcome: no enrollment of the customer keeps retry provenance for this address, in ANY status.
 * A final-step retry completes its enrollment before delivery arrives, and a completed enrollment is reactivated later with its
 * metadata; a stale marker would then meet a settled claim and cancel a legitimate send.
 */
async function clearRetryProvenance({ customerId, retryEmail }, client = db) {
  for (const active of [true, false]) {
    await provenanceEnrollments(client, customerId, retryEmail, { active })
      .update({ metadata: client.raw(DROP_PROVENANCE_SQL), updated_at: new Date() });
  }
}

/**
 * The claim did NOT commit: end what it started for this customer's provenance enrollments (still active, still mailing the
 * retry address). Staff set a different valid primary email by hand (`email_changed`): retarget them to it, which is what the
 * customer-email fanout would have done had they still pointed at the old address (it matches only the previous primary).
 * Otherwise cancel them the way today's hard bounce does (cancel_reason hard_bounce). The provenance goes either way, from
 * the terminal enrollments too.
 */
async function releaseRetryEnrollments({ customerId, retryEmail, reason }, client = db) {
  let current = null;
  if (reason === 'email_changed') {
    const customer = await liveCustomer(client, customerId).first('email');
    const email = norm(customer?.email);
    if (EMAIL_SHAPE_RE.test(email)) current = email;
  }
  const query = provenanceEnrollments(client, customerId, retryEmail);
  if (current) {
    await query.update({ email: current, metadata: client.raw(DROP_PROVENANCE_SQL), updated_at: new Date() });
  } else {
    await query.update({
      status: 'cancelled', next_send_at: null, completed_at: new Date(),
      metadata: client.raw(`jsonb_set(${DROP_PROVENANCE_SQL}, '{cancel_reason}', ?::jsonb, true)`, [JSON.stringify('hard_bounce')]),
      updated_at: new Date(),
    });
  }
  await provenanceEnrollments(client, customerId, retryEmail, { active: false })
    .update({ metadata: client.raw(DROP_PROVENANCE_SQL), updated_at: new Date() });
}

/**
 * THE way a delivered or bounced event finds a claim: by the retry SEND bound to it + the resolved customer. Never
 * by address, so a delayed event for an older send, a sibling's send, or another customer's pending claim on the same
 * alternate address settles nothing. Locks the claim row. Null = this send is not a bound, still-`resending` retry.
 */
async function claimForSend({ sendId, customerId }, client = db) {
  if (!sendId || !customerId) return null;
  return (await client(TABLE).where({ channel: CHANNEL, retry_send_id: sendId, customer_id: customerId, status: 'resending' }).forUpdate().first()) || null;
}

/**
 * Bind the automation retry send to its claim, in the same transaction that creates the send row (sendStepLocked), only
 * while the claim is still `resending` and unbound, the gate is on, and the send is the rewound step itself: the claim's
 * origin send belongs to THIS enrollment and THIS step. A sibling repointed without a resend, a later step, or any other
 * enrollment never binds ('not_origin'). One UPDATE, so exactly one send can win the bind. Returns 'bound', 'not_origin', or, for the
 * originating step whose bind failed, 'refused' / 'gate_off': that send must not be dispatched.
 */
async function bindAutomationRetrySend({ enrollment, step, sendId, recipient }, client = db) {
  const where = [enrollment.customer_id, norm(recipient), CHANNEL, enrollment.id, step.id];
  if (gateLive()) {
    // Unbound, or bound to a row that no longer exists (a deferred step deletes its queued row: nothing was sent).
    const res = await client.raw(
      `UPDATE ${TABLE} c SET retry_send_id = ?, updated_at = now()
         FROM automation_step_sends o
        WHERE c.customer_id = ? AND c.retry_email = ? AND c.channel = ? AND c.status = 'resending'
          AND (c.retry_send_id IS NULL OR NOT EXISTS (SELECT 1 FROM automation_step_sends b WHERE b.id = c.retry_send_id))
          AND o.id = c.origin_send_id AND o.enrollment_id = ? AND o.step_id = ?`,
      [sendId, ...where],
    );
    if (res.rowCount === 1) return 'bound';
  }
  // Not bound. Is this the claim's originating retry step at all? A sibling or a later step legitimately never binds.
  const origin = await client.raw(
    `SELECT 1 FROM ${TABLE} c JOIN automation_step_sends o ON o.id = c.origin_send_id
      WHERE c.customer_id = ? AND c.retry_email = ? AND c.channel = ? AND c.status = 'resending' AND o.enrollment_id = ? AND o.step_id = ?`,
    where,
  );
  if (origin.rows.length === 0) return 'not_origin';
  // The originating step but the bind failed (the claim is already bound to an earlier queued row that was never dispatched, e.g.
  // the process stopped after the bind committed). Fail closed: the caller must not dispatch it.
  return gateLive() ? 'refused' : 'gate_off';
}

/** GATE_CALL_BOUNCE_OTHER_SPELLING, read at call time: the one gate recheck every retry boundary goes through. */
function gateLive() {
  return callBounceOtherSpellingLive();
}

/**
 * Pure: the other spelling a call's extraction names for the bounced address, or null. Reads
 * ai_extraction.email_spelling_settled ({ email, other_spelling }, both lowercased by the call pipeline) and
 * returns other_spelling only when `email` is the bounced address, other_spelling is email-shaped, differs from
 * it, and is not the same Gmail inbox (a dead Gmail inbox is dead for every dot spelling). Bad JSON -> null.
 */
function settledOtherSpelling(extraction, bouncedEmail) {
  let parsed = extraction;
  if (typeof extraction === 'string') {
    try { parsed = JSON.parse(extraction); } catch { return null; }
  }
  const settled = parsed && typeof parsed === 'object' ? parsed.email_spelling_settled : null;
  if (!settled || typeof settled !== 'object') return null;
  const bounced = norm(bouncedEmail);
  const email = norm(settled.email);
  const other = norm(settled.other_spelling);
  if (!bounced || email !== bounced || !EMAIL_SHAPE_RE.test(other) || other === bounced) return null;
  const canon = gmailCanonicalMailbox(bounced);
  if (sameGmailInbox([bounced, other]) || (canon && canon === gmailCanonicalMailbox(other))) return null;
  return other;
}

/** The settled other spelling for this send's customer + address, after every safety check, or null. */
async function eligibleOtherSpelling({ enrollment, bounced }, client) {
  if (!enrollment?.customer_id || !['active', 'completed'].includes(enrollment.status)) return null;
  // A step addressed to an on-location contact follows that contact's own address rules; the holder's address only.
  if (norm(enrollment.email) !== bounced || enrollmentRole(enrollment)) return null;
  const template = await client('automation_templates').where({ key: enrollment.template_key }).first('asm_group');
  // Marketing-stream bounces belong to the suppression ledger and never rewrite a contact's email.
  if (!template || String(template.asm_group || 'service').trim().toLowerCase() === 'newsletter') return null;
  const customer = await liveCustomer(client, enrollment.customer_id).first('id', 'email');
  if (!customer || norm(customer.email) !== bounced) return null;

  const { findSourceCall } = require('./email-bounce-reverify');
  const call = await findSourceCall({
    bouncedEmail: bounced, customerId: customer.id, onlyCustomerId: customer.id, requireRecording: false, requireSettled: true,
  });
  if (!call || String(call.customer_id || '') !== String(customer.id)) return null;
  const other = settledOtherSpelling(call.ai_extraction, bounced);
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
 * The verdict for a claim row and its customer, read on `client` (a locked claim inside a transaction, or a plain read).
 * null = the send goes. A committed claim whose address IS the customer's CURRENT primary email is a normal send, never
 * stopped (a delivery that commits while the runner already holds its enrollment must not cancel a recovered enrollment).
 * Otherwise the reason it must not go: the gate is off; the claim is no longer `resending` (a settled claim is never a pass);
 * the customer's primary email is no longer the bounced address (staff changed it); or the retry address is now suppressed or
 * belongs to someone else.
 */
async function verdictFor({ claim, customerId, retryEmail }, client) {
  const address = norm(retryEmail);
  const customer = await liveCustomer(client, customerId).first('email');
  if (claim && claim.status === 'committed' && customer && norm(customer.email) === address) return null;
  if (!gateLive()) return 'gate_off';
  if (!claim || claim.status !== 'resending') return 'claim_settled';
  if (isStale(claim)) return 'stale';
  if (!customer || norm(customer.email) !== norm(claim.bounced_email)) return 'email_changed';
  return retryAddressProblem(address, customerId, client);
}

const latestClaim = (client, customerId, retryEmail) => client(TABLE)
  .where({ customer_id: customerId, retry_email: norm(retryEmail), channel: CHANNEL }).orderBy('created_at', 'desc');

/** The send-boundary verdict (automation-runner.js: before the queued retry step and again at the provider boundary). */
async function retrySendVerdict({ customerId, retryEmail }, client = db) {
  return verdictFor({ claim: await latestClaim(client, customerId, retryEmail).first(), customerId, retryEmail }, client);
}

/**
 * End a retry the verdict says must not send. The verdict is RE-READ here, on the locked claim row, in the transaction of the
 * stop (claim first, then customer, then enrollments): only if the live state still says stop is the claim skipped (releasing the
 * customer's provenance enrollments), or a settled claim's leftover enrollments released. `not_bound` is a stop that needs no
 * verdict. Returns { stopped: false } when the live state says the send is fine (the caller then sends it), else
 * { stopped: true, reason }.
 */
async function stopRetry({ customerId, retryEmail, reason }, client = db) {
  return client.transaction(async (trx) => {
    const claim = await latestClaim(trx, customerId, retryEmail).forUpdate().first();
    const live = reason === 'not_bound' ? reason : await verdictFor({ claim, customerId, retryEmail }, trx);
    if (!live) return { stopped: false };
    if (claim && claim.status === 'resending') {
      // A queued row the claim was bound to but never dispatched (reason not_bound) is closed with it.
      if (live === 'not_bound' && claim.retry_send_id) {
        await trx('automation_step_sends').where({ id: claim.retry_send_id, status: 'queued' })
          .update({ status: 'blocked', failure_reason: 'The retry send was never dispatched', updated_at: new Date() });
      }
      await applySettlement(trx(TABLE).where({ id: claim.id, status: 'resending' }), { status: 'skipped', reason: live }, trx);
    } else {
      await releaseRetryEnrollments({ customerId, retryEmail, reason: live }, trx);
    }
    return { stopped: true, reason: live };
  });
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
  const seen = await client('automation_enrollments').where({ id: sendRow.enrollment_id }).first();
  if (!seen) return NO_RETRY;
  const found = await eligibleOtherSpelling({ enrollment: seen, bounced }, client);
  if (!found) return NO_RETRY;

  const row = await claimRetry({
    customerId: found.customerId, sourceCallId: found.sourceCallId, bouncedEmail: bounced, retryEmail: found.other, originId: sendRow.id,
  }, client);
  if (!row.claimed) return NO_RETRY; // tried before for this customer + address: never twice

  // The claim row now exists in this transaction: the enrollment row is locked AFTER it (claim first, then enrollments, like every
  // settlement), and re-read under the lock so the rewind sees the cursor as it is now.
  const enrollment = await client('automation_enrollments').where({ id: sendRow.enrollment_id }).forUpdate().first();
  if (!enrollment || norm(enrollment.email) !== bounced || !['active', 'completed'].includes(enrollment.status)) {
    await applySettlement(client(TABLE).where({ id: row.id, status: 'resending' }), { status: 'skipped', reason: 'enrollment_changed' }, client);
    return NO_RETRY;
  }

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
async function settleRetryBounce({ sendRow, customerId, reason = 'retry_address_bounced' }, client) {
  const row = await claimForSend({ sendId: sendRow.id, customerId }, client);
  if (!row) return null;
  await applySettlement(client(TABLE).where({ id: row.id, status: 'resending' }), { status: 'failed', reason }, client);
  return { retryFailed: true, bouncedEmail: row.bounced_email };
}

const isStale = (claim) => Date.now() - new Date(claim.created_at).getTime() > CLAIM_STALE_MS;

/**
 * Is the claim for this customer + bounced address in flight? 'fresh' = still `resending` and inside the window (it owns the
 * bounce); a STALE one is settled `failed` / `stale` here (claim locked, enrollments released by applySettlement) and counts as
 * not in flight, so the bounce takes today's path; null = no live claim.
 */
async function claimInFlight({ customerId, bounced }, client) {
  const claim = await client(TABLE).where({ customer_id: customerId, bounced_email: bounced, channel: CHANNEL, status: 'resending' }).forUpdate().first();
  if (!claim) return null;
  if (!isStale(claim)) return 'fresh';
  await applySettlement(client(TABLE).where({ id: claim.id, status: 'resending' }), { status: 'failed', reason: 'stale' }, client);
  return null;
}

/**
 * A terminal cancel of a send (automation-runner.js blockSendAndCancelEnrollment) for an enrollment carrying this retry address:
 * the still-`resending` claim is skipped with the cancel reason, claim row locked first, which releases the sibling enrollments
 * and the provenance. A claim already settled is left alone.
 */
async function abandonRetry({ customerId, retryEmail, reason }, client = db) {
  return client.transaction(async (trx) => {
    const claim = await latestClaim(trx, customerId, retryEmail).forUpdate().first();
    if (!claim || claim.status !== 'resending') return false;
    await applySettlement(trx(TABLE).where({ id: claim.id, status: 'resending' }), { status: 'skipped', reason: String(reason || 'cancelled').slice(0, 100) }, trx);
    return true;
  });
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
  // An EXISTING claim is being acted on here (failed, or found in flight): a database failure propagates, the event transaction
  // rolls back, and the route answers non-2xx for a bounce, so SendGrid redelivers it. Only the START of a new retry below is
  // best-effort: it runs in a savepoint, any error rolls the attempt back whole and the bounce is handled as before.
  const customerId = await enrollmentCustomerId(sendRow, client);
  const failed = await settleRetryBounce({ sendRow, customerId }, client);
  if (failed) return failed;
  // The claim for this customer + address is still in flight: that retry owns this bounce (a duplicate event, a sibling's
  // send to the same address). Nothing is retried again and no alert, rescue or read-back card is raised; a settled claim
  // (failed, committed, skipped) is today's path.
  if (customerId && await claimInFlight({ customerId, bounced }, client) === 'fresh') return RETRY_OWNED;
  try {
    return await client.transaction((sp) => startRetry({ sendRow, bounced }, sp));
  } catch (err) {
    logger.warn(`[call-email-spelling-retry] failed closed: ${err.code || err.name}`);
    return NO_RETRY;
  }
}

/**
 * A "blocked" event whose reason is a domain with no mail server (GATE_CALL_EMAIL_CHECKS) for the BOUND retry send: the retry
 * address is dead, exactly as if it had hard-bounced. The claim fails and the provenance enrollments are released; the
 * webhook raises the one existing alert and no read-back card. Any other blocked / dropped event, and any send that is not the
 * bound retry send, is left to the webhook as before.
 */
async function onAutomationDeadDomain({ ev, sendRow }, client = db) {
  if (!gateLive() || !sendRow?.enrollment_id) return NO_RETRY;
  if (!require('./email-bounce-recovery').isNoMailServerEvent(ev)) return NO_RETRY;
  // Failing an existing claim: a database failure propagates (a blocked event is redelivered by the route), never swallowed.
  return (await settleRetryBounce({ sendRow, customerId: await enrollmentCustomerId(sendRow, client), reason: 'retry_address_no_mail_server' }, client)) || NO_RETRY;
}

/**
 * A send DELIVERED. When it went to a retry address that is still `resending`, replace the customer email that held
 * the bounced address (only if it still does: a hand edit wins) through the canonical fanout with the narrowed review
 * scope, so an automated correction never settles a read-back card. Runs in the event transaction; an error rolls
 * the event back and SendGrid redelivers it. Gated like the start: unsetting the gate stops the commit too.
 */
async function onAutomationDelivered(args, client = db) {
  try {
    return await commitDeliveredRetry(args, client);
  } catch (err) {
    // Any failure of the retry-commit work (claim lock, customer update, fanout, audit, settlement) rolls the event transaction
    // back, and the route must answer non-2xx so SendGrid redelivers the delivery: the event ledger row went with the rollback and
    // the claim is still `resending`, so the redelivery runs the commit once. (A COMMIT failure surfaces from the route's
    // transaction; the route marks it the same way when `touched` was returned.)
    if (err && typeof err === 'object') err.retryWebhook = true;
    throw err;
  }
}

async function commitDeliveredRetry({ sendRow }, client) {
  if (!callBounceOtherSpellingLive()) return { committed: false }; // gate off = today's behavior (the kill switch stops the commit too)
  const address = norm(sendRow?.email);
  if (!address || !sendRow?.enrollment_id) return { committed: false };
  // Customer first, then the claim bound to THIS send: a delivery of any other send to this address settles nothing.
  const row = await claimForSend({ sendId: sendRow.id, customerId: await enrollmentCustomerId(sendRow, client) }, client);
  if (!row || norm(row.retry_email) !== address) return { committed: false };
  // From here this delivery works on a claim: `touched` tells the route a failure of the transaction (even its COMMIT) must be redelivered.

  const settle = (status, reason) => applySettlement(client(TABLE).where({ id: row.id, status: 'resending' }), { status, reason }, client);
  const before = await liveCustomer(client, row.customer_id).forUpdate().first();
  if (!before) { await settle('skipped', 'customer_gone'); return { committed: false, touched: true }; }
  const { lockCustomerEmail } = require('../utils/customer-comms-lock');
  await lockCustomerEmail(client, address);
  // Re-judged at commit: the address may have been claimed since the send. The mail already delivered, but no record moves.
  if (await require('./email-bounce-recovery').correctedAddressOwnedByOther(address, row.customer_id, client)) {
    await settle('skipped', 'owned_by_other');
    return { committed: false, touched: true };
  }
  const updated = await liveCustomer(client, row.customer_id).whereRaw('LOWER(email) = ?', [norm(row.bounced_email)])
    .update({ email: address, updated_at: new Date() });
  if (Number(updated) !== 1) { await settle('skipped', 'email_changed'); return { committed: false, touched: true }; }

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
  return { committed: true, touched: true };
}

module.exports = {
  onAutomationHardBounce, onAutomationDelivered, claimRetry, settleClaim, claimForSend, bindAutomationRetrySend, gateLive,
  retrySendVerdict, stopRetry, abandonRetry, releaseRetryEnrollments, onAutomationDeadDomain, settledOtherSpelling, lockPrepSend, CLAIM_STALE_MS, CHANNEL, TABLE, RETRY_PROVENANCE_KEY,
};
