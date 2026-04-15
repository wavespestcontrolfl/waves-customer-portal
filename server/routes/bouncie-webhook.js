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
