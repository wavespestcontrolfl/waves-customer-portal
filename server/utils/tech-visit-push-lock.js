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
 * HOLD TIME. The lock is held across the provider round trip, and the hold
 * is bounded end to end so a waiter never gives up on a holder that is
 * still legitimately sending (a waiter that timed out and sent unordered
 * would recreate the very misorder this lock prevents):
 *   - every query under the lock runs with `SET LOCAL statement_timeout`
 *     (STATEMENT_TIMEOUT_MS), set only AFTER the lock is granted so it never
 *     cuts the wait itself short;
 *   - the sender starts no new device leg after `deadlineAt`
 *     (SEND_BUDGET_MS after the lock is granted), and each leg is bounded by
 *     its transport (web-push and APNs 8 s; FCM up to 8 s OAuth + 8 s send,
 *     MAX_LEG_MS);
 * so a holder releases within MAX_HOLD_MS, and the waiter's
 * `SET LOCAL lock_timeout` (LOCK_TIMEOUT_MS) is set above that. A lock
 * timeout therefore means an abnormal holder (a stalled database session),
 * not a slow fan-out. A device past the budget is skipped, not sent late.
 *
 * POOL. Everything the push does while holding the lock — the recheck, the
 * subscription lookup, an expired-device cleanup — runs on the lock's OWN
 * transaction (`send(trx, …)`), so a holder uses exactly one connection. That
 * matters inside runExclusive (no-show detector), whose cron lock already
 * pins one: at DB_POOL_MAX=2 a second checkout would wait out the acquire
 * timeout. An in-process cap on concurrent holders (a fraction of the pool,
 * at least one) keeps a bulk reschedule from pinning the whole pool; extra
 * pushes wait in memory, holding no connection.
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
// Bounds on one holder (see HOLD TIME above). The recheck is a few statements
// and the lookup one; each is capped by STATEMENT_TIMEOUT_MS.
const STATEMENT_TIMEOUT_MS = 5000;
const SEND_BUDGET_MS = 20000;
const MAX_LEG_MS = 16000;
const MAX_HOLD_MS = 4 * STATEMENT_TIMEOUT_MS + SEND_BUDGET_MS + MAX_LEG_MS;
const LOCK_TIMEOUT_MS = MAX_HOLD_MS + 10000;
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
 * @param {(conn) => Promise<boolean>} [args.isCurrent]  the recheck; resolve
 *   false for a clean "stale" verdict. It runs as the sender's
 *   beforeDispatch — AFTER the subscription lookup, immediately before the
 *   first provider handoff — so no status write can slip in between the
 *   check and the handoff while the lookup runs (codex #5421 r2). It gets a
 *   savepoint on the lock's connection.
 * @param {(trx, { deadlineAt: number, beforeDispatch: Function }) => Promise<*>} args.send
 *   the provider handoff. Pass `beforeDispatch` through to the sender, run
 *   every query on `trx` (one connection per holder) and start no device leg
 *   after `deadlineAt` (epoch ms). On the fail-open path `trx` is null (use
 *   the pool), there is no lock to bound (no deadline), and beforeDispatch
 *   always answers true.
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
        // After the grant: bounds the holder, never the wait.
        await trx.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
        const deadlineAt = Date.now() + SEND_BUDGET_MS;
        let stale = false;
        const beforeDispatch = async () => {
          if (!isCurrent) return true;
          try {
            // In a savepoint: a failed recheck query would otherwise abort
            // the lock's transaction and take the fail-open send down with it.
            stale = (await trx.transaction((sp) => isCurrent(sp))) === false;
          } catch (err) {
            logger.warn(`[tech-visit-push-lock] recheck failed for visit ${visitId} (${errorTag(err)}); sending`);
          }
          return !stale;
        };
        phase = 'send';
        try {
          const result = await send(trx, { deadlineAt, beforeDispatch });
          outcome = stale ? { sent: false, stale: true, locked: true } : { sent: true, locked: true, result };
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
          outcome = { sent: true, locked: false, result: await send(null, { deadlineAt: null, beforeDispatch: async () => true }) };
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

module.exports = {
  sendUnderVisitPushLock, LOCK_NAMESPACE, LOCK_TIMEOUT_MS, STATEMENT_TIMEOUT_MS, SEND_BUDGET_MS, MAX_HOLD_MS,
  _test: { maxHolders },
};
