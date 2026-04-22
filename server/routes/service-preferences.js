/**
 * Customer-facing service-preference toggles.
 *
 * A customer can opt out of specific parts of a pest-control visit (interior
 * spraying, exterior eave/cobweb sweep). The selections live on
 * customers.service_preferences as a JSONB blob so the tech portal, the
 * estimator, and this route all read the same source of truth.
 *
 * Any change from the customer portal fires an admin notification so the
 * office knows to update the tech's work order before the next visit.
 *
 * Routes
 *   GET  /api/service-preferences           → returns { interior_spray, exterior_sweep }
 *   PUT  /api/service-preferences           → partial update; same shape
 */
const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const NotificationService = require('../services/notification-service');

router.use(express.json({ limit: '8kb' }));
router.use(authenticate);

const DEFAULT_PREFS = { interior_spray: true, exterior_sweep: true };

function normalize(raw) {
  const out = { ...DEFAULT_PREFS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_PREFS)) {
      if (k in raw) out[k] = raw[k] !== false;
    }
  }
  return out;
}

async function readPrefs(customerId) {
  if (!(await db.schema.hasColumn('customers', 'service_preferences'))) {
    return DEFAULT_PREFS;
  }
  const row = await db('customers').select('service_preferences').where({ id: customerId }).first();
  if (!row) return DEFAULT_PREFS;
  const raw = typeof row.service_preferences === 'string'
    ? JSON.parse(row.service_preferences || '{}')
    : (row.service_preferences || {});
  return normalize(raw);
}

// GET /api/service-preferences
router.get('/', async (req, res, next) => {
  try {
    const prefs = await readPrefs(req.customerId);
    res.json({ preferences: prefs });
  } catch (err) { next(err); }
});

// PUT /api/service-preferences — partial update
router.put('/', async (req, res, next) => {
  try {
    const schema = Joi.object({
      interior_spray: Joi.boolean(),
      exterior_sweep: Joi.boolean(),
    }).min(1);
    const patch = await schema.validateAsync(req.body);

    if (!(await db.schema.hasColumn('customers', 'service_preferences'))) {
      return res.status(503).json({ error: 'Service preferences not yet available' });
    }

    const previous = await readPrefs(req.customerId);
    const next = normalize({ ...previous, ...patch });

    await db('customers').where({ id: req.customerId }).update({
      service_preferences: JSON.stringify(next),
      updated_at: new Date(),
    });

    // Figure out which keys actually flipped (for the admin notification body)
    const changed = Object.keys(patch).filter((k) => previous[k] !== next[k]);
    if (changed.length) {
      try {
        const customer = await db('customers')
          .select('id', 'first_name', 'last_name', 'address_line1')
          .where({ id: req.customerId }).first();
        const name = `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim() || 'Customer';
        const summary = changed.map((k) => {
          const label = k === 'interior_spray' ? 'interior spray' : 'exterior sweep';
          return `${label}: ${next[k] ? 'ON' : 'OFF'}`;
        }).join(' · ');
        await NotificationService.notifyAdmin(
          'service-prefs',
          `Service prefs changed: ${name}`,
          `${customer?.address_line1 || ''} — ${summary}`,
          { icon: '\u{1F527}', link: `/admin/customers/${req.customerId}`, metadata: { customerId: req.customerId, changed, next } },
        );
      } catch (e) {
        logger.warn(`[service-preferences] admin notification failed: ${e.message}`);
      }
    }

    logger.info(`[service-preferences] customer ${req.customerId} updated: ${JSON.stringify(next)}`);
    res.json({ preferences: next });
  } catch (err) {
    if (err.isJoi) return res.status(400).json({ error: err.details.map((d) => d.message).join('; ') });
    next(err);
  }
});

module.exports = router;
