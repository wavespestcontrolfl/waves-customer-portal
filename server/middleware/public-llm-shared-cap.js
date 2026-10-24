/**
 * Shared (all processes, all IPs) daily cap for the public paid-LLM routes.
 *
 * Security audit run 2 (2026-10-22, #13): askWavesDailyLimiter and
 * photoAssessmentDailyLimiter in index.js are express-rate-limit with the
 * default in-memory store. Their counts are per process and reset on every
 * deploy or restart, and nothing bounds the total: many IPs (or IPv6 /64
 * rotation) can each spend the full per-IP budget of paid LLM / vision calls.
 *
 * With GATE_PUBLIC_LLM_SHARED_CAP on, this middleware counts each request the
 * per-IP limiter counts (same `skip` predicate, passed in by index.js) in
 * public_llm_daily_usage, one row per (bucket, Eastern day), with one atomic
 * upsert, and answers 429 with the per-IP limiter's message once the day's
 * count passes the cap. Mount it AFTER the per-IP limiter so a request that
 * limiter already refused does not burn the shared budget.
 *
 * Gate off: next() at once, no DB call, no skip evaluation. A DB error fails
 * open (logged at most once a minute); the per-IP limiter still applies.
 * Sends nothing to a customer.
 */
const db = require('../models/db');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');

const WARN_EVERY_MS = 60 * 1000;
let lastWarnAt = 0;

function warnOncePerMinute(err, bucket) {
  const now = Date.now();
  if (now - lastWarnAt < WARN_EVERY_MS) return;
  lastWarnAt = now;
  logger.warn(`[public-llm-shared-cap] ${bucket}: counter unavailable, failing open (per-IP limiter still applies): ${err && err.message}`);
}

// Positive integer from the env var, else the default.
function resolveMax(envVar, defaultMax) {
  const raw = envVar ? process.env[envVar] : undefined;
  if (raw !== undefined && /^\s*\d+\s*$/.test(String(raw))) {
    const n = parseInt(raw, 10);
    if (Number.isSafeInteger(n) && n > 0) return n;
  }
  return defaultMax;
}

function sharedDailyCap({ bucket, envVar, defaultMax, message, skip }) {
  return async function sharedDailyCapMiddleware(req, res, next) {
    try {
      if (!require('../config/feature-gates').publicLlmSharedCapLive()) return next();
      if (typeof skip === 'function' && skip(req)) return next();
    } catch (err) {
      warnOncePerMinute(err, bucket);
      return next();
    }

    let count;
    try {
      const result = await db.raw(
        `INSERT INTO public_llm_daily_usage (bucket, day, count)
         VALUES (?, ?::date, 1)
         ON CONFLICT (bucket, day)
         DO UPDATE SET count = public_llm_daily_usage.count + 1, updated_at = now()
         RETURNING count`,
        [bucket, etDateString(new Date())],
      );
      count = Number(result && result.rows && result.rows[0] && result.rows[0].count);
      if (!Number.isFinite(count)) throw new Error('counter returned no row');
    } catch (err) {
      warnOncePerMinute(err, bucket);
      return next();
    }

    if (count > resolveMax(envVar, defaultMax)) {
      return res.status(429).json(message);
    }
    return next();
  };
}

module.exports = { sharedDailyCap, resolveMax };
