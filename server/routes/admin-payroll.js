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
 * Pay lines (GATE_PAYROLL_PAY_LINES, also dark; off answers 404 { enabled: false }).
 * GET    /pay-lines?technicianId=&status=   lines, newest week first (status open, paid or voided).
 * GET    /pay-lines/technicians             every W-2 employee a line can be for, one who has left too.
 * POST   /pay-lines                         { kind: 'review_bonus' | 'commission' | 'health_allowance' |
 *                                    'hsa_employer', technicianId, amountCents, earnedWeekStart (a Monday),
 *                                    coversFrom?, coversTo?, note? } 201 { payLine }. The next pay run
 *                                    that reaches the week pays it. A span (coversFrom, coversTo) is for
 *                                    a commission or monthly allowance that covers several weeks.
 * DELETE /pay-lines/:id                     remove a line that is not paid yet (409 once a final run paid it).
 * PUT    /technicians/:id/flsa-coverage     { covered: true | false | null } whether federal overtime law
 *                                    covers the employee; W-2 box 12 code TT is filled only for true.
 *
 * Family employee (GATE_PAYROLL_FAMILY_EMPLOYEE, also dark; off answers 404 { enabled: false }).
 * PUT    /technicians/:id/family-employment { relationship: 'parent' | 'spouse', entity:
 *                                    'sole_proprietorship' | 'single_member_llc', exemptFrom (YYYY-MM-DD) },
 *                                    or { relationship: null } to clear all three. W-2 employees only (409
 *                                    otherwise). A pay run dated on or after exemptFrom skips federal and
 *                                    Florida unemployment tax for that employee and nothing else.
 *
 * Mercury paychecks (owner plan A, 2026-10-30; GATE_PAYROLL_MERCURY_STATUS and GATE_PAYROLL_MERCURY_PAY, both
 * dark; off answers 404 { enabled: false }). Mercury sends a paycheck only after the owner approves the request in
 * the Mercury app. No route here calls Mercury's direct send.
 * PUT  /technicians/:id/mercury-recipient  { recipientId | null } (status gate) the technician's Mercury recipient
 *                                    id. With a key set it reads the recipient and returns the NAME only (404 from
 *                                    Mercury answers 400).
 * GET  /runs/:id/send-preview        (status gate) the three warnings before a send: funding, key health, approve-by.
 * POST /runs/:id/send                (pay gate) request payment for each bank-transfer check with no payment yet.
 *                                    Answers { results: [{ checkId, name, outcome, reason?, message? }], run }.
 * POST /checks/:id/send-again        (pay gate) { confirmNothingWaiting? } a new attempt after failed, rejected,
 *                                    cancelled or returned, or after unknown when the owner confirms.
 * POST /payments/:id/link-request   (status gate, moves no money) { requestId } names the Mercury request that belongs
 *                                    to a payment whose outcome is unknown; refused unless it matches the attempt.
 * POST /checks/:id/paper             (status gate) { checkNumber } paid by paper check instead.
 *
 * Admin only. Off answers 404 { enabled: false } on every route but /status,
 * before any query. The portal never stores an SSN or a bank account number:
 * this router returns and logs neither. Responses are no-store.
 */
const express = require('express');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const {
  payrollLive, payrollFormFiguresLive, payrollTimeOffLive, payrollPayLinesLive, payrollFamilyEmployeeLive,
  payrollMercuryStatusLive, payrollMercuryPayLive,
} = require('../config/feature-gates');
const payrollW4 = require('../services/payroll-w4');
const payrollRuns = require('../services/payroll-runs');
const payrollFormFigures = require('../services/payroll-form-figures');
const payrollTimeOff = require('../services/payroll-time-off');
const payrollPayLines = require('../services/payroll-pay-lines');
const payrollFamilyEmployee = require('../services/payroll-family-employee');
const payrollMercury = require('../services/payroll-mercury');

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

// GATE_PAYROLL_PAY_LINES off: the same answer the payroll routes give when their gate is off.
const payLinesOnly = (req, res, next) => {
  if (!(typeof payrollPayLinesLive === 'function' && payrollPayLinesLive())) return res.status(404).json({ enabled: false });
  return next();
};

router.get('/pay-lines', payLinesOnly, async (req, res) => {
  try {
    res.json({ payLines: await payrollPayLines.listPayLines(req.query) });
  } catch (err) { fail(res, 'list pay lines', err); }
});

router.get('/pay-lines/technicians', payLinesOnly, async (req, res) => {
  try {
    res.json({ technicians: await payrollPayLines.listPayLineTechnicians() });
  } catch (err) { fail(res, 'list pay line employees', err); }
});

router.post('/pay-lines', payLinesOnly, async (req, res) => {
  try {
    res.status(201).json({ payLine: await payrollPayLines.createPayLine(req.body, req.technicianId) });
  } catch (err) { fail(res, 'add pay line', err); }
});

router.delete('/pay-lines/:id', payLinesOnly, async (req, res) => {
  try {
    res.json(await payrollPayLines.deletePayLine(req.params.id, req.technicianId));
  } catch (err) { fail(res, 'remove pay line', err); }
});

router.put('/technicians/:id/flsa-coverage', payLinesOnly, async (req, res) => {
  try {
    res.json({ technician: await payrollPayLines.setFlsaCoverage(req.params.id, req.body, req.technicianId) });
  } catch (err) { fail(res, 'set overtime coverage', err); }
});

// GATE_PAYROLL_FAMILY_EMPLOYEE off: the same answer the payroll routes give when their gate is off.
const familyEmployeeOnly = (req, res, next) => {
  if (!(typeof payrollFamilyEmployeeLive === 'function' && payrollFamilyEmployeeLive())) return res.status(404).json({ enabled: false });
  return next();
};

router.put('/technicians/:id/family-employment', familyEmployeeOnly, async (req, res) => {
  try {
    res.json({ technician: await payrollFamilyEmployee.setFamilyEmployment(req.params.id, req.body, req.technicianId) });
  } catch (err) { fail(res, 'set family employee', err); }
});

// GATE_PAYROLL_MERCURY_STATUS / _PAY off: the same answer the payroll routes give when their gate is off.
const mercuryStatusOnly = (req, res, next) => {
  if (!(typeof payrollMercuryStatusLive === 'function' && payrollMercuryStatusLive())) return res.status(404).json({ enabled: false });
  return next();
};
const mercuryPayOnly = (req, res, next) => {
  if (!(typeof payrollMercuryPayLive === 'function' && payrollMercuryPayLive())) return res.status(404).json({ enabled: false });
  return next();
};

router.put('/technicians/:id/mercury-recipient', mercuryStatusOnly, async (req, res) => {
  try {
    res.json({ technician: await payrollMercury.setMercuryRecipient(req.params.id, req.body, req.technicianId) });
  } catch (err) { fail(res, 'set Mercury recipient', err); }
});

router.get('/runs/:id/send-preview', mercuryStatusOnly, async (req, res) => {
  try {
    res.json({ preview: await payrollMercury.sendPreview(req.params.id) });
  } catch (err) { fail(res, 'read Mercury send preview', err); }
});

router.post('/runs/:id/send', mercuryPayOnly, async (req, res) => {
  try {
    const results = await payrollMercury.sendRun(req.params.id, req.technicianId);
    // The requests are made and saved. A failed re-read must not hide what happened.
    const run = await payrollRuns.getRun(req.params.id).catch(() => null);
    res.json({ results, run });
  } catch (err) { fail(res, 'send pay run to Mercury', err); }
});

router.post('/checks/:id/send-again', mercuryPayOnly, async (req, res) => {
  try {
    res.json({ result: await payrollMercury.sendAgain(req.params.id, req.body, req.technicianId) });
  } catch (err) { fail(res, 'send paycheck to Mercury again', err); }
});

router.post('/payments/:id/link-request', mercuryStatusOnly, async (req, res) => {
  try {
    res.json({ result: await payrollMercury.linkRequest(req.params.id, req.body, req.technicianId) });
  } catch (err) { fail(res, 'link Mercury request', err); }
});

router.post('/checks/:id/paper', mercuryStatusOnly, async (req, res) => {
  try {
    res.json({ result: await payrollMercury.recordPaper(req.params.id, req.body, req.technicianId) });
  } catch (err) { fail(res, 'record paper check', err); }
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
