const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../models/db');
const TwilioService = require('../services/twilio');
const logger = require('../services/logger');
const { shortenOrPassthrough } = require('../services/short-url');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const {
  parseEstimateData,
  resolveBillingCadence,
} = require('../services/billing-cadence');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');
const { logAutopay } = require('../services/autopay-log');

const WAVES_OFFICE_PHONE = '+19413187612';

function fmtMoney(value) {
  const n = Number(value || 0);
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function findSessionEstimate(session) {
  if (!session?.id) return null;
  const bySession = await db('estimates').where({ onboarding_session_id: session.id }).first();
  if (bySession) return bySession;
  if (session.quote_reference) {
    return db('estimates')
      .where({ token: session.quote_reference })
      .orWhere({ estimate_slug: session.quote_reference })
      .first();
  }
  return null;
}

function billingCadenceForSession(session, estimate) {
  const estimateData = parseEstimateData(estimate?.estimate_data);
  return resolveBillingCadence({
    monthlyRate: parseFloat(session?.monthly_rate || 0),
    frequencyKey: estimateData.customerSelection?.frequency,
    estimateData,
    fallbackFrequencyKey: estimate ? 'quarterly' : 'monthly',
  });
}

function formatOnboardingServiceDate(value) {
  if (!value) return 'TBD';
  let date;
  if (value instanceof Date) {
    date = new Date(Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate(),
      12,
    ));
  } else {
    date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  }
  if (Number.isNaN(date.getTime())) return 'TBD';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
}

function onboardingTechClause(svc) {
  const techName = String(svc?.tech_name || '').trim();
  return techName ? ` with ${techName}` : '';
}

async function sendOnboardingSms(customer, body, metadata = {}) {
  if (!customer?.phone || !customer?.id) {
    return { sent: false, blocked: true, code: 'MISSING_CUSTOMER_CONTACT' };
  }
  return sendCustomerMessage({
    to: customer.phone,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose: 'appointment',
    customerId: customer.id,
    identityTrustLevel: 'phone_matches_customer',
    entryPoint: 'onboarding',
    metadata,
  });
}

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
      const smsResult = await sendOnboardingSms(
        customer,
        `Hey ${customer.first_name}! Your ${serviceType} with Waves is confirmed. Complete your quick setup here: ${onboardingUrl}.`,
        { original_message_type: 'onboarding_start' }
      );
      if (!smsResult.sent) {
        logger.warn(`[onboarding] Start SMS blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
      }
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
    const estimate = await findSessionEstimate(s);
    const billing = billingCadenceForSession(s, estimate);
    if (
      scheduled
      && estimate
      && billing.amount > 0
      && scheduled.payment_method_preference !== 'prepay_annual'
      && (!scheduled.estimated_price || Number(scheduled.estimated_price) <= 0)
    ) {
      await db('scheduled_services')
        .where({ id: scheduled.id })
        .where((q) => q.whereNull('estimated_price').orWhere('estimated_price', '<=', 0))
        .update({ estimated_price: billing.amount, updated_at: db.fn.now() });
      scheduled.estimated_price = billing.amount;
    }

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
        billing,
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
        estimatedPrice: scheduled.estimated_price != null ? Number(scheduled.estimated_price) : null,
        // Carries the card_on_file / pay_at_visit choice the customer made
        // during inline accept so the onboarding UI can skip the Stripe
        // screen when they opted to pay at the visit.
        paymentMethodPreference: scheduled.payment_method_preference || null,
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
        chemicalSensitivityDetails: prefs.chemical_sensitivity_details,
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
    const result = await StripeService.createSetupIntent(req.customer.id, 'card_or_bank');
    res.json({ ...result, publishableKey: stripeConfig.publishableKey });
  } catch (err) { next(err); }
});

// =========================================================================
// POST /api/onboarding/:token/save-card — Save card after Stripe confirmation
// =========================================================================
router.post('/:token/save-card', loadSession, async (req, res, next) => {
  try {
    const { paymentMethodId, setupIntentId } = req.body;
    if (!setupIntentId) return res.status(400).json({ error: 'setupIntentId required' });

    const StripeService = require('../services/stripe');
    const ConsentService = require('../services/payment-method-consents');
    const setupIntent = await StripeService.retrieveSetupIntent(setupIntentId);
    const setupPaymentMethodId = typeof setupIntent?.payment_method === 'string'
      ? setupIntent.payment_method
      : setupIntent?.payment_method?.id;
    const resolvedPaymentMethodId = paymentMethodId || setupPaymentMethodId;
    if (!setupIntent || setupIntent.status !== 'succeeded' || !resolvedPaymentMethodId || setupPaymentMethodId !== resolvedPaymentMethodId) {
      return res.status(409).json({
        error: 'Payment method setup is not complete. Finish verification before enabling Auto Pay.',
        setupIntentStatus: setupIntent?.status || 'unknown',
      });
    }

    const hadActiveAutopay = await customerOnAutopay({
      id: req.customer.id,
      autopay_enabled: req.customer.autopay_enabled,
      autopay_paused_until: req.customer.autopay_paused_until,
      autopay_payment_method_id: req.customer.autopay_payment_method_id,
      ach_status: req.customer.ach_status,
    });
    const shouldEnableAutopay = !hadActiveAutopay;
    const card = await StripeService.savePaymentMethod(req.customer.id, resolvedPaymentMethodId, {
      enableAutopay: shouldEnableAutopay,
      makeDefault: shouldEnableAutopay,
    });
    if (!hadActiveAutopay) {
      await db('customers')
        .where({ id: req.customer.id })
        .update({
          autopay_enabled: true,
          autopay_payment_method_id: card.id,
          autopay_paused_until: null,
          autopay_pause_reason: null,
        });
      await logAutopay(req.customer.id, 'autopay_enabled', {
        paymentMethodId: card.id,
        details: { source: 'onboarding', session_id: req.session.id },
      });
      await logAutopay(req.customer.id, 'payment_method_changed', {
        paymentMethodId: card.id,
        details: { source: 'onboarding', previous_payment_method_id: req.customer.autopay_payment_method_id || null },
      });
      PaymentLifecycleEmail.sendPaymentMethodUpdated({
        customerId: req.customer.id,
        newPaymentMethodId: card.id,
        updatedAt: card.created_at || new Date(),
        idempotencyKey: `payment.method_updated:${req.customer.id}:${card.id}:onboarding:${req.session.id}`,
      }).catch((emailErr) => {
        logger.warn(`[onboarding] payment method update email failed for session ${req.session.id}: ${emailErr.message}`);
      });
      PaymentLifecycleEmail.sendAutopayEnabled({
        customerId: req.customer.id,
        paymentMethodId: card.id,
        enabledDate: card.created_at || new Date(),
      }).catch((emailErr) => {
        logger.warn(`[onboarding] autopay enabled email failed for session ${req.session.id}: ${emailErr.message}`);
      });
    }

    // Record consent — the onboarding flow shows SaveCardConsent as
    // locked + checked because saving is a precondition of finishing
    // sign-up, so arriving here means the customer saw the copy.
    try {
      await ConsentService.recordConsent({
        customerId: req.customer.id,
        paymentMethodId: card.id,
        stripePaymentMethodId: resolvedPaymentMethodId,
        source: 'onboarding',
        methodType: card.method_type || 'card',
        ip: req.ip,
        userAgent: req.get('user-agent') || null,
      });
    } catch (consentErr) {
      // Non-fatal — the card saved fine. Log loudly for reconciliation.
      require('../services/logger').error(`[onboarding] Consent record failed: ${consentErr.message}`);
    }

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
          `📅 Reschedule request from ${req.customer.first_name} ${req.customer.last_name}: prefers ${preferredDate || 'TBD'}. Notes: ${notes || 'None'}`,
          { messageType: 'internal_alert', link: '/admin/schedule' });
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

    // Card-required guard. Customers who chose "card on file" on
    // the estimate page must save a payment method before they can finish
    // onboarding — otherwise they end up with a committed scheduled visit
    // and no card on file. The client UI enforces this via screen routing,
    // but we re-check server-side so a direct API call (or an abandoned
    // tab that's later resumed past Stripe) can't slip through.
    const upcoming = await db('scheduled_services')
      .where({ customer_id: customerId })
      .whereNotIn('status', ['cancelled', 'completed'])
      .orderBy('scheduled_date', 'asc')
      .first('payment_method_preference');
    if (['card_on_file', 'deposit_now'].includes(upcoming?.payment_method_preference)) {
      const card = await db('payment_methods').where({ customer_id: customerId }).first('id');
      if (!card) {
        return res.status(409).json({
          error: 'card_required',
          message: 'Save a card on file before completing setup — you chose to put a card on file at booking.',
        });
      }
    }

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
    const estimate = await findSessionEstimate(s);
    const billing = billingCadenceForSession(s, estimate);

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

    const svcDate = formatOnboardingServiceDate(svc?.scheduled_date);

    // Welcome SMS
    try {
      const welcomeBody = await renderSmsTemplate('onboarding_welcome', {
        first_name: c.first_name || 'there',
        service_type: s.service_type,
        service_date: svcDate,
        tech_clause: onboardingTechClause(svc),
      }, {
        workflow: 'onboarding_welcome',
        entity_type: 'onboarding_session',
        entity_id: s.id,
      });
      if (!welcomeBody) {
        logger.warn(`[onboarding] onboarding_welcome template missing/disabled — skipping welcome SMS for customer ${c.id}`);
      } else {
        const smsResult = await sendOnboardingSms(c, welcomeBody, {
          original_message_type: 'onboarding_complete_welcome',
          onboarding_session_id: s.id,
          appointment_id: svc?.id,
        });
        if (!smsResult.sent) {
          logger.warn(`[onboarding] Welcome SMS blocked/failed for customer ${c.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
        }
      }
    } catch (e) { logger.error(`Welcome SMS failed: ${e.message}`); }

    // Internal notification
    try {
      const hasGate = prefs?.neighborhood_gate_code || prefs?.property_gate_code;
      const hasPets = prefs?.pet_count > 0;
      const billingLine = billing.amount > 0
        ? `$${fmtMoney(billing.amount)}${billing.displaySuffix}`
        : `$${fmtMoney(s.monthly_rate)}/mo`;
      await TwilioService.sendSMS(WAVES_OFFICE_PHONE,
        `✅ New customer onboarded: ${c.first_name} ${c.last_name} at ${c.address_line1}, ${c.city}.\n` +
        `${s.waveguard_tier || ''} WaveGuard, ${billingLine}. Card ✅.\n` +
        `First service: ${svcDate}. Gate: ${hasGate ? 'yes' : 'no'}. Pets: ${hasPets ? `yes (${prefs.pet_count})` : 'no'}.\n` +
        `Referral: ${c.referral_source || 'N/A'}.`,
        { messageType: 'internal_alert', link: '/admin/customers' },
      );
    } catch (e) { logger.error(`Internal onboarding SMS failed: ${e.message}`); }

    res.json({ success: true, portalUrl: 'https://portal.wavespestcontrol.com' });
  } catch (err) { next(err); }
});

router._private = {
  formatOnboardingServiceDate,
  onboardingTechClause,
};

module.exports = router;
