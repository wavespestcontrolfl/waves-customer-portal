/**
 * Bouncie GPS webhook — Live Service Tracking (PR #52 Phase 2).
 *
 * Separate from the existing /api/bouncie/webhook (mileage + geofence).
 * This receiver's job is to keep `vehicle_locations` fresh for the
 * public /track/:token map. Two webhooks on purpose — mileage and
 * tracking have different failure modes and shouldn't cascade.
 *
 * Verification: Bouncie's public docs are sparse on how the secret is
 * transmitted (header vs body, header name). Receiver accepts both
 * `x-webhook-key` header and `webhookKey` body field, logs which was
 * used on the first successful verify. If the first real event shows
 * a different mechanism we can tighten the check later.
 *
 * Event model:
 *   - trip-start / trip-data / trip-end / trip-metrics / connect / disconnect
 *   - IMEI resolved to a technician row; unknown IMEI = log-warn-and-return 200.
 *   - Raw payload logged to bouncie_webhook_log BEFORE processing so a
 *     handler crash can't lose the event.
 *   - Responds 200 synchronously, processes via setImmediate.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');

// ---------- verification ----------

function verifyKey(req) {
  const expected = process.env.BOUNCIE_WEBHOOK_SECRET;
  if (!expected) {
    return { ok: false, reason: 'no-secret-configured', from: null };
  }
  const headerKey = req.get('x-webhook-key');
  if (headerKey && headerKey === expected) return { ok: true, from: 'header' };
  const bodyKey = req.body && (req.body.webhookKey || req.body.webhook_key);
  if (bodyKey && bodyKey === expected) return { ok: true, from: 'body' };
  const queryKey = req.query && req.query.key;
  if (queryKey && queryKey === expected) return { ok: true, from: 'query' };
  return { ok: false, reason: 'mismatch', from: null };
}

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
    payload.deviceId ||
    (payload.vehicle && payload.vehicle.imei) ||
    (payload.data && !Array.isArray(payload.data) && payload.data.imei) ||
    ''
  );
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
          .update({ error: `unknown IMEI ${imei || '(missing)'}` })
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
        // TODO: persist distance/duration once the mileage consumer is ready
        // to read from tracking events. Today the existing /api/bouncie
        // webhook (tripCompleted) is the mileage system of record.
        break;
      }
      default: {
        point = pickPoint(payload);
      }
    }

    if (point) {
      await upsertLocation(tech.bouncie_imei, point);
    }

    if (logId) {
      await db('bouncie_webhook_log')
        .where('id', logId)
        .update({ processed: true })
        .catch(() => {});
    }

    await db('tool_executions')
      .insert({
        tool_name: 'bouncie_tracking_webhook',
        args: JSON.stringify({ eventType, imei, technician_id: tech.id }),
        result: JSON.stringify({ updated: !!point }),
        executed_at: new Date(),
      })
      .catch(() => {});
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

// GET /api/webhooks/bouncie/ping?key=<secret>
router.get('/ping', (req, res) => {
  const expected = process.env.BOUNCIE_WEBHOOK_SECRET;
  if (!expected || req.query.key !== expected) {
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// POST /api/webhooks/bouncie
router.post('/', async (req, res) => {
  const verify = verifyKey(req);
  if (!verify.ok) {
    logger.warn(`[webhooks-bouncie] rejected event: ${verify.reason}`);
    return res.status(401).json({ ok: false });
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
        payload: JSON.stringify(payload),
        processed: false,
      })
      .returning('id');
    logId = row && (row.id || row);
  } catch (logErr) {
    logger.error(`[webhooks-bouncie] failed to log event: ${logErr.message}`);
  }

  logger.info(
    `[webhooks-bouncie] accepted ${eventType} imei=${imei || '(missing)'} key=${verify.from}`
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
