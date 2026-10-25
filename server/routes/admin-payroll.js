/**
 * Admin basic payroll settings (layer 1b-2a), dark behind GATE_PAYROLL.
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
 * Admin only. Off answers 404 { enabled: false } on every route but /status,
 * before any query. The portal never stores an SSN or a bank account number:
 * this router returns and logs neither. Responses are no-store.
 */
const express = require('express');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { payrollLive } = require('../config/feature-gates');
const payrollW4 = require('../services/payroll-w4');

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
  return res.status(500).json({ error: 'Payroll settings failed. Try again.' });
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

module.exports = router;
