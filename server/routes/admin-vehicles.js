/**
 * Admin vehicle ↔ technician mapping (Bouncie IMEI / VIN / vehicle name).
 * Mounted at /api/admin/vehicles, and still at /api/admin/geofence/vehicles (the
 * old path) so any caller of the old URL keeps working.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireAdmin);

// GET /api/admin/vehicles — tech ↔ IMEI map
router.get('/', async (req, res, next) => {
  try {
    const rows = await db('technicians')
      .select('id', 'name', 'bouncie_imei', 'bouncie_vin', 'vehicle_name', 'active')
      .orderBy('name');
    res.json({ technicians: rows });
  } catch (err) { next(err); }
});

// PUT /api/admin/vehicles/:technicianId
router.put('/:technicianId', async (req, res, next) => {
  try {
    const { bouncie_imei, bouncie_vin, vehicle_name } = req.body;
    const updates = { updated_at: new Date() };
    if (bouncie_imei !== undefined) {
      // The CANONICAL form the readers use (resolveFreshTechPosition trims before fetching/guarding): trimmed, empty -> NULL. Stored and
      // stamped trimmed, so whitespace never breaks the guarded write / webhook lookup nor fires a spurious remap stamp (Codex #5334 P2).
      const nextImei = String(bouncie_imei ?? '').trim() || null;
      updates.bouncie_imei = nextImei;
      // Stamp the tracker-remap instant ONLY when the IMEI actually changes (round-35
      // P2) and do it ATOMICALLY with the IMEI write (round-38 P2): one UPDATE whose
      // CASE compares the row's CURRENT bouncie_imei (Postgres evaluates SET
      // expressions against the pre-update row, under the row lock), so concurrent
      // saves can never restore an old IMEI without a stamp. An unchanged re-save keeps
      // the existing stamp. technicians.updated_at is restamped by every ordinary edit
      // and cannot say this. clock_timestamp(), NOT NOW() (Codex #5334 P2): NOW() is the transaction START time, so an
      // UPDATE that waited on the row lock behind an old-device ping would stamp a remap EARLIER than that ping's receipt.
      updates.bouncie_imei_changed_at = db.raw(
        'CASE WHEN technicians.bouncie_imei IS DISTINCT FROM ?::varchar THEN clock_timestamp() ELSE technicians.bouncie_imei_changed_at END',
        [nextImei],
      );
    }
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

module.exports = router;
