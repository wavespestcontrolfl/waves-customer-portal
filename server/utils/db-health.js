// Fast readiness ping for /api/health. A hung or broken database must not
// report healthy — an uncaughtException is swallowed at startup by design, so
// the health endpoint was the only place a dead-DB instance still looked fine.
// Cancel-on-timeout so a slow DB can't stall Railway's probe.
const HEALTH_DB_TIMEOUT_MS = 2000;

async function isDatabaseReady(db, timeoutMs = HEALTH_DB_TIMEOUT_MS) {
  // Knex's .timeout() only starts AFTER a connection is acquired, so a saturated
  // pool could otherwise leave the probe waiting on the pool's much longer
  // acquire timeout. Race an outer deadline that bounds the WHOLE operation,
  // acquisition included, so the probe always answers within timeoutMs.
  let timer;
  try {
    const ping = db.raw('SELECT 1').timeout(timeoutMs, { cancel: true });
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('health check timed out')), timeoutMs);
    });
    await Promise.race([ping, deadline]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { isDatabaseReady, HEALTH_DB_TIMEOUT_MS };
