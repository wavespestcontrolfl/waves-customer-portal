const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { resolveLocation } = require('../config/locations');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/dispatch/today (or /:date)
router.get('/:date?', async (req, res, next) => {
  try {
    const date = req.params.date || new Date().toISOString().split('T')[0];

    const services = await db('scheduled_services')
      .where({ 'scheduled_services.scheduled_date': date })
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select(
        'scheduled_services.*',
        'customers.first_name', 'customers.last_name', 'customers.phone as customer_phone',
        'customers.address_line1', 'customers.city', 'customers.state', 'customers.zip',
        'customers.waveguard_tier', 'customers.monthly_rate', 'customers.lawn_type',
        'technicians.name as tech_name'
      )
      .orderByRaw('COALESCE(route_order, 999), window_start');

    // Enrich with property preferences and last service
    const enriched = await Promise.all(services.map(async (s) => {
      const prefs = await db('property_preferences').where({ customer_id: s.customer_id }).first();
      const lastService = await db('service_records')
        .where({ customer_id: s.customer_id, status: 'completed' })
        .orderBy('service_date', 'desc').first();
      const statusLog = await db('service_status_log')
        .where({ scheduled_service_id: s.id }).orderBy('created_at');

      // Build property notes
      const alerts = [];
      if (prefs?.neighborhood_gate_code) alerts.push(`Gate: ${prefs.neighborhood_gate_code}`);
      if (prefs?.property_gate_code) alerts.push(`Yard gate: ${prefs.property_gate_code}`);
      if (prefs?.pet_count > 0) alerts.push(`🐾 ${prefs.pet_details || `${prefs.pet_count} pet(s)`}`);
      if (prefs?.pets_secured_plan) alerts.push(`Pet plan: ${prefs.pets_secured_plan}`);
      if (prefs?.chemical_sensitivities) alerts.push(`⚠️ Chemical sensitivity: ${prefs.chemical_sensitivity_details || 'yes'}`);
      if (prefs?.access_notes) alerts.push(prefs.access_notes);
      if (s.notes) alerts.push(s.notes);

      return {
        id: s.id,
        routeOrder: s.route_order,
        customerName: `${s.first_name} ${s.last_name}`,
        customerId: s.customer_id,
        customerPhone: s.customer_phone,
        address: `${s.address_line1}, ${s.city}, ${s.state} ${s.zip}`,
        city: s.city,
        serviceType: s.service_type,
        windowStart: s.window_start,
        windowEnd: s.window_end,
        status: s.status,
        technicianId: s.technician_id,
        technicianName: s.tech_name,
        customerConfirmed: s.customer_confirmed,
        waveguardTier: s.waveguard_tier,
        monthlyRate: parseFloat(s.monthly_rate || 0),
        lawnType: s.lawn_type,
        propertyAlerts: alerts,
        lastServiceDate: lastService?.service_date || null,
        lastServiceType: lastService?.service_type || null,
        lastServiceNotes: lastService?.technician_notes?.slice(0, 200) || null,
        actualStartTime: s.actual_start_time,
        actualEndTime: s.actual_end_time,
        serviceTimeMinutes: s.service_time_minutes,
        statusLog: statusLog.map(l => ({ status: l.status, at: l.created_at, notes: l.notes })),
      };
    }));

    // Tech summary
    const techs = {};
    enriched.forEach(s => {
      if (!s.technicianId) return;
      if (!techs[s.technicianId]) {
        techs[s.technicianId] = {
          technicianId: s.technicianId, technicianName: s.technicianName,
          initials: s.technicianName?.split(' ').map(n => n[0]).join('') || '?',
          serviceCount: 0, completedCount: 0,
        };
      }
      techs[s.technicianId].serviceCount++;
      if (s.status === 'completed') techs[s.technicianId].completedCount++;
    });

    res.json({ date, services: enriched, techSummary: Object.values(techs) });
  } catch (err) { next(err); }
});

// PUT /api/admin/dispatch/:serviceId/status
router.put('/:serviceId/status', async (req, res, next) => {
  try {
    const { status, notes, lat, lng } = req.body;
    const svc = await db('scheduled_services').where({ id: req.params.serviceId })
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.phone as cust_phone', 'customers.city', 'technicians.name as tech_name')
      .first();

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Log status change
    await db('service_status_log').insert({
      scheduled_service_id: svc.id, status, changed_by: req.technicianId, lat, lng, notes,
    });

    const updates = { status };
    if (status === 'on_site') updates.actual_start_time = db.fn.now();
    if (status === 'completed') {
      updates.actual_end_time = db.fn.now();
      if (svc.actual_start_time) {
        updates.service_time_minutes = Math.round((Date.now() - new Date(svc.actual_start_time)) / 60000);
      }
    }
    await db('scheduled_services').where({ id: svc.id }).update(updates);

    // Send en_route SMS
    if (status === 'en_route' && svc.cust_phone) {
      const loc = resolveLocation(svc.city);
      try {
        await TwilioService.sendSMS(svc.cust_phone,
          `🌊 Waves Pest Control\n\nHi ${svc.first_name}! ${svc.tech_name} is on the way to your property.\n\nPlease ensure gates are unlocked and pets are secured.\n\nQuestions? Reply or call ${loc.phone}.`
        );
      } catch (e) { logger.error(`En route SMS failed: ${e.message}`); }
    }

    await db('activity_log').insert({
      admin_user_id: req.technicianId, customer_id: svc.customer_id,
      action: status === 'completed' ? 'service_completed' : 'status_changed',
      description: `${svc.tech_name} marked ${svc.service_type} as ${status} for ${svc.first_name}`,
    });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/dispatch/:serviceId/complete
router.post('/:serviceId/complete', async (req, res, next) => {
  try {
    const { technicianNotes, products, soilTemp, thatchMeasurement, soilPh, soilMoisture, sendCompletionSms, requestReview } = req.body;
    const svc = await db('scheduled_services').where({ id: req.params.serviceId })
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.last_name', 'customers.phone as cust_phone', 'customers.city', 'technicians.name as tech_name')
      .first();

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    // Create service_record
    const [record] = await db('service_records').insert({
      customer_id: svc.customer_id, technician_id: svc.technician_id,
      service_date: svc.scheduled_date, service_type: svc.service_type, status: 'completed',
      technician_notes: technicianNotes || '',
      soil_temp: soilTemp || null, thatch_measurement: thatchMeasurement || null,
      soil_ph: soilPh || null, soil_moisture: soilMoisture || null,
    }).returning('*');

    // Create service_products
    if (products?.length) {
      for (const p of products) {
        const product = p.productId ? await db('products_catalog').where({ id: p.productId }).first() : null;
        await db('service_products').insert({
          service_record_id: record.id,
          product_name: product?.name || p.name || 'Unknown',
          product_category: product?.category || p.category || null,
          active_ingredient: product?.active_ingredient || null,
          moa_group: product?.moa_group || null,
          application_rate: p.rate ? parseFloat(p.rate) : null,
          rate_unit: p.rateUnit || null,
          total_amount: p.totalAmount ? parseFloat(p.totalAmount) : null,
          amount_unit: p.amountUnit || null,
        });
      }
    }

    // Update scheduled_service
    await db('scheduled_services').where({ id: svc.id }).update({
      status: 'completed', actual_end_time: db.fn.now(),
      service_time_minutes: svc.actual_start_time ? Math.round((Date.now() - new Date(svc.actual_start_time)) / 60000) : null,
    });

    await db('service_status_log').insert({ scheduled_service_id: svc.id, status: 'completed', changed_by: req.technicianId });

    // Completion SMS — link to Visit Reports in portal
    if (svc.cust_phone) {
      try {
        const portalUrl = 'https://portal.wavespestcontrol.com';
        await TwilioService.sendSMS(svc.cust_phone,
          `Hello ${svc.first_name}! Your service report can be found under Documents > Visit Reports:\n${portalUrl}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!`,
          { customerId: svc.customer_id, messageType: 'service_complete' }
        );
      } catch (e) { logger.error(`Completion SMS failed: ${e.message}`); }
    }

    // Review request (delayed)
    if (requestReview && svc.cust_phone) {
      const loc = resolveLocation(svc.city);
      setTimeout(async () => {
        try {
          await TwilioService.sendSMS(svc.cust_phone,
            `🌊 Hi ${svc.first_name}! Hope your service went well today. If you have a moment, a quick Google review would mean the world to our team:\n\n${loc.googleReviewUrl}\n\nThank you! — Adam & the Waves team`
          );
        } catch (e) { logger.error(`Review request SMS failed: ${e.message}`); }
      }, 2 * 60 * 60 * 1000); // 2 hour delay
    }

    await db('activity_log').insert({
      admin_user_id: req.technicianId, customer_id: svc.customer_id,
      action: 'service_completed',
      description: `${svc.tech_name} completed ${svc.service_type} for ${svc.first_name} ${svc.last_name}`,
    });

    res.json({ success: true, serviceRecordId: record.id });
  } catch (err) { next(err); }
});

// PUT /api/admin/dispatch/:serviceId/reorder
router.put('/:serviceId/reorder', async (req, res, next) => {
  try {
    await db('scheduled_services').where({ id: req.params.serviceId }).update({ route_order: req.body.routeOrder });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PUT /api/admin/dispatch/reorder-bulk
router.put('/reorder/bulk', async (req, res, next) => {
  try {
    const { order } = req.body;
    for (const item of order) {
      await db('scheduled_services').where({ id: item.serviceId }).update({ route_order: item.routeOrder });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/products/catalog
router.get('/products/catalog', async (req, res, next) => {
  try {
    const products = await db('products_catalog').where({ active: true }).orderBy('category').orderBy('name');
    res.json({ products });
  } catch (err) { next(err); }
});

// =========================================================================
// RESCHEDULE ENDPOINTS
// =========================================================================
const SmartRebooker = require('../services/rebooker');
const RescheduleSMS = require('../services/reschedule-sms');
const ForecastAnalyzer = require('../services/forecast-analyzer');

// GET /api/admin/dispatch/:serviceId/reschedule-options
router.get('/:serviceId/reschedule-options', async (req, res, next) => {
  try {
    const options = await SmartRebooker.findRescheduleOptions(req.params.serviceId);
    res.json({ options });
  } catch (err) { next(err); }
});

// POST /api/admin/dispatch/:serviceId/reschedule
router.post('/:serviceId/reschedule', async (req, res, next) => {
  try {
    const { newDate, newWindow, reasonCode, reasonText, notifyCustomer } = req.body;

    if (notifyCustomer !== false) {
      const result = await RescheduleSMS.sendRescheduleRequest(req.params.serviceId, reasonCode || 'admin', reasonText);
      return res.json(result);
    }

    const result = await SmartRebooker.reschedule(req.params.serviceId, newDate, newWindow, reasonCode || 'admin', 'admin');
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/weather/tomorrow
router.get('/weather/tomorrow', async (req, res, next) => {
  try {
    const analysis = await ForecastAnalyzer.analyzeTomorrow();
    res.json(analysis);
  } catch (err) { next(err); }
});

// GET /api/admin/dispatch/reschedules/log
router.get('/reschedules/log', async (req, res, next) => {
  try {
    const logs = await db('reschedule_log')
      .leftJoin('customers', 'reschedule_log.customer_id', 'customers.id')
      .leftJoin('scheduled_services', 'reschedule_log.scheduled_service_id', 'scheduled_services.id')
      .select('reschedule_log.*', 'customers.first_name', 'customers.last_name',
        'scheduled_services.service_type')
      .orderBy('reschedule_log.created_at', 'desc')
      .limit(50);

    // Stats
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const stats = await db('reschedule_log').where('created_at', '>=', thirtyDaysAgo)
      .select('reason_code').count('* as count').groupBy('reason_code');
    const avgResponse = await db('reschedule_log').where('created_at', '>=', thirtyDaysAgo)
      .whereNotNull('response_time_minutes')
      .avg('response_time_minutes as avg').first();
    const autoConfirmed = await db('reschedule_log').where('created_at', '>=', thirtyDaysAgo)
      .whereIn('customer_response', ['option_1', 'option_2']).count('* as count').first();
    const total30 = await db('reschedule_log').where('created_at', '>=', thirtyDaysAgo).count('* as count').first();

    res.json({
      logs: logs.map(l => ({
        id: l.id, customerName: l.first_name ? `${l.first_name} ${l.last_name}` : 'Unknown',
        serviceType: l.service_type, originalDate: l.original_date, newDate: l.new_date,
        reasonCode: l.reason_code, initiatedBy: l.initiated_by,
        customerResponse: l.customer_response, responseTime: l.response_time_minutes,
        escalated: l.escalated, createdAt: l.created_at,
      })),
      stats: {
        total: parseInt(total30?.count || 0),
        byReason: Object.fromEntries(stats.map(s => [s.reason_code, parseInt(s.count)])),
        avgResponseMinutes: Math.round(parseFloat(avgResponse?.avg || 0)),
        autoConfirmedRate: total30?.count > 0 ? Math.round((parseInt(autoConfirmed?.count || 0) / parseInt(total30.count)) * 100) : 0,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
