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
const STALE_MINUTES = 10;
const BATCH = 20;

const etTime = (date) => new Date(date).toLocaleString('en-US', {
  timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

async function alertOffice(row, kind) {
  const { raiseAdminAlert } = require('../admin-alert-compose');
  const unknown = kind === 'outcome_unknown';
  try {
    await raiseAdminAlert('alert', {
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
      bell: true, dedupeKey: `scheduled-email:${row.id}`, metadata: { scheduledEmailId: row.id },
      detail: `To: ${row.to_address}\n${unknown ? 'Look in the Gmail Sent folder first. If it is not there, open Email, then Scheduled, and tap Back to draft.' : 'Open Email, then Scheduled, and tap Back to draft to fix and resend it.'}`,
    });
  } catch (err) {
    logger.error(`[scheduled-email] alert failed for ${row.id}: ${err.message}`);
  }
}

// A claim this old belongs to a process that died between claiming and
// recording Gmail's answer, so Gmail may have the email: never resend it.
async function settleStaleClaims(conn = db) {
  const rows = await conn('scheduled_emails')
    .where({ status: 'sending' })
    .where('claimed_at', '<', conn.raw(`now() - interval '${STALE_MINUTES} minutes'`))
    .update({ status: 'outcome_unknown', last_error: 'claim expired before Gmail answered', updated_at: conn.fn.now() })
    .returning(['id', 'to_address', 'send_at']);
  for (const row of rows) await alertOffice(row, 'outcome_unknown');
  return rows.length;
}

async function claimDue(conn = db) {
  const { rows } = await conn.raw(`
    UPDATE scheduled_emails SET status = 'sending', claimed_at = now(), attempts = attempts + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM scheduled_emails WHERE status = 'scheduled' AND send_at <= now()
      ORDER BY send_at LIMIT ${BATCH} FOR UPDATE SKIP LOCKED
    )
    RETURNING id, to_address, subject, body_html, thread_id, send_at, attempts`);
  return rows;
}

async function sendOne(row, { conn = db, gmail = require('./gmail-client') } = {}) {
  const fence = { id: row.id, status: 'sending' };
  try {
    const result = await gmail.sendMessage(row.to_address, row.subject, row.body_html, row.thread_id || null);
    if (!result?.id) throw Object.assign(new Error('Gmail returned no message identifier'), { providerOutcome: { outcomeUnknown: true } });
    await conn('scheduled_emails').where(fence)
      .update({ status: 'sent', gmail_message_id: result.id, sent_at: conn.fn.now(), last_error: null, updated_at: conn.fn.now() });
    logger.info(`[scheduled-email] sent ${row.id}: ${result.id}`);
    return 'sent';
  } catch (err) {
    if (err.providerOutcome?.outcomeUnknown === true) {
      await conn('scheduled_emails').where(fence)
        .update({ status: 'outcome_unknown', last_error: 'Gmail did not confirm the send', updated_at: conn.fn.now() });
      await alertOffice(row, 'outcome_unknown');
      logger.error(`[scheduled-email] outcome unknown for ${row.id}`);
      return 'outcome_unknown';
    }
    const last = row.attempts >= MAX_ATTEMPTS;
    await conn('scheduled_emails').where(fence).update({
      status: last ? 'failed' : 'scheduled', claimed_at: null,
      last_error: String(err.message || 'send failed').slice(0, 500), updated_at: conn.fn.now(),
    });
    if (last) await alertOffice(row, 'failed');
    logger.error(`[scheduled-email] ${last ? 'failed' : 'will retry'} ${row.id} (attempt ${row.attempts})`);
    return last ? 'failed' : 'retry';
  }
}

async function sendDueScheduledEmails({ conn = db, gmail } = {}) {
  if (!emailSendLaterLive()) return { enabled: false, settled: 0, results: [] };
  const settled = await settleStaleClaims(conn);
  const rows = await claimDue(conn);
  const results = [];
  for (const row of rows) results.push(await sendOne(row, { conn, ...(gmail ? { gmail } : {}) }));
  return { enabled: true, settled, results };
}

module.exports = { sendDueScheduledEmails, settleStaleClaims, claimDue, sendOne, MAX_ATTEMPTS, STALE_MINUTES };
