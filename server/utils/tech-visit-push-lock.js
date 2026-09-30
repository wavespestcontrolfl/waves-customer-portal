/**
 * Cross-instance ordering for a visit's tech PUSH delivery.
 *
 * The feed rows (tech_notifications) are already safe across app instances:
 * writeCard re-checks the visit row FOR SHARE in the insert's transaction.
 * The push is not — it runs after that transaction commits, and during a
 * deploy two instances overlap (cron-lock.js), so instance 1's delayed push
 * for A→B ("new visit") could be handed to the provider AFTER instance 2's
 * push for B→C ("moved off"), leaving a stale alert on the lock screen.
 * The in-process per-visit chain (enqueueForVisit) still orders notices
 * within ONE instance; this lock orders them across instances.
 *
 * Every tech push for one scheduled_services row — visit notices, the
 * customer-photo alert, follow-through tracking pushes — takes
 * pg_advisory_xact_lock(hashtextextended('tech-visit-push:<id>', 0)) (same
 * hashtextextended idiom as customer-comms-lock.js) around the provider
 * handoff, and re-checks that the push is still current UNDER the lock.
 *
 * LOCK CHOICE. A transaction-scoped lock in a short DEDICATED transaction,
 * not a session lock (pg_try_advisory_lock): the lock cannot leak past a
 * crash or a pooled connection returned dirty, and it is released by
 * commit/rollback with no unlock bookkeeping. The transaction takes NO row
 * locks and writes nothing — the recheck reads the visit row plainly, never
 * FOR SHARE, so a schedule writer is never blocked by a push in flight. The
 * only thing that ever waits on this lock is another push for the same visit.
 *
 * HOLD TIME. The lock is held across the provider round trip, which is
 * bounded: every transport enforces its own timeout (web-push 8 s in
 * push-notifications.js, apns.js and fcm.js their own), so a hung provider
 * cannot pin the lock forever. The waiter side is bounded too:
 * `SET LOCAL lock_timeout` makes a stuck holder cost a waiter at most
 * LOCK_TIMEOUT_MS. While held, the transaction pins ONE pool connection and
 * the send needs another (subscription lookup), so an in-process cap on
 * concurrent holders (a fraction of the pool) keeps a bulk reschedule from
 * pinning the whole pool and starving the sends; extra pushes wait in
 * memory, holding no connection.
 *
 * ERROR POLICY (fail open). A CLEAN "stale" verdict from the recheck skips
 * the push — the newer change's own push is the one that lands. A lock or
 * recheck ERROR (lock timeout, no pool connection, a failed query) SENDS
 * anyway: the card is already durable, and a missed alert on a route change
 * is worse than a rare misordered one. Nothing here throws to the caller
 * except the send's own error, which callers already log and swallow.
 */
const db = require('../models/db');
const logger = require('../services/logger');

const LOCK_NAMESPACE = 'tech-visit-push';
// A holder spends at most a few 8 s provider timeouts (one per device) here.
const LOCK_TIMEOUT_MS = 20000;
const DEFAULT_MAX_HOLDERS = 4;

function maxHolders() {
  const poolMax = Number(db && db.client && db.client.pool && db.client.pool.max);
  if (!Number.isFinite(poolMax) || poolMax <= 0) return DEFAULT_MAX_HOLDERS;
  return Math.max(1, Math.min(DEFAULT_MAX_HOLDERS, Math.floor(poolMax / 4)));
}

let active = 0;
const waiters = [];

async function acquireSlot() {
  if (active < maxHolders()) { active += 1; return; }
  // The slot is handed over directly on release (active stays counted).
  await new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot() {
  const next = waiters.shift();
  if (next) next();
  else active -= 1;
}

// Driver code / error name only: a Knex message can carry bound SQL values.
function errorTag(err) {
  return String((err && (err.code || err.name)) || 'error');
}

/**
 * Run `send` under the visit's push lock.
 *
 * @param {string} visitId  scheduled_services.id — the key every tech push
 *   for the stop shares (the tag is `visit-<id>` / `visit-prep-<id>`).
 * @param {object} args
 * @param {(trx) => Promise<boolean>} [args.isCurrent]  runs under the lock on
 *   the lock's own connection; resolve false for a clean "stale" verdict.
 * @param {() => Promise<*>} args.send  the provider handoff.
 * @returns {Promise<{ sent: boolean, stale?: boolean, locked: boolean, result?: * }>}
 *   `send`'s own rejection propagates (after the lock is released).
 */
async function sendUnderVisitPushLock(visitId, { isCurrent = null, send } = {}) {
  await acquireSlot();
  let phase = 'lock';
  let outcome = null;
  let sendError = null;
  try {
    try {
      await db.transaction(async (trx) => {
        await trx.raw(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [`${LOCK_NAMESPACE}:${visitId}`]);
        phase = 'check';
        let current = true;
        if (isCurrent) {
          try {
            current = (await isCurrent(trx)) !== false;
          } catch (err) {
            logger.warn(`[tech-visit-push-lock] recheck failed for visit ${visitId} (${errorTag(err)}); sending`);
          }
        }
        if (!current) {
          outcome = { sent: false, stale: true, locked: true };
          return;
        }
        phase = 'send';
        try {
          outcome = { sent: true, locked: true, result: await send() };
        } catch (err) {
          sendError = err;
        }
      });
    } catch (err) {
      // Lock/transaction failure before the send began: fail open. A failure
      // AFTER the send (commit) changes nothing — never send twice.
      if (phase !== 'send' && !outcome) {
        logger.warn(`[tech-visit-push-lock] lock failed for visit ${visitId} (${errorTag(err)}); sending unordered`);
        try {
          outcome = { sent: true, locked: false, result: await send() };
        } catch (sendErr) {
          sendError = sendErr;
        }
      } else {
        logger.warn(`[tech-visit-push-lock] lock release failed for visit ${visitId} (${errorTag(err)})`);
      }
    }
  } finally {
    releaseSlot();
  }
  if (sendError) throw sendError;
  return outcome || { sent: false, locked: false };
}

module.exports = { sendUnderVisitPushLock, LOCK_NAMESPACE, LOCK_TIMEOUT_MS, _test: { maxHolders } };
