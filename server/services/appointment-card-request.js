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
const { etDateString } = require('../utils/datetime-et');
const { callBookingDateOnly } = require('./call-booking-catalog');
const { sendCustomerMessage } = require('./messaging/send-customer-message');

const TEMPLATE_KEY = 'secure_appointment_card';
// Deliberately NOT 'rescheduled' (Codex #2821 P1): the customer-portal
// reschedule request (routes/schedule.js) flips the visit to 'rescheduled'
// while leaving the ORIGINAL date/window on the row — it is a pending-
// rebook PLACEHOLDER (reschedule-public.js calls it exactly that) whose
// slot no longer exists, and the dispatch board excludes those rows as
// phantoms (admin-schedule.js day endpoint). Treating it as live would
// send the secure-card SMS with the obsolete date, render /secure ready
// with the same stale date/window, and enroll Auto Pay before a
// replacement appointment exists. When the office re-slots the visit, the
// rebooker restores 'confirmed' (rebooker.js) and this funnel / the
// /secure page reopen with the REAL new date.
const LIVE_VISIT_STATUSES = ['pending', 'confirmed'];
// Lease for both claim mechanics (the visit's card_link_sent_at send claim
// and the request row's pending → completing completion claim): a claim
// older than this with no durable outcome marker belongs to a dead worker
// and may be adopted by exactly one retrier (age-guarded atomic UPDATE).
const STALE_CLAIM_MS = 10 * 60 * 1000;
// Far-future sentinel that PARKS a send claim when the maybe-sent marker
// cannot be written after a provider-accepted dispatch: staleness is an
// age check, so a future stamp is permanently fresh and no lease can
// re-text the visit. A parked claim is an office exception, not a state
// the code ever un-parks.
const CLAIM_PARK_DATE = new Date('2200-01-01T00:00:00Z');

function isAppointmentCardRequestEnabled() {
  const flag = process.env.APPOINTMENT_CARD_REQUEST;
  return flag === '1' || flag === 'true' || flag === 'on';
}

function skip(reason, extra = {}) {
  return { requested: false, action: 'skipped', reason, ...extra };
}

// BOTH dark levers — the env gate AND the active secure_appointment_card
// template. Admin surfaces use this to decide whether to OFFER the send
// action at all (Codex #2921 P2): while the lane is dark, an offered
// checkbox/button silently no-ops (gate_off / template_inactive land only
// in the logs) and the office reads that as a sent link. Fail toward NOT
// offering — a hidden option is recoverable, a phantom send is not.
async function isSecureCardLaneReady() {
  if (!isAppointmentCardRequestEnabled()) return false;
  try {
    return !!(await renderTemplate({ first_name: 'x', service_type: 'x', date_line: '', secure_link: 'x' }));
  } catch (err) {
    logger.warn(`[appt-card-request] lane-ready template probe failed: ${err.message}`);
    return false;
  }
}

// " on Tue, Jul 21" — noon-anchored so the rendered weekday can't slip a
// day across TZ seams, and rendered explicitly in ET (the business's
// behavior timezone) rather than the server's locale default. '' when the
// visit has no parseable date (the template's {date_line} is clause-style:
// absent renders clean copy).
function dateLineFor(scheduledDate) {
  const dateOnly = callBookingDateOnly(scheduledDate);
  if (!dateOnly) return '';
  const anchored = new Date(`${dateOnly}T12:00:00`);
  if (Number.isNaN(anchored.getTime())) return '';
  return ` on ${anchored.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' })}`;
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

// Check 2 — auto-secure from an existing consented chargeable card, via
// the single enrollment semantics (enrollConsentedMethod). Enrollment runs
// FIRST and the `satisfied` row is written only after it succeeds (Codex
// #2771: completion billing keys on the Auto Pay flags, not this table —
// a `satisfied` row written before a failed enrollment would make every
// later trigger skip on request_exists while the visit sits unprotected).
// A refused/failed enrollment returns a retryable skip so the next
// trigger re-attempts; enrollment is idempotent, so a concurrent double
// run resolves as already_enrolled.
async function autoSecureFromSavedMethod({ visit, savedMethod, trigger }) {
  try {
    const { enrollConsentedMethod } = require('./autopay-enrollment');
    const enrollment = await enrollConsentedMethod({
      customerId: visit.customer_id,
      paymentMethodId: savedMethod.id,
      source: 'save_card_consent',
      details: { via: 'appointment_card_request', scheduled_service_id: visit.id, trigger },
    });
    if (!enrollment?.enrolled && enrollment?.reason !== 'already_enrolled') {
      logger.warn(`[appt-card-request] auto-secure enrollment refused (${enrollment?.reason || 'unknown'}) for visit ${visit.id} — left retryable`);
      return skip(`enrollment_refused:${enrollment?.reason || 'unknown'}`);
    }
  } catch (err) {
    logger.warn(`[appt-card-request] auto-secure enrollment failed for visit ${visit.id} — left retryable: ${err.message}`);
    return skip('enrollment_failed');
  }
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
    // A pending row already exists (abandoned inline/SMS link) — flip it
    // to satisfied (Codex #2771 r4) or the /secure page keeps rendering a
    // live card form for a visit the saved method already covers.
    // Pending-only: a completed/satisfied row is already terminal.
    await db('appointment_card_requests')
      .where({ scheduled_service_id: visit.id, status: 'pending' })
      .update({
        status: 'satisfied',
        payment_method_id: savedMethod.id,
        stripe_payment_method_id: savedMethod.stripe_payment_method_id || null,
        completed_at: new Date(),
        updated_at: new Date(),
      });
  }
  return { requested: false, action: 'auto_secured', reason: 'saved_method_satisfied' };
}

/**
 * The one entry point. Returns { requested, action, reason }:
 *   action 'sent'         — the single card-link SMS went out (delivery 'sms').
 *   action 'link_created' — delivery 'inline': the tokenized capture exists
 *                           and secureUrl points at /secure/:token — the
 *                           caller renders it in-flow (the /book wizard's
 *                           card step); no SMS, no one-text claim consumed.
 *   action 'auto_secured' — covered by an existing consented saved method.
 *   action 'skipped'      — reason says why (gate_off, exemption, dedup...).
 * Never throws — every trigger path treats this as fire-and-observe.
 */
async function requestCardForAppointment({ scheduledServiceId, trigger = 'unspecified', delivery = 'sms', recipientPhone = null }) {
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

    // The template is the second dark lever, and it gates EVERY side
    // effect of this funnel — auto-secure enrollment included, not just
    // the customer-visible text/link (Codex #2771 r8). Probe with fully-
    // resolved dummy vars (getTemplate returns null when the row is
    // missing or inactive); the real body renders later with the live
    // token.
    const templateActive = !!(await renderTemplate({ first_name: 'x', service_type: 'x', date_line: '', secure_link: 'x' }));
    if (!templateActive) return skip('template_inactive');

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

    // 3. Existing pending/complete capture for this appointment. An inline
    // caller re-running (page refresh, booking retry) gets the SAME pending
    // link back — idempotent, never a second row.
    const existing = await db('appointment_card_requests')
      .where({ scheduled_service_id: visit.id })
      .first('id', 'status', 'token');
    let reuseToken = null;
    if (existing) {
      if (existing.status === 'pending' && existing.token) {
        if (delivery === 'inline') {
          return { requested: false, action: 'link_created', reason: 'request_exists', secureUrl: portalUrl(`/secure/${existing.token}`) };
        }
        // A pending row whose text never went out — an inline /book step
        // the customer abandoned, or a prior send that failed after the
        // row landed — must stay reachable by the ONE allowed SMS (Codex
        // #2771): reuse its token; the card_link_sent_at claim below still
        // guarantees one text total.
        reuseToken = existing.token;
      } else {
        return skip('request_exists', { status: existing.status });
      }
    }

    const customer = await db('customers')
      .where({ id: visit.customer_id })
      .first('id', 'first_name', 'phone');
    // The caller may pass the CONSENTED recipient (Codex #2771 P1: the AI
    // call pipeline redirects implied-consent sends to the inbound caller's
    // number when the saved customer phone is a spouse/alternate slot) —
    // a payment-adjacent bearer link follows the same recipient decision
    // as the confirmation, never blindly customer.phone.
    const smsTo = recipientPhone || customer?.phone || null;
    if (delivery !== 'inline' && !smsTo) return skip('no_customer_phone');

    const token = reuseToken || crypto.randomBytes(32).toString('hex');
    // The 64-hex bearer link goes out UNSHORTENED (Codex #2771 P1): the
    // generic /l/:code shortener would swap it for a 5-char permanent code
    // — a far weaker credential for a payment-adjacent page — and /l/:code
    // resolves outside the /api rate limiter.
    const secureUrl = portalUrl(`/secure/${token}`);

    // Render before ANY exposure: the inactive/missing template is the
    // second dark lever, and it gates BOTH deliveries (Codex #2771 P1) —
    // the inline /book step must not expose the capture surface while the
    // template is inactive (template active + env gate = the documented
    // two-switch launch), and an SMS claim must never be consumed for a
    // send that can't render.
    const body = await renderTemplate({
      first_name: customer?.first_name || 'there',
      service_type: visit.service_type || 'service',
      date_line: dateLineFor(visit.scheduled_date),
      secure_link: secureUrl,
    });
    if (!body) return skip('template_inactive');

    // Inline delivery: the customer is ON the booking surface — create the
    // tokenized capture and hand the URL back for the wizard's card step.
    // No SMS, and the one-text-ever stamp stays unconsumed: if the
    // customer abandons the step, the visit is still eligible for exactly
    // one text later (an office/AI trigger through this same funnel).
    if (delivery === 'inline') {
      const inserted = await db('appointment_card_requests')
        .insert({
          scheduled_service_id: visit.id,
          customer_id: visit.customer_id,
          status: 'pending',
          trigger,
          token,
        })
        .onConflict('scheduled_service_id')
        .ignore()
        .returning('id');
      if (!inserted || !inserted.length) {
        const raced = await db('appointment_card_requests')
          .where({ scheduled_service_id: visit.id })
          .first('status', 'token');
        if (raced?.status === 'pending' && raced.token) {
          return { requested: false, action: 'link_created', reason: 'request_exists', secureUrl: portalUrl(`/secure/${raced.token}`) };
        }
        return skip('request_exists');
      }
      logger.info(`[appt-card-request] inline capture link created for visit ${visit.id} (trigger ${trigger})`);
      return { requested: true, action: 'link_created', reason: 'created', secureUrl };
    }

    // 4. One text, ever — atomic claim on the visit row.
    const stamp = new Date();
    let claimed = await db('scheduled_services')
      .where({ id: visit.id })
      .whereNull('card_link_sent_at')
      .update({ card_link_sent_at: stamp, updated_at: stamp });
    if (claimed !== 1) {
      // Stale-claim lease (Codex #2771 r4): a worker that died between
      // this claim and the send leaves the stamp set with no text out —
      // and every later trigger would skip forever. The request row's
      // sent_at is the durable outcome marker (stamped on success AND on
      // uncertain outcomes below), so an old stamp with no marker may be
      // adopted by exactly one retrier via the value-guarded UPDATE. A
      // row whose token differs from the one this run rendered means a
      // concurrent run owns it — never adopt that.
      const current = await db('scheduled_services')
        .where({ id: visit.id })
        .first('card_link_sent_at');
      const row = await db('appointment_card_requests')
        .where({ scheduled_service_id: visit.id })
        .first('status', 'token', 'sent_at');
      const priorStamp = current?.card_link_sent_at ? new Date(current.card_link_sent_at) : null;
      const stale = priorStamp && (Date.now() - priorStamp.getTime()) > STALE_CLAIM_MS;
      const rowBlocks = row && (row.sent_at || row.status !== 'pending' || (row.token && row.token !== token));
      if (!stale || rowBlocks) return skip('link_already_sent');
      claimed = await db('scheduled_services')
        .where({ id: visit.id, card_link_sent_at: priorStamp })
        .update({ card_link_sent_at: stamp, updated_at: stamp });
      if (claimed !== 1) return skip('link_already_sent');
      logger.warn(`[appt-card-request] reclaimed stale send claim for visit ${visit.id}`);
    }

    const releaseClaim = async () => {
      try {
        await db('scheduled_services')
          .where({ id: visit.id, card_link_sent_at: stamp })
          .update({ card_link_sent_at: null, updated_at: new Date() });
        // Only remove a row THIS call created — a reused pending row (the
        // /book inline step's) also serves the /secure page and may carry
        // a SetupIntent already.
        if (!reuseToken) {
          await db('appointment_card_requests')
            .where({ scheduled_service_id: visit.id, status: 'pending', token })
            .whereNull('stripe_setup_intent_id')
            .del();
        }
      } catch (err) {
        logger.warn(`[appt-card-request] claim release failed for visit ${visit.id}: ${err.message}`);
      }
    };

    // Fresh rows insert WITHOUT sent_at — sent_at is the durable "a text
    // (probably) left" marker, stamped only once the provider outcome is
    // known or uncertain, so the stale-claim lease above can tell
    // died-before-send from sent (Codex #2771 r4).
    try {
      if (!reuseToken) {
        const inserted = await db('appointment_card_requests')
          .insert({
            scheduled_service_id: visit.id,
            customer_id: visit.customer_id,
            status: 'pending',
            trigger,
            token,
          })
          .onConflict('scheduled_service_id')
          .ignore()
          .returning('id');
        if (!inserted || !inserted.length) {
          // A row landed between check 3 and the claim — funnel already ran.
          await releaseClaim();
          return skip('request_exists');
        }
      }
    } catch (insertErr) {
      // Certainly unsent — nothing reached the provider yet. Release the
      // claim or the one-text-ever stamp permanently strands the visit
      // with no card request and no retry (Codex #2771 P1).
      await releaseClaim();
      throw insertErr;
    }

    // The maybe-sent marker MUST land (Codex #2771 r5): the stale-send
    // lease reads a missing sent_at as died-before-send, so a swallowed
    // marker failure after a Twilio-accepted dispatch would let a later
    // trigger re-text a second bearer link once the lease expires.
    // Bounded retries; if all fail, the office gets an exception alert
    // naming the visit so a human intervenes before the lease can fire.
    const markSendOutcome = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await db('appointment_card_requests')
            .where({ scheduled_service_id: visit.id, status: 'pending' })
            .update({ sent_at: stamp, updated_at: stamp });
          return true;
        } catch (err) {
          logger.warn(`[appt-card-request] sent_at marker attempt ${attempt + 1} failed for visit ${visit.id}: ${err.message}`);
        }
      }
      // PARK the claim so the stale lease can never adopt it (Codex #2771
      // r8): staleness is an AGE check on card_link_sent_at, so pushing
      // the stamp far into the future makes the claim permanently fresh —
      // no retrier can re-text this visit even though the marker never
      // landed. Best-effort (a different table than the failed write);
      // the office alert below is the human backstop either way.
      let parked = false;
      try {
        await db('scheduled_services')
          .where({ id: visit.id, card_link_sent_at: stamp })
          .update({ card_link_sent_at: CLAIM_PARK_DATE, updated_at: new Date() });
        parked = true;
      } catch (parkErr) {
        logger.warn(`[appt-card-request] claim park failed for visit ${visit.id}: ${parkErr.message}`);
      }
      logger.error(`[appt-card-request] sent_at marker FAILED for visit ${visit.id} (claim ${parked ? 'parked' : 'NOT parked'}) — alerting office`);
      try {
        await require('./notification-service').notifyAdmin(
          'billing',
          'Card-link sent marker failed',
          `A secure-card SMS was dispatched but its sent marker could not be written${parked ? ' (the send claim is parked — no automatic retry will re-text)' : ' AND the claim could not be parked — investigate before the send lease expires (~10 min) or the customer may receive a second link'}.`,
          { link: '/admin/dispatch', metadata: { scheduled_service_id: visit.id, claim_parked: parked } },
        );
      } catch (alertErr) {
        logger.warn(`[appt-card-request] marker-failure alert failed: ${alertErr.message}`);
      }
      return false;
    };

    let result;
    try {
      result = await sendCustomerMessage({
        to: smsTo,
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
    } catch (sendErr) {
      // UNCERTAIN outcome (Codex #2771 r4): sendCustomerMessage dispatches
      // to the provider BEFORE persisting its audit row, so a throw here
      // can follow a Twilio-ACCEPTED send. Two bearer card links is the
      // worse failure mode — keep the claim consumed and stamp the
      // maybe-sent marker so the stale-claim lease never re-texts.
      logger.error(`[appt-card-request] send outcome UNCERTAIN for visit ${visit.id} — keeping the one-text claim: ${sendErr.message}`);
      await markSendOutcome();
      return skip('send_outcome_uncertain');
    }
    if (!result?.sent) {
      if (result?.retryable || result?.deferred) {
        // AMBIGUOUS provider outcome (Codex #2771 r7): the Twilio adapter
        // classifies timeouts/5xx/429 as retryable non-sent results — the
        // provider may already have accepted the message. Same rule as the
        // thrown-uncertain path: keep the claim consumed and stamp the
        // maybe-sent marker. A definitively-lost send surfaces through the
        // office/abandonment lanes, never as a second bearer link.
        logger.error(`[appt-card-request] send outcome RETRYABLE-ambiguous for visit ${visit.id} — keeping the one-text claim (${result?.code || 'no_code'})`);
        await markSendOutcome();
        return skip('send_outcome_uncertain');
      }
      // A definitive not-sent RESULT (policy block, hard provider
      // rejection): the text never left, so the claim and the fresh
      // pending row release — a later trigger may retry once.
      await releaseClaim();
      return skip(`send_blocked:${result?.code || result?.reason || 'unknown'}`);
    }

    await markSendOutcome();
    // Email leg (owner delivery rule 2026-07-23: an invite goes out on
    // BOTH channels). Strictly after a CONFIRMED-dispatched text — the
    // uncertain/blocked paths above send nothing on either channel, so the
    // email can never outrun the one-text rails or reach a visit the
    // funnel skipped. Best-effort fire-and-forget: the gate being off, no
    // email on file, or a SendGrid failure never changes the funnel result.
    try {
      const { sendAutopaySetupInvitation } = require('./card-enrollment-email');
      sendAutopaySetupInvitation({
        customerId: visit.customer_id,
        scheduledServiceId: visit.id,
        serviceType: visit.service_type || 'service',
        dateLine: dateLineFor(visit.scheduled_date),
        secureUrl,
      }).catch((emailErr) => {
        logger.warn(`[appt-card-request] invitation email leg failed for visit ${visit.id}: ${emailErr.message}`);
      });
    } catch (emailErr) {
      logger.warn(`[appt-card-request] invitation email leg failed to start for visit ${visit.id}: ${emailErr.message}`);
    }
    logger.info(`[appt-card-request] secure-card link sent for visit ${visit.id} (trigger ${trigger})`);
    return { requested: true, action: 'sent', reason: 'sent' };
  } catch (err) {
    logger.error(`[appt-card-request] request failed for visit ${scheduledServiceId}: ${err.message}`);
    return skip(`error:${err.message}`);
  }
}

// ── /secure/:token capture lifecycle (card-on-file spec §3 Phase 5.2) ──
// The page the funnel's SMS points at. Same trust contract as the
// recurring-accept capture (recurring-card-on-file.js): the SetupIntent is
// live-verified against Stripe — status, purpose metadata, AND request id —
// never trusted from the client, and completion runs the same idempotent
// save → consent → enroll sequence as the pay page's /setup-complete.

const MAX_SETUP_INTENT_GENERATIONS = 5;

// Mint (or replay — deterministic idempotency key) the capture SetupIntent
// for a pending request, walking the generation salt past terminal intents
// (same self-heal as createRecurringCardSetupIntentForEstimate). Persists
// the intent id on the row: Phase 4's abandonment stage keys on a pending
// row whose intent never succeeded.
async function createSecureCardSetupIntent(request) {
  const StripeService = require('./stripe');
  for (let generation = 0; generation < MAX_SETUP_INTENT_GENERATIONS; generation += 1) {
    const setupIntent = await StripeService.createAppointmentCardSetupIntent({
      requestId: request.id,
      scheduledServiceId: request.scheduled_service_id,
      generation,
    });
    if (!setupIntent) return null;
    if (setupIntent.status === 'canceled') continue;
    if (setupIntent.id !== request.stripe_setup_intent_id) {
      await db('appointment_card_requests')
        .where({ id: request.id })
        .update({ stripe_setup_intent_id: setupIntent.id, updated_at: new Date() });
    }
    return { clientSecret: setupIntent.client_secret, setupIntentId: setupIntent.id };
  }
  logger.error(`[appt-card-request] exhausted SetupIntent generations for request ${request.id} — all replays terminal`);
  return null;
}

function secureCardIntentMatchesRequest(setupIntent, requestId) {
  return !!setupIntent
    && setupIntent.status === 'succeeded'
    && setupIntent.metadata?.purpose === 'appointment_card_request'
    && String(setupIntent.metadata?.request_id) === String(requestId)
    && !!setupIntent.payment_method;
}

// Live verification — trust re-derived from Stripe, never the client.
async function verifySecureCardIntent({ request, setupIntentId }) {
  if (!setupIntentId) return { ok: false, reason: 'no_setup_intent' };
  let setupIntent = null;
  try {
    const StripeService = require('./stripe');
    setupIntent = await StripeService.retrieveSetupIntent(setupIntentId);
  } catch (err) {
    logger.warn(`[appt-card-request] live SetupIntent verification failed: ${err.message}`);
    return { ok: false, reason: 'verification_failed' };
  }
  if (!secureCardIntentMatchesRequest(setupIntent, request.id)) {
    return { ok: false, reason: 'intent_mismatch' };
  }
  const pm = setupIntent.payment_method;
  return { ok: true, stripePaymentMethodId: typeof pm === 'string' ? pm : pm.id, setupIntentId: setupIntent.id };
}

async function alertCaptureNeedsReview({ customerId, scheduledServiceId, reason }) {
  try {
    await require('./notification-service').notifyAdmin(
      'billing',
      'Secure-appointment card not enrolled',
      `A customer saved a card from the secure-appointment link but it could not be enrolled (${reason}) — re-add a payment method or the visit will invoice unprotected.`,
      { link: customerId ? `/admin/customers/${customerId}` : '/admin/dashboard', metadata: { customerId, scheduledServiceId, reason } },
    );
  } catch (e) { logger.warn(`[appt-card-request] capture review alert failed: ${e.message}`); }
}

// POST /secure/:token completion. Verify live, then the shared completion
// tail below.
async function completeSecureCardCapture({ token, setupIntentId, ip = null, userAgent = null }) {
  const request = await db('appointment_card_requests').where({ token }).first();
  if (!request) return { ok: false, code: 'not_found' };
  if (request.status === 'completed' || request.status === 'satisfied') {
    return { ok: true, alreadyCompleted: true };
  }

  const verified = await verifySecureCardIntent({ request, setupIntentId });
  if (!verified.ok) return { ok: false, code: verified.reason };
  return finishVerifiedSecureCapture({
    request,
    stripePaymentMethodId: verified.stripePaymentMethodId,
    setupIntentId: verified.setupIntentId,
    ip,
    userAgent,
  });
}

// Durability backstop, called from stripe-webhook's setup_intent.succeeded
// dispatch: the SetupIntent succeeded at Stripe (3DS finished) but the
// browser never posted /complete. The intent object arrives signed from
// the webhook, so no re-retrieve is needed — pin it to its request via the
// same purpose/request-id/succeeded checks, then run the same idempotent
// completion tail. A non-pending request no-ops (the page path won).
async function completeSecureCardCaptureFromWebhook(setupIntent) {
  const requestId = setupIntent?.metadata?.request_id;
  if (!requestId) return { ok: false, code: 'no_request_id' };
  const request = await db('appointment_card_requests').where({ id: requestId }).first();
  if (!request) return { ok: false, code: 'not_found' };
  // A row mid-completion (the page POST holds the claim) is NOT done —
  // ack-and-dropping here would burn the durable retry if that attempt
  // then fails and reverts. A FRESH claim reports retryable (the webhook
  // branch throws so Stripe re-delivers); a STALE one falls through to
  // finishVerifiedSecureCapture, whose lease adopts it — the webhook is
  // the only durable retry when the browser died after claiming (Codex
  // #2771 r5), so it must not short-circuit forever.
  if (request.status === 'completing'
    && request.updated_at
    && (Date.now() - new Date(request.updated_at).getTime()) <= STALE_CLAIM_MS) {
    return { ok: false, code: 'completion_in_progress' };
  }
  if (request.status !== 'pending' && request.status !== 'completing') {
    return { ok: true, alreadyCompleted: true };
  }
  if (!secureCardIntentMatchesRequest(setupIntent, request.id)) {
    return { ok: false, code: 'intent_mismatch' };
  }
  const pm = setupIntent.payment_method;
  return finishVerifiedSecureCapture({
    request,
    stripePaymentMethodId: typeof pm === 'string' ? pm : pm.id,
    setupIntentId: setupIntent.id,
  });
}

// Shared completion tail: the idempotent save → consent → enroll sequence
// (mirrors completeRecurringCardEnrollment so enrollment semantics can't
// drift between save surfaces), then the request row flips pending →
// completed (claim-based: only the pending row transitions, so a
// double-submit or page/webhook overlap can't double-write).
//
// Re-derives visit + payer state immediately before saving (Codex #2771
// P1): the office can cancel/reschedule the visit or attach a third-party
// payer between page load and card submit — never save/enroll the
// homeowner's card for a visit that is no longer live or that now bills a
// payer. A payer-lookup failure refuses completion (fail toward not
// enrolling the wrong party); the SetupIntent stays succeeded at Stripe,
// so a retry (page re-POST or webhook redelivery) completes once the
// payer state is readable.
async function finishVerifiedSecureCapture({ request, stripePaymentMethodId, setupIntentId, ip = null, userAgent = null }) {
  const visit = await db('scheduled_services')
    .where({ id: request.scheduled_service_id })
    .first('id', 'status', 'scheduled_date');
  const dateOnly = visit ? callBookingDateOnly(visit.scheduled_date) : null;
  if (!visit
    || !LIVE_VISIT_STATUSES.includes(visit.status)
    || (dateOnly && dateOnly < etDateString(new Date()))) {
    return { ok: false, code: 'no_longer_needed' };
  }
  try {
    const PayerService = require('./payer');
    const resolved = await PayerService.resolveForInvoice({
      customerId: String(request.customer_id),
      scheduledServiceId: String(request.scheduled_service_id),
      throwOnError: true,
    });
    if (resolved?.payerId) return { ok: false, code: 'no_longer_needed' };
  } catch (err) {
    logger.warn(`[appt-card-request] completion payer re-check failed — refusing enrollment for request ${request.id}: ${err.message}`);
    return { ok: false, code: 'completion_failed' };
  }

  // Claim the request BEFORE the side effects run (Codex #2771 r3): the
  // page POST and the setup_intent.succeeded webhook can overlap — the
  // save is idempotent, but recordConsent / enrollConsentedMethod would
  // duplicate consent+autopay audit rows (and enrollment emails when that
  // gate is on). pending → completing is the mutex; the loser sees the
  // fresh status and either acks (already done) or retries
  // (completion_in_progress → the webhook branch throws so Stripe's retry
  // schedule re-runs it; the page returns a retryable 409).
  let claimed = await db('appointment_card_requests')
    .where({ id: request.id, status: 'pending' })
    .update({ status: 'completing', updated_at: new Date() });
  if (claimed !== 1) {
    const fresh = await db('appointment_card_requests').where({ id: request.id }).first('status', 'updated_at');
    if (fresh?.status === 'completed' || fresh?.status === 'satisfied') return { ok: true, alreadyCompleted: true };
    // Stale-claim lease (Codex #2771 r4): a worker killed between the
    // claim and the completed/revert write strands the row 'completing'
    // forever, and both retry paths would spin on completion_in_progress.
    // updated_at is the lease clock — a claim older than the lease is a
    // dead worker's, and the age-guarded UPDATE lets exactly one retrier
    // adopt it.
    if (fresh?.status === 'completing' && fresh.updated_at
      && (Date.now() - new Date(fresh.updated_at).getTime()) > STALE_CLAIM_MS) {
      claimed = await db('appointment_card_requests')
        .where({ id: request.id, status: 'completing' })
        .where('updated_at', '<', new Date(Date.now() - STALE_CLAIM_MS))
        .update({ updated_at: new Date() });
      if (claimed !== 1) return { ok: false, code: 'completion_in_progress' };
      logger.warn(`[appt-card-request] reclaimed stale completion claim for request ${request.id}`);
    } else {
      return { ok: false, code: 'completion_in_progress' };
    }
  }
  // Any failure below puts the row back so a retry (page re-POST or
  // webhook redelivery) can complete — a stranded 'completing' would ack
  // the webhook forever while nothing was saved.
  const revertClaim = async () => {
    try {
      await db('appointment_card_requests')
        .where({ id: request.id, status: 'completing' })
        .update({ status: 'pending', updated_at: new Date() });
    } catch (revertErr) {
      logger.warn(`[appt-card-request] completion claim revert failed for request ${request.id}: ${revertErr.message}`);
    }
  };

  try {
    // Idempotent save: stripe_payment_method_id is unique — a retry after a
    // partial first attempt continues with the existing row.
    let saved = await db('payment_methods').where({ stripe_payment_method_id: stripePaymentMethodId }).first();
    if (saved && String(saved.customer_id) !== String(request.customer_id)) {
      logger.warn(`[appt-card-request] pm ownership mismatch: pm ${stripePaymentMethodId} belongs to ${saved.customer_id}, request customer ${request.customer_id}`);
      await alertCaptureNeedsReview({ customerId: request.customer_id, scheduledServiceId: request.scheduled_service_id, reason: 'pm_ownership_mismatch' });
      await revertClaim();
      return { ok: false, code: 'pm_ownership_mismatch' };
    }
    if (!saved) {
      const StripeService = require('./stripe');
      saved = await StripeService.savePaymentMethod(request.customer_id, stripePaymentMethodId, {
        enableAutopay: false,
        // enrollConsentedMethod owns the default decision.
        makeDefault: false,
      });
    }
    const ConsentService = require('./payment-method-consents');
    if (!(await ConsentService.hasEnrollmentScopedConsent(request.customer_id, stripePaymentMethodId))) {
      // The page rendered the locked card consent verbatim (checkbox-gated)
      // before confirmSetup — this row is the authorization of record.
      await ConsentService.recordConsent({
        customerId: request.customer_id,
        paymentMethodId: saved?.id || null,
        stripePaymentMethodId,
        source: 'appointment_card_request',
        methodType: saved?.method_type || 'card',
        ip,
        userAgent,
      });
    }
    if (saved?.id) {
      await ConsentService.linkPaymentMethodId(stripePaymentMethodId, saved.id);
    }
    const { enrollConsentedMethod } = require('./autopay-enrollment');
    const enrollment = await enrollConsentedMethod({
      customerId: request.customer_id,
      paymentMethodId: saved?.id,
      source: 'save_card_consent',
      details: { via: 'appointment_card_request', scheduled_service_id: request.scheduled_service_id, setup_intent_id: setupIntentId },
    });
    if (!enrollment.enrolled && enrollment.reason !== 'already_enrolled') {
      // A refused enrollment must NOT complete the request (Codex #2771
      // r9): completion billing auto-charges only an active Auto Pay
      // method, so a 'completed' row here would show the visit as secured
      // while it completes unpaid, and every later funnel trigger would
      // skip it. Alert the office, put the row back, and stay retryable —
      // the page re-POST / webhook redelivery re-runs the idempotent
      // sequence (save + consent short-circuit; enrollment re-attempts).
      logger.warn(`[appt-card-request] enrollment refused (${enrollment.reason}) for customer ${request.customer_id} — completion stays retryable`);
      await alertCaptureNeedsReview({ customerId: request.customer_id, scheduledServiceId: request.scheduled_service_id, reason: enrollment.reason });
      await revertClaim();
      return { ok: false, code: 'completion_failed' };
    }

    await db('appointment_card_requests')
      .where({ id: request.id, status: 'completing' })
      .update({
        status: 'completed',
        stripe_setup_intent_id: setupIntentId,
        stripe_payment_method_id: stripePaymentMethodId,
        payment_method_id: saved?.id || null,
        completed_at: new Date(),
        updated_at: new Date(),
      });
    logger.info(`[appt-card-request] capture completed for visit ${request.scheduled_service_id} (request ${request.id})`);
    return { ok: true };
  } catch (err) {
    logger.error(`[appt-card-request] capture completion failed for request ${request.id}: ${err.message}`);
    await alertCaptureNeedsReview({ customerId: request.customer_id, scheduledServiceId: request.scheduled_service_id, reason: err.message });
    await revertClaim();
    return { ok: false, code: 'completion_failed' };
  }
}

// GET /secure/:token page payload. The page keeps working for already-sent
// links even if the send gate is later switched off — the gate governs new
// sends; stranding a customer mid-flow is never the kill-switch behavior.
async function loadSecureCardPageData(token) {
  const request = await db('appointment_card_requests').where({ token }).first();
  if (!request) return null;

  const visit = await db('scheduled_services')
    .where({ id: request.scheduled_service_id })
    .first('id', 'customer_id', 'status', 'scheduled_date', 'window_display', 'service_type');
  const customer = request.customer_id
    ? await db('customers').where({ id: request.customer_id }).first('id', 'first_name')
    : null;
  const base = {
    firstName: customer?.first_name || null,
    serviceType: visit?.service_type || null,
    dateDisplay: visit ? dateLineFor(visit.scheduled_date).replace(/^ on /, '') : null,
    windowDisplay: visit?.window_display || null,
  };

  // 'completing' renders as secured too (Codex #2771 r10): the SetupIntent
  // already succeeded and the page POST or webhook holds the completion
  // claim — showing the card form again mid-save (e.g. on a 3DS redirect
  // return that lost the /complete race) would invite a second card entry.
  // If the in-flight attempt fails and reverts, the durable webhook retry
  // converges the row to completed.
  if (request.status === 'completed' || request.status === 'satisfied' || request.status === 'completing') {
    return { state: 'secured', ...base };
  }
  const dateOnly = visit ? callBookingDateOnly(visit.scheduled_date) : null;
  if (!visit
    || !LIVE_VISIT_STATUSES.includes(visit.status)
    || (dateOnly && dateOnly < etDateString(new Date()))) {
    return { state: 'closed', ...base };
  }

  // Payer re-check before rendering the form (Codex #2771 r4 P3): a payer
  // attached AFTER the link was minted means the homeowner should never be
  // asked for a card — show "nothing needed" now instead of letting them
  // enter a card that completion will refuse. Lookup failure renders the
  // form (completion's own re-check is the enforcement point).
  try {
    const PayerService = require('./payer');
    const resolved = await PayerService.resolveForInvoice({
      customerId: String(request.customer_id),
      scheduledServiceId: String(request.scheduled_service_id),
      throwOnError: true,
    });
    if (resolved?.payerId) return { state: 'closed', ...base };
  } catch (err) {
    logger.warn(`[appt-card-request] page payer re-check failed — rendering the form (completion enforces): ${err.message}`);
  }

  // Coverage re-check (Codex #2771 r7 P3): a customer who enrolled in Auto
  // Pay or saved a consented chargeable card AFTER this link was minted is
  // already covered — mirror the funnel's exemptions and show "secured"
  // instead of asking for another card. Lookup failure renders the form
  // (an extra saved card is a recoverable annoyance, a broken page is not).
  try {
    const { customerOnAutopay } = require('./autopay-eligibility');
    const customerRow = await db('customers').where({ id: request.customer_id }).first();
    if (customerRow && await customerOnAutopay(customerRow)) {
      // Already enrolled with a chargeable method — heal and show secured.
      await db('appointment_card_requests')
        .where({ id: request.id, status: 'pending' })
        .update({ status: 'satisfied', completed_at: new Date(), updated_at: new Date() });
      return { state: 'secured', ...base };
    }
    const { findConsentedChargeableCard } = require('./payment-method-consents');
    const savedMethod = await findConsentedChargeableCard(request.customer_id);
    if (savedMethod) {
      // A consented saved card is only coverage once it's ENROLLED (Codex
      // #2771 r8): completion auto-charge reads active Auto Pay, not this
      // table — a satisfied row without enrollment would complete the
      // visit with no charge while the page claims it's secured. Run the
      // same enroll-first auto-secure the funnel uses; its conflict path
      // heals this pending row to satisfied. A refused/failed enrollment
      // falls through and renders the form.
      const secured = await autoSecureFromSavedMethod({
        visit: { id: request.scheduled_service_id, customer_id: request.customer_id },
        savedMethod,
        trigger: 'secure_page_coverage',
      });
      if (secured.action === 'auto_secured') return { state: 'secured', ...base };
    }
  } catch (err) {
    logger.warn(`[appt-card-request] page coverage re-check failed — rendering the form: ${err.message}`);
  }

  const intent = await createSecureCardSetupIntent(request);
  if (!intent) return { state: 'unavailable', ...base };
  return { state: 'ready', ...base, clientSecret: intent.clientSecret, setupIntentId: intent.setupIntentId };
}

module.exports = {
  requestCardForAppointment,
  isAppointmentCardRequestEnabled,
  isSecureCardLaneReady,
  loadSecureCardPageData,
  completeSecureCardCapture,
  completeSecureCardCaptureFromWebhook,
  _test: {
    dateLineFor,
    resolveExemption,
    autoSecureFromSavedMethod,
    createSecureCardSetupIntent,
    verifySecureCardIntent,
    secureCardIntentMatchesRequest,
  },
};
