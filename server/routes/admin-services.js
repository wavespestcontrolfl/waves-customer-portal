/**
 * Admin Service Routes — two concerns share this file today:
 *
 *   1. Service Library (catalog)     — :id is a service-catalog row
 *      GET  /               — list with filters
 *      GET  /dropdown        — lightweight for dropdowns
 *      GET  /packages        — WaveGuard packages
 *      GET  /:id             — single service detail
 *      POST /                — create
 *      PUT  /:id             — update
 *      DELETE /:id           — soft delete
 *      PUT  /packages/:id    — update package
 *
 *   2. Scheduled-service lifecycle   — :id is a scheduled_services.id
 *      POST /:id/cancel      — cancel a scheduled appointment
 *
 *   Sub-paths on :id/* don't collide with the bare :id library routes
 *   above (they use GET/PUT/DELETE), so the two concerns coexist. If
 *   the lifecycle section grows (Phase 2: reassign, reschedule, edit
 *   notes) consider splitting into admin-service-library.js + keeping
 *   lifecycle here.
 */
const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const serviceLibrary = require('../services/service-library');
const trackTransitions = require('../services/track-transitions');
const db = require('../models/db');
const logger = require('../services/logger');

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

// =============================================================================
// Scheduled-service lifecycle
// =============================================================================

// POST /:id/cancel — cancel a scheduled appointment
// Body: { reason?: string }
// Flips track_state='cancelled', bumps token expiry 24h so customer can still
// see the cancelled state on /track/:token for a day. No customer SMS on v1.
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const { reason } = req.body || {};

    const result = await trackTransitions.cancel(req.params.id, {
      reason: reason ? String(reason).slice(0, 500) : null,
      actorId: req.technicianId,
    });

    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      return res.status(status).json({ error: result.reason });
    }

    // Also update the legacy `status` column so the dispatch board, schedule
    // page, and other consumers that read `status` reflect the cancellation.
    // track_state remains the customer-visible truth; status keeps internal
    // tooling in sync.
    await db('scheduled_services')
      .where({ id: req.params.id })
      .update({ status: 'cancelled', updated_at: new Date() })
      .catch((e) => logger.warn(`[admin-services] legacy status update failed: ${e.message}`));

    res.json({
      state: result.state,
      cancelledAt: result.cancelledAt,
      expiresAt: result.expiresAt || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
