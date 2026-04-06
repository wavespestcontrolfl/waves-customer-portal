/**
 * Estimate Follow-Up Service
 *
 * Auto-sends follow-up SMS to customers who:
 *   - Received an estimate but haven't viewed it (24h)
 *   - Viewed an estimate but haven't accepted (48h, 5d)
 *   - Estimate is about to expire (5 days before)
 *
 * Runs via cron every 2 hours.
 */

const db = require('../models/db');
const TwilioService = require('./twilio');
const logger = require('./logger');

const EstimateFollowUp = {
  async checkAll() {
    let sent = 0;

    // 1. Sent but NOT viewed after 24 hours
    try {
      const unviewed = await db('estimates')
        .where({ status: 'sent' })
        .whereNull('viewed_at')
        .where('sent_at', '<', new Date(Date.now() - 24 * 3600000))
        .where('sent_at', '>', new Date(Date.now() - 48 * 3600000))
        .whereNotNull('customer_phone')
        .whereRaw('COALESCE(follow_up_count, 0) < 1');

      for (const est of unviewed) {
        try {
          const firstName = (est.customer_name || '').split(' ')[0] || 'there';
          const url = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
          await TwilioService.sendSMS(est.customer_phone,
            `Hey ${firstName}! Just wanted to make sure you saw your Waves Pest Control estimate 🌊\n\n${url}\n\nTake a look when you get a chance — we're here if you have any questions! (941) 318-7612`
          );
          await db('estimates').where({ id: est.id }).update({
            follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
            last_follow_up_at: db.fn.now(),
          });
          sent++;
        } catch (e) { logger.error(`[est-followup] Unviewed SMS failed: ${e.message}`); }
      }
    } catch { /* columns may not exist */ }

    // 2. Viewed but NOT accepted after 48 hours
    try {
      const viewedNotAccepted = await db('estimates')
        .where({ status: 'viewed' })
        .whereNotNull('viewed_at')
        .where('viewed_at', '<', new Date(Date.now() - 48 * 3600000))
        .where('viewed_at', '>', new Date(Date.now() - 72 * 3600000))
        .whereNotNull('customer_phone')
        .whereRaw('COALESCE(follow_up_count, 0) < 2');

      for (const est of viewedNotAccepted) {
        try {
          const firstName = (est.customer_name || '').split(' ')[0] || 'there';
          const url = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
          await TwilioService.sendSMS(est.customer_phone,
            `Hi ${firstName}! I noticed you checked out your Waves estimate — any questions I can answer? 🌊\n\n${url}\n\nI'm happy to walk through it with you. Just reply here or call (941) 318-7612.\n\n— Adam, Waves Pest Control`
          );
          await db('estimates').where({ id: est.id }).update({
            follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
            last_follow_up_at: db.fn.now(),
          });
          sent++;
        } catch (e) { logger.error(`[est-followup] Viewed-not-accepted SMS failed: ${e.message}`); }
      }
    } catch { /* columns may not exist */ }

    // 3. Viewed but NOT accepted after 5 days (final nudge)
    try {
      const finalNudge = await db('estimates')
        .where({ status: 'viewed' })
        .whereNotNull('viewed_at')
        .where('viewed_at', '<', new Date(Date.now() - 5 * 86400000))
        .where('viewed_at', '>', new Date(Date.now() - 6 * 86400000))
        .whereNotNull('customer_phone')
        .whereRaw('COALESCE(follow_up_count, 0) < 3');

      for (const est of finalNudge) {
        try {
          const firstName = (est.customer_name || '').split(' ')[0] || 'there';
          const url = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
          await TwilioService.sendSMS(est.customer_phone,
            `Hey ${firstName} — last check-in from me! Your Waves estimate is still available:\n\n${url}\n\nWe'd love to earn your business. No pressure at all — just reply if you'd like to move forward or have any questions.\n\n— Adam 🌊`
          );
          await db('estimates').where({ id: est.id }).update({
            follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
            last_follow_up_at: db.fn.now(),
          });
          sent++;
        } catch (e) { logger.error(`[est-followup] Final nudge SMS failed: ${e.message}`); }
      }
    } catch { /* columns may not exist */ }

    // 4. Expiring in 5 days
    try {
      const expiring = await db('estimates')
        .whereIn('status', ['sent', 'viewed'])
        .whereNotNull('expires_at')
        .whereNotNull('customer_phone')
        .whereBetween('expires_at', [
          new Date(Date.now() + 4 * 86400000),
          new Date(Date.now() + 6 * 86400000),
        ])
        .whereRaw('COALESCE(follow_up_count, 0) < 4');

      for (const est of expiring) {
        try {
          const firstName = (est.customer_name || '').split(' ')[0] || 'there';
          const url = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
          const expDate = new Date(est.expires_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
          await TwilioService.sendSMS(est.customer_phone,
            `Hi ${firstName}! Just a heads up — your Waves Pest Control estimate expires on ${expDate}.\n\n${url}\n\nLet us know if you'd like to move forward! (941) 318-7612 🌊`
          );
          await db('estimates').where({ id: est.id }).update({
            follow_up_count: db.raw('COALESCE(follow_up_count, 0) + 1'),
            last_follow_up_at: db.fn.now(),
          });
          sent++;
        } catch (e) { logger.error(`[est-followup] Expiry reminder failed: ${e.message}`); }
      }
    } catch { /* columns may not exist */ }

    if (sent > 0) logger.info(`[est-followup] Sent ${sent} follow-up SMS`);
    return { sent };
  },
};

module.exports = EstimateFollowUp;
