/**
 * Admin basic payroll (layers 1b-2a and 1b-2b), dark behind GATE_PAYROLL.
 *
 * GET  /status                       { enabled }. Works while dark and reads nothing else.
 * GET  /technicians                  W-2 technicians (active or prospective) with pay
 *                                    rate, pay method and the W-4 in force today.
 * GET  /technicians/:id/w4           that technician's W-4 history, newest first.
 * POST /technicians/:id/w4           enter an election typed from the signed paper W-4
 *                                    (201 with the new row). A correction is a new row.
 * PUT  /technicians/:id/pay-method   { payMethod: 'check' | 'bank_transfer', consentOn }
 *                                    bank_transfer needs the date the employee's written
 *                                    OK was received (Florida law).
 *
 * Pay runs (layer 1b-2b). The portal works out each paycheck from the approved
 * weekly hours. The owner pays the technician and makes every tax payment.
 * GET  /runs                         runs, newest week first, with totals.
 * POST /runs                         { weekStart, payDate? } draft a run (201). weekStart is
 *                                    the Monday of a finished staff week; payDate defaults to
 *                                    the Friday after. Response: the run with its checks,
 *                                    blocked and waiting lists, totals and a review token.
 * GET  /runs/:id                     one run in the same shape.
 * POST /runs/:id/recompute           replace a draft's checks from current data.
 * POST /runs/:id/finalize            { token } refuses (409) while anyone is blocked or
 *                                    waiting, or when the numbers moved since the token.
 * POST /runs/:id/void                { reason } a draft or finalized run.
 * GET  /runs/:id/export.csv          one row per check.
 * PUT  /checks/:id/check-number      { checkNumber } on a finalized paper check.
 * GET  /checks/:id/stub              the printable pay stub (employee view, no employer taxes).
 *
 * Admin only. Off answers 404 { enabled: false } on every route but /status,
 * before any query. The portal never stores an SSN or a bank account number:
 * this router returns and logs neither. Responses are no-store.
 */
const express = require('express');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { payrollLive } = require('../config/feature-gates');
const payrollW4 = require('../services/payroll-w4');
const payrollRuns = require('../services/payroll-runs');

const router = express.Router();
router.use(adminAuthenticate);
router.use(requireAdmin);
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/status', (req, res) => res.json({ enabled: payrollLive() }));

router.use((req, res, next) => {
  if (!payrollLive()) return res.status(404).json({ enabled: false });
  return next();
});

// Ids and error codes only: a database error can carry the bound values.
function fail(res, what, err) {
  if (err && err.name === 'PayrollError') return res.status(err.status).json({ error: err.message });
  logger.error(`[admin-payroll] ${what} failed (${(err && (err.code || err.name)) || 'error'})`);
  return res.status(500).json({ error: 'Payroll failed. Try again.' });
}

router.get('/technicians', async (req, res) => {
  try {
    res.json({ technicians: await payrollW4.listPayrollTechnicians() });
  } catch (err) { fail(res, 'list technicians', err); }
});

router.get('/technicians/:id/w4', async (req, res) => {
  try {
    res.json({ elections: await payrollW4.listW4(req.params.id) });
  } catch (err) { fail(res, 'list W-4', err); }
});

router.post('/technicians/:id/w4', async (req, res) => {
  try {
    const election = await payrollW4.recordW4(req.params.id, req.body, req.technicianId);
    res.status(201).json({ election });
  } catch (err) { fail(res, 'record W-4', err); }
});

router.put('/technicians/:id/pay-method', async (req, res) => {
  try {
    res.json({ technician: await payrollW4.setPayMethod(req.params.id, req.body, req.technicianId) });
  } catch (err) { fail(res, 'set pay method', err); }
});

router.get('/runs', async (req, res) => {
  try {
    res.json({ runs: await payrollRuns.listRuns() });
  } catch (err) { fail(res, 'list pay runs', err); }
});

router.post('/runs', async (req, res) => {
  try {
    res.status(201).json({ run: await payrollRuns.draftRun(req.body, req.technicianId) });
  } catch (err) { fail(res, 'draft pay run', err); }
});

router.get('/runs/:id', async (req, res) => {
  try {
    res.json({ run: await payrollRuns.getRun(req.params.id) });
  } catch (err) { fail(res, 'read pay run', err); }
});

router.post('/runs/:id/recompute', async (req, res) => {
  try {
    res.json({ run: await payrollRuns.recomputeRun(req.params.id, req.technicianId) });
  } catch (err) { fail(res, 'recompute pay run', err); }
});

router.post('/runs/:id/finalize', async (req, res) => {
  try {
    res.json({ run: await payrollRuns.finalizeRun(req.params.id, req.body, req.technicianId) });
  } catch (err) { fail(res, 'finalize pay run', err); }
});

router.post('/runs/:id/void', async (req, res) => {
  try {
    res.json({ run: await payrollRuns.voidRun(req.params.id, req.body, req.technicianId) });
  } catch (err) { fail(res, 'void pay run', err); }
});

router.get('/runs/:id/export.csv', async (req, res) => {
  try {
    const { filename, csv } = await payrollRuns.exportCsv(req.params.id);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) { fail(res, 'export pay run', err); }
});

router.put('/checks/:id/check-number', async (req, res) => {
  try {
    res.json({ check: await payrollRuns.setCheckNumber(req.params.id, req.body, req.technicianId) });
  } catch (err) { fail(res, 'set check number', err); }
});

router.get('/checks/:id/stub', async (req, res) => {
  try {
    res.json({ stub: await payrollRuns.getStub(req.params.id) });
  } catch (err) { fail(res, 'read pay stub', err); }
});

module.exports = router;
