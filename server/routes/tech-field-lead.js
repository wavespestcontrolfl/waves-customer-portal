const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate } = require('../middleware/admin-auth');

// Tech auth — any authenticated technician
router.use(adminAuthenticate);

/* POST / — create a field lead */
router.post('/', async (req, res, next) => {
  try {
    const { customerId, leadServiceType, notes, urgency } = req.body;
    if (!leadServiceType) return res.status(400).json({ error: 'Service type is required' });

    // Look up the field_tech lead source
    const leadSource = await db('lead_sources')
      .where({ channel: 'field_observation', is_active: true })
      .first();

    // Get customer info if customerId provided
    let customer = null;
    if (customerId) {
      customer = await db('customers').where({ id: customerId }).first();
    }

    // Create the lead
    const [lead] = await db('leads')
      .insert({
        lead_source_id: leadSource?.id || null,
        customer_id: customerId || null,
        first_name: customer?.first_name || null,
        last_name: customer?.last_name || null,
        phone: customer?.phone || null,
        email: customer?.email || null,
        address: customer?.address_line1 || null,
        city: customer?.city || null,
        lead_type: 'field_observation',
        service_interest: leadServiceType,
        urgency: urgency || 'normal',
        first_contact_channel: 'field_observation',
        status: 'new',
        assigned_to: req.technicianId,
      })
      .returning('*');

    // Log activity
    await db('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'field_observation',
      description: `Field lead created by ${req.technician.name}: ${leadServiceType}${notes ? ' — ' + notes : ''}`,
      performed_by: req.technician.name,
      metadata: JSON.stringify({ technicianId: req.technicianId, notes, urgency }),
    });

    // Also log to activity_log
    try {
      await db('activity_log').insert({
        action: 'field_lead_created',
        description: `${req.technician.name} flagged ${leadServiceType} opportunity${customer ? ` at ${customer.first_name} ${customer.last_name}` : ''}`,
        metadata: JSON.stringify({ leadId: lead.id, technicianId: req.technicianId, serviceType: leadServiceType }),
      });
    } catch {}

    // Send admin SMS notification
    try {
      const TwilioService = require('../services/twilio');
      const ADMIN_PHONE = process.env.ADAM_PHONE || '+19415993489';
      const customerLabel = customer ? `${customer.first_name} ${customer.last_name}` : 'Unknown customer';
      await TwilioService.sendSMS(ADMIN_PHONE,
        `🔔 Field Lead: ${req.technician.name} flagged ${leadServiceType} opportunity at ${customerLabel}.${notes ? '\nNotes: ' + notes : ''}${urgency === 'high' ? '\n⚡ URGENT' : ''}`,
        { messageType: 'internal_alert' }
      );
    } catch {}

    res.json({ success: true, lead: { id: lead.id, status: lead.status } });
  } catch (err) { next(err); }
});

module.exports = router;
