const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

/* ── 1. GET /inbox — last 20 inbound SMS with customer context ── */
router.get('/inbox', async (req, res, next) => {
  try {
    const messages = await db('sms_log')
      .where({ direction: 'inbound' })
      .leftJoin('customers', 'sms_log.customer_id', 'customers.id')
      .select(
        'sms_log.id', 'sms_log.from_phone', 'sms_log.to_phone',
        'sms_log.message_body', 'sms_log.is_read', 'sms_log.created_at',
        'sms_log.customer_id', 'sms_log.message_type',
        'customers.first_name', 'customers.last_name', 'customers.phone as customer_phone'
      )
      .orderBy('sms_log.created_at', 'desc')
      .limit(20);

    const unreadCount = await db('sms_log')
      .where({ direction: 'inbound' })
      .andWhere(function () {
        this.where({ is_read: false }).orWhereNull('is_read');
      })
      .count('* as count')
      .first();

    res.json({
      messages: messages.map(m => ({
        id: m.id,
        fromPhone: m.from_phone,
        customerName: m.first_name ? `${m.first_name} ${m.last_name}` : null,
        customerId: m.customer_id,
        messageBody: m.message_body,
        messageType: m.message_type,
        isRead: !!m.is_read,
        createdAt: m.created_at,
      })),
      unreadCount: parseInt(unreadCount?.count || 0),
    });
  } catch (err) { next(err); }
});

/* ── 2. POST /inbox/:id/read — mark message as read ── */
router.post('/inbox/:id/read', async (req, res, next) => {
  try {
    await db('sms_log').where({ id: req.params.id }).update({ is_read: true });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/* ── 3. POST /inbox/:id/reply — send quick reply SMS ── */
router.post('/inbox/:id/reply', async (req, res, next) => {
  try {
    const { body } = req.body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'Reply body is required' });

    const original = await db('sms_log').where({ id: req.params.id }).first();
    if (!original) return res.status(404).json({ error: 'Message not found' });

    const TwilioService = require('../services/twilio');
    const result = await TwilioService.sendSMS(original.from_phone, body.trim(), {
      customerId: original.customer_id,
      messageType: 'manual',
      adminUserId: req.technicianId,
    });

    // Mark original as read
    await db('sms_log').where({ id: req.params.id }).update({ is_read: true });

    res.json({ success: true, sid: result?.sid });
  } catch (err) { next(err); }
});

/* ── 4. GET /recent-photos — last 15 service photos with context ── */
router.get('/recent-photos', async (req, res, next) => {
  try {
    const hasTable = await db.schema.hasTable('service_photos');
    if (!hasTable) return res.json({ photos: [] });

    const photos = await db('service_photos')
      .leftJoin('service_records', 'service_photos.service_record_id', 'service_records.id')
      .leftJoin('customers', 'service_records.customer_id', 'customers.id')
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select(
        'service_photos.id', 'service_photos.filepath', 'service_photos.caption',
        'service_photos.qa_status', 'service_photos.created_at',
        'service_records.service_type', 'service_records.service_date',
        'customers.first_name', 'customers.last_name',
        'technicians.name as tech_name'
      )
      .orderBy('service_photos.created_at', 'desc')
      .limit(15);

    res.json({
      photos: photos.map(p => ({
        id: p.id,
        filepath: p.filepath,
        caption: p.caption,
        qaStatus: p.qa_status || 'pending',
        createdAt: p.created_at,
        serviceType: p.service_type,
        serviceDate: p.service_date,
        customerName: p.first_name ? `${p.first_name} ${p.last_name}` : null,
        techName: p.tech_name,
      })),
    });
  } catch (err) { next(err); }
});

/* ── 5. POST /photos/:id/flag — flag a photo for QA review ── */
router.post('/photos/:id/flag', async (req, res, next) => {
  try {
    await db('service_photos')
      .where({ id: req.params.id })
      .update({ qa_status: 'flagged', qa_notes: req.body.notes || null });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/* ── 6. POST /photos/:id/approve — approve a photo ── */
router.post('/photos/:id/approve', async (req, res, next) => {
  try {
    await db('service_photos')
      .where({ id: req.params.id })
      .update({ qa_status: 'approved', qa_notes: null });
    res.json({ success: true });
  } catch (err) { next(err); }
});

/* ── 7. GET /field-leads — recent field leads (last 7 days) ── */
router.get('/field-leads', async (req, res, next) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const leads = await db('leads')
      .where({ first_contact_channel: 'field_observation' })
      .where('leads.created_at', '>=', sevenDaysAgo)
      .leftJoin('customers', 'leads.customer_id', 'customers.id')
      .leftJoin('technicians', 'leads.assigned_to', 'technicians.id')
      .select(
        'leads.id', 'leads.service_interest', 'leads.urgency',
        'leads.status', 'leads.created_at',
        'leads.first_name as lead_first', 'leads.last_name as lead_last',
        'leads.address', 'leads.city',
        'customers.first_name as cust_first', 'customers.last_name as cust_last',
        'technicians.name as tech_name'
      )
      .orderBy('leads.created_at', 'desc');

    res.json({
      leads: leads.map(l => ({
        id: l.id,
        customerName: l.cust_first ? `${l.cust_first} ${l.cust_last}` : `${l.lead_first || ''} ${l.lead_last || ''}`.trim(),
        address: l.address ? `${l.address}, ${l.city || ''}` : null,
        serviceInterest: l.service_interest,
        urgency: l.urgency,
        status: l.status,
        techName: l.tech_name,
        createdAt: l.created_at,
      })),
    });
  } catch (err) { next(err); }
});

/* ── 8. GET /weather — weather for a date ── */
router.get('/weather', async (req, res, next) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const alerts = [];

    // Strategy 1: Try weather_data table (FAWN)
    try {
      const hasTable = await db.schema.hasTable('weather_data');
      if (hasTable) {
        const row = await db('weather_data').where({ date }).first();
        if (row) {
          if (row.rainfall > 0.5) alerts.push({ level: 'red', text: `Rain: ${row.rainfall}"` });
          if (row.wind_speed > 15) alerts.push({ level: 'amber', text: `Wind: ${row.wind_speed} mph` });
          if (row.temp_high > 95) alerts.push({ level: 'amber', text: `Heat: ${row.temp_high}°F` });
          return res.json({
            source: 'fawn',
            date,
            temp: row.temp_high,
            humidity: row.humidity,
            windSpeed: row.wind_speed,
            rainfall: row.rainfall,
            alerts,
          });
        }
      }
    } catch {}

    // Strategy 2: Open-Meteo API (free, no key)
    try {
      // SW Florida coordinates (Fort Myers area)
      const lat = 26.64;
      const lon = -81.87;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max,relative_humidity_2m_max,wind_speed_10m_max,precipitation_sum&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&start_date=${date}&end_date=${date}&timezone=America/New_York`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (resp.ok) {
        const data = await resp.json();
        const d = data.daily;
        if (d && d.time && d.time.length > 0) {
          const temp = d.temperature_2m_max[0];
          const humidity = d.relative_humidity_2m_max?.[0];
          const wind = d.wind_speed_10m_max[0];
          const rain = d.precipitation_sum[0];
          if (rain > 0.5) alerts.push({ level: 'red', text: `Rain: ${rain}"` });
          if (wind > 15) alerts.push({ level: 'amber', text: `Wind: ${wind} mph` });
          if (temp > 95) alerts.push({ level: 'amber', text: `Heat: ${temp}°F` });
          return res.json({ source: 'open-meteo', date, temp, humidity, windSpeed: wind, rainfall: rain, alerts });
        }
      }
    } catch {}

    // Strategy 3: SWFL seasonal averages by month
    const month = new Date(date + 'T12:00:00').getMonth(); // 0-indexed
    const SWFL_AVERAGES = [
      { temp: 75, humidity: 65, windSpeed: 8, rainfall: 0.1 },  // Jan
      { temp: 77, humidity: 63, windSpeed: 9, rainfall: 0.1 },  // Feb
      { temp: 80, humidity: 60, windSpeed: 10, rainfall: 0.1 }, // Mar
      { temp: 84, humidity: 58, windSpeed: 10, rainfall: 0.1 }, // Apr
      { temp: 89, humidity: 62, windSpeed: 8, rainfall: 0.3 },  // May
      { temp: 91, humidity: 72, windSpeed: 7, rainfall: 0.6 },  // Jun
      { temp: 92, humidity: 74, windSpeed: 6, rainfall: 0.7 },  // Jul
      { temp: 92, humidity: 75, windSpeed: 6, rainfall: 0.7 },  // Aug
      { temp: 91, humidity: 73, windSpeed: 7, rainfall: 0.5 },  // Sep
      { temp: 86, humidity: 68, windSpeed: 8, rainfall: 0.2 },  // Oct
      { temp: 81, humidity: 65, windSpeed: 8, rainfall: 0.1 },  // Nov
      { temp: 76, humidity: 66, windSpeed: 8, rainfall: 0.1 },  // Dec
    ];
    const avg = SWFL_AVERAGES[month];
    res.json({ source: 'seasonal-average', date, ...avg, alerts: [] });
  } catch (err) { next(err); }
});

// =========================================================================
// WEEKLY BI BRIEFING AGENT
// =========================================================================

// POST /api/admin/dashboard-ops/bi/run — trigger the Monday briefing manually
router.post('/bi/run', async (req, res, next) => {
  try {
    const BIAgent = require('../services/bi-agent');
    const { skipSMS } = req.body;

    const promise = BIAgent.run({ skipSMS: skipSMS || false });

    if (req.query.wait === 'true') {
      const result = await promise;
      return res.json(result);
    }

    promise.catch(err => logger.error(`BI agent failed: ${err.message}`));
    res.json({ status: 'started', message: 'BI briefing agent running. Check /bi/reports for results.' });
  } catch (err) { next(err); }
});

// GET /api/admin/dashboard-ops/bi/reports — view weekly reports
router.get('/bi/reports', async (req, res, next) => {
  try {
    const { limit = 10 } = req.query;
    const reports = await db('weekly_bi_reports')
      .orderBy('created_at', 'desc')
      .limit(parseInt(limit));
    res.json({ reports });
  } catch (err) { next(err); }
});

module.exports = router;
