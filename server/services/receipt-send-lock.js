/**
 * One operator receipt send per invoice at a time: a Postgres advisory lock held
 * on its own connection for the whole send. Nothing is persisted, so there is
 * nothing to recover — a crash drops the connection and the lock with it.
 *
 * The lock transaction runs NO queries of the send (it holds only the advisory
 * lock, no row locks), so nothing a leg writes can deadlock against it. Same
 * convention as the repo's other try-locks (pg_try_advisory_xact_lock with
 * hashtext keys, e.g. visit-completion-invoice.js).
 *
 * Bounds, so a hung call cannot pin the connection forever:
 *  - the legs' own provider timeouts (SendGrid requests abort after 120 s,
 *    sendgrid-mail.js REQUEST_TIMEOUT_MS; the Twilio SDK's default request
 *    timeout is 30 s);
 *  - idle_in_transaction_session_timeout on this session, set to the operator
 *    claim's own staleness window (receipt-delivery-queue STALE_LOCK_MINUTES,
 *    10 min): past it the server ends the session and drops the lock, the same
 *    moment a crashed send's claim becomes recoverable;
 *  - the transaction ends in `finally` on every path, including a throw.
 * Pool: it pins one root-pool connection for the send's duration (the cron-lock
 * convention, knexfile poolConfig: max is at least 2).
 */
const db = require('../models/db');
const logger = require('./logger');

const NAMESPACE = 'receipt-resend';
const SESSION_IDLE_LIMIT_MS = 10 * 60 * 1000;

// run() executes while the lock is held. Returns { acquired: false } when another
// send holds it (no effects), else { acquired: true, value: <run's result> }.
async function withReceiptSendLock(invoiceId, run, { idleLimitMs = SESSION_IDLE_LIMIT_MS } = {}) {
  const lockTrx = await db.transaction();
  try {
    await lockTrx.raw("SELECT set_config('idle_in_transaction_session_timeout', ?, true)", [String(idleLimitMs)]);
    const lock = await lockTrx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS locked', [NAMESPACE, String(invoiceId)]);
    if (!lock.rows[0].locked) return { acquired: false };
    return { acquired: true, value: await run() };
  } finally {
    // Nothing was written on this connection: ending it (commit) only releases the lock. A
    // connection the server already ended (idle limit) has nothing left to release.
    await lockTrx.commit().catch((err) => logger.warn(`[receipt-send-lock] lock transaction end failed for invoice ${invoiceId}: ${err.message}`));
  }
}

module.exports = { withReceiptSendLock };
