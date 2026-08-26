// Synchronous provider opt-out recording — the ONE site that persists a
// send-time 21610 (Twilio rejecting messages.create() before any SID or
// delivery callback exists). Lives at the TwilioService.sendSMS choke point
// so every caller — wrapper-routed or direct — records identically; the
// delivery-status callback path in routes/twilio-webhook.js is its
// asynchronous twin and shares the same serialization discipline:
//
//   per-phone advisory lock → defer to a clearance newer than the attempt →
//   canonical write in-transaction → newest-command recheck (detector-only)
//   → self-undo → recipient DECLINED — all atomic, bells post-commit.
//
// attemptAt MUST be captured BEFORE the provider call (codex #3495): a
// START arriving during the send window is NEWER than the attempt and has
// to win the defer check; a timestamp taken after the rejection would
// misorder it.
const db = require('../../models/db');
const logger = require('../logger');
const { recordSuppression, clearSuppression } = require('./validators/suppression');
const { detectSmsOptCommand } = require('./opt-out-detector');

const maskPhone = (p) => String(p || '').replace(/(\d{3})\d{4}(\d{2})$/, '$1••••$2');

async function recordSyncProviderOptOut({ phone, attemptAt, source = 'twilio_send_21610' } = {}) {
  const optOutPhone = String(phone || '').replace(/[^\d+]/g, '');
  if (!optOutPhone) return { recorded: false, reason: 'no_phone' };
  const anchoredAt = attemptAt instanceof Date && !Number.isNaN(attemptAt.getTime()) ? attemptAt : new Date();
  const outcome = {};
  try {
    await db.transaction(async (trx) => {
      await trx.raw("SELECT pg_advisory_xact_lock(hashtext('twilio_21610'), hashtext(?::text))", [optOutPhone]);
      const supRow = await trx('messaging_suppression')
        .where({ phone: optOutPhone }).forUpdate().first('active', 'cleared_at');
      if (supRow && supRow.active === false && supRow.cleared_at
          && new Date(supRow.cleared_at) > anchoredAt) {
        outcome.deferred = 'cleared-after-attempt'; return;
      }
      const res = await recordSuppression({ phone: optOutPhone, reason: 'opt_out', source, dbh: trx });
      if (res?.ok === false) {
        throw Object.assign(new Error('suppression write reported failure'), { code: 'suppression_write_failed' });
      }
      const inbound = await trx('sms_log')
        .where({ from_phone: optOutPhone })
        .where('created_at', '>', anchoredAt)
        .orderBy('created_at', 'desc')
        .limit(50)
        .select('message_body');
      const newest = inbound
        .map((r) => detectSmsOptCommand(r.message_body || '').action)
        .find((a) => a === 'opt_in' || a === 'opt_out');
      if (newest === 'opt_in') {
        const cleared = await clearSuppression({ phone: optOutPhone, source: `${source}_undo`, dbh: trx });
        if (cleared?.ok === false) {
          throw Object.assign(new Error('clearSuppression reported failure'), { code: 'suppression_clear_failed' });
        }
        outcome.undone = true; return;
      }
      // Recipient verdict, mirroring the callback path: a 21610 on the
      // opt-in ask must land as DECLINED — ask_failed is a state a later
      // START's confirm deliberately ignores. FALSE ≡ swallowed SQL error
      // (phone is normalized above): throw, roll back cleanly.
      const declined = await require('../recipient-optin').markRecipientOptin(optOutPhone, 'declined', { dbh: trx });
      if (declined === false) {
        throw Object.assign(new Error('recipient decline write reported failure'), { code: 'recipient_decline_failed' });
      }
      outcome.recorded = true;
    });
  } catch (err) {
    outcome.failed = err.code || err.name || 'db_error';
  }
  if (outcome.failed) {
    logger.warn(`[sync-optout] send-time 21610 recording FAILED for ${maskPhone(optOutPhone)}: ${outcome.failed}`);
    try {
      await require('../notification-service').notifyAdmin(
        'system',
        'Opt-out suppression write failed',
        `A synchronous Twilio 21610 rejection for ${maskPhone(optOutPhone)} could not be recorded (${outcome.failed}). Add this number to the do-not-text list manually — other SMS workflows cannot see the opt-out until it is recorded.`,
        { bell: true, metadata: { source, error: outcome.failed } },
      );
    } catch (notifyErr) {
      logger.error(`[sync-optout] failure notify also failed: ${notifyErr.message}`);
    }
  } else if (outcome.recorded) {
    logger.info(`[sync-optout] send-time 21610 recorded for ${maskPhone(optOutPhone)}`);
  }
  return outcome;
}

module.exports = { recordSyncProviderOptOut };
