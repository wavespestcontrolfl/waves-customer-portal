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
 * Bounds on how long a session can be held: a lease equal to the operator claim's own
 * staleness window (receipt-delivery-queue STALE_LOCK_MINUTES, 10 min) from the start of
 * the send: past it the session is closed here, which drops the lock and flips owner.lost().
 * The writer's provider-handoff guard calls owner.extendLease(window) where the provider
 * request starts, with a window that covers that provider client's own timeout plus a margin
 * (invoice-receipt-resend.js), so a request that starts near the end of the lease is not cut
 * off in flight; the deadline only moves later, and a request that never returns still ends
 * at its client timeout. owner.query runs a statement on this session (the claim heartbeat).
 */
const { rawConnectionSlots, trackConnectionLoss } = require('./raw-connection-slots');
const logger = require('./logger');

const NAMESPACE = 'receipt-resend';
const MAX_OPEN_LOCKS = 4;
const CONNECT_MS = 5000;
const LEASE_MS = 10 * 60 * 1000;
const QUERY_MS = 10 * 1000;

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
  let closing = null;
  // One release, shared: a caller that arrives while the lease timer's release is still in progress
  // waits for that same release, so the slot is free by the time withReceiptSendLock returns.
  const closeSession = () => {
    if (!closing) {
      released = true;
      held.lost = true;
      closing = slots.release(connection);
    }
    return closing;
  };
  // The lease is a deadline that only moves later (owner.extendLease): re-armed from the provider handoff
  // so a request that starts near the end of the lease is not cut off while it is still in flight.
  let deadline = Date.now() + leaseMs;
  let lease = null;
  const arm = () => {
    clearTimeout(lease);
    lease = setTimeout(() => {
      logger.warn(`[receipt-send-lock] lease expired for invoice ${invoiceId} — releasing the lock`);
      closeSession().catch(() => {});
    }, Math.max(0, deadline - Date.now()));
    if (typeof lease.unref === 'function') lease.unref();
  };
  arm();
  // Keep the lock until at least `ms` from now (never shorter than the current deadline). false = the
  // session is already gone, so the lock can no longer be kept.
  const extendLease = (ms) => {
    if (released || held.lost) return false;
    deadline = Math.max(deadline, Date.now() + Math.max(0, Number(ms) || 0));
    arm();
    return true;
  };
  // A statement on the lock's OWN session (not the pool), for work that must run where the pool may be
  // exhausted: the App path calls the handoff guard while it holds a pooled transaction. statement_timeout
  // (10 s, set at lock time) bounds it.
  const query = async (sql, params) => {
    if (released || held.lost) throw new Error('send lock session is gone');
    // statement_timeout does not cover a socket that went silent: the wait is bounded here too.
    let timer;
    try {
      return await Promise.race([
        connection.query(sql, params),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('send lock session query timed out')), QUERY_MS); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    if (!(await tryLock(connection, invoiceId, held))) return { acquired: false, reason: held.lost ? 'unavailable' : 'busy' };
    const value = await run({ lost: () => held.lost, extendLease, query });
    return { acquired: true, value, lost: held.lost };
  } finally {
    clearTimeout(lease);
    // Destroying the session ends it, which drops every advisory lock it held.
    await closeSession();
  }
}

module.exports = { withReceiptSendLock, _slots: slots };
