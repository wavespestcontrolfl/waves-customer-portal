/**
 * Admin Service Library Routes
 * GET  /api/admin/services           — list with filters
 * GET  /api/admin/services/dropdown   — lightweight for dropdowns
 * GET  /api/admin/services/packages   — WaveGuard packages
 * GET  /api/admin/services/:id        — single service detail
 * POST /api/admin/services            — create
 * PUT  /api/admin/services/:id        — update
 * DELETE /api/admin/services/:id      — soft delete
 * PUT  /api/admin/services/packages/:id — update package
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const serviceLibrary = require('../services/service-library');

router.use(adminAuthenticate, requireAdmin);

// GET / — paginated list with filters
router.get('/', async (req, res, next) => {
  try {
    const { category, billing_type, is_active, search, limit, offset } = req.query;
    const result = await serviceLibrary.getServices({
      category,
      billingType: billing_type,
      isActive: is_active,
      search,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /dropdown — lightweight for selects / dropdowns
router.get('/dropdown', async (req, res, next) => {
  try {
    const rows = await serviceLibrary.getDropdown();
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /packages — WaveGuard packages with items
router.get('/packages', async (req, res, next) => {
  try {
    const packages = await serviceLibrary.getPackages();
    res.json(packages);
  } catch (err) { next(err); }
});

// GET /:id — single service with addons
router.get('/:id', async (req, res, next) => {
  try {
    const service = await serviceLibrary.getServiceById(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    res.json(service);
  } catch (err) { next(err); }
});

// POST / — create service
router.post('/', async (req, res, next) => {
  try {
    const service = await serviceLibrary.createService(req.body);
    res.status(201).json(service);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Service key already exists' });
    res.status(500).json({ error: err.message || 'Failed to create service' });
  }
});

// PUT /packages/:id — update package (must be before /:id to avoid being shadowed)
router.put('/packages/:id', async (req, res, next) => {
  try {
    const pkg = await serviceLibrary.updatePackage(req.params.id, req.body);
    if (!pkg) return res.status(404).json({ error: 'Package not found' });
    res.json(pkg);
  } catch (err) { next(err); }
});

// PUT /:id — update service
router.put('/:id', async (req, res, next) => {
  try {
    const service = await serviceLibrary.updateService(req.params.id, req.body);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    res.json(service);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to update service' });
  }
});

// DELETE /:id — soft delete (deactivate + archive)
router.delete('/:id', async (req, res, next) => {
  try {
    const service = await serviceLibrary.deactivateService(req.params.id);
    if (!service) return res.status(404).json({ error: 'Service not found' });
    res.json({ success: true, service });
  } catch (err) { next(err); }
});

module.exports = router;
