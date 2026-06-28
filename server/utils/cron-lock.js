const db = require('../models/db');
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
 * wrapped job. Wrapped jobs are minutes-long at worst and mostly seconds,
 * and their schedules are spread, so concurrent holders stay low.
 *
 * NOT for jobs that already claim work atomically (FOR UPDATE SKIP LOCKED
 * queues, conditional-UPDATE claims) — those are fleet-safe without it.
 */
async function runExclusive(jobName, fn) {
  const lockKey = `cron:${jobName}`;
  let conn;
  try {
    conn = await db.client.acquireConnection();
  } catch (err) {
    logger.error(`[cron-lock] ${jobName}: could not acquire DB connection (${err.message}) — skipping tick`);
    return { skipped: true, reason: 'no_connection' };
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
    return await fn();
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
    try {
      db.client.releaseConnection(conn);
    } catch (err) {
      logger.error(`[cron-lock] ${jobName}: connection release failed: ${err.message}`);
    }
  }
}

/**
 * Non-mutating check of whether a job's advisory lock is currently held (i.e. a
 * runExclusive('<jobName>') body is executing — possibly on another instance).
 * Acquires the lock momentarily and releases it: if we got it, nothing holds it.
 */
async function isLocked(jobName) {
  const lockKey = `cron:${jobName}`;
  let conn;
  try {
    conn = await db.client.acquireConnection();
  } catch (err) {
    logger.error(`[cron-lock] isLocked(${jobName}): could not acquire DB connection (${err.message})`);
    return false;
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
    return false;
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

module.exports = { runExclusive, isLocked };
