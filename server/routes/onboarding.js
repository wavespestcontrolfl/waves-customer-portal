const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const logger = require('../services/logger');
const { shortenOrPassthrough } = require('../services/short-url');

const WAVES_OFFICE_PHONE = '+19413187612';

// Middleware to load onboarding session by token (no login required)
async function loadSession(req, res, next) {
  const { token } = req.params;
  const session = await db('onboarding_sessions').where({ token }).first();
  if (!session) return res.status(404).json({ error: 'Onboarding session not found' });
  if (new Date(session.expires_at) < new Date()) return res.status(410).json({ error: 'This onboarding link has expired. Call (941) 297-5749 for a new one.' });
  req.session = session;
  req.customer = await db('customers').where({ id: session.customer_id }).first();
  next();
}

// =========================================================================
// POST /api/onboarding/start — create a new onboarding session
// =========================================================================
router.post('/start', async (req, res, next) => {
  try {
    const { customerId, serviceType, waveguardTier, monthlyRate, depositAmount, quoteReference } = req.body;
    if (!customerId || !serviceType) return res.status(400).json({ error: 'customerId and serviceType required' });

    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const token = crypto.randomUUID();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await db('onboarding_sessions').insert({
      customer_id: customerId,
      token,
      quote_reference: quoteReference || null,
      service_type: serviceType,
      waveguard_tier: waveguardTier || null,
      monthly_rate: monthlyRate || null,
      deposit_amount: depositAmount || null,
      status: 'started',
      expires_at: expiresAt,
    });

    const longOnboardingUrl = `https://portal.wavespestcontrol.com/onboard/${token}`;
    const onboardingUrl = await shortenOrPassthrough(longOnboardingUrl, {
      kind: 'onboarding', entityType: 'onboarding_sessions', customerId: customer.id,
    });

    try {
      await TwilioService.sendSMS(customer.phone,
        `Hey ${customer.first_name}! 🌊 Your ${serviceType} with Waves is confirmed. Complete your quick 2-minute setup here: ${onboardingUrl} — and your first visit will go perfectly.`
      );
    } catch (e) { logger.error(`Onboarding SMS failed: ${e.message}`); }

    res.json({ token, onboardingUrl });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /api/onboarding/:token — get full onboarding state
// =========================================================================
router.get('/:token', loadSession, async (req, res, next) => {
  try {
    const s = req.session;
    const c = req.customer;

    const prefs = await db('property_preferences').where({ customer_id: c.id }).first();
    const scheduled = await db('scheduled_services')
      .where({ customer_id: c.id })
      .whereNotIn('status', ['cancelled', 'completed'])
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'technicians.name as tech_name')
      .orderBy('scheduled_date', 'asc')
      .first();

    const card = await db('payment_methods').where({ customer_id: c.id, is_default: true }).first();

    res.json({
      customer: {
        id: c.id,
        firstName: c.first_name,
        lastName: c.last_name,
        phone: c.phone,
        email: c.email,
        address: `${c.address_line1}, ${c.city}, ${c.state} ${c.zip}`,
        city: c.city,
        referralCode: c.referral_code,
      },
      quote: {
        serviceType: s.service_type,
        tier: s.waveguard_tier,
        monthlyRate: parseFloat(s.monthly_rate || 0),
        depositAmount: parseFloat(s.deposit_amount || 0),
        quoteReference: s.quote_reference,
      },
      status: {
        current: s.status,
        paymentCollected: s.payment_collected,
        serviceConfirmed: s.service_confirmed,
        detailsCollected: s.details_collected,
      },
      card: card ? { brand: card.card_brand, lastFour: card.last_four, autopay: card.autopay_enabled } : null,
      scheduledService: scheduled ? {
        id: scheduled.id,
        date: scheduled.scheduled_date,
        windowStart: scheduled.window_start,
        windowEnd: scheduled.window_end,
        serviceType: scheduled.service_type,
        techName: scheduled.tech_name,
        confirmed: scheduled.customer_confirmed,
      } : null,
      preferences: prefs ? {
        preferredTime: prefs.preferred_time,
        preferredDay: prefs.preferred_day,
        contactPreference: prefs.contact_preference,
        typicallyHome: prefs.typically_home,
        neighborhoodGateCode: prefs.neighborhood_gate_code,
        propertyGateCode: prefs.property_gate_code,
        garageCode: prefs.garage_code,
        lockboxCode: prefs.lockbox_code,
        parkingNotes: prefs.parking_notes,
        petCount: prefs.pet_count,
        petDetails: prefs.pet_details,
        petSecuredPlan: prefs.pets_secured_plan,
        irrigationSystem: prefs.irrigation_system,
        irrigationControllerLocation: prefs.irrigation_controller_location,
        irrigationZones: prefs.irrigation_zones,
        hoaName: prefs.hoa_name,
        hoaRestrictions: prefs.hoa_restrictions,
        specialInstructions: prefs.special_instructions,
        chemicalSensitivities: prefs.chemical_sensitivities,
        specialFeatures: prefs.special_features || [],
      } : {},
    });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /api/onboarding/:token/setup-intent — Create Stripe SetupIntent
// =========================================================================
router.post('/:token/setup-intent', loadSession, async (req, res, next) => {
  try {
    const StripeService = require('../services/stripe');
    const stripeConfig = require('../config/stripe-config');
    const result = await StripeService.createSetupIntent(req.customer.id);
    res.json({ ...result, publishableKey: stripeConfig.publishableKey });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /api/onboarding/:token/save-card — Save card after Stripe confirmation
// =========================================================================
router.post('/:token/save-card', loadSession, async (req, res, next) => {
  try {
    const { paymentMethodId } = req.body;
    if (!paymentMethodId) return res.status(400).json({ error: 'paymentMethodId required' });

    const StripeService = require('../services/stripe');
    const card = await StripeService.savePaymentMethod(req.customer.id, paymentMethodId);

    await db('onboarding_sessions')
      .where({ id: req.session.id })
      .update({ payment_collected: true, status: 'payment_complete' });

    res.json({ card });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /api/onboarding/:token/payment — process payment (legacy)
// =========================================================================
router.put('/:token/payment', loadSession, async (req, res, next) => {
  try {
    const { cardNonce, autopayEnabled } = req.body;

    await db('onboarding_sessions')
      .where({ id: req.session.id })
      .update({ payment_collected: true, status: 'payment_complete' });

    res.json({ success: true, cardBrand: 'VISA', lastFour: '4821', depositCharged: !!req.session.deposit_amount });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /api/onboarding/:token/confirm-service — confirm or reschedule
// =========================================================================
router.put('/:token/confirm-service', loadSession, async (req, res, next) => {
  try {
    const { confirmed, reschedule, preferredDate, notes } = req.body;
    const svc = await db('scheduled_services')
      .where({ customer_id: req.customer.id })
      .whereNotIn('status', ['cancelled', 'completed'])
      .orderBy('scheduled_date', 'asc')
      .first();

    if (!svc) return res.status(404).json({ error: 'No scheduled service found' });

    if (confirmed) {
      await db('scheduled_services')
        .where({ id: svc.id })
        .update({ customer_confirmed: true, confirmed_at: db.fn.now(), status: 'confirmed' });
    } else if (reschedule) {
      await db('scheduled_services')
        .where({ id: svc.id })
        .update({ status: 'rescheduled', notes: notes || `Preferred date: ${preferredDate}` });
      try {
        await TwilioService.sendSMS(WAVES_OFFICE_PHONE,
          `📅 Reschedule request from ${req.customer.first_name} ${req.customer.last_name}: prefers ${preferredDate || 'TBD'}. Notes: ${notes || 'None'}`);
      } catch (e) { logger.error(`Reschedule SMS failed: ${e.message}`); }
    }

    await db('onboarding_sessions')
      .where({ id: req.session.id })
      .update({ service_confirmed: true, status: 'service_confirmed' });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /api/onboarding/:token/details — save all property details
// =========================================================================
router.put('/:token/details', loadSession, async (req, res, next) => {
  try {
    const { scheduling, access, pets, property, attribution } = req.body;
    const customerId = req.customer.id;

    // Build property_preferences upsert
    const prefUpdates = {};
    if (scheduling) {
      if (scheduling.preferredTime) prefUpdates.preferred_time = scheduling.preferredTime;
      if (scheduling.preferredDay) prefUpdates.preferred_day = scheduling.preferredDay;
      if (scheduling.contactPreference) prefUpdates.contact_preference = scheduling.contactPreference;
      if (scheduling.typicallyHome) prefUpdates.typically_home = scheduling.typicallyHome;
    }
    if (access) {
      if (access.neighborhoodGateCode !== undefined) prefUpdates.neighborhood_gate_code = access.neighborhoodGateCode;
      if (access.propertyGateCode !== undefined) prefUpdates.property_gate_code = access.propertyGateCode;
      if (access.garageCode !== undefined) prefUpdates.garage_code = access.garageCode;
      if (access.lockboxCode !== undefined) prefUpdates.lockbox_code = access.lockboxCode;
      if (access.interiorAccessMethod) prefUpdates.interior_access_method = access.interiorAccessMethod;
      if (access.interiorAccessDetails) prefUpdates.interior_access_details = access.interiorAccessDetails;
      if (access.parkingNotes !== undefined) prefUpdates.parking_notes = access.parkingNotes;
    }
    if (pets) {
      if (pets.petCount !== undefined) prefUpdates.pet_count = pets.petCount;
      if (pets.petDetails !== undefined) prefUpdates.pet_details = pets.petDetails;
      if (pets.petsPlan !== undefined) prefUpdates.pets_secured_plan = pets.petsPlan;
      if (pets.chemicalSensitivities !== undefined) prefUpdates.chemical_sensitivities = pets.chemicalSensitivities;
      if (pets.chemicalSensitivityDetails !== undefined) prefUpdates.chemical_sensitivity_details = pets.chemicalSensitivityDetails;
    }
    if (property) {
      if (property.specialFeatures) prefUpdates.special_features = JSON.stringify(property.specialFeatures);
      if (property.irrigationSystem !== undefined) prefUpdates.irrigation_system = property.irrigationSystem;
      if (property.irrigationControllerLocation !== undefined) prefUpdates.irrigation_controller_location = property.irrigationControllerLocation;
      if (property.irrigationZones !== undefined) prefUpdates.irrigation_zones = property.irrigationZones;
      if (property.hoaName !== undefined) prefUpdates.hoa_name = property.hoaName;
      if (property.hoaRestrictions !== undefined) prefUpdates.hoa_restrictions = property.hoaRestrictions;
      if (property.specialInstructions !== undefined) prefUpdates.special_instructions = property.specialInstructions;
    }

    if (Object.keys(prefUpdates).length > 0) {
      const existing = await db('property_preferences').where({ customer_id: customerId }).first();
      if (existing) {
        await db('property_preferences').where({ customer_id: customerId }).update({ ...prefUpdates, updated_at: db.fn.now() });
      } else {
        await db('property_preferences').insert({ customer_id: customerId, ...prefUpdates });
      }
    }

    // Attribution
    if (attribution) {
      const custUpdates = {};
      if (attribution.referralSource) custUpdates.referral_source = attribution.referralSource;

      // Look up referrer by phone
      if (attribution.referredByPhone) {
        const referrer = await db('customers')
          .where({ phone: attribution.referredByPhone.trim() })
          .first();
        if (referrer) {
          custUpdates.referred_by_customer_id = referrer.id;
          // Create referral record for the referrer
          const existingRef = await db('referrals')
            .where({ referrer_customer_id: referrer.id, referee_phone: req.customer.phone })
            .first();
          if (!existingRef) {
            await db('referrals').insert({
              referrer_customer_id: referrer.id,
              referee_name: `${req.customer.first_name} ${req.customer.last_name}`,
              referee_phone: req.customer.phone,
              referral_code: referrer.referral_code,
              status: 'signed_up',
              converted_at: db.fn.now(),
            });
          }
        }
      }

      if (Object.keys(custUpdates).length > 0) {
        await db('customers').where({ id: customerId }).update(custUpdates);
      }
    }

    await db('onboarding_sessions')
      .where({ id: req.session.id })
      .update({ details_collected: true, status: 'details_complete' });

    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// GET /api/onboarding/:token/available-slots — show customer real route-day
// slots they can pick from (zone-aware — only days a tech is nearby)
// =========================================================================
router.get('/:token/available-slots', loadSession, async (req, res, next) => {
  try {
    const availability = require('../services/availability');
    const result = await availability.getAvailableSlots(req.customer.city, null);
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// PUT /api/onboarding/:token/reschedule-service — actually move the first
// service to a customer-picked slot (not just a note-to-office).
// =========================================================================
router.put('/:token/reschedule-service', loadSession, async (req, res, next) => {
  try {
    const { date, startTime } = req.body;
    if (!date || !startTime) return res.status(400).json({ error: 'date and startTime required' });

    const current = await db('scheduled_services')
      .where({ customer_id: req.customer.id })
      .whereNotIn('status', ['cancelled', 'completed'])
      .orderBy('scheduled_date', 'asc')
      .first();

    // Cancel the auto-picked service so we don't end up with two scheduled
    // entries on the dispatch board.
    if (current) {
      await db('scheduled_services').where({ id: current.id }).update({
        status: 'cancelled',
        notes: `Rescheduled by customer during onboarding to ${date} ${startTime}`,
      });
      if (current.self_booking_id) {
        await db('self_booked_appointments').where({ id: current.self_booking_id }).update({ status: 'cancelled' });
      }
    }

    // Book the customer-picked slot through the same engine the portal uses,
    // so we inherit confirmation codes, dispatch sync, and SMS notifications.
    const availability = require('../services/availability');
    const booking = await availability.confirmBooking(null, req.customer.id, date, startTime, 'Picked during onboarding');

    await db('onboarding_sessions')
      .where({ id: req.session.id })
      .update({ service_confirmed: true, status: 'service_confirmed' });

    res.json({ success: true, booking });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /api/onboarding/:token/complete — finalize onboarding
// =========================================================================
router.post('/:token/complete', loadSession, async (req, res, next) => {
  try {
    const c = req.customer;
    const s = req.session;

    // Mark complete
    await db('onboarding_sessions')
      .where({ id: s.id })
      .update({ status: 'complete', completed_at: db.fn.now() });

    await db('customers')
      .where({ id: c.id })
      .update({ onboarding_complete: true, onboarded_at: db.fn.now() });

    // Award badges
    await db('customer_badges').insert({ customer_id: c.id, badge_type: 'welcome_aboard' })
      .onConflict(['customer_id', 'badge_type']).ignore();

    const prefs = await db('property_preferences').where({ customer_id: c.id }).first();
    if (prefs && (prefs.neighborhood_gate_code || prefs.property_gate_code || prefs.pet_count > 0 || prefs.preferred_day !== 'no_preference')) {
      await db('customer_badges').insert({ customer_id: c.id, badge_type: 'property_pro' })
        .onConflict(['customer_id', 'badge_type']).ignore();
    }

    // Get scheduled service info for SMS
    const svc = await db('scheduled_services')
      .where({ customer_id: c.id })
      .whereNotIn('status', ['cancelled', 'completed'])
      .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
      .select('scheduled_services.*', 'technicians.name as tech_name')
      .orderBy('scheduled_date', 'asc')
      .first();

    const svcDate = svc ? new Date(svc.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' }) : 'TBD';

    // Welcome SMS
    try {
      await TwilioService.sendSMS(c.phone,
        `Welcome to the Waves family, ${c.first_name}! 🌊 Your first ${s.service_type} is ${svcDate}${svc ? ` with ${svc.tech_name}` : ''}. Log into your portal anytime: portal.wavespestcontrol.com`
      );
    } catch (e) { logger.error(`Welcome SMS failed: ${e.message}`); }

    // Internal notification
    try {
      const hasGate = prefs?.neighborhood_gate_code || prefs?.property_gate_code;
      const hasPets = prefs?.pet_count > 0;
      await TwilioService.sendSMS(WAVES_OFFICE_PHONE,
        `✅ New customer onboarded: ${c.first_name} ${c.last_name} at ${c.address_line1}, ${c.city}.\n` +
        `${s.waveguard_tier || ''} WaveGuard, $${s.monthly_rate}/mo. Card ✅.\n` +
        `First service: ${svcDate}. Gate: ${hasGate ? 'yes' : 'no'}. Pets: ${hasPets ? `yes (${prefs.pet_count})` : 'no'}.\n` +
        `Referral: ${c.referral_source || 'N/A'}.`
      );
    } catch (e) { logger.error(`Internal onboarding SMS failed: ${e.message}`); }

    res.json({ success: true, portalUrl: 'https://portal.wavespestcontrol.com' });
  } catch (err) { next(err); }
});

module.exports = router;
