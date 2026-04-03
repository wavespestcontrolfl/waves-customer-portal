const express = require('express');
const router = express.Router();
const db = require('../models/db');
const Availability = require('../services/availability');
const logger = require('../services/logger');

// GET /api/booking/availability?city=Bradenton&estimate_id=123
router.get('/availability', async (req, res, next) => {
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('selfBooking')) {
      return res.status(503).json({ error: 'Self-scheduling coming soon' });
    }

    const { city, estimate_id } = req.query;
    if (!city) return res.status(400).json({ error: 'City required' });

    const result = await Availability.getAvailableSlots(city, estimate_id);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/booking/confirm
router.post('/confirm', async (req, res, next) => {
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('selfBooking')) {
      return res.status(503).json({ error: 'Self-scheduling coming soon' });
    }

    const { estimate_id, customer_id, slot_date, slot_start, customer_notes } = req.body;
    if (!slot_date || !slot_start) return res.status(400).json({ error: 'Date and time required' });

    // Resolve customer_id from estimate if not provided
    let custId = customer_id;
    if (!custId && estimate_id) {
      const est = await db('estimates').where('id', estimate_id).first();
      custId = est?.customer_id;
    }
    if (!custId) return res.status(400).json({ error: 'Customer not found' });

    const result = await Availability.confirmBooking(estimate_id, custId, slot_date, slot_start, customer_notes);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/booking/status/:code
router.get('/status/:code', async (req, res, next) => {
  try {
    const booking = await db('self_booked_appointments')
      .where('confirmation_code', req.params.code)
      .leftJoin('customers', 'self_booked_appointments.customer_id', 'customers.id')
      .select('self_booked_appointments.*', 'customers.first_name', 'customers.last_name', 'customers.address_line1', 'customers.city')
      .first();

    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    res.json({ booking });
  } catch (err) { next(err); }
});

module.exports = router;
