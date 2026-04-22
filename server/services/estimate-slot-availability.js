/**
 * Estimate slot availability — thin wrapper around scheduling/find-time.js
 * for the customer-facing estimate view.
 *
 * Given an estimate token's underlying row, returns the 3 best route-optimal
 * time slots over the next 14 days plus an expander list with up to 10
 * additional options. Route-optimality is detour-based (the cost the fleet
 * actually pays, not raw distance to the nearest stop) because find-time
 * already computed it that way and the signal is honest.
 *
 * Customer-facing label is copy-only: "Nearby {dayName} — {techFirstName}
 * is servicing a property close to you" — renders from the data this
 * service returns without exposing other customers' info. We carry the
 * underlying detourMinutes on the response for future A/B testing.
 *
 * This module knows nothing about route-level optimization and doesn't touch
 * Google's Routes API or DistanceMatrix. Haversine-based detour from
 * find-time.js is good enough at current volume, and it's zero per-request
 * API cost. The only Google call we make is geocoding the estimate's
 * address — once per unique address, cached 24h.
 *
 * TODO(separate-PR): customers table naming drift — the canonical coordinate
 * columns are `latitude` / `longitude` (added by 20260414000029_geofence_timers).
 * find-time.js also reads `customers.lat as cust_lat` which isn't a real
 * column on customers, so that alias returns null; the query falls back to
 * scheduled_services.lat/lng which IS real. Consolidate naming in a
 * dedicated surgical PR.
 */
const db = require('../models/db');
const logger = require('./logger');
const { findAvailableSlots } = require('./scheduling/find-time');

const BLOCKED_STATES_FOR_SLOTS = new Set(['accepted', 'declined', 'expired']);

const DEFAULT_OPTS = {
  windowDays: 14,
  maxResults: 3,
  proximityDriveMinutes: 20,
  expanderMaxResults: 10,
  durationMinutes: 60,
};

// ---------- in-memory caches ----------

const wrapperCache = new Map();      // key: `${estimateId}:${hourOfDay}` → { result, expiresAt }
const WRAPPER_TTL_MS = 5 * 60 * 1000;

const geocodeCache = new Map();      // key: normalized address → { coords, expiresAt }
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheHour() {
  return new Date().toISOString().slice(0, 13); // 'YYYY-MM-DDTHH' — 1-hour bucket
}

function cleanupCache(cache) {
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    if (v.expiresAt < now) cache.delete(k);
  }
}

// ---------- geocoding ----------

async function geocodeAddress(address) {
  const key = (address || '').trim().toLowerCase();
  if (!key) return null;

  cleanupCache(geocodeCache);
  const cached = geocodeCache.get(key);
  if (cached) return cached.coords;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logger.warn('[estimate-slots] no GOOGLE_MAPS_API_KEY — skipping geocode');
    return null;
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== 'OK' || !data.results?.length) {
      logger.warn(`[estimate-slots] geocode failed for "${address.slice(0, 60)}": ${data.status}`);
      return null;
    }
    const loc = data.results[0].geometry.location;
    const coords = { lat: loc.lat, lng: loc.lng };
    geocodeCache.set(key, { coords, expiresAt: Date.now() + GEOCODE_TTL_MS });
    return coords;
  } catch (err) {
    logger.error(`[estimate-slots] geocode error: ${err.message}`);
    return null;
  }
}

// ---------- coordinate resolution ----------

async function resolveEstimateCoords(estimate) {
  // Prefer linked-customer coords (zero cost, zero external call).
  if (estimate.customer_id) {
    try {
      const cust = await db('customers')
        .where({ id: estimate.customer_id })
        .first('latitude', 'longitude');
      const lat = cust?.latitude != null ? Number(cust.latitude) : null;
      const lng = cust?.longitude != null ? Number(cust.longitude) : null;
      if (Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0) {
        return { lat, lng, source: 'customer_record' };
      }
    } catch (err) {
      logger.warn(`[estimate-slots] customer coord lookup failed: ${err.message}`);
    }
  }

  // Fallback: geocode the estimate's address.
  if (estimate.address) {
    const coords = await geocodeAddress(estimate.address);
    if (coords) {
      return { ...coords, source: 'geocoded' };
    }
  }

  return null;
}

// ---------- slot classification ----------

function parseAnchorTime(anchorStr) {
  // Anchor strings from find-time look like 'Sarah Smith (09:30)' or
  // 'HQ (start of day)'. Extract minutes-since-midnight; null if not
  // a real stop (HQ) or unparseable.
  if (!anchorStr) return null;
  const m = anchorStr.match(/\((\d{1,2}):(\d{2})\)\s*$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
}

function pickNearbyAnchor(slot) {
  // Detour is cheap because at least one anchor is a real stop. Pick the
  // non-HQ anchor; when both are real stops, pick whichever is closer in
  // time to the slot's start_time (the user's spec — that's the stop the
  // customer-facing 'we're close by' label would most naturally reference).
  const afterIsReal = !!slot?.insertion?.after_stop_id;
  const beforeIsReal = !!slot?.insertion?.before_stop_id;
  if (!afterIsReal && !beforeIsReal) return null;

  const slotStartMin = parseAnchorTime(`x (${slot.start_time})`);
  const afterMin = afterIsReal ? parseAnchorTime(slot.insertion.after) : null;
  const beforeMin = beforeIsReal ? parseAnchorTime(slot.insertion.before) : null;

  if (afterIsReal && !beforeIsReal) return 'after';
  if (beforeIsReal && !afterIsReal) return 'before';
  if (slotStartMin == null) return 'after'; // arbitrary tiebreak
  const afterDelta = afterMin == null ? Infinity : Math.abs(slotStartMin - afterMin);
  const beforeDelta = beforeMin == null ? Infinity : Math.abs(slotStartMin - beforeMin);
  return afterDelta <= beforeDelta ? 'after' : 'before';
}

// Round a "HH:MM" string to the next full hour. e.g. "08:13" → "09:00",
// "08:00" → "08:00" (idempotent when already on an hour mark). Used to
// clean up find-time's minute-precise start times — customers expect
// hour-rounded service windows ("9:00–10:00", not "8:13–9:13").
// The slight delay (up to 59 min) from find-time's earliestStart is
// acceptable: find-time already accounts for latestEnd when computing
// the candidate, so the rounded window still usually fits the day.
function roundUpToHour(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return hhmm;
  const parts = hhmm.split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1] || 0);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  if (m === 0) return `${String(h).padStart(2, '0')}:00`;
  const nextH = (h + 1) % 24;
  return `${String(nextH).padStart(2, '0')}:00`;
}

function addOneHour(hhmm) {
  const parts = String(hhmm).split(':');
  const h = Number(parts[0]);
  const m = Number(parts[1] || 0);
  if (!Number.isFinite(h)) return hhmm;
  const nextH = (h + 1) % 24;
  return `${String(nextH).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function classifySlot(slot, proximityDriveMinutes) {
  const routeOptimal = Number.isFinite(slot.detour_minutes) && slot.detour_minutes <= proximityDriveMinutes;
  const nearbyAnchor = routeOptimal ? pickNearbyAnchor(slot) : null;
  // Round display times to clean hour boundaries. slotId still uses the
  // rounded start so collisions between two slots that rounded to the
  // same hour (possible at the edge of find-time's range) don't both
  // generate identical IDs — techId differentiates.
  const windowStart = roundUpToHour(slot.start_time);
  const windowEnd = addOneHour(windowStart);
  return {
    slotId: `${slot.date}_${windowStart.replace(':', '-')}_${slot.technician?.id || 'unassigned'}`,
    date: slot.date,
    windowStart,
    windowEnd,
    techFirstName: (slot.technician?.name || '').split(/\s+/)[0] || null,
    techId: slot.technician?.id || null,
    routeOptimal,
    nearbyJob: routeOptimal && nearbyAnchor
      ? { detourMinutes: slot.detour_minutes }
      : null,
  };
}

// ---------- main ----------

async function getAvailableSlots(estimateId, userOpts = {}) {
  const opts = { ...DEFAULT_OPTS, ...userOpts };

  const estimate = await db('estimates').where({ id: estimateId }).first();
  if (!estimate) {
    const err = new Error('estimate not found');
    err.code = 'ESTIMATE_NOT_FOUND';
    throw err;
  }
  if (BLOCKED_STATES_FOR_SLOTS.has(estimate.status)) {
    const err = new Error(`cannot load slots for estimate in state '${estimate.status}'`);
    err.code = 'ESTIMATE_TERMINAL';
    throw err;
  }
  if (estimate.expires_at && new Date(estimate.expires_at) < new Date()) {
    const err = new Error('estimate has expired');
    err.code = 'ESTIMATE_EXPIRED';
    throw err;
  }

  // Cache check — keyed per (estimateId, hour bucket).
  cleanupCache(wrapperCache);
  const cacheKey = `${estimateId}:${cacheHour()}`;
  const cached = wrapperCache.get(cacheKey);
  if (cached) {
    return { ...cached.result, metadata: { ...cached.result.metadata, cacheHit: true } };
  }

  const coords = await resolveEstimateCoords(estimate);

  // If we can't resolve coords, degrade gracefully: return empty primary,
  // no expander. The route-public handler still 200s — customer just sees
  // the fallback "reach out to schedule" messaging on the page.
  if (!coords) {
    const fallback = {
      primary: [],
      expander: [],
      metadata: {
        estimateAddress: estimate.address || null,
        estimateCoords: null,
        windowDays: opts.windowDays,
        proximityDriveMinutes: opts.proximityDriveMinutes,
        generatedAt: new Date().toISOString(),
        cacheHit: false,
        coordsSource: 'none',
      },
    };
    return fallback;
  }

  const today = new Date();
  const dateFrom = today.toISOString().slice(0, 10);
  const end = new Date(today.getTime() + opts.windowDays * 86400000);
  const dateTo = end.toISOString().slice(0, 10);

  // Pull a generous topN so we can split route-optimal + expander post-hoc
  // without a second call. find-time sorts by score (detour + day penalty)
  // ascending, so the top 50 are the cheapest 50 insertions across the
  // whole fleet over 14 days — way more than we'll surface.
  const raw = await findAvailableSlots({
    lat: coords.lat,
    lng: coords.lng,
    durationMinutes: opts.durationMinutes,
    dateFrom,
    dateTo,
    topN: 50,
  });

  const classified = (raw?.slots || []).map((s) => classifySlot(s, opts.proximityDriveMinutes));

  // Primary: route-optimal only, sorted by detour asc then date asc.
  // find-time's default sort is close to this already (detour + day penalty),
  // but re-sort to make the ordering explicit and decouple from any future
  // scoring tweaks over there.
  const routeOptimalSlots = classified
    .filter((s) => s.routeOptimal)
    .sort((a, b) => {
      const da = a.nearbyJob?.detourMinutes ?? Infinity;
      const dbv = b.nearbyJob?.detourMinutes ?? Infinity;
      if (da !== dbv) return da - dbv;
      return a.date.localeCompare(b.date);
    });

  const primary = routeOptimalSlots.slice(0, opts.maxResults);
  const primaryIds = new Set(primary.map((s) => s.slotId));

  // Expander: everything else (route-optimal leftovers + non-route-optimal
  // mixed), sorted by date asc, capped.
  const expander = classified
    .filter((s) => !primaryIds.has(s.slotId))
    .sort((a, b) => a.date.localeCompare(b.date) || a.windowStart.localeCompare(b.windowStart))
    .slice(0, opts.expanderMaxResults);

  const result = {
    primary,
    expander,
    metadata: {
      estimateAddress: estimate.address || null,
      estimateCoords: { lat: coords.lat, lng: coords.lng },
      coordsSource: coords.source,
      windowDays: opts.windowDays,
      proximityDriveMinutes: opts.proximityDriveMinutes,
      generatedAt: new Date().toISOString(),
      cacheHit: false,
      // TODO: PR B's accept-handler invalidates this cache on every new
      // scheduled_services insert. For now, the 5-min TTL is the only
      // staleness guard.
    },
  };

  wrapperCache.set(cacheKey, { result, expiresAt: Date.now() + WRAPPER_TTL_MS });
  return result;
}

// ---------- admin debug variant ----------

async function getSlotDebug(estimateId, userOpts = {}) {
  const opts = { ...DEFAULT_OPTS, ...userOpts };
  const estimate = await db('estimates').where({ id: estimateId }).first();
  if (!estimate) {
    const err = new Error('estimate not found');
    err.code = 'ESTIMATE_NOT_FOUND';
    throw err;
  }

  const startedAt = Date.now();
  const geocodeBefore = geocodeCache.size;
  const coords = await resolveEstimateCoords(estimate);
  const geocodeAfter = geocodeCache.size;

  if (!coords) {
    return {
      estimate: { id: estimate.id, token: estimate.token, status: estimate.status, address: estimate.address },
      error: 'could not resolve estimate coordinates',
      computeTimeMs: Date.now() - startedAt,
    };
  }

  const today = new Date();
  const dateFrom = today.toISOString().slice(0, 10);
  const end = new Date(today.getTime() + opts.windowDays * 86400000);
  const dateTo = end.toISOString().slice(0, 10);

  const raw = await findAvailableSlots({
    lat: coords.lat,
    lng: coords.lng,
    durationMinutes: opts.durationMinutes,
    dateFrom,
    dateTo,
    topN: 200, // broad — debug surface wants everything
  });

  const classified = (raw?.slots || []).map((s) => ({
    ...classifySlot(s, opts.proximityDriveMinutes),
    raw: {
      score: s.score,
      detour_minutes: s.detour_minutes,
      baseline_drive_minutes: s.baseline_drive_minutes,
      total_drive_minutes: s.total_drive_minutes,
      insertion: s.insertion,
      stops_that_day: s.stops_that_day,
    },
  }));

  return {
    estimate: {
      id: estimate.id,
      token: estimate.token,
      status: estimate.status,
      address: estimate.address,
      customerId: estimate.customer_id,
    },
    coords,
    window: { dateFrom, dateTo, durationMinutes: opts.durationMinutes },
    proximityDriveMinutes: opts.proximityDriveMinutes,
    rawEvaluated: raw?.evaluated || 0,
    rawTotalFeasible: raw?.total_feasible || 0,
    routeOptimalCount: classified.filter((s) => s.routeOptimal).length,
    cacheSnapshot: {
      wrapperEntries: wrapperCache.size,
      geocodeEntries: geocodeAfter,
      geocodeMissedThisRequest: geocodeAfter > geocodeBefore ? 1 : 0,
    },
    computeTimeMs: Date.now() - startedAt,
    slots: classified,
  };
}

// Narrow cache invalidation for PR B's accept handler — one slot booking
// on estimate X means estimate X's cached slot list is stale, but nothing
// else is. Scans all cache entries and drops anything keyed to this
// estimate (across all hour buckets — the key shape is `${estimateId}:${hour}`).
function invalidateEstimate(estimateId) {
  if (!estimateId) return 0;
  const prefix = `${estimateId}:`;
  let dropped = 0;
  for (const k of wrapperCache.keys()) {
    if (k.startsWith(prefix)) { wrapperCache.delete(k); dropped++; }
  }
  return dropped;
}

module.exports = {
  getAvailableSlots,
  getSlotDebug,
  invalidateEstimate,
  // Exposed for tests — don't rely on them in app code.
  _internals: {
    parseAnchorTime,
    pickNearbyAnchor,
    classifySlot,
    clearCaches() { wrapperCache.clear(); geocodeCache.clear(); },
  },
};
