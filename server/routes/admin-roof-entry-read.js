/**
 * Staff roof read (GATE_ROOF_ENTRY_READ, owner 2026-11-19): the aerial-photo read of likely rodent entry points.
 *
 *   POST  /api/admin/roof-entry-read                run, or reuse (same property within 90 days), a read
 *         body { lat, lng, county, estimate_id?, customer_id? }; county is Manatee, Sarasota or Charlotte
 *         -> { status: 'ok' | 'no_image' | 'model_failed', cached, read }; read is null unless status is 'ok'
 *   PATCH /api/admin/roof-entry-read/:id/tech-count the technician's final count and flags, to compare with the AI later
 *         body { count?: int >= 0, flags?: { <entry type>: 'yes' | 'no' | 'unsure' } } -> { read }
 *
 * Admin only, like the other admin estimate routes. The gate is checked FIRST, before the staff login reads the
 * technicians table: gate off = 404 { enabled: false } with no database read, image fetch or model call (a non-admin
 * sees the same 404 while it is off). Nothing here is customer-facing.
 */
const express = require('express');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { roofEntryReadLive } = require('../config/feature-gates');
const logger = require('../services/logger');
const {
  ENTRY_TYPES, LIKELY, countyKey, runRoofEntryRead, saveTechCount,
} = require('../services/roof-entry-read');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TECH_COUNT = 500;

const gateOn = (req, res, next) => (roofEntryReadLive() ? next() : res.status(404).json({ enabled: false }));
router.use(gateOn, adminAuthenticate, requireAdmin);

const isCoord = (v, limit) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;
const optionalUuid = (v) => v == null || (typeof v === 'string' && UUID_RE.test(v));

function readInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const ok = isCoord(b.lat, 90) && isCoord(b.lng, 180)
    && typeof b.county === 'string' && b.county.trim() && b.county.length <= 40
    && optionalUuid(b.estimate_id) && optionalUuid(b.customer_id);
  if (!ok) return null;
  return {
    lat: b.lat, lng: b.lng, county: b.county,
    estimateId: b.estimate_id || null, customerId: b.customer_id || null,
  };
}

function techCountInput(body) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  if (b.count !== undefined) {
    if (!Number.isInteger(b.count) || b.count < 0 || b.count > MAX_TECH_COUNT) return null;
    out.count = b.count;
  }
  if (b.flags !== undefined) {
    const f = b.flags;
    const valid = f && typeof f === 'object' && !Array.isArray(f)
      && Object.entries(f).every(([type, likely]) => ENTRY_TYPES.includes(type) && LIKELY.includes(likely));
    if (!valid) return null;
    out.flags = f;
  }
  return out.count === undefined && out.flags === undefined ? null : out;
}

router.post('/', async (req, res, next) => {
  try {
    const input = readInput(req.body);
    if (!input) return res.status(400).json({ error: 'lat, lng and county are required; estimate_id and customer_id are optional' });
    const result = await runRoofEntryRead(input);
    logger.info(`[admin-roof-entry-read] status=${result.status} cached=${result.cached} county=${countyKey(input.county) || 'unsupported'}`);
    return res.json(result);
  } catch (err) {
    // A missing estimate or customer is refused before any spend; the foreign key still catches one deleted mid-read.
    if (err.code === 'unknown_reference' || err.code === '23503') return res.status(400).json({ error: 'Unknown estimate_id or customer_id' });
    logger.error(`[admin-roof-entry-read] run failed: ${err.message}`);
    return next(err);
  }
});

router.patch('/:id/tech-count', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Read not found' });
    const input = techCountInput(req.body);
    if (!input) return res.status(400).json({ error: 'Send count (whole number, 0-500) and/or flags ({ <entry type>: yes | no | unsure })' });
    const read = await saveTechCount(req.params.id, input);
    if (!read) return res.status(404).json({ error: 'Read not found' });
    return res.json({ read });
  } catch (err) {
    logger.error(`[admin-roof-entry-read] tech count failed: ${err.message}`);
    return next(err);
  }
});

module.exports = router;
