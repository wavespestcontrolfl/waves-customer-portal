const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const {
  normalizeServiceType, detectServiceCategory, serviceIcon, serviceColor,
  cleanSquareNotes, isNewCustomer, safeDate,
} = require('../utils/service-normalizer');

router.use(adminAuthenticate, requireTechOrAdmin);

// Legacy wrapper — kept for backwards compat in other code paths
function sanitizeServiceType(serviceType) {
  return normalizeServiceType(serviceType);
}

function getZone(city, zip) {
  const c = (city || '').toLowerCase();
  const z = zip || '';
  if (['parrish', 'ellenton'].includes(c) || z === '34219') return 'parrish';
  if (c === 'palmetto') return 'palmetto';
  if (c.includes('lakewood') || ['34202', '34211', '34212'].includes(z)) return 'lakewood_ranch';
  if (c.includes('bradenton')) return 'bradenton_north';
  if (c === 'sarasota') return 'sarasota';
  if (['venice', 'nokomis', 'north port'].includes(c)) return 'venice_north_port';
  return 'lakewood_ranch';
}

const ZONE_COLORS = {
  parrish: '#10b981', palmetto: '#34d399', lakewood_ranch: '#0ea5e9',
  bradenton_north: '#6366f1', bradenton_south: '#8b5cf6',
  sarasota: '#f59e0b', venice_north_port: '#ef4444', ellenton: '#14b8a6',
};

const ZONE_LABELS = {
  parrish: 'Parrish', palmetto: 'Palmetto', lakewood_ranch: 'Lakewood Ranch',
  bradenton_north: 'Bradenton N', bradenton_south: 'Bradenton S',
  sarasota: 'Sarasota', venice_north_port: 'Venice/N.Port', ellenton: 'Ellenton',
};

// GET /api/admin/schedule — day view (board + dispatch)
router.get('/', async (req, res, next) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];

    const services = await db('scheduled_services')
      .where({ 'scheduled_services.scheduled_date': date })
      .whereNotIn('scheduled_services.status', ['cancelled'])
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select(
        'scheduled_services.*',
        'customers.first_name', 'customers.last_name', 'customers.phone as customer_phone',
        'customers.address_line1', 'customers.city', 'customers.state', 'customers.zip',
        'customers.waveguard_tier', 'customers.monthly_rate', 'customers.lawn_type',
        'customers.property_sqft', 'customers.lot_sqft', 'customers.lead_score',
        'technicians.name as tech_name'
      )
      .orderByRaw('COALESCE(route_order, 999), window_start');

    // Enrich with property prefs and last service
    const enriched = await Promise.all(services.map(async (s) => {
      const prefs = await db('property_preferences').where({ customer_id: s.customer_id }).first();
      const lastService = await db('service_records')
        .where({ customer_id: s.customer_id, status: 'completed' })
        .orderBy('service_date', 'desc').first();

      // BUG FIX #1: Compute isNewCustomer from actual service records, not Square notes
      const genuinelyNew = await isNewCustomer(db, s.customer_id);

      // BUG FIX #2: Normalize raw Square service type to clean Waves label
      const normalizedType = normalizeServiceType(s.service_type);
      const category = detectServiceCategory(normalizedType);

      // BUG FIX #4: Clean Square boilerplate from notes before adding to alerts
      const cleanedNotes = cleanSquareNotes(s.notes);

      const alerts = [];
      if (prefs?.neighborhood_gate_code) alerts.push({ type: 'gate', text: `Gate: ${prefs.neighborhood_gate_code}` });
      if (prefs?.property_gate_code) alerts.push({ type: 'gate', text: `Yard: ${prefs.property_gate_code}` });
      if (prefs?.pet_count > 0) alerts.push({ type: 'pet', text: prefs.pet_details || `${prefs.pet_count} pet(s)` });
      if (prefs?.pets_secured_plan) alerts.push({ type: 'pet_plan', text: prefs.pets_secured_plan });
      if (prefs?.chemical_sensitivities) alerts.push({ type: 'chemical', text: prefs.chemical_sensitivity_details || 'Chemical sensitivity' });
      if (prefs?.access_notes) alerts.push({ type: 'access', text: prefs.access_notes });
      // Only add notes if there's meaningful content after cleaning
      if (cleanedNotes) alerts.push({ type: 'note', text: cleanedNotes });
      // Show "New customer" badge ONLY if genuinely new (no completed service records)
      if (genuinelyNew) alerts.push({ type: 'new_customer', text: 'New customer — first visit' });

      const zone = s.zone || getZone(s.city, s.zip);

      return {
        id: s.id, routeOrder: s.route_order,
        customerName: `${s.first_name} ${s.last_name}`,
        customerId: s.customer_id, customerPhone: s.customer_phone,
        address: `${s.address_line1}, ${s.city}, ${s.state} ${s.zip}`,
        city: s.city,
        serviceType: normalizedType,                    // FIX #2: clean label
        serviceTypeRaw: s.service_type,                 // Keep raw for debugging
        serviceCategory: category,                      // pest, lawn, mosquito, etc.
        serviceIcon: serviceIcon(category),
        serviceCategoryColor: serviceColor(category),   // For UI color coding
        windowStart: s.window_start, windowEnd: s.window_end,
        windowDisplay: s.window_display || (s.window_start ? `${fmtTime(s.window_start)}–${fmtTime(s.window_end)}` : 'Flexible'),
        status: s.status, technicianId: s.technician_id, technicianName: s.tech_name,
        customerConfirmed: s.customer_confirmed,
        waveguardTier: s.waveguard_tier, monthlyRate: parseFloat(s.monthly_rate || 0),
        leadScore: s.lead_score, lawnType: s.lawn_type,
        propertySqft: s.property_sqft, lotSqft: s.lot_sqft,
        zone, zoneColor: ZONE_COLORS[zone] || '#94a3b8', zoneLabel: ZONE_LABELS[zone] || zone,
        estimatedDuration: s.estimated_duration_minutes || estimateDuration(normalizedType, s.property_sqft, s.lot_sqft),
        materialsNeeded: s.materials_needed ? (typeof s.materials_needed === 'string' ? JSON.parse(s.materials_needed) : s.materials_needed) : [],
        materialsLoaded: s.materials_loaded_confirmed,
        propertyAlerts: alerts,
        isNewCustomer: genuinelyNew,                    // FIX #1: computed from service_records
        lastServiceDate: safeDate(lastService?.service_date),   // FIX #3: safe date
        lastServiceType: lastService ? normalizeServiceType(lastService.service_type) : null,
        lastServiceNotes: lastService?.technician_notes?.slice(0, 200),
        checkInTime: s.check_in_time, checkOutTime: s.check_out_time,
        actualDuration: s.actual_duration_minutes,
        weatherAdvisory: s.weather_advisory,
        isRecurring: s.is_recurring,
      };
    }));

    // Group by technician
    const byTech = {};
    const unassigned = [];
    enriched.forEach(s => {
      if (!s.technicianId) { unassigned.push(s); return; }
      const key = s.technicianId;
      if (!byTech[key]) {
        byTech[key] = {
          technicianId: key, technicianName: s.technicianName,
          initials: s.technicianName?.split(' ').map(n => n[0]).join('') || '?',
          services: [], zones: {},
        };
      }
      byTech[key].services.push(s);
      byTech[key].zones[s.zone] = (byTech[key].zones[s.zone] || 0) + 1;
    });

    // Calculate tech summaries
    Object.values(byTech).forEach(tech => {
      tech.totalServices = tech.services.length;
      tech.completedServices = tech.services.filter(s => s.status === 'completed').length;
      tech.estimatedServiceMinutes = tech.services.reduce((sum, s) => sum + (s.estimatedDuration || 30), 0);
      tech.estimatedDriveMinutes = tech.services.length * 8;
      // Aggregate materials
      const materials = {};
      tech.services.forEach(s => {
        (s.materialsNeeded || []).forEach(m => {
          materials[m.product || m] = true;
        });
      });
      tech.loadList = Object.keys(materials);
    });

    const technicians = await db('technicians').select('id', 'name').where({ active: true }).orderBy('name');

    // Fetch live weather for Lakewood Ranch area
    let weather = {};
    try {
      const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=27.40&longitude=-82.40&current=temperature_2m,wind_speed_10m,precipitation_probability&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America/New_York`);
      if (weatherRes.ok) {
        const wd = await weatherRes.json();
        const current = wd.current || {};
        weather = {
          temp: Math.round(current.temperature_2m || 0),
          windSpeed: Math.round(current.wind_speed_10m || 0),
          rainProbability: current.precipitation_probability || 0,
        };
      }
    } catch { /* weather is optional */ }

    res.json({
      date, services: enriched,
      techSummary: Object.values(byTech),
      unassigned,
      technicians,
      weather,
      zoneColors: ZONE_COLORS, zoneLabels: ZONE_LABELS,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/schedule/week
router.get('/week', async (req, res, next) => {
  try {
    const startDate = req.query.start || new Date().toISOString().split('T')[0];
    const start = new Date(startDate + 'T12:00:00');
    const days = [];

    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];

      const services = await db('scheduled_services')
        .where({ scheduled_date: dateStr })
        .whereNotIn('status', ['cancelled'])
        .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
        .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
        .select('scheduled_services.id', 'scheduled_services.service_type', 'scheduled_services.status',
          'scheduled_services.window_start', 'scheduled_services.zone', 'scheduled_services.route_order',
          'customers.first_name', 'customers.last_name', 'customers.waveguard_tier',
          'technicians.name as tech_name')
        .orderByRaw('COALESCE(route_order, 999)');

      const zones = {};
      services.forEach(s => { const z = s.zone || 'unknown'; zones[z] = (zones[z] || 0) + 1; });

      days.push({
        date: dateStr,
        dayOfWeek: d.toLocaleDateString('en-US', { weekday: 'short' }),
        dayNum: d.getDate(),
        services: services.map(s => {
          const svcType = normalizeServiceType(s.service_type);
          return {
            id: s.id, customerName: `${s.first_name} ${s.last_name}`,
            serviceType: svcType,
            serviceCategory: detectServiceCategory(svcType),
            status: s.status,
            techName: s.tech_name, zone: s.zone,
            tier: s.waveguard_tier,
          };
        }),
        count: services.length,
        zones,
      });
    }

    res.json({ startDate, days });
  } catch (err) { next(err); }
});

// GET /api/admin/schedule/month — month calendar view
router.get('/month', async (req, res, next) => {
  try {
    const yearMonth = req.query.month || new Date().toISOString().slice(0, 7); // "2026-04"
    const [year, month] = yearMonth.split('-').map(Number);

    // Get first and last day of the month
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    const startDate = firstDay.toISOString().split('T')[0];
    const endDate = lastDay.toISOString().split('T')[0];

    // Extend to fill calendar grid (previous month's trailing days, next month's leading days)
    const gridStart = new Date(firstDay);
    gridStart.setDate(gridStart.getDate() - firstDay.getDay()); // Back to Sunday
    const gridEnd = new Date(lastDay);
    const remaining = 6 - lastDay.getDay();
    if (remaining < 6) gridEnd.setDate(gridEnd.getDate() + remaining); // Forward to Saturday

    // Fetch all services for the full grid range
    const services = await db('scheduled_services')
      .whereBetween('scheduled_services.scheduled_date', [
        gridStart.toISOString().split('T')[0],
        gridEnd.toISOString().split('T')[0],
      ])
      .whereNotIn('scheduled_services.status', ['cancelled'])
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select(
        'scheduled_services.id', 'scheduled_services.scheduled_date',
        'scheduled_services.service_type', 'scheduled_services.status',
        'scheduled_services.window_start', 'scheduled_services.zone',
        'scheduled_services.technician_id', 'scheduled_services.estimated_duration_minutes',
        'customers.first_name', 'customers.last_name', 'customers.waveguard_tier',
        'customers.city', 'customers.zip',
        'technicians.name as tech_name'
      )
      .orderBy('scheduled_services.scheduled_date')
      .orderByRaw('COALESCE(scheduled_services.route_order, 999)');

    // Group by date
    const byDate = {};
    services.forEach(s => {
      const d = s.scheduled_date instanceof Date
        ? s.scheduled_date.toISOString().split('T')[0]
        : String(s.scheduled_date).split('T')[0];
      if (!byDate[d]) byDate[d] = [];
      const svcType = normalizeServiceType(s.service_type);
      const category = detectServiceCategory(svcType);
      byDate[d].push({
        id: s.id,
        customerName: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
        serviceType: svcType,
        serviceCategory: category,
        status: s.status,
        techName: s.tech_name,
        technicianId: s.technician_id,
        tier: s.waveguard_tier,
        zone: s.zone || getZone(s.city, s.zip),
        windowStart: s.window_start,
        duration: s.estimated_duration_minutes || 30,
      });
    });

    // Build calendar grid (array of weeks, each week is array of 7 days)
    const weeks = [];
    let currentDate = new Date(gridStart);
    while (currentDate <= gridEnd) {
      const week = [];
      for (let i = 0; i < 7; i++) {
        const dateStr = currentDate.toISOString().split('T')[0];
        const daySvcs = byDate[dateStr] || [];

        // Count by category
        const categoryCounts = {};
        const techCounts = {};
        daySvcs.forEach(s => {
          categoryCounts[s.serviceCategory] = (categoryCounts[s.serviceCategory] || 0) + 1;
          if (s.techName) techCounts[s.techName] = (techCounts[s.techName] || 0) + 1;
        });

        week.push({
          date: dateStr,
          dayNum: currentDate.getDate(),
          isCurrentMonth: currentDate.getMonth() === month - 1,
          isToday: dateStr === new Date().toISOString().split('T')[0],
          isWeekend: currentDate.getDay() === 0 || currentDate.getDay() === 6,
          services: daySvcs,
          count: daySvcs.length,
          completed: daySvcs.filter(s => s.status === 'completed').length,
          categoryCounts,
          techCounts,
          estimatedRevenue: daySvcs.reduce((sum, s) => {
            const rev = { pest: 110, lawn: 75, mosquito: 89, termite: 200, tree_shrub: 130, rodent: 95 };
            return sum + (rev[s.serviceCategory] || 95);
          }, 0),
        });

        currentDate.setDate(currentDate.getDate() + 1);
      }
      weeks.push(week);
    }

    // Month summary stats
    const monthServices = services.filter(s => {
      const d = s.scheduled_date instanceof Date
        ? s.scheduled_date.toISOString().split('T')[0]
        : String(s.scheduled_date).split('T')[0];
      return d >= startDate && d <= endDate;
    });

    const summary = {
      totalServices: monthServices.length,
      completed: monthServices.filter(s => s.status === 'completed').length,
      pending: monthServices.filter(s => s.status === 'pending' || s.status === 'confirmed').length,
      uniqueCustomers: new Set(monthServices.map(s => `${s.first_name} ${s.last_name}`)).size,
      byCategory: {},
      byTech: {},
    };
    monthServices.forEach(s => {
      const cat = detectServiceCategory(normalizeServiceType(s.service_type));
      summary.byCategory[cat] = (summary.byCategory[cat] || 0) + 1;
      if (s.tech_name) summary.byTech[s.tech_name] = (summary.byTech[s.tech_name] || 0) + 1;
    });

    res.json({
      yearMonth,
      monthName: firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
      weeks,
      summary,
    });
  } catch (err) { next(err); }
});

// POST /api/admin/schedule — create new service
router.post('/', async (req, res, next) => {
  try {
    const { customerId, technicianId, scheduledDate, windowStart, windowEnd, serviceType, timeWindow, notes, isRecurring, recurringPattern, recurringCount, sendConfirmation } = req.body;

    if (!customerId || !scheduledDate || !serviceType) return res.status(400).json({ error: 'customerId, scheduledDate, serviceType required' });

    const customer = await db('customers').where({ id: customerId }).first();
    const zone = getZone(customer?.city, customer?.zip);
    const duration = estimateDuration(serviceType, customer?.property_sqft, customer?.lot_sqft);

    const [svc] = await db('scheduled_services').insert({
      customer_id: customerId, technician_id: technicianId || null,
      scheduled_date: scheduledDate, window_start: windowStart, window_end: windowEnd,
      service_type: serviceType, status: 'pending',
      time_window: timeWindow, zone, estimated_duration_minutes: duration,
      notes, is_recurring: isRecurring || false, recurring_pattern: recurringPattern,
    }).returning('*');

    // Create recurring instances
    if (isRecurring && recurringPattern && recurringCount > 1) {
      const intervals = { weekly: 7, biweekly: 14, monthly: 30, bimonthly: 60, quarterly: 91, triannual: 122 };
      const interval = intervals[recurringPattern] || 91;

      for (let i = 1; i < (recurringCount || 4); i++) {
        const nextDate = new Date(scheduledDate + 'T12:00:00');
        nextDate.setDate(nextDate.getDate() + interval * i);
        await db('scheduled_services').insert({
          customer_id: customerId, technician_id: technicianId,
          scheduled_date: nextDate.toISOString().split('T')[0],
          window_start: windowStart, window_end: windowEnd,
          service_type: serviceType, status: 'pending',
          time_window: timeWindow, zone, estimated_duration_minutes: duration,
          is_recurring: true, recurring_pattern: recurringPattern,
          recurring_parent_id: svc.id,
        });
      }
    }

    // Register for appointment reminders (handles confirmation SMS for admin_manual)
    try {
      const AppointmentReminders = require('../services/appointment-reminders');
      await AppointmentReminders.registerAppointment(
        svc.id, customerId,
        scheduledDate + 'T' + (windowStart || '08:00'),
        serviceType, 'admin_manual'
      );
    } catch (e) { logger.error(`Appointment reminder registration failed: ${e.message}`); }

    // Trigger appointment type automations
    try {
      const AppointmentTagger = require('../services/appointment-tagger');
      await AppointmentTagger.onServiceScheduled(svc.id);
    } catch (e) { logger.error(`Appointment tagger failed: ${e.message}`); }

    // Sync to Square Bookings
    try {
      const SquareService = require('../services/square');
      const bookingId = await SquareService.createBookingFromSchedule(
        customerId, scheduledDate, windowStart, windowEnd, serviceType
      );
      if (bookingId) {
        await db('scheduled_services').where({ id: svc.id }).update({ square_booking_id: bookingId, source: 'portal' });
      }
    } catch (e) { logger.error(`Square booking sync failed (non-blocking): ${e.message}`); }

    res.status(201).json({ id: svc.id, recurringCreated: isRecurring ? (recurringCount || 4) : 1 });
  } catch (err) { next(err); }
});

// PUT /api/admin/schedule/:id/update-details — edit service type + duration
router.put('/:id/update-details', async (req, res, next) => {
  try {
    const { serviceType, estimatedDuration } = req.body;
    const updates = {};
    if (serviceType) updates.service_type = serviceType;
    if (estimatedDuration) updates.estimated_duration_minutes = parseInt(estimatedDuration);
    if (Object.keys(updates).length) {
      await db('scheduled_services').where({ id: req.params.id }).update(updates);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PUT /api/admin/schedule/:id/assign — assign technician
router.put('/:id/assign', async (req, res, next) => {
  try {
    const { technicianId } = req.body;
    if (!technicianId) return res.status(400).json({ error: 'technicianId required' });
    await db('scheduled_services').where({ id: req.params.id }).update({ technician_id: technicianId });
    const tech = await db('technicians').where({ id: technicianId }).first();
    logger.info(`[schedule] Assigned service ${req.params.id} to ${tech?.name || technicianId}`);
    res.json({ success: true, technicianName: tech?.name });
  } catch (err) { next(err); }
});

// PUT /api/admin/schedule/:id/status — change status with automations
router.put('/:id/status', async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    const svc = await db('scheduled_services').where('scheduled_services.id', req.params.id)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.phone as cust_phone',
        'customers.city', 'technicians.name as tech_name')
      .first();

    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const updates = { status };

    if (status === 'confirmed') {
      updates.customer_confirmed = true;
    } else if (status === 'en_route') {
      // En route is optional — SMS + ETA are best-effort
      try {
        let etaMinutes = 15;
        try {
          if (svc.distance_from_previous_miles) etaMinutes = Math.round(svc.distance_from_previous_miles * 2);
          const BouncieService = require('../services/bouncie');
          if (BouncieService.configured !== false) {
            const custLat = parseFloat(svc.cust_lat || svc.lat || 0);
            const custLng = parseFloat(svc.cust_lng || svc.lng || 0);
            if (custLat && custLng) {
              const eta = await BouncieService.calculateETA(custLat, custLng);
              if (eta?.etaMinutes && eta.source !== 'default') {
                etaMinutes = eta.etaMinutes;
                logger.info(`[en-route] ETA via ${eta.source}: ${etaMinutes} min`);
              }
            }
          }
        } catch (e) { logger.warn(`[en-route] ETA calc failed: ${e.message}`); }

        if (svc.cust_phone) {
          const custFirstName = svc.first_name || 'there';
          await TwilioService.sendSMS(svc.cust_phone,
            `Hello ${custFirstName}! Your Waves technician is on the way. ETA: ~${etaMinutes} minutes.`,
            { customerId: svc.customer_id, messageType: 'en_route' }
          );
        }
      } catch (e) { logger.error(`[en-route] Failed: ${e.message}`); }

      // In-app notification: technician en route
      try {
        const NotificationService = require('../services/notification-service');
        await NotificationService.notifyCustomer(svc.customer_id, 'service', 'Technician en route', `Your Waves technician is on the way.`, { icon: '\u{1F697}' });
      } catch (e) { logger.error(`[notifications] En route notification failed: ${e.message}`); }
    } else if (status === 'on_site') {
      updates.check_in_time = db.fn.now();
    } else if (status === 'completed') {
      updates.check_out_time = db.fn.now();
      if (svc.check_in_time) {
        updates.actual_duration_minutes = Math.round((Date.now() - new Date(svc.check_in_time)) / 60000);
      }

      // Schedule a review request SMS for 2 hours after completion
      scheduleReviewRequest(svc);

      // In-app notification: service completed
      try {
        const NotificationService = require('../services/notification-service');
        await NotificationService.notifyCustomer(svc.customer_id, 'service', 'Service completed', `Your ${sanitizeServiceType(svc.service_type)} has been completed. View your report in Documents.`, { icon: '\u{1F3E0}', link: '/documents' });
      } catch (e) { logger.error(`[notifications] Service completed notification failed: ${e.message}`); }

      // --- Post-service automation chain (all fire-and-forget, non-blocking) ---

      // 1. Create compliance records
      try {
        const ComplianceService = require('../services/compliance');
        if (ComplianceService.createComplianceRecords) {
          // Find the service_record that matches this scheduled_service
          db('service_records')
            .where({ customer_id: svc.customer_id })
            .orderBy('created_at', 'desc')
            .first()
            .then(sr => {
              if (sr) {
                ComplianceService.createComplianceRecords(sr.id).catch(err =>
                  logger.error(`[post-service] Compliance records failed: ${err.message}`)
                );
              }
            })
            .catch(err => logger.error(`[post-service] Compliance lookup failed: ${err.message}`));
        }
      } catch (e) { logger.error(`[post-service] Compliance require failed: ${e.message}`); }

      // 2. Update customer health score
      try {
        const customerHealth = require('../services/customer-health');
        if (customerHealth.scoreCustomer) {
          customerHealth.scoreCustomer(svc.customer_id).catch(err =>
            logger.error(`[post-service] Health score update failed: ${err.message}`)
          );
        }
      } catch (e) { logger.error(`[post-service] Customer health require failed: ${e.message}`); }

      // 3. Close time tracking entry
      try {
        const timeTracking = require('../services/time-tracking');
        if (timeTracking.endJob && svc.technician_id) {
          timeTracking.endJob(svc.technician_id).catch(err =>
            logger.error(`[post-service] Time tracking endJob failed: ${err.message}`)
          );
        }
      } catch (e) { logger.error(`[post-service] Time tracking require failed: ${e.message}`); }

      // 4. Schedule upsell evaluation (24hr delay)
      try {
        const upsellTrigger = require('../services/workflows/upsell-trigger');
        if (upsellTrigger.checkAfterService) {
          const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
          const upsellCustomerId = svc.customer_id;
          setTimeout(() => {
            upsellTrigger.checkAfterService(upsellCustomerId).catch(err =>
              logger.error(`[post-service] Upsell evaluation failed: ${err.message}`)
            );
          }, TWENTY_FOUR_HOURS);
        }
      } catch (e) { logger.error(`[post-service] Upsell trigger require failed: ${e.message}`); }

      // 5. Check for WaveGuard conversion opportunity (2+ one-time services, no WaveGuard tier)
      try {
        const convCustomerId = svc.customer_id;
        Promise.all([
          db('customers').where({ id: convCustomerId }).first(),
          db('service_records').where({ customer_id: convCustomerId, status: 'completed' }).count('* as count').first(),
        ]).then(([customer, svcCount]) => {
          const count = parseInt(svcCount?.count || 0);
          if (customer && count >= 2 && !customer.waveguard_tier) {
            logger.info(`[post-service] WaveGuard conversion opportunity: customer ${convCustomerId} has ${count} services, no tier`);
            db('customer_interactions').insert({
              customer_id: convCustomerId,
              interaction_type: 'task',
              subject: 'WaveGuard conversion opportunity',
              body: `Customer has ${count} completed one-time services but no WaveGuard plan. Consider reaching out with a plan offer.`,
              status: 'pending',
            }).catch(err => logger.error(`[post-service] WaveGuard task creation failed: ${err.message}`));
          }
        }).catch(err => logger.error(`[post-service] WaveGuard check failed: ${err.message}`));
      } catch (e) { logger.error(`[post-service] WaveGuard check require failed: ${e.message}`); }
    }

    // Handle cancellation — notify via appointment reminders
    if (status === 'cancelled') {
      try {
        const AppointmentReminders = require('../services/appointment-reminders');
        await AppointmentReminders.handleCancellation(req.params.id);
      } catch (e) { logger.error(`Appointment cancellation handler failed: ${e.message}`); }
    }

    // Update the service — try with all fields, fall back to just status
    try {
      await db('scheduled_services').where({ id: req.params.id }).update(updates);
    } catch (updateErr) {
      logger.warn(`[schedule] Full update failed, falling back to status-only: ${updateErr.message}`);
      await db('scheduled_services').where({ id: req.params.id }).update({ status });
    }

    // Log status change — table may not exist
    try {
      await db('service_status_log').insert({
        scheduled_service_id: svc.id, status, changed_by: req.technicianId || null, notes: notes || null,
      });
    } catch (logErr) {
      logger.warn(`[schedule] Status log failed: ${logErr.message}`);
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/schedule/optimize — route optimization v3 (Google Routes API)
// Uses Google Routes API with traffic-aware optimization, falls back to nearest-neighbor.
router.post('/optimize', async (req, res, next) => {
  try {
    const RouteOptimizer = require('../services/route-optimizer');
    const { date, technicianId } = req.body;
    const dateStr = date || new Date().toISOString().split('T')[0];

    const services = await db('scheduled_services')
      .where({ scheduled_date: dateStr })
      .where(function () {
        if (technicianId) this.where({ technician_id: technicianId });
      })
      .whereNotIn('status', ['cancelled', 'completed'])
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select(
        'scheduled_services.id', 'scheduled_services.time_window',
        'scheduled_services.zone', 'scheduled_services.service_type',
        'scheduled_services.technician_id',
        'customers.lat', 'customers.lng', 'customers.city', 'customers.zip',
        db.raw("COALESCE(customers.first_name, '') || ' ' || COALESCE(customers.last_name, '') as customer_name")
      );

    if (!services.length) {
      return res.json({ success: true, order: [], totalDistanceMeters: 0, totalDurationMinutes: 0, legs: [], source: 'empty' });
    }

    // Assign zone from customer city/zip if not already set
    for (const svc of services) {
      if (!svc.zone) {
        svc.zone = getZone(svc.city, svc.zip);
      }
    }

    // Run optimization
    const result = await RouteOptimizer.optimizeRoute(services, {
      startLat: RouteOptimizer.HQ.lat,
      startLng: RouteOptimizer.HQ.lng,
      endAtStart: true,
      techId: technicianId || null,
    });

    // Update route_order on each service
    for (let i = 0; i < result.orderedStops.length; i++) {
      await db('scheduled_services')
        .where({ id: result.orderedStops[i].id })
        .update({ route_order: i + 1 });
    }

    const totalDurationMinutes = Math.round(result.totalDurationSeconds / 60);
    const savedDistanceMeters = Math.max(0, result.unoptimizedDistanceMeters - result.totalDistanceMeters);
    const savedPercent = result.unoptimizedDistanceMeters > 0
      ? Math.round((savedDistanceMeters / result.unoptimizedDistanceMeters) * 100)
      : 0;

    const response = {
      success: true,
      order: result.orderedStops.map((s, i) => ({
        id: s.id,
        routeOrder: i + 1,
        zone: s.zone,
        timeWindow: s.time_window,
        city: s.city,
        customerName: (s.customer_name || '').trim(),
      })),
      totalDistanceMeters: result.totalDistanceMeters,
      totalDurationMinutes,
      unoptimizedDistanceMeters: result.unoptimizedDistanceMeters,
      savedDistanceMeters,
      savedPercent,
      legs: result.legs,
      source: result.source,
      // Backwards-compat field
      estimatedDriveMinutes: totalDurationMinutes,
    };

    if (result.apiWarning) {
      response.apiWarning = result.apiWarning;
      if (result.apiWarning.includes('Routes API')) {
        response.hint = 'Enable "Routes API" in Google Cloud Console: https://console.cloud.google.com/apis/library/routes.googleapis.com';
      }
    }

    res.json(response);
  } catch (err) { next(err); }
});

// POST /api/admin/schedule/optimize-route — single-tech route optimization
// Optimizes only the specified technician's stops for a given date.
router.post('/optimize-route', async (req, res, next) => {
  try {
    const RouteOptimizer = require('../services/route-optimizer');
    const { technicianId, date } = req.body;

    if (!technicianId) {
      return res.status(400).json({ error: 'technicianId is required' });
    }

    const dateStr = date || new Date().toISOString().split('T')[0];

    const services = await db('scheduled_services')
      .where({ scheduled_date: dateStr, technician_id: technicianId })
      .whereNotIn('status', ['cancelled', 'completed'])
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select(
        'scheduled_services.id', 'scheduled_services.time_window',
        'scheduled_services.zone', 'scheduled_services.service_type',
        'scheduled_services.technician_id',
        'customers.lat', 'customers.lng', 'customers.city', 'customers.zip',
        db.raw("COALESCE(customers.first_name, '') || ' ' || COALESCE(customers.last_name, '') as customer_name")
      );

    if (!services.length) {
      return res.json({ success: true, order: [], totalDistanceMeters: 0, totalDurationMinutes: 0, legs: [], source: 'empty' });
    }

    // Assign zone
    for (const svc of services) {
      if (!svc.zone) {
        svc.zone = getZone(svc.city, svc.zip);
      }
    }

    const result = await RouteOptimizer.optimizeRoute(services, {
      startLat: RouteOptimizer.HQ.lat,
      startLng: RouteOptimizer.HQ.lng,
      endAtStart: true,
      techId: technicianId,
    });

    // Update route_order
    for (let i = 0; i < result.orderedStops.length; i++) {
      await db('scheduled_services')
        .where({ id: result.orderedStops[i].id })
        .update({ route_order: i + 1 });
    }

    const totalDurationMinutes = Math.round(result.totalDurationSeconds / 60);
    const savedDistanceMeters = Math.max(0, result.unoptimizedDistanceMeters - result.totalDistanceMeters);
    const savedPercent = result.unoptimizedDistanceMeters > 0
      ? Math.round((savedDistanceMeters / result.unoptimizedDistanceMeters) * 100)
      : 0;

    const response = {
      success: true,
      order: result.orderedStops.map((s, i) => ({
        id: s.id,
        routeOrder: i + 1,
        zone: s.zone,
        timeWindow: s.time_window,
        city: s.city,
        customerName: (s.customer_name || '').trim(),
      })),
      totalDistanceMeters: result.totalDistanceMeters,
      totalDurationMinutes,
      unoptimizedDistanceMeters: result.unoptimizedDistanceMeters,
      savedDistanceMeters,
      savedPercent,
      legs: result.legs,
      source: result.source,
    };

    if (result.apiWarning) {
      response.apiWarning = result.apiWarning;
      if (result.apiWarning.includes('Routes API')) {
        response.hint = 'Enable "Routes API" in Google Cloud Console: https://console.cloud.google.com/apis/library/routes.googleapis.com';
      }
    }

    res.json(response);
  } catch (err) { next(err); }
});

// GET /api/admin/schedule/zone-density
router.get('/zone-density', async (req, res, next) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const density = await db('scheduled_services')
      .where({ scheduled_date: date }).whereNotIn('status', ['cancelled'])
      .select('zone').count('* as count').groupBy('zone');
    res.json({ date, zones: Object.fromEntries(density.map(d => [d.zone, parseInt(d.count)])) });
  } catch (err) { next(err); }
});

function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function estimateDuration(serviceType, propertySqft, lotSqft) {
  const s = (serviceType || '').toLowerCase();
  if (s.includes('lawn')) return Math.round(8 + (lotSqft || 5000) / 1000 * 1.75);
  if (s.includes('pest') && s.includes('interior')) return Math.round(20 + (propertySqft || 1800) / 1000 * 5);
  if (s.includes('pest')) return Math.round(25 + (propertySqft || 1800) / 1000 * 3);
  if (s.includes('mosquito')) return Math.round(15 + (lotSqft || 5000) / 1000 * 2);
  if (s.includes('tree') || s.includes('shrub')) return Math.round(25 + (lotSqft || 5000) / 1000 * 2);
  if (s.includes('termite')) return 20;
  if (s.includes('rodent')) return 25;
  return 30;
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 3959;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// GET /api/admin/schedule/:id/wdo-brief
router.get('/:id/wdo-brief', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services').where({ id: req.params.id }).first();
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    if (!svc.pre_service_brief) return res.json({ brief: null });
    res.json({ brief: typeof svc.pre_service_brief === 'string' ? JSON.parse(svc.pre_service_brief) : svc.pre_service_brief, type: svc.pre_service_brief_type, generatedAt: svc.pre_service_brief_generated_at });
  } catch (err) { next(err); }
});

// POST /api/admin/schedule/:id/regenerate-brief
router.post('/:id/regenerate-brief', async (req, res, next) => {
  try {
    const AppointmentTagger = require('../services/appointment-tagger');
    await AppointmentTagger.onServiceScheduled(req.params.id);
    const svc = await db('scheduled_services').where({ id: req.params.id }).first();
    res.json({ success: true, brief: svc.pre_service_brief ? JSON.parse(svc.pre_service_brief) : null });
  } catch (err) { next(err); }
});

// POST /api/admin/schedule/sync-square — kept for backwards compat, redirects to sync-calendar
router.post('/sync-square', async (req, res, next) => {
  try {
    const CalendarSync = require('../services/calendar-sync');
    const days = parseInt(req.body.days) || 14;
    const result = await CalendarSync.syncAll(days);
    res.json(result);
  } catch (err) {
    logger.error(`[cal-sync] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/schedule/sync-calendar — unified sync from Square + Google Calendar
router.post('/sync-calendar', async (req, res, next) => {
  try {
    const CalendarSync = require('../services/calendar-sync');
    const days = parseInt(req.body.days) || 14;
    const result = await CalendarSync.syncAll(days);
    res.json(result);
  } catch (err) {
    logger.error(`[cal-sync] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Schedule a review request SMS 2 hours after service completion.
 * Checks: customer has sms_enabled, hasn't been asked in 30 days.
 */
function scheduleReviewRequest(svc) {
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

  setTimeout(async () => {
    try {
      const customer = await db('customers').where({ id: svc.customer_id }).first();
      if (!customer || !customer.phone) return;

      // Check SMS opt-in
      const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first();
      if (prefs && prefs.sms_enabled === false) {
        logger.info(`[review-auto] Skipping review request for ${customer.first_name} — SMS disabled`);
        return;
      }

      // Check if review already requested in last 30 days
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
      let recentRequest = null;
      try {
        recentRequest = await db('review_requests')
          .where({ customer_id: customer.id })
          .where('created_at', '>', thirtyDaysAgo)
          .first();
      } catch { /* table may not exist yet */ }

      if (recentRequest) {
        logger.info(`[review-auto] Skipping review request for ${customer.first_name} — already asked recently`);
        return;
      }

      // Create review request and send SMS
      const { WAVES_LOCATIONS } = require('../config/locations');
      const loc = WAVES_LOCATIONS.find(l => l.id === customer.nearest_location_id) || WAVES_LOCATIONS[0];
      const adminReviewRouter = require('./admin-reviews');

      const reviewReq = await adminReviewRouter.createReviewRequest({
        customerId: customer.id,
        locationId: loc.id,
        techName: svc.tech_name || null,
        serviceType: svc.service_type || 'pest control',
        serviceDate: svc.scheduled_date || null,
      });

      const PORTAL_DOMAIN = process.env.PORTAL_DOMAIN || 'portal.wavespestcontrol.com';
      const rateUrl = `https://${PORTAL_DOMAIN}/rate/${reviewReq.token}`;
      const firstName = customer.first_name || 'there';
      const svcLabel = reviewReq.service_type || 'pest control service';

      await TwilioService.sendSMS(customer.phone,
        `Hey ${firstName}! Thanks for choosing Waves 🌊 We'd love to hear how your ${svcLabel} went — it only takes 10 seconds:\n\n${rateUrl}\n\nThank you! — Waves Pest Control`,
        { customerId: customer.id, messageType: 'review_request', customerLocationId: customer.nearest_location_id }
      );

      await db('activity_log').insert({
        customer_id: customer.id, action: 'review_requested',
        description: `Auto review request sent 2h after ${svc.service_type} completion`,
      });

      logger.info(`[review-auto] Review request sent to ${customer.first_name} ${customer.last_name}`);
    } catch (err) {
      logger.error(`[review-auto] Failed to send review request: ${err.message}`);
    }
  }, TWO_HOURS_MS);
}

// GET /api/admin/schedule/vehicle-location — live GPS from Bouncie
router.get('/vehicle-location', async (req, res, next) => {
  try {
    const BouncieService = require('../services/bouncie');
    const location = await BouncieService.getLiveLocation();
    if (!location) return res.json({ available: false, message: 'No vehicle location available' });
    res.json({ available: true, ...location });
  } catch (err) {
    res.json({ available: false, error: err.message });
  }
});

// GET /api/admin/schedule/eta/:serviceId — calculate ETA to a service
router.get('/eta/:serviceId', async (req, res, next) => {
  try {
    const svc = await db('scheduled_services')
      .where('scheduled_services.id', req.params.serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select('customers.lat', 'customers.lng')
      .first();
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const BouncieService = require('../services/bouncie');
    const eta = await BouncieService.calculateETA(parseFloat(svc.lat), parseFloat(svc.lng));
    res.json(eta);
  } catch (err) {
    res.json({ etaMinutes: 15, source: 'default', error: err.message });
  }
});

// POST /api/admin/schedule/cleanup-duplicates — remove duplicate scheduled_services
router.post('/cleanup-duplicates', async (req, res, next) => {
  try {
    const dupes = await db.raw(`
      DELETE FROM scheduled_services
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (
            PARTITION BY customer_id, scheduled_date, window_start
            ORDER BY created_at ASC
          ) as rn
          FROM scheduled_services
          WHERE customer_id IS NOT NULL
        ) ranked
        WHERE rn > 1
      )
    `);
    const deleted = dupes.rowCount || 0;
    logger.info(`[cleanup] Removed ${deleted} duplicate scheduled_services`);
    res.json({ success: true, deleted });
  } catch (err) {
    logger.error(`[cleanup] Failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/schedule/fix-service-types — replace Square catalog IDs with "Service"
router.post('/fix-service-types', async (req, res, next) => {
  try {
    const result = await db.raw(`
      UPDATE scheduled_services
      SET service_type = 'Service'
      WHERE service_type ~ '^[A-Z0-9]{15,}$'
    `);
    const fixed = result.rowCount || 0;
    logger.info(`[cleanup] Fixed ${fixed} Square ID service_types`);
    res.json({ success: true, fixed });
  } catch (err) {
    logger.error(`[cleanup] fix-service-types failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/schedule/generate-report — AI tactical service report
router.post('/generate-report', async (req, res) => {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI not configured' });

    const { customerName, serviceType, technicianName, serviceDate, arrivalTime, serviceNotes, productsApplied } = req.body;
    if (!serviceNotes) return res.status(400).json({ error: 'Service notes required' });

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `Role: You are the AI communications specialist for "Waves," a premium pest control and lawn care provider.
Persona: You are a "Tactical Turf & Pest Specialist." You speak with the confidence of a scientist and the decisiveness of a military strategist.

Tone:
- Tactical & High-Energy: Use words like neutralize, fortify, deploy, suppression, perimeter, initiate, tactical strike, barrier, vector.
- Scientific Authority: NEVER use commercial brand names. ALWAYS refer to the Active Ingredient (e.g., "Imidacloprid," "Bifenthrin," "Prodiamine").
- Educational yet Gripping: Explain chemical mechanisms using "Action Metaphors" (e.g., "locking the jaw muscles," "acting like a biological trojan horse," "creating a subterranean shield").
- Natural & Fluid: Avoid robotic repetition. Do not start every sentence with "We." Flow like a human conversation.

Goal: Generate a text-only service report that sounds like a sophisticated "Mission Debrief."

INPUT DATA:
- Client Full Name: ${customerName}
- Service Type: ${serviceType}
- Technician Full Name: ${technicianName}
- Service Date: ${serviceDate}
- Arrival Time: ${arrivalTime}
- Service Notes: ${serviceNotes}
- Products Applied: ${productsApplied || 'Not specified'}

INSTRUCTIONS:

PHASE 1: THE GREETING
Randomly select one greeting style. If Service Type already contains "Service," don't repeat it. Use regular case. If multiple services, join with "&".

PHASE 2: THE TACTICAL DEBRIEF
Based on the service type, write a flowing narrative paragraph explaining the science and strategy:
- For pest control: describe colony collapse, barrier fortification, or crevice flush strategies
- For lawn care: describe deep-tissue nutrition, cellular fortification, or soil activation
- For mosquito: describe vertical suppression, lifecycle arrest, or airspace reclamation
- For rodent: describe perimeter interception, runway denial, or structural hardening
- For termite: describe subterranean barrier strategies
- For weed control: describe pre-emergent shield or systemic termination
- For tree/shrub/palm: describe vascular defense or armored pest bypass

Combine the service notes naturally. VARY sentence starters — use the treatment as the subject, not "We applied..."

PHASE 3: CLOSING (Strict Format)
Line 1: "Questions or requests? Reply to this message."
Line 2: "Thank you for choosing Waves!"

FORMATTING:
- No emojis, no bullet points
- Three sections: Greeting, Debrief/Notes, Closing
- Double line breaks between sections
- Keep under 1500 characters
- Concise and punchy`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const report = msg.content?.[0]?.text || '';
    res.json({ report });
  } catch (err) {
    logger.error(`[generate-report] AI failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
