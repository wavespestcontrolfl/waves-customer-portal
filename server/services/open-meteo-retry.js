'use strict';

// A second try for Open-Meteo calls inside the Monday watering sweep (owner 2026-11-03, "yes fix").
// 2026-11-02 7:00 ET: from 12:00:30Z every past-week (city grid) request ran past the 3.5 s limit
// until the sweep ended, so 32 of 45 homes had no Open-Meteo week: 25 emails fell back to the 1"
// seasonal target instead of the ET0 target (~0.75"), and forecast misses dropped the forecast
// line. Nothing retried.
//
// Only a caller that passes a budget from createOpenMeteoRetry() gets the second try. The service
// report, the public watering page and the tech tools keep their single 3.5 s request.
// The second try pauses RETRY_DELAY_MS, then allows RETRY_TIMEOUT_MS. The budget is the time one
// run may spend on second tries (pause + request): none starts once SWEEP_RETRY_BUDGET_MS is spent,
// so a full outage adds at most about 3 min to the run, and a slow-but-up provider is waited out.
// Never log a request URL here: the paid key rides in it (open-meteo-endpoint.js).
const logger = require('./logger');

const RETRY_DELAY_MS = 1000;
const RETRY_TIMEOUT_MS = 10000;
const SWEEP_RETRY_BUDGET_MS = 3 * 60 * 1000;

// A thrown request (timeout, network error, cut-off body), 429 or 5xx can pass on a second try;
// another 4xx or an unusable payload cannot.
function retryableStatus(status) {
  return status === 429 || (Number.isInteger(status) && status >= 500);
}

function wait(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function createOpenMeteoRetry({
  budgetMs = SWEEP_RETRY_BUDGET_MS, delayMs = RETRY_DELAY_MS, timeoutMs = RETRY_TIMEOUT_MS, sleep = wait, now = Date.now,
} = {}) {
  const stats = { used: 0, recovered: 0, spentMs: 0, budgetMs };
  return {
    stats,
    // One second try while the run's budget lasts: the attempt's result, or null when spent.
    async secondTry(attempt) {
      if (stats.spentMs >= budgetMs) return null;
      const startedAt = now();
      stats.used += 1;
      await sleep(delayMs);
      const result = await attempt(timeoutMs);
      stats.spentMs += now() - startedAt;
      if (result.ok) stats.recovered += 1;
      return result;
    },
  };
}

// attempt(timeoutMs) resolves { value, ok, retryable }. The first try keeps the caller's own limit;
// a retryable miss gets one more try at the budget's longer limit while the budget lasts.
async function withOpenMeteoRetry(attempt, { firstTimeoutMs, retry, label }) {
  const first = await attempt(firstTimeoutMs);
  if (first.ok || !first.retryable || !retry) return first.value;
  const second = await retry.secondTry(attempt);
  if (!second) return first.value;
  const { spentMs, budgetMs } = retry.stats;
  logger.info(`[open-meteo-retry] ${label}: second try ${second.ok ? 'ok' : 'failed'} (${Math.round(spentMs / 1000)} of ${budgetMs / 1000} s used this run)`);
  return second.value;
}

module.exports = {
  createOpenMeteoRetry,
  withOpenMeteoRetry,
  retryableStatus,
  RETRY_DELAY_MS,
  RETRY_TIMEOUT_MS,
  SWEEP_RETRY_BUDGET_MS,
};
