const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { technicianVisitRowInScope } = require('../services/technician-visit-scope');
const { validatePhotoChain } = require('../services/service-report/photo-chain');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/service/records/:id/validate-photo-chain
router.get('/:id/validate-photo-chain', async (req, res, next) => {
  try {
    const record = await db('service_records')
      .where({ id: req.params.id })
      .first('id', 'technician_id', 'scheduled_service_id');
    if (!record) return res.status(404).json({ error: 'Service record not found' });

    if (req.techRole !== 'admin') {
      if (record.technician_id !== req.technicianId) {
        return res.status(403).json({ error: 'Not assigned to this service record' });
      }
      // A service_records row carries no status or date window of its own, so
      // currency is judged on the visit it was written for: the canonical
      // current-assignment predicate (own row, not a dead status, inside the
      // access window). A record with no linked visit (legacy rows) keeps the
      // bare own-record match above — there is nothing to window it on.
      if (record.scheduled_service_id) {
        const visit = await db('scheduled_services')
          .where({ id: record.scheduled_service_id })
          .first('id', 'technician_id', 'status', 'scheduled_date');
        if (!visit || !technicianVisitRowInScope(req, visit)) {
          return res.status(403).json({ error: 'Not assigned to this service record' });
        }
      }
    }

    const result = await validatePhotoChain(record.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
