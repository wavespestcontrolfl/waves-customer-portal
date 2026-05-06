/**
 * Bouncie GPS webhook — Live Service Tracking (PR #52 Phase 2).
 *
 * Separate from the existing /api/bouncie/webhook (mileage + geofence).
 * This receiver's job is to keep `vehicle_locations` fresh for the
 * public /track/:token map. Two webhooks on purpose — mileage and
 * tracking have different failure modes and shouldn't cascade.
 *
 * Verification is fail-closed by default. Configure
 * BOUNCIE_WEBHOOK_SECRET and send it via x-webhook-key or
 * x-bouncie-webhook-key. Temporary rollout escape hatch:
 * BOUNCIE_WEBHOOK_VERIFICATION=log accepts mismatches while logging them.
 *
 * Event model:
 *   - trip-start / trip-data / trip-end / trip-metrics / connect / disconnect
 *   - IMEI resolved to a technician row; unknown IMEI = log, mark processed, return 200.
 *   - Raw payload logged to bouncie_webhook_log BEFORE processing so a
 *     handler crash can't lose the event.
 *   - Responds 200 synchronously, processes via setImmediate.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const mileageService = require('../services/bouncie-mileage');
const { pingTechLocation } = require('../services/tech-status');
const {
  inspectBouncieWebhook,
  stringifyBounciePayload,
} = require('../services/bouncie-webhook-security');

// ---------- normalization ----------

function pickLatestSample(payload) {
  // trip-data arrives as { data: [{ timestamp, lat, lon, ... }, ...] }.
  // Pick the sample with the highest timestamp so a repeated batch can't
  // rewind our last-known position.
  const arr = Array.isArray(payload.data) ? payload.data : null;
  if (!arr || arr.length === 0) return null;
  let best = arr[0];
  let bestMs = Date.parse(best.timestamp || best.ts || 0) || 0;
  for (let i = 1; i < arr.length; i++) {
    const s = arr[i];
    const ms = Date.parse(s.timestamp || s.ts || 0) || 0;
    if (ms > bestMs) {
      best = s;
      bestMs = ms;
    }
  }
  return best;
}

function extractImei(payload) {
  return (
    payload.imei ||
    payload.vehicleId ||
    payload.vehicle_id ||
    payload.deviceId ||
    payload.device_id ||
    (payload.vehicle && payload.vehicle.imei) ||
    (payload.data && !Array.isArray(payload.data) && (
      payload.data.imei ||
      payload.data.vehicleId ||
      payload.data.vehicle_id ||
      payload.data.deviceId ||
      payload.data.device_id
    )) ||
    ''
  );
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '');
}

function metersFromPayload(source) {
  const meters = num(firstPresent(
    source.distance_meters,
    source.distanceMeters,
    source.distance
  ));
  if (meters != null) return meters;

  const miles = num(firstPresent(
    source.distance_miles,
    source.distanceMiles,
    source.miles
  ));
  return miles != null ? miles / 0.000621371 : null;
}

function secondsFromPayload(source) {
  const seconds = num(firstPresent(
    source.duration_seconds,
    source.durationSeconds,
    source.duration
  ));
  if (seconds != null) return seconds;

  const minutes = num(firstPresent(
    source.duration_minutes,
    source.durationMinutes,
    source.minutes
  ));
  return minutes != null ? minutes * 60 : null;
}

function pickPoint(source) {
  // Bouncie uses `lat`/`lon` in trip data, sometimes `latitude`/`longitude`.
  if (!source) return null;
  const lat = num(source.lat != null ? source.lat : source.latitude);
  const lng = num(source.lon != null ? source.lon : source.longitude);
  if (lat == null || lng == null) return null;
  return {
    lat,
    lng,
    heading: num(source.heading != null ? source.heading : source.bearing),
    speed_mph: num(source.speed != null ? source.speed : source.speed_mph),
    ignition: typeof source.ignition === 'boolean' ? source.ignition : null,
    reported_at: source.timestamp || source.ts || null,
  };
}

function normalizeTripMetricsPayload(payload, imei) {
  const source = payload.data && !Array.isArray(payload.data) ? payload.data : payload;
  const distance = metersFromPayload(source);
  const duration = secondsFromPayload(source);
  const hasTripMetric = distance != null || duration != null;
  if (!hasTripMetric) return null;
  const transactionId = firstPresent(
    source.transactionId,
    source.transaction_id,
    source.tripId,
    source.trip_id,
    source.id,
    payload.transactionId,
    payload.transaction_id,
    payload.tripId,
    payload.trip_id,
    payload.id
  );
  if (!transactionId) return null;

  return {
    eventType: 'tripCompleted',
    imei,
    data: {
      ...source,
      imei,
      vehicleId: firstPresent(source.vehicleId, source.vehicle_id, payload.vehicleId, payload.vehicle_id, imei),
      transactionId,
      startTime: firstPresent(source.startTime, source.start_time, payload.startTime, payload.start_time, source.startedAt, source.started_at),
      endTime: firstPresent(source.endTime, source.end_time, payload.endTime, payload.end_time, source.endedAt, source.ended_at),
      distance: distance ?? 0,
      duration: duration ?? 0,
      startLocation: firstPresent(source.startLocation, source.start_location, payload.startLocation, payload.start_location),
      endLocation: firstPresent(source.endLocation, source.end_location, payload.endLocation, payload.end_location),
    },
  };
}

// ---------- persistence ----------

async function upsertLocation(imei, point) {
  if (!imei || !point) return;
  await db.raw(
    `INSERT INTO vehicle_locations
       (bouncie_imei, lat, lng, heading, speed_mph, ignition, reported_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
     ON CONFLICT (bouncie_imei) DO UPDATE SET
       lat = EXCLUDED.lat,
       lng = EXCLUDED.lng,
       heading = EXCLUDED.heading,
       speed_mph = EXCLUDED.speed_mph,
       ignition = EXCLUDED.ignition,
       reported_at = EXCLUDED.reported_at,
       updated_at = NOW()`,
    [
      imei,
      point.lat,
      point.lng,
      point.heading,
      point.speed_mph,
      point.ignition,
      point.reported_at ? new Date(point.reported_at) : new Date(),
    ]
  );
}

async function resolveTechnician(imei) {
  if (!imei) return null;
  try {
    const tech = await db('technicians')
      .where({ bouncie_imei: imei })
      .first('id', 'name', 'bouncie_imei', 'active');
    return tech || null;
  } catch (err) {
    logger.error(`[webhooks-bouncie] technician lookup failed: ${err.message}`);
    return null;
  }
}

// ---------- event processing ----------

async function processTrackingEvent({ logId, eventType, payload }) {
  try {
    const imei = extractImei(payload);
    const tech = await resolveTechnician(imei);
    if (!tech) {
      logger.warn(`[webhooks-bouncie] unknown IMEI ${imei || '(missing)'} for event ${eventType}`);
      if (logId) {
        await db('bouncie_webhook_log')
          .where('id', logId)
          .update({ processed: true, error: `unknown IMEI ${imei || '(missing)'}` })
          .catch(() => {});
      }
      return;
    }

    let point = null;
    switch (eventType) {
      case 'trip-start':
      case 'trip-end':
      case 'connect':
      case 'disconnect': {
        point = pickPoint(payload) || pickPoint(payload.location) || pickPoint(payload.position);
        break;
      }
      case 'trip-data': {
        const sample = pickLatestSample(payload) || pickLatestSample(payload.samples);
        point = pickPoint(sample);
        break;
      }
      case 'trip-metrics': {
        const metricsEvent = normalizeTripMetricsPayload(payload, tech.bouncie_imei);
        if (metricsEvent) {
          await mileageService.processTripWebhook(metricsEvent);
        }
        break;
      }
      default: {
        point = pickPoint(payload);
      }
    }

    if (point) {
      await upsertLocation(tech.bouncie_imei, point);

      // Also keep tech_status fresh so the dispatch board's left-pane
      // roster + map markers update in real-time. pingTechLocation
      // preserves semantic statuses (en_route / on_site / wrapping_up)
      // so an admin's flip won't get clobbered by the next Bouncie
      // ping a minute later — see services/tech-status.js header.
      // Wrapped in catch so a tech_status failure doesn't kill the
      // log-mark-processed update below; the GPS history in
      // vehicle_locations is already committed at this point and is
      // the system of record for the customer-facing track map.
      try {
        await pingTechLocation({
          tech_id: tech.id,
          lat: point.lat,
          lng: point.lng,
          ignition: point.ignition,
          speed_mph: point.speed_mph,
        });
      } catch (err) {
        logger.error(`[webhooks-bouncie] pingTechLocation failed: ${err.message}`);
      }
    }

    if (logId) {
      await db('bouncie_webhook_log')
        .where('id', logId)
        .update({ processed: true })
        .catch(() => {});
    }
  } catch (err) {
    logger.error(`[webhooks-bouncie] processing error: ${err.message}`);
    if (logId) {
      await db('bouncie_webhook_log')
        .where('id', logId)
        .update({ error: err.message })
        .catch(() => {});
    }
  }
}

// ---------- routes ----------

// GET /api/webhooks/bouncie/ping  (header: x-webhook-key)
// Header-only on purpose: query strings leak into Railway access logs and
// any upstream proxy logs, so the secret can't ride in the URL.
router.get('/ping', (req, res) => {
  const verify = inspectBouncieWebhook(req);
  if (!verify.accepted || !verify.matched) {
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// POST /api/webhooks/bouncie
router.post('/', async (req, res) => {
  const verify = inspectBouncieWebhook(req);
  if (!verify.accepted) {
    logger.warn(`[webhooks-bouncie] secret ${verify.reason} — rejected (${verify.mode})`);
    return res.status(401).json({ ok: false });
  }
  if (!verify.matched) {
    logger.warn(`[webhooks-bouncie] secret ${verify.reason} — accepted (${verify.mode})`);
  }

  const payload = req.body || {};
  const eventType =
    payload.eventType ||
    payload.event_type ||
    payload.event ||
    payload.type ||
    'unknown';
  const imei = extractImei(payload);

  let logId = null;
  try {
    const [row] = await db('bouncie_webhook_log')
      .insert({
        event_type: eventType,
        vehicle_imei: imei,
        payload: stringifyBounciePayload(payload),
        processed: false,
      })
      .returning('id');
    logId = row && (row.id || row);
  } catch (logErr) {
    logger.error(`[webhooks-bouncie] failed to log event: ${logErr.message}`);
  }

  logger.info(
    `[webhooks-bouncie] accepted ${eventType} imei=${imei || '(missing)'} key=${verify.from || 'none'}`
  );

  // Answer fast; process in the background so Bouncie never sees a slow 2xx.
  res.status(200).json({ ok: true });

  setImmediate(() => {
    processTrackingEvent({ logId, eventType, payload }).catch((err) => {
      logger.error(`[webhooks-bouncie] setImmediate error: ${err.message}`);
    });
  });
});

module.exports = router;

router._test = {
  normalizeTripMetricsPayload,
  processTrackingEvent,
};
