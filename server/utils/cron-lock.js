const { AsyncLocalStorage } = require('async_hooks');
const db = require('../models/db');
const { isScheduledTick } = require('./scheduled-cron');
const { parseETDateTime, etDateString, addETDays } = require('./datetime-et');
const logger = require('../services/logger');

/**
 * Cross-instance (and same-instance overlap) exclusivity for cron jobs.
 *
 * Every scheduled job runs in-process on the web dyno, so during a Railway
 * deploy the old and new instances overlap and fire the same tick — and a
 * slow run can still be going when the next tick lands. For jobs whose body
 * is read-then-act against customers (send SMS/email, charge cards) that
 * means duplicate sends. runExclusive() takes a Postgres session advisory
 * lock named for the job before running the body:
 *
 *   - pg_try_advisory_lock is NON-blocking: if another holder exists
 *     (other instance, or this instance's previous tick still running),
 *     the tick is skipped and the holder finishes its sweep. All wrapped
 *     jobs are sweep-style (they query for everything currently due), so
 *     a skipped tick's work is picked up by the holder or the next tick.
 *   - The lock lives on a dedicated pooled connection held for the job's
 *     duration and is released in finally; if the process dies mid-job,
 *     Postgres frees the lock when the connection drops — no stale-lease
 *     cleanup needed (this is the cron_leases alternative the
 *     terminal-cleanup comment in scheduler.js anticipated).
 *
 * Cost: one pool connection (pool max 10/20) is checked out per running
 * wrapped job — and it must stay exactly one. The job-health writes run on
 * that same held connection: when they went through the shared pool as a
 * second checkout, a top-of-hour herd of wrapped jobs could pin every pool
 * connection and then all block on the job_health acquire — a self-deadlock
 * that starved the web routes into KnexTimeouts (Sentry NODE-EXPRESS-21/22,
 * card-expiry-warnings dead for weeks).
 *
 * NOT for jobs that already claim work atomically (FOR UPDATE SKIP LOCKED
 * queues, conditional-UPDATE claims) — those are fleet-safe without it.
 */
const MAX_RECORDED_ERROR_LENGTH = 500;

// Provider errors can echo request payloads — Twilio errors are known to
// embed phone numbers (see review-request.js's deliberate refusal to log
// err.message). Mask digit runs before the message is persisted anywhere.
function sanitizeJobError(message) {
  return String(message || 'unknown error')
    .replace(/\+?\d[\d\s().-]{5,}\d/g, '[redacted-number]')
    .slice(0, MAX_RECORDED_ERROR_LENGTH);
}

// Best-effort job-health recorder (job_health table, one row per job) —
// feeds the Intelligence Bar's get_scheduled_job_health. Every write is
// wrapped so ledger problems (missing table pre-migration, transient DB
// errors) can NEVER break or delay the job itself. Skipped ticks
// (lease_held / no_connection) are normal fleet behavior and are not
// recorded.
//
// `conn` (optional): a raw pg connection the caller already holds. When
// present the write runs on it instead of checking out a second pool
// connection — required inside runExclusive, where a pool acquire while the
// lock connection is pinned recreates the herd self-deadlock described in
// the header. Standalone callers (scheduler.js skip records) pass nothing
// and use the pool as before.
// pg surfaces a dead session with no SQLSTATE at all (socket-level errors),
// class 08 (connection exception), or the shutdown codes 57P01–57P03
// (admin/crash shutdown, cannot connect now). Everything else — 57014
// query cancelled/statement timeout, class 53 resource errors, 42 schema,
// 22/23 data — leaves the session and its advisory lock usable, so the
// recorder stays best-effort and the body runs. On the HELD lock
// connection the distinction is load-bearing: a dead session has already
// dropped its advisory lock, so the body must not run — another instance
// can take the lease and run the same sweep.
function isSessionFatal(err) {
  const code = String((err && err.code) || '');
  return !code || /^08/.test(code) || /^57P0[123]$/.test(code);
}

async function recordJobStart(jobName, conn) {
  try {
    const now = new Date();
    if (conn) {
      await conn.query({
        text: `INSERT INTO job_health (job_name, last_started_at, last_status, updated_at)
               VALUES ($1, $2, 'running', $2)
               ON CONFLICT (job_name) DO UPDATE SET
                 last_started_at = EXCLUDED.last_started_at,
                 last_status = EXCLUDED.last_status,
                 updated_at = EXCLUDED.updated_at`,
        values: [jobName, now],
      });
      return;
    }
    await db('job_health')
      .insert({ job_name: jobName, last_started_at: now, last_status: 'running', updated_at: now })
      .onConflict('job_name')
      .merge({ last_started_at: now, last_status: 'running', updated_at: now });
  } catch (err) {
    if (conn && isSessionFatal(err)) throw err; // the lock session is gone — caller aborts
    logger.warn(`[cron-lock] ${jobName}: job_health start record failed (${err.message})`);
  }
}

// A tick that never ran (no slot before its deadline, or a lease won too
// late) must show as a FAILED run — but only if no other replica has
// started or succeeded this job for the SAME scheduled occurrence: during
// a deploy overlap the other pod may have completed the very sweep this
// pod lost, and overwriting its success would tell the health surface a
// lie. Replicas fire the same occurrence within milliseconds of each other
// (never a full cron minute apart), so a start/success inside the window
// before this pod's arrival is the same tick, not an older one.
const TICK_WINDOW_SECONDS = 60;
async function recordMissedTick(jobName, tickStartedAtMs, message, conn) {
  const startedAt = new Date(tickStartedAtMs);
  const finishedAt = new Date();
  const values = [jobName, startedAt, finishedAt, Math.max(0, finishedAt - startedAt), sanitizeJobError(message)];
  const sql = `INSERT INTO job_health
                 (job_name, last_started_at, last_finished_at, last_duration_ms, last_status, last_error, consecutive_failures, updated_at)
               VALUES (?, ?, ?, ?, 'failed', ?, 1, CURRENT_TIMESTAMP)
               ON CONFLICT (job_name) DO UPDATE SET
                 last_started_at = EXCLUDED.last_started_at,
                 last_finished_at = EXCLUDED.last_finished_at,
                 last_duration_ms = EXCLUDED.last_duration_ms,
                 last_status = 'failed',
                 last_error = EXCLUDED.last_error,
                 consecutive_failures = job_health.consecutive_failures + 1,
                 updated_at = EXCLUDED.updated_at
               WHERE (job_health.last_started_at IS NULL
                      OR job_health.last_started_at < EXCLUDED.last_started_at - interval '${TICK_WINDOW_SECONDS} seconds')
                 AND (job_health.last_success_at IS NULL
                      OR job_health.last_success_at < EXCLUDED.last_started_at - interval '${TICK_WINDOW_SECONDS} seconds')`;
  try {
    if (conn) {
      let n = 0;
      await conn.query({ text: sql.replace(/\?/g, () => `$${++n}`), values });
    } else {
      await db.raw(sql, values);
    }
  } catch (err) {
    logger.warn(`[cron-lock] ${jobName}: job_health missed-tick record failed (${err.message})`);
  }
}

async function recordJobEnd(jobName, startedAtMs, error, conn) {
  try {
    const finishedAt = new Date();
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    if (conn) {
      if (error) {
        await conn.query({
          text: `UPDATE job_health SET
                   last_finished_at = $2, last_duration_ms = $3, updated_at = $2,
                   last_status = 'failed', last_error = $4,
                   consecutive_failures = consecutive_failures + 1
                 WHERE job_name = $1`,
          values: [jobName, finishedAt, durationMs, sanitizeJobError(error.message || error)],
        });
      } else {
        await conn.query({
          text: `UPDATE job_health SET
                   last_finished_at = $2, last_duration_ms = $3, updated_at = $2,
                   last_status = 'success', last_success_at = $2, last_error = NULL,
                   consecutive_failures = 0
                 WHERE job_name = $1`,
          values: [jobName, finishedAt, durationMs],
        });
      }
      return;
    }
    const patch = {
      last_finished_at: finishedAt,
      last_duration_ms: durationMs,
      updated_at: finishedAt,
    };
    if (error) {
      patch.last_status = 'failed';
      patch.last_error = sanitizeJobError(error.message || error);
      await db('job_health').where({ job_name: jobName })
        .update({ ...patch, consecutive_failures: db.raw('consecutive_failures + 1') });
    } else {
      patch.last_status = 'success';
      patch.last_success_at = finishedAt;
      patch.last_error = null;
      patch.consecutive_failures = 0;
      await db('job_health').where({ job_name: jobName }).update(patch);
    }
  } catch (err) {
    logger.warn(`[cron-lock] ${jobName}: job_health end record failed (${err.message})`);
  }
}

// options.recordHealth (default true): set false for DYNAMIC per-entity
// locks (review-send:${customerId}, per-run approval locks) — those are
// mutual-exclusion uses, not scheduled jobs, and recording them would grow
// job_health by one row per customer/run and leave one-off failures listed
// as "failing" forever. Bounded-enum names (per-conversion-type upload
// syncs) stay recorded — they ARE the scheduled jobs.
// Cap on concurrently HELD lock connections. A job's body still runs its
// queries through the shared pool while its lock connection is pinned, so
// without a ceiling a big-enough herd of distinct jobs could pin every
// pool connection and leave their own callbacks (and web routes) nothing
// to run on. Half the ACTIVE pool maximum (read at tick time — DB_POOL_MAX
// is tunable now, and dev/test pools are only 10) guarantees the other
// half stays free.
//
// Scheduled jobs over the cap WAIT for a slot (bounded — SLOT_WAIT_MAX_MS
// is an absolute per-tick deadline) rather than skip. A waiter holds NO
// connection (the semaphore sits before the pool acquire), so waiting is
// free for the pool; skipping is not free for the business: date-scoped
// once-a-day jobs (monthly billing charges customers whose billing_day is
// today) cannot recover a dropped tick tomorrow. Same-job overlap is coalesced in
// runExclusive before any slot is taken (see activeRuns); the advisory
// try-lock still covers overlap across instances.
function lockHolderCap() {
  const poolMax = Number(db.client?.pool?.max)
    || Number(db.client?.config?.pool?.max)
    || 20;
  return Math.max(1, Math.floor(poolMax / 2));
}
let activeLockHolders = 0;
const lockSlotWaiters = []; // FIFO of { resolve, timer }
// jobName → promise of the in-flight run's LEASE decision ({ held } or
// { held: false, reason }). Present from before the slot wait until the
// run settles, so it covers waiting AND running ticks of a job; it resolves
// as soon as the lease outcome is known, never waits for the body.
const activeRuns = new Map();
// A queued tick must not run arbitrarily late: date-sensitive callbacks
// recompute their target date at execution time (billing-monthly derives
// todayDay from new Date()), so a tick that crossed midnight ET would
// charge the wrong day's cohort and permanently miss the original one.
// Past this bound the tick FAILS as no_connection — visible in job_health
// and the watchers — rather than running in the wrong window.
const SLOT_WAIT_MAX_MS = 10 * 60 * 1000;
// Tracks "this async context already holds a slot" so a body that calls
// runExclusive again (route-tier reorder, backlink feeders do) bypasses the
// semaphore instead of deadlocking on its own slot at small caps.
const lockSlotContext = new AsyncLocalStorage();

function tryAcquireLockSlot() {
  if (activeLockHolders < lockHolderCap()) {
    activeLockHolders += 1;
    return true;
  }
  return false;
}

// Resolves true once a slot is held, false if none freed up before
// deadlineAt — an ABSOLUTE time fixed when the tick arrived, so a tick
// that coalesces and retries never restarts its clock.
async function acquireLockSlot(jobName, deadlineAt) {
  if (Date.now() >= deadlineAt) return false;
  if (tryAcquireLockSlot()) return true;
  logger.warn(`[cron-lock] ${jobName}: ${activeLockHolders} lock holders active (cap ${lockHolderCap()}) — waiting for a slot`);
  return new Promise((resolve) => {
    const entry = {
      resolve: (granted) => {
        clearTimeout(entry.timer);
        resolve(granted);
      },
    };
    entry.timer = setTimeout(() => {
      const i = lockSlotWaiters.indexOf(entry);
      if (i !== -1) lockSlotWaiters.splice(i, 1);
      resolve(false);
    }, deadlineAt - Date.now());
    entry.timer.unref?.();
    lockSlotWaiters.push(entry);
  });
}

function releaseLockSlot() {
  const next = lockSlotWaiters.shift();
  if (next) next.resolve(true); // slot handed to the waiter; counter unchanged
  else activeLockHolders -= 1;
}

// waitForSlot defaults to "running inside a scheduled tick" (see
// scheduled-cron.js) — independent of health recording, because scheduled
// sweeps that opt out of job_health (link-registry-catchup) are still
// scheduled work whose dropped tick nobody retries before the next
// interval. Only scheduled ticks wait — a dropped once-a-day tick is
// unrecoverable. Everything else fails fast: dynamic per-entity locks
// (review-send:${customerId}) and every HTTP path — including handlers
// that trigger a scheduled job by name (manual auto-dispatch, price-scan,
// engagement sync) and shared service entry points reached from admin
// routes. An HTTP request parked behind the cron herd would mutate after
// the client gave up. The context-based default means no
// request-vs-scheduled flag has to be threaded through shared code.
//
// Non-waiting callers still take a holder slot: bypassing the cap would
// let a burst of request locks pin the half of the pool reserved for job
// bodies and web routes. No slot → no_connection, the same skip every
// caller already maps to "retry in a moment".
async function runExclusive(jobName, fn, { recordHealth = true, waitForSlot = isScheduledTick() } = {}) {
  const lockKey = `cron:${jobName}`;
  // Reentrant path: already inside a held slot (nested runExclusive) —
  // no second slot AND no second connection. The nested advisory lock is
  // taken on the OUTER call's session (advisory locks are per-session, so
  // a different key on the same session is fine); pinning a second pooled
  // connection here would recreate the deadlock at DB_POOL_MAX=2.
  const nested = lockSlotContext.getStore();
  if (nested) {
    return runExclusiveLocked(jobName, lockKey, fn, recordHealth, nested.conn);
  }
  if (!waitForSlot) {
    if (!tryAcquireLockSlot()) {
      logger.warn(`[cron-lock] ${jobName}: ${activeLockHolders} lock holders active (cap ${lockHolderCap()}) — request-scoped lock fails fast`);
      return { skipped: true, reason: 'no_connection' };
    }
    try {
      return await runExclusiveLocked(jobName, lockKey, fn, recordHealth);
    } finally {
      releaseLockSlot();
    }
  }
  // Arrival time and deadline are fixed HERE and travel through every
  // coalesced retry: a retry is still this tick, so its health record and
  // its cutoff are measured from when it arrived, not from when it retried.
  const arrivedAtMs = Date.now();
  return runScheduled(jobName, lockKey, fn, recordHealth, tickDeadline(arrivedAtMs), arrivedAtMs);
}

// A tick may wait at most SLOT_WAIT_MAX_MS — and never into the next ET
// business day. Bodies compute their period from the wall clock when they
// run (the 23:50 month-end MRR snapshot, billing_day cohorts), so a tick
// that fired today must not execute tomorrow even if the window has not
// elapsed yet: the deadline is capped at the next ET midnight.
function tickDeadline(now = Date.now()) {
  const nextEtMidnight = parseETDateTime(`${etDateString(addETDays(new Date(now), 1))}T00:00`).getTime();
  return Math.min(now + SLOT_WAIT_MAX_MS, nextEtMidnight);
}

async function runScheduled(jobName, lockKey, fn, recordHealth, deadlineAt, tickStartedAtMs) {
  // Coalesce behind an in-flight (waiting or running) tick of this job
  // rather than queueing a replay — but only until that run's LEASE
  // outcome is known, never until it finishes: a hung body would otherwise
  // retain every later tick of a minutely job behind one never-settling
  // promise. Once the prior run holds the lease this tick is covered
  // (lease_held, immediately). If the prior run settled WITHOUT the lease
  // (no slot, acquire failure, try-lock throw, session lost, deadline) its
  // work was NOT done and this tick must do it — under ITS OWN original
  // deadline — or both deploy-overlap invocations of a once-daily job
  // would silently drop.
  const prior = activeRuns.get(jobName);
  if (prior) {
    const decision = await prior;
    if (!decision.held && decision.reason === 'no_connection') {
      return runScheduled(jobName, lockKey, fn, recordHealth, deadlineAt, tickStartedAtMs);
    }
    logger.info(`[cron-lock] ${jobName}: covered by a concurrent run — skipping tick`);
    return { skipped: true, reason: 'lease_held' };
  }
  let decideLease;
  const leaseDecided = new Promise((resolve) => { decideLease = resolve; });
  const lease = {
    held: false,
    deadlineAt,
    tickStartedAtMs,
    onHeld: () => { lease.held = true; decideLease({ held: true }); },
  };
  const runPromise = (async () => {
    const granted = await acquireLockSlot(jobName, deadlineAt);
    if (!granted) {
      logger.error(`[cron-lock] ${jobName}: no lock slot within ${SLOT_WAIT_MAX_MS}ms — tick failed`);
      // No connection is held here, so the recorder uses the pool
      // (best-effort, like every job_health write).
      if (recordHealth) await recordMissedTick(jobName, tickStartedAtMs, `no lock slot within ${SLOT_WAIT_MAX_MS}ms — tick failed`);
      return { skipped: true, reason: 'no_connection' };
    }
    try {
      return await runExclusiveLocked(jobName, lockKey, fn, recordHealth, null, lease);
    } finally {
      releaseLockSlot();
    }
  })();
  // Anything that settles without onHeld having fired decided "no lease":
  // carry the machinery reason (lease_held from another instance stays
  // lease_held; everything else is a retryable no_connection).
  runPromise.then(
    (r) => decideLease(lease.held ? { held: true } : { held: false, reason: (r && r.skipped === true && r.reason) || 'no_connection' }),
    () => decideLease(lease.held ? { held: true } : { held: false, reason: 'no_connection' }),
  );
  activeRuns.set(jobName, leaseDecided);
  try {
    return await runPromise;
  } finally {
    activeRuns.delete(jobName);
  }
}

async function runExclusiveLocked(jobName, lockKey, fn, recordHealth, heldConn, lease) {
  let conn = heldConn;
  if (!conn) {
    try {
      conn = await db.client.acquireConnection();
    } catch (err) {
      logger.error(`[cron-lock] ${jobName}: could not acquire DB connection (${err.message}) — skipping tick`);
      return { skipped: true, reason: 'no_connection' };
    }
  }

  let locked = false;
  try {
    const res = await conn.query({
      text: 'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      values: [lockKey],
    });
    locked = !!res?.rows?.[0]?.locked;
    if (!locked) {
      logger.info(`[cron-lock] ${jobName}: lease held elsewhere (overlapping instance or prior tick) — skipping`);
      return { skipped: true, reason: 'lease_held' };
    }
    // The slot wait honoured the deadline, but the pool acquire and the
    // try-lock query above can eat the remainder of the window. A lease
    // won after the deadline must not run either: the month-end MRR
    // snapshot (scheduler.js) invoked after midnight records the NEW month
    // and permanently misses the ending one. Same visible failure as a
    // slot timeout; the coalesced tick (if any) sees no_connection and
    // fails on its own passed deadline.
    if (lease && Date.now() >= lease.deadlineAt) {
      logger.error(`[cron-lock] ${jobName}: lease acquired after the tick's deadline — not running`);
      if (recordHealth) await recordMissedTick(jobName, lease.tickStartedAtMs, 'lease acquired after tick deadline — tick failed', conn);
      return { skipped: true, reason: 'no_connection' };
    }
    const startedAtMs = Date.now();
    if (recordHealth) {
      try {
        await recordJobStart(jobName, conn);
      } catch (err) {
        // The session (and with it the advisory lock) is gone. Running the
        // body now would race another instance that can take the lease.
        conn.__knex__disposed = `cron-lock session lost before body: ${err.message}`;
        logger.error(`[cron-lock] ${jobName}: lock session lost before the body ran (${err.message}) — skipping tick, connection flagged for destruction`);
        return { skipped: true, reason: 'no_connection' };
      }
    }
    // The start record just awaited a round-trip; re-check the deadline
    // immediately before the body so nothing between "lease usable" and
    // "body runs" can carry the tick across its cutoff. The row already
    // says 'running' under our own lease, so this is a plain failed end.
    if (lease && Date.now() >= lease.deadlineAt) {
      logger.error(`[cron-lock] ${jobName}: deadline passed before the body could start — not running`);
      if (recordHealth) await recordJobEnd(jobName, lease.tickStartedAtMs, new Error('deadline passed before body start — tick failed'), conn);
      return { skipped: true, reason: 'no_connection' };
    }
    // Lease confirmed usable: tell coalesced ticks of this job they are
    // covered (see runScheduled).
    if (lease) lease.onHeld();
    try {
      // The held connection rides the async context so nested runExclusive
      // calls (any depth) reuse this session instead of pinning another.
      const result = await lockSlotContext.run({ conn }, fn);
      if (recordHealth) await recordJobEnd(jobName, startedAtMs, null, conn);
      return result;
    } catch (err) {
      // Record the failure, then preserve the existing contract: the
      // error still propagates to the job's own handler.
      if (recordHealth) await recordJobEnd(jobName, startedAtMs, err, conn);
      throw err;
    }
  } finally {
    if (locked) {
      try {
        await conn.query({
          text: 'SELECT pg_advisory_unlock(hashtext($1))',
          values: [lockKey],
        });
      } catch (err) {
        // Session advisory locks survive pool release — if this session
        // went back into the pool still holding the lock, every future
        // tick would skip as lease_held until the process died. Flag the
        // connection so knex's acquire-time validation destroys it
        // instead of reusing it; the lock dies with the connection.
        conn.__knex__disposed = `cron-lock unlock failed: ${err.message}`;
        logger.error(`[cron-lock] ${jobName}: advisory unlock failed (${err.message}) — connection flagged for destruction so the lock is freed`);
      }
    }
    if (!heldConn) {
      // A borrowed session (nested call) is released by its owner.
      try {
        db.client.releaseConnection(conn);
      } catch (err) {
        logger.error(`[cron-lock] ${jobName}: connection release failed: ${err.message}`);
      }
    }
  }
}

/**
 * Non-mutating check of whether a job's advisory lock is currently held (i.e. a
 * runExclusive('<jobName>') body is executing — possibly on another instance).
 * Acquires the lock momentarily and releases it: if we got it, nothing holds it.
 * Returns true (held), false (free), or null when the probe itself could not
 * run (no connection / query failure) — falsy for "is it running?" callers,
 * but distinguishable by a caller that must not start work on an unknown
 * lease (a null is "could not check", never "free").
 */
async function isLocked(jobName) {
  const lockKey = `cron:${jobName}`;
  let conn;
  try {
    conn = await db.client.acquireConnection();
  } catch (err) {
    logger.error(`[cron-lock] isLocked(${jobName}): could not acquire DB connection (${err.message})`);
    return null;
  }
  let acquired = false;
  try {
    const res = await conn.query({
      text: 'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      values: [lockKey],
    });
    acquired = !!res?.rows?.[0]?.locked;
    return !acquired; // we acquired it → free (nothing running); couldn't → held
  } catch (err) {
    logger.warn(`[cron-lock] isLocked(${jobName}) check failed: ${err.message}`);
    return null;
  } finally {
    if (acquired) {
      try {
        await conn.query({ text: 'SELECT pg_advisory_unlock(hashtext($1))', values: [lockKey] });
      } catch (err) {
        // Same safety as runExclusive: if we can't release, destroy the connection
        // so the session lock can't linger in the pool and block real runs.
        conn.__knex__disposed = `cron-lock isLocked unlock failed: ${err.message}`;
        logger.error(`[cron-lock] isLocked(${jobName}) advisory unlock failed (${err.message}) — connection flagged for destruction`);
      }
    }
    try {
      db.client.releaseConnection(conn);
    } catch (err) {
      logger.error(`[cron-lock] isLocked(${jobName}) connection release failed: ${err.message}`);
    }
  }
}

// The complete set of skip results runExclusive itself can return — as
// opposed to a `skipped: true` shape the job BODY returned, which flows
// through untouched. Callers that must distinguish "the lock machinery
// never ran my body" from their own body-level skips use this predicate
// instead of enumerating reasons, so adding a reason here can never make
// a machinery skip look like a caller-level success again.
const LOCK_SKIP_REASONS = new Set(['lease_held', 'no_connection']);
function wasLockSkipped(result) {
  return !!(result && result.skipped === true && LOCK_SKIP_REASONS.has(result.reason));
}

// Sequential work inside a cron body can reuse its pinned connection for a
// short transaction. Holding a second connection while the body queries the
// pool would deadlock at DB_POOL_MAX=2. Await the transaction before returning
// from the body; never run overlapping transactions on this connection.
function getHeldConnection() {
  return lockSlotContext.getStore()?.conn;
}

module.exports = { runExclusive, isLocked, recordJobStart, recordJobEnd, wasLockSkipped, sanitizeJobError, getHeldConnection };
