/**
 * Admin-side geofence management:
 *   - GET/PUT settings (mode / radius / cooldown / auto_complete)
 *   - Vehicle ↔ tech IMEI mapping
 *   - Event log (with ENTER/EXIT pairing → duration)
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireAdmin);

const KEYS = [
  'geofence.mode',
  'geofence.radius_meters',
  'geofence.cooldown_minutes',
  'geofence.auto_complete_on_exit',
];

// GET /api/admin/geofence/settings
router.get('/settings', async (req, res, next) => {
  try {
    const rows = await db('system_settings').whereIn('key', KEYS);
    const settings = {};
    rows.forEach((r) => { settings[r.key] = r.value; });
    res.json({
      mode: settings['geofence.mode'] || 'reminder',
      radius_meters: parseInt(settings['geofence.radius_meters'] || '200', 10),
      cooldown_minutes: parseInt(settings['geofence.cooldown_minutes'] || '15', 10),
      auto_complete_on_exit: String(settings['geofence.auto_complete_on_exit']) === 'true',
    });
  } catch (err) { next(err); }
});

// PUT /api/admin/geofence/settings
router.put('/settings', async (req, res, next) => {
  try {
    const { mode, radius_meters, cooldown_minutes, auto_complete_on_exit } = req.body;
    const updates = [];
    if (mode !== undefined) updates.push({ key: 'geofence.mode', value: String(mode) });
    if (radius_meters !== undefined) updates.push({ key: 'geofence.radius_meters', value: String(parseInt(radius_meters, 10)) });
    if (cooldown_minutes !== undefined) updates.push({ key: 'geofence.cooldown_minutes', value: String(parseInt(cooldown_minutes, 10)) });
    if (auto_complete_on_exit !== undefined) updates.push({ key: 'geofence.auto_complete_on_exit', value: String(!!auto_complete_on_exit) });

    for (const u of updates) {
      await db('system_settings')
        .insert({ ...u, category: 'geofence', updated_at: new Date() })
        .onConflict('key')
        .merge({ value: u.value, updated_at: new Date() });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/geofence/vehicles — tech ↔ IMEI map
router.get('/vehicles', async (req, res, next) => {
  try {
    const rows = await db('technicians')
      .select('id', 'name', 'bouncie_imei', 'bouncie_vin', 'vehicle_name', 'active')
      .orderBy('name');
    res.json({ technicians: rows });
  } catch (err) { next(err); }
});

// PUT /api/admin/geofence/vehicles/:technicianId
router.put('/vehicles/:technicianId', async (req, res, next) => {
  try {
    const { bouncie_imei, bouncie_vin, vehicle_name } = req.body;
    const updates = { updated_at: new Date() };
    if (bouncie_imei !== undefined) updates.bouncie_imei = bouncie_imei || null;
    if (bouncie_vin !== undefined) updates.bouncie_vin = bouncie_vin || null;
    if (vehicle_name !== undefined) updates.vehicle_name = vehicle_name || null;
    await db('technicians').where({ id: req.params.technicianId }).update(updates);
    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('unique')) {
      return res.status(400).json({ error: 'That IMEI is already assigned to another tech.' });
    }
    next(err);
  }
});

// GET /api/admin/geofence/events
router.get('/events', async (req, res, next) => {
  try {
    const { technicianId, action, startDate, endDate, limit = 100, offset = 0 } = req.query;
    let q = db('geofence_events')
      .leftJoin('technicians', 'geofence_events.technician_id', 'technicians.id')
      .leftJoin('customers', 'geofence_events.matched_customer_id', 'customers.id')
      .select(
        'geofence_events.*',
        'technicians.name as tech_name',
        'customers.first_name as customer_first_name',
        'customers.last_name as customer_last_name',
      );
    if (technicianId) q = q.where('geofence_events.technician_id', technicianId);
    if (action) q = q.where('geofence_events.action_taken', action);
    if (startDate) q = q.where('geofence_events.event_timestamp', '>=', startDate);
    if (endDate) q = q.where('geofence_events.event_timestamp', '<=', endDate + ' 23:59:59');
    const rows = await q
      .orderBy('geofence_events.event_timestamp', 'desc')
      .limit(parseInt(limit, 10))
      .offset(parseInt(offset, 10));
    res.json({ events: rows });
  } catch (err) { next(err); }
});

module.exports = router;
