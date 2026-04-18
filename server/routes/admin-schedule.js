const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const MODELS = require('../config/models');
const {
  normalizeServiceType, detectServiceCategory, serviceIcon, serviceColor,
  cleanSquareNotes, isNewCustomer, safeDate,
} = require('../utils/service-normalizer');
const { etDateString, etParts, addETDays } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

// Legacy wrapper — kept for backwards compat in other code paths
function sanitizeServiceType(serviceType) {
  return normalizeServiceType(serviceType);
}

// Generate the Nth recurring occurrence date given a base date + pattern config.
// Supports: daily, weekly, biweekly, monthly, bimonthly, quarterly, triannual,
// monthly_nth_weekday (needs nth 1-4 + weekday 0-6 where 0=Sun), custom (needs intervalDays).
// Returns a YYYY-MM-DD string.
function nextRecurringDate(baseDateStr, pattern, i, opts = {}) {
  const { nth, weekday, intervalDays } = opts;
  const safeBaseStr = baseDateStr ? String(baseDateStr).split('T')[0] : etDateString();
  const base = new Date(safeBaseStr + 'T12:00:00');
  if (isNaN(base.getTime())) return etDateString();
  const nthNum = (nth != null && nth !== '' && !isNaN(parseInt(nth))) ? parseInt(nth) : null;
  const wdayNum = (weekday != null && weekday !== '' && !isNaN(parseInt(weekday))) ? parseInt(weekday) : null;
  const intNum = (intervalDays != null && intervalDays !== '' && !isNaN(parseInt(intervalDays))) ? parseInt(intervalDays) : null;
  if (pattern === 'monthly_nth_weekday' && nthNum != null && wdayNum != null) {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1, 12, 0, 0);
    const firstW = d.getDay();
    const offset = (wdayNum - firstW + 7) % 7;
    d.setDate(1 + offset + (nthNum - 1) * 7);
    if (isNaN(d.getTime())) return safeBaseStr;
    return d.toISOString().split('T')[0];
  }
  const intervals = {
    daily: 1, weekly: 7, biweekly: 14, monthly: 30, bimonthly: 60,
    quarterly: 91, triannual: 122,
  };
  let gap;
  if (pattern === 'custom' && intNum) gap = Math.max(1, intNum);
  else gap = intervals[pattern] || 91;
  const d = new Date(base);
  d.setDate(d.getDate() + gap * i);
  if (isNaN(d.getTime())) return safeBaseStr;
  return d.toISOString().split('T')[0];
}

// Apply a discount to a price. Returns the discounted price (>= 0).
function applyDiscount(price, type, amount) {
  if (price == null || !type || amount == null || amount === '' || isNaN(Number(amount))) return price;
  const p = Number(price);
  const a = Number(amount);
  if (type === 'percentage') return Math.max(0, +(p * (1 - a / 100)).toFixed(2));
  if (type === 'fixed_amount') return Math.max(0, +(p - a).toFixed(2));
  return price;
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
    const date = req.query.date || etDateString();

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

      const genuinelyNew = await isNewCustomer(db, s.customer_id);

      const normalizedType = normalizeServiceType(s.service_type);
      const category = detectServiceCategory(normalizedType);

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
    const startDate = req.query.start || etDateString();
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
          'scheduled_services.window_start', 'scheduled_services.window_end',
          'scheduled_services.estimated_duration_minutes',
          'scheduled_services.technician_id',
          'scheduled_services.zone', 'scheduled_services.route_order',
          'customers.first_name', 'customers.last_name', 'customers.waveguard_tier',
          'technicians.name as tech_name')
        .orderByRaw('COALESCE(route_order, 999)');

      const zones = {};
      services.forEach(s => { const z = s.zone || 'unknown'; zones[z] = (zones[z] || 0) + 1; });

      days.push({
        date: dateStr,
        dayOfWeek: d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }),
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
            windowStart: s.window_start,
            windowEnd: s.window_end,
            estimatedDuration: s.estimated_duration_minutes,
            technicianId: s.technician_id,
            technicianName: s.tech_name,
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
    const yearMonth = req.query.month || etDateString().slice(0, 7); // "2026-04"
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
          isToday: dateStr === etDateString(),
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
      monthName: firstDay.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' }),
      weeks,
      summary,
    });
  } catch (err) { next(err); }
});

// POST /api/admin/schedule — create new service
router.post('/', async (req, res, next) => {
  try {
    const {
      customerId, technicianId, scheduledDate, windowStart, windowEnd,
      serviceType, timeWindow, notes, isRecurring, recurringPattern, recurringCount, recurringOngoing,
      recurringNth, recurringWeekday, recurringIntervalDays,
      discountType, discountAmount,
      createInvoice,
      sendConfirmation, serviceId, serviceAddons, assignmentMode,
      estimatedPrice, urgency, internalNotes, customerNotes, isCallback,
      parentServiceId, sendConfirmationSms, sendTechNotification,
    } = req.body;

    if (!customerId || !scheduledDate || !serviceType) return res.status(400).json({ error: 'customerId, scheduledDate, serviceType required' });

    const customer = await db('customers').where({ id: customerId }).first();
    const zone = getZone(customer?.city, customer?.zip);
    let duration = estimateDuration(serviceType, customer?.property_sqft, customer?.lot_sqft);

    // Look up service from services table for duration/pricing
    let serviceRecord = null;
    if (serviceId) {
      try {
        serviceRecord = await db('services').where({ id: serviceId }).first();
        if (serviceRecord?.default_duration_minutes) duration = serviceRecord.default_duration_minutes;
      } catch (e) { logger.warn(`[schedule] services table lookup failed: ${e.message}`); }
    }

    // Calculate end time from start + duration if not provided
    let computedEnd = windowEnd;
    if (windowStart && !windowEnd) {
      const [h, m] = windowStart.split(':').map(Number);
      const endMin = h * 60 + m + duration;
      computedEnd = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
    }

    // Auto-assign tech if requested
    let resolvedTechId = technicianId || null;
    if (assignmentMode === 'auto') {
      try {
        const TechMatcher = require('../services/tech-matcher');
        const match = await TechMatcher.findBestTech({ customerId, date: scheduledDate, serviceType, zone });
        if (match?.technicianId) resolvedTechId = match.technicianId;
      } catch (e) { logger.warn(`[schedule] Auto-assign failed, leaving unassigned: ${e.message}`); }
    } else if (assignmentMode === 'unassigned') {
      resolvedTechId = null;
    }

    // WaveGuard callback: free if customer has tier
    let finalPrice = estimatedPrice != null ? estimatedPrice : (serviceRecord?.base_price || null);
    if (isCallback && customer?.waveguard_tier) {
      finalPrice = 0;
    }
    // Apply recurring discount (if any)
    if (finalPrice != null && discountType && discountAmount != null && discountAmount !== '') {
      finalPrice = applyDiscount(finalPrice, discountType, discountAmount);
    }

    // Merge notes
    const combinedNotes = [notes, customerNotes].filter(Boolean).join('\n') || null;

    const insertData = {
      customer_id: customerId, technician_id: resolvedTechId,
      scheduled_date: scheduledDate, window_start: windowStart, window_end: computedEnd,
      service_type: serviceType, status: 'pending',
      time_window: timeWindow, zone, estimated_duration_minutes: duration,
      notes: combinedNotes, is_recurring: isRecurring || false, recurring_pattern: recurringPattern,
    };

    // Add new workflow columns (safe — migration may not have run yet)
    try {
      const cols = await db('scheduled_services').columnInfo();
      if (cols.service_id && serviceId) insertData.service_id = serviceId;
      if (cols.estimated_price && finalPrice != null) insertData.estimated_price = finalPrice;
      if (cols.urgency) insertData.urgency = urgency || 'routine';
      if (cols.internal_notes && internalNotes) insertData.internal_notes = internalNotes;
      if (cols.is_callback) insertData.is_callback = isCallback || false;
      if (cols.parent_service_id && parentServiceId) insertData.parent_service_id = parentServiceId;
      if (cols.recurring_ongoing && isRecurring) insertData.recurring_ongoing = !!recurringOngoing;
      if (isRecurring) {
        if (cols.recurring_nth && recurringNth != null && recurringNth !== '' && !isNaN(parseInt(recurringNth))) insertData.recurring_nth = parseInt(recurringNth);
        if (cols.recurring_weekday && recurringWeekday != null && recurringWeekday !== '' && !isNaN(parseInt(recurringWeekday))) insertData.recurring_weekday = parseInt(recurringWeekday);
        if (cols.recurring_interval_days && recurringIntervalDays != null && recurringIntervalDays !== '' && !isNaN(parseInt(recurringIntervalDays))) insertData.recurring_interval_days = parseInt(recurringIntervalDays);
      }
      if (cols.discount_type && discountType) insertData.discount_type = discountType;
      if (cols.discount_amount && discountAmount != null && discountAmount !== '') insertData.discount_amount = Number(discountAmount);
      if (cols.create_invoice_on_complete) insertData.create_invoice_on_complete = !!createInvoice;
    } catch (e) { logger.warn(`[schedule] Column check failed (non-blocking): ${e.message}`); }

    const [svc] = await db('scheduled_services').insert(insertData).returning('*');

    // Create addon entries
    if (serviceAddons && serviceAddons.length > 0) {
      try {
        for (const addon of serviceAddons) {
          await db('scheduled_service_addons').insert({
            scheduled_service_id: svc.id,
            service_id: addon.serviceId || null,
            service_name: addon.name || addon.serviceName,
            estimated_price: addon.price || null,
          });
        }
      } catch (e) { logger.warn(`[schedule] Addon insert failed (non-blocking): ${e.message}`); }
    }

    // Create recurring instances (Ongoing mode still pre-seeds a 4-visit rolling window for UX)
    const plannedCount = isRecurring ? (recurringOngoing ? 4 : (recurringCount || 4)) : 0;
    if (isRecurring && recurringPattern && plannedCount > 1) {
     try {
      const cols = await db('scheduled_services').columnInfo();
      const rOpts = { nth: recurringNth, weekday: recurringWeekday, intervalDays: recurringIntervalDays };
      for (let i = 1; i < plannedCount; i++) {
        const nextDateStr = nextRecurringDate(scheduledDate, recurringPattern, i, rOpts);
        const childData = {
          customer_id: customerId, technician_id: resolvedTechId,
          scheduled_date: nextDateStr,
          window_start: windowStart, window_end: computedEnd,
          service_type: serviceType, status: 'pending',
          time_window: timeWindow, zone, estimated_duration_minutes: duration,
          is_recurring: true, recurring_pattern: recurringPattern,
          recurring_parent_id: svc.id,
        };
        if (cols.recurring_ongoing) childData.recurring_ongoing = !!recurringOngoing;
        if (cols.recurring_nth && recurringNth != null && recurringNth !== '' && !isNaN(parseInt(recurringNth))) childData.recurring_nth = parseInt(recurringNth);
        if (cols.recurring_weekday && recurringWeekday != null && recurringWeekday !== '' && !isNaN(parseInt(recurringWeekday))) childData.recurring_weekday = parseInt(recurringWeekday);
        if (cols.recurring_interval_days && recurringIntervalDays != null && recurringIntervalDays !== '' && !isNaN(parseInt(recurringIntervalDays))) childData.recurring_interval_days = parseInt(recurringIntervalDays);
        if (cols.estimated_price && finalPrice != null) childData.estimated_price = finalPrice;
        if (cols.discount_type && discountType) childData.discount_type = discountType;
        if (cols.discount_amount && discountAmount != null && discountAmount !== '') childData.discount_amount = Number(discountAmount);
        if (cols.create_invoice_on_complete) childData.create_invoice_on_complete = !!createInvoice;
        await db('scheduled_services').insert(childData);
      }
     } catch (e) { logger.error(`[schedule] Recurring spawn failed (non-blocking): ${e.message}`); }
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

    res.status(201).json({ id: svc.id, recurringCreated: isRecurring ? (recurringCount || 4) : 1 });
  } catch (err) { next(err); }
});

// PUT /api/admin/schedule/:id/update-details — edit service fields
router.put('/:id/update-details', async (req, res, next) => {
  try {
    const {
      serviceType, estimatedDuration, scheduledDate,
      windowStart, windowEnd, technicianId, notes, routeOrder, zone,
      isRecurring, recurringPattern, recurringCount, recurringOngoing,
      recurringNth, recurringWeekday, recurringIntervalDays,
      discountType, discountAmount, estimatedPrice,
      createInvoice,
    } = req.body;
    const updates = {};
    if (serviceType !== undefined) updates.service_type = serviceType;
    if (estimatedDuration !== undefined && estimatedDuration !== '') updates.estimated_duration_minutes = parseInt(estimatedDuration);
    if (scheduledDate !== undefined && scheduledDate !== '') updates.scheduled_date = scheduledDate;
    if (windowStart !== undefined) updates.window_start = windowStart || null;
    if (windowEnd !== undefined) updates.window_end = windowEnd || null;
    if (technicianId !== undefined) updates.technician_id = technicianId || null;
    if (notes !== undefined) updates.notes = notes;
    if (routeOrder !== undefined && routeOrder !== '') updates.route_order = parseInt(routeOrder);
    if (zone !== undefined) updates.zone = zone;
    if (isRecurring) {
      updates.is_recurring = true;
      if (recurringPattern) updates.recurring_pattern = recurringPattern;
      try {
        const cols = await db('scheduled_services').columnInfo();
        if (cols.recurring_ongoing) updates.recurring_ongoing = !!recurringOngoing;
        if (cols.recurring_nth) updates.recurring_nth = (recurringNth != null && recurringNth !== '' && !isNaN(parseInt(recurringNth))) ? parseInt(recurringNth) : null;
        if (cols.recurring_weekday) updates.recurring_weekday = (recurringWeekday != null && recurringWeekday !== '' && !isNaN(parseInt(recurringWeekday))) ? parseInt(recurringWeekday) : null;
        if (cols.recurring_interval_days) updates.recurring_interval_days = (recurringIntervalDays != null && recurringIntervalDays !== '' && !isNaN(parseInt(recurringIntervalDays))) ? parseInt(recurringIntervalDays) : null;
        if (cols.discount_type) updates.discount_type = discountType || null;
        if (cols.discount_amount) updates.discount_amount = (discountAmount != null && discountAmount !== '') ? Number(discountAmount) : null;
        if (cols.create_invoice_on_complete && createInvoice !== undefined) updates.create_invoice_on_complete = !!createInvoice;
      } catch {}
    }
    if (!isRecurring && createInvoice !== undefined) {
      try {
        const cols = await db('scheduled_services').columnInfo();
        if (cols.create_invoice_on_complete) updates.create_invoice_on_complete = !!createInvoice;
      } catch {}
    }
    // Price + discount (apply discount to the final stored price used at invoicing)
    if (estimatedPrice !== undefined && estimatedPrice !== '' && !isNaN(Number(estimatedPrice))) {
      try {
        const cols = await db('scheduled_services').columnInfo();
        let finalPrice = Number(estimatedPrice);
        if (discountType && discountAmount != null && discountAmount !== '') {
          finalPrice = applyDiscount(finalPrice, discountType, discountAmount);
        }
        if (cols.estimated_price) updates.estimated_price = finalPrice;
        if (cols.discount_type) updates.discount_type = discountType || null;
        if (cols.discount_amount) updates.discount_amount = (discountAmount != null && discountAmount !== '') ? Number(discountAmount) : null;
      } catch {}
    } else if (!isRecurring && (discountType !== undefined || discountAmount !== undefined)) {
      try {
        const cols = await db('scheduled_services').columnInfo();
        if (cols.discount_type) updates.discount_type = discountType || null;
        if (cols.discount_amount) updates.discount_amount = (discountAmount != null && discountAmount !== '') ? Number(discountAmount) : null;
      } catch {}
    }
    if (Object.keys(updates).length) {
      await db('scheduled_services').where({ id: req.params.id }).update(updates);
    }

    // Spawn recurring children if requested (Ongoing seeds 4; Fixed uses recurringCount)
    let recurringCreated = 0;
    const spawnCount = isRecurring ? (recurringOngoing ? 4 : (recurringCount || 0)) : 0;
    if (isRecurring && recurringPattern && spawnCount > 1) {
      const parent = await db('scheduled_services').where({ id: req.params.id }).first();
      if (parent) {
        const baseDateStr = parent.scheduled_date
          ? String(parent.scheduled_date).split('T')[0]
          : etDateString();
        const rOpts = {
          nth: recurringNth != null ? recurringNth : parent.recurring_nth,
          weekday: recurringWeekday != null ? recurringWeekday : parent.recurring_weekday,
          intervalDays: recurringIntervalDays != null ? recurringIntervalDays : parent.recurring_interval_days,
        };
        for (let i = 1; i < spawnCount; i++) {
          const nextDateStr = nextRecurringDate(baseDateStr, recurringPattern, i, rOpts);
          const childData = {
            customer_id: parent.customer_id,
            technician_id: parent.technician_id,
            scheduled_date: nextDateStr,
            window_start: parent.window_start,
            window_end: parent.window_end,
            service_type: parent.service_type,
            status: 'pending',
            time_window: parent.time_window,
            zone: parent.zone,
            estimated_duration_minutes: parent.estimated_duration_minutes,
            is_recurring: true,
            recurring_pattern: recurringPattern,
          };
          try {
            const cols = await db('scheduled_services').columnInfo();
            if (cols.recurring_parent_id) childData.recurring_parent_id = parent.id;
            if (cols.service_id && parent.service_id) childData.service_id = parent.service_id;
            if (cols.recurring_ongoing) childData.recurring_ongoing = !!recurringOngoing;
            if (cols.recurring_nth) childData.recurring_nth = (rOpts.nth != null && rOpts.nth !== '' && !isNaN(parseInt(rOpts.nth))) ? parseInt(rOpts.nth) : null;
            if (cols.recurring_weekday) childData.recurring_weekday = (rOpts.weekday != null && rOpts.weekday !== '' && !isNaN(parseInt(rOpts.weekday))) ? parseInt(rOpts.weekday) : null;
            if (cols.recurring_interval_days) childData.recurring_interval_days = (rOpts.intervalDays != null && rOpts.intervalDays !== '' && !isNaN(parseInt(rOpts.intervalDays))) ? parseInt(rOpts.intervalDays) : null;
            const dType = discountType !== undefined ? discountType : parent.discount_type;
            const dAmt = discountAmount !== undefined ? discountAmount : parent.discount_amount;
            // parent.estimated_price is already discounted at save time — copy as-is to children
            if (cols.estimated_price && parent.estimated_price != null) childData.estimated_price = parent.estimated_price;
            if (cols.discount_type && dType) childData.discount_type = dType;
            if (cols.discount_amount && dAmt != null && dAmt !== '') childData.discount_amount = Number(dAmt);
            const inv = createInvoice !== undefined ? !!createInvoice : !!parent.create_invoice_on_complete;
            if (cols.create_invoice_on_complete) childData.create_invoice_on_complete = inv;
          } catch { /* non-blocking */ }
          await db('scheduled_services').insert(childData);
          recurringCreated++;
        }
      }
    }

    res.json({ success: true, recurringCreated });
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
          let body = null;
          try {
            const tpl = require('./admin-sms-templates');
            body = await tpl.getTemplate('tech_en_route', {
              first_name: custFirstName, eta_minutes: String(etaMinutes),
            });
          } catch { /* fall through */ }
          if (!body) {
            body = `Hello ${custFirstName}! Your Waves technician is on the way. ETA: ~${etaMinutes} minutes.`;
          }
          await TwilioService.sendSMS(svc.cust_phone, body,
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

      // 4b. Recurring plan: auto-extend (Ongoing) or flag end-of-plan (Fixed)
      try {
        const parentId = svc.recurring_parent_id || svc.id;
        const cols = await db('scheduled_services').columnInfo();
        const parent = await db('scheduled_services').where({ id: parentId }).first();
        if (parent && parent.is_recurring && parent.recurring_pattern) {
          const pendingCount = parseInt((await db('scheduled_services')
            .where(function () { this.where('recurring_parent_id', parentId).orWhere('id', parentId); })
            .where('status', 'pending')
            .count('* as c').first())?.c || 0);

          const isOngoing = cols.recurring_ongoing ? !!parent.recurring_ongoing : false;

          if (isOngoing && pendingCount < 2) {
            // Find latest visit (pending or completed) to calculate next date
            const latest = await db('scheduled_services')
              .where(function () { this.where('recurring_parent_id', parentId).orWhere('id', parentId); })
              .orderBy('scheduled_date', 'desc').first();
            if (latest) {
              const latestStr = String(latest.scheduled_date).split('T')[0];
              const rOpts = { nth: parent.recurring_nth, weekday: parent.recurring_weekday, intervalDays: parent.recurring_interval_days };
              const nextStr = nextRecurringDate(latestStr, parent.recurring_pattern, 1, rOpts);
              const nextData = {
                customer_id: parent.customer_id,
                technician_id: parent.technician_id,
                scheduled_date: nextStr,
                window_start: parent.window_start, window_end: parent.window_end,
                service_type: parent.service_type, status: 'pending',
                time_window: parent.time_window, zone: parent.zone,
                estimated_duration_minutes: parent.estimated_duration_minutes,
                is_recurring: true, recurring_pattern: parent.recurring_pattern,
                recurring_parent_id: parentId,
              };
              if (cols.recurring_ongoing) nextData.recurring_ongoing = true;
              if (cols.service_id && parent.service_id) nextData.service_id = parent.service_id;
              if (cols.estimated_price && parent.estimated_price != null) nextData.estimated_price = parent.estimated_price;
              await db('scheduled_services').insert(nextData);
              logger.info(`[recurring] Auto-extended ongoing plan parent=${parentId} → ${nextData.scheduled_date}`);
            }
          } else if (!isOngoing && pendingCount === 0) {
            // Fixed plan just finished — queue an alert if table exists and not already open
            try {
              const existing = await db('recurring_plan_alerts')
                .where({ recurring_parent_id: parentId }).whereNull('resolved_at').first();
              if (!existing) {
                await db('recurring_plan_alerts').insert({
                  recurring_parent_id: parentId,
                  customer_id: parent.customer_id,
                  alert_type: 'plan_ending',
                  last_visit_date: String(svc.scheduled_date).split('T')[0],
                  recurring_pattern: parent.recurring_pattern,
                  remaining_visits: 0,
                });
                logger.info(`[recurring] Flagged end-of-plan alert for parent=${parentId}`);
              }
            } catch (e) { logger.warn(`[recurring] Alert insert skipped: ${e.message}`); }
          }
        }
      } catch (e) { logger.error(`[recurring] Auto-extend/flag failed: ${e.message}`); }

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
    const dateStr = date || etDateString();

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

    const dateStr = date || etDateString();

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
    const date = req.query.date || etDateString();
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

// POST /api/admin/schedule/sync-calendar — unified sync from Google Calendar
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
 * Queue a review request to send 2 hours after service completion.
 *
 * Persists to review_requests with scheduled_for = now + 120min. A cron in
 * scheduler.js (every 15 min) picks it up and sends via ReviewService.sendSMS,
 * so the request survives Railway restarts/deploys.
 *
 * Checks: customer has sms_enabled, hasn't been asked in 30 days.
 */
async function scheduleReviewRequest(svc) {
  try {
    const customer = await db('customers').where({ id: svc.customer_id }).first();
    if (!customer || !customer.phone) return;

    const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first();
    if (prefs && prefs.sms_enabled === false) {
      logger.info(`[review-auto] Skipping review request for ${customer.first_name} — SMS disabled`);
      return;
    }

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

    // Look up the matching service_record so ReviewService can dedup + attach tech/service metadata.
    let serviceRecordId = null;
    try {
      const sr = await db('service_records')
        .where({ customer_id: customer.id })
        .orderBy('created_at', 'desc')
        .first();
      if (sr) serviceRecordId = sr.id;
    } catch { /* service_records lookup is best-effort */ }

    const ReviewService = require('../services/review-request');
    await ReviewService.create({
      customerId: customer.id,
      serviceRecordId,
      triggeredBy: 'auto',
      delayMinutes: 120,
    });

    logger.info(`[review-auto] Review request queued for ${customer.first_name} ${customer.last_name} (sends in 2h)`);
  } catch (err) {
    logger.error(`[review-auto] Failed to queue review request: ${err.message}`);
  }
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

// POST /api/admin/schedule/fix-service-types — replace legacy catalog IDs with "Service"
router.post('/fix-service-types', async (req, res, next) => {
  try {
    const result = await db.raw(`
      UPDATE scheduled_services
      SET service_type = 'Service'
      WHERE service_type ~ '^[A-Z0-9]{15,}$'
    `);
    const fixed = result.rowCount || 0;
    logger.info(`[cleanup] Fixed ${fixed} legacy ID service_types`);
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

    const prompt = `# SERVICE REPORT COPY — SYSTEM PROMPT v2

## CONTEXT

This prompt generates copy for two sections of a branded, customer-facing service report PDF for **Waves Pest Control & Lawn Care** — a premium home services provider in Southwest Florida. The sections appear inside a formal document alongside customer info, property details, product tables, and safety guidance.

The two sections are:

- **WHAT WE DID** — a treatment summary
- **WHAT WE FOUND** — a follow-up setting expectations

## HARD CONSTRAINTS (READ FIRST — THESE OVERRIDE EVERYTHING ELSE)

1. **No military language.** Do not use: mission, tactical, deployment, fortification, fortress, sentries, invaders, infiltration, neutralize, annihilation, defensive perimeter, chemical barrier, vectors, sweep, recon, staging, advancement, threat, lockdown, intercept (as military metaphor). If a sentence sounds like it belongs in a war briefing, rewrite it.

2. **No overpromising.** Never claim: elimination, eradication, impenetrable, guaranteed, 100%, total protection, pest-free, foolproof. Use language like: reduce activity, manage pressure, support long-term control, limit conducive conditions.

3. **No invented observations.** Only reference conditions, pest types, or findings that appear in the service notes. If notes say "general pest control" with no specifics, write generally. Do not fabricate sightings.

4. **No brand names for products.** Use active ingredient names (fipronil, bifenthrin, imidacloprid, prodiamine, etc.) or functional descriptions (non-repellent residual, insect growth regulator, pre-emergent herbicide, systemic drench). If the active ingredient is not provided in the inputs, use the functional description only.

5. **Plain text only.** No markdown, no bold, no emojis, no bullet points, no headers in the output body. Just paragraphs under the two section titles.

6. **Length.** Each section should be 2–4 sentences. Together, both sections should total roughly 80–140 words. This is a report block, not an essay.

## VOICE

Write like a **knowledgeable field technician writing a professional summary** — someone who understands the science but communicates plainly.

The tone is:
- Calm and precise
- Technically informed but readable
- Confident without bragging
- Clean, modern, premium

Think: a well-written inspection report from a specialist you trust.
Do not think: action movie, military briefing, advertising copy, or dramatic monologue.

### Sentence-Level Rules

- Vary sentence openings. Do not start more than one sentence with "We."
- Blend what was done with why it matters in the same sentence when possible.
- One vivid phrase per section maximum. The rest should be clean and direct.
- Avoid repeating the same word more than once across both sections (especially: barrier, perimeter, treatment, applied, control).

## STRUCTURE

### WHAT WE DID

Write a concise treatment summary (2–3 sentences) that:
- States the service objective in one line
- Describes the method and treated areas in plain technical terms
- References specific products/active ingredients if provided in inputs
- Sounds custom-written for this visit, not templated

### WHAT WE FOUND

Write a short expectations paragraph (2–3 sentences) that:
- Explains the practical outcome of the treatment
- Sets realistic expectations for the coming days/weeks
- Reinforces the value without overpromising
- Connects to the next service or ongoing plan when applicable

## SERVICE TYPE GUIDANCE

Use these focal points based on the service type. Do not force all of them in — pick what's relevant to the actual service notes.

- General Pest Control: Exterior perimeter treatment, crack-and-crevice targeting, harborage reduction, residual control, cobweb removal
- Ant Control: Colony-level suppression, non-repellent transfer effect, bait placement, reproductive disruption
- Rodent / Wildlife: Interception, exclusion, activity monitoring, transit routes, structural entry points
- Mosquito: Foliage treatment, resting site targeting, breeding source reduction, adult population knockdown
- Lawn Fertilization: Root-zone nutrition, plant vigor, stress tolerance, seasonal nutrient timing
- Weed Control: Pre-emergent barrier, post-emergent herbicide, root uptake, turf selectivity
- Fungicide / Disease: Pathogen suppression, systemic movement, tissue protection, disease cycle interruption
- Lawn Insects: Subsurface control, lifecycle interruption, turf recovery, pressure reduction
- Tree & Shrub / Ornamentals: Systemic uptake, vascular distribution, feeding disruption, canopy protection
- Termite: Treated zones, soil barrier, concealment inspection, structural risk
- Bed Bug: Harborage targeting, crack-and-crevice treatment, concealment areas, follow-up timing

## EXAMPLES

### Good Output (General Pest Control with Fipronil)

WHAT WE DID

Today's service focused on exterior perimeter management and entry-point treatment around the home's foundation. A fipronil-based residual was applied along structural transitions, door frames, and common harborage areas. Cobwebs were cleared from eaves and overhangs to reduce established pest activity and improve visibility along the foundation line.

WHAT WE FOUND

The exterior treatment zone is now positioned to intercept crawling pest activity at the most common access points. Some minor activity may continue over the next 7–14 days as the product reaches full efficacy. Ongoing quarterly service will help maintain consistent coverage and catch seasonal shifts early.

### Good Output (Lawn Fertilization)

WHAT WE DID

A granular fertilizer application was made across approximately 6,200 square feet of St. Augustine turf, targeting root-zone nutrition heading into the active growth season. The blend was selected to support sustained green-up and improve the lawn's ability to handle heat stress and foot traffic through summer.

WHAT WE FOUND

Visible response should begin within 10–14 days as the turf takes up nutrients through the root system. Consistent irrigation will help the product move into the soil profile where it's most effective. This application sets the foundation for the next round of the seasonal program.

### Bad Output (Do Not Write Like This)

WHAT WE DID

MISSION DEBRIEF — Tactical suppression deployment completed. Perimeter fortification has been established using a precision-applied chemical barrier that targets sodium channel disruption in arthropod nervous systems. This creates an impenetrable defensive perimeter around your structure's foundation and entry points.

WHAT WE FOUND

Your property's structural perimeter now maintains active chemical sentries that will intercept and neutralize incoming pest vectors for the next 90 days, creating a fortress-like barrier against seasonal arthropod advancement.

Why this is bad: military cosplay, overpromises "impenetrable" and "90 days" of guaranteed protection, sounds like ad copy, uses "fortification/fortress/sentries/vectors/advancement" in violation of constraint #1.

## INPUTS

Client Full Name: ${customerName}
Service Type: ${serviceType}
Technician Full Name: ${technicianName || 'Not specified'}
Service Date: ${serviceDate}
Arrival Time: ${arrivalTime || 'Not specified'}
Service Notes: ${serviceNotes}
Products Applied / Active Ingredients: ${productsApplied || 'Not specified'}

## OUTPUT FORMAT

Output exactly this structure, plain text, no markdown formatting:

WHAT WE DID

[2-3 sentences]

WHAT WE FOUND

[2-3 sentences]

Do not include the client name as a header. Do not add greetings, sign-offs, or any text outside these two sections.`;

    const msg = await anthropic.messages.create({
      model: MODELS.FLAGSHIP,
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

// GET /api/admin/schedule/services-dropdown — service list for appointment modal
router.get('/services-dropdown', async (req, res, next) => {
  try {
    let groups = [];
    try {
      const services = await db('services').where({ is_active: true }).orderBy('sort_order');
      if (services.length > 0) {
        const byCategory = {};
        for (const s of services) {
          const cat = s.category || 'other';
          if (!byCategory[cat]) byCategory[cat] = { category: cat, items: [] };
          byCategory[cat].items.push({
            id: s.id, name: s.name, duration: s.default_duration_minutes,
            priceMin: parseFloat(s.price_range_min || s.base_price || 0),
            priceMax: parseFloat(s.price_range_max || s.base_price || 0),
            base_price: parseFloat(s.base_price || 0),
            default_duration_minutes: s.default_duration_minutes,
          });
        }
        groups = Object.values(byCategory);
      }
    } catch (e) { logger.warn(`[services-dropdown] services table query failed: ${e.message}`); }

    // Fallback to full service library (42 services, all default 1hr / $0 except noted)
    if (groups.length === 0) {
      const S = (name, dur = 60) => ({ name, duration: dur, priceMin: 0, priceMax: 0 });
      groups = [
        { category: 'pest_control', items: [
          // One-Time
          S('Pest Control Service'),
          S('Mite Control Service'),
          S('Mold Remediation Service'),
          S('Mosquito Control Service'),
          S('Mud Dauber Nest Removal Service'),
          S('Tick Control Service'),
          S('Yellow Jacket Control Service'),
          S('Wasp Control Service'),
          S('Wildlife Trapping Service'),
          // Recurring
          S('Semiannual Pest Control Service'),
          S('Quarterly Pest Control Service'),
          S('Bi-Monthly Pest Control Service'),
          S('Monthly Pest Control Service'),
        ]},
        { category: 'rodent', items: [
          // One-Time
          S('Rodent Control Service'),
          S('Rodent Trapping Service'),
          S('Rodent Exclusion Service'),
          S('Rodent Trapping & Exclusion Service'),
          S('Rodent Trapping & Sanitation Service'),
          S('Rodent Trapping, Exclusion & Sanitation Service'),
          S('Rodent Pest Control'),
          // Recurring
          S('Rodent Bait Station Service'),
        ]},
        { category: 'termite', items: [
          // Recurring - Bonds
          { name: 'Termite Bond (Billed Quarterly | 10-Year Term)', duration: 60, priceMin: 45, priceMax: 45 },
          { name: 'Termite Bond (Billed Quarterly | 5-Year Term)', duration: 60, priceMin: 54, priceMax: 54 },
          { name: 'Termite Bond (Billed Quarterly | 1-Year Term)', duration: 60, priceMin: 60, priceMax: 60 },
          // Recurring - Monitoring
          { name: 'Termite Monitoring Service', duration: 60, priceMin: 99, priceMax: 99 },
          { name: 'Termite Active Annual Bait Station Service', duration: 60, priceMin: 199, priceMax: 199 },
          S('Termite Active Bait Station Service'),
          S('Termite Installation Setup'),
          // One-Time
          S('Termite Spot Treatment Service'),
          S('Termite Pretreatment Service'),
          S('Termite Trenching Service'),
          { name: 'Termite Bait Station Cartridge Replacement', duration: 60, priceMin: 20, priceMax: 20 },
          S('Slab Pre-Treat Termite'),
        ]},
        { category: 'lawn_care', items: [
          S('Lawn Care Service'),
          S('Lawn Fertilization Service'),
          S('Lawn Fungicide Treatment Service'),
          S('Lawn Insect Control Service'),
          S('Lawn Aeration Service'),
        ]},
        { category: 'tree_shrub', items: [
          S('Every 6 Weeks Tree & Shrub Care Service'),
          S('Bi-Monthly Tree & Shrub Care Service'),
        ]},
        { category: 'specialty', items: [
          S('WaveGuard Membership', 0),
          S('WaveGuard Initial Setup'),
          S('Waves Pest Control Appointment'),
        ]},
      ];
    }

    res.json({ groups });
  } catch (err) { next(err); }
});

// GET /api/admin/schedule/recommend-slots — smart slot recommendations
router.get('/recommend-slots', async (req, res, next) => {
  try {
    const { customerId, serviceType, date, serviceId } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });

    // Try CSR booker first
    try {
      const CSRBooker = require('../services/csr-booker');
      if (CSRBooker.recommendSlots) {
        const result = await CSRBooker.recommendSlots({ customerId, serviceType, date, serviceId });
        if (result?.slots?.length) return res.json(result);
      }
    } catch (e) { logger.warn(`[recommend-slots] CSR booker unavailable: ${e.message}`); }

    // Basic slot finder: check existing services on that date
    const existing = await db('scheduled_services')
      .where({ scheduled_date: date })
      .whereNotIn('status', ['cancelled'])
      .select('window_start', 'window_end', 'estimated_duration_minutes');

    const busySlots = existing.map(s => {
      const start = s.window_start || '08:00';
      const [sh, sm] = start.split(':').map(Number);
      const dur = s.estimated_duration_minutes || 60;
      return { startMin: sh * 60 + sm, endMin: sh * 60 + sm + dur };
    });

    // Find open 30-min windows between 7 AM (420) and 5 PM (1020)
    const candidates = [];
    for (let min = 420; min <= 1020; min += 30) {
      const conflicts = busySlots.filter(b => min < b.endMin && min + 30 > b.startMin).length;
      candidates.push({ min, conflicts });
    }

    // Sort by fewest conflicts, pick top 3, spread across morning/midday/afternoon
    candidates.sort((a, b) => a.conflicts - b.conflicts);
    const morning = candidates.find(c => c.min >= 420 && c.min < 660);
    const midday = candidates.find(c => c.min >= 660 && c.min < 840);
    const afternoon = candidates.find(c => c.min >= 840 && c.min <= 1020);

    const picks = [morning, midday, afternoon].filter(Boolean).slice(0, 3);
    if (picks.length === 0) picks.push(...candidates.slice(0, 3));

    const slots = picks.map(p => {
      const h = Math.floor(p.min / 60);
      const m = p.min % 60;
      const start = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const label = p.conflicts === 0 ? 'Open' : `${p.conflicts} overlap${p.conflicts > 1 ? 's' : ''}`;
      const period = h < 11 ? 'Morning' : h < 14 ? 'Midday' : 'Afternoon';
      return { start, conflicts: p.conflicts, label: `${period} — ${label}` };
    });

    res.json({ slots });
  } catch (err) { next(err); }
});

// GET /api/admin/schedule/recurring-alerts — end-of-plan alerts + upcoming fixed plans ending soon
router.get('/recurring-alerts', async (req, res, next) => {
  try {
    const alerts = [];

    // 1. Open alerts in the queue
    try {
      const open = await db('recurring_plan_alerts as a')
        .leftJoin('customers as c', 'a.customer_id', 'c.id')
        .leftJoin('scheduled_services as s', 'a.recurring_parent_id', 's.id')
        .whereNull('a.resolved_at')
        .select(
          'a.id', 'a.recurring_parent_id', 'a.customer_id', 'a.alert_type',
          'a.last_visit_date', 'a.recurring_pattern', 'a.remaining_visits', 'a.created_at',
          'c.first_name', 'c.last_name', 'c.phone', 'c.email',
          's.service_type',
        )
        .orderBy('a.created_at', 'desc');
      alerts.push(...open.map(a => ({
        id: a.id,
        source: 'queue',
        parentId: a.recurring_parent_id,
        customerId: a.customer_id,
        customerName: `${a.first_name || ''} ${a.last_name || ''}`.trim(),
        phone: a.phone, email: a.email,
        serviceType: a.service_type,
        alertType: a.alert_type,
        lastVisitDate: a.last_visit_date,
        pattern: a.recurring_pattern,
        remainingVisits: a.remaining_visits,
        createdAt: a.created_at,
      })));
    } catch (e) { logger.warn(`[recurring-alerts] queue read failed: ${e.message}`); }

    // 2. Derived: fixed plans with ≤1 pending visit in next 14 days (pre-emptive)
    try {
      const cols = await db('scheduled_services').columnInfo();
      if (cols.recurring_ongoing) {
        const today = etDateString();
        const soonStr = etDateString(addETDays(new Date(), 14));
        const ending = await db('scheduled_services as s')
          .leftJoin('customers as c', 's.customer_id', 'c.id')
          .where('s.is_recurring', true)
          .where(function () { this.where('s.recurring_ongoing', false).orWhereNull('s.recurring_ongoing'); })
          .whereNull('s.recurring_parent_id')
          .select(
            's.id', 's.customer_id', 's.service_type', 's.recurring_pattern', 's.scheduled_date',
            'c.first_name', 'c.last_name', 'c.phone', 'c.email',
          );

        for (const plan of ending) {
          const pending = await db('scheduled_services')
            .where(function () { this.where('recurring_parent_id', plan.id).orWhere('id', plan.id); })
            .where('status', 'pending')
            .where('scheduled_date', '>=', today)
            .orderBy('scheduled_date', 'desc').limit(1);
          const latestPending = pending[0];
          if (!latestPending) continue;
          if (latestPending.scheduled_date && String(latestPending.scheduled_date).split('T')[0] > soonStr) continue;

          const pendingCount = parseInt((await db('scheduled_services')
            .where(function () { this.where('recurring_parent_id', plan.id).orWhere('id', plan.id); })
            .where('status', 'pending')
            .count('* as c').first())?.c || 0);
          if (pendingCount > 1) continue;

          // Skip if already queued
          const q = await db('recurring_plan_alerts')
            .where({ recurring_parent_id: plan.id }).whereNull('resolved_at').first();
          if (q) continue;

          alerts.push({
            id: `derived-${plan.id}`,
            source: 'derived',
            parentId: plan.id,
            customerId: plan.customer_id,
            customerName: `${plan.first_name || ''} ${plan.last_name || ''}`.trim(),
            phone: plan.phone, email: plan.email,
            serviceType: plan.service_type,
            alertType: 'plan_ending_soon',
            lastVisitDate: String(latestPending.scheduled_date).split('T')[0],
            pattern: plan.recurring_pattern,
            remainingVisits: pendingCount,
            createdAt: null,
          });
        }
      }
    } catch (e) { logger.warn(`[recurring-alerts] derived scan failed: ${e.message}`); }

    res.json({ alerts, total: alerts.length });
  } catch (err) { next(err); }
});

// POST /api/admin/schedule/recurring-alerts/:id/action
// body: { action: 'extend' | 'convert_ongoing' | 'let_lapse', count?: number }
router.post('/recurring-alerts/:id/action', async (req, res, next) => {
  try {
    const { action, count } = req.body;
    const idParam = String(req.params.id);
    if (!['extend', 'convert_ongoing', 'let_lapse'].includes(action)) {
      return res.status(400).json({ error: 'invalid action' });
    }

    // Resolve alert row (may be derived id)
    let alert = null;
    let parentId = null;
    if (idParam.startsWith('derived-')) {
      parentId = parseInt(idParam.replace('derived-', ''));
    } else {
      alert = await db('recurring_plan_alerts').where({ id: parseInt(idParam) }).first();
      if (!alert) return res.status(404).json({ error: 'alert not found' });
      parentId = alert.recurring_parent_id;
    }

    const parent = await db('scheduled_services').where({ id: parentId }).first();
    if (!parent) return res.status(404).json({ error: 'parent service not found' });

    const cols = await db('scheduled_services').columnInfo();
    const rOpts = { nth: parent.recurring_nth, weekday: parent.recurring_weekday, intervalDays: parent.recurring_interval_days };

    const latest = await db('scheduled_services')
      .where(function () { this.where('recurring_parent_id', parentId).orWhere('id', parentId); })
      .orderBy('scheduled_date', 'desc').first();
    const baseDateStr = latest?.scheduled_date
      ? String(latest.scheduled_date).split('T')[0]
      : etDateString();

    let created = 0;
    if (action === 'extend') {
      const n = Math.min(Math.max(parseInt(count) || 4, 1), 12);
      for (let i = 1; i <= n; i++) {
        const nd = nextRecurringDate(baseDateStr, parent.recurring_pattern, i, rOpts);
        const data = {
          customer_id: parent.customer_id,
          technician_id: parent.technician_id,
          scheduled_date: nd,
          window_start: parent.window_start, window_end: parent.window_end,
          service_type: parent.service_type, status: 'pending',
          time_window: parent.time_window, zone: parent.zone,
          estimated_duration_minutes: parent.estimated_duration_minutes,
          is_recurring: true, recurring_pattern: parent.recurring_pattern,
          recurring_parent_id: parentId,
        };
        if (cols.service_id && parent.service_id) data.service_id = parent.service_id;
        if (cols.estimated_price && parent.estimated_price != null) data.estimated_price = parent.estimated_price;
        await db('scheduled_services').insert(data);
        created++;
      }
    } else if (action === 'convert_ongoing') {
      if (cols.recurring_ongoing) {
        await db('scheduled_services')
          .where(function () { this.where('recurring_parent_id', parentId).orWhere('id', parentId); })
          .update({ recurring_ongoing: true });
      }
      // Also ensure at least 3 pending visits scheduled ahead
      const pendingCount = parseInt((await db('scheduled_services')
        .where(function () { this.where('recurring_parent_id', parentId).orWhere('id', parentId); })
        .where('status', 'pending').count('* as c').first())?.c || 0);
      const need = Math.max(0, 3 - pendingCount);
      for (let i = 1; i <= need; i++) {
        const nd = nextRecurringDate(baseDateStr, parent.recurring_pattern, i, rOpts);
        const data = {
          customer_id: parent.customer_id,
          technician_id: parent.technician_id,
          scheduled_date: nd,
          window_start: parent.window_start, window_end: parent.window_end,
          service_type: parent.service_type, status: 'pending',
          time_window: parent.time_window, zone: parent.zone,
          estimated_duration_minutes: parent.estimated_duration_minutes,
          is_recurring: true, recurring_pattern: parent.recurring_pattern,
          recurring_parent_id: parentId,
        };
        if (cols.recurring_ongoing) data.recurring_ongoing = true;
        if (cols.service_id && parent.service_id) data.service_id = parent.service_id;
        if (cols.estimated_price && parent.estimated_price != null) data.estimated_price = parent.estimated_price;
        await db('scheduled_services').insert(data);
        created++;
      }
    }
    // 'let_lapse' just resolves the alert — no spawn

    // Resolve/insert alert row
    if (alert) {
      await db('recurring_plan_alerts').where({ id: alert.id }).update({
        resolved_at: db.fn.now(),
        resolved_action: action,
        resolved_by: req.adminUserId || null,
      });
    } else {
      // Derived — insert a resolved record for audit
      try {
        await db('recurring_plan_alerts').insert({
          recurring_parent_id: parentId,
          customer_id: parent.customer_id,
          alert_type: 'plan_ending_soon',
          recurring_pattern: parent.recurring_pattern,
          resolved_at: db.fn.now(),
          resolved_action: action,
          resolved_by: req.adminUserId || null,
        });
      } catch {}
    }

    res.json({ success: true, action, created });
  } catch (err) { next(err); }
});

module.exports = router;
