// DEPRECATED — replaced by referrals-v2.js (Clicki integration + promoter payouts)
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { authenticate } = require('../middleware/auth');
const logger = require('../services/logger');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

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
      const smsResult = await sendCustomerMessage({
        to: refereePhone.trim(),
        body: `Hi ${refereeName.trim()}! Your neighbor ${customer.first_name} thinks you'd love Waves Pest Control. Get a free quote: https://wavespestcontrol.com?ref=${customer.referral_code} or call us: (941) 318-7612`,
        channel: 'sms',
        audience: 'lead',
        purpose: 'referral',
        identityTrustLevel: 'phone_provided_unverified',
        consentBasis: {
          status: 'transactional_allowed',
          source: 'referral_invite_form',
          capturedAt: new Date().toISOString(),
        },
        entryPoint: 'referrals_legacy_invite',
        metadata: {
          original_message_type: 'referral_invite',
          referral_id: referral.id,
          referrer_customer_id: req.customerId,
        },
      });
      if (!smsResult.sent) {
        throw new Error(smsResult.reason || smsResult.code || 'SMS send blocked/failed');
      }

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
