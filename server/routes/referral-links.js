/**
 * Referral Link Route — public (no auth)
 * Handles /r/:code click tracking and redirect
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const crypto = require('crypto');
const logger = require('../services/logger');

// =========================================================================
// GET /r/:code — track click and redirect
// =========================================================================
router.get('/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const ua = req.headers['user-agent'] || '';
    const referer = req.headers['referer'] || '';

    // Find promoter by referral_code
    const promoter = await db('referral_promoters')
      .where({ referral_code: code, status: 'active' })
      .first();

    if (!promoter) {
      // Fallback: check customers.referral_code
      const customer = await db('customers').where({ referral_code: code }).first();
      if (customer) {
        return res.redirect(`https://wavespestcontrol.com/?ref=${code}&utm_source=referral`);
      }
      return res.redirect('https://wavespestcontrol.com');
    }

    // Generate fingerprint for dedup (IP + UA hash)
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${ip}|${ua}`)
      .digest('hex')
      .slice(0, 64);

    // Dedup: check for same fingerprint within 24 hours
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentClick = await db('referral_clicks')
      .where({ promoter_id: promoter.id, fingerprint })
      .where('created_at', '>=', twentyFourHoursAgo)
      .first();

    const isUnique = !recentClick;

    // Detect device type
    let deviceType = 'desktop';
    if (/mobile|android|iphone|ipad/i.test(ua)) {
      deviceType = /ipad|tablet/i.test(ua) ? 'tablet' : 'mobile';
    }

    // Record click
    await db('referral_clicks').insert({
      promoter_id: promoter.id,
      click_ip: ip,
      click_geo: null,
      click_source: referer || null,
      referral_code: code,
      user_agent: ua.slice(0, 500),
      referer_url: referer.slice(0, 500),
      device_type: deviceType,
      is_unique: isUnique,
      fingerprint,
      raw_payload: JSON.stringify({ ip, ua: ua.slice(0, 200), referer: referer.slice(0, 200) }),
    });

    // Increment promoter total_clicks only for unique clicks
    if (isUnique) {
      await db('referral_promoters')
        .where({ id: promoter.id })
        .increment({ total_clicks: 1 });
    }

    logger.info(`[ReferralLink] Click on ${code} from ${ip} (${isUnique ? 'unique' : 'repeat'})`);

    // Redirect to main site with ref param
    res.redirect(`https://wavespestcontrol.com/?ref=${code}&utm_source=referral`);
  } catch (err) {
    logger.error(`[ReferralLink] Error: ${err.message}`);
    res.redirect('https://wavespestcontrol.com');
  }
});

module.exports = router;
