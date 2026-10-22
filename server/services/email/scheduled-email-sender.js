/**
 * Sends due scheduled emails (table scheduled_emails; migration
 * 20261022130000). Run every minute by scheduler.js behind
 * GATE_EMAIL_SEND_LATER. Same Gmail path as POST /api/admin/email/send.
 *
 * At most once: a row is claimed ('scheduled' -> 'sending') before Gmail is
 * called. Gmail accepted -> 'sent'. A definite refusal goes back to
 * 'scheduled' for the next minute, and to 'failed' on the last attempt. A
 * possible acceptance (timeout, no message id) and a claim older than
 * STALE_MINUTES (the process died mid-send) become 'outcome_unknown' and are
 * never retried: the office checks the Gmail Sent folder. Both end states
 * ring one admin alert.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { emailSendLaterLive } = require('../../config/feature-gates');

const MAX_ATTEMPTS = 3;
const RETRY_GAP_SECONDS = 60;
// Up to SEND_CONCURRENCY Gmail requests at once, and no new claim after
// CLAIM_BUDGET_MS, so a slow Gmail cannot hold one sweep for many minutes
// (the rest go on the next sweep, here or on another replica).
const SEND_CONCURRENCY = 5;
const CLAIM_BUDGET_MS = 30 * 1000;
// A Gmail request is aborted well before STALE_MINUTES, so no request can
// still be running when a stale claim becomes outcome_unknown.
const SEND_TIMEOUT_MS = 60 * 1000;
const CLAIM_EXPIRED_ERROR = 'claim expired before Gmail answered';
const UNCONFIRMED_ERROR = 'Gmail did not confirm the send';
// last_error of a row Gmail may have accepted (kept when it is cancelled).
const OUTCOME_UNKNOWN_ERRORS = [CLAIM_EXPIRED_ERROR, UNCONFIRMED_ERROR];
const STALE_MINUTES = 10;
const BATCH = 20;

const etTime = (date) => new Date(date).toLocaleString('en-US', {
  timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

async function alertOffice(row, kind) {
  const { raiseAdminAlert } = require('../admin-alert-compose');
  const unknown = kind === 'outcome_unknown';
  try {
    const alert = await raiseAdminAlert('alert', {
      area: 'Comms',
      action: unknown ? 'check Sent for a scheduled email' : 'resend a scheduled email',
      why: unknown
        ? `The ${etTime(row.send_at)} email may have gone out, so it was not sent again.`
        : `Gmail refused the ${etTime(row.send_at)} email ${MAX_ATTEMPTS} times.`,
      severity: 'needs-you',
      link: '/admin/communications#tab=email',
      subject: { type: 'check', id: String(row.id) },
      doneWhen: 'office_checked',
      who: 'person',
    }, {
      bell: true, dedupeKey: alertKey(row.id), metadata: { scheduledEmailId: row.id },
      detail: `To: ${row.to_address}\n${unknown ? 'Look in the Gmail Sent folder first. If it is not there, open Email, then Scheduled, and tap Back to draft.' : 'Open Email, then Scheduled, and tap Back to draft to fix and resend it.'}`,
    });
    // notifyAdmin answers null (it does not throw) when the row was not
    // written: that is a failed alert, which raiseMissedAlerts retries.
    if (!alert?.id) throw Object.assign(new Error('alert not written'), { code: 'alert_not_written' });
    return true;
  } catch (err) {
    // raiseMissedAlerts tries again on the next run.
    logger.error(`[scheduled-email] alert failed for ${row.id} (${err.code || 'error'})`);
    return false;
  }
}

const alertKey = (id) => `scheduled-email:${id}`;
const ALERT_LOOKBACK_DAYS = 7;

// A failed or unclear email whose alert write failed has no notification row
// yet: raise it now. The alert's dedupeKey lives in notifications.metadata.
async function raiseMissedAlerts(conn = db) {
  const rows = await conn('scheduled_emails as s')
    .whereIn('s.status', ['failed', 'outcome_unknown'])
    .where('s.updated_at', '>', conn.raw(`now() - interval '${ALERT_LOOKBACK_DAYS} days'`))
    .whereNotExists(conn('notifications').select(conn.raw('1'))
      .where('recipient_type', 'admin')
      .whereRaw("metadata->>'dedupeKey' = 'scheduled-email:' || s.id::text"))
    .select('s.id', 's.to_address', 's.send_at', 's.status');
  let failed = 0;
  for (const row of rows) if (!(await alertOffice(row, row.status))) failed += 1;
  return failed;
}

// A claim this old belongs to a process that died between claiming and
// recording Gmail's answer, so Gmail may have the email: never resend it.
async function settleStaleClaims(conn = db) {
  const rows = await conn('scheduled_emails')
    .where({ status: 'sending' })
    .where('claimed_at', '<', conn.raw(`now() - interval '${STALE_MINUTES} minutes'`))
    .update({ status: 'outcome_unknown', last_error: CLAIM_EXPIRED_ERROR, updated_at: conn.fn.now() })
    .returning(['id', 'to_address', 'send_at']);
  for (const row of rows) await alertOffice(row, 'outcome_unknown');
  return rows.length;
}

// Claims ONE due row, just before it is sent, so an error never leaves rows
// claimed but unsent (those would settle as outcome_unknown). A refused email
// keeps its claimed_at, so no replica claims it again for RETRY_GAP_SECONDS:
// a brief Gmail failure cannot burn every attempt within one minute.
// `tried` holds this run's rows.
async function claimNext(conn = db, tried = []) {
  const { rows } = await conn.raw(`
    UPDATE scheduled_emails SET status = 'sending', claimed_at = now(), attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM scheduled_emails WHERE status = 'scheduled' AND send_at <= now() AND NOT (id = ANY(?::uuid[]))
        AND (claimed_at IS NULL OR claimed_at <= now() - interval '${RETRY_GAP_SECONDS} seconds')
      ORDER BY send_at LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    RETURNING id, to_address, subject, body_html, thread_id, reply_email_id, send_at, attempts`, [`{${tried.join(',')}}`]);
  return rows[0] || null;
}

// A reply needs the source email's Message-ID (In-Reply-To / References) as
// well as the thread id to join the conversation, as email-actions.js does.
// A lookup failure only degrades threading; the email still goes.
async function sourceMessageId(row, conn) {
  if (!row.reply_email_id) return null;
  try {
    const source = await conn('emails').where({ id: row.reply_email_id }).first('message_id');
    return source?.message_id || null;
  } catch (err) {
    logger.warn(`[scheduled-email] source message lookup failed for ${row.id} (${err.code || 'error'})`);
    return null;
  }
}

async function sendOne(row, { conn = db, gmail = require('./gmail-client') } = {}) {
  const fence = { id: row.id, status: 'sending' };
  let result;
  try {
    result = await gmail.sendMessage(row.to_address, row.subject, row.body_html, row.thread_id || null, await sourceMessageId(row, conn), { timeoutMs: SEND_TIMEOUT_MS });
  } catch (err) {
    if (err.providerOutcome?.outcomeUnknown === true) return settleUnknown(row, conn);
    const last = row.attempts >= MAX_ATTEMPTS;
    await conn('scheduled_emails').where(fence).update({
      // claimed_at stays: RETRY_GAP_SECONDS after it, any replica may try again.
      status: last ? 'failed' : 'scheduled',
      last_error: String(err.message || 'send failed').slice(0, 500), updated_at: conn.fn.now(),
    });
    if (last) await alertOffice(row, 'failed');
    logger.error(`[scheduled-email] ${last ? 'failed' : 'will retry'} ${row.id} (attempt ${row.attempts})`);
    return last ? 'failed' : 'retry';
  }
  if (!result?.id) return settleUnknown(row, conn);
  // Gmail accepted it: from here nothing may requeue the row. If this write
  // fails, the row stays 'sending' and settleStaleClaims later marks it
  // outcome_unknown with an alert; it is never sent again.
  try {
    await conn('scheduled_emails').where(fence)
      .update({ status: 'sent', gmail_message_id: result.id, sent_at: conn.fn.now(), last_error: null, updated_at: conn.fn.now() });
  } catch (err) {
    logger.error(`[scheduled-email] sent ${row.id} but could not record it (${err.code || 'db_error'})`);
    return 'sent_unrecorded';
  }
  logger.info(`[scheduled-email] sent ${row.id}: ${result.id}`);
  return 'sent';
}

async function settleUnknown(row, conn) {
  await conn('scheduled_emails').where({ id: row.id, status: 'sending' })
    .update({ status: 'outcome_unknown', last_error: UNCONFIRMED_ERROR, updated_at: conn.fn.now() });
  await alertOffice(row, 'outcome_unknown');
  logger.error(`[scheduled-email] outcome unknown for ${row.id}`);
  return 'outcome_unknown';
}

// Claims up to SEND_CONCURRENCY due rows for one parallel group.
async function claimGroup(conn, tried) {
  const group = [];
  while (group.length < SEND_CONCURRENCY && tried.length < BATCH) {
    const row = await claimNext(conn, tried);
    if (!row) break;
    tried.push(row.id);
    group.push(row);
  }
  return group;
}

async function sendDueScheduledEmails({ conn = db, gmail } = {}) {
  if (!emailSendLaterLive()) return { enabled: false, settled: 0, results: [] };
  const settled = await settleStaleClaims(conn);
  const results = [];
  const tried = [];
  const claimUntil = Date.now() + CLAIM_BUDGET_MS;
  while (tried.length < BATCH && Date.now() < claimUntil) {
    const group = await claimGroup(conn, tried);
    results.push(...await Promise.all(group.map((row) => sendOne(row, { conn, ...(gmail ? { gmail } : {}) }).catch((err) => {
      // The claim stays 'sending'; settleStaleClaims turns it into
      // outcome_unknown with an alert. The other emails still go out.
      logger.error(`[scheduled-email] ${row.id} errored (${err.code || 'error'})`);
      return 'error';
    }))));
    if (group.length < SEND_CONCURRENCY) break;
  }
  const missedAlerts = await raiseMissedAlerts(conn);
  const summary = { enabled: true, settled, results, missedAlerts };
  // Every claimed email was still tried; a run with an error reads as failed
  // in job_health (runScheduledSweep records the throw).
  if (results.includes('error') || missedAlerts > 0) {
    throw Object.assign(new Error(`scheduled-email sweep: ${results.filter((r) => r === 'error').length} error(s), ${missedAlerts} alert(s) not raised`), { summary });
  }
  return summary;
}

const JOB_NAME = 'scheduled-email-send';

// The every-minute cron entry: one sweep at a time in this process. No fleet
// lease (the row claim is the fence); job_health through cron-lock's
// recordLeaseFreeJobEnd, so a concurrent empty sweep cannot hide a failure.
let sweeping = false;
async function runScheduledSweep({ conn = db, gmail } = {}) {
  if (sweeping) return { skipped: 'overlap' };
  sweeping = true;
  const { recordLeaseFreeJobEnd } = require('../../utils/cron-lock');
  const startedAt = Date.now();
  try {
    const summary = await sendDueScheduledEmails({ conn, gmail });
    await recordLeaseFreeJobEnd(JOB_NAME, startedAt, null);
    return summary;
  } catch (err) {
    await recordLeaseFreeJobEnd(JOB_NAME, startedAt, err);
    throw err;
  } finally {
    sweeping = false;
  }
}

module.exports = { runScheduledSweep, OUTCOME_UNKNOWN_ERRORS, SEND_TIMEOUT_MS, sendDueScheduledEmails, settleStaleClaims, claimNext, sendOne, raiseMissedAlerts, MAX_ATTEMPTS, STALE_MINUTES };
