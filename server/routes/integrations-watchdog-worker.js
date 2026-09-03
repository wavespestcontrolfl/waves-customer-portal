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
 * Dark behind GATE_HERMES_WATCHDOG (read at call time): off → 404 and the audit
 * row stays 'authenticated', so a disabled lane never counts as liveness.
 * No POST — v1 observes and pages; actions arrive with agent-control S4.
 */
const express = require('express');
const router = express.Router();
const { linkWorkerAuth, finalizeWorkerRequest } = require('../middleware/link-worker-auth');
const { gateEnvValue } = require('../config/feature-gates');
const { buildWatchdogSnapshot } = require('../services/agent-watchdog-snapshot');

router.use(linkWorkerAuth('watchdog'));

router.get('/status', async (req, res, next) => {
  try {
    if (!gateEnvValue('GATE_HERMES_WATCHDOG')) {
      return res.status(404).json({ error: 'watchdog lane disabled' });
    }
    const snapshot = await buildWatchdogSnapshot();
    await finalizeWorkerRequest(req, 'observed');
    res.set('Cache-Control', 'no-store');
    res.json(snapshot);
  } catch (err) { next(err); }
});

module.exports = router;
