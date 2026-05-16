const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { validatePhotoChain } = require('../services/service-report/photo-chain');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/service/records/:id/validate-photo-chain
router.get('/:id/validate-photo-chain', async (req, res, next) => {
  try {
    const record = await db('service_records')
      .where({ id: req.params.id })
      .first('id', 'technician_id');
    if (!record) return res.status(404).json({ error: 'Service record not found' });

    if (req.techRole !== 'admin' && record.technician_id !== req.technicianId) {
      return res.status(403).json({ error: 'Not assigned to this service record' });
    }

    const result = await validatePhotoChain(record.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
