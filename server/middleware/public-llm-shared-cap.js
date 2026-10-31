/**
 * Shared (all processes, all IPs) daily cap for the public paid-LLM routes.
 *
 * Security audit run 2 (2026-10-22, #13): askWavesDailyLimiter and
 * photoAssessmentDailyLimiter in index.js are express-rate-limit with the
 * default in-memory store. Their counts are per process and reset on every
 * deploy or restart, and nothing bounds the total: many IPs (or IPv6 /64
 * rotation) can each spend the full per-IP budget of paid LLM / vision calls.
 *
 * With GATE_PUBLIC_LLM_SHARED_CAP on, `consumeSharedDailyCap` counts ONE unit in
 * public_llm_daily_usage (one row per bucket and Eastern day, one atomic upsert)
 * and reports whether the day's count is still within the cap. A route calls it
 * at the LAST point before its paid model call: after the route's own limiter,
 * honeypot, Turnstile and validation have all passed, so a request rejected
 * earlier never burns the shared budget. Call it once per request; retries and
 * fallback models inside the paid call do not call it again.
 *
 * Gate off: allowed at once, no DB call. A DB error fails open (logged at most
 * once a minute); the per-IP limiter still applies. Sends nothing to a customer.
 *
 * A `failClosed` budget (BUG_ID_EXTENSION_CAP: the Chrome extension's
 * anonymous, worldwide, Turnstile-less route) is the exception on both
 * counts: it is counted whatever GATE_PUBLIC_LLM_SHARED_CAP says, and a
 * counter error refuses instead of allowing, so its daily ceiling holds
 * without the shared-cap gate and through a database outage.
 */
const db = require('../models/db');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');

const WARN_EVERY_MS = 60 * 1000;
let lastWarnAt = 0;

function warnOncePerMinute(err, bucket, failClosed = false) {
  const now = Date.now();
  if (now - lastWarnAt < WARN_EVERY_MS) return;
  lastWarnAt = now;
  const outcome = failClosed ? 'failing closed (refusing until it is back)' : 'failing open (per-IP limiter still applies)';
  logger.warn(`[public-llm-shared-cap] ${bucket}: counter unavailable, ${outcome}: ${err && err.message}`);
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

// Same text the per-IP daily limiters in index.js answer with.
const DAILY_LIMIT_MESSAGE = { error: 'Daily limit reached — call (941) 297-5749 and a real person will help right away.' };

// { allowed } — false only when the gate is on (or the budget is failClosed)
// and the day's shared count is over the cap, or when a failClosed budget's
// counter is unavailable. Never throws.
async function consumeSharedDailyCap({ bucket, envVar, defaultMax, failClosed = false }) {
  if (!failClosed) {
    try {
      if (!require('../config/feature-gates').publicLlmSharedCapLive()) return { allowed: true };
    } catch (err) {
      warnOncePerMinute(err, bucket);
      return { allowed: true };
    }
  }

  try {
    const result = await db.raw(
      `INSERT INTO public_llm_daily_usage (bucket, day, count)
       VALUES (?, ?::date, 1)
       ON CONFLICT (bucket, day)
       DO UPDATE SET count = public_llm_daily_usage.count + 1, updated_at = now()
       RETURNING count`,
      [bucket, etDateString(new Date())],
    );
    const count = Number(result && result.rows && result.rows[0] && result.rows[0].count);
    if (!Number.isFinite(count)) throw new Error('counter returned no row');
    return { allowed: count <= resolveMax(envVar, defaultMax) };
  } catch (err) {
    warnOncePerMinute(err, bucket, failClosed);
    return { allowed: !failClosed };
  }
}

// The budgets, so the routes name them in one place.
const ASK_WAVES_CAP = { bucket: 'ask-waves', envVar: 'PUBLIC_LLM_DAILY_CAP_ASK_WAVES', defaultMax: 1500 };
const PHOTO_ASSESSMENT_CAP = { bucket: 'photo-assessment', envVar: 'PUBLIC_LLM_DAILY_CAP_PHOTO', defaultMax: 300 };
// Owner 2026-10-31: 100 extension identifications a day, worldwide, kept apart
// from the website funnels' photo budget.
const BUG_ID_EXTENSION_CAP = {
  bucket: 'bug-id-extension', envVar: 'PUBLIC_LLM_DAILY_CAP_BUG_ID_EXTENSION', defaultMax: 100, failClosed: true,
};

module.exports = {
  consumeSharedDailyCap, resolveMax, DAILY_LIMIT_MESSAGE, ASK_WAVES_CAP, PHOTO_ASSESSMENT_CAP, BUG_ID_EXTENSION_CAP,
};
