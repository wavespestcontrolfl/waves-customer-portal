/**
 * A technician's own pay stubs (payroll item 7), dark behind GATE_TECH_PAY_STUBS.
 *
 * GET /checks            { checks }: the caller's own checks from FINALIZED, not-voided pay runs,
 *                        newest pay date first (at most 60).
 * GET /checks/:id/stub   { stub }: the stub of one of the caller's own checks (the admin stub:
 *                        hours, earnings, taxes withheld, year to date, net pay; no employer taxes).
 *
 * Allowed by the technician allow-list v1 ruling (owner 2026-10-02): a technician login reaches its
 * own pay. Both routes scope by the AUTHENTICATED technician id (req.technicianId), never a
 * client-sent id. Another person's check, a draft or voided pay run, and a bad id all answer 404, so
 * ids cannot be probed. An admin sees only their own stubs here; pay runs, W-4s, other people's
 * checks, employer taxes and tax forms stay on /api/admin/payroll. Off answers 404 { enabled: false }
 * before any query. Responses are no-store.
 */
const express = require('express');
const logger = require('../services/logger');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { techPayStubsLive } = require('../config/feature-gates');
const payrollRuns = require('../services/payroll-runs');

const router = express.Router();

router.use((req, res, next) => {
  if (!(typeof techPayStubsLive === 'function' && techPayStubsLive())) return res.status(404).json({ enabled: false });
  return next();
});
router.use(adminAuthenticate, requireTechOrAdmin);
router.use((req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

function fail(res, what, err) {
  if (err && err.name === 'PayrollError') return res.status(err.status).json({ error: err.message });
  logger.error(`[tech-payroll] ${what} failed (${(err && (err.code || err.name)) || 'error'})`);
  return res.status(500).json({ error: 'Pay stubs failed. Try again.' });
}

router.get('/checks', async (req, res) => {
  try {
    res.json({ checks: await payrollRuns.listOwnChecks(req.technicianId) });
  } catch (err) { fail(res, 'list pay checks', err); }
});

router.get('/checks/:id/stub', async (req, res) => {
  try {
    res.json({ stub: await payrollRuns.getOwnStub(req.technicianId, req.params.id) });
  } catch (err) { fail(res, 'read pay stub', err); }
});

module.exports = router;
