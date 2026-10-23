/**
 * Tech API for the truck check (GATE_TRUCK_KIT, docs/tool-inventory-tracker-scope.md).
 *
 *   GET  /api/tech/truck-check   the signed-in technician's truck, its kit, the last check, due
 *   POST /api/tech/truck-check   body { results: [{ equipmentId, state, note? }] } — one check
 *
 * The truck is resolved from the login (services/truck-kit.js), never from the
 * body: a technician can only ever check their own truck. Gate checked at call
 * time on every handler — off answers 404 { enabled: false }, matching the
 * other GATE_*-owned surfaces (routes/admin-tech-out.js).
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const truckKit = require('../services/truck-kit');

router.use(adminAuthenticate, requireTechOrAdmin);

const ERROR_STATUS = { no_truck: 404, invalid_results: 400, kit_changed: 409, ambiguous_truck: 409 };

router.get('/', async (req, res, next) => {
  if (!truckKit.truckKitEnabled()) return res.status(404).json({ enabled: false });
  try {
    res.set('Cache-Control', 'private, no-store');
    res.json(await truckKit.truckKitStatus(req.technicianId));
  } catch (err) {
    const status = ERROR_STATUS[err.code];
    if (!status) return next(err);
    res.status(status).json({ error: err.message, code: err.code });
  }
});

router.post('/', async (req, res, next) => {
  if (!truckKit.truckKitEnabled()) return res.status(404).json({ enabled: false });
  try {
    const result = await truckKit.recordTruckCheck({ technicianId: req.technicianId, results: req.body?.results });
    res.status(201).json(result);
  } catch (err) {
    const status = ERROR_STATUS[err.code];
    if (!status) return next(err);
    res.status(status).json({ error: err.message, code: err.code, ...(err.code === 'kit_changed' ? { kit: err.kit } : {}) });
  }
});

module.exports = router;
