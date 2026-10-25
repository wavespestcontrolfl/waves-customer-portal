// GATE_NEW_CALLER_BOOKING (owner 2026-10-25): New Appointment books a NEW
// caller's visit by address, before any customer record exists
// (services/booking/new-caller-visit.js). Admin only, like New Appointment's
// Save (POST /api/admin/schedule). Mounted before the main schedule router so
// /new-caller is never read as a visit id.
//
//   GET  /api/admin/schedule/new-caller/calls          live calls the office answered
//   POST /api/admin/schedule/new-caller                book the visit (no customer)
//   PUT  /api/admin/schedule/new-caller/:visitId/link  link it to its customer, then
//        arm reminders and (unless sendConfirmation is false) send the confirmation

const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { isEnabled } = require('../config/feature-gates');
const {
  listPickableCalls, bookNewCallerVisit, linkNewCallerVisit, armLinkedVisitComms,
} = require('../services/booking/new-caller-visit');
const logger = require('../services/logger');

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

router.put('/:visitId/link', async (req, res, next) => {
  try {
    const { visit, addedProperty } = await linkNewCallerVisit({
      visitId: req.params.visitId,
      customerId: req.body?.customerId,
      adminUserId: req.technicianId || null,
    });
    // The link is committed: a reminder or text failure is reported, never undone.
    const wantsText = req.body?.sendConfirmation !== false;
    let outcome = { remindersArmed: false, confirmationSent: false };
    try {
      outcome = await armLinkedVisitComms({ visit, sendConfirmation: wantsText });
    } catch (err) {
      logger.error(`[new-caller] reminders/confirmation after link failed for visit ${visit.id}: ${err.message}`);
    }
    let warning = null;
    if (!outcome.remindersArmed) warning = 'The visit is linked, but its reminders were not set up and no confirmation went out. Check the visit.';
    else if (wantsText && !outcome.confirmationSent) warning = 'The visit is linked. The confirmation text did not go out; the customer may not take texts. Check the visit.';
    res.json({ ok: true, id: visit.id, customerId: visit.customer_id, addedProperty, ...outcome, warning });
  } catch (err) {
    if (err?.isOperational && (err.status || err.statusCode)) return sendOperational(res, err);
    next(err);
  }
});

module.exports = router;
