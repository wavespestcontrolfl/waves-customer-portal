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
 *   }
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { findAvailableSlots } = require('../services/scheduling/find-time');
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
    } = req.body || {};

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

    const result = await findAvailableSlots({
      lat: target.lat,
      lng: target.lng,
      durationMinutes: Math.max(15, parseInt(durationMinutes, 10) || 60),
      dateFrom: from,
      dateTo: clampedTo,
      technicianId: technicianId || undefined,
      topN: Math.min(Math.max(parseInt(topN, 10) || 10, 1), 100),
    });

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
