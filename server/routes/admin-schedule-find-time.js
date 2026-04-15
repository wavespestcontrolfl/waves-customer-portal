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

router.use(adminAuthenticate, requireTechOrAdmin);

async function geocodeAddress(address) {
  const key = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('No Google Maps API key configured');
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Geocode failed: ${data.status}`);
  }
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}

router.post('/', async (req, res) => {
  try {
    const {
      customerId, address, lat, lng,
      durationMinutes, dateFrom, dateTo,
      technicianId, topN,
    } = req.body || {};

    let resolvedLat = lat != null ? parseFloat(lat) : null;
    let resolvedLng = lng != null ? parseFloat(lng) : null;
    let resolvedFrom = 'provided';

    if ((!resolvedLat || !resolvedLng) && customerId) {
      const c = await db('customers').where('id', customerId)
        .select('lat', 'lng', 'address_line1', 'city', 'state', 'zip').first();
      if (c?.lat && c?.lng) {
        resolvedLat = parseFloat(c.lat);
        resolvedLng = parseFloat(c.lng);
        resolvedFrom = 'customer_record';
      } else if (c) {
        // Fall back to geocoding the customer's address
        const addr = [c.address_line1, c.city, c.state, c.zip].filter(Boolean).join(', ');
        if (addr) {
          const geo = await geocodeAddress(addr);
          resolvedLat = geo.lat; resolvedLng = geo.lng;
          resolvedFrom = 'geocoded_customer_address';
          // Backfill onto the customer record for next time
          await db('customers').where('id', customerId).update({ lat: resolvedLat, lng: resolvedLng });
        }
      }
    }

    if ((!resolvedLat || !resolvedLng) && address) {
      const geo = await geocodeAddress(address);
      resolvedLat = geo.lat; resolvedLng = geo.lng;
      resolvedFrom = 'geocoded_address';
    }

    if (!resolvedLat || !resolvedLng) {
      return res.status(400).json({ error: 'Could not resolve lat/lng from customerId, address, or lat/lng params' });
    }

    const today = new Date().toISOString().split('T')[0];
    const weekOut = (() => {
      const d = new Date(); d.setDate(d.getDate() + 7);
      return d.toISOString().split('T')[0];
    })();

    const result = await findAvailableSlots({
      lat: resolvedLat,
      lng: resolvedLng,
      durationMinutes: durationMinutes ? parseInt(durationMinutes) : 60,
      dateFrom: dateFrom || today,
      dateTo: dateTo || weekOut,
      technicianId: technicianId || undefined,
      topN: topN ? parseInt(topN) : 10,
    });

    res.json({
      ...result,
      resolved_from: resolvedFrom,
      lat: resolvedLat,
      lng: resolvedLng,
    });
  } catch (err) {
    logger.error('[find-time] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
