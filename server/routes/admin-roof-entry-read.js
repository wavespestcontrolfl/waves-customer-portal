/**
 * Staff roof read (GATE_ROOF_ENTRY_READ, owner 2026-11-19): the aerial-photo read of likely rodent entry points.
 *
 *   POST  /api/admin/roof-entry-read                run, or reuse (same property within 90 days), a read
 *         body { lat, lng, county, estimate_id?, customer_id? }; county is Manatee, Sarasota or Charlotte
 *         -> { status: 'ok' | 'in_progress' | 'no_image' | 'model_failed', cached, read, image_url? }; read is null unless status
 *         is 'ok', and then image_url is the county export URL of the crop the pins sit on.
 *         200 for every status except 202 'in_progress': another request holds this roof's claim, no image fetch or
 *         model call was made, ask again shortly. estimate_id / customer_id are stored and compared lower-case.
 *         400 { error: 'reference_mismatch' } when both ids are given and the estimate belongs to a different customer.
 *   PATCH /api/admin/roof-entry-read/:id/tech-count the technician's final count, flags and confirmed points
 *         body { count?: int 0-500, flags?: { <entry type>: 'yes' | 'no' | 'unsure' },
 *                pins?: [{ x, y, type, note?, source? }, ...] | null, crop?: { lat, lng }, expected_pins?: [...] | null,
 *                hide_on_estimate?: boolean } -> { read }
 *         At least one of count, flags, pins, hide_on_estimate is required. pins (owner ruling 2026-11-20, choice 4A) are the
 *         points the technician confirmed on the photo, saved whole (null clears them); the customer estimate shows only
 *         these, never the AI read. When pins is a list, crop is required: the crop centre the panel drew on, which must
 *         belong to this read's photo (else 400 { error: 'These points were not drawn on this roof photo' }). An invalid
 *         pins list (over 20 points, x or y outside 0-1, an unknown type, a note over 40 characters) is 400.
 *         source (optional) is "<entry type>:<index into that type's AI pins>", the AI suggestion a point was confirmed from;
 *         the staff panel uses it to keep that suggestion hidden, and the customer estimate never gets it.
 *         With pins (a list or null), expected_pins is required too: the list the panel last loaded (null = none saved).
 *         The save or clear lands only while the row still holds exactly that list, else 409 (another window changed it).
 *         Points need a finished, readable read (else 400 "Read the roof again").
 *         hide_on_estimate true keeps the points off the customer estimate. Send only what changed: pins and crop only when
 *         the points were edited, hide_on_estimate only when the checkbox changed.
 *
 * Admin only, like the other admin estimate routes. The gate is this router's first middleware, ahead of the staff
 * login that reads the technicians table: gate off = 404 { enabled: false } from the router, with no route-level
 * database read, staff login, image fetch or model call (a non-admin sees the same 404 while it is off). The portal's
 * global API middleware (rate limit, body parsing) runs before the router, so a limiter 429 or a malformed-body 400 can
 * still come first. Nothing here is customer-facing.
 */
const express = require('express');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { roofEntryReadLive } = require('../config/feature-gates');
const logger = require('../services/logger');
const {
  ENTRY_TYPES, LIKELY, MAX_TECH_PINS, countyKey, isPlainObject, runRoofEntryRead, saveTechCount, validateTechPins,
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
    estimateId: b.estimate_id ? b.estimate_id.toLowerCase() : null,
    customerId: b.customer_id ? b.customer_id.toLowerCase() : null,
  };
}

// The tech-count PATCH fields that stand alone, each with its check. One loop applies the shared rule: a field left out
// is skipped, and a field sent must pass its check or the whole request is refused. pins, crop and expected_pins depend
// on each other, so techCountInput checks them together.
const TECH_FIELDS = [
  { key: 'count', as: 'count', ok: (v) => Number.isInteger(v) && v >= 0 && v <= MAX_TECH_COUNT },
  {
    key: 'flags',
    as: 'flags',
    ok: (f) => isPlainObject(f) && Object.entries(f).every(([type, likely]) => ENTRY_TYPES.includes(type) && LIKELY.includes(likely)),
  },
  { key: 'hide_on_estimate', as: 'hideOnEstimate', ok: (v) => typeof v === 'boolean' },
];

function techCountInput(body) {
  const b = isPlainObject(body) ? body : {};
  const out = {};
  for (const { key, as, ok } of TECH_FIELDS) {
    if (b[key] === undefined) continue;
    if (!ok(b[key])) return null;
    out[as] = b[key];
  }
  if (b.pins !== undefined) {
    const clear = b.pins === null;
    const pins = clear ? null : validateTechPins(b.pins);
    const c = b.crop;
    // A list needs the crop centre it was drawn on; a clear (null) needs none.
    const pointsOk = clear || (pins && isPlainObject(c) && isCoord(c.lat, 90) && isCoord(c.lng, 180));
    // The list the panel last loaded (null = none saved yet): required with any points change, so a stale tab's save
    // or clear is refused (409).
    const e = b.expected_pins;
    const expectedOk = e === null || (Array.isArray(e) && e.length <= MAX_TECH_PINS && e.every(isPlainObject));
    if (!pointsOk || !expectedOk) return null;
    out.pins = pins;
    out.expectedPins = e;
    if (!clear) out.crop = { lat: c.lat, lng: c.lng };
  }
  return Object.keys(out).length ? out : null;
}

router.post('/', async (req, res, next) => {
  try {
    const input = readInput(req.body);
    if (!input) return res.status(400).json({ error: 'lat, lng and county are required; estimate_id and customer_id are optional' });
    const result = await runRoofEntryRead(input);
    logger.info(`[admin-roof-entry-read] status=${result.status} cached=${result.cached} county=${countyKey(input.county) || 'unsupported'}`);
    return res.status(result.status === 'in_progress' ? 202 : 200).json(result);
  } catch (err) {
    // An estimate that belongs to another customer is refused before any claim, row, fetch or call.
    if (err.code === 'reference_mismatch') return res.status(400).json({ error: 'reference_mismatch' });
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
    if (!input) {
      return res.status(400).json({
        error: 'Send count (whole number, 0-500), flags ({ <entry type>: yes | no | unsure }), pins (up to 20, with crop) and/or hide_on_estimate (true or false)',
      });
    }
    const read = await saveTechCount(req.params.id, input);
    if (!read) return res.status(404).json({ error: 'Read not found' });
    return res.json({ read });
  } catch (err) {
    if (err.code === 'crop_mismatch') return res.status(400).json({ error: 'These points were not drawn on this roof photo' });
    if (err.code === 'read_not_usable') return res.status(400).json({ error: 'This roof read did not work. Read the roof again before adding points.' });
    if (err.code === 'points_changed') return res.status(409).json({ error: 'These points were changed in another window. Read the roof again to load them.' });
    // A database error can carry the bound values (the technician's notes, the crop centre): log and forward only the
    // read id and the error code.
    logger.error(`[admin-roof-entry-read] tech count failed for read ${req.params.id}: ${err.code || 'error'}`);
    return next(Object.assign(new Error('Roof read tech count save failed'), { code: err.code }));
  }
});

module.exports = router;
