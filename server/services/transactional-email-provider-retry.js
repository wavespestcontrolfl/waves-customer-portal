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

async function recoverStaleClaims(now = new Date()) {
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  return db('email_messages')
    // provider_retry_count > 0 distinguishes retry-worker claims from normal
    // sendTemplate rows that are independently protected by their own stale
    // in-flight logic.
    .where({ status: 'queued' })
    .where('provider_retry_count', '>', 0)
    .whereNull('provider_retry_next_at')
    .whereNull('provider_retry_exhausted_at')
    .whereNull('provider_message_id')
    .whereNull('sent_at')
    .where('queued_at', '<=', staleBefore)
    .update({
      status: 'failed',
      provider_retry_next_at: now,
      error_message: 'Interrupted provider retry claim recovered',
      updated_at: now,
    });
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
  if (updated && exhausted) await alertExhausted(updated, reason);
  return updated || null;
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
    const reason = suppression.suppression_type === 'template_unavailable'
      ? 'Template is unavailable; retry stopped.'
      : `Suppressed before retry: ${suppression.suppression_type}`;
    const [updated] = await db('email_messages')
      .where({ id: message.id, send_attempt_token: message.send_attempt_token, status: 'queued' })
      .update({
        status: suppression.suppression_type === 'template_unavailable' ? 'failed' : 'blocked',
        error_message: reason,
        provider_retry_next_at: null,
        provider_retry_exhausted_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');
    if (updated && suppression.suppression_type === 'template_unavailable') await alertExhausted(updated, reason);
    return { sent: false, stopped: true, reason };
  }

  const group = String(message.suppression_group_key_snapshot || '').trim().toLowerCase();
  const asmGroupId = group === 'transactional_required' ? 0 : sendgrid.serviceGroupId();
  try {
    // Blocks are a provider-specific suppression distinct from hard bounces.
    // If it remains, SendGrid will drop the retry before attempting delivery.
    await sendgrid.clearBlockedAddress(message.recipient_email_snapshot);
    const result = await sendgrid.sendOne({
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
    const [updated] = await db('email_messages')
      .where({ id: message.id, send_attempt_token: message.send_attempt_token })
      .update({
        provider_message_id: result.messageId,
        sent_at: new Date(),
        error_message: null,
        updated_at: new Date(),
        status: db.raw("CASE WHEN status = 'queued' THEN 'sent' ELSE status END"),
      })
      .returning('*');
    return { sent: true, message: updated || message };
  } catch (err) {
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
