// DEPRECATED — replaced by referrals-v2.js (Clicki integration + promoter payouts)
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');

router.use(authenticate);

// =========================================================================
// GET /api/referrals — Full referral data for the customer
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const customer = await db('customers')
      .where({ id: req.customerId })
      .select('referral_code', 'first_name')
      .first();

    const referrals = await db('referrals')
      .where({ referrer_customer_id: req.customerId })
      .orderBy('created_at', 'desc');

    const total = referrals.length;
    const converted = referrals.filter(r => r.status === 'signed_up' || r.status === 'credited').length;
    const credited = referrals.filter(r => r.status === 'credited').length;
    const totalEarned = referrals
      .filter(r => r.referrer_credited)
      .reduce((sum, r) => sum + parseFloat(r.credit_amount || 0), 0);

    res.json({
      referralCode: customer.referral_code,
      shareLink: `https://wavespestcontrol.com?ref=${customer.referral_code}`,
      stats: {
        totalReferrals: total,
        converted,
        credited,
        totalEarned,
      },
      referrals: referrals.map(r => ({
        id: r.id,
        refereeName: r.referee_name,
        refereePhone: r.referee_phone ? maskPhone(r.referee_phone) : null,
        status: r.status,
        creditAmount: parseFloat(r.credit_amount),
        referrerCredited: r.referrer_credited,
        createdAt: r.created_at,
        convertedAt: r.converted_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /api/referrals/stats — Lightweight stats for dashboard card
// =========================================================================
router.get('/stats', async (req, res, next) => {
  try {
    const customer = await db('customers')
      .where({ id: req.customerId })
      .select('referral_code')
      .first();

    const referrals = await db('referrals')
      .where({ referrer_customer_id: req.customerId });

    const totalEarned = referrals
      .filter(r => r.referrer_credited)
      .reduce((sum, r) => sum + parseFloat(r.credit_amount || 0), 0);

    res.json({
      referralCode: customer.referral_code,
      totalReferrals: referrals.length,
      totalEarned,
    });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /api/referrals — Submit a new referral
// =========================================================================
router.post('/', async (req, res, next) => {
  try {
    const { refereeName, refereePhone, refereeEmail } = req.body;

    if (!refereeName || !refereePhone) {
      return res.status(400).json({ error: 'Name and phone number are required' });
    }

    const customer = await db('customers')
      .where({ id: req.customerId })
      .select('referral_code', 'first_name')
      .first();

    if (!customer.referral_code) {
      return res.status(400).json({ error: 'No referral code found' });
    }

    // Check for duplicate phone
    const existing = await db('referrals')
      .where({ referrer_customer_id: req.customerId, referee_phone: refereePhone.trim() })
      .first();

    if (existing) {
      return res.status(409).json({ error: 'You\'ve already referred this phone number' });
    }

    const [referral] = await db('referrals')
      .insert({
        referrer_customer_id: req.customerId,
        referee_name: refereeName.trim(),
        referee_phone: refereePhone.trim(),
        referee_email: refereeEmail?.trim() || null,
        referral_code: customer.referral_code,
        status: 'pending',
      })
      .returning('*');

    // Send SMS to referee
    try {
      await TwilioService.sendSMS(
        refereePhone.trim(),
        `Hi ${refereeName.trim()}! Your neighbor ${customer.first_name} thinks you'd love Waves Pest Control 🌊\n\n` +
        `You'll both get $25 off when you sign up for any WaveGuard plan.\n\n` +
        `Get a free quote: https://wavespestcontrol.com?ref=${customer.referral_code}\n\n` +
        `Or call us: (941) 318-7612`
      );

      // Update status to contacted
      await db('referrals')
        .where({ id: referral.id })
        .update({ status: 'contacted' });
    } catch (smsErr) {
      logger.error(`Failed to send referral SMS: ${smsErr.message}`);
      // Still counts as pending even if SMS fails
    }

    res.status(201).json({
      success: true,
      referral: {
        id: referral.id,
        refereeName: referral.referee_name,
        status: 'contacted',
      },
    });
  } catch (err) {
    next(err);
  }
});

function maskPhone(phone) {
  if (!phone || phone.length < 6) return phone;
  return phone.slice(0, -4).replace(/\d/g, '•') + phone.slice(-4);
}

module.exports = router;
