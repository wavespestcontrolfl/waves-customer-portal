/**
 * Find-a-Time endpoint — ranked slot recommendations.
 *
 * POST /api/admin/schedule/find-time
 *   body: {
 *     customerId?,            // resolves lat/lng from customer record
 *     address?,               // "123 Main St, Bradenton FL" — geocoded if no lat/lng
 *     lat?, lng?,             // direct coords (fastest)
 *     durationMinutes?,       // default 60
 *     dateFrom?, dateTo?,     // default: today → +7 days
 *     technicianId?,          // restrict to one tech
 *     topN?,                  // default 10
 *     excludeServiceIds?,     // drop these visits from occupancy (reschedule self-exclusion)
 *     slotStepMinutes?,       // snap starts to this granularity (1–120)
 *     hint?,                  // advisory best-times consumer — gated (GATE_BEST_TIME_HINTS)
 *   }
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { loadOccupancy, conflictsForTarget } = require('../services/rain-out');
const { gateEnvValue } = require('../config/feature-gates');
const { geocodeAddress, ensureCustomerGeocoded, buildAddress } = require('../services/geocoder');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');

const MAX_FIND_TIME_DAYS = 90;

router.use(adminAuthenticate, requireTechOrAdmin);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.isOperational = true;
  return err;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function isYmd(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = parseETDateTime(`${value}T12:00`);
  return Number.isFinite(parsed.getTime()) && etDateString(parsed) === value;
}

async function resolveFindTimeTarget({ customerId, address, lat, lng }) {
  let targetLat = finiteNumber(lat);
  let targetLng = finiteNumber(lng);
  let source = targetLat != null && targetLng != null ? 'request_coordinates' : null;
  let customer = null;
  let targetAddress = address || null;

  if (customerId && (targetLat == null || targetLng == null)) {
    customer = await db('customers')
      .where({ id: customerId })
      .first('id', 'latitude', 'longitude', 'address_line1', 'city', 'state', 'zip', 'profile_label');
    if (!customer) throw httpError(404, 'Customer not found');
    targetAddress = targetAddress || buildAddress(customer);
    const customerLat = finiteNumber(customer.latitude);
    const customerLng = finiteNumber(customer.longitude);
    if (customerLat != null && customerLng != null) {
      targetLat = customerLat;
      targetLng = customerLng;
      source = 'customer_geocode';
    } else {
      const geocoded = await ensureCustomerGeocoded(customerId);
      if (geocoded) {
        targetLat = geocoded.lat;
        targetLng = geocoded.lng;
        source = 'customer_geocoded_now';
      }
    }
  }

  if ((targetLat == null || targetLng == null) && targetAddress) {
    const geocoded = await geocodeAddress(targetAddress);
    if (geocoded) {
      targetLat = geocoded.lat;
      targetLng = geocoded.lng;
      source = 'address_geocoded_now';
    }
  }

  if (targetLat == null || targetLng == null) {
    throw httpError(400, 'Best-times search needs a service address with geocoded latitude/longitude');
  }

  return {
    lat: targetLat,
    lng: targetLng,
    address: targetAddress,
    source,
    customerId: customer?.id || customerId || null,
    profileLabel: customer?.profile_label || null,
  };
}

router.post('/', async (req, res) => {
  try {
    const {
      customerId, address, lat, lng,
      durationMinutes, dateFrom, dateTo,
      technicianId, topN,
      hint, excludeServiceIds, slotStepMinutes,
    } = req.body || {};

    // Best-time hint consumers go dark behind GATE_BEST_TIME_HINTS — read
    // at call time so a flip needs no redeploy (same kill-switch contract
    // as dispatch slot-check: gated:true, no search, pickers render exactly
    // as today). The Find-a-Time button never sends `hint`, so the existing
    // ranged search stays ungated.
    if (hint && !gateEnvValue('GATE_BEST_TIME_HINTS')) {
      return res.json({ ok: true, gated: true, slots: [] });
    }

    // Reschedule pickers exclude the visit's own current row so it can't
    // collide with itself. Same 25-id cap as dispatch slot-check.
    if (excludeServiceIds !== undefined) {
      const valid = Array.isArray(excludeServiceIds)
        && excludeServiceIds.length <= 25
        && excludeServiceIds.every((id) => (
          (typeof id === 'string' && id.trim() !== '')
          || (typeof id === 'number' && Number.isFinite(id))
        ));
      if (!valid) throw httpError(400, 'excludeServiceIds must be an array of up to 25 service ids');
    }
    if (slotStepMinutes !== undefined) {
      const step = Number(slotStepMinutes);
      if (!Number.isInteger(step) || step < 1 || step > 120) {
        throw httpError(400, 'slotStepMinutes must be an integer between 1 and 120');
      }
    }

    const today = etDateString();
    const from = dateFrom || today;
    if (!isYmd(from) || (dateTo && !isYmd(dateTo))) {
      throw httpError(400, 'dateFrom/dateTo must be valid YYYY-MM-DD dates');
    }
    const to = dateTo || etDateString(addETDays(parseETDateTime(`${from}T12:00`), 7));
    if (to < from) throw httpError(400, 'dateTo must be on or after dateFrom');
    const maxTo = etDateString(addETDays(parseETDateTime(`${from}T12:00`), MAX_FIND_TIME_DAYS));
    const clampedTo = to > maxTo ? maxTo : to;

    const target = await resolveFindTimeTarget({ customerId, address, lat, lng });

    const requestedTopN = Math.min(Math.max(parseInt(topN, 10) || 10, 1), 100);
    const result = await findAvailableSlots({
      lat: target.lat,
      lng: target.lng,
      durationMinutes: Math.max(15, parseInt(durationMinutes, 10) || 60),
      dateFrom: from,
      dateTo: clampedTo,
      technicianId: technicianId || undefined,
      // Hint mode over-fetches so the occupancy guard below can drop hours
      // without leaving the chips row short.
      topN: hint ? Math.min(requestedTopN * 3, 30) : requestedTopN,
      // undefined = the engine's own defaults ([] / exact-minute starts).
      excludeServiceIds,
      slotStepMinutes: slotStepMinutes !== undefined ? Number(slotStepMinutes) : undefined,
      // Staff tool: blackout days stay visible — admin manual scheduling is
      // deliberately unblocked (Settings blackouts gate CUSTOMER surfaces).
      includeBlackoutDates: true,
      // Same principle for Sundays: find-time's legacy default drops them,
      // which hid real weekend capacity from the staff picker.
      includeWeekends: true,
    });

    if (hint && Array.isArray(result?.slots) && result.slots.length) {
      // The engine walks per-technician routes, so a scheduled row with NO
      // assigned tech occupies no route and is invisible to it — an hour it
      // recommends can sit on an unassigned visit the commit will still
      // reject. Mirror the dispatch slot-check occupancy guard (tech-blind,
      // same overlap predicate, excludeServiceIds honored) and veto those
      // hours. The engine emits only the EARLIEST start per route gap, so a
      // vetoed candidate must not discard its whole gap — walk the gap
      // through latest_start_min at the request's step and keep the first
      // clear start (detour is position-independent within a gap). Fail-open
      // like checkSlots: a snapshot failure keeps the engine's answer —
      // this whole path is advisory.
      try {
        const occupancyByDate = new Map();
        await Promise.all([...new Set(result.slots.map((s) => s.date))].map(async (d) => {
          occupancyByDate.set(d, await loadOccupancy({ dateFrom: d, dateTo: d }));
        }));
        const excluded = (excludeServiceIds || []).map(String);
        const toMin = (hhmm) => {
          const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
          return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
        };
        const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
        const step = slotStepMinutes !== undefined ? Number(slotStepMinutes) : 1;
        const spanMin = Math.max(15, parseInt(durationMinutes, 10) || 60);
        result.slots = result.slots.flatMap((s) => {
          const baseMin = toMin(s.start_time);
          if (baseMin == null) return [];
          const latest = Number.isFinite(s.latest_start_min) ? s.latest_start_min : baseMin;
          for (let m = baseMin; m <= latest; m += step) {
            const window = { start: toHHMM(m), end: toHHMM(m + spanMin) };
            const clear = conflictsForTarget(
              occupancyByDate.get(s.date), null, s.date, window,
              { excludeServiceIds: excluded },
            ).length === 0;
            if (clear) {
              return [m === baseMin ? s : { ...s, start_time: window.start, end_time: window.end }];
            }
          }
          return [];
        });
      } catch (guardErr) {
        logger.warn('[find-time] hint occupancy guard failed (fail-open):', guardErr.message);
      }
      result.slots = result.slots.slice(0, requestedTopN);
    }

    res.json({
      ...result,
      target,
      range: { dateFrom: from, dateTo: clampedTo },
    });
  } catch (err) {
    logger.error('[find-time] failed:', err);
    res.status(err.statusCode || err.status || 500).json({ error: err.message || 'Find-time search failed' });
  }
});

module.exports = router;
