/**
 * Single idempotent "request card for appointment" service (card-on-file
 * spec §3 Phase 5.1). Every trigger that wants a card secured for a booked
 * visit — estimate flow, /book wizard, AI call pipeline, admin button —
 * funnels through requestCardForAppointment, which runs the spec's ordered
 * checks:
 *
 *   1. policy exemption      — payer-billed (fail toward EXEMPT: a payer
 *                              lookup outage must never enroll the
 *                              homeowner's card for third-party invoices,
 *                              same rule as recurring-card-on-file), or
 *                              already on Auto Pay.
 *   2. saved method on file  — a consented chargeable card skips the text
 *                              and AUTO-SECURES the visit: a `satisfied`
 *                              request row + idempotent Auto Pay enrollment
 *                              of that method (mirrors pay-v2
 *                              /setup-complete semantics).
 *   3. existing capture      — any appointment_card_requests row for this
 *                              visit (pending / completed / satisfied)
 *                              means the funnel already ran: skip.
 *   4. one text, ever        — the card_link_sent_at stamp on the visit is
 *                              an atomic claim (UPDATE ... WHERE NULL): N
 *                              concurrent triggers collapse to one send.
 *                              Follow-up nudges are Phase 4's job — never
 *                              this path's.
 *
 * Only after all four: mint the 64-hex tokenized "secure your appointment"
 * link (/secure/{token}, page shipped separately), insert the pending
 * request row, and send ONE SMS through send_customer_message (purpose
 * card_request — consent, suppression, and audit ride the canonical path).
 * A send that never left (blocked, provider failure, template inactive)
 * releases the claim and the pending row so a later trigger can retry —
 * "one text ever" counts texts that sent.
 *
 * DARK BY DEFAULT: inert unless APPOINTMENT_CARD_REQUEST=true AND the
 * secure_appointment_card SMS template is active (seeded inactive) — both
 * levers are owner flips, either one alone keeps this path silent.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { portalUrl } = require('../utils/portal-url');
const { shortenOrPassthrough } = require('./short-url');
const { etDateString } = require('../utils/datetime-et');
const { callBookingDateOnly } = require('./call-booking-catalog');
const { sendCustomerMessage } = require('./messaging/send-customer-message');

const TEMPLATE_KEY = 'secure_appointment_card';
const LIVE_VISIT_STATUSES = ['pending', 'confirmed'];

function isAppointmentCardRequestEnabled() {
  const flag = process.env.APPOINTMENT_CARD_REQUEST;
  return flag === '1' || flag === 'true' || flag === 'on';
}

function skip(reason, extra = {}) {
  return { requested: false, action: 'skipped', reason, ...extra };
}

// " on Tue, Jul 21" — noon-anchored so the rendered weekday can't slip a
// day across TZ seams. '' when the visit has no parseable date (the
// template's {date_line} is clause-style: absent renders clean copy).
function dateLineFor(scheduledDate) {
  const dateOnly = callBookingDateOnly(scheduledDate);
  if (!dateOnly) return '';
  const anchored = new Date(`${dateOnly}T12:00:00`);
  if (Number.isNaN(anchored.getTime())) return '';
  return ` on ${anchored.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

async function renderTemplate(vars) {
  try {
    const smsTemplatesRouter = require('../routes/admin-sms-templates');
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(TEMPLATE_KEY, vars);
      if (body) return body;
    }
  } catch (err) {
    logger.warn(`[appt-card-request] template ${TEMPLATE_KEY} lookup failed: ${err.message}`);
  }
  return null;
}

// Check 1 — policy exemption. Payer check fails toward EXEMPT (never risk
// securing the homeowner's card for invoices that route to a third-party
// payer); the autopay-active check fails toward REQUIRING the card (a
// wrongly sent link is recoverable, a wrongly skipped one loses the
// protection) — both directions copied from recurring-card-on-file.
async function resolveExemption({ customerId, scheduledServiceId }) {
  try {
    const PayerService = require('./payer');
    const resolved = await PayerService.resolveForInvoice({
      customerId: String(customerId),
      scheduledServiceId: String(scheduledServiceId),
      throwOnError: true,
    });
    if (resolved?.payerId) return { exempt: true, reason: 'payer_billed' };
  } catch (err) {
    logger.warn(`[appt-card-request] payer check failed — exempting (never risk the wrong party): ${err.message}`);
    return { exempt: true, reason: 'payer_check_uncertain' };
  }

  try {
    const { customerOnAutopay } = require('./autopay-eligibility');
    const customer = await db('customers').where({ id: customerId }).first();
    if (customer && await customerOnAutopay(customer)) {
      return { exempt: true, reason: 'autopay_already_active' };
    }
  } catch (err) {
    logger.warn(`[appt-card-request] autopay-active check failed — card request stays on: ${err.message}`);
  }

  return { exempt: false };
}

// Check 2 — auto-secure from an existing consented chargeable card. The
// `satisfied` row is the durable "this visit is covered" record (check 3
// catches it on every later trigger); enrollment reuses the single
// enrollment semantics (enrollConsentedMethod) and is best-effort — the
// consented saved method IS the protection, a refused enrollment is
// surfaced by the pay-path backstops, and re-texting a customer who has a
// consented card on file is wrong regardless.
async function autoSecureFromSavedMethod({ visit, savedMethod, trigger }) {
  const inserted = await db('appointment_card_requests')
    .insert({
      scheduled_service_id: visit.id,
      customer_id: visit.customer_id,
      status: 'satisfied',
      trigger,
      payment_method_id: savedMethod.id,
      stripe_payment_method_id: savedMethod.stripe_payment_method_id || null,
      completed_at: new Date(),
    })
    .onConflict('scheduled_service_id')
    .ignore()
    .returning('id');
  if (!inserted || !inserted.length) {
    // Another trigger's row landed first — the funnel already ran.
    return skip('request_exists');
  }
  try {
    const { enrollConsentedMethod } = require('./autopay-enrollment');
    await enrollConsentedMethod({
      customerId: visit.customer_id,
      paymentMethodId: savedMethod.id,
      source: 'save_card_consent',
      details: { via: 'appointment_card_request', scheduled_service_id: visit.id, trigger },
    });
  } catch (err) {
    logger.warn(`[appt-card-request] auto-secure enrollment failed for visit ${visit.id} (saved method remains the protection): ${err.message}`);
  }
  return { requested: false, action: 'auto_secured', reason: 'saved_method_satisfied' };
}

/**
 * The one entry point. Returns { requested, action, reason }:
 *   action 'sent'         — the single card-link SMS went out.
 *   action 'auto_secured' — covered by an existing consented saved method.
 *   action 'skipped'      — reason says why (gate_off, exemption, dedup...).
 * Never throws — every trigger path treats this as fire-and-observe.
 */
async function requestCardForAppointment({ scheduledServiceId, trigger = 'unspecified' }) {
  try {
    if (!isAppointmentCardRequestEnabled()) return skip('gate_off');
    if (!scheduledServiceId) return skip('no_scheduled_service_id');

    const visit = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('id', 'customer_id', 'status', 'scheduled_date', 'window_display', 'service_type', 'card_link_sent_at');
    if (!visit) return skip('visit_not_found');
    if (!visit.customer_id) return skip('no_customer');
    if (!LIVE_VISIT_STATUSES.includes(visit.status)) return skip(`visit_not_live:${visit.status}`);
    const dateOnly = callBookingDateOnly(visit.scheduled_date);
    if (dateOnly && dateOnly < etDateString(new Date())) return skip('visit_in_past');

    // 1. Policy exemption.
    const exemption = await resolveExemption({ customerId: visit.customer_id, scheduledServiceId: visit.id });
    if (exemption.exempt) return skip(exemption.reason);

    // 2. Chargeable saved method → skip + auto-secure. Lookup failure keeps
    // the request path going (fail toward asking for the card).
    let savedMethod = null;
    try {
      const { findConsentedChargeableCard } = require('./payment-method-consents');
      savedMethod = await findConsentedChargeableCard(visit.customer_id);
    } catch (err) {
      logger.warn(`[appt-card-request] saved-method check failed — proceeding to request: ${err.message}`);
    }
    if (savedMethod) return autoSecureFromSavedMethod({ visit, savedMethod, trigger });

    // 3. Existing pending/complete capture for this appointment.
    const existing = await db('appointment_card_requests')
      .where({ scheduled_service_id: visit.id })
      .first('id', 'status');
    if (existing) return skip('request_exists', { status: existing.status });

    // Render before claiming: an inactive/missing template (the second dark
    // lever) must not consume the one-text-ever stamp.
    const customer = await db('customers')
      .where({ id: visit.customer_id })
      .first('id', 'first_name', 'phone');
    if (!customer?.phone) return skip('no_customer_phone');

    const token = crypto.randomBytes(32).toString('hex');
    const longUrl = portalUrl(`/secure/${token}`);
    // Never-expiring short code, same posture as reschedule links: the
    // /secure/:token page owns eligibility for stale links.
    const secureLink = await shortenOrPassthrough(longUrl, {
      kind: 'secure_card',
      entityType: 'scheduled_services',
      entityId: visit.id,
      customerId: visit.customer_id,
      expiresAt: null,
    });
    const body = await renderTemplate({
      first_name: customer.first_name || 'there',
      service_type: visit.service_type || 'service',
      date_line: dateLineFor(visit.scheduled_date),
      secure_link: secureLink || longUrl,
    });
    if (!body) return skip('template_inactive');

    // 4. One text, ever — atomic claim on the visit row.
    const stamp = new Date();
    const claimed = await db('scheduled_services')
      .where({ id: visit.id })
      .whereNull('card_link_sent_at')
      .update({ card_link_sent_at: stamp, updated_at: stamp });
    if (claimed !== 1) return skip('link_already_sent');

    const releaseClaim = async () => {
      try {
        await db('scheduled_services')
          .where({ id: visit.id, card_link_sent_at: stamp })
          .update({ card_link_sent_at: null, updated_at: new Date() });
        await db('appointment_card_requests')
          .where({ scheduled_service_id: visit.id, status: 'pending', token })
          .whereNull('stripe_setup_intent_id')
          .del();
      } catch (err) {
        logger.warn(`[appt-card-request] claim release failed for visit ${visit.id}: ${err.message}`);
      }
    };

    const inserted = await db('appointment_card_requests')
      .insert({
        scheduled_service_id: visit.id,
        customer_id: visit.customer_id,
        status: 'pending',
        trigger,
        token,
        sent_at: stamp,
      })
      .onConflict('scheduled_service_id')
      .ignore()
      .returning('id');
    if (!inserted || !inserted.length) {
      // A row landed between check 3 and the claim — funnel already ran.
      await releaseClaim();
      return skip('request_exists');
    }

    const result = await sendCustomerMessage({
      to: customer.phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'card_request',
      customerId: visit.customer_id,
      identityTrustLevel: 'phone_matches_customer',
      metadata: {
        scheduled_service_id: visit.id,
        trigger,
        original_message_type: TEMPLATE_KEY,
      },
    });
    if (!result?.sent) {
      // Blocked or provider-failed: the text never left, so the claim and
      // the pending row release — a later trigger may retry once.
      await releaseClaim();
      return skip(`send_blocked:${result?.code || result?.reason || 'unknown'}`);
    }

    logger.info(`[appt-card-request] secure-card link sent for visit ${visit.id} (trigger ${trigger})`);
    return { requested: true, action: 'sent', reason: 'sent' };
  } catch (err) {
    logger.error(`[appt-card-request] request failed for visit ${scheduledServiceId}: ${err.message}`);
    return skip(`error:${err.message}`);
  }
}

module.exports = {
  requestCardForAppointment,
  isAppointmentCardRequestEnabled,
  _test: {
    dateLineFor,
    resolveExemption,
    autoSecureFromSavedMethod,
  },
};
