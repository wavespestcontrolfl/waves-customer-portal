// GATE_NEW_CALLER_BOOKING (owner 2026-10-25): New Appointment books a NEW
// caller's visit by address, before any customer record exists
// (services/booking/new-caller-visit.js). Admin only, like New Appointment's
// Save (POST /api/admin/schedule). Mounted before the main schedule router so
// /new-caller is never read as a visit id.
//
//   GET  /api/admin/schedule/new-caller/calls  live calls the office answered
//   POST /api/admin/schedule/new-caller        book the visit (no customer)

const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { isEnabled } = require('../config/feature-gates');
const { listPickableCalls, bookNewCallerVisit } = require('../services/booking/new-caller-visit');

router.use(adminAuthenticate, requireAdmin);
// Dark: with the gate unset the routes answer as if they did not exist.
router.use((req, res, next) => (isEnabled('newCallerBooking') ? next() : res.status(404).json({ error: 'Not found' })));

function sendOperational(res, err) {
  return res.status(err.status || err.statusCode).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
}

router.get('/calls', async (req, res, next) => {
  try {
    res.json({ calls: await listPickableCalls() });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    // The zone the office create route stamps for the same address.
    const { getZone } = require('./admin-schedule');
    const address = req.body?.address && typeof req.body.address === 'object' ? req.body.address : {};
    const zone = getZone(typeof address.city === 'string' ? address.city : '', typeof address.zip === 'string' ? address.zip : '');
    const { visit, warnings } = await bookNewCallerVisit({
      input: req.body,
      zone,
      adminUserId: req.technicianId || null,
    });
    res.status(201).json({ ok: true, id: visit.id, scheduledDate: String(req.body.scheduledDate), warnings });
  } catch (err) {
    if (err?.isOperational && (err.status || err.statusCode)) return sendOperational(res, err);
    next(err);
  }
});

module.exports = router;
