/**
 * One operator receipt send per invoice at a time: a session advisory lock held
 * on its own UNPOOLED connection for the whole send. Nothing is persisted, so
 * there is nothing to recover — a crash, or the connection ending for any
 * reason, drops the lock with it.
 *
 * Built on the repo's existing bounded raw-connection mechanism
 * (raw-connection-slots.js, lifted from reschedule-link-promises.js' send
 * interlock — read its header: a pooled transaction held across a flow that
 * opens pooled transactions of its own deadlocks two simultaneous sends once the
 * pool has two slots, DB_POOL_MAX=2). The lock session holds ONLY the advisory
 * lock, runs on its own connection outside DB_POOL_MAX, and is bounded in count
 * (MAX_OPEN_LOCKS) and connect time (CONNECT_MS). When no slot can be had the
 * caller is refused like "in flight" — never an unbounded wait.
 *
 * Losing the session is tracked with the helper's own signal
 * (trackConnectionLoss: the connection's error / end / close events), exactly as
 * the send interlock does. run() receives `owner`; `owner.lost()` is true once the
 * session has ended (the server dropped it, the lease expired, or the lock was
 * released), and the caller checks it before each effect so nothing new starts
 * after another send could have taken the lock.
 *
 * Bounds on how long a session can be held: the legs' own provider timeouts
 * (SendGrid requests abort after 120 s, sendgrid-mail.js REQUEST_TIMEOUT_MS; the
 * Twilio SDK's default request timeout is 30 s), and a lease equal to the operator
 * claim's own staleness window (receipt-delivery-queue STALE_LOCK_MINUTES, 10 min):
 * past it the session is closed here, which drops the lock and flips owner.lost().
 */
const { rawConnectionSlots, trackConnectionLoss } = require('./raw-connection-slots');
const logger = require('./logger');

const NAMESPACE = 'receipt-resend';
const MAX_OPEN_LOCKS = 4;
const CONNECT_MS = 5000;
const LEASE_MS = 10 * 60 * 1000;

const slots = rawConnectionSlots({ max: MAX_OPEN_LOCKS, connectMs: CONNECT_MS, logPrefix: '[receipt-send-lock] lock session' });

// Take the lock on this session, or say so. A try-lock never queues; statement_timeout
// bounds the round trip. A failed query on the session also means the lock is not held.
async function tryLock(connection, invoiceId, held) {
  try {
    await connection.query("SET statement_timeout = '10s'");
    const res = await connection.query('SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked', [NAMESPACE, String(invoiceId)]);
    return Boolean(res.rows[0].locked) && !held.lost;
  } catch (err) {
    held.lost = true;
    logger.warn(`[receipt-send-lock] lock not taken for ${invoiceId} (${err.code || err.name || 'error'})`);
    return false;
  }
}

// run(owner) executes while the lock is held. Returns
//   { acquired: false, reason: 'busy' }         another send holds it (no effects)
//   { acquired: false, reason: 'unavailable' }  no lock session could be had (slots exhausted / connect failed)
//   { acquired: true, value: <run's result>, lost: <whether the session was lost before run finished> }
async function withReceiptSendLock(invoiceId, run, { leaseMs = LEASE_MS } = {}) {
  const connection = await slots.acquire();
  if (!connection) return { acquired: false, reason: 'unavailable' };
  const held = { lost: false };
  trackConnectionLoss(connection, held);
  let released = false;
  const closeSession = async () => {
    if (released) return;
    released = true;
    held.lost = true;
    await slots.release(connection);
  };
  const lease = setTimeout(() => {
    logger.warn(`[receipt-send-lock] lease expired for invoice ${invoiceId} — releasing the lock`);
    closeSession().catch(() => {});
  }, leaseMs);
  if (typeof lease.unref === 'function') lease.unref();
  try {
    if (!(await tryLock(connection, invoiceId, held))) return { acquired: false, reason: held.lost ? 'unavailable' : 'busy' };
    const value = await run({ lost: () => held.lost });
    return { acquired: true, value, lost: held.lost };
  } finally {
    clearTimeout(lease);
    // Destroying the session ends it, which drops every advisory lock it held.
    await closeSession();
  }
}

module.exports = { withReceiptSendLock, _slots: slots };
