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
  const group = String(message.suppression_group_key_snapshot || '').trim().toLowerCase();
  if (group.startsWith('marketing_')) return false;
  if (asArray(message.categories).map((v) => String(v).toLowerCase()).includes('bounce_recovery')) return false;
  return !!message.recipient_email_snapshot && !!message.subject_snapshot;
}

function retryStateForProviderBlock(message, now = new Date()) {
  if (!isTransactionalRetryEligible(message)) return {};
  const retryCount = Math.max(0, Number(message.provider_retry_count || 0));
  if (retryCount >= MAX_RETRIES) {
    return {
      provider_retry_next_at: null,
      provider_retry_exhausted_at: now,
    };
  }
  return {
    provider_retry_next_at: new Date(now.getTime() + RETRY_DELAYS_MS[retryCount]),
    provider_retry_exhausted_at: null,
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
    const rows = await trx('email_messages')
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
      const [updated] = await trx('email_messages')
        .where({ id: row.id, status: 'failed' })
        .where('provider_retry_next_at', '<=', now)
        .update({
          status: 'queued',
          provider_message_id: null,
          send_attempt_token: sendAttemptToken,
          sent_at: null,
          queued_at: now,
          provider_retry_next_at: null,
          provider_retry_count: trx.raw('provider_retry_count + 1'),
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
  // A summary interrupted after its handoff began has no known provider
  // outcome: terminal for the office, exactly like an exhausted retry. The
  // row's settlement and the summary's transition commit together, per
  // row, so a failure between them leaves the row queued for this sweep to
  // find again instead of exhausted with the summary still reading as sent.
  const started = await stale().where({ error_message: HANDOFF_STARTED }).select('id', 'send_attempt_token');
  let uncertain = 0;
  for (const claim of started) {
    uncertain += await db.transaction(async (trx) => {
      const [row] = await trx('email_messages').where({ id: claim.id, send_attempt_token: claim.send_attempt_token, status: 'queued', error_message: HANDOFF_STARTED })
        .update({
          status: 'failed',
          provider_retry_next_at: null,
          provider_retry_exhausted_at: now,
          error_message: 'Provider outcome unknown: interrupted after the provider handoff began',
          updated_at: now,
        }).returning('*');
      if (!row) return 0;
      await reconcileExhaustedSummary(row, trx);
      return 1;
    });
  }
  const requeued = await stale()
    .where((q) => q.whereNull('error_message').orWhereNot('error_message', HANDOFF_STARTED))
    .update({
      status: 'failed',
      provider_retry_next_at: now,
      // The claim increments before network I/O. These rows have neither a
      // provider id nor a sent timestamp, so refund the interrupted claim and
      // let the next worker consume the same bounded attempt slot.
      provider_retry_count: db.raw('GREATEST(provider_retry_count - 1, 0)'),
      error_message: 'Interrupted provider retry claim recovered',
      updated_at: now,
    });
  return Number(requeued || 0) + uncertain;
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

async function markRetryFailure(message, err, now = new Date()) {
  const reason = emailTemplates.redactEmailAddresses(String(err?.message || 'SendGrid retry failed')).slice(0, 1000);
  const retryCount = Number(message.provider_retry_count || 0);
  const exhausted = retryCount >= MAX_RETRIES;
  const nextAt = exhausted ? null : new Date(now.getTime() + RETRY_DELAYS_MS[retryCount]);
  const [updated] = await db('email_messages')
    .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued' })
    .update({
      status: 'failed',
      error_message: reason,
      provider_retry_next_at: nextAt,
      provider_retry_exhausted_at: exhausted ? now : null,
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
      .update({ status: 'failed', error_message: reason, provider_retry_next_at: null, provider_retry_exhausted_at: now, updated_at: now })
      .returning('*');
    if (row) await reconcileExhaustedSummary(row, trx);
    return row || null;
  });
  if (updated) await alertExhausted(updated, reason);
  return updated;
}

// A row stopped before any provider request: terminal for the rail, and a
// summary's aggregate is settled from the ledger since no webhook follows.
async function stopRetry(message, { status, reason, exhaustedAlert = false }) {
  const isSummary = message.template_key === 'service.visit_summary';
  const settle = async (trx) => {
    const [row] = await trx('email_messages')
      .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued' })
      .update({ status, error_message: reason, provider_retry_next_at: null, provider_retry_exhausted_at: new Date(), updated_at: new Date() })
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
    .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued' })
    .update({ error_message: HANDOFF_PENDING, updated_at: new Date() });
  if (Number(marked) !== 1) return { outcome: { sent: false, stopped: true, reason: 'claim_lost' } };
  let fence;
  try {
    fence = await require('./visit-completion-summary').retrySummaryThroughHandoff(message, dispatchToProvider);
  } catch (err) {
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
    return { outcome: await stopRetry(message, { status: 'blocked', reason: `Suppressed before retry: ${fence?.reason || 'visit_summary_unavailable'}` }) };
  }
  return { result: state.result };
}

// Post-acceptance bookkeeping. A bearer-link summary whose bookkeeping fails
// after SendGrid accepted it settles as uncertain, never back on the schedule.
async function recordRetrySend(message, result) {
  let updated;
  try {
    [updated] = await db('email_messages')
      .where({ id: message.id, send_attempt_token: message.send_attempt_token })
      .update({
        provider_message_id: result.messageId,
        sent_at: new Date(),
        error_message: null,
        updated_at: new Date(),
        status: db.raw("CASE WHEN status = 'queued' THEN 'sent' ELSE status END"),
      })
      .returning('*');
  } catch (err) {
    if (message.template_key === 'service.visit_summary') {
      await markRetryUncertain(message, new Error(`bookkeeping failed after acceptance: ${err.message}`)).catch(() => {});
      return { sent: false, uncertain: true, error: err };
    }
    throw err;
  }
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
  const state = { dispatchStarted: false, result: null };
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
    if (message.template_key === 'service.visit_summary') {
      const started = await require('../models/marker-db')()('email_messages')
        .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued', error_message: HANDOFF_PENDING })
        .update({ error_message: HANDOFF_STARTED, updated_at: new Date() });
      if (Number(started) !== 1) throw new Error('Visit summary retry claim was reclaimed before the provider request');
    }
    state.dispatchStarted = true;
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
    });
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
    return await recordRetrySend(message, state.result);
  } catch (err) {
    // A bearer-link summary whose provider request began is never requeued:
    // if the uncertain settlement itself failed above, it is attempted once
    // more here, and a row it still cannot settle keeps its started marker
    // for stale-claim recovery to settle as uncertain.
    if (message.template_key === 'service.visit_summary' && state.dispatchStarted) {
      await markRetryUncertain(message, err).catch((again) => logger.error(`[email-provider-retry] uncertain settlement failed twice for ${message.id}: ${again.message}`));
      return { sent: false, uncertain: true, error: err };
    }
    await markRetryFailure(message, err);
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
