const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const smsTemplatesRouter = require('./admin-sms-templates');
const logger = require('../services/logger');

const WAVES_OFFICE_PHONE = '+19413187612';

async function renderTemplate(templateKey, vars, fallback) {
  try {
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body) return body;
    }
  } catch { /* fall through */ }
  return fallback;
}

// GET /api/estimates/:token — customer views estimate (no auth)
router.get('/:token', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    if (new Date(estimate.expires_at) < new Date() && estimate.status !== 'accepted') {
      return res.json({ expired: true, estimate: { address: estimate.address, customerName: estimate.customer_name } });
    }

    // Track every view (count + last_viewed_at)
    try {
      await db('estimates').where({ id: estimate.id }).update({
        view_count: db.raw('COALESCE(view_count, 0) + 1'),
        last_viewed_at: db.fn.now(),
      });
    } catch (e) { logger.error(`[estimate-view] view tracking failed: ${e.message}`); }

    // First-view actions: set viewed_at/status, notify admin + SMS office
    if (!estimate.viewed_at) {
      await db('estimates').where({ id: estimate.id }).update({ viewed_at: db.fn.now(), status: 'viewed' });

      try {
        const NotificationService = require('../services/notification-service');
        await NotificationService.notifyAdmin('estimate', `Estimate viewed: ${estimate.customer_name}`, `${estimate.address || 'no address'} \u2014 $${estimate.monthly_total || 0}/mo`, { icon: '\u{1F4CB}', link: '/admin/estimates', metadata: { estimateId: estimate.id, customerId: estimate.customer_id } });
      } catch (e) { logger.error(`[notifications] Estimate viewed notification failed: ${e.message}`); }

      try {
        await TwilioService.sendSMS(WAVES_OFFICE_PHONE,
          `\u{1F440} ${estimate.customer_name} just opened their estimate ($${estimate.monthly_total || 0}/mo ${estimate.waveguard_tier || ''}). Great time to follow up! ${estimate.customer_phone || ''}`
        );
      } catch (e) { logger.error(`[estimate-view] office SMS failed: ${e.message}`); }
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
    const tierDiscount = { Bronze: 0, Silver: 0.10, Gold: 0.15, Platinum: 0.18 };
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

    const firstName = (estimate.customer_name || '').split(' ')[0] || 'there';

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
        const officeVars = {
          customer_name: estimate.customer_name || '',
          address: estimate.address || '',
          waveguard_tier: estimate.waveguard_tier || 'Bronze',
          monthly_total: estimate.monthly_total || 0,
        };
        const officeBody = await renderTemplate(
          'estimate_accepted_office',
          officeVars,
          `🎉 Estimate accepted! ${officeVars.customer_name} at ${officeVars.address} — ${officeVars.waveguard_tier} WaveGuard $${officeVars.monthly_total}/mo. Onboarding link sent.`
        );
        await TwilioService.sendSMS(WAVES_OFFICE_PHONE, officeBody);
      } catch (e) { logger.error(`Estimate accept SMS failed: ${e.message}`); }
    }

    // Send acceptance SMS to customer with onboarding link
    if (estimate.customer_phone) {
      try {
        const obUrl = onboardingToken ? `https://portal.wavespestcontrol.com/onboard/${onboardingToken}` : '';
        const customerBody = await renderTemplate(
          'estimate_accepted_customer',
          { first_name: firstName, onboarding_url: obUrl },
          `Hello ${firstName}! Thanks for approving your estimate. Complete your setup here so we can get you on the schedule: ${obUrl}`
        );
        await TwilioService.sendSMS(estimate.customer_phone, customerBody,
          { mediaUrl: 'https://www.wavespestcontrol.com/wp-content/uploads/2026/01/waves-pest-and-lawn-logo.png' }
        );
        logger.info(`[estimate-accept] Acceptance SMS sent to ${firstName} (${estimate.customer_phone})`);
      } catch (e) { logger.error(`[estimate-accept] Acceptance SMS failed: ${e.message}`); }
    }

    // In-app notifications for estimate accepted
    try {
      const NotificationService = require('../services/notification-service');
      await NotificationService.notifyAdmin('estimate', `Estimate accepted: ${estimate.customer_name}`, `${estimate.waveguard_tier || 'Bronze'} WaveGuard $${estimate.monthly_total}/mo`, { icon: '\u2705', link: '/admin/estimates', metadata: { estimateId: estimate.id, customerId } });
      if (customerId) {
        await NotificationService.notifyCustomer(customerId, 'account', 'Estimate accepted', `Your ${estimate.waveguard_tier || 'Bronze'} WaveGuard plan is confirmed. Complete onboarding to get started.`, { icon: '\u2705', link: '/onboarding' });
      }
    } catch (e) { logger.error(`[notifications] Estimate accepted notification failed: ${e.message}`); }

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

// PUT /api/estimates/:token/select-tier — customer selects a WaveGuard tier
router.put('/:token/select-tier', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (estimate.status === 'accepted') return res.status(400).json({ error: 'Estimate already accepted' });

    const { selectedTier } = req.body;
    const ALLOWED_TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum'];
    if (!selectedTier || !ALLOWED_TIERS.includes(selectedTier)) {
      return res.status(400).json({ error: 'selectedTier must be one of: ' + ALLOWED_TIERS.join(', ') });
    }

    const previousTier = estimate.waveguard_tier || 'Bronze';

    // Server-side pricing — never trust client totals
    const TIER_DISCOUNTS = { Bronze: 0, Silver: 0.10, Gold: 0.15, Platinum: 0.18 };
    let parsedData = {};
    try { parsedData = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : (estimate.estimate_data || {}); }
    catch { parsedData = {}; }

    const baseMonthly = Number(parsedData.baseMonthly || parsedData.preDiscountMonthly || estimate.monthly_total || 0);
    const discount = TIER_DISCOUNTS[selectedTier] || 0;
    const monthlyTotal = Math.round(baseMonthly * (1 - discount) * 100) / 100;
    const annualTotal = Math.round(monthlyTotal * 12 * 100) / 100;

    await db('estimates').where({ id: estimate.id }).update({
      waveguard_tier: selectedTier,
      monthly_total: monthlyTotal,
      annual_total: annualTotal,
      updated_at: db.fn.now(),
    });

    // Notify admin of tier selection
    try {
      const NotificationService = require('../services/notification-service');
      await NotificationService.notifyAdmin('estimate',
        `Tier upgrade: ${estimate.customer_name}`,
        `Selected ${selectedTier} (was ${previousTier}) \u2014 $${monthlyTotal}/mo`,
        { icon: '\u2B06\uFE0F', link: '/admin/estimates', metadata: { estimateId: estimate.id } }
      );
    } catch (e) { logger.error(`[estimate] Tier selection notification failed: ${e.message}`); }

    logger.info(`[estimate] ${estimate.customer_name} selected ${selectedTier} tier (was ${previousTier}) — $${monthlyTotal}/mo`);
    res.json({ success: true, tier: selectedTier, monthlyTotal, annualTotal });
  } catch (err) { next(err); }
});

// POST /api/estimates/:token/bundle-inquiry — customer interested in bundling
router.post('/:token/bundle-inquiry', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const { suggestedService } = req.body;

    // SMS to office
    try {
      await TwilioService.sendSMS(WAVES_OFFICE_PHONE,
        `\u{1F4E6} Bundle inquiry from ${estimate.customer_name}:\nCurrently quoted: ${estimate.waveguard_tier || 'Bronze'} at $${estimate.monthly_total}/mo\nInterested in adding: ${suggestedService || 'another service'}\nProperty: ${estimate.address || 'N/A'}\nPhone: ${estimate.customer_phone || 'N/A'}`
      );
    } catch (e) { logger.error(`[estimate] Bundle inquiry SMS failed: ${e.message}`); }

    // In-app notification
    try {
      const NotificationService = require('../services/notification-service');
      await NotificationService.notifyAdmin('estimate',
        `Bundle inquiry: ${estimate.customer_name}`,
        `Interested in adding ${suggestedService || 'a service'} to ${estimate.waveguard_tier || 'Bronze'} plan`,
        { icon: '\u{1F4E6}', link: '/admin/estimates', metadata: { estimateId: estimate.id } }
      );
    } catch (e) { logger.error(`[estimate] Bundle inquiry notification failed: ${e.message}`); }

    logger.info(`[estimate] Bundle inquiry from ${estimate.customer_name} — wants ${suggestedService}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// PUT /api/estimates/:token/decline
router.put('/:token/decline', async (req, res, next) => {
  try {
    const estimate = await db('estimates').where({ token: req.params.token }).first();
    await db('estimates').where({ token: req.params.token }).update({ status: 'declined', declined_at: db.fn.now() });

    // Notify admin of declined estimate
    if (estimate) {
      try {
        const NotificationService = require('../services/notification-service');
        await NotificationService.notifyAdmin('estimate', `Estimate declined: ${estimate.customer_name}`, `${estimate.address || 'no address'} \u2014 $${estimate.monthly_total || 0}/mo`, { icon: '\u274C', link: '/admin/estimates', metadata: { estimateId: estimate.id, customerId: estimate.customer_id } });
      } catch (e) { logger.error(`[notifications] Estimate declined notification failed: ${e.message}`); }
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
