const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const logger = require('../services/logger');

const WAVES_OFFICE_PHONE = '+19413187612';

// GET /api/estimates/:token — customer views estimate (no auth)
router.get('/:token', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    if (new Date(estimate.expires_at) < new Date() && estimate.status !== 'accepted') {
      return res.json({ expired: true, estimate: { address: estimate.address, customerName: estimate.customer_name } });
    }

    // Mark as viewed on first access
    if (!estimate.viewed_at) {
      await db('estimates').where({ id: estimate.id }).update({ viewed_at: db.fn.now(), status: 'viewed' });
    }

    const data = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : estimate.estimate_data;

    // ── Hormozi Grand Slam Offer enhancements ─────────────────────
    // Try to load offer package for this estimate's tier, fall back to defaults
    let offerPackage = null;
    try {
      offerPackage = await db('offer_packages')
        .where('status', 'active')
        .orderBy('created_at', 'desc')
        .first();
    } catch (_) { /* table may not exist yet */ }

    const guaranteeText = offerPackage?.guarantee_text
      || '100% Satisfaction Guarantee — If you\'re not completely satisfied after your first service, we\'ll re-treat for free or refund your money. No questions asked.';

    const bonuses = offerPackage?.bonuses
      ? (typeof offerPackage.bonuses === 'string' ? JSON.parse(offerPackage.bonuses) : offerPackage.bonuses)
      : [
          { name: 'Free Annual Termite Inspection', value: 185 },
          { name: 'Priority 24-Hour Scheduling', value: 0 },
          { name: '15% Off Any One-Time Treatment', value: 0 },
        ];

    // Anchor price = sum of individual service prices before WaveGuard bundle discount
    const monthlyTotal = parseFloat(estimate.monthly_total || 0);
    const tierDiscount = { Bronze: 0, Silver: 0.10, Gold: 0.15, Platinum: 0.20 };
    const discount = tierDiscount[estimate.waveguard_tier] || 0;
    const anchorPrice = discount > 0
      ? Math.round((monthlyTotal / (1 - discount)) * 100) / 100
      : Math.round(monthlyTotal * 1.25 * 100) / 100; // Bronze: show 25% "without WaveGuard" markup

    const savingsAmount = Math.round((anchorPrice - monthlyTotal) * 100) / 100;
    const bonusTotal = bonuses.reduce((sum, b) => sum + (b.value || 0), 0);
    const perceivedTotalValue = Math.round(((anchorPrice * 12) + bonusTotal) * 100) / 100;

    res.json({
      expired: false,
      estimate: {
        id: estimate.id,
        status: estimate.status,
        customerName: estimate.customer_name,
        address: estimate.address,
        monthlyTotal,
        annualTotal: parseFloat(estimate.annual_total || 0),
        onetimeTotal: parseFloat(estimate.onetime_total || 0),
        tier: estimate.waveguard_tier,
        data,
        createdAt: estimate.created_at,
        expiresAt: estimate.expires_at,
        // Hormozi value-stacking fields
        guaranteeText,
        bonuses,
        anchorPrice,
        savingsAmount,
        perceivedTotalValue,
      },
    });
  } catch (err) { next(err); }
});

// PUT /api/estimates/:token/accept — customer accepts
router.put('/:token/accept', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (estimate.status === 'accepted') return res.json({ success: true, alreadyAccepted: true });

    await db('estimates').where({ id: estimate.id }).update({ status: 'accepted', accepted_at: db.fn.now() });

    // Send acceptance SMS to customer (#5 — last Zapier zap replacement)
    if (estimate.customer_phone) {
      try {
        const firstName = (estimate.customer_name || '').split(' ')[0] || 'there';
        await TwilioService.sendSMS(estimate.customer_phone,
          `Hey ${firstName}! Great news — your Waves Pest Control estimate has been accepted! We'll be in touch shortly to schedule your first service. Questions? Reply here or call (941) 318-7612. — Waves 🌊`
        );
        logger.info(`[estimate-accept] Acceptance SMS sent to ${firstName} (${estimate.customer_phone})`);
      } catch (e) { logger.error(`[estimate-accept] Acceptance SMS failed: ${e.message}`); }
    }

    // Create customer if doesn't exist
    let customerId = estimate.customer_id;
    if (!customerId && estimate.customer_phone) {
      const existing = await db('customers').where({ phone: estimate.customer_phone }).first();
      if (existing) {
        customerId = existing.id;
      } else {
        const nameParts = (estimate.customer_name || 'New Customer').split(' ');
        const code = 'WAVES-' + Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
        const [newCust] = await db('customers').insert({
          first_name: nameParts[0] || 'New',
          last_name: nameParts.slice(1).join(' ') || 'Customer',
          phone: estimate.customer_phone,
          email: estimate.customer_email || null,
          address_line1: estimate.address || '',
          city: '', state: 'FL', zip: '',
          waveguard_tier: estimate.waveguard_tier || 'Bronze',
          monthly_rate: estimate.monthly_total || 0,
          member_since: new Date().toISOString().split('T')[0],
          referral_code: code,
        }).returning('*');
        customerId = newCust.id;
        await db('property_preferences').insert({ customer_id: customerId });
        await db('notification_prefs').insert({ customer_id: customerId });
      }
      await db('estimates').where({ id: estimate.id }).update({ customer_id: customerId });
    }

    // Trigger onboarding
    let onboardingToken = null;
    if (customerId) {
      const obToken = crypto.randomUUID();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      const data = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : estimate.estimate_data;
      const svcType = data?.recurring?.services?.map(s => s.name).join(' + ') || 'Pest Control';

      const [ob] = await db('onboarding_sessions').insert({
        customer_id: customerId,
        token: obToken,
        service_type: `WaveGuard ${estimate.waveguard_tier || 'Bronze'} — ${svcType}`,
        waveguard_tier: estimate.waveguard_tier,
        monthly_rate: estimate.monthly_total,
        status: 'started',
        expires_at: expiresAt,
      }).returning('*');

      await db('estimates').where({ id: estimate.id }).update({ onboarding_session_id: ob.id });
      onboardingToken = obToken;

      // Notify office
      try {
        await TwilioService.sendSMS(WAVES_OFFICE_PHONE,
          `🎉 Estimate accepted! ${estimate.customer_name} at ${estimate.address} — ${estimate.waveguard_tier || 'Bronze'} WaveGuard $${estimate.monthly_total}/mo. Onboarding link sent.`
        );
      } catch (e) { logger.error(`Estimate accept SMS failed: ${e.message}`); }
    }

    // Auto-convert estimate to active customer (Feature #5)
    if (customerId) {
      try {
        const EstimateConverter = require('../services/estimate-converter');
        await EstimateConverter.convertEstimate(estimate.id);
        logger.info(`[estimate-accept] Auto-conversion completed for estimate ${estimate.id}`);
      } catch (e) { logger.error(`[estimate-accept] Auto-conversion failed: ${e.message}`); }
    }

    res.json({ success: true, onboardingToken });
  } catch (err) { next(err); }
});

// PUT /api/estimates/:token/decline
router.put('/:token/decline', async (req, res, next) => {
  try {
    await db('estimates').where({ token: req.params.token }).update({ status: 'declined', declined_at: db.fn.now() });
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
