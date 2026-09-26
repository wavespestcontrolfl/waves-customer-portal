const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const emailTemplates = require('./email-template-library');
const NotificationService = require('./notification-service');

const RETRY_DELAYS_MS = [10 * 60 * 1000, 60 * 60 * 1000, 6 * 60 * 60 * 1000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;
const CLAIM_LIMIT = 10;
const STALE_CLAIM_MS = 10 * 60 * 1000;
const HANDOFF_PHASE_PENDING = 'pending';
const HANDOFF_PHASE_STARTED = 'started';
const HANDOFF_PHASE_REJECTED = 'rejected';

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
  if (String(message.recipient_type || '').toLowerCase() === 'test') return false;
  // Applicant emails (recruiting-comms.js) have no email_templates row and
  // their own eligibility (application state); they stay off this rail.
  if (String(message.recipient_type || '').toLowerCase() === 'job_application') return false;
  const group = String(message.suppression_group_key_snapshot || '').trim().toLowerCase();
  if (group.startsWith('marketing_')) return false;
  if (asArray(message.categories).map((v) => String(v).toLowerCase()).includes('bounce_recovery')) return false;
  return !!message.recipient_email_snapshot && !!message.subject_snapshot;
}

function retryStateForProviderBlock(message, now = new Date()) {
  if (!isTransactionalRetryEligible(message)) return {};
  const retryCount = Math.max(0, Number(message.provider_retry_count || 0));
  // Runtime rows selected after the migration carry this key (including
  // NULL), so webhook scheduling records positive rejection evidence. Keep
  // the helper's legacy return shape for older callers that supply a partial
  // pre-column object during rolling deploys.
  const phase = Object.prototype.hasOwnProperty.call(message, 'provider_handoff_phase')
    ? { provider_handoff_phase: HANDOFF_PHASE_REJECTED, provider_handoff_attempt_token: message.send_attempt_token || null }
    : {};
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

async function recoverStaleClaims(now = new Date()) {
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  // provider_retry_count > 0 distinguishes retry-worker claims from normal
  // sendTemplate rows that are independently protected by their own stale
  // in-flight logic.
  const stale = () => db('email_messages')
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
    const updated = await db.transaction(async (trx) => {
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
      provider_retry_count: db.raw('GREATEST(provider_retry_count - 1, 0)'),
      provider_handoff_phase: HANDOFF_PHASE_PENDING,
      provider_handoff_attempt_token: db.raw('send_attempt_token'),
      error_message: 'Interrupted provider retry claim recovered',
      updated_at: now,
    });

  // Rows scheduled before this phase existed cannot prove that their prior
  // provider handoff was rejected. Park them for office review instead of
  // repeatedly selecting them or guessing that another send is safe.
  const unsafeScheduled = await retryEvidence(db('email_messages'), [HANDOFF_PHASE_PENDING, HANDOFF_PHASE_REJECTED], false)
    .where({ status: 'failed' })
    .whereNotNull('provider_retry_next_at')
    .where('provider_retry_next_at', '<=', now)
    .where('provider_retry_count', '<', MAX_RETRIES)
    .select('id', 'send_attempt_token', 'provider_handoff_phase', 'provider_retry_next_at');
  let held = 0;
  for (const candidate of unsafeScheduled) {
    const updated = await db.transaction(async (trx) => {
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
  return Number(requeued || 0) + uncertain + held;
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
  if (!isProviderBlockedEvent(ev) || !isTransactionalRetryEligible(message)) return;
  if (Number(message.provider_retry_count || 0) < MAX_RETRIES) return;
  await alertExhausted(
    { ...message, provider_retry_count: MAX_RETRIES },
    emailTemplates.redactEmailAddresses(String(ev?.reason || ev?.response || 'SendGrid provider block')),
  );
}

async function markRetryFailure(message, err, now = new Date(), { rejectedAfterStart = false } = {}) {
  const reason = emailTemplates.redactEmailAddresses(String(err?.message || 'SendGrid retry failed')).slice(0, 1000);
  const retryCount = Number(message.provider_retry_count || 0);
  const exhausted = retryCount >= MAX_RETRIES;
  const nextAt = exhausted ? null : new Date(now.getTime() + RETRY_DELAYS_MS[retryCount]);
  const expectedPhase = rejectedAfterStart ? HANDOFF_PHASE_STARTED : HANDOFF_PHASE_PENDING;
  const [updated] = await db('email_messages')
    .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued',
      provider_handoff_phase: expectedPhase, provider_handoff_attempt_token: message.send_attempt_token })
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
async function stopRetry(message, { status, reason, exhaustedAlert = false, rejectedAfterStart = false }) {
  const isSummary = message.template_key === 'service.visit_summary';
  const settle = async (trx) => {
    const expectedPhase = rejectedAfterStart ? HANDOFF_PHASE_STARTED : HANDOFF_PHASE_PENDING;
    const [row] = await trx('email_messages')
      .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued',
        provider_handoff_phase: expectedPhase, provider_handoff_attempt_token: message.send_attempt_token })
      .update({ status, error_message: reason, provider_retry_next_at: null, provider_retry_exhausted_at: new Date(),
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
  if (updated && exhaustedAlert) await alertExhausted(updated, reason);
  return { sent: false, stopped: true, reason };
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

// Post-acceptance bookkeeping. A bearer-link summary whose bookkeeping fails
// after SendGrid accepted it settles as uncertain, never back on the schedule.
async function recordRetrySend(message, result) {
  let updated;
  try {
    [updated] = await db('email_messages')
      .where({ id: message.id, send_attempt_token: message.send_attempt_token,
        provider_handoff_phase: HANDOFF_PHASE_STARTED, provider_handoff_attempt_token: message.send_attempt_token })
      .update({
        provider_message_id: result.messageId,
        sent_at: new Date(),
        error_message: null,
        updated_at: new Date(),
        status: db.raw("CASE WHEN status = 'queued' THEN 'sent' ELSE status END"),
        // Round 9 structural fix (P1): sendOne rewrote a withheld estimate
        // link before this retry actually sent — persist the rewritten
        // bytes so the stored row reflects what the customer received, same
        // as a fresh sendTemplate send does (email-template-library.js).
        ...(result.withheldLinksRewritten?.length
          ? { html_snapshot: result.html, text_snapshot: result.text }
          : {}),
      })
      .returning('*');
  } catch (err) {
    await markRetryUncertain(message, new Error(`bookkeeping failed after acceptance: ${err.message}`)).catch(() => {});
    return { sent: false, uncertain: true, error: err };
  }
  if (!updated) return { sent: false, uncertain: true, reason: 'claim_lost_after_acceptance' };
  if (updated?.template_key === 'service.visit_summary') {
    await require('./visit-completion-summary').reconcileSummaryEmailRecovery(updated)
      .catch((err) => logger.warn(`[email-provider-retry] visit summary recovery not reconciled for ${message.id}: ${err.message}`));
  }
  return { sent: true, message: updated || message };
}

async function retryOne(message) {
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

  const group = String(message.suppression_group_key_snapshot || '').trim().toLowerCase();
  const asmGroupId = group === 'transactional_required' ? 0 : sendgrid.serviceGroupId();
  // dispatchStarted is set immediately before the Mail Send request: a
  // failure clearing the provider block is provably pre-send and keeps the
  // ordinary retry schedule.
  const state = { dispatchStarted: false, rejected: false, result: null, blocked: false };
  const dispatchToProvider = async () => {
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
    const started = await marker.update({
      provider_handoff_phase: HANDOFF_PHASE_STARTED,
      ...(message.template_key === 'service.visit_summary' ? { error_message: HANDOFF_STARTED } : {}),
      updated_at: new Date(),
    });
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
      });
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
        || err.code === 'SENDGRID_NOT_CONFIGURED'
        || sendgrid.isDefiniteRejection(err)));
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
    } else {
      await dispatchToProvider();
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
    await markRetryFailure(message, err, new Date(), { rejectedAfterStart: state.rejected });
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
  retryStateForProviderBlock,
  alertIfProviderRetriesExhausted,
  recoverStaleClaims,
  claimDueRetries,
  markRetryFailure,
  retryOne,
  runDueRetries,
};
