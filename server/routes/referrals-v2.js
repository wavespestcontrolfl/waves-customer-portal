/**
 * Customer Referral Routes v2 — unified referral program
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const engine = require('../services/referral-engine');

router.use(authenticate);

// =========================================================================
// GET / — full referral data (auto-enrolls if needed)
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    // Auto-enroll as promoter if not already
    const { promoter } = await engine.enrollPromoter(req.customerId);

    const referrals = await db('referrals')
      .where(function () {
        this.where({ promoter_id: promoter.id })
          .orWhere({ referrer_customer_id: req.customerId });
      })
      .orderBy('created_at', 'desc');

    const settings = await engine.getSettings();

    const total = referrals.length;
    const converted = referrals.filter(r => ['signed_up', 'credited'].includes(r.status)).length;
    const pending = referrals.filter(r => ['pending', 'contacted'].includes(r.status)).length;

    // Milestone progress
    const milestones = [
      { level: 'advocate', threshold: 3, bonus: settings.milestone_3_bonus_cents },
      { level: 'ambassador', threshold: 5, bonus: settings.milestone_5_bonus_cents },
      { level: 'champion', threshold: 10, bonus: settings.milestone_10_bonus_cents },
    ];
    const currentLevel = promoter.milestone_level || 'none';
    const levelOrder = ['none', 'advocate', 'ambassador', 'champion'];
    const currentIdx = levelOrder.indexOf(currentLevel);
    const nextMilestone = milestones.find(m => levelOrder.indexOf(m.level) > currentIdx) || null;

    res.json({
      referralCode: promoter.referral_code,
      referralLink: promoter.referral_link,
      milestoneLevel: currentLevel,
      nextMilestone: nextMilestone ? {
        level: nextMilestone.level,
        threshold: nextMilestone.threshold,
        bonus: nextMilestone.bonus,
        progress: converted,
        remaining: Math.max(0, nextMilestone.threshold - converted),
      } : null,
      availableBalance: promoter.available_balance_cents || 0,
      pendingEarnings: promoter.pending_earnings_cents || 0,
      totalEarned: promoter.total_earned_cents || 0,
      totalPaidOut: promoter.total_paid_out_cents || 0,
      stats: {
        totalReferrals: total,
        converted,
        pending,
        totalClicks: promoter.total_clicks || 0,
      },
      referrals: referrals.map(r => ({
        id: r.id,
        name: r.referee_name || `${r.referral_first_name || ''} ${r.referral_last_name || ''}`.trim(),
        phone: maskPhone(r.referee_phone || r.referral_phone),
        status: r.status,
        rewardAmount: parseFloat(r.referrer_reward_amount || r.credit_amount || 0),
        rewardStatus: r.referrer_reward_status || (r.referrer_credited ? 'earned' : 'pending'),
        createdAt: r.created_at,
        convertedAt: r.converted_at,
      })),
      rewardPerReferral: settings.referrer_reward_cents / 100,
    });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /stats — lightweight stats for dashboard card
// =========================================================================
router.get('/stats', async (req, res, next) => {
  try {
    const promoter = await db('referral_promoters').where({ customer_id: req.customerId }).first();

    if (!promoter) {
      return res.json({
        totalReferrals: 0,
        totalEarned: 0,
        referralCode: null,
        enrolled: false,
      });
    }

    res.json({
      totalReferrals: promoter.total_referrals_sent || 0,
      totalConverted: promoter.total_referrals_converted || 0,
      totalEarned: promoter.total_earned_cents || 0,
      availableBalance: promoter.available_balance_cents || 0,
      referralCode: promoter.referral_code,
      referralLink: promoter.referral_link,
      milestoneLevel: promoter.milestone_level || 'none',
      enrolled: true,
    });
  } catch (err) { next(err); }
});

// =========================================================================
// POST / — submit a referral
// =========================================================================
router.post('/', async (req, res, next) => {
  try {
    const { name, phone, email, address, notes } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });

    // Ensure enrolled
    const { promoter } = await engine.enrollPromoter(req.customerId);

    const referral = await engine.submitReferral(promoter.id, {
      name, phone, email, address, notes, source: 'portal',
    });

    res.status(201).json({
      success: true,
      referral: {
        id: referral.id,
        name: referral.referee_name,
        status: referral.status || 'contacted',
        smsSent: referral.sms_sent,
      },
    });
  } catch (err) {
    if (err.message.includes('limit') || err.message.includes('already') || err.message.includes('Cannot') || err.message.includes('Waves customer')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// =========================================================================
// POST /invite — send invite SMS to a phone number
// =========================================================================
router.post('/invite', async (req, res, next) => {
  try {
    const { phone, friendName } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    const { promoter } = await engine.enrollPromoter(req.customerId);
    const settings = await engine.getSettings();

    const TwilioService = require('../services/twilio');
    const body = `Hi${friendName ? ` ${friendName}` : ''}! ${promoter.first_name} thinks you'd love Waves Pest Control. Get a free quote: ${promoter.referral_link || settings.base_url + promoter.referral_code} or call (941) 318-7612`;

    await TwilioService.sendSMS(phone.trim(), body, { messageType: 'referral_invite' });

    // Update share timestamp
    await db('referral_promoters').where({ id: promoter.id }).update({
      last_share_at: new Date(),
      updated_at: new Date(),
    });

    res.json({ success: true });
  } catch (err) {
    logger.error(`[Referrals] Invite SMS failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

function maskPhone(phone) {
  if (!phone || phone.length < 6) return phone;
  return phone.slice(0, -4).replace(/\d/g, '•') + phone.slice(-4);
}

module.exports = router;
