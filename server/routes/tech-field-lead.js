const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate } = require('../middleware/admin-auth');
const { soldByLive } = require('../services/estimate-sold-by');

// Tech auth — any authenticated technician
router.use(adminAuthenticate);

// GATE_COMMISSION_SOLD_BY helpers (owner 2026-10-29, D5 part 3b-1). With the gate off each one
// returns an empty value, so the route's reads and writes are exactly what they were before.
// Before the customer is looked up: the Neighbor's details, checked for the required fields.
async function prepareGpsCheck(req) {
  const { customerId, prospect } = req.body;
  if (!soldByLive() || customerId || prospect == null) return {};
  const { normalizeProspect } = require('../services/field-lead-gps');
  return { live: true, ...normalizeProspect(prospect) };
}

// After the route scoping guard: the truck GPS check. A failed check is a result; a check that
// could not run stays null ("no check ran") and the lead is made either way.
async function runGpsCheck(req, gpsSetup) {
  const { customerId, scheduledServiceId } = req.body;
  if (!soldByLive() || (!customerId && !gpsSetup.prospect)) return null;
  const gps = require('../services/field-lead-gps');
  try {
    return customerId
      ? await gps.checkCustomerArrival({ technicianId: req.technicianId, customerId, scheduledServiceId })
      : await gps.checkProspectLocation({ technicianId: req.technicianId, prospect: gpsSetup.prospect });
  } catch (err) {
    require('../services/logger').warn(`[tech-field-lead] gps check failed: ${err.message}`);
    return null;
  }
}

// A Neighbor has no customer row: the typed details fill the lead's contact columns.
function prospectLeadColumns(prospect) {
  if (!prospect) return {};
  return {
    first_name: prospect.firstName, last_name: prospect.lastName || null, phone: prospect.phone,
    address: prospect.address, city: prospect.city || null, zip: prospect.zip,
  };
}

function gpsLeadColumns(gpsCheck) {
  if (!gpsCheck) return {};
  return { gps_verified: gpsCheck.result === 'verified', gps_check: JSON.stringify(gpsCheck) };
}

function gpsActivitySuffix(gpsCheck) {
  if (!gpsCheck) return '';
  return ` · ${require('../services/field-lead-gps').describeGpsCheck(gpsCheck)}`;
}

/* POST / — create a field lead */
router.post('/', async (req, res, next) => {
  try {
    const { customerId, leadServiceType, notes, urgency } = req.body;
    if (!leadServiceType) return res.status(400).json({ error: 'Service type is required' });

    // GATE_COMMISSION_SOLD_BY: the truck GPS checks the flag. Off = {}: nothing new is read or written.
    const gpsSetup = await prepareGpsCheck(req);
    if (gpsSetup.error) return res.status(400).json({ error: gpsSetup.error });

    // Look up the field_tech lead source
    const leadSource = await db('lead_sources')
      .where({ channel: 'field_observation', is_active: true })
      .first();

    // Get customer info if customerId provided
    let customer = null;
    if (customerId) {
      // A technician flags a lead only for a customer on their own current or
      // recent route: their details are copied into the lead (codex #5568
      // r17 P1). 404 so an id seen elsewhere confirms nothing; admins pass.
      const { technicianServicesCustomer } = require('../services/technician-visit-scope');
      if (!(await technicianServicesCustomer(req, customerId))) return res.status(404).json({ error: 'Customer not found' });
      customer = await db('customers').where({ id: customerId }).first();
    }

    const gpsCheck = await runGpsCheck(req, gpsSetup);

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
        ...prospectLeadColumns(gpsSetup.prospect),
        ...gpsLeadColumns(gpsCheck),
      })
      .returning('*');

    // Log activity
    await db('lead_activities').insert({
      lead_id: lead.id,
      activity_type: 'field_observation',
      description: `Field lead created by ${req.technician.name}: ${leadServiceType}${notes ? ' — ' + notes : ''}${gpsActivitySuffix(gpsCheck)}`,
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
