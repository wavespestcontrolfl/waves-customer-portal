/**
 * Hermes agent watchdog — status contract.
 *
 * Machine-to-machine (HMAC-signed via link-worker-auth, key `hermes_watchdog`,
 * capability `watchdog`; NOT admin bearer). Mounted at
 * /api/integrations/watchdog-worker. The external watchdog polls GET /status;
 * the served snapshot is PII-free counts + job names
 * (services/agent-watchdog-snapshot.js), and the finalized audit row
 * (result='observed') is the heartbeat services/agent-watchdog-liveness.js reads.
 *
 * Dark behind GATE_HERMES_WATCHDOG (read at call time) AHEAD of the auth chain
 * (unobservable-when-dark, the publicMcpGate precedent; registered as a
 * passthrough in config/route-auth-guards.json): off → 404 before any audit
 * row exists, so a disabled lane never counts as liveness.
 * No POST — v1 observes and pages; actions arrive with agent-control S4.
 */
const express = require('express');
const router = express.Router();
const { linkWorkerAuth, finalizeWorkerRequest } = require('../middleware/link-worker-auth');
const { gateEnvValue } = require('../config/feature-gates');
const { buildWatchdogSnapshot } = require('../services/agent-watchdog-snapshot');

// 404 while the lane is dark — before auth, before any audit row. Rejects or
// calls next(); never serves.
function watchdogGate(req, res, next) {
  if (!gateEnvValue('GATE_HERMES_WATCHDOG')) return res.status(404).json({ error: 'watchdog lane disabled' });
  next();
}

router.use(watchdogGate);
router.use(linkWorkerAuth('watchdog'));

router.get('/status', async (req, res, next) => {
  try {
    const snapshot = await buildWatchdogSnapshot();
    // The finalized row IS the heartbeat the liveness cron reads: if it did not
    // persist, this poll must not look successful to Hermes.
    const recorded = await finalizeWorkerRequest(req, 'observed');
    res.set('Cache-Control', 'no-store');
    if (!recorded) return res.status(503).json({ error: 'heartbeat not recorded' });
    res.json(snapshot);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports._test = { watchdogGate };
