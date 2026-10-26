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
 * Tax form figures (layer 3a, GATE_PAYROLL_FORM_FIGURES, also dark).
 * GET  /forms?year=YYYY&quarter=N    { year, quarter, f941, rt6, f940, w2, w3 }: the line-by-line
 *                                    figures for Form 941 and RT-6 (the quarter), Form 940 and
 *                                    W-2/W-3 (the year) from finalized, not-voided checks.
 *                                    400 on a bad year or quarter. Off answers 404.
 *
 * Paid time off and holidays (GATE_PAYROLL_TIME_OFF, also dark; off answers 404 { enabled: false }).
 * GET    /time-off?from=&to=         entries in the range (at most 400 days), with technician name.
 * POST   /time-off                   { technicianId, workDate, kind: 'pto' | 'holiday', hours, note }
 *                                    201 { entry, warning } (409 on a second entry for the date).
 * PUT    /time-off/:id               { kind, hours, note } -> { entry, warning }
 * DELETE /time-off/:id               remove an entry.
 *                                    Create, change and delete answer 409 once the pay run for the
 *                                    week that holds the date is final (whichever technician it
 *                                    paid): void the pay run first.
 * GET    /time-off/balance?technicianId=&year=   allowance, hours booked, hours paid, holidays.
 * PUT    /technicians/:id/pto-allowance          { hoursPerYear | null } the yearly allowance.
 *                                    The allowance only warns; it never blocks an entry.
 *
 * Admin only. Off answers 404 { enabled: false } on every route but /status,
 * before any query. The portal never stores an SSN or a bank account number:
 * this router returns and logs neither. Responses are no-store.
 */
const express = require('express');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { payrollLive, payrollFormFiguresLive, payrollTimeOffLive } = require('../config/feature-gates');
const payrollW4 = require('../services/payroll-w4');
const payrollRuns = require('../services/payroll-runs');
const payrollFormFigures = require('../services/payroll-form-figures');
const payrollTimeOff = require('../services/payroll-time-off');

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

router.get('/forms', async (req, res) => {
  if (!payrollFormFiguresLive()) {
    res.status(404).json({ enabled: false });
    return;
  }
  try {
    res.json(await payrollFormFigures.readFormFigures(payrollFormFigures.parseFormPeriod(req.query)));
  } catch (err) { fail(res, 'read tax form figures', err); }
});

// GATE_PAYROLL_TIME_OFF off: the same answer the payroll routes give when their gate is off.
const timeOffOnly = (req, res, next) => {
  if (!(typeof payrollTimeOffLive === 'function' && payrollTimeOffLive())) return res.status(404).json({ enabled: false });
  return next();
};

router.get('/time-off/balance', timeOffOnly, async (req, res) => {
  try {
    res.json({ balance: await payrollTimeOff.balance(req.query) });
  } catch (err) { fail(res, 'read time off balance', err); }
});

router.get('/time-off', timeOffOnly, async (req, res) => {
  try {
    res.json({ entries: await payrollTimeOff.listTimeOff(req.query) });
  } catch (err) { fail(res, 'list time off', err); }
});

router.post('/time-off', timeOffOnly, async (req, res) => {
  try {
    res.status(201).json(await payrollTimeOff.createTimeOff(req.body, req.technicianId));
  } catch (err) { fail(res, 'record time off', err); }
});

router.put('/time-off/:id', timeOffOnly, async (req, res) => {
  try {
    res.json(await payrollTimeOff.updateTimeOff(req.params.id, req.body, req.technicianId));
  } catch (err) { fail(res, 'change time off', err); }
});

router.delete('/time-off/:id', timeOffOnly, async (req, res) => {
  try {
    res.json(await payrollTimeOff.deleteTimeOff(req.params.id, req.technicianId));
  } catch (err) { fail(res, 'remove time off', err); }
});

router.put('/technicians/:id/pto-allowance', timeOffOnly, async (req, res) => {
  try {
    res.json({ technician: await payrollTimeOff.setPtoAllowance(req.params.id, req.body, req.technicianId) });
  } catch (err) { fail(res, 'set time off allowance', err); }
});

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
