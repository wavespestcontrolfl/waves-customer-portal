const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { resolveLocation } = require('../config/locations');
const smsTemplatesRouter = require('./admin-sms-templates');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');
const trackTransitions = require('../services/track-transitions');

async function renderTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body) return body;
    }
  } catch { /* fall through */ }
  return fallback;
}

// Templates say "Your {service_type} service report is ready", but
// many service_type values already end in "Service" / "Services"
// (e.g. "One-Time Pest Control Service") which would duplicate the
// word. Strip the trailing suffix before substitution so output reads
// "Your One-Time Pest Control service report is ready."
function normalizeServiceTypeForTemplate(s) {
  if (!s) return 'your service';
  return s.replace(/\s+services?$/i, '');
}

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/dispatch/today (or /:date)
router.get('/:date?', async (req, res, next) => {
  try {
    // Validate date param — reject non-date strings like "technicians", "products", etc.
    const rawDate = req.params.date;
    if (rawDate && !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return next();
    const date = rawDate || etDateString();

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
        notes: s.notes || '',
        createdAt: s.created_at,
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

// PATCH /api/admin/dispatch/:serviceId/note — save the staff-facing appointment note
router.patch('/:serviceId/note', async (req, res, next) => {
  try {
    const { notes } = req.body;
    const text = (notes == null ? '' : String(notes)).slice(0, 2000);
    const updated = await db('scheduled_services')
      .where({ id: req.params.serviceId })
      .update({ notes: text, updated_at: new Date() })
      .returning(['id', 'notes']);
    if (!updated.length) return res.status(404).json({ error: 'Service not found' });
    res.json({ success: true, notes: updated[0].notes });
  } catch (err) { next(err); }
});

// PUT /api/admin/dispatch/:serviceId/status
router.put('/:serviceId/status', async (req, res, next) => {
  try {
    const { status, notes, lat, lng } = req.body;
    const svc = await db('scheduled_services').where('scheduled_services.id', req.params.serviceId)
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

    // Customer-visible track_state is owned by services/track-transitions.js.
    // Legacy `status` column write above stays for back-compat; the helper
    // owns track_state, lifecycle timestamps, and the en-route SMS fire.
    // Removed the inline sendSMS block that lived here — the helper calls
    // TwilioService.sendTechEnRoute with the track-link body, and the legacy
    // message would have been duplicative.
    if (status === 'en_route') {
      try {
        await trackTransitions.markEnRoute(svc.id, {
          actorType: 'admin',
          actorId: req.technicianId,
        });
      } catch (e) { logger.error(`[admin-dispatch] markEnRoute failed: ${e.message}`); }
    } else if (status === 'completed') {
      try {
        await trackTransitions.markComplete(svc.id, {
          actorType: 'admin',
          actorId: req.technicianId,
        });
      } catch (e) { logger.error(`[admin-dispatch] markComplete failed: ${e.message}`); }
    } else if (status === 'cancelled') {
      try {
        await trackTransitions.cancel(svc.id, {
          reason: notes || null,
          actorId: req.technicianId,
        });
      } catch (e) { logger.error(`[admin-dispatch] cancel failed: ${e.message}`); }
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
    const { technicianNotes, products, soilTemp, thatchMeasurement, soilPh, soilMoisture, sendCompletionSms, requestReview, formResponses, formStartedAt } = req.body;
    const svc = await db('scheduled_services').where('scheduled_services.id', req.params.serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.last_name', 'customers.phone as cust_phone', 'customers.city', 'customers.property_type', 'customers.monthly_rate as cust_monthly_rate', 'customers.waveguard_tier as cust_waveguard_tier', 'technicians.name as tech_name')
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

    // Customer-visible track_state → 'complete' so /track/:token renders the
    // summary card. track_state is owned by services/track-transitions.js.
    try {
      await trackTransitions.markComplete(svc.id, {
        actorType: 'admin',
        actorId: req.technicianId,
      });
    } catch (e) { logger.error(`[admin-dispatch] markComplete failed: ${e.message}`); }

    // Invoice + completion SMS:
    //   - If the appointment was flagged `create_invoice_on_complete` (scheduler's
    //     "Create invoice" checkbox) OR the customer is WaveGuard with a monthly_rate,
    //     generate an invoice and send a single combined SMS (report + pay link).
    //   - Otherwise send the plain service-complete SMS (report link only).
    const invoiceAmount = (svc.estimated_price != null && Number(svc.estimated_price) > 0)
      ? Number(svc.estimated_price)
      : (svc.cust_monthly_rate && Number(svc.cust_monthly_rate) > 0 ? Number(svc.cust_monthly_rate) : 0);
    // Skip invoice creation if a paid invoice already exists for this service record
    // (covers the "customer paid prior to service report" case)
    let alreadyPaid = false;
    try {
      const existingPaid = await db('invoices')
        .where({ service_record_id: record.id, status: 'paid' })
        .first();
      if (existingPaid) alreadyPaid = true;
    } catch (e) { /* non-blocking */ }
    // If the admin/tech marked this visit prepaid (cash, Zelle, phone CC, etc.)
    // and the recorded amount covers the would-be invoice, skip auto-invoicing.
    const prepaidCovered = svc.prepaid_amount != null
      && Number(svc.prepaid_amount) > 0
      && Number(svc.prepaid_amount) >= invoiceAmount;
    // If the tech already minted an invoice for this visit pre-completion
    // (Charge now → Tap-to-Pay flow), reuse it instead of cutting a second one.
    let preMintedInvoice = null;
    try {
      preMintedInvoice = await db('invoices')
        .where({ scheduled_service_id: svc.id })
        .whereNot('status', 'void')
        .orderBy('created_at', 'desc')
        .first();
    } catch (e) { /* column may not exist pre-migration — non-blocking */ }
    const shouldInvoice = !alreadyPaid && !prepaidCovered && !preMintedInvoice
      && (!!svc.create_invoice_on_complete || !!svc.cust_waveguard_tier) && invoiceAmount > 0;
    // Customer-facing SMS URL must be the canonical portal domain, not
    // the raw Railway URL (CLIENT_URL is set to the Railway hostname on
    // prod for app-internal redirects). PORTAL_URL can override for dev.
    const portalUrl = process.env.PORTAL_URL || 'https://portal.wavespestcontrol.com';

    let invoiceCreated = false;
    let payUrl = null;
    let invoice = null;
    if (shouldInvoice) {
      try {
        const InvoiceService = require('../services/invoice');
        invoice = await InvoiceService.createFromService(record.id, {
          amount: invoiceAmount,
          description: svc.service_type,
          taxRate: svc.property_type === 'commercial' ? 0.07 : 0,
        });
        invoiceCreated = true;
        payUrl = `${portalUrl}/pay/${invoice.token}`;
      } catch (invErr) {
        logger.error(`[dispatch] Auto-invoice failed (non-blocking): ${invErr.message}`);
      }
    } else if (preMintedInvoice) {
      // Back-link the pre-minted invoice to the freshly created service_record
      // so receipts, /pay enrichment, and reports all resolve correctly.
      try {
        await db('invoices').where({ id: preMintedInvoice.id }).update({
          service_record_id: record.id,
          technician_id: svc.technician_id || preMintedInvoice.technician_id || null,
          updated_at: new Date(),
        });
      } catch (e) { logger.warn(`[dispatch] Could not back-link invoice to service_record: ${e.message}`); }
      invoice = preMintedInvoice;
      payUrl = `${portalUrl}/pay/${preMintedInvoice.token}`;
      // Treat already-paid pre-mint as the same SMS branch as prepaid.
      if (preMintedInvoice.status === 'paid') alreadyPaid = true;
      else invoiceCreated = true;
    }

    // When the tech completes with both "send report" and "ask for review" on,
    // mint the review row now and bundle its short URL into the one completion
    // SMS instead of firing a second message 90-180 min later. Single message
    // lands higher read-rates than two.
    let bundledReviewUrl = null;
    if (sendCompletionSms && requestReview && svc.cust_phone) {
      try {
        const ReviewService = require('../services/review-request');
        bundledReviewUrl = await ReviewService.createInline({
          customerId: svc.customer_id,
          serviceRecordId: record.id,
        });
      } catch (e) { logger.error(`[dispatch] Inline review mint failed: ${e.message}`); }
    }
    const reviewSuffix = bundledReviewUrl
      ? `\n\nEnjoyed the service? A quick review means the world: ${bundledReviewUrl}`
      : '';

    if (sendCompletionSms && svc.cust_phone) {
      try {
        const displayServiceType = normalizeServiceTypeForTemplate(svc.service_type);
        if (invoiceCreated && payUrl) {
          const fallback = `Hello ${svc.first_name}! Your ${displayServiceType} service report is ready: ${portalUrl}\n\nInvoice for today's visit: ${payUrl}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!`;
          const body = await renderTemplate('service_complete_with_invoice', {
            first_name: svc.first_name || '',
            service_type: displayServiceType,
            portal_url: portalUrl,
            pay_url: payUrl,
          }, fallback);
          await TwilioService.sendSMS(svc.cust_phone, body + reviewSuffix, { customerId: svc.customer_id, messageType: 'service_complete_with_invoice' });
        } else if (prepaidCovered || alreadyPaid) {
          const fallback = `Hello ${svc.first_name}! Thanks for your payment today. Your ${displayServiceType} service report is ready: ${portalUrl}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!`;
          const body = await renderTemplate('service_complete_prepaid', {
            first_name: svc.first_name || '',
            service_type: displayServiceType,
            portal_url: portalUrl,
          }, fallback);
          await TwilioService.sendSMS(svc.cust_phone, body + reviewSuffix, { customerId: svc.customer_id, messageType: 'service_complete_prepaid' });
        } else {
          const fallback = `Hello ${svc.first_name}! Your service report is ready. View it here: ${portalUrl}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!`;
          const body = await renderTemplate('service_complete', { first_name: svc.first_name || '' }, fallback);
          await TwilioService.sendSMS(svc.cust_phone, body + reviewSuffix, { customerId: svc.customer_id, messageType: 'service_complete' });
        }
      } catch (e) { logger.error(`Completion SMS failed: ${e.message}`); }
    }

    // Only schedule the delayed follow-up message when the review wasn't
    // already bundled into the completion SMS above.
    if (requestReview && svc.cust_phone && !bundledReviewUrl) {
      try {
        const ReviewService = require('../services/review-request');
        await ReviewService.create({
          customerId: svc.customer_id,
          serviceRecordId: record.id,
          triggeredBy: 'auto',
          delayMinutes: 120,
        });
      } catch (e) { logger.error(`[dispatch] Review request schedule failed: ${e.message}`); }
    }

    await db('activity_log').insert({
      admin_user_id: req.technicianId, customer_id: svc.customer_id,
      action: 'service_completed',
      description: `${svc.tech_name} completed ${svc.service_type} for ${svc.first_name} ${svc.last_name}`,
    });

    // Job form submission (non-blocking)
    if (formResponses) {
      try {
        const JobForm = require('../services/job-form');
        await JobForm.saveSubmission({
          scheduledServiceId: svc.id,
          serviceRecordId: record.id,
          technicianId: svc.technician_id,
          customerId: svc.customer_id,
          serviceType: svc.service_type,
          responses: formResponses,
          startedAt: formStartedAt || null,
        });
      } catch (e) { logger.error(`[dispatch] Job form save failed (non-blocking): ${e.message}`); }
    }

    // Job costing (non-blocking, fire-and-forget)
    try {
      const JobCosting = require('../services/job-costing');
      JobCosting.calculateJobCost(svc.id).catch(e =>
        logger.error(`[dispatch] Job cost calc failed: ${e.message}`)
      );
    } catch (e) { logger.error(`[dispatch] Job costing require failed: ${e.message}`); }

    res.json({
      success: true,
      serviceRecordId: record.id,
      invoiceId: invoice?.id || null,
      invoiceTotal: invoice?.total != null ? Number(invoice.total) : null,
    });
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

// GET /api/admin/dispatch/board — phase 2 dispatch board v1 hydration.
// Returns techs (left-pane roster) + today's jobs (map pins). Single
// payload to avoid a flash of stale state on the map. Real-time updates
// from there ride dispatch:tech_status broadcasts (PR #284); the client
// uses the `jobs` array as a lookup table for current_job_id → address.
//
// Filter rules (per phase 2 brief):
//   - techs[]:  technicians.role IN ('admin','technician') AND active=TRUE,
//               must have a tech_status row with updated_at >= NOW()-24h
//               (rolling window, not midnight ET — avoids the "tech pinged
//               at 11:50pm last night, card disappears at midnight" gap).
//   - jobs[]:   all scheduled_services WHERE scheduled_date = today (ET),
//               regardless of assignment, so unassigned pins still show
//               on the map in a neutral color.
//
// Address is normalized into a single string at this layer — clients
// don't see the schema's composable shape (address_line1/line2/city/
// state/zip). If the address representation changes later, only this
// endpoint touches it.
//
// Admin-only — requireAdmin (not requireTechOrAdmin) per the brief.
router.get('/board', requireAdmin, async (req, res, next) => {
  try {
    const today = etDateString();

    const techRows = await db.raw(
      `
      SELECT
        t.id,
        t.name,
        t.avatar_url,
        t.role,
        ts.status,
        ts.lat,
        ts.lng,
        ts.current_job_id,
        ts.updated_at,
        COALESCE(today_agg.total, 0)     AS today_total,
        COALESCE(today_agg.completed, 0) AS today_completed
      FROM technicians t
      INNER JOIN tech_status ts ON ts.tech_id = t.id
      LEFT JOIN (
        SELECT
          technician_id,
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed
        FROM scheduled_services
        WHERE scheduled_date = ?
          AND technician_id IS NOT NULL
        GROUP BY technician_id
      ) today_agg ON today_agg.technician_id = t.id
      WHERE t.role IN ('admin','technician')
        AND t.active = TRUE
        AND ts.updated_at >= NOW() - INTERVAL '24 hours'
      ORDER BY t.name
      `,
      [today]
    );

    const jobRows = await db.raw(
      `
      SELECT
        s.id,
        s.technician_id,
        s.customer_id,
        COALESCE(s.lat, c.latitude)  AS lat,
        COALESCE(s.lng, c.longitude) AS lng,
        s.status,
        s.service_type,
        s.scheduled_date,
        s.window_start,
        s.window_end,
        c.first_name,
        c.last_name,
        c.address_line1,
        c.address_line2,
        c.city,
        c.state,
        c.zip
      FROM scheduled_services s
      INNER JOIN customers c ON c.id = s.customer_id
      WHERE s.scheduled_date = ?
      ORDER BY s.window_start NULLS LAST, c.last_name
      `,
      [today]
    );

    const techs = (techRows.rows || []).map((r) => ({
      id: r.id,
      name: r.name,
      avatar_url: r.avatar_url || null,
      role: r.role,
      status: r.status,
      lat: r.lat == null ? null : Number(r.lat),
      lng: r.lng == null ? null : Number(r.lng),
      current_job_id: r.current_job_id || null,
      updated_at: r.updated_at,
      today_total: parseInt(r.today_total, 10) || 0,
      today_completed: parseInt(r.today_completed, 10) || 0,
    }));

    const jobs = (jobRows.rows || []).map((r) => {
      // Address normalization at the API boundary. Clients render this
      // string directly; the schema's address_line1/line2/city/state/zip
      // shape stays internal.
      const line1 = r.address_line1 || '';
      const line2 = r.address_line2 ? ` ${r.address_line2}` : '';
      const cityState = r.city ? `, ${r.city}` : '';
      const stateZip = r.state ? `, ${r.state}${r.zip ? ` ${r.zip}` : ''}` : '';
      const address = `${line1}${line2}${cityState}${stateZip}`.trim();

      // Customer name: first name + last initial, e.g. "Sarah M."
      // Admin-channel safe (this is the dispatch board, not customer-
      // facing) but truncated keeps map pin tooltips readable. Last
      // name stays in detail-view fetches.
      const lastInitial = r.last_name ? r.last_name.trim().charAt(0).toUpperCase() : '';
      const customer_name = lastInitial
        ? `${r.first_name} ${lastInitial}.`
        : (r.first_name || '');

      return {
        id: r.id,
        technician_id: r.technician_id || null,
        customer_id: r.customer_id,
        customer_name,
        address,
        lat: r.lat == null ? null : Number(r.lat),
        lng: r.lng == null ? null : Number(r.lng),
        status: r.status,
        service_type: r.service_type || null,
        scheduled_date: r.scheduled_date,
        window_start: r.window_start || null,
        window_end: r.window_end || null,
      };
    });

    res.json({ techs, jobs });
  } catch (err) {
    logger.error(`[dispatch/board] hydration failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dispatch/jobs/:id — drawer hydration.
//
// Richer payload than dispatch:job_update (the broadcast event):
// includes the full customer last name + phone + email so the
// dispatcher can identify "whose house" at a glance and call them
// without leaving the drawer. Same admin-only scope as /board.
//
// Distinct from the broadcast event because:
//   - Broadcasts must stay narrow (re-render the roster + map without
//     a refetch); the drawer is on-demand and can carry richer data
//     that the user explicitly opened.
//   - Customer last name was redacted from dispatch:job_update because
//     a stale broadcast on a customer:* room could leak it; the drawer
//     fetches over an admin-authenticated GET so the same constraint
//     doesn't apply.
//
// Admin-only via requireAdmin (same as /board).
router.get('/jobs/:id', requireAdmin, async (req, res, next) => {
  try {
    const row = await db('scheduled_services as s')
      .leftJoin('technicians as t', 's.technician_id', 't.id')
      .innerJoin('customers as c', 's.customer_id', 'c.id')
      .where('s.id', req.params.id)
      .first(
        's.id as job_id',
        's.customer_id',
        's.technician_id as tech_id',
        's.status',
        's.service_type',
        's.scheduled_date',
        's.window_start',
        's.window_end',
        's.notes',
        's.internal_notes',
        's.lat as svc_lat',
        's.lng as svc_lng',
        's.updated_at',
        't.name as tech_full_name',
        'c.first_name as cust_first_name',
        'c.last_name as cust_last_name',
        'c.phone as cust_phone',
        'c.email as cust_email',
        'c.address_line1',
        'c.address_line2',
        'c.city',
        'c.state',
        'c.zip',
        'c.latitude as cust_lat',
        'c.longitude as cust_lng'
      );

    if (!row) return res.status(404).json({ error: 'Job not found' });

    // Same address normalization as /board so client renders are
    // consistent across the two surfaces.
    const line1 = row.address_line1 || '';
    const line2 = row.address_line2 ? ` ${row.address_line2}` : '';
    const cityState = row.city ? `, ${row.city}` : '';
    const stateZip = row.state ? `, ${row.state}${row.zip ? ` ${row.zip}` : ''}` : '';
    const address = `${line1}${line2}${cityState}${stateZip}`.trim();

    const lat = row.svc_lat == null ? (row.cust_lat == null ? null : Number(row.cust_lat)) : Number(row.svc_lat);
    const lng = row.svc_lng == null ? (row.cust_lng == null ? null : Number(row.cust_lng)) : Number(row.svc_lng);

    return res.json({
      id: row.job_id,
      customer_id: row.customer_id,
      customer_first_name: row.cust_first_name,
      customer_last_name: row.cust_last_name,   // full last name OK on admin GET
      customer_phone: row.cust_phone || null,
      customer_email: row.cust_email || null,
      address,
      lat,
      lng,
      tech_id: row.tech_id || null,
      tech_full_name: row.tech_full_name || null,
      status: row.status,
      service_type: row.service_type || null,
      scheduled_date: row.scheduled_date,
      window_start: row.window_start || null,
      window_end: row.window_end || null,
      notes: row.notes || null,
      internal_notes: row.internal_notes || null,
      updated_at: row.updated_at,
    });
  } catch (err) {
    logger.error(`[dispatch/jobs/:id] hydration failed: ${err.message}`);
    next(err);
  }
});

// GET /api/admin/dispatch/alerts — action queue read endpoint.
//
// Returns dispatch_alerts rows enriched with tech_name + customer
// context + address so the right-pane can render cards without
// follow-up fetches per alert. Filtered by ?unresolved=true (default
// true; pass ?unresolved=false to include resolved alerts in audit
// views).
//
// Default ORDER BY created_at DESC (newest first) — that's the
// dispatch board's primary read pattern. ?limit caps the result;
// default 50, max 200 to keep payloads bounded if the table grows.
//
// Distinct from the dispatch:alert socket broadcast (PR #293):
// broadcast carries the bare row at insert time (cheap, narrow);
// this GET returns enriched rows (tech name, customer, address) for
// the right-pane's hydration. The action queue UI degrades
// gracefully when broadcast-only rows are missing the enriched
// fields.
//
// Admin-only (matches /board and /jobs/:id).
router.get('/alerts', requireAdmin, async (req, res, next) => {
  try {
    const unresolved = req.query.unresolved !== 'false';
    const requestedLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 50;

    const q = db('dispatch_alerts as a')
      .leftJoin('technicians as t', 'a.tech_id', 't.id')
      .leftJoin('scheduled_services as s', 'a.job_id', 's.id')
      .leftJoin('customers as c', 's.customer_id', 'c.id')
      .select(
        'a.id',
        'a.type',
        'a.severity',
        'a.tech_id',
        'a.job_id',
        'a.payload',
        'a.created_at',
        'a.resolved_at',
        'a.resolved_by',
        't.name as tech_name',
        'c.first_name as customer_first_name',
        'c.last_name as customer_last_name',
        'c.address_line1',
        'c.address_line2',
        'c.city',
        'c.state',
        'c.zip',
        's.service_type',
        's.scheduled_date',
        's.window_start',
        's.window_end'
      )
      .orderBy('a.created_at', 'desc')
      .limit(limit);

    if (unresolved) q.whereNull('a.resolved_at');

    const rows = await q;

    const alerts = rows.map((r) => {
      // Address normalization, same shape as /board and /jobs/:id.
      // Null-safe — alerts can be tech-scoped or job-scoped or neither,
      // so customer/job fields may all be null.
      let address = null;
      if (r.address_line1) {
        const line2 = r.address_line2 ? ` ${r.address_line2}` : '';
        const cityState = r.city ? `, ${r.city}` : '';
        const stateZip = r.state ? `, ${r.state}${r.zip ? ` ${r.zip}` : ''}` : '';
        address = `${r.address_line1}${line2}${cityState}${stateZip}`.trim();
      }

      return {
        id: r.id,
        type: r.type,
        severity: r.severity,
        tech_id: r.tech_id,
        tech_name: r.tech_name || null,
        job_id: r.job_id,
        customer_first_name: r.customer_first_name || null,
        customer_last_name: r.customer_last_name || null,
        address,
        service_type: r.service_type || null,
        scheduled_date: r.scheduled_date || null,
        window_start: r.window_start || null,
        window_end: r.window_end || null,
        // payload is JSONB — pg returns it as object directly.
        payload: r.payload || null,
        created_at: r.created_at,
        resolved_at: r.resolved_at,
        resolved_by: r.resolved_by,
      };
    });

    res.json({ alerts });
  } catch (err) {
    logger.error(`[dispatch/alerts] hydration failed: ${err.message}`);
    next(err);
  }
});

// PATCH /api/admin/dispatch/alerts/:id/resolve — close an action queue card.
//
// Sets resolved_at + resolved_by on the row and broadcasts
// dispatch:alert_resolved to dispatch:admins so every connected
// dispatcher's right pane drops the card without a hydration round
// trip. The local PATCH caller also drops it client-side on success
// (their broadcast arrival becomes a no-op via the same id filter).
//
// Idempotent: the underlying UPDATE matches `WHERE resolved_at IS NULL`,
// so a second concurrent resolve from another dispatcher returns null
// from resolveAlert. We follow up with a SELECT to disambiguate:
//   - row exists and is resolved → 200 with the existing row, no
//     second broadcast (cards on other clients already removed)
//   - row missing                → 404
router.patch('/alerts/:id/resolve', requireAdmin, async (req, res, next) => {
  try {
    const { resolveAlert } = require('../services/dispatch-alerts');
    const row = await resolveAlert({
      id: req.params.id,
      resolvedBy: req.technicianId,
    });
    if (row) return res.json({ alert: row });

    const existing = await db('dispatch_alerts').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'alert not found' });
    return res.json({ alert: existing });
  } catch (err) {
    logger.error(`[dispatch/alerts/resolve] failed for ${req.params.id}: ${err.message}`);
    next(err);
  }
});

module.exports = router;
