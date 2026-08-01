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
// Plan-choice copy variant (owner-approved 2026-07-24): used only when the
// link will open the plan picker AND the variant is active — never a lever
// for the lane itself.
const PLAN_TEMPLATE_KEY = 'secure_appointment_card_plans';
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
    return !!(await renderTemplate({ first_name: 'x', service_type: 'x', date_line: '', secure_link: 'x', cancel_fee_line: '' }));
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

// Cancellation-fee disclosure (owner ruling 2026-07-30): appointment-lane
// card invites state the late-cancel/no-show fee, sourced from the same
// pricing_config the estimate card-hold lane charges from (fallback $49) so
// an admin fee change propagates to the copy. Clause-style with a leading
// newline: resolves to '' when the fee is configured off, so the template
// token vanishes cleanly. Only ever rides on priced visits — the $0/unpriced
// guard above suppresses the whole request first.
function cancelFeeText() {
  try {
    const { cardHoldNoShowFee } = require('./estimate-card-holds');
    const fee = Number(cardHoldNoShowFee());
    if (!(fee > 0)) return null;
    return fee % 1 ? `$${fee.toFixed(2)}` : `$${fee}`;
  } catch (err) {
    logger.warn(`[appt-card-request] cancel-fee amount unavailable — omitting disclosure: ${err.message}`);
    return null;
  }
}

// SMS clause — deliberately COMPACT and GSM-7-safe (no em-dash): the rendered
// plan-choice invite must stay within the card_request three-segment target
// (Codex #3077), so this form trades the fuller sentence for ~27 chars.
function cancelFeeLine() {
  const feeText = cancelFeeText();
  // No rescheduling-reassurance clause in the SMS form: with real service
  // labels (e.g. "Quarterly Pest Control") the longer clause pushed rendered
  // plan-choice invites to a 4th segment (Codex #3077 r2). The /secure page
  // and email keep the fuller sentence.
  return feeText ? `\n${feeText} fee only for last-minute cancels or no-shows.` : '';
}

// Fuller sentence for the /secure page (no SMS segment budget there).
function cancelFeeNote() {
  const feeText = cancelFeeText();
  return feeText ? `A ${feeText} fee applies only for last-minute cancels or no-shows. Rescheduling is always free.` : '';
}

async function renderTemplate(vars, templateKey = TEMPLATE_KEY) {
  try {
    const smsTemplatesRouter = require('../routes/admin-sms-templates');
    if (typeof smsTemplatesRouter.getTemplate === 'function') {
      const body = await smsTemplatesRouter.getTemplate(templateKey, vars);
      if (body) return body;
    }
  } catch (err) {
    logger.warn(`[appt-card-request] template ${templateKey} lookup failed: ${err.message}`);
  }
  return null;
}

// Send-time probe for the plan-choice copy variants (owner-approved
// 2026-07-24): true only when the /secure link will open the plan picker —
// same derivation the page runs (gate off, one-time visits, non-whitelisted
// services, covered lanes all return false and keep the base copy, which
// stays accurate for them). The EXISTING pending request (an inline /book
// row being reused for the one allowed SMS) rides along so its own
// selection state is honored: a request that already picked prepay carries
// its payment_pending term, and without the request the overlap check
// would read that term as external coverage and fall back to the base
// "only charged after service" copy — the one message that is FALSE on the
// prepay_selected page the link opens (Codex #2987). The variant is also
// withheld when the plan carries NO incentive (discount class with
// ANNUAL_PREPAY_DISCOUNT_PCT configured to 0 and no fee waiver) — "prepay
// the year and save" must never promise savings the page won't show
// (Codex #2987). Availability stays live-derived on BOTH ends, so a change
// between send and click degrades to the card-only page; the variant copy
// is written to stay truthful in that case (no dollar amounts, and adding
// a card with nothing charged today remains exactly what the page offers).
async function planInviteApplies(visitId, request = null) {
  try {
    const { buildSecurePlanContext } = require('./secure-appointment-plans');
    const planCtx = await buildSecurePlanContext({ request, visitId });
    return planCtx?.mode === 'recurring'
      && !!(planCtx.setupFee?.waivedWithPrepay || Number(planCtx.prepay?.discount) > 0);
  } catch (err) {
    logger.warn(`[appt-card-request] plan-invite probe failed for visit ${visitId} — using base copy: ${err.message}`);
    return false;
  }
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
      .first('id', 'customer_id', 'status', 'scheduled_date', 'window_display', 'service_type', 'card_link_sent_at', 'estimated_price');
    if (!visit) return skip('visit_not_found');
    if (!visit.customer_id) return skip('no_customer');
    if (!LIVE_VISIT_STATUSES.includes(visit.status)) return skip(`visit_not_live:${visit.status}`);
    const dateOnly = callBookingDateOnly(visit.scheduled_date);
    if (dateOnly && dateOnly < etDateString(new Date())) return skip('visit_in_past');

    // Owner directive 2026-07-30: the card ask only goes out for visits with
    // a real dollar amount. NULL price = manual quote pending (never $0 —
    // billing rule) and 0 = charge nothing; neither should ask for a card,
    // and suppressing the whole request also guarantees the cancellation-fee
    // disclosure below only ever rides on priced visits.
    const visitPrice = visit.estimated_price != null ? Number(visit.estimated_price) : null;
    if (!(visitPrice > 0)) return skip(visitPrice == null ? 'unpriced_visit' : 'zero_price_visit');

    // The template is the second dark lever, and it gates EVERY side
    // effect of this funnel — auto-secure enrollment included, not just
    // the customer-visible text/link (Codex #2771 r8). Probe with fully-
    // resolved dummy vars (getTemplate returns null when the row is
    // missing or inactive); the real body renders later with the live
    // token.
    const templateActive = !!(await renderTemplate({ first_name: 'x', service_type: 'x', date_line: '', secure_link: 'x', cancel_fee_line: '' }));
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

    // Owner rule 2026-07-30: the card ask is for FIRST-TIME customers only.
    // An existing customer with completed service history has an established
    // payment relationship — "add a card to finish booking" reads wrong and
    // was never the intent. (Saved-card auto-secure above still applies to
    // them; only the ASK is gated.) Lookup failure fails toward asking —
    // same posture as the saved-method check.
    try {
      const priorCompleted = await db('scheduled_services')
        .where({ customer_id: visit.customer_id, status: 'completed' })
        .whereNot({ id: visit.id })
        .first('id');
      if (priorCompleted) return skip('existing_customer');
    } catch (err) {
      logger.warn(`[appt-card-request] prior-service check failed — proceeding to request: ${err.message}`);
    }

    // 3. Existing pending/complete capture for this appointment. An inline
    // caller re-running (page refresh, booking retry) gets the SAME pending
    // link back — idempotent, never a second row.
    const existing = await db('appointment_card_requests')
      .where({ scheduled_service_id: visit.id })
      .first('id', 'status', 'token', 'selected_plan', 'annual_prepay_term_id');
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
    const templateVars = {
      first_name: customer?.first_name || 'there',
      service_type: visit.service_type || 'service',
      date_line: dateLineFor(visit.scheduled_date),
      secure_link: secureUrl,
      cancel_fee_line: cancelFeeLine(),
    };
    // The BASE render is the live kill-switch check at the send boundary
    // (Codex #2987 P1): it must run — and pass — before a variant body can
    // be accepted, so deactivating secure_appointment_card between the
    // early probe and this point still blocks the send, variant active or
    // not. Only then is the plan-choice OVERLAY considered: probed for the
    // SMS/email delivery only (inline hands back a URL, no copy), with the
    // EXISTING pending request passed through so a reused link that
    // already selected a plan gets copy matching the page it opens (Codex
    // #2987: the request's own pending term must not read as an external
    // overlap). An inactive variant silently keeps the approved base copy.
    const body0 = await renderTemplate(templateVars);
    if (!body0) return skip('template_inactive');
    let body = body0;
    let usedTemplateKey = TEMPLATE_KEY;
    if (delivery !== 'inline' && await planInviteApplies(visit.id, existing || null)) {
      const variantBody = await renderTemplate(templateVars, PLAN_TEMPLATE_KEY);
      if (variantBody) {
        body = variantBody;
        usedTemplateKey = PLAN_TEMPLATE_KEY;
      }
    }

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
          original_message_type: usedTemplateKey,
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
        // The email variant follows the copy that ACTUALLY went out on the
        // SMS leg — not the raw probe — so the two legs of one invite can
        // never contradict each other (base SMS's unconditional "only
        // charged after service" next to a prepay pitch). Activating the
        // SMS variant in /admin templates is the single copy lever.
        planChoice: usedTemplateKey === PLAN_TEMPLATE_KEY,
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
    .first('id', 'status', 'scheduled_date', 'estimated_price');
  const dateOnly = visit ? callBookingDateOnly(visit.scheduled_date) : null;
  const finishPrice = visit && visit.estimated_price != null ? Number(visit.estimated_price) : null;
  if (!visit
    || !LIVE_VISIT_STATUSES.includes(visit.status)
    // Same price recheck as page load (Codex #3077 P1): a token minted for a
    // since-unpriced/$0 visit must not complete a capture.
    || !(finishPrice > 0)
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

  // Plan-choice lane (Codex #2980 r3): a plan-bearing RECURRING request
  // must carry a durable per_application selection before a card capture
  // may complete — otherwise a token holder could POST /complete directly
  // (or an earlier tab's SetupIntent could land via the webhook) and
  // bypass the required choice and its setup-fee stamp, or complete a
  // capture against a live prepay selection. One-time and context-less
  // requests (gate off, unsound pricing) keep today's behavior; the
  // refusal leaves the request pending, so completing is a matter of
  // making the selection and re-submitting (the SetupIntent stays
  // succeeded at Stripe). buildSecurePlanContext never throws.
  {
    const { buildSecurePlanContext } = require('./secure-appointment-plans');
    const planCtx = await buildSecurePlanContext({ request, visitId: request.scheduled_service_id });
    if (planCtx?.mode === 'recurring' && request.selected_plan !== 'per_application') {
      logger.warn(`[appt-card-request] capture refused for request ${request.id}: plan selection required (selected: ${request.selected_plan || 'none'})`);
      return { ok: false, code: 'plan_required' };
    }
  }

  // Claim the request BEFORE the side effects run (Codex #2771 r3): the
  // page POST and the setup_intent.succeeded webhook can overlap — the
  // save is idempotent, but recordConsent / enrollConsentedMethod would
  // duplicate consent+autopay audit rows (and enrollment emails when that
  // gate is on). pending → completing is the mutex; the loser sees the
  // fresh status and either acks (already done) or retries
  // (completion_in_progress → the webhook branch throws so Stripe's retry
  // schedule re-runs it; the page returns a retryable 409).
  // The claim is PLAN-VALUE-GUARDED (Codex #2980 r4): the plan check above
  // validated the selection this function READ — if a concurrent
  // select-plan switched it (e.g. to prepay_annual) after that read, the
  // guard makes this claim miss and the retry re-reads the fresh request,
  // whose plan_required refusal then applies. selected_plan can only
  // change while the row is 'pending', so the completing lease below never
  // needs the guard.
  let claimQuery = db('appointment_card_requests')
    .where({ id: request.id, status: 'pending' });
  claimQuery = request.selected_plan == null
    ? claimQuery.whereNull('selected_plan')
    : claimQuery.where({ selected_plan: request.selected_plan });
  let claimed = await claimQuery.update({ status: 'completing', updated_at: new Date() });
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

    // Plan-choice lane: an explicit per-application selection moves the
    // customer onto the per_application billing lane once the card is
    // actually enrolled — dispatch's completion auto-charge is gated on
    // that lane, so without the stamp the plan page's "charged
    // automatically after each completed service" would silently degrade
    // to invoice-on-complete. Runs BEFORE the completed flip and a failure
    // keeps the completion retryable (Codex #2980 r3): a completed row
    // short-circuits every later retry, which would strand the customer
    // off the promised lane forever. Idempotent — a retry that finds the
    // lane already stamped no-ops.
    if (request.selected_plan === 'per_application') {
      const { applyPerApplicationLaneStamp } = require('./secure-appointment-plans');
      const laneStamped = await applyPerApplicationLaneStamp({
        customerId: request.customer_id,
        scheduledServiceId: request.scheduled_service_id,
      });
      if (!laneStamped) {
        logger.warn(`[appt-card-request] per-application lane stamp failed for request ${request.id} — completion stays retryable`);
        await revertClaim();
        return { ok: false, code: 'completion_failed' };
      }
    }

    // Frozen fee terms (fee rail, owner-approved 2026-08-01): the /secure
    // page rendered cancelFeeNote from live config — freeze exactly those
    // terms onto the row at the consent moment, so a later config change
    // never moves an agreed fee (card-hold frozen-terms discipline). Only
    // COMPLETED rows are stamped: a `satisfied` row was auto-secured from a
    // saved card and never saw the disclosure, so it must never carry (or be
    // charged) a fee. Fee configured off (cancelFeeText null) → no stamp →
    // the rail skips this visit.
    const frozenFeeTerms = {};
    try {
      const { cardHoldNoShowFee, cardHoldCancelWindowHours } = require('./estimate-card-holds');
      const feeAmount = Number(cardHoldNoShowFee());
      if (feeAmount > 0) {
        frozenFeeTerms.no_show_fee_amount = feeAmount;
        frozenFeeTerms.cancel_window_hours = Number(cardHoldCancelWindowHours()) > 0
          ? Number(cardHoldCancelWindowHours()) : 24;
        frozenFeeTerms.fee_agreed_at = new Date();
      }
    } catch (err) {
      logger.warn(`[appt-card-request] fee-term freeze unavailable for request ${request.id} — completing without fee terms: ${err.message}`);
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
        ...frozenFeeTerms,
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
    .first('id', 'customer_id', 'status', 'scheduled_date', 'window_display', 'service_type', 'estimated_price');
  // Live price recheck (Codex #3077 P1): a request minted before the
  // $0/unpriced send guard existed — or a visit repriced to $0 after the
  // link went out — must not render the capture form, mint a SetupIntent,
  // or show a fee disclosure.
  const visitPrice = visit && visit.estimated_price != null ? Number(visit.estimated_price) : null;
  const visitPriced = visitPrice > 0;
  const customer = request.customer_id
    ? await db('customers').where({ id: request.customer_id }).first('id', 'first_name')
    : null;
  const base = {
    firstName: customer?.first_name || null,
    serviceType: visit?.service_type || null,
    dateDisplay: visit ? dateLineFor(visit.scheduled_date).replace(/^ on /, '') : null,
    windowDisplay: visit?.window_display || null,
    cancelFeeNote: visitPriced ? (cancelFeeNote() || null) : null,
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

  // Plan-choice lane (GATE_SECURE_PLAN_CHOICE; both helpers return null
  // while the gate is off, keeping this payload byte-identical to today).
  // A prepay selection whose invoice settled means the year is covered —
  // heal the pending row to satisfied (mirrors the autopay heal below) and
  // render secured; a live unpaid prepay invoice renders the
  // prepay_selected state at the bottom (pay link + card fallback).
  const { prepaySelectionState, buildSecurePlanContext } = require('./secure-appointment-plans');
  const planState = await prepaySelectionState(request);
  if (planState?.state === 'secured') {
    await db('appointment_card_requests')
      .where({ id: request.id, status: 'pending' })
      .update({ status: 'satisfied', completed_at: new Date(), updated_at: new Date() });
    return { state: 'secured', ...base };
  }
  const dateOnly = visit ? callBookingDateOnly(visit.scheduled_date) : null;
  if (!visit
    || !LIVE_VISIT_STATUSES.includes(visit.status)
    || !visitPriced
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
  // planContext is attached ONLY when the plan-choice gate is on and the
  // booked series yields sound pricing (buildSecurePlanContext returns null
  // otherwise) — its absence is the client's signal to render the original
  // card-only page. prepay_selected keeps the SetupIntent alive so the
  // "save a card and pay per visit instead" fallback works on that state.
  const planContext = await buildSecurePlanContext({ request, visitId: request.scheduled_service_id });
  if (planState?.state === 'prepay_selected') {
    return {
      state: 'prepay_selected',
      ...base,
      payUrl: planState.payUrl,
      clientSecret: intent.clientSecret,
      setupIntentId: intent.setupIntentId,
      ...(planContext ? { planContext } : {}),
    };
  }
  return {
    state: 'ready',
    ...base,
    clientSecret: intent.clientSecret,
    setupIntentId: intent.setupIntentId,
    ...(planContext ? { planContext } : {}),
  };
}

// ── No-show / late-cancel fee rail (owner-approved 2026-08-01) ────────────
// The lane's SMS + /secure page disclose a late-cancel/no-show fee, but until
// this rail the only charge path lived on estimate_card_holds — office/AI-
// booked visits secured HERE had a disclosed fee nothing could collect.
// Mirrors the card-hold rail's postures exactly (staleness guards, claim
// mechanics, ambiguous-outcome parking, face-value surcharge-exempt charge,
// paid-refundable-invoice settlement) with the appointment_card_requests row
// as the anchor. Dark behind GATE_APPT_CARD_NO_SHOW_FEE.
//
// Eligibility is deliberately narrow (fail toward not charging):
//   - status='completed' ONLY — the customer went through the /secure page,
//     which rendered the fee disclosure; `satisfied` rows never saw it.
//   - frozen terms present (no_show_fee_amount > 0, stamped at consent) —
//     rows completed before the fee-terms migration are never charged.
//   - fee_status IS NULL — one fee event per visit, ever.
//   - NO estimate_card_holds row for the visit (any status): the hold rail
//     owns estimate-flow bookings; two rails must never both see one visit.

function isApptCardFeeRailEnabled() {
  try {
    return require('../config/feature-gates').isEnabled('apptCardNoShowFee');
  } catch (err) {
    logger.warn(`[appt-card-request] fee-rail gate read failed — treating as off: ${err.message}`);
    return false;
  }
}

async function feeEligibleRequestForVisit(scheduledServiceId) {
  const request = await db('appointment_card_requests')
    .where({ scheduled_service_id: scheduledServiceId })
    .first();
  if (!request) return { request: null, reason: 'no_card_request' };
  if (request.status !== 'completed') return { request: null, reason: 'not_completed' };
  if (!(Number(request.no_show_fee_amount) > 0)) return { request: null, reason: 'no_agreed_fee' };
  if (!request.stripe_payment_method_id || !request.customer_id) return { request: null, reason: 'no_charge_target' };
  if (request.fee_status) return { request: null, reason: `fee_${request.fee_status}` };
  const hold = await db('estimate_card_holds')
    .where({ scheduled_service_id: scheduledServiceId })
    .first('id')
    .catch(() => null);
  if (hold) return { request: null, reason: 'card_hold_lane' };
  return { request };
}

// Same window formula as the card-hold rail, with fee_agreed_at (the consent
// moment) as the booking-age anchor: the free-cancel period a late securer
// gets is exactly the time they've had the agreement. Missing/skewed
// fee_agreed_at keeps the full frozen window (never wider than disclosed
// except through the booking-age rule itself).
function isWithinApptCancelWindow({ request, serviceStart, now = new Date() }) {
  const windowHours = Number(request?.cancel_window_hours) > 0 ? Number(request.cancel_window_hours) : 24;
  const start = serviceStart instanceof Date ? serviceStart : new Date(serviceStart);
  if (Number.isNaN(start.getTime())) return false;
  let windowMs = windowHours * 3600000;
  const agreedAt = request?.fee_agreed_at ? new Date(request.fee_agreed_at) : null;
  if (agreedAt && !Number.isNaN(agreedAt.getTime())) {
    const msSinceAgreed = now.getTime() - agreedAt.getTime();
    if (msSinceAgreed >= 0) windowMs = Math.min(windowMs, msSinceAgreed);
  }
  const { CARD_HOLD_POST_START_GRACE_MS } = require('./estimate-card-holds');
  const msUntilStart = start.getTime() - now.getTime();
  return msUntilStart > -CARD_HOLD_POST_START_GRACE_MS && msUntilStart <= windowMs;
}

async function chargeAppointmentNoShowFee({ scheduledServiceId, reason = 'no_show', serviceStart = null, now = new Date() }) {
  if (!isApptCardFeeRailEnabled()) return { charged: false, reason: 'feature_disabled' };
  const { request, reason: skipReason } = await feeEligibleRequestForVisit(scheduledServiceId);
  if (!request) return { charged: false, reason: skipReason };
  const feeAmount = Number(request.no_show_fee_amount);

  // Staleness guard — identical posture to the card-hold rail: the fee is
  // for a FRESH missed visit; cleanup of ancient rows must never bill.
  const { NO_SHOW_FEE_MAX_AGE_MS } = require('./estimate-card-holds');
  let start = serviceStart;
  if (!start) {
    try {
      const { scheduledServiceApptTime } = require('./appointment-reminders');
      start = await scheduledServiceApptTime(scheduledServiceId);
    } catch (err) {
      logger.warn(`[appt-card-request] appt-time resolution for no-show fee failed — not charging: ${err.message}`);
    }
  }
  const startDate = start instanceof Date ? start : (start ? new Date(start) : null);
  const startMs = startDate && !Number.isNaN(startDate.getTime()) ? startDate.getTime() : null;
  if (startMs == null || now.getTime() - startMs > NO_SHOW_FEE_MAX_AGE_MS) {
    const staleReason = startMs == null ? 'no_show_start_unresolved' : 'no_show_stale_start';
    logger.warn(`[appt-card-request] no-show fee refused (${staleReason}) for visit ${scheduledServiceId}`);
    try {
      await require('./notification-service').notifyAdmin(
        'billing',
        'No-show fee not charged',
        startMs == null
          ? 'A visit was marked no-show but its scheduled time could not be resolved — the saved-card fee was NOT charged. Bill manually if the fee applies.'
          : `A visit was marked no-show more than ${Math.round(NO_SHOW_FEE_MAX_AGE_MS / 3600000)} hours after its scheduled time — the saved-card fee was NOT charged. Bill manually if the fee applies.`,
        {
          link: request.customer_id ? `/admin/customers/${request.customer_id}` : '/admin/dispatch',
          metadata: { scheduledServiceId, reason: staleReason },
        },
      );
    } catch (e) { logger.warn(`[appt-card-request] stale no-show alert failed: ${e.message}`); }
    return { charged: false, reason: staleReason };
  }

  // Atomic charge claim: NULL -> 'charging'. One fee event per visit, ever.
  const claimed = await db('appointment_card_requests')
    .where({ id: request.id })
    .whereNull('fee_status')
    .update({ fee_status: 'charging', updated_at: new Date() });
  if (claimed !== 1) return { charged: false, reason: 'fee_claim_lost' };

  // Charge FIRST (separately from the row write) so a post-charge DB failure
  // is never confused with a pre-charge failure. Attach self-heal is
  // idempotent — the completion tail normally attached the PM already.
  const StripeService = require('./stripe');
  let paymentIntent;
  try {
    const { attachCardHoldPaymentMethod } = require('./estimate-card-holds');
    await attachCardHoldPaymentMethod({ customerId: request.customer_id, paymentMethodId: request.stripe_payment_method_id });
    paymentIntent = await StripeService.chargeSavedPaymentMethodOffSession({
      customerId: request.customer_id,
      paymentMethodId: request.stripe_payment_method_id,
      amountDollars: feeAmount,
      description: 'Waves one-time visit — no-show / late-cancellation fee',
      metadata: {
        purpose: 'appointment_card_no_show_fee',
        request_id: String(request.id),
        scheduled_service_id: String(scheduledServiceId),
        reason,
      },
      idempotencyKey: `appt_card_no_show_${request.id}`,
    });
  } catch (err) {
    // Same triage as the card-hold rail: a DEFINITE pre-charge failure
    // reopens the claim (safe to retry); an AMBIGUOUS connection/API error
    // may have charged — park charge_review so a >24h retry can never mint
    // a SECOND fee once Stripe's idempotency cache expires.
    const errType = err.type || err.raw?.type || null;
    const piIdFromErr = err.payment_intent?.id || err.raw?.payment_intent?.id || null;
    const ambiguous = !piIdFromErr && ['StripeConnectionError', 'StripeAPIError'].includes(errType);
    if (ambiguous) {
      await db('appointment_card_requests').where({ id: request.id, fee_status: 'charging' })
        .update({ fee_status: 'charge_review', updated_at: new Date() }).catch(() => {});
      logger.error(`[appt-card-request] no-show fee charge AMBIGUOUS (possible charge) — parked charge_review for visit ${scheduledServiceId}: ${err.message}`);
      return { charged: false, reason: 'charge_review', error: err.message };
    }
    await db('appointment_card_requests').where({ id: request.id, fee_status: 'charging' })
      .update({ fee_status: null, updated_at: new Date() }).catch(() => {});
    logger.error(`[appt-card-request] no-show fee charge FAILED (no charge) for visit ${scheduledServiceId}: ${err.message}`);
    return { charged: false, reason: 'charge_failed', error: err.message };
  }

  // PI succeeded. A DB-write failure must NOT reopen the claim (Stripe's
  // idempotency cache expires ~24h — a retry would double-charge): park
  // charge_review keeping the PI pointer.
  try {
    await db('appointment_card_requests').where({ id: request.id }).update({
      fee_status: 'charged',
      no_show_payment_intent_id: paymentIntent?.id || null,
      fee_charged_amount: feeAmount,
      fee_charged_at: new Date(),
      updated_at: new Date(),
    });
  } catch (writeErr) {
    await db('appointment_card_requests').where({ id: request.id, fee_status: 'charging' })
      .update({
        fee_status: 'charge_review',
        no_show_payment_intent_id: paymentIntent?.id || null,
        fee_charged_amount: feeAmount,
        fee_charged_at: new Date(),
        updated_at: new Date(),
      }).catch(() => {});
    logger.error(`[appt-card-request] no-show fee CHARGED but DB write failed — parked charge_review (NOT retryable) for visit ${scheduledServiceId} (PI ${paymentIntent?.id})`);
    return { charged: true, amount: feeAmount, reason: 'charge_review_write_failed' };
  }
  logger.info(`[appt-card-request] no-show fee charged for visit ${scheduledServiceId} ($${feeAmount}, ${reason})`);
  return { charged: true, amount: feeAmount };
}

// Cancel-path entry, run by the same call sites as the card-hold handler
// (which supersedes — callers try the hold rail first, and this rail's own
// eligibility skips any visit with a hold row). waiveFee is the business-
// initiated escape hatch: WE cancelled, so the fee event closes 'waived'
// and can never fire later.
async function handleAppointmentCardCancellation({ scheduledServiceId, serviceStart = null, now = new Date(), waiveFee = false }) {
  const { request, reason: skipReason } = await feeEligibleRequestForVisit(scheduledServiceId);
  if (!request) return { handled: false, released: true, reason: skipReason };
  if (waiveFee) {
    const waived = await db('appointment_card_requests').where({ id: request.id }).whereNull('fee_status')
      .update({ fee_status: 'waived', updated_at: new Date() });
    if (waived !== 1) {
      // A concurrent charge claimed the row between the eligibility read and
      // this waive — fail closed (offboarding gates its deposit refund on a
      // clean release, mirroring the card-hold lost-race posture).
      logger.warn(`[appt-card-request] fee waive lost a race for visit ${scheduledServiceId} — review before proceeding`);
      return { handled: false, released: false, reason: 'waive_race_lost' };
    }
    logger.info(`[appt-card-request] fee waived (business-initiated cancel) for visit ${scheduledServiceId}`);
    return { handled: true, released: true, reason: 'admin_waive' };
  }
  let start = serviceStart;
  if (!start) {
    try {
      const { scheduledServiceApptTime } = require('./appointment-reminders');
      start = await scheduledServiceApptTime(scheduledServiceId);
    } catch (err) {
      logger.warn(`[appt-card-request] appt-time resolution for cancel failed — no fee: ${err.message}`);
    }
  }
  if (start && isApptCardFeeRailEnabled() && isWithinApptCancelWindow({ request, serviceStart: start, now })) {
    return chargeAppointmentNoShowFee({ scheduledServiceId, reason: 'late_cancel', serviceStart: start, now });
  }
  const startDate = start instanceof Date ? start : (start ? new Date(start) : null);
  const startPassed = startDate && !Number.isNaN(startDate.getTime()) && startDate.getTime() <= now.getTime();
  return { handled: true, released: true, reason: startPassed ? 'cancel_past_start' : 'cancel_outside_window' };
}

// Read-only preview for the admin cancel UIs — merged into the existing
// GET /admin/dispatch/:serviceId/card-hold response so the client confirm
// prompts cover both lanes unchanged.
async function appointmentCardCancelPreview(scheduledServiceId, now = new Date()) {
  const { request } = await feeEligibleRequestForVisit(scheduledServiceId);
  if (!request) return { secured: false, feeApplies: false };
  let start = null;
  try {
    const { scheduledServiceApptTime } = require('./appointment-reminders');
    start = await scheduledServiceApptTime(scheduledServiceId);
  } catch (err) {
    logger.warn(`[appt-card-request] appt-time resolution for cancel preview failed: ${err.message}`);
  }
  const feeApplies = isApptCardFeeRailEnabled() && !!start && isWithinApptCancelWindow({ request, serviceStart: start, now });
  return { secured: true, feeApplies, feeAmount: Number(request.no_show_fee_amount) };
}

// Settlement: turn the bare off-session fee charge into a paid, refundable
// fee invoice + payments row + canonical receipt — contract-for-contract
// with the card-hold settleNoShowFee (advisory-lock serialized, in-lock
// replay check, face value, taxRate 0, self-pay). Driven from the
// appointment_card_no_show_fee webhook; idempotent on the PI.
async function settleAppointmentNoShowFee(paymentIntent) {
  const piId = paymentIntent?.id;
  const customerId = paymentIntent?.metadata?.waves_customer_id || null;
  if (!piId || !customerId) return { settled: false, reason: 'missing_pi_or_customer' };

  // Pre-settlement refund guard — FAIL CLOSED on a retrieve error (throw so
  // Stripe retries): settling gross would book already-refunded money.
  const StripeService = require('./stripe');
  let preRefundedCents = 0;
  try {
    const live = await StripeService.retrievePaymentIntent(piId, { expand: ['latest_charge'] });
    const ch = live?.latest_charge;
    if (ch && typeof ch === 'object') {
      const chargedCents = Math.round(Number(ch.amount || 0));
      preRefundedCents = Math.max(0, Math.round(Number(ch.amount_refunded || 0)));
      if (ch.refunded === true || (chargedCents > 0 && preRefundedCents >= chargedCents)) {
        logger.warn(`[appt-card-request] no-show fee fully refunded before settlement — skipping (${piId})`);
        return { settled: false, reason: 'refunded_pre_settlement' };
      }
    }
  } catch (err) {
    logger.error(`[appt-card-request] pre-settlement refund check failed — deferring to Stripe retry (${piId}): ${err.message}`);
    throw err;
  }

  const amount = Math.round(Number(paymentIntent.amount_received || paymentIntent.amount || 0)) / 100;
  const reason = paymentIntent.metadata?.reason || 'no_show';
  const requestId = paymentIntent.metadata?.request_id || null;
  const scheduledServiceId = paymentIntent.metadata?.scheduled_service_id || null;
  const feeLabel = reason === 'late_cancel' ? 'Late-cancellation fee' : 'No-show fee';

  const InvoiceService = require('./invoice');
  const description = `One-time visit — ${feeLabel.toLowerCase()}`;
  const result = await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`appointment_card_no_show_fee:${piId}`]);
    const existing = await trx('payments').where({ stripe_payment_intent_id: piId }).first('id');
    if (existing) return { replay: true };

    // Face value, NO tax: the fee must equal the amount disclosed + charged.
    const inv = await InvoiceService.create({
      database: trx,
      customerId,
      title: description,
      lineItems: [{ description: `${feeLabel} — one-time visit`, quantity: 1, unit_price: amount, amount }],
      taxRate: 0,
      dueDate: etDateString(),
      skipAccrual: true,
    });
    // SELF-PAY: charged to the homeowner's saved card — never route the fee
    // invoice/receipt to a third-party payer.
    await trx('invoices').where({ id: inv.id }).update({
      status: 'paid',
      paid_at: trx.fn.now(),
      stripe_payment_intent_id: piId,
      stripe_charge_id: paymentIntent.latest_charge || null,
      payer_id: null,
      payer_snapshot: null,
      updated_at: trx.fn.now(),
    });
    await trx('payments').insert({
      customer_id: customerId,
      processor: 'stripe',
      stripe_payment_intent_id: piId,
      stripe_charge_id: paymentIntent.latest_charge || null,
      payment_date: etDateString(),
      amount,
      refund_amount: preRefundedCents > 0 ? preRefundedCents / 100 : 0,
      refund_status: preRefundedCents > 0 ? 'partial' : null,
      status: 'paid',
      description,
      metadata: JSON.stringify({
        purpose: 'appointment_card_no_show_fee',
        invoice_id: inv.id,
        request_id: requestId,
        scheduled_service_id: scheduledServiceId,
        reason,
      }),
    });
    return { invoice: inv };
  });
  const { sendNoShowFeeReceipt } = require('./estimate-card-holds');
  if (result.replay) {
    try {
      const inv = await db('invoices').where({ stripe_payment_intent_id: piId })
        .whereNot('status', 'void').orderBy('created_at', 'desc').first('id', 'token', 'receipt_sent_at');
      if (inv?.id && !inv.receipt_sent_at) {
        await sendNoShowFeeReceipt({ invoice: inv, customerId, amount, feeLabel, reason });
      }
    } catch (err) {
      logger.warn(`[appt-card-request] replay receipt recovery failed (non-fatal): ${err.message}`);
    }
    return { settled: false, replay: true };
  }
  const invoice = result.invoice;
  logger.info(`[appt-card-request] no-show fee settled as paid invoice ${invoice.id} (customer ${customerId}, ${reason})`);
  try {
    await sendNoShowFeeReceipt({ invoice, customerId, amount, feeLabel, reason });
  } catch (err) {
    logger.warn(`[appt-card-request] no-show fee receipt/notify failed (non-fatal): ${err.message}`);
  }
  return { settled: true, invoiceId: invoice.id };
}

module.exports = {
  requestCardForAppointment,
  isAppointmentCardRequestEnabled,
  isSecureCardLaneReady,
  loadSecureCardPageData,
  completeSecureCardCapture,
  completeSecureCardCaptureFromWebhook,
  chargeAppointmentNoShowFee,
  handleAppointmentCardCancellation,
  appointmentCardCancelPreview,
  settleAppointmentNoShowFee,
  isWithinApptCancelWindow,
  _test: {
    dateLineFor,
    resolveExemption,
    autoSecureFromSavedMethod,
    createSecureCardSetupIntent,
    verifySecureCardIntent,
    secureCardIntentMatchesRequest,
  },
};
