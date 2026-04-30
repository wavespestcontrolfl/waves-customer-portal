/**
 * Bouncie Webhook Route
 *
 * PUBLIC endpoint — no auth required.
 * Bouncie sends trip/vehicle events here.
 * All events are logged; tripCompleted events are processed.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const mileageService = require('../services/bouncie-mileage');
const geofenceHandler = require('../services/geofence-handler');

// POST /api/bouncie/webhook
router.post('/', async (req, res) => {
  // Always return 200 to Bouncie — never let errors cause retries
  try {
    const payload = req.body || {};
    const eventType = payload.eventType || payload.event_type || payload.type || 'unknown';
    const imei = payload.imei || payload.vehicleId || (payload.data && payload.data.imei) || '';

    // Key verification. Default non-strict: log mismatches, accept the event.
    // Set BOUNCIE_WEBHOOK_STRICT=true once Bouncie's side is confirmed sending
    // x-webhook-key — strict mode returns 401 on mismatch. Non-strict exists
    // because flipping straight to strict would 401 every in-flight event
    // the instant the secret lands in Railway, and Bouncie auto-deactivates
    // a webhook after enough non-2xx responses.
    const expected = process.env.BOUNCIE_WEBHOOK_SECRET;
    const strict = process.env.BOUNCIE_WEBHOOK_STRICT === 'true';
    if (expected) {
      const headerKey = req.get('x-webhook-key');
      const bodyKey = payload.webhookKey || payload.webhook_key;
      const ok = [headerKey, bodyKey].some((k) => k && k === expected);
      if (!ok) {
        if (strict) {
          logger.warn(`[bouncie-webhook] secret mismatch for ${eventType} imei=${imei} — rejected (strict)`);
          return res.status(401).json({ ok: false });
        }
        logger.warn(`[bouncie-webhook] secret mismatch for ${eventType} imei=${imei} — accepted anyway (non-strict)`);
      }
    } else if (strict) {
      logger.error('[bouncie-webhook] BOUNCIE_WEBHOOK_STRICT=true but BOUNCIE_WEBHOOK_SECRET unset — rejecting');
      return res.status(401).json({ ok: false });
    }

    // Log the webhook event
    let logId = null;
    try {
      const [log] = await db('bouncie_webhook_log')
        .insert({
          event_type: eventType,
          vehicle_imei: imei,
          payload: JSON.stringify(payload),
          processed: false,
        })
        .returning('id');
      logId = log.id || log;
    } catch (logErr) {
      logger.error(`[bouncie-webhook] Failed to log event: ${logErr.message}`);
    }

    // Process tripCompleted events
    if (eventType === 'tripCompleted' || eventType === 'trip.completed' || eventType === 'trip') {
      try {
        await mileageService.processTripWebhook(payload);

        // Mark webhook as processed
        if (logId) {
          await db('bouncie_webhook_log')
            .where('id', logId)
            .update({ processed: true });
        }

        logger.info(`[bouncie-webhook] Processed ${eventType} for ${imei}`);
      } catch (processErr) {
        logger.error(`[bouncie-webhook] Error processing ${eventType}: ${processErr.message}`);

        // Record the error but don't fail the response
        if (logId) {
          await db('bouncie_webhook_log')
            .where('id', logId)
            .update({ error: processErr.message });
        }
      }
    } else if (eventType === 'userGeozone' || eventType === 'geozone' || eventType === 'user.geozone') {
      try {
        await geofenceHandler.handleGeozoneEvent(payload);
        if (logId) {
          await db('bouncie_webhook_log').where('id', logId).update({ processed: true });
        }
        logger.info(`[bouncie-webhook] Processed userGeozone for ${imei}`);
      } catch (processErr) {
        logger.error(`[bouncie-webhook] Error processing userGeozone: ${processErr.message}`);
        if (logId) {
          await db('bouncie_webhook_log').where('id', logId).update({ error: processErr.message });
        }
      }
    } else {
      logger.info(`[bouncie-webhook] Received ${eventType} for ${imei} (not processed)`);
    }
  } catch (err) {
    logger.error(`[bouncie-webhook] Unhandled error: ${err.message}`);
  }

  // Always 200
  res.status(200).json({ received: true });
});

module.exports = router;
