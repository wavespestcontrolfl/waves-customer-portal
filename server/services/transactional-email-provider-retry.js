const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const emailTemplates = require('./email-template-library');
const NotificationService = require('./notification-service');
const billingReplay = require('./billing-email-provider-replay');
const billingReservation = require('./billing-email-reservation');
const { isSenderRenderedEmail, alertFinalNoticeMissed } = require('./billing-email-no-replay');

const RETRY_DELAYS_MS = [10 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;
const CLAIM_LIMIT = 10;
const STALE_CLAIM_MS = 10 * 60 * 1000;
const HANDOFF_PHASE_PENDING = 'pending';
const HANDOFF_PHASE_STARTED = 'started';
const HANDOFF_PHASE_REJECTED = 'rejected';
// Stamped on a row addressed to an email the office replaced (see
// stopRetriesForReplacedEmail): such a row never gets a provider retry.
const REPLACED_RECIPIENT_CATEGORY = 'recipient_replaced';

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isProviderBlockedEvent(ev) {
  const event = String(ev?.event || '').trim().toLowerCase();
  const type = String(ev?.type || '').trim().toLowerCase();
  return event === 'blocked' || (event === 'bounce' && type === 'blocked');
}

function isTransactionalRetryEligible(message) {
  if (!message || message.has_attachments) return false;
  if (isSenderRenderedEmail(message)) return false;
  if (String(message.recipient_type || '').toLowerCase() === 'test') return false;
  // Applicant emails (recruiting-comms.js) have no email_templates row and
  // their own eligibility (application state); they stay off this rail.
  if (String(message.recipient_type || '').toLowerCase() === 'job_application') return false;
  const group = String(message.suppression_group_key_snapshot || '').trim().toLowerCase();
  if (group.startsWith('marketing_')) return false;
  const categories = asArray(message.categories).map((v) => String(v).toLowerCase());
  if (categories.includes('bounce_recovery') || categories.includes(REPLACED_RECIPIENT_CATEGORY)) return false;
  return !!message.recipient_email_snapshot && !!message.subject_snapshot;
}

function retryStateForProviderBlock(message, now = new Date()) {
  // Runtime rows selected after the migration carry this key (including
  // NULL), so webhook scheduling records positive rejection evidence. Keep
  // the helper's legacy return shape for older callers that supply a partial
  // pre-column object during rolling deploys.
  const phase = message && Object.prototype.hasOwnProperty.call(message, 'provider_handoff_phase')
    ? { provider_handoff_phase: HANDOFF_PHASE_REJECTED, provider_handoff_attempt_token: message.send_attempt_token || null }
    : {};
  // Definitive blocks also permit direct retries of messages outside this rail.
  if (!isTransactionalRetryEligible(message)) return phase;
  const retryCount = Math.max(0, Number(message.provider_retry_count || 0));
  if (retryCount >= MAX_RETRIES) {
    return {
      provider_retry_next_at: null,
      provider_retry_exhausted_at: now,
      ...phase,
    };
  }
  return {
    provider_retry_next_at: new Date(now.getTime() + RETRY_DELAYS_MS[retryCount]),
    provider_retry_exhausted_at: null,
    ...phase,
  };
}

async function activeSuppressionForMessage(message) {
  const loaded = message.template_key
    ? await emailTemplates.loadTemplateByKey(message.template_key)
    : null;
  if (!loaded?.template) return { suppression_type: 'template_unavailable' };
  return emailTemplates.activeSuppressionFor(
    loaded.template,
    message.recipient_email_snapshot,
    message.suppression_group_key_snapshot || undefined,
  );
}

async function claimDueRetries(limit = CLAIM_LIMIT, now = new Date()) {
  return db.transaction(async (trx) => {
    const rows = await retryEvidence(trx('email_messages'), [HANDOFF_PHASE_PENDING, HANDOFF_PHASE_REJECTED])
      .where({ status: 'failed', has_attachments: false })
      .whereNotNull('provider_retry_next_at')
      .where('provider_retry_next_at', '<=', now)
      .where('provider_retry_count', '<', MAX_RETRIES)
      .orderBy('provider_retry_next_at', 'asc')
      .forUpdate()
      .skipLocked()
      .limit(limit);

    const claimed = [];
    for (const row of rows) {
      const sendAttemptToken = crypto.randomUUID();
      const [updated] = await retryEvidence(trx('email_messages'), [HANDOFF_PHASE_PENDING, HANDOFF_PHASE_REJECTED])
        .where({ id: row.id, status: 'failed', send_attempt_token: row.send_attempt_token })
        .where('provider_retry_next_at', '<=', now)
        .update({
          status: 'queued',
          provider_message_id: null,
          send_attempt_token: sendAttemptToken,
          sent_at: null,
          queued_at: now,
          provider_retry_next_at: null,
          provider_retry_count: trx.raw('provider_retry_count + 1'),
          provider_handoff_phase: HANDOFF_PHASE_PENDING,
          provider_handoff_attempt_token: sendAttemptToken,
          updated_at: now,
        })
        .returning('*');
      if (updated) claimed.push(updated);
    }
    return claimed;
  });
}

// Written on the queued row immediately before a visit-summary provider
// request: a worker lost after this point may have had its request accepted,
// so stale-claim recovery settles such a row as uncertain instead of
// scheduling another attempt (a bearer link is never sent twice on a guess).
const HANDOFF_STARTED = 'provider_handoff_started';
// Written before the held handoff (locks, re-authorization, the provider
// block clear): a worker lost while it still carries this marker provably
// made no request, so stale-claim recovery requeues the row. The marker
// becomes HANDOFF_STARTED at the Mail Send boundary itself.
const HANDOFF_PENDING = 'provider_handoff_pending';

// Old workers replace send_attempt_token without knowing about these fields.
// A phase from the previous token cannot prove the current request was unsent.
function retryEvidence(query, phases, matches = true) {
  return query.whereRaw(`COALESCE(
    (provider_handoff_phase = ANY(?::text[]) AND provider_handoff_attempt_token = send_attempt_token)
    OR (provider_handoff_phase IS NULL AND error_message = ?), FALSE) = ?`,
  [phases, HANDOFF_PENDING, matches]);
}

async function recoverStaleClaims(now = new Date(), database = db) {
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  // provider_retry_count > 0 distinguishes retry-worker claims from normal
  // sendTemplate rows that are independently protected by their own stale
  // in-flight logic.
  const stale = () => database('email_messages')
    .where({ status: 'queued' })
    .where('provider_retry_count', '>', 0)
    .whereNull('provider_retry_next_at')
    .whereNull('provider_retry_exhausted_at')
    .whereNull('provider_message_id')
    .whereNull('sent_at')
    .where('queued_at', '<=', staleBefore);
  // Only a durable positive pending marker proves that no request began.
  // Started rows and legacy unmarked rows are ambiguous and must never have
  // their bounded attempt refunded. A stale queued `rejected` row is rolling-
  // deploy evidence from a worker that claimed without writing the new
  // pending phase; `rejected` describes the previous attempt, so the current
  // one is ambiguous too.
  const ambiguous = await retryEvidence(stale(), [HANDOFF_PHASE_PENDING], false)
    .select('id', 'send_attempt_token', 'provider_handoff_phase');
  let uncertain = 0;
  for (const claim of ambiguous) {
    const updated = await database.transaction(async (trx) => {
      const query = retryEvidence(trx('email_messages'), [HANDOFF_PHASE_PENDING], false)
        .where({ id: claim.id, send_attempt_token: claim.send_attempt_token, status: 'queued' });
      const [row] = await query
        .update({
          status: 'failed',
          provider_retry_next_at: null,
          provider_retry_exhausted_at: now,
          error_message: 'Provider outcome unknown: interrupted provider retry without positive pending evidence',
          updated_at: now,
        }).returning('*');
      if (!row) return null;
      await reconcileExhaustedSummary(row, trx);
      return row;
    });
    if (updated) {
      uncertain += 1;
      await alertExhausted(updated, updated.error_message);
    }
  }
  const requeued = await retryEvidence(stale(), [HANDOFF_PHASE_PENDING])
    .update({
      status: 'failed',
      provider_retry_next_at: now,
      // The claim increments before network I/O. These rows have neither a
      // provider id nor a sent timestamp, so refund the interrupted claim and
      // let the next worker consume the same bounded attempt slot.
      provider_retry_count: database.raw('GREATEST(provider_retry_count - 1, 0)'),
      provider_handoff_phase: HANDOFF_PHASE_PENDING,
      provider_handoff_attempt_token: database.raw('send_attempt_token'),
      error_message: 'Interrupted provider retry claim recovered',
      updated_at: now,
    });

  // Rows scheduled before this phase existed cannot prove that their prior
  // provider handoff was rejected. Park them for office review instead of
  // repeatedly selecting them or guessing that another send is safe.
  const unsafeScheduled = await retryEvidence(database('email_messages'), [HANDOFF_PHASE_PENDING, HANDOFF_PHASE_REJECTED], false)
    .where({ status: 'failed' })
    .whereNotNull('provider_retry_next_at')
    .where('provider_retry_next_at', '<=', now)
    .where('provider_retry_count', '<', MAX_RETRIES)
    .select('id', 'send_attempt_token', 'provider_handoff_phase', 'provider_retry_next_at');
  let held = 0;
  for (const candidate of unsafeScheduled) {
    const updated = await database.transaction(async (trx) => {
      const query = retryEvidence(trx('email_messages'), [HANDOFF_PHASE_PENDING, HANDOFF_PHASE_REJECTED], false)
        .where({ id: candidate.id, status: 'failed', send_attempt_token: candidate.send_attempt_token,
          provider_retry_next_at: candidate.provider_retry_next_at });
      const [row] = await query.update({
        provider_retry_next_at: null,
        provider_retry_exhausted_at: now,
        error_message: 'Provider outcome unknown: scheduled retry lacks positive pending evidence',
        updated_at: now,
      }).returning('*');
      if (row) await reconcileExhaustedSummary(row, trx);
      return row || null;
    });
    if (updated) {
      held += 1;
      await alertExhausted(updated, updated.error_message);
    }
  }
  // A stopped old quote can still own a completed visit claim, so the
  // reminder sweep cannot reach it. Retry its atomic release here even if
  // the original worker was lost after persisting the refusal.
  const requotes = await retryEvidence(database('email_messages'), [HANDOFF_PHASE_PENDING, HANDOFF_PHASE_REJECTED])
    .where({ status: 'failed' })
    .whereIn('template_key', ['billing.notice', 'billing.receipt_notice'])
    .whereNotNull('provider_retry_exhausted_at')
    .whereNull('provider_retry_next_at')
    .where('error_message', 'like', `${billingReservation.BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX}%`)
    .orderBy('updated_at', 'asc').limit(CLAIM_LIMIT).select('*');
  let reopened = 0;
  for (const candidate of requotes) {
    if (await billingReservation.releaseBillingEmailReservationForRequote(candidate, database)) reopened += 1;
    else {
      // A permanently invalid pin must not starve other bounded repairs.
      await database('email_messages').where({ id: candidate.id,
        send_attempt_token: candidate.send_attempt_token, error_message: candidate.error_message,
      }).update({ updated_at: now });
    }
  }
  return Number(requeued || 0) + uncertain + held + reopened;
}

// A summary whose retries ended without a delivery — the provider block
// never cleared, or the last request's outcome is unknown — is a terminal
// failure for the office, exactly like a hard bounce: the sent effect
// reopens for delivery review. On a transaction the reconciliation commits
// with the row's settlement (a failure rolls both back); on the root
// handle a failure is logged, the exhausted-retry path's contract.
async function reconcileExhaustedSummary(updated, database = null) {
  if (updated?.template_key !== 'service.visit_summary') return;
  const reconcile = require('./visit-completion-summary').reconcileSummaryEmailBounce(updated, database || undefined);
  if (database) { await reconcile; return; }
  await reconcile.catch((err) => logger.warn(`[email-provider-retry] visit summary bounce not reconciled for ${updated.id}: ${err.message}`));
}

async function alertExhausted(message, reason) {
  try {
    const dedupeKey = `email-provider-retry-exhausted:${message.id}`;
    const existing = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
      .first('id');
    if (existing) return;
    await NotificationService.notifyAdmin(
      'alert',
      'Transactional email delivery failed',
      `${message.template_key || 'Unknown template'} could not be delivered after ${message.provider_retry_count || MAX_RETRIES} provider retries. ${reason || 'Review the SendGrid rejection and contact record.'}`,
      {
        link: '/admin/communications',
        metadata: { dedupeKey, email_message_id: message.id, template_key: message.template_key || null },
      },
    );
  } catch (err) {
    logger.warn(`[email-provider-retry] exhausted alert failed: ${err.message}`);
  }
}

async function alertIfProviderRetriesExhausted(message, ev) {
  if (!isProviderBlockedEvent(ev)) return;
  // Not retried at all: a final notice has no later stage either.
  if (isSenderRenderedEmail(message)) {
    await alertFinalNoticeMissed(message, 'blocked');
    return;
  }
  if (!isTransactionalRetryEligible(message)) return;
  if (Number(message.provider_retry_count || 0) < MAX_RETRIES) return;
  await alertExhausted(
    { ...message, provider_retry_count: MAX_RETRIES },
    emailTemplates.redactEmailAddresses(String(ev?.reason || ev?.response || 'SendGrid provider block')),
  );
}

async function markRetryFailure(message, err, now = new Date(), { rejectedAfterStart = false, markerWriteFailed = false } = {}) {
  const reason = emailTemplates.redactEmailAddresses(String(err?.message || 'SendGrid retry failed')).slice(0, 1000);
  const retryCount = Number(message.provider_retry_count || 0);
  const exhausted = retryCount >= MAX_RETRIES;
  const nextAt = exhausted ? null : new Date(now.getTime() + RETRY_DELAYS_MS[retryCount]);
  const expectedPhase = rejectedAfterStart ? HANDOFF_PHASE_STARTED : HANDOFF_PHASE_PENDING;
  const failureQuery = db('email_messages')
    .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued',
      provider_handoff_attempt_token: message.send_attempt_token });
  if (markerWriteFailed) {
    failureQuery.whereIn('provider_handoff_phase', [HANDOFF_PHASE_PENDING, HANDOFF_PHASE_STARTED]);
  } else failureQuery.where({ provider_handoff_phase: expectedPhase });
  const [updated] = await failureQuery
    .update({
      status: 'failed',
      error_message: reason,
      provider_retry_next_at: nextAt,
      provider_retry_exhausted_at: exhausted ? now : null,
      provider_handoff_phase: rejectedAfterStart ? HANDOFF_PHASE_REJECTED : HANDOFF_PHASE_PENDING,
      updated_at: now,
    })
    .returning('*');
  if (updated && exhausted) {
    await alertExhausted(updated, reason);
    await reconcileExhaustedSummary(updated);
  }
  return updated || null;
}

// A queued row held by a collections dispute hold before any provider request:
// back to the retry queue one hold interval out with the attempt this claim
// consumed REFUNDED, so a long dispute never exhausts the ladder and the
// pay-link email sends after the release.
async function markRetryHeld(message, reason, now = new Date(), { rejectedAfterStart = false } = {}) {
  const expectedPhase = rejectedAfterStart ? HANDOFF_PHASE_STARTED : HANDOFF_PHASE_PENDING;
  const [updated] = await db('email_messages')
    .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued',
      provider_handoff_attempt_token: message.send_attempt_token, provider_handoff_phase: expectedPhase })
    .update({
      status: 'failed',
      error_message: emailTemplates.redactEmailAddresses(String(reason || 'collections dispute hold')).slice(0, 1000),
      provider_retry_next_at: new Date(now.getTime() + require('./collections/collection-hold').HOLD_DEFER_MS),
      provider_retry_count: db.raw('GREATEST(provider_retry_count - 1, 0)'),
      provider_retry_exhausted_at: null,
      provider_handoff_phase: rejectedAfterStart ? HANDOFF_PHASE_REJECTED : HANDOFF_PHASE_PENDING,
      updated_at: now,
    })
    .returning('*');
  return updated || null;
}

// A thrown provider request after the handoff began is ambiguous: SendGrid
// may hold the message despite the lost response. A bearer-link summary is
// never requeued from that state; its row settles as an uncertain delivery
// for the office to reconcile (no sent_at, no provider id, not the
// pre-dispatch abort marker), and the exhausted alert names it.
async function markRetryUncertain(message, err, now = new Date()) {
  const reason = `Provider outcome unknown: ${emailTemplates.redactEmailAddresses(String(err?.message || 'SendGrid retry failed'))}`.slice(0, 1000);
  // The row's settlement and the summary's transition commit together: a
  // failure between them leaves the row queued for stale-claim recovery
  // (which settles it the same way) instead of exhausted beside a summary
  // that still reads as delivered.
  const updated = await db.transaction(async (trx) => {
    const [row] = await trx('email_messages')
      .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued' })
      .where({ provider_handoff_phase: HANDOFF_PHASE_STARTED, provider_handoff_attempt_token: message.send_attempt_token })
      .update({ status: 'failed', error_message: reason, provider_retry_next_at: null, provider_retry_exhausted_at: now,
        provider_handoff_phase: HANDOFF_PHASE_STARTED, updated_at: now })
      .returning('*');
    if (row) await reconcileExhaustedSummary(row, trx);
    return row || null;
  });
  if (updated) await alertExhausted(updated, reason);
  return updated;
}

// A row stopped before any provider request: terminal for the rail, and a
// summary's aggregate is settled from the ledger since no webhook follows.
async function stopRetry(message, {
  status, reason, exhaustedAlert = false, rejectedAfterStart = false, requote = false, reissue = false,
}) {
  const isSummary = message.template_key === 'service.visit_summary';
  const terminalBillingRefusal = status === 'blocked' && billingReplay.isBillingEmailProviderReplay(message);
  const storedReason = requote ? `${billingReservation.BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX}${reason}`
    : terminalBillingRefusal ? `${billingReservation.BILLING_EMAIL_TERMINAL_REFUSAL_PREFIX}${reason}` : reason;
  const settle = async (trx) => {
    const expectedPhase = rejectedAfterStart ? HANDOFF_PHASE_STARTED : HANDOFF_PHASE_PENDING;
    const [row] = await trx('email_messages')
      .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued',
        provider_handoff_phase: expectedPhase, provider_handoff_attempt_token: message.send_attempt_token })
      .update({ status, error_message: storedReason, provider_retry_next_at: null, provider_retry_exhausted_at: new Date(),
        provider_handoff_phase: rejectedAfterStart ? HANDOFF_PHASE_REJECTED : HANDOFF_PHASE_PENDING, updated_at: new Date() })
      .returning('*');
    if (row && isSummary) {
      // The ledger terminalization and the summary settlement commit
      // together, the same posture markRetryUncertain already holds: a
      // failure reconciling the aggregate must not leave a terminalized
      // ledger row with no queued row and no future webhook left to retry
      // the transition, stranding the effect at 'sent' while closeout
      // keeps reporting delivery.
      await require('./visit-completion-summary').reconcileSummaryEmailRecovery({ ...message, ...row, status: row.status || status }, trx);
    }
    return row || null;
  };
  const updated = isSummary ? await db.transaction(settle) : await settle(db);
  if (updated && terminalBillingRefusal) {
    await billingReservation.resolveBillingEmailReservationRefusal(updated)
      .catch((err) => logger.warn(`[email-provider-retry] billing refusal not reconciled for ${message.id}: ${err.message}`));
  }
  if (updated && requote) {
    await billingReservation.releaseBillingEmailReservationForRequote(updated)
      .catch((err) => logger.warn(`[email-provider-retry] changed quote not reconciled for ${message.id}: ${err.message}`));
  }
  if (updated && reissue) {
    await billingReservation.reopenBillingEmailReservationForReissue(updated)
      .catch((err) => logger.warn(`[email-provider-retry] replaced-address stop not reconciled for ${message.id}: ${err.message}`));
  }
  if (updated && exhaustedAlert) await alertExhausted(updated, reason);
  return { sent: false, stopped: true, reason };
}

const EMAIL_REPLACED_REASON = 'Customer email was corrected; retry to the replaced address stopped.';

// The customer's mail to an address the office replaced: rows naming the
// customer in recipient_id, plus rows that name nobody (or the lead itself)
// but are linked to the customer's leads or estimates. A row that names ANOTHER
// customer is never theirs, whatever it links to. Visit summaries keep their
// own re-authorization fence (summaryRetryAuthorized refuses a recipient that
// is no longer current).
function mailToReplacedAddress(database, customerId, replaced) {
  return database('email_messages')
    .whereRaw('LOWER(TRIM(recipient_email_snapshot)) = ?', [replaced])
    .where((owner) => owner
      .where('recipient_id', String(customerId))
      .orWhere((linked) => linked
        .where((unowned) => unowned.whereNull('recipient_id').orWhereRaw('recipient_id = lead_id::text'))
        .where((links) => links
          .whereIn('lead_id', database('leads').where({ customer_id: customerId }).select('id'))
          .orWhereIn('estimate_id', database('estimates').where({ customer_id: customerId }).select('id')))))
    .where((template) => template.whereNull('template_key').orWhereNot('template_key', 'service.visit_summary'));
}

// A correction of the customer's email retires every provider-block retry
// addressed to the address it replaced (customer-email-fanout calls this
// inside its own transaction): the stored copy would otherwise go on to the
// rejected address, which can be a third party's inbox. A retry is stopped,
// never retargeted; the senders that own these emails re-issue them.
//   1. A row scheduled, or claimed with no provider request yet (pending
//      phase: the worker loses its pending-to-started marker CAS and sends
//      nothing, the lost-claim path), settles as `failed` with its handoff
//      evidence kept. Not `blocked`: that status makes the library dedupe the
//      row's idempotency key, so the owner's re-issue would never go out,
//      while a failed, definitely-unsent row is reclaimed to the live address.
//      A billing replay's reservation stays claimable (see
//      reopenBillingEmailReservationForReissue). Sender-rendered notices (the
//      invoice follow-ups) are never replayed from a stored copy, so they keep
//      their own settlement and are left alone here.
//   2. Every row still awaiting a provider verdict (queued, sent) or without a
//      schedule (failed) is stamped REPLACED_RECIPIENT_CATEGORY: a row already
//      at the provider, or accepted and blocked asynchronously later, would
//      otherwise be re-armed by that block event. Stamped rows are ineligible
//      for scheduling (isTransactionalRetryEligible) and retryOne stops one
//      that was scheduled anyway before any request. Nothing but the
//      eligibility check reads it, and the stamp lives on the row, so it needs
//      no schema.
async function stopRetriesForReplacedEmail(database, { customerId, oldEmail, now = new Date() }) {
  const replaced = String(oldEmail || '').trim().toLowerCase();
  if (!customerId || !replaced) return 0;
  const rows = await mailToReplacedAddress(database, customerId, replaced)
    .where((pending) => pending
      .where((scheduled) => scheduled.where({ status: 'failed' }).whereNotNull('provider_retry_next_at'))
      .orWhere((claimed) => retryEvidence(
        claimed.where({ status: 'queued' }).where('provider_retry_count', '>', 0)
          .whereNull('provider_message_id').whereNull('sent_at'),
        [HANDOFF_PHASE_PENDING],
      )))
    .forUpdate()
    .select('*');
  let stopped = 0;
  for (const row of rows) {
    if (isSenderRenderedEmail(row)) continue;
    const replay = billingReplay.isBillingEmailProviderReplay(row);
    const requote = replay && billingReservation.isPrevisitReissue(row);
    const [updated] = await database('email_messages')
      .where({ id: row.id, send_attempt_token: row.send_attempt_token, status: row.status })
      .update({
        status: 'failed',
        error_message: requote ? `${billingReservation.BILLING_EMAIL_REQUOTE_REFUSAL_PREFIX}${EMAIL_REPLACED_REASON}` : EMAIL_REPLACED_REASON,
        provider_retry_next_at: null,
        provider_retry_exhausted_at: now,
        updated_at: now,
      })
      .returning('*');
    if (!updated) continue;
    stopped += 1;
    if (requote) await billingReservation.releaseBillingEmailReservationForRequote(updated, database);
    else if (replay) await billingReservation.reopenBillingEmailReservationForReissue(updated, database);
  }
  await mailToReplacedAddress(database, customerId, replaced)
    .whereIn('status', ['queued', 'sent', 'failed'])
    .whereRaw("NOT jsonb_exists(COALESCE(categories, '[]'::jsonb), ?)", [REPLACED_RECIPIENT_CATEGORY])
    .update({ categories: database.raw("COALESCE(categories, '[]'::jsonb) || to_jsonb(?::text)", [REPLACED_RECIPIENT_CATEGORY]) });
  return stopped;
}

// The visit-summary handoff around one provider request. Resolves to the
// provider result, or to the rail's terminal/uncertain outcome when nothing
// (or something unknowable) reached the provider.
async function retrySummaryThroughHandoff(message, dispatchToProvider, state) {
  // Durable before the held handoff and on this worker's own connection
  // (never a second slot inside the held transaction): a reclaimable
  // pre-provider marker, so a worker lost while acquiring locks,
  // re-authorizing or clearing the provider block is requeued by stale-claim
  // recovery, not exhausted. The update must own the queued row, or the
  // claim has moved on.
  const marked = await db('email_messages')
    .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued',
      provider_handoff_phase: HANDOFF_PHASE_PENDING, provider_handoff_attempt_token: message.send_attempt_token })
    .update({ error_message: HANDOFF_PENDING, updated_at: new Date() });
  if (Number(marked) !== 1) return { outcome: { sent: false, stopped: true, reason: 'claim_lost' } };
  let fence;
  try {
    fence = await require('./visit-completion-summary').retrySummaryThroughHandoff(message, dispatchToProvider);
  } catch (err) {
    if (state.rejected) {
      await markRetryFailure(message, err, new Date(), { rejectedAfterStart: true });
      return { outcome: { sent: false, error: err } };
    }
    if (state.dispatchStarted && !state.result) {
      await markRetryUncertain(message, err);
      return { outcome: { sent: false, uncertain: true, error: err } };
    }
    if (!state.dispatchStarted) {
      // Fail closed, the same way an unreadable suppression ledger does.
      await markRetryFailure(message, new Error(`Visit summary recheck failed: ${err.message}`));
      return { outcome: { sent: false, error: err } };
    }
    logger.warn(`[email-provider-retry] visit summary handoff guard failed after acceptance for ${message.id}: ${err.message}`);
  }
  if (!state.result) {
    // Pre-push audit P1 (2eb19ceff7): the annual-offer guard (inside
    // dispatchToProvider, above) also resolves without setting state.result
    // when it blocks — distinguish that from the summary re-authorization's
    // own "unavailable" verdict so the row's error_message names the real
    // reason.
    return { outcome: await stopRetry(message, {
      status: 'blocked',
      reason: state.blocked ? 'annual_offer_withheld' : `Suppressed before retry: ${fence?.reason || 'visit_summary_unavailable'}`,
      rejectedAfterStart: state.blocked,
    }) };
  }
  return { result: state.result };
}

async function retryClaimAtProviderBoundary(message, database) {
  let owned;
  try {
    owned = await database('email_messages')
      .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued',
        provider_handoff_phase: HANDOFF_PHASE_STARTED,
        provider_handoff_attempt_token: message.send_attempt_token })
      .forUpdate()
      .first('id');
  } catch (err) {
    err.code = err.code || 'BILLING_RETRY_CLAIM_UNREADABLE';
    err.retryable = true;
    throw err;
  }
  return owned ? { ok: true } : {
    ok: false,
    code: 'BILLING_RETRY_CLAIM_LOST',
    reason: 'Billing retry claim was reclaimed before the provider request',
  };
}

async function settleRetrySend(message, result, database = db, { requireQueued = false } = {}) {
  const claim = database('email_messages')
    .where({ id: message.id, send_attempt_token: message.send_attempt_token,
      provider_handoff_phase: HANDOFF_PHASE_STARTED, provider_handoff_attempt_token: message.send_attempt_token });
  if (requireQueued) claim.where({ status: 'queued' });
  const [updated] = await claim.update({
    provider_message_id: result.messageId,
    sent_at: new Date(),
    error_message: null,
    updated_at: new Date(),
    status: database.raw("CASE WHEN status = 'queued' THEN 'sent' ELSE status END"),
    // Round 9 structural fix (P1): sendOne rewrote a withheld estimate
    // link before this retry actually sent — persist the rewritten
    // bytes so the stored row reflects what the customer received, same
    // as a fresh sendTemplate send does (email-template-library.js).
    ...(result.withheldLinksRewritten?.length
      ? { html_snapshot: result.html, text_snapshot: result.text }
      : {}),
  }).returning('*');
  return updated || null;
}

// Post-commit reconciliation. The accepted Email row is already durable, so
// these best-effort aggregate stamps can never reopen its provider attempt.
async function finishRetrySend(message, updated) {
  if (!updated) {
    await markRetryUncertain(message, new Error('Provider retry acceptance settlement is not durable'));
    return { sent: false, uncertain: true, reason: 'claim_lost_after_acceptance' };
  }
  if (updated?.template_key === 'service.visit_summary') {
    await require('./visit-completion-summary').reconcileSummaryEmailRecovery(updated)
      .catch((err) => logger.warn(`[email-provider-retry] visit summary recovery not reconciled for ${message.id}: ${err.message}`));
  }
  if (billingReplay.isBillingEmailProviderReplay(updated)) {
    await billingReservation.markBillingEmailReservationDelivered(updated)
      .catch((err) => logger.warn(`[email-provider-retry] billing acceptance not reconciled for ${message.id}: ${err.message}`));
  }
  return { sent: true, message: updated || message };
}

async function recordRetrySend(message, result) {
  return finishRetrySend(message, await settleRetrySend(message, result));
}

// A held lifecycle notice older than this when the hold ends is not re-sent from its stored copy:
// the provider ladder itself never re-sends a notice older than ~7 hours (RETRY_DELAYS_MS), and a
// "your payment failed" snapshot that has sat through a multi-day dispute can describe a balance
// that has since changed. It settles as a definite non-delivery instead; the dunning ladder after
// the release covers the customer.
const HOLD_GATED_RETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// null = go ahead and dispatch. Otherwise the retryOne outcome. While a dispute hold stands (or
// its lookup cannot be answered - fail closed) the row goes back on the queue one hold interval
// out with the claim's attempt refunded: a hold is a WAIT, never a spent retry or a terminal
// failure.
async function holdGateLifecycleRetry(message) {
  const collectionHold = require('./collections/collection-hold');
  const held = await collectionHold.storedLifecycleEmailHeld(message);
  if (!held.held) {
    const bornAt = new Date(message.created_at || message.queued_at || Date.now()).getTime();
    const wasHeld = /dispute[- ]hold/i.test(String(message.error_message || ''));
    if (wasHeld && Number.isFinite(bornAt) && Date.now() - bornAt > HOLD_GATED_RETRY_MAX_AGE_MS) {
      return stopRetry(message, { status: 'failed', reason: 'Stale after a collections dispute hold; not re-sent from the stored copy.' });
    }
    return null;
  }
  const outcome = collectionHold.holdDeferOutcome(held);
  logger.info(`[email-provider-retry] ${message.template_key} ${message.id} held: collections dispute hold${held.reason === 'lookup_failed' ? ' (lookup failed - fail closed)' : ''}`);
  await markRetryHeld(message, outcome.reason);
  return { sent: false, held: true };
}

async function retryOne(message) {
  // A row scheduled before the ruling took effect settles the same way.
  if (isSenderRenderedEmail(message)) {
    const stopped = await stopRetry(message, { status: 'failed', reason: 'Not re-sent from stored copy (billing no-replay ruling).' });
    await alertFinalNoticeMissed(message, 'blocked');
    return stopped;
  }
  // The address was replaced after this row was written (stopRetriesForReplacedEmail's stamp): a
  // block event or a failed attempt scheduled it again, and it must not reach the old address.
  if (asArray(message.categories).includes(REPLACED_RECIPIENT_CATEGORY)) {
    const replay = billingReplay.isBillingEmailProviderReplay(message);
    const requote = replay && billingReservation.isPrevisitReissue(message);
    return stopRetry(message, { status: 'failed', reason: EMAIL_REPLACED_REASON, requote, reissue: replay && !requote });
  }
  let suppression;
  try {
    suppression = await activeSuppressionForMessage(message);
  } catch (err) {
    // Fail closed: never send when the suppression ledger cannot be checked.
    await markRetryFailure(message, new Error(`Suppression check failed: ${err.message}`));
    return { sent: false, error: err };
  }
  if (suppression) {
    const unavailable = suppression.suppression_type === 'template_unavailable';
    return stopRetry(message, { status: unavailable ? 'failed' : 'blocked', exhaustedAlert: unavailable,
      reason: unavailable ? 'Template is unavailable; retry stopped.' : `Suppressed before retry: ${suppression.suppression_type}` });
  }

  const group = String(message.suppression_group_key_snapshot).trim().toLowerCase();
  const asmGroupId = group === 'transactional_required' ? 0 : sendgrid.serviceGroupId();
  // dispatchStarted is set immediately before the Mail Send request: a
  // failure clearing the provider block is provably pre-send and keeps the
  // ordinary retry schedule.
  const state = {
    dispatchStarted: false, rejected: false, result: null, acceptedMessage: null,
    blocked: false, markerWriteFailed: false,
  };
  const dispatchToProvider = async (database, providerBoundaryCheck) => {
    // Blocks are a provider-specific suppression distinct from hard bounces.
    // If it remains, SendGrid will drop the retry before attempting delivery.
    await sendgrid.clearBlockedAddress(message.recipient_email_snapshot);
    // The Mail Send boundary: the pre-provider marker becomes the started
    // marker durably (dedicated marker connection, never a second root-pool
    // slot inside the held handoff) before the request, so a worker lost
    // after this point settles as uncertain and one lost before it requeues.
    // Zero rows means stale-claim recovery already reclaimed the row: nothing
    // may reach the provider.
    const marker = require('../models/marker-db')()('email_messages')
      .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued',
        provider_handoff_phase: HANDOFF_PHASE_PENDING, provider_handoff_attempt_token: message.send_attempt_token });
    if (message.template_key === 'service.visit_summary') marker.where({ error_message: HANDOFF_PENDING });
    let started;
    try {
      started = await marker.update({
        provider_handoff_phase: HANDOFF_PHASE_STARTED,
        ...(message.template_key === 'service.visit_summary' ? { error_message: HANDOFF_STARTED } : {}),
        updated_at: new Date(),
      });
    } catch (err) {
      state.markerWriteFailed = true;
      throw err;
    }
    if (Number(started) !== 1) {
      const lost = new Error('Provider retry claim was reclaimed before the provider request');
      lost.retryClaimLost = true;
      throw lost;
    }
    // Codex round 3 on #4608 (structural move): the annual-offer guard's
    // AUTHORITATIVE check now runs inside sendgrid.sendOne itself, the true
    // provider boundary — an automatic retry re-sends the SAME stored
    // html/text a fresh send would, and sendOne's own content derivation
    // over that html/text covers it without composing the guard here
    // separately (no explicit id: a retried email_messages row has no
    // structured estimate reference to pass as one).
    //
    // Round 9 structural fix (P1): `templateKey: message.template_key`
    // lets sendOne resolve the SAME rewrite-vs-refuse policy a fresh send
    // of this template would get (estimate-annual-guard.js's
    // withheldLinkPolicyForTemplate) — a stored deposit receipt whose
    // content still carries a withheld link (queued before an earlier
    // rewrite persisted, or re-rendered) is rewritten and retried
    // successfully here, not refused permanently just because this sweep
    // has no explicit opinion of its own.
    //
    // dispatchStarted flips true optimistically (a real sendOne attempt is
    // about to happen) and is reverted on catching sendOne's OWN blocked
    // refusal (.annualOfferWithheld) — that refusal means the wire was
    // never touched, so both this file's own catch below and
    // retrySummaryThroughHandoff's (visit-completion-summary.js's) must see
    // "never attempted", not a failed attempt. state.blocked signals the
    // caller to stop the retry permanently (below); any OTHER thrown error
    // (a real provider failure) propagates unchanged into the existing
    // "not dispatched"/"uncertain" classification this file already has.
    state.dispatchStarted = true;
    try {
      state.result = await sendgrid.sendOne({
        to: message.recipient_email_snapshot,
        fromEmail: message.from_email_snapshot,
        fromName: message.from_name_snapshot,
        replyTo: message.reply_to_snapshot,
        subject: message.subject_snapshot,
        html: message.html_snapshot,
        text: message.text_snapshot,
        categories: asArray(message.categories),
        asmGroupId,
        customArgs: {
          email_message_id: message.id,
          send_attempt_token: message.send_attempt_token,
        },
        suppressErrorLog: true,
        templateKey: message.template_key,
        database,
        // A billing replay's authority boundary wins; a plain stored pay-link lifecycle notice
        // carries the hold recheck as its own FINAL boundary (state.holdBoundaryCheck below).
        ...((providerBoundaryCheck || state.holdBoundaryCheck)
          ? { providerBoundaryCheck: providerBoundaryCheck || state.holdBoundaryCheck } : {}),
      });
      if (providerBoundaryCheck) {
        state.acceptedMessage = await settleRetrySend(
          message, state.result, database, { requireQueued: true },
        );
        if (!state.acceptedMessage) throw new Error('Billing retry claim was lost after provider acceptance');
      }
    } catch (err) {
      // Pre-push audit P1 (b49be57b12 round 4): a guard INFRASTRUCTURE
      // failure (.annualOfferGuardFailed) happens at the exact same
      // pre-request point as a blocked verdict — sendOne's own guard check,
      // before any HTTP call — so it must revert dispatchStarted exactly
      // like the withheld case, or retrySummaryThroughHandoff's catch below
      // (state.dispatchStarted && !state.result) wrongly reads "the wire
      // was touched, settle uncertain" for a request that was never
      // attempted. Unlike withheld, it is NOT a permanent stop: rethrown
      // unchanged so the ordinary retry-later classification applies (this
      // file's ownnot-dispatched branches, both here and in retryOne's own
      // catch), same as any other pre-send recheck failure.
      state.rejected = !!(err && (err.annualOfferWithheld
        || err.annualOfferGuardFailed
        || err.providerBoundaryBlocked
        || err.code === 'SENDGRID_NOT_CONFIGURED'
        || sendgrid.isDefiniteRejection(err)));
      if (err?.providerBoundaryBlocked) {
        state.dispatchStarted = false;
        return;
      }
      if (err && err.annualOfferWithheld) {
        state.blocked = true;
        return;
      }
      throw err;
    }
  };
  try {
    // A visit summary is a bearer link: its recipient, the customer's
    // preferences and the link itself are re-authorized while their rows are
    // held through the provider request, not only the template and the
    // suppression ledger before it.
    if (message.template_key === 'service.visit_summary') {
      const handoff = await retrySummaryThroughHandoff(message, dispatchToProvider, state);
      if (handoff.outcome) return handoff.outcome;
    } else if (billingReplay.isBillingEmailTemplateRetry(message)) {
      const handoff = await billingReplay.runBillingEmailProviderReplayHandoff(message, dispatchToProvider, {
        providerBoundaryCheck: ({ database }) => retryClaimAtProviderBoundary(message, database),
      });
      if (!handoff.allowed) {
        if (handoff.code === 'BILLING_RETRY_CLAIM_LOST') {
          return { sent: false, stopped: true, reason: 'claim_lost' };
        }
        const requote = handoff.code === 'BILLING_REPLAY_REQUOTE_REQUIRED';
        // A collections dispute hold: wait, never spend a retry (a hold can
        // outlast the whole ladder) - the row sends after the release.
        if (handoff.code === require('./collections/collection-hold').HOLD_DEFER_CODE) {
          await markRetryHeld(message, handoff.reason, new Date(), { rejectedAfterStart: state.rejected });
          return { sent: false, held: true };
        }
        if (handoff.retryable) {
          const err = new Error(handoff.reason);
          err.code = handoff.code;
          await markRetryFailure(message, err, new Date(), { rejectedAfterStart: state.rejected });
          return { sent: false, error: err };
        }
        // Preserve main's resendable refusal while settling the actual phase
        // reached by this attempt (a final veto follows the started marker).
        const status = [billingReplay.BILLING_REPLAY_RESENDABLE, 'BILLING_REPLAY_REQUOTE_REQUIRED']
          .includes(handoff.code) ? 'failed' : 'blocked';
        return await stopRetry(message, {
          status, reason: handoff.reason, rejectedAfterStart: state.rejected, requote,
        });
      }
      if (state.acceptedMessage) {
        // The authority preserves provider acceptance when COMMIT fails or
        // loses its acknowledgement. Only a durable acceptance stamp can
        // authorize delivered-ledger reconciliation after that transaction.
        const accepted = await db('email_messages')
          .where({ id: message.id, send_attempt_token: message.send_attempt_token,
            provider_handoff_attempt_token: message.send_attempt_token,
            provider_message_id: state.result.messageId })
          .whereNotNull('sent_at')
          .first();
        return await finishRetrySend(message, accepted);
      }
    } else {
      // A stored pay / update-card lifecycle snapshot (payment.failed, payment.retry_notice,
      // payment.method_expiring) re-checks the collections dispute hold before it goes back to
      // SendGrid, exactly as a fresh send does (payment-lifecycle-email.js): the retry waits.
      const holdOutcome = await holdGateLifecycleRetry(message);
      if (holdOutcome) return holdOutcome;
      // The same hold, read again as sendOne's FINAL boundary check (after the block-clear and
      // marker awaits and SendGrid's own request preparation, right before the fetch): a dispute
      // committed since the read above still stops the stored copy. A WAIT, never a spent retry.
      const collectionHold = require('./collections/collection-hold');
      if (collectionHold.HOLD_GATED_EMAIL_TEMPLATES.has(String(message.template_key || '').trim())) {
        state.holdBoundaryCheck = async ({ database: handoffDb } = {}) => {
          const heldNow = await collectionHold.storedLifecycleEmailHeld(message, handoffDb);
          if (heldNow.held) {
            state.holdRefusal = heldNow;
            throw Object.assign(new Error('Customer has an active collections dispute hold'), {
              code: collectionHold.HOLD_DEFER_CODE, retryable: true, providerBoundaryBlocked: true,
            });
          }
          return { ok: true };
        };
      }
      await dispatchToProvider();
      if (state.holdRefusal) {
        await markRetryHeld(message, collectionHold.holdDeferOutcome(state.holdRefusal).reason, new Date(), { rejectedAfterStart: true });
        return { sent: false, held: true };
      }
    }
    if (state.blocked) {
      return await stopRetry(message, { status: 'blocked', reason: 'annual_offer_withheld', rejectedAfterStart: true });
    }
    return await recordRetrySend(message, state.result);
  } catch (err) {
    // A bearer-link summary whose provider request began is never requeued:
    // if the uncertain settlement itself failed above, it is attempted once
    // more here, and a row it still cannot settle keeps its started marker
    // for stale-claim recovery to settle as uncertain.
    if (err?.retryClaimLost) return { sent: false, stopped: true, reason: 'claim_lost' };
    if (state.dispatchStarted && !state.rejected) {
      await markRetryUncertain(message, err).catch((again) => logger.error(`[email-provider-retry] uncertain settlement failed twice for ${message.id}: ${again.message}`));
      return { sent: false, uncertain: true, error: err };
    }
    await markRetryFailure(message, err, new Date(), {
      rejectedAfterStart: state.rejected, markerWriteFailed: state.markerWriteFailed,
    });
    return { sent: false, error: err };
  }
}

async function runDueRetries({ limit = CLAIM_LIMIT } = {}) {
  const recovered = await recoverStaleClaims();
  if (Number(recovered) > 0) logger.warn(`[email-provider-retry] recovered ${recovered} stale claim(s)`);
  const claimed = await claimDueRetries(limit);
  const results = [];
  for (const message of claimed) {
    try {
      results.push(await retryOne(message));
    } catch (err) {
      await markRetryFailure(message, err).catch((markErr) => {
        logger.error(`[email-provider-retry] failed to release claim ${message.id}: ${markErr.message}`);
      });
      results.push({ sent: false, error: err });
    }
  }
  const sent = results.filter((r) => r.sent).length;
  if (claimed.length) logger.info(`[email-provider-retry] processed=${claimed.length} sent=${sent}`);
  return { claimed: claimed.length, sent, failed: claimed.length - sent };
}

module.exports = {
  HANDOFF_STARTED,
  HANDOFF_PENDING,
  HANDOFF_PHASE_PENDING,
  HANDOFF_PHASE_STARTED,
  HANDOFF_PHASE_REJECTED,
  RETRY_DELAYS_MS,
  MAX_RETRIES,
  asArray,
  isProviderBlockedEvent,
  isTransactionalRetryEligible,
  isSenderRenderedEmail,
  retryStateForProviderBlock,
  alertIfProviderRetriesExhausted,
  recoverStaleClaims,
  claimDueRetries,
  markRetryFailure,
  markRetryHeld,
  REPLACED_RECIPIENT_CATEGORY,
  stopRetriesForReplacedEmail,
  retryClaimAtProviderBoundary,
  retryOne,
  runDueRetries,
};
