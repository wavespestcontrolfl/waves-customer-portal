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
  // Trailing-space clause (owner spacing pass 2026-08-11): the templates
  // place {cancel_fee_line} directly before the card-security sentence so
  // the two disclosures share one line; '' when the fee is off must leave
  // that line starting cleanly at "We never".
  return feeText ? `${feeText} fee only for last-minute cancels or no-shows. ` : '';
}

// ONE coherent read of the fee disclosure (Codex #3153 r4 P1): the note in
// the page payload and the values the render stamp freezes MUST come from
// the same snapshot — a config refresh mid-request (while the GET awaits
// the SetupIntent or plan context) must never let the row authorize terms
// the response didn't show. The EXACT enforced window is part of the
// disclosure (r3 P0): a fee collected under an undisclosed cutoff is not
// consented. null = no disclosure (fee off, or source unavailable — never
// enforce a term we can't state).
function readCancelFeeDisclosure() {
  try {
    const { cardHoldNoShowFee, cardHoldCancelWindowHours } = require('./estimate-card-holds');
    const feeAmount = Number(cardHoldNoShowFee());
    if (!(feeAmount > 0)) return null;
    const windowHours = Number(cardHoldCancelWindowHours()) > 0 ? Number(cardHoldCancelWindowHours()) : 24;
    const feeText = feeAmount % 1 ? `$${feeAmount.toFixed(2)}` : `$${feeAmount}`;
    return {
      feeAmount,
      windowHours,
      note: `A ${feeText} fee applies only to no-shows or cancellations less than ${windowHours} hours before your visit. Rescheduling is always free, though a reschedule made within ${windowHours} hours doesn't reset the cancellation window.`,
    };
  } catch (err) {
    logger.warn(`[appt-card-request] fee disclosure unavailable — omitting: ${err.message}`);
    return null;
  }
}

// Fuller sentence for the /secure page (no SMS segment budget there) —
// kept for non-page callers; the page itself uses readCancelFeeDisclosure
// so the note and the stamped terms share one snapshot.
function cancelFeeNote() {
  const disclosure = readCancelFeeDisclosure();
  return disclosure ? disclosure.note : '';
}

// Post-consent (secured) renders repeat the terms the ROW actually carries
// (Codex #3153 r9 P1): the secured page's "only charged after your service
// is completed" would otherwise contradict an enforceable no-show fee the
// customer agreed to. Frozen row values only — never live config — and
// never a fee for `satisfied` rows (auto-secured, no disclosure = no fee).
function frozenFeeNoteForRow(request) {
  if (request?.status !== 'completed' && request?.status !== 'completing') return null;
  const fee = Number(request?.no_show_fee_amount);
  const windowHours = Number(request?.cancel_window_hours);
  if (!(fee > 0) || !(windowHours > 0)) return null;
  const feeText = fee % 1 ? `$${fee.toFixed(2)}` : `$${fee}`;
  // The reset sentence follows the row's own consent marker (pre-push r8
  // P1): a legacy row (sticky_window_disclosed=false) never accepted the
  // sticky rule and enforcement never sticky-charges it — its secured
  // render must repeat the terms it accepted, not the current copy.
  const stickyClause = request?.sticky_window_disclosed
    ? `, though a reschedule made within ${windowHours} hours doesn't reset the cancellation window`
    : '';
  return `A ${feeText} fee applies only to no-shows or cancellations less than ${windowHours} hours before your visit. Rescheduling is always free${stickyClause}.`;
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

// Recipient identity for deferred rows (last-10 comparison, refresh vs
// freeze) lives in services/messaging/deferred-recipient-identity.js — a
// single owner for the rule so bearer links can't diverge between the
// secure-card and estimate paths.

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
  // Write-time live-status re-check (Codex #3361 r9 P1): the caller's
  // entry read can be stale by the time this runs (the legacy-activation
  // hook window), and enabling Auto Pay + writing a satisfied row for a
  // just-rejected visit leaves an enrollment nothing releases — the
  // cancellation follow-through only unwinds requests it can find at
  // cancel time. Same LIVE_VISIT_STATUSES contract as the entry check;
  // fail toward skip (retryable on the next trigger).
  try {
    const live = await db('scheduled_services').where({ id: visit.id }).first('status');
    if (!live || !LIVE_VISIT_STATUSES.includes(live.status)) {
      return skip(`visit_not_live_at_secure:${live ? live.status : 'missing'}`);
    }
  } catch (err) {
    logger.warn(`[appt-card-request] live-status re-check failed for visit ${visit.id} — auto-secure skipped (retryable): ${err.message}`);
    return skip('status_recheck_failed');
  }
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
      // Completion-charge cap, frozen at the auto-secure moment (Codex
      // #3153 r1 P1): later price edits must never widen what the saved
      // consent covers. Fee terms are deliberately NOT stamped — a
      // satisfied row never saw the fee disclosure.
      accepted_amount: visit.estimated_price != null && Number(visit.estimated_price) > 0
        ? Number(visit.estimated_price) : null,
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
        // The heal targets a PENDING page row that may carry a lower cap or
        // the sticky 0 sentinel from an earlier render — monotonic-down,
        // never a plain overwrite (Codex #3153 r6 P1). (The fresh-row
        // INSERT above stamps the value directly: no prior disclosure.)
        ...(visit.estimated_price != null && Number(visit.estimated_price) > 0 ? {
          accepted_amount: db.raw(
            'CASE WHEN accepted_amount = 0 THEN 0 ELSE LEAST(COALESCE(accepted_amount, ?::numeric), ?::numeric) END',
            [Number(visit.estimated_price), Number(visit.estimated_price)],
          ),
        } : {}),
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

    // delivery 'none' = the caller wanted ONLY the non-messaging work above
    // (policy exemption + saved-card auto-secure) — the AI call pipeline
    // uses it when the call-level TCPA verdict blocked messaging, so this
    // path must never mint a token or send a card link on stored consent
    // (Codex #3361 r3 P1). The pre-visit sweep and a later cleared trigger
    // remain the ask's delivery surfaces.
    if (delivery === 'none') return skip('delivery_suppressed');

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
        // trigger 'admin' = the schedule page's explicit "request card"
        // click; every other trigger (previsit sweep, call pipeline,
        // outbound confirm, booking) is automation and stays fenced by
        // the send window.
        ...(trigger === 'admin' ? { operatorInitiated: true } : {}),
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
      // blocked:true is a VALIDATOR stop — the pipeline never reached the
      // provider, so the outcome is definitive even when the result also
      // advertises deferral timing (the send-window block returns
      // retryable/deferred/nextAllowedAt for callers that self-reschedule).
      // Only a provider-phase retryable result is genuinely ambiguous.
      if ((result?.retryable || result?.deferred) && !result?.blocked) {
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
      // Send-window hold: the one-shot automation triggers
      // (ai_call_pipeline, outbound_review_confirm, booking) never retry,
      // and the previsit backstop is independent — a released claim here
      // would just drop the card request. Queue the exact link SMS on the
      // scheduled rail; the ONE-TEXT claim stays consumed (the queued row
      // now owns the single bearer-link text — releasing would let a later
      // trigger double-text) and the maybe-sent marker is stamped so the
      // stale-claim lease can't re-text either. The registry's recheck
      // suppresses if the card gets captured or the visit dies overnight,
      // and its onTerminal releases the stamp-guarded claim + owned row so
      // a later trigger can retry.
      if (result?.code === 'QUIET_HOURS_HOLD' && result?.deferred && result?.nextAllowedAt) {
        try {
          const TWILIO_NUMBERS = require('../config/twilio-numbers');
          const { recipientRefreshStamp } = require('./messaging/deferred-recipient-identity');
          const recipientStamp = await recipientRefreshStamp({
            customerId: visit.customer_id,
            recipientPhone: smsTo,
            customerRow: customer || null,
            label: 'appt-card-request',
          });
          await db('sms_log').insert({
            customer_id: visit.customer_id,
            direction: 'outbound',
            from_phone: TWILIO_NUMBERS.getOutboundNumber(),
            to_phone: smsTo,
            message_body: body,
            status: 'scheduled',
            scheduled_for: new Date(result.nextAllowedAt),
            message_type: usedTemplateKey,
            metadata: JSON.stringify({
              entry_point: 'appointment_card_request_deferred',
              scheduled_service_id: visit.id,
              trigger,
              original_block_code: result.code,
              replay_purpose: 'card_request',
              // Refresh-vs-freeze is decided by the SHARED classifier
              // (codex r23) so the secure-card link and the estimate links
              // can never diverge on phone normalization or lookup-failure
              // behavior. The rule it encodes is the one this path has
              // always needed: an explicit recipientPhone (the consented
              // inbound caller when the saved customer phone is a
              // spouse/alternate slot, Codex #2771) is a per-send recipient
              // DECISION, and swapping it for customers.phone at replay
              // would text the bearer link to a different person than the
              // immediate path chose. The frozen number still passes the
              // full send-time validator chain (opt-out, suppressions,
              // line type) at replay.
              ...recipientStamp,
              resolve_from_by_customer: true,
              card_claim_stamp: stamp.toISOString(),
              // For the finalize's email twin (both-channels rule). The
              // body above already carries the tokenized link, so the
              // metadata copy adds no new exposure.
              card_secure_url: secureUrl,
              card_template_key: usedTemplateKey,
              // Token only when THIS call owns the pending row (the body
              // already carries the tokenized link, so no new exposure);
              // a reused /book row must never be deleted by onTerminal.
              ...(reuseToken ? {} : { card_row_token: token }),
            }),
          });
          await markSendOutcome();
          logger.info(`[appt-card-request] card-link SMS for visit ${visit.id} held outside the 8AM-8PM ET send window — queued for ${result.nextAllowedAt}`);
          return skip('send_deferred_window');
        } catch (queueErr) {
          logger.error(`[appt-card-request] held card-link requeue failed for visit ${visit.id}: ${queueErr.message} — releasing for a later trigger`);
        }
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
    // funnel skipped. (The window-held path is the one exception: its
    // queued SMS row owns the text, and the deferred-replay finalize runs
    // this same helper after that SMS delivers.) Best-effort
    // fire-and-forget: the gate being off, no email on file, or a
    // SendGrid failure never changes the funnel result.
    try {
      runInvitationEmailLeg({ visit, secureUrl, planChoice: usedTemplateKey === PLAN_TEMPLATE_KEY })
        .catch((emailErr) => {
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

// Email twin of the secure-card invite, shared by the immediate path
// (fire-and-forget above) and the deferred-replay finalize (after the
// window-held SMS delivers the next morning) so both channels always
// travel together. The EMAIL's disclosed fee terms become another
// monotonic bound on the row BEFORE the email leaves (Codex #3153 r21
// P1): a config change between this invitation and the customer's later
// /secure render must never let the row enforce wider/higher terms than
// the invitation stated. If the stamp cannot be persisted — or the row
// left 'pending' between read and stamp (Codex #3153 r22 P1) — the email
// omits the fee sentence entirely; never a term we didn't freeze.
async function runInvitationEmailLeg({ visit, secureUrl, planChoice }) {
  const { sendAutopaySetupInvitation } = require('./card-enrollment-email');
  let emailFeeDisclosure = readCancelFeeDisclosure();
  if (emailFeeDisclosure) {
    try {
      const stampedRows = await db('appointment_card_requests')
        .where({ scheduled_service_id: visit.id, status: 'pending' })
        .update({
          no_show_fee_amount: db.raw(
            'CASE WHEN cancel_window_hours = 0 THEN NULL ELSE LEAST(COALESCE(no_show_fee_amount, ?::numeric), ?::numeric) END',
            [emailFeeDisclosure.feeAmount, emailFeeDisclosure.feeAmount],
          ),
          cancel_window_hours: db.raw(
            'CASE WHEN cancel_window_hours = 0 THEN 0 ELSE LEAST(COALESCE(cancel_window_hours, ?::int), ?::int) END',
            [emailFeeDisclosure.windowHours, emailFeeDisclosure.windowHours],
          ),
          // Deliberately NO sticky marker write here either (Codex
          // #3342 r5 P1) — the marker is consent-time-only, written by
          // finishVerifiedSecureCapture from the completing tab's echo.
          updated_at: new Date(),
        });
      if (stampedRows !== 1) {
        // The row left 'pending' between our read and this stamp
        // (Codex #3153 r22 P1) — the email must not state terms the
        // row is not bound by. Omit the sentence entirely.
        logger.warn(`[appt-card-request] email disclosure stamp hit ${stampedRows} rows for visit ${visit.id} — omitting the fee sentence`);
        emailFeeDisclosure = null;
      }
    } catch (stampErr) {
      logger.warn(`[appt-card-request] email disclosure stamp failed for visit ${visit.id} — omitting the fee sentence: ${stampErr.message}`);
      emailFeeDisclosure = null;
    }
  }
  await sendAutopaySetupInvitation({
    customerId: visit.customer_id,
    scheduledServiceId: visit.id,
    serviceType: visit.service_type || 'service',
    dateLine: dateLineFor(visit.scheduled_date),
    secureUrl,
    feeDisclosure: emailFeeDisclosure,
    // The email variant follows the copy that ACTUALLY went out on the
    // SMS leg — not the raw probe — so the two legs of one invite can
    // never contradict each other (base SMS's unconditional "only
    // charged after service" next to a prepay pitch). Activating the
    // SMS variant in /admin templates is the single copy lever.
    planChoice,
  });
}

// Deferred-replay finalize for `appointment_card_request_deferred`: the
// queued card-link SMS just delivered, so the owner's both-channels rule
// now owes the email twin. Best-effort with the same contract as the
// immediate path's fire-and-forget — an email failure never unwinds the
// replay settlement, so this reports ok:true unconditionally (no durable
// retry rail; the inline path has none either). Rows queued before the
// secure-url metadata existed skip quietly.
async function sendDeferredInvitationEmailLeg(meta = {}) {
  try {
    if (!meta.scheduled_service_id || !meta.card_secure_url) return { ok: true };
    const visit = await db('scheduled_services')
      .where({ id: meta.scheduled_service_id })
      .first('id', 'customer_id', 'service_type', 'scheduled_date');
    if (!visit) return { ok: true };
    await runInvitationEmailLeg({
      visit,
      secureUrl: meta.card_secure_url,
      planChoice: meta.card_template_key === PLAN_TEMPLATE_KEY,
    });
  } catch (emailErr) {
    logger.warn(`[appt-card-request] deferred invitation email leg failed for visit ${meta.scheduled_service_id}: ${emailErr.message}`);
  }
  return { ok: true };
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

// Records the browser's attested disclosure echo on a row the WEBHOOK
// completed — the webhook tail carries no echo and stamps non-sticky, so
// the confirming tab's later/racing POST is the only consent artifact.
// Shared by BOTH webhook-first interleavings (Codex #3342 r9 P1): the row
// already completed at the browser's initial read, AND the webhook winning
// between that read and the browser's pending→completing claim. The echo
// is pinned to the SAME SetupIntent the row completed with (proof this is
// the confirming tab), never applied to satisfied rows (no fee disclosure
// at all). ok:false (consent_echo_failed) means the caller must NOT ack —
// the client keeps its 3DS params on the NACK and a reload retries the
// idempotent /complete.
async function recordWebhookFirstConsentEcho({ row, setupIntentId, disclosureVersion }) {
  if (
    row?.status !== 'completed'
    || disclosureVersion !== STICKY_DISCLOSURE_VERSION
    || !setupIntentId
    || row.stripe_setup_intent_id !== setupIntentId
    || !row.fee_agreed_at
    || row.sticky_window_disclosed
  ) return { ok: true };
  try {
    const upgraded = await db('appointment_card_requests')
      .where({ id: row.id, status: 'completed', stripe_setup_intent_id: setupIntentId })
      .update({ sticky_window_disclosed: true, updated_at: new Date() });
    if (upgraded !== 1) {
      logger.warn(`[appt-card-request] webhook-first consent echo matched ${upgraded} rows for request ${row.id} — not acking`);
      return { ok: false, code: 'consent_echo_failed' };
    }
  } catch (err) {
    logger.warn(`[appt-card-request] webhook-first consent echo record failed for request ${row.id}: ${err.message}`);
    return { ok: false, code: 'consent_echo_failed' };
  }
  return { ok: true };
}

// POST /secure/:token completion. Verify live, then the shared completion
// tail below.
async function completeSecureCardCapture({ token, setupIntentId, ip = null, userAgent = null, disclosureVersion = null }) {
  const request = await db('appointment_card_requests').where({ token }).first();
  if (!request) return { ok: false, code: 'not_found' };
  if (request.status === 'completed' || request.status === 'satisfied') {
    // Webhook-first race (Codex #3342 r7 P1): when setup_intent.succeeded
    // beats the browser's POST, the webhook tail stamped fee_agreed_at with
    // sticky=false (no echo available). The browser's echo is the
    // AUTHORITATIVE consent artifact — record it idempotently, pinned to
    // the SAME SetupIntent this row completed with (proof it is the
    // confirming tab), never on satisfied rows (no fee disclosure at all).
    const echo = await recordWebhookFirstConsentEcho({ row: request, setupIntentId, disclosureVersion });
    if (!echo.ok) return echo;
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
    disclosureVersion,
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
// The completing tab's attested disclosure version — the ONLY writer of the
// sticky-window policy marker on this rail (Codex #3342 r5 P1): render-time
// seeding was removable poison during a rolling deploy (a new worker's seed
// survives an old worker's later old-copy render), so the enforceable bit is
// written atomically WITH fee_agreed_at from the echo of the tab that
// actually consented. The webhook completion backstop carries no echo and
// stamps non-sticky — the browser died, so nothing stronger is provable.
// Keep the literal in lockstep with CARD_HOLD_STICKY_DISCLOSURE_VERSION in
// estimate-card-holds.js.
const STICKY_DISCLOSURE_VERSION = 'sticky_v1';

async function finishVerifiedSecureCapture({ request, stripePaymentMethodId, setupIntentId, ip = null, userAgent = null, disclosureVersion = null }) {
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
    const fresh = await db('appointment_card_requests').where({ id: request.id })
      .first('id', 'status', 'updated_at', 'stripe_setup_intent_id', 'fee_agreed_at', 'sticky_window_disclosed');
    if (fresh?.status === 'completed' || fresh?.status === 'satisfied') {
      // The webhook won BETWEEN this call's initial read (still pending)
      // and the claim above (Codex #3342 r9 P1) — its completion tail
      // carried no echo and stamped non-sticky, and the initial-read
      // recovery in completeSecureCardCapture never saw a completed row.
      // Record the browser's echo here too, or this interleaving silently
      // keeps the reschedule-then-cancel dodge. The webhook caller passes
      // no disclosureVersion, so this is a no-op on that path.
      const echo = await recordWebhookFirstConsentEcho({ row: fresh, setupIntentId, disclosureVersion });
      if (!echo.ok) return echo;
      return { ok: true, alreadyCompleted: true };
    }
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

    // Frozen fee terms (fee rail, owner-approved 2026-08-01): the fee/window
    // the customer agreed to were stamped onto the row when the /secure page
    // RENDERED them (Codex #3153 r1 P1 — the disclosure the customer saw is
    // the only chargeable term; re-reading live config here would let a
    // config change between render and consent move an agreed fee). This
    // stamp only records WHEN agreement happened. An unstamped row (fee
    // configured off at render, or the render pre-dates the stamp) carries
    // no terms and the rail skips it. Only COMPLETED rows agree to a fee: a
    // `satisfied` row was auto-secured from a saved card and never saw the
    // disclosure, so it must never carry (or be charged) one.
    const frozenFeeTerms = {};
    try {
      const disclosed = await db('appointment_card_requests')
        .where({ id: request.id })
        .first('no_show_fee_amount');
      if (Number(disclosed?.no_show_fee_amount) > 0) {
        frozenFeeTerms.fee_agreed_at = new Date();
        // Sticky marker rides ONLY with consent, from the completing tab's
        // own echo — a missing/legacy echo (old bundle, webhook backstop)
        // stamps non-sticky. See STICKY_DISCLOSURE_VERSION above.
        frozenFeeTerms.sticky_window_disclosed = disclosureVersion === STICKY_DISCLOSURE_VERSION;
      }
    } catch (err) {
      logger.warn(`[appt-card-request] disclosed-terms read failed for request ${request.id} — completing without fee consent stamp: ${err.message}`);
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
  // Read ONCE, up front: the payload note and the render stamp below both
  // consume this same snapshot (Codex #3153 r4 P1).
  const feeDisclosure = visitPriced ? readCancelFeeDisclosure() : null;
  const base = {
    firstName: customer?.first_name || null,
    serviceType: visit?.service_type || null,
    dateDisplay: visit ? dateLineFor(visit.scheduled_date).replace(/^ on /, '') : null,
    windowDisplay: visit?.window_display || null,
    cancelFeeNote: visitPriced ? (feeDisclosure ? feeDisclosure.note : null) : null,
  };
  // Echo token for the completing tab: attached ONLY to the pending 'ready'
  // return below — the one state that renders the card-consent form — never
  // to base (Codex #3342 r8 P1). A secured/closed payload that carried it
  // would be cached by the client's sessionStorage latch, and a replayed
  // 3DS return could then upgrade a non-sticky webhook/legacy completion to
  // sticky_window_disclosed=true from a disclosure shown only AFTER consent.
  const readyEcho = visitPriced && feeDisclosure
    ? { stickyDisclosureVersion: STICKY_DISCLOSURE_VERSION } : {};

  // 'completing' renders as secured too (Codex #2771 r10): the SetupIntent
  // already succeeded and the page POST or webhook holds the completion
  // claim — showing the card form again mid-save (e.g. on a 3DS redirect
  // return that lost the /complete race) would invite a second card entry.
  // If the in-flight attempt fails and reverts, the durable webhook retry
  // converges the row to completed.
  if (request.status === 'completed' || request.status === 'satisfied' || request.status === 'completing') {
    return { state: 'secured', ...base, cancelFeeNote: frozenFeeNoteForRow(request) };
  }

  // Plan-choice lane (GATE_SECURE_PLAN_CHOICE; both helpers return null
  // while the gate is off, keeping this payload byte-identical to today).
  // A prepay selection whose invoice settled means the year is covered —
  // heal the pending row to satisfied (mirrors the autopay heal below) and
  // render secured; a live unpaid prepay invoice renders the
  // prepay_selected state at the bottom (pay link + card fallback).
  const { prepaySelectionState, deriveSecurePlanContext } = require('./secure-appointment-plans');
  const planState = await prepaySelectionState(request);
  if (planState?.state === 'secured') {
    await db('appointment_card_requests')
      .where({ id: request.id, status: 'pending' })
      .update({
        status: 'satisfied',
        // Frozen completion cap rides every satisfied transition (pre-push
        // r2 P1) — but MONOTONIC-DOWN like the render stamp (Codex #3153
        // r6 P1): a heal must never overwrite the sticky 0 sentinel or
        // widen a lower disclosed cap. No price → leave the column alone.
        ...(visitPriced ? {
          accepted_amount: db.raw(
            'CASE WHEN accepted_amount = 0 THEN 0 ELSE LEAST(COALESCE(accepted_amount, ?::numeric), ?::numeric) END',
            [visitPrice, visitPrice],
          ),
        } : {}),
        completed_at: new Date(),
        updated_at: new Date(),
      });
    // Satisfied via coverage (no page disclosure) → no fee terms to repeat.
    return { state: 'secured', ...base, cancelFeeNote: null };
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
      // Already enrolled with a chargeable method — heal and show secured,
      // carrying the frozen completion cap (pre-push r2 P1), MONOTONIC-DOWN
      // (Codex #3153 r6 P1): never overwrite the sticky 0 sentinel or
      // widen a lower disclosed cap from an earlier render.
      await db('appointment_card_requests')
        .where({ id: request.id, status: 'pending' })
        .update({
          status: 'satisfied',
          ...(visitPriced ? {
            accepted_amount: db.raw(
              'CASE WHEN accepted_amount = 0 THEN 0 ELSE LEAST(COALESCE(accepted_amount, ?::numeric), ?::numeric) END',
              [visitPrice, visitPrice],
            ),
          } : {}),
          completed_at: new Date(),
          updated_at: new Date(),
        });
      // Satisfied via coverage (no page disclosure) → no fee terms to repeat.
    return { state: 'secured', ...base, cancelFeeNote: null };
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
        // estimated_price rides along so the satisfied row freezes its
        // completion cap (pre-push r2 P1) — id/customer_id alone stamped
        // accepted_amount NULL and stranded the visit on review.
        visit: { id: request.scheduled_service_id, customer_id: request.customer_id, estimated_price: visit.estimated_price },
        savedMethod,
        trigger: 'secure_page_coverage',
      });
      // Satisfied via saved-card coverage — no page disclosure, no fee
      // terms to repeat (Codex #3153 r9 P2: base.cancelFeeNote is the LIVE
      // disclosure and would claim a fee this row can never be charged).
      if (secured.action === 'auto_secured') return { state: 'secured', ...base, cancelFeeNote: null };
    }
  } catch (err) {
    logger.warn(`[appt-card-request] page coverage re-check failed — rendering the form: ${err.message}`);
  }

  const intent = await createSecureCardSetupIntent(request);
  if (!intent) return { state: 'unavailable', ...base };
  // planContext is attached ONLY when the plan-choice gate is on and the
  // booked series yields sound pricing (deriveSecurePlanContext returns null
  // otherwise) — its absence is the client's signal to render the original
  // card-only page. prepay_selected keeps the SetupIntent alive so the
  // "save a card and pay per visit instead" fallback works on that state.
  //
  // Transient failure ≠ no-price (PR #3175 origin follow-up): the stamp
  // below reads a null context as "the page deliberately displayed no
  // price" and pins the STICKY accepted_amount=0 consent sentinel —
  // permanent by design (monotonic-down CASE + one request row per visit,
  // ever), leaving the visit manual-collect forever. A thrown derivation
  // (db hiccup, dependency error) must not collapse into that consent
  // statement: policy nulls (gate off, unsound inputs) still flow through
  // and stamp exactly as before, while a derivation FAILURE renders
  // 'unavailable' (no form, no SetupIntent handed out, nothing stamped) —
  // a reload retries against healthy dependencies.
  let planContext = null;
  try {
    planContext = await deriveSecurePlanContext({ request, visitId: request.scheduled_service_id });
  } catch (err) {
    logger.warn(`[appt-card-request] plan-context derivation failed for request ${request.id} — rendering unavailable, nothing stamped: ${err.message}`);
    return { state: 'unavailable', ...base };
  }

  // Freeze what THIS render discloses (Codex #3153 r1 P1): the fee the page
  // shows is the fee the rail may later charge, and the price shown is the
  // completion-charge cap — both must be the values the customer SAW, never
  // whatever config/price holds at consent or completion time. Re-stamped on
  // every ready render so the LAST disclosure shown wins; fee configured off
  // at render explicitly clears any earlier stamp. Pending-only — never
  // touches a row mid- or post-completion. The stamp is LOAD-BEARING, not
  // best-effort (pre-push r2 P0): a failed or zero-row stamp means the page
  // would display terms the row does not carry — an EARLIER render's
  // higher fee/cap could then be charged against a lower disclosure. In
  // that case render 'unavailable' (no form, no SetupIntent handed out);
  // a reload retries, and a row that raced to completed re-renders secured.
  let disclosureStamped = false;
  let noPricePinTransition = false;
  try {
    const disclosure = { updated_at: new Date() };
    // Monotonic-DOWN with sticky "nothing disclosed" sentinels (Codex #3153
    // r3 P0): completion cannot know WHICH open tab's render the customer
    // consented from — the /complete POST carries only the (shared)
    // SetupIntent — so the row may only ever move TOWARD the customer. A
    // re-render can lower a fee/cap but never raise one (LEAST, atomic in
    // SQL against concurrent renders), and any render that disclosed NO fee
    // (window sentinel 0) or NO price (accepted sentinel 0) pins the row
    // unchargeable for good. Whatever tab they complete from, the enforced
    // terms are ≤ every disclosure ever shown on this link.
    //
    // accepted_amount rides ONLY when the page actually DISPLAYS the price
    // (Codex #3153 r2 P1): the one-time service total and the recurring
    // per-application price both render exclusively from planContext —
    // gate off / derivation null shows no number, so nothing is accepted
    // and the completion lane routes to office review. Auto-secured
    // `satisfied` rows are different: their cap rests on the saved-method
    // enrollment consent, not this page.
    // Fee/window come from the SAME feeDisclosure snapshot the payload's
    // note was built from (Codex #3153 r4 P1) — never a fresh config read,
    // which mid-request could diverge from what the response displays.
    if (feeDisclosure) {
      disclosure.no_show_fee_amount = db.raw(
        'CASE WHEN cancel_window_hours = 0 THEN NULL ELSE LEAST(COALESCE(no_show_fee_amount, ?::numeric), ?::numeric) END',
        [feeDisclosure.feeAmount, feeDisclosure.feeAmount],
      );
      disclosure.cancel_window_hours = db.raw(
        'CASE WHEN cancel_window_hours = 0 THEN 0 ELSE LEAST(COALESCE(cancel_window_hours, ?::int), ?::int) END',
        [feeDisclosure.windowHours, feeDisclosure.windowHours],
      );
      // Deliberately NO sticky marker write at render (Codex #3342 r5 P1):
      // render-time seeding poisons rows during a rolling deploy (a new
      // worker's seed survives an old worker's later old-copy render). The
      // marker is written ONLY at completion, from the consenting tab's
      // attested echo — see finishVerifiedSecureCapture.
    } else {
      disclosure.no_show_fee_amount = null;
      disclosure.cancel_window_hours = 0;
    }
    // The stamped cap is the EXACT number in the returned payload —
    // planContext.perVisit, the value the client renders — not this GET's
    // earlier visitPrice read (Codex #3153 r4 P1: a concurrent reprice
    // between the two reads would freeze a cap higher than displayed).
    const displayedPrice = planContext && Number(planContext.perVisit) > 0
      ? Number(planContext.perVisit) : null;
    if (displayedPrice != null) {
      disclosure.accepted_amount = db.raw(
        'CASE WHEN accepted_amount = 0 THEN 0 ELSE LEAST(COALESCE(accepted_amount, ?::numeric), ?::numeric) END',
        [displayedPrice, displayedPrice],
      );
    } else {
      disclosure.accepted_amount = 0;
      // Pin-time bell arming: fire only when this stamp TRANSITIONS the
      // row to the 0 sentinel — a re-render of an already-pinned row stays
      // silent. Prior value comes from this GET's own row read; two
      // concurrent FIRST renders can therefore double-fire, which fails
      // open toward alerting (a duplicate bell is noise; a missed pin is a
      // silently unchargeable visit). NULL prior is a transition — Number(
      // null) is 0, so the null check is explicit.
      noPricePinTransition = !(request.accepted_amount != null
        && Number(request.accepted_amount) === 0);
    }
    const stamped = await db('appointment_card_requests')
      .where({ id: request.id, status: 'pending' })
      .update(disclosure);
    disclosureStamped = stamped === 1;
  } catch (err) {
    logger.warn(`[appt-card-request] disclosure stamp failed for request ${request.id}: ${err.message}`);
  }
  if (!disclosureStamped) {
    logger.warn(`[appt-card-request] disclosure not persisted for request ${request.id} — rendering unavailable instead of the form`);
    return { state: 'unavailable', ...base };
  }
  if (noPricePinTransition) {
    // The pin just made this visit manual-collect only, permanently for
    // this link (the completion reads fail closed with their own bells,
    // but nothing else announces the pin itself — this was the lane's one
    // silent moment). Best-effort: a bell failure never blocks the render.
    try {
      await require('./notification-service').notifyAdmin(
        'billing',
        'Secure page rendered without a price — visit is manual-collect only',
        'The /secure card page displayed no price for this visit, so no completion amount was accepted (accepted_amount pinned to 0 — permanent for this link). Auto-charge will never run for this visit; collect manually at completion.',
        {
          link: request.customer_id ? `/admin/customers/${request.customer_id}` : '/admin/dispatch',
          metadata: {
            // customerId feeds the internal-test-account suppression in
            // notification-service.js — without it the demo account rings.
            customerId: request.customer_id,
            scheduledServiceId: request.scheduled_service_id,
            appointmentCardRequestId: request.id,
            reason: 'no_price_displayed',
          },
        },
      );
    } catch (e) {
      logger.warn(`[appt-card-request] no-price pin bell failed for request ${request.id}: ${e.message}`);
    }
  }

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
    ...readyEcho,
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
  if (request.status !== 'completed') {
    // inFlight distinguishes a capture mid-completion ('completing') from
    // rows that never gained consent (pending/declined) — the no-show
    // path parks the former for review instead of declaring "no charge"
    // (Codex #3153 r24 P2): the capture can finish with valid fee consent
    // right after, and the no-show route's idempotent retry would never
    // re-evaluate the agreed fee.
    return { request: null, reason: 'not_completed', inFlight: request.status === 'completing' };
  }
  if (!(Number(request.no_show_fee_amount) > 0)) return { request: null, reason: 'no_agreed_fee' };
  if (!(Number(request.cancel_window_hours) > 0)) return { request: null, reason: 'no_agreed_fee' };
  // Consent must be RECORDED, not implied (pre-push r2 P0): the completion
  // tail stamps fee_agreed_at only after re-reading the disclosed terms —
  // a row that completed without that stamp (terms read failed) has no
  // durable consent marker and must never be charged.
  const feeAgreedAt = request.fee_agreed_at ? new Date(request.fee_agreed_at) : null;
  if (!feeAgreedAt || Number.isNaN(feeAgreedAt.getTime())) return { request: null, reason: 'no_fee_consent' };
  if (!request.stripe_payment_method_id || !request.customer_id) return { request: null, reason: 'no_charge_target' };
  // charging/charge_review are IN-FLIGHT fee events, not benign absence
  // (Codex #3153 r1 P1): a caller treating them as "nothing here" would
  // release/refund while a charge may still land. `unresolved` makes the
  // cancellation handler report a non-released review outcome. Checked
  // BEFORE the payer exemption (r8 P1): a payer assigned while another
  // worker's claim is in flight must never convert that unresolved state
  // into a clean payer_billed release.
  if (request.fee_status === 'charging' || request.fee_status === 'charge_review') {
    return { request: null, reason: 'charge_review', unresolved: true };
  }
  if (request.fee_status) return { request: null, reason: `fee_${request.fee_status}` };
  // A third-party payer assigned AFTER the card was secured exempts the
  // homeowner from this lane (Codex #3153 r6 P1): the capture flow fails
  // closed on payer changes at render and completion, and the completion
  // rail refuses payer-linked invoices — the penalty charge must honor the
  // same exemption. Fail CLOSED on lookup errors (unresolved, never a
  // charge against a card the appointment may no longer bill). Re-checked
  // again AT the claim boundary in chargeAppointmentNoShowFee (r8 P1) —
  // this early resolve also keeps the cancel preview honest.
  try {
    const PayerService = require('./payer');
    const resolved = await PayerService.resolveForInvoice({
      customerId: String(request.customer_id),
      scheduledServiceId: String(scheduledServiceId),
      throwOnError: true,
    });
    if (resolved?.payerId) return { request: null, reason: 'payer_billed' };
  } catch (err) {
    logger.error(`[appt-card-request] payer re-check failed for visit ${scheduledServiceId} — fee rail fails closed: ${err.message}`);
    return { request: null, reason: 'payer_check_failed', unresolved: true };
  }
  // Lane exclusivity — fail CLOSED on a lookup error (Codex #3153 r1 P1): a
  // hold row in ANY status may already own this visit's one fee event, so a
  // transient failure must never read as absence and mint a second fee.
  let hold;
  try {
    hold = await db('estimate_card_holds')
      .where({ scheduled_service_id: scheduledServiceId })
      .first('id');
  } catch (err) {
    logger.error(`[appt-card-request] card-hold lookup failed for visit ${scheduledServiceId} — fee rail fails closed: ${err.message}`);
    return { request: null, reason: 'hold_lookup_failed', unresolved: true };
  }
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
  // STRICT upper bound (Codex #3153 r10 P2): the disclosure says the fee
  // applies to cancellations "less than N hours before" — a cancel at
  // exactly the boundary is free, matching the stated terms.
  return msUntilStart > -CARD_HOLD_POST_START_GRACE_MS && msUntilStart < windowMs;
}

async function chargeAppointmentNoShowFee({ scheduledServiceId, reason = 'no_show', serviceStart = null, now = new Date() }) {
  if (!isApptCardFeeRailEnabled()) return { charged: false, reason: 'feature_disabled' };
  const { request, reason: skipReason, unresolved, inFlight } = await feeEligibleRequestForVisit(scheduledServiceId);
  // Unresolved eligibility (failed payer/hold lookup) surfaces as the
  // canonical review reason (Codex #3153 r16 P2): the dispatch no-show
  // path maps ONLY charge_review to its cautious customer copy — a raw
  // lookup-failure reason would send "there's no charge" while the agreed
  // fee sits retryable.
  if (!request) {
    // Capture in flight at no-show time (Codex #3153 r24 P2): the /secure
    // completion can commit 'completed' with valid fee consent moments
    // after this read, and the no-show route's same-status retry never
    // re-evaluates — a "no charge" here would silently drop an agreed
    // fee. Park review DURABLY (whereNull-guarded, same stamp discipline
    // as the cancel path) so the office decides; a lost stamp still
    // reports review.
    if (!unresolved && skipReason === 'not_completed' && inFlight) {
      try {
        await db('appointment_card_requests')
          .where({ scheduled_service_id: scheduledServiceId })
          .whereNull('fee_status')
          .update({ fee_status: 'charge_review', updated_at: new Date() });
      } catch (err) {
        logger.error(`[appt-card-request] in-flight-capture review stamp failed for visit ${scheduledServiceId}: ${err.message}`);
      }
      return { charged: false, reason: 'charge_review' };
    }
    return { charged: false, reason: unresolved ? 'charge_review' : skipReason };
  }
  const feeAmount = Number(request.no_show_fee_amount);

  // Staleness guard — identical posture to the card-hold rail: the fee is
  // for a FRESH missed visit; cleanup of ancient rows must never bill.
  const { NO_SHOW_FEE_MAX_AGE_MS } = require('./estimate-card-holds');
  let start = serviceStart;
  if (!start) {
    try {
      const { scheduledServiceApptTime } = require('./appointment-reminders');
      // throwOnError (Codex #3153 r20 P1): a FAILED lookup must not fall
      // into the terminal released stamp below — that would permanently
      // waive the fee over a transient DB blip. charge_review keeps it
      // reviewable; terminal release is reserved for a SUCCESSFUL lookup
      // that genuinely finds no appointment time.
      start = await scheduledServiceApptTime(scheduledServiceId, { throwOnError: true });
    } catch (err) {
      logger.error(`[appt-card-request] appt-time resolution for no-show fee FAILED — parking review: ${err.message}`);
      return { charged: false, reason: 'charge_review' };
    }
  }
  const startDate = start instanceof Date ? start : (start ? new Date(start) : null);
  const startMs = startDate && !Number.isNaN(startDate.getTime()) ? startDate.getTime() : null;
  if (reason === 'no_show' && startMs != null && startMs > now.getTime()) {
    // Marked no-show BEFORE the visit's scheduled start (Codex #3153 r19
    // P1 — the dispatch day-guard rejects only future DATES, not
    // later-today times): the customer cannot have missed it yet. Never
    // charge — and never stamp terminal either, so a genuine no-show
    // re-marked AFTER the start can still collect its fee. (late_cancel is
    // exempt BY DEFINITION: an in-window cancel happens before the start.)
    logger.warn(`[appt-card-request] no-show fee refused (before scheduled start) for visit ${scheduledServiceId}`);
    try {
      await require('./notification-service').notifyAdmin(
        'billing',
        'No-show fee not charged — marked before start',
        'A visit was marked no-show before its scheduled start time — the saved-card fee was NOT charged. Re-mark the visit after its start if the customer no-shows.',
        {
          link: request.customer_id ? `/admin/customers/${request.customer_id}` : '/admin/dispatch',
          metadata: { scheduledServiceId, reason: 'no_show_before_start' },
        },
      );
    } catch (e) { logger.warn(`[appt-card-request] pre-start no-show alert failed: ${e.message}`); }
    return { charged: false, reason: 'no_show_before_start' };
  }
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
    // Terminal stamp REQUIRED (Codex #3153 r15 P1): the office was just
    // told to bill manually — a side-effect retry after time resolution
    // recovers must not machine-charge on top of that. A lost stamp means
    // a concurrent claim → canonical review, never a benign refusal.
    try {
      const stamped = await db('appointment_card_requests')
        .where({ id: request.id })
        .whereNull('fee_status')
        .update({ fee_status: 'released', updated_at: new Date() });
      if (stamped !== 1) {
        logger.warn(`[appt-card-request] stale-refusal stamp lost a race for visit ${scheduledServiceId} — reporting charge_review`);
        return { charged: false, reason: 'charge_review' };
      }
    } catch (err) {
      logger.error(`[appt-card-request] stale-refusal stamp failed for visit ${scheduledServiceId} — reporting charge_review: ${err.message}`);
      return { charged: false, reason: 'charge_review' };
    }
    return { charged: false, reason: staleReason };
  }

  // Atomic charge claim: NULL -> 'charging'. One fee event per visit, ever.
  const claimed = await db('appointment_card_requests')
    .where({ id: request.id })
    .whereNull('fee_status')
    .update({ fee_status: 'charging', updated_at: new Date() });
  if (claimed !== 1) {
    // Lost the claim race — a concurrent worker is charging (or already
    // resolved) this visit's one fee RIGHT NOW (Codex #3153 r2 P1): report
    // the canonical unresolved outcome so no caller sends a no-charge
    // notice or reports a clean cancellation while the fee may land.
    logger.warn(`[appt-card-request] fee claim lost for visit ${scheduledServiceId} — reporting charge_review`);
    return { charged: false, reason: 'charge_review' };
  }

  // Revocation check (Codex #3153 r8 P1): removing a card in the portal
  // detaches the Stripe PM AND deletes the local payment_methods row — the
  // promised revocation mechanism. The attach self-heal below would happily
  // RE-ATTACH a detached PM, resurrecting authorization the customer
  // explicitly withdrew — so require the local row to still exist before
  // any charge. Revoked → close the fee event terminally + tell the office
  // (bill manually if the fee is owed); lookup error → revert the claim
  // (nothing charged) and park review.
  try {
    const pmRow = await db('payment_methods')
      .where({ customer_id: request.customer_id, stripe_payment_method_id: request.stripe_payment_method_id })
      .first('id');
    if (!pmRow) {
      // Exactly-one-row terminal stamp (Codex #3153 r18 P1): a swallowed
      // failure would leave the row 'charging' forever while callers treat
      // payment_method_revoked as a clean terminal outcome.
      try {
        const stamped = await db('appointment_card_requests').where({ id: request.id, fee_status: 'charging' })
          .update({ fee_status: 'released', updated_at: new Date() });
        if (stamped !== 1) {
          logger.error(`[appt-card-request] revoked-card release stamp lost for visit ${scheduledServiceId} — reporting charge_review`);
          return { charged: false, reason: 'charge_review' };
        }
      } catch (stampErr) {
        logger.error(`[appt-card-request] revoked-card release stamp failed for visit ${scheduledServiceId} — reporting charge_review: ${stampErr.message}`);
        return { charged: false, reason: 'charge_review' };
      }
      logger.warn(`[appt-card-request] no-show fee not charged — saved card was removed (visit ${scheduledServiceId})`);
      try {
        await require('./notification-service').notifyAdmin(
          'billing',
          'No-show fee not charged — card removed',
          'The customer removed the saved card before the no-show/late-cancel fee could be charged. Bill manually if the fee applies.',
          {
            link: request.customer_id ? `/admin/customers/${request.customer_id}` : '/admin/dispatch',
            metadata: { scheduledServiceId, reason: 'payment_method_revoked' },
          },
        );
      } catch (e) { logger.warn(`[appt-card-request] revoked-card alert failed: ${e.message}`); }
      return { charged: false, reason: 'payment_method_revoked' };
    }
  } catch (err) {
    logger.error(`[appt-card-request] payment-method revocation check failed for visit ${scheduledServiceId} — reverting claim, parking review: ${err.message}`);
    await db('appointment_card_requests').where({ id: request.id, fee_status: 'charging' })
      .update({ fee_status: null, updated_at: new Date() }).catch(() => {});
    return { charged: false, reason: 'charge_review' };
  }

  // Charge FIRST (separately from the row write) so a post-charge DB failure
  // is never confused with a pre-charge failure. Deliberately NO attach
  // self-heal on this path (Codex #3153 r9 P1): a removal racing the
  // revocation check above would be resurrected by an attach — a detached
  // method must simply fail the charge (definite error → claim reverts →
  // office bills manually). The completion tail attached the PM at consent;
  // a method that is detached NOW is detached because someone detached it.
  const StripeService = require('./stripe');
  let paymentIntent;
  let submittedFeePi = null;
  try {
    // Payer ownership SERIALIZED through charge submission (Codex #3153 r15
    // P1, superseding the r8 snapshot check): payer assignment updates
    // scheduled_services — FOR UPDATE on that row holds a concurrent
    // assignment out until the PaymentIntent is submitted (the edit blocks,
    // or committed first and is seen by the re-resolve on the lock
    // connection). The transaction writes nothing itself — a payer hit or
    // lookup failure throws a typed skip and rolls back with the row lock
    // released and no charge made.
    paymentIntent = await db.transaction(async (trx) => {
      // Customer row FIRST, then the visit — the same customer→service
      // lock order as chargeInvoiceWithSavedCard (Codex #3153 r18 P0):
      // payer assignment can live on customers.payer_id too, and the admin
      // customer update locks that row — without it a customer-level payer
      // edit could commit between the check and the Stripe submission.
      const lockedCustomer = await trx('customers')
        .where({ id: request.customer_id })
        .forUpdate()
        .first('id');
      if (!lockedCustomer) {
        const e = new Error('customer missing at fee charge');
        e.apptFeeSkip = 'charge_review';
        throw e;
      }
      const lockedSvc = await trx('scheduled_services')
        .where({ id: scheduledServiceId })
        .forUpdate()
        .first('id', 'customer_id');
      if (!lockedSvc) {
        const e = new Error('scheduled service missing at fee charge');
        e.apptFeeSkip = 'charge_review';
        throw e;
      }
      // The consent must belong to the visit's CURRENT customer (Codex
      // #3153 r19 P0): a reassigned visit must never charge the prior
      // customer's saved card — park for office review, charge nothing.
      if (String(lockedSvc.customer_id) !== String(request.customer_id)) {
        const e = new Error('visit customer changed since consent');
        e.apptFeeSkip = 'charge_review';
        throw e;
      }
      let resolvedPayer;
      try {
        resolvedPayer = await require('./payer').resolveForInvoice({
          database: trx,
          customerId: String(request.customer_id),
          scheduledServiceId: String(scheduledServiceId),
          throwOnError: true,
        });
      } catch (payerErr) {
        const e = new Error(`payer re-check failed: ${payerErr.message}`);
        e.apptFeeSkip = 'charge_review';
        throw e;
      }
      if (resolvedPayer?.payerId) {
        const e = new Error('payer assigned');
        e.apptFeeSkip = 'payer_billed';
        throw e;
      }
      const pi = await StripeService.chargeSavedPaymentMethodOffSession({
        customerId: request.customer_id,
        paymentMethodId: request.stripe_payment_method_id,
        amountDollars: feeAmount,
        description: 'Waves appointment — no-show / late-cancellation fee',
        metadata: {
          purpose: 'appointment_card_no_show_fee',
          request_id: String(request.id),
          scheduled_service_id: String(scheduledServiceId),
          reason,
        },
        idempotencyKey: `appt_card_no_show_${request.id}`,
      });
      // Captured OUTSIDE the transaction result (Codex #3153 r19 P0): if
      // the lock transaction fails to COMMIT after Stripe succeeded, the
      // catch must see the submitted PI and park review — never classify a
      // post-submission failure as a definite pre-charge one.
      submittedFeePi = pi;
      return pi;
    });
  } catch (err) {
    if (!err.apptFeeSkip && submittedFeePi) {
      // Stripe charged; only the lock transaction's commit failed. The
      // claim must NOT revert (a retry past the idempotency window would
      // double-charge) — proceed to the durable success write below, whose
      // own failure path parks charge_review keeping the PI pointer.
      logger.error(`[appt-card-request] fee charged but lock txn commit failed for visit ${scheduledServiceId} — proceeding as charged: ${err.message}`);
      paymentIntent = submittedFeePi;
    } else {
    if (err.apptFeeSkip === 'payer_billed') {
      // The appointment became payer-billed — close the fee event
      // terminally. Exactly one row or canonical review (Codex #3153 r15
      // P1): a swallowed stamp would report a benign outcome while the row
      // stays 'charging' with no review signal.
      try {
        const stamped = await db('appointment_card_requests').where({ id: request.id, fee_status: 'charging' })
          .update({ fee_status: 'released', updated_at: new Date() });
        if (stamped !== 1) {
          logger.error(`[appt-card-request] post-claim payer release stamp lost for visit ${scheduledServiceId} — reporting charge_review`);
          return { charged: false, reason: 'charge_review' };
        }
      } catch (stampErr) {
        logger.error(`[appt-card-request] post-claim payer release stamp failed for visit ${scheduledServiceId} — reporting charge_review: ${stampErr.message}`);
        return { charged: false, reason: 'charge_review' };
      }
      logger.info(`[appt-card-request] fee released (payer assigned) for visit ${scheduledServiceId}`);
      return { charged: false, reason: 'payer_billed' };
    }
    if (err.apptFeeSkip === 'charge_review') {
      logger.error(`[appt-card-request] fee payer serialization failed for visit ${scheduledServiceId} — reverting claim, parking review: ${err.message}`);
      await db('appointment_card_requests').where({ id: request.id, fee_status: 'charging' })
        .update({ fee_status: null, updated_at: new Date() }).catch(() => {});
      return { charged: false, reason: 'charge_review' };
    }
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
  // Dark rail (Codex #3153 r11 P1): with the kill switch off, every cancel
  // path must stay byte-identical to pre-rail behavior — the fail-closed
  // payer/hold lookups must not run, because their error outcomes would
  // block an offboarding refund or park review for a fee that CANNOT
  // charge. The one internal write kept (r2, invisible while dark): a
  // best-effort terminal stamp on the row so a later gate flip can never
  // retro-charge a cancellation that happened while the rail was dark.
  if (!isApptCardFeeRailEnabled()) {
    try {
      const row = await db('appointment_card_requests')
        .where({ scheduled_service_id: scheduledServiceId })
        .first('id', 'fee_status');
      if (row && !row.fee_status) {
        // The flip-protection stamp is REQUIRED, not best-effort (Codex
        // #3153 r16 P1): during a rolling gate enable a gate-on worker can
        // already be charging, and an unstamped row could be fee'd by a
        // cancellation retry after the flip. Exactly one row or the
        // canonical non-released review outcome.
        const stamped = await db('appointment_card_requests')
          .where({ id: row.id })
          .whereNull('fee_status')
          .update({ fee_status: waiveFee ? 'waived' : 'released', updated_at: new Date() });
        if (stamped !== 1) {
          logger.warn(`[appt-card-request] dark-gate release stamp lost a race for visit ${scheduledServiceId} — reporting charge_review`);
          return { handled: false, released: false, reason: 'charge_review' };
        }
      } else if (row && (row.fee_status === 'charging' || row.fee_status === 'charge_review')) {
        // A gate-on worker's fee is in flight (rolling enable) — never a
        // clean release while it may land.
        return { handled: false, released: false, reason: 'charge_review' };
      }
    } catch (err) {
      logger.error(`[appt-card-request] dark-gate release stamp failed for visit ${scheduledServiceId} — reporting charge_review: ${err.message}`);
      return { handled: false, released: false, reason: 'charge_review' };
    }
    return { handled: false, released: true, reason: 'feature_disabled' };
  }
  const { request, reason: skipReason, unresolved } = await feeEligibleRequestForVisit(scheduledServiceId);
  if (!request) {
    // An in-flight/parked fee (charging, charge_review) or an unverifiable
    // hold lookup is NOT a clean release (Codex #3153 r1 P1): offboarding
    // gates its deposit refund on released=true and the processors park
    // canonical 'charge_review' for office review — a fee may still land.
    if (unresolved) return { handled: false, released: false, reason: 'charge_review' };
    if (skipReason === 'payer_billed' || skipReason === 'not_completed') {
      // Terminal stamp for a payer-exempt cancellation (Codex #3153 r13
      // P1), REQUIRED not best-effort (r14): a lost stamp means either a
      // concurrent worker claimed the fee after our eligibility read or
      // the write failed — in both cases reporting a clean release could
      // let a fee land after offboarding refunded. Exactly-one row or the
      // canonical non-released review outcome. not_completed rows
      // (pending/completing/satisfied — a row EXISTS) get the same stamp
      // (r20 P0): a capture mid-flight at cancel time can finish as
      // 'completed' afterwards, and a cancellation retry would then find
      // an eligible row and charge a fee for this already-free cancel.
      try {
        const stamped = await db('appointment_card_requests')
          .where({ scheduled_service_id: scheduledServiceId })
          .whereNull('fee_status')
          .update({ fee_status: waiveFee ? 'waived' : 'released', updated_at: new Date() });
        if (stamped !== 1) {
          logger.warn(`[appt-card-request] payer-exempt release stamp lost a race for visit ${scheduledServiceId} — reporting charge_review`);
          return { handled: false, released: false, reason: 'charge_review' };
        }
      } catch (err) {
        logger.error(`[appt-card-request] payer-exempt release stamp failed for visit ${scheduledServiceId} — reporting charge_review: ${err.message}`);
        return { handled: false, released: false, reason: 'charge_review' };
      }
    }
    return { handled: false, released: true, reason: skipReason };
  }
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
      // throwOnError (Codex #3153 r19 P1): a FAILED lookup must not fall
      // through to the terminal free-release stamp — that would silently
      // waive a potentially applicable fee. Release is reserved for a
      // successful null (the visit genuinely has no time).
      start = await scheduledServiceApptTime(scheduledServiceId, { throwOnError: true });
    } catch (err) {
      logger.error(`[appt-card-request] appt-time resolution for cancel FAILED — unresolved, parking review: ${err.message}`);
      return { handled: false, released: false, reason: 'charge_review' };
    }
  }
  // Sticky window (owner ruling 2026-08-10, shared with the card-hold rail):
  // outside the CURRENT slot's window, the cancel is still a late cancel if
  // a customer-initiated reschedule was itself made inside the window —
  // rebooker's in-place date overwrite must not reset the clock. This rail's
  // r19 posture applies to the lookup: a FAILED read must not fall through
  // to the terminal free-release stamp below, so it parks review instead.
  const inWindow = !!start && isApptCardFeeRailEnabled() && isWithinApptCancelWindow({ request, serviceStart: start, now });
  // Sticky evidence applies ONLY to a LIVE current slot: a start already
  // past the cancellation grace keeps its free release (the visit came and
  // went undelivered — day-later cleanup must never bill), mirroring the
  // card-hold rail's guard.
  const { CARD_HOLD_POST_START_GRACE_MS: STICKY_GRACE_MS } = require('./estimate-card-holds');
  const liveStartDate = start instanceof Date ? start : (start ? new Date(start) : null);
  const liveStartMs = liveStartDate && !Number.isNaN(liveStartDate.getTime()) ? liveStartDate.getTime() : null;
  const startLive = liveStartMs != null && (liveStartMs - now.getTime()) > -STICKY_GRACE_MS;
  let sticky = null;
  // sticky_window_disclosed (migration 20260810000040): only rows whose
  // consent surface stated the sticky rule may be charged on its strength.
  // Enforcement gate checked HERE (the helper is ungated so reminder copy
  // can see evidence while dark).
  if (!inWindow && startLive && request.sticky_window_disclosed && isApptCardFeeRailEnabled()) {
    try {
      const { findStickyLateReschedule, isStickyCancelWindowEnabled } = require('./estimate-card-holds');
      sticky = !isStickyCancelWindowEnabled() ? null : await findStickyLateReschedule({
        scheduledServiceId,
        isWithinWindow: (s, at) => isWithinApptCancelWindow({ request, serviceStart: s, now: at }),
        notBefore: request.fee_agreed_at,
        currentStart: liveStartDate,
      });
    } catch (err) {
      logger.error(`[appt-card-request] sticky-window lookup for cancel FAILED — unresolved, parking review: ${err.message}`);
      return { handled: false, released: false, reason: 'charge_review' };
    }
  }
  if (inWindow || sticky) {
    const chargeResult = await chargeAppointmentNoShowFee({ scheduledServiceId, reason: 'late_cancel', serviceStart: start, now });
    // Normalized for cancellation callers (Codex #3153 r17 P1): unresolved
    // charge outcomes (parked review, or a definite decline whose reverted
    // claim a retry may still convert) carry released:false so the
    // route-level alert and offboarding gates see them; every terminal
    // outcome (charged, payer_billed, revoked, stale refusals — all of
    // which stamped the fee event closed) releases cleanly.
    const unresolvedCharge = chargeResult?.charged !== true
      && ['charge_review', 'charge_failed'].includes(chargeResult?.reason);
    return { ...chargeResult, handled: true, released: !unresolvedCharge };
  }
  const startDate = start instanceof Date ? start : (start ? new Date(start) : null);
  const startPassed = startDate && !Number.isNaN(startDate.getTime()) && startDate.getTime() <= now.getTime();
  // Persist the free cancel as a TERMINAL fee state before reporting it
  // (Codex #3153 r2 P1): processCancellationRequest deliberately re-runs
  // side effects on retry, so an unpersisted timely cancel could re-enter
  // the window (or the gate could flip on) and charge a fee for a
  // cancellation that was free when it happened. Atomic on NULL — losing
  // this write to a concurrent charge claim is the same unresolved race
  // as losing the claim itself.
  const releasedStamp = await db('appointment_card_requests')
    .where({ id: request.id })
    .whereNull('fee_status')
    .update({ fee_status: 'released', updated_at: new Date() });
  if (releasedStamp !== 1) {
    logger.warn(`[appt-card-request] free-cancel release lost a race for visit ${scheduledServiceId} — reporting charge_review`);
    return { handled: false, released: false, reason: 'charge_review' };
  }
  return { handled: true, released: true, reason: startPassed ? 'cancel_past_start' : 'cancel_outside_window' };
}

// Re-run settlement for a fee PI whose pre-settlement marker just became
// settleable — a bounced refund (Stripe kept the fee) or a WON dispute
// (funds reinstated). The acknowledged succeeded event will never retry,
// so this is the recovery trigger (Codex #3153 r18 P1). Best-effort;
// settlement itself is idempotent under the PI advisory lock.
async function resettleAppointmentFeeFromPi(piId) {
  // THROWS on failure (Codex #3153 r19 P1): the webhook callers must not
  // mark their event processed while retained/reinstated money still lacks
  // its paid invoice — a throw makes Stripe redeliver and retry this.
  const StripeService = require('./stripe');
  const pi = await StripeService.retrievePaymentIntent(piId);
  if (pi?.metadata?.purpose !== 'appointment_card_no_show_fee') return { settled: false, reason: 'not_fee_pi' };
  return settleAppointmentNoShowFee(pi);
}

// Route-side surfacing for unresolved cancellation-fee outcomes (Codex
// #3153 r16 P1): the admin cancel routes proceed with the cancellation
// regardless (the visit is already being cancelled), but a NON-released
// outcome means a fee may still land after an attempted waiver — the
// operator must hear about it, never read a silent success. Never throws.
async function alertUnresolvedCancellationFee({ scheduledServiceId, outcome }) {
  if (!outcome || outcome.released !== false) return;
  try {
    const row = await db('appointment_card_requests')
      .where({ scheduled_service_id: scheduledServiceId })
      .first('customer_id');
    await require('./notification-service').notifyAdmin(
      'billing',
      'Cancellation fee needs review',
      `A cancelled visit's saved-card fee state is unresolved (${outcome.reason}) — review the customer's billing before assuming no fee was (or will be) charged.`,
      {
        link: row?.customer_id ? `/admin/customers/${row.customer_id}` : '/admin/dispatch',
        metadata: { scheduledServiceId, reason: outcome.reason },
      },
    );
  } catch (err) {
    logger.warn(`[appt-card-request] unresolved-fee alert failed for visit ${scheduledServiceId}: ${err.message}`);
  }
}

// Read-only preview for the admin cancel UIs — merged into the existing
// GET /admin/dispatch/:serviceId/card-hold response so the client confirm
// prompts cover both lanes unchanged.
async function appointmentCardCancelPreview(scheduledServiceId, now = new Date()) {
  // Dark rail: no lookups, no fee-may-apply previews (Codex #3153 r11 P1)
  // — the disabled rail cannot charge, so the lane presents as absent.
  if (!isApptCardFeeRailEnabled()) return { secured: false, feeApplies: false };
  const { request, unresolved } = await feeEligibleRequestForVisit(scheduledServiceId);
  if (!request) {
    if (unresolved) {
      // Lane state unverifiable (Codex #3153 r9 P1): reporting "no fee"
      // while a recovered lookup could charge one on the very next request
      // makes the operator's confirm prompt lie — surface a fee-may-apply
      // preview so the cancel path shows the waiver choice. Fee amount is
      // best-effort from the row (the prompt copy degrades gracefully).
      let feeAmount = null;
      try {
        const row = await db('appointment_card_requests')
          .where({ scheduled_service_id: scheduledServiceId })
          .first('no_show_fee_amount');
        feeAmount = Number(row?.no_show_fee_amount) > 0 ? Number(row.no_show_fee_amount) : null;
      } catch (err) { /* best-effort */ }
      return { secured: true, feeApplies: true, feeAmount, unresolved: true };
    }
    return { secured: false, feeApplies: false };
  }
  let start = null;
  try {
    const { scheduledServiceApptTime } = require('./appointment-reminders');
    // throwOnError distinguishes a FAILED lookup from a genuinely timeless
    // visit (Codex #3153 r16 P1 — the helper's default fail-soft null made
    // this catch unreachable and the preview lied fee-free).
    start = await scheduledServiceApptTime(scheduledServiceId, { throwOnError: true });
  } catch (err) {
    // A THROWN time resolution is unresolved, not fee-free (Codex #3153
    // r13 P1): the cancellation path re-resolves independently, and a
    // recovered lookup could charge an in-window cancel the preview called
    // free. (A cleanly-null time stays fee-free — the charge path refuses
    // unresolvable starts the same way.)
    logger.warn(`[appt-card-request] appt-time resolution for cancel preview failed — reporting fee-may-apply: ${err.message}`);
    return { secured: true, feeApplies: true, feeAmount: Number(request.no_show_fee_amount), unresolved: true };
  }
  let feeApplies = isApptCardFeeRailEnabled() && !!start && isWithinApptCancelWindow({ request, serviceStart: start, now });
  const { CARD_HOLD_POST_START_GRACE_MS: PREVIEW_GRACE_MS } = require('./estimate-card-holds');
  const previewStartMs = start ? new Date(start).getTime() : NaN;
  const previewStartLive = Number.isFinite(previewStartMs) && (previewStartMs - now.getTime()) > -PREVIEW_GRACE_MS;
  if (!feeApplies && isApptCardFeeRailEnabled() && previewStartLive && request.sticky_window_disclosed) {
    // Sticky window — the preview must agree with the cancellation handler
    // (same enforcement gate, same evidence). A THROWN lookup is
    // unresolved, not fee-free (same posture as the time-resolution catch
    // above): the cancel path parks review on the same failure, so the
    // prompt must surface the waiver choice.
    try {
      const { findStickyLateReschedule, isStickyCancelWindowEnabled } = require('./estimate-card-holds');
      feeApplies = !isStickyCancelWindowEnabled() ? false : !!(await findStickyLateReschedule({
        scheduledServiceId,
        isWithinWindow: (s, at) => isWithinApptCancelWindow({ request, serviceStart: s, now: at }),
        notBefore: request.fee_agreed_at,
        currentStart: previewStartLive ? new Date(previewStartMs) : null,
      }));
      if (feeApplies) {
        // Card removal is revocation on the charge path — the preview must
        // agree (Codex #3342 r5 P2): a removed card means the charge leg
        // closes released, so no fee prompt.
        const pmRow = await db('payment_methods')
          .where({ customer_id: request.customer_id, stripe_payment_method_id: request.stripe_payment_method_id })
          .first('id');
        if (!pmRow) feeApplies = false;
      }
    } catch (err) {
      logger.warn(`[appt-card-request] sticky-window lookup for cancel preview failed — reporting fee-may-apply: ${err.message}`);
      return { secured: true, feeApplies: true, feeAmount: Number(request.no_show_fee_amount), unresolved: true };
    }
  }
  return { secured: true, feeApplies, feeAmount: Number(request.no_show_fee_amount) };
}

// Office heads-up for recap completions the lane could not auto-charge —
// the recap flow has no pay-link state to fall back on, so silence here
// strands an unbilled visit (mirror of alertRecapCardHoldNeedsReview).
async function alertRecapApptCardNeedsReview({ scheduledServiceId, customerId, reason }) {
  try {
    await require('./notification-service').notifyAdmin(
      'billing',
      'Recap completion needs billing review (saved card)',
      `A recap-completed visit whose card was saved through the appointment link was not auto-charged (${reason}). Review the visit's billing and collect manually if appropriate.`,
      {
        link: customerId ? `/admin/customers/${customerId}` : '/admin/dispatch',
        metadata: { scheduledServiceId, reason, lane: 'appointment_card' },
      },
    );
  } catch (err) {
    logger.warn(`[appt-card-request] recap review alert failed: ${err.message}`);
  }
}

// Recap-path completion charge (Codex #3153 r1 P1): POST /:serviceId/pest-recap
// completes WITHOUT invoicing, so the /complete flow's appointment-card
// completion lane never runs there — without this fallback a lane-secured
// one-time visit closes out uncharged despite the "charged after your
// service is completed" promise. Mirrors chargeCardHoldForRecapCompletion's
// postures (prior-non-performed → review, prepaid → review, fail-closed
// lookups, shared invoice mint lock) and the dispatch lane's guardrails
// (billing-lane exclusions, autopay eligibility, hard cap at the FROZEN
// accepted_amount). Dark behind GATE_APPT_CARD_COMPLETION_CHARGE; every
// failure mode alerts the office instead of charging. Never throws.
async function chargeAppointmentCardForRecapCompletion({ scheduledServiceId, serviceRecordId, priorNonPerformed = false }) {
  // Captured as soon as a lane row is known so the outer catch can still
  // point the office at the right customer (Codex #3153 r2 P1).
  let alertCustomerId = null;
  try {
    if (!require('../config/feature-gates').isEnabled('apptCardCompletionCharge')) {
      return { charged: false, reason: 'feature_disabled' };
    }
    if (!serviceRecordId) return { charged: false, reason: 'no_service_record' };
    const laneRow = await db('appointment_card_requests')
      .where({ scheduled_service_id: scheduledServiceId })
      .whereIn('status', ['completed', 'satisfied'])
      .first('id', 'customer_id', 'accepted_amount');
    if (!laneRow) return { charged: false, reason: 'no_lane_row' };
    alertCustomerId = laneRow.customer_id || null;
    // Lane exclusivity — fail CLOSED on a lookup error: the hold rail owns
    // any visit with a hold row, and its own recap fallback already ran.
    let holdRow;
    try {
      holdRow = await db('estimate_card_holds')
        .where({ scheduled_service_id: scheduledServiceId })
        .first('id');
    } catch (err) {
      logger.error(`[appt-card-request] recap hold lookup failed for visit ${scheduledServiceId} — no auto-charge: ${err.message}`);
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: laneRow.customer_id, reason: 'hold_lookup_failed' });
      return { charged: false, reason: 'hold_lookup_failed' };
    }
    if (holdRow) return { charged: false, reason: 'card_hold_lane' };
    // A re-completed NOT-performed visit (incomplete / inspection-only /
    // declined) must not auto-charge a full completion amount — office call.
    if (priorNonPerformed) {
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: laneRow.customer_id, reason: 'prior_non_performed' });
      return { charged: false, reason: 'prior_non_performed' };
    }
    let svc;
    try {
      svc = await db('scheduled_services').where({ id: scheduledServiceId })
        .first('id', 'customer_id', 'service_type', 'is_recurring', 'prepaid_amount');
    } catch (err) {
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: laneRow.customer_id, reason: 'visit_lookup_failed' });
      return { charged: false, reason: 'visit_lookup_failed' };
    }
    if (!svc || svc.is_recurring === true) return { charged: false, reason: 'not_one_time' };
    // The consent row must belong to the visit's CURRENT customer (Codex
    // #3153 r19 P0): a reassigned visit must never ride a prior customer's
    // accepted_amount into automatic collection.
    if (String(laneRow.customer_id) !== String(svc.customer_id)) {
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: svc.customer_id, reason: 'customer_mismatch' });
      return { charged: false, reason: 'customer_mismatch' };
    }
    // A field prepayment settles the visit outside this lane — charging on
    // top of one would double-bill (same posture as the hold recap rail).
    if (Number(svc.prepaid_amount) > 0) {
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: svc.customer_id, reason: 'prepaid_visit' });
      return { charged: false, reason: 'prepaid_visit_manual' };
    }
    const customer = await db('customers').where({ id: svc.customer_id })
      .first('id', 'billing_mode', 'monthly_rate', 'waveguard_tier', 'autopay_enabled', 'autopay_paused_until', 'autopay_payment_method_id', 'ach_status');
    if (!customer) return { charged: false, reason: 'no_customer' };
    // Explicit billing lanes have their own rails — same exclusions as the
    // dispatch completion lane.
    const { resolveBillingLane } = require('./billing-lane');
    const lane = resolveBillingLane(customer);
    if (customer.billing_mode === 'per_application' || lane.mode === 'monthly_membership' || lane.mode === 'annual_prepay') {
      return { charged: false, reason: 'other_billing_lane' };
    }
    const { customerOnAutopay, getChargeableAutopayMethod, isChargeableAutopayMethod } = require('./autopay-eligibility');
    const onAutopay = await customerOnAutopay(customer);
    const autopayPm = onAutopay ? await getChargeableAutopayMethod({ id: svc.customer_id }, db) : null;
    if (!onAutopay || !isChargeableAutopayMethod(autopayPm)) {
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: svc.customer_id, reason: 'no_chargeable_method' });
      return { charged: false, reason: 'no_chargeable_method' };
    }
    // Hard cap at the FROZEN accepted amount (Codex #3153 r1 P1) — never
    // the live visit price, which appointment editors rewrite.
    const acceptedAmount = laneRow.accepted_amount != null && Number(laneRow.accepted_amount) > 0
      ? Number(laneRow.accepted_amount) : null;
    if (acceptedAmount == null) {
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: svc.customer_id, reason: 'no_accepted_amount' });
      return { charged: false, reason: 'no_accepted_amount' };
    }
    let invoiceId;
    try {
      const { resolveOrMintRecapCompletionInvoice } = require('./estimate-card-holds');
      invoiceId = await resolveOrMintRecapCompletionInvoice({
        scheduledServiceId,
        serviceRecordId,
        serviceType: svc.service_type || null,
      });
    } catch (err) {
      logger.error(`[appt-card-request] recap completion invoice resolve/create failed for visit ${scheduledServiceId}: ${err.message}`);
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: svc.customer_id, reason: 'invoice_create_failed' });
      return { charged: false, reason: 'invoice_create_failed', error: err.message };
    }
    if (!invoiceId) {
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: svc.customer_id, reason: 'no_invoice' });
      return { charged: false, reason: 'no_invoice' };
    }
    const invoice = await db('invoices').where({ id: invoiceId })
      .first('id', 'status', 'payer_id', 'subtotal', 'total', 'discount_amount');
    if (!invoice) return { charged: false, reason: 'invoice_missing' };
    if (invoice.payer_id) {
      // A payer assigned after the card was secured owns this bill — but
      // submitRecap has NO later delivery path (unlike /complete), so a
      // silent return strands the payer invoice in draft forever (Codex
      // #3153 r6 P1): route it to office review for delivery.
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: svc.customer_id, reason: 'payer_billed' });
      return { charged: false, reason: 'payer_billed' };
    }
    // A VOIDED invoice on a completed recap visit is an UNBILLED service
    // with no pay-link fallback (Codex #3153 r10 P1) — unlike paid/
    // prepaid/processing (money handled elsewhere), it needs the office.
    if (String(invoice.status || '').toLowerCase() === 'void') {
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: svc.customer_id, reason: 'invoice_void' });
      return { charged: false, reason: 'invoice_void' };
    }
    if (['paid', 'prepaid', 'processing'].includes(String(invoice.status || '').toLowerCase())) {
      return { charged: false, reason: `invoice_${String(invoice.status).toLowerCase()}` };
    }
    const subtotal = invoice.subtotal != null ? Number(invoice.subtotal) : Number(invoice.total || 0);
    const netSubtotal = Math.round((subtotal - Math.max(0, Number(invoice.discount_amount) || 0)) * 100) / 100;
    if (netSubtotal > acceptedAmount + 0.005) {
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: svc.customer_id, reason: 'above_accepted_amount' });
      return { charged: false, reason: 'above_accepted_amount' };
    }
    // Auto Pay re-resolved at the CHARGE boundary (Codex #3153 r12 P1):
    // the mint/lock awaits above leave a gap an opt-out or pause can
    // commit inside — and a pause touches only the CUSTOMER row, which a
    // method re-read alone cannot see. Lookup failure charges nothing.
    let freshPm = null;
    try {
      const freshCustomer = await db('customers').where({ id: svc.customer_id })
        .first('id', 'autopay_enabled', 'autopay_paused_until', 'autopay_payment_method_id', 'ach_status');
      freshPm = freshCustomer && await customerOnAutopay(freshCustomer)
        ? await getChargeableAutopayMethod({ id: svc.customer_id }, db)
        : null;
    } catch (recheckErr) {
      logger.warn(`[appt-card-request] charge-boundary Auto Pay re-check failed for visit ${scheduledServiceId} — not charging: ${recheckErr.message}`);
      freshPm = null;
    }
    if (!isChargeableAutopayMethod(freshPm)) {
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: svc.customer_id, reason: 'no_chargeable_method' });
      return { charged: false, reason: 'no_chargeable_method' };
    }
    // Live payer re-resolve at the charge boundary (Codex #3153 r13 P1): a
    // payer assigned after the invoice was pre-minted lives only on
    // scheduled_services — the reused invoice's payer_id stays null. Payer
    // present → the payer flows own the bill (office alert, no delivery
    // path here); lookup failure → fail closed, alert.
    try {
      const boundaryPayer = await require('./payer').resolveForInvoice({
        customerId: String(svc.customer_id),
        scheduledServiceId: String(scheduledServiceId),
        throwOnError: true,
      });
      if (boundaryPayer?.payerId) {
        await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: svc.customer_id, reason: 'payer_billed' });
        return { charged: false, reason: 'payer_billed' };
      }
    } catch (payerRecheckErr) {
      logger.warn(`[appt-card-request] charge-boundary payer re-check failed for visit ${scheduledServiceId} — not charging: ${payerRecheckErr.message}`);
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: svc.customer_id, reason: 'payer_check_failed' });
      return { charged: false, reason: 'payer_check_failed' };
    }
    const StripeService = require('./stripe');
    try {
      // maxAuthorizedSubtotal: the frozen cap is re-enforced against the
      // LOCKED invoice inside the charge service (Codex #3153 r7 P0) — the
      // preflight above compared an unlocked snapshot a concurrent edit
      // could outrun. requireAutopayForCustomerId serializes the charge
      // against a concurrently-committing pause/opt-out (r13).
      await StripeService.chargeInvoiceWithSavedCard(invoice.id, freshPm.id, {
        maxAuthorizedSubtotal: acceptedAmount,
        requireAutopayForCustomerId: svc.customer_id,
        requireSelfPayScheduledServiceId: scheduledServiceId,
        requireOneTimeLane: true,
      });
    } catch (err) {
      logger.error(`[appt-card-request] recap completion charge failed for visit ${scheduledServiceId}: ${err.message}`);
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: svc.customer_id, reason: 'charge_failed' });
      // Awaited so a rejected audit write is caught here, never an
      // unhandled rejection (pre-push r2 P1 — floating-promise rule).
      try {
        await require('./autopay-log').logAutopay(svc.customer_id, 'charge_failed', {
          details: { source: 'appointment_card_recap_completion', invoice_id: invoice.id, scheduled_service_id: scheduledServiceId, error: err.message },
        });
      } catch (e) { logger.warn(`[appt-card-request] autopay audit write failed: ${e.message}`); }
      return { charged: false, reason: 'charge_failed', error: err.message };
    }
    try {
      await require('./autopay-log').logAutopay(svc.customer_id, 'charge_success', {
        details: { source: 'appointment_card_recap_completion', invoice_id: invoice.id, scheduled_service_id: scheduledServiceId },
      });
    } catch (e) { logger.warn(`[appt-card-request] autopay audit write failed: ${e.message}`); }
    logger.info(`[appt-card-request] recap completion charged invoice ${invoice.id} for visit ${scheduledServiceId}`);
    // Full-balance sweep (owner ruling 2026-08-08) — same post-success hook
    // as the dispatch completion rail, so which closeout path ran never
    // decides whether old balances get collected (pre-push P1). 'paid' ONLY
    // (pre-push r2 P0): an ACH debit still 'processing' is money in flight,
    // not proof the tender is good — never fan out further debits behind it.
    // Detached; durability model documented in completion-balance-sweep.js.
    // Dark behind GATE_COMPLETION_BALANCE_SWEEP (re-checked inside).
    let sweepEligible = false;
    try {
      const fresh = await db('invoices').where({ id: invoice.id }).first('status');
      sweepEligible = String(fresh?.status || '').toLowerCase() === 'paid';
    } catch (freshErr) {
      logger.warn(`[appt-card-request] post-charge status read failed for invoice ${invoice.id} — skipping balance sweep: ${freshErr.message}`);
    }
    if (sweepEligible) {
      const sweepArgs = {
        customerId: svc.customer_id,
        excludeInvoiceId: invoice.id,
        paymentMethodId: freshPm.id,
        triggerScheduledServiceId: scheduledServiceId,
      };
      // Resolved BEFORE the tick is scheduled — a deferred require would run
      // outside the request (and after teardown in tests).
      const { runCompletionBalanceSweep } = require('./completion-balance-sweep');
      setImmediate(() => {
        runCompletionBalanceSweep(sweepArgs)
          .catch((sweepErr) => logger.error(`[appt-card-request] balance sweep crashed for customer ${sweepArgs.customerId}: ${sweepErr.message}`));
      });
    }
    return { charged: true, invoiceId: invoice.id };
  } catch (err) {
    // An unexpected dependency failure past the lane check leaves a
    // completed visit unbilled with NO pay-link fallback — the office must
    // hear about it (Codex #3153 r2 P1). Before the lane check
    // (alertCustomerId null) a silent return is correct: the visit isn't
    // this lane's to bill.
    logger.error(`[appt-card-request] recap completion charge errored for visit ${scheduledServiceId}: ${err.message}`);
    if (alertCustomerId !== null) {
      await alertRecapApptCardNeedsReview({ scheduledServiceId, customerId: alertCustomerId, reason: 'error' });
    }
    return { charged: false, reason: 'error', error: err.message };
  }
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

  const StripeService = require('./stripe');
  const amount = Math.round(Number(paymentIntent.amount_received || paymentIntent.amount || 0)) / 100;
  const reason = paymentIntent.metadata?.reason || 'no_show';
  const requestId = paymentIntent.metadata?.request_id || null;
  const scheduledServiceId = paymentIntent.metadata?.scheduled_service_id || null;
  const feeLabel = reason === 'late_cancel' ? 'Late-cancellation fee' : 'No-show fee';

  const InvoiceService = require('./invoice');
  // Neutral "appointment" wording (Codex #3153 r4 P2): the fee rail also
  // covers recurring plan-choice visits — "one-time visit" on their
  // invoice/receipt would be inaccurate billing copy.
  const description = `Appointment — ${feeLabel.toLowerCase()}`;
  const result = await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`appointment_card_no_show_fee:${piId}`]);
    const existing = await trx('payments').where({ stripe_payment_intent_id: piId })
      .first('id', 'status', 'refund_status', 'refund_amount', 'metadata');
    let adoptMarkerRowId = null;
    let liveRefundIds = [];
    let markerMeta = null;
    let markerRefundedCents = 0;
    if (existing) {
      let meta = {};
      try {
        meta = typeof existing.metadata === 'string' ? JSON.parse(existing.metadata) : (existing.metadata || {});
      } catch { meta = {}; }
      const fullyRefunded = String(existing.status || '').toLowerCase() === 'refunded'
        || String(existing.refund_status || '').toLowerCase() === 'full';
      const isMarker = meta.pre_settlement_refund === true || meta.pre_settlement_dispute === true;
      if (!isMarker || fullyRefunded) return { replay: true };
      // An invoice-bound row is SETTLED regardless of any residual marker
      // flag (Codex #3153 r27 P1): a worker crash after the adoption
      // commit but before the webhook-processed stamp replays this event —
      // re-adopting would mint a second paid invoice + receipt and rebind
      // the row away from the first.
      if (meta.invoice_id) return { replay: true };
      // A still-contested dispute marker stays untouched — the dispute-won
      // handler flips it and re-triggers settlement (Codex #3153 r18 P1).
      if (String(existing.status || '').toLowerCase() === 'disputed') return { replay: true };
      // PARTIAL pre-settlement refund marker (Codex #3153 r17 P1): the fee
      // was partially refunded before settlement — the business keeps the
      // remainder, so the paid fee invoice must still be minted. Adopt the
      // marker row (update, never a second insert) and carry its refund
      // amount and canonical stamped_refund_ids forward.
      adoptMarkerRowId = existing.id;
      markerMeta = meta;
      markerRefundedCents = Math.max(0, Math.round(Number(existing.refund_amount || 0) * 100));
    }

    // Refund guard INSIDE the PI lock (Codex #3153 r16 P1): a dashboard
    // refund landing after an earlier unlocked check but before the paid
    // rows insert would be acknowledged by the refund webhook with no row
    // to mark — and this settlement would then book fully-paid revenue for
    // a refunded charge. The live retrieve runs under the lock, right
    // before the insert; FAIL CLOSED on a retrieve error (throw → rollback
    // → Stripe redelivers).
    let preRefundedCents = 0;
    {
      const live = await StripeService.retrievePaymentIntent(piId, { expand: ['latest_charge'] });
      const ch = live?.latest_charge;
      if (ch && typeof ch === 'object') {
        // Disputed BEFORE settlement (Codex #3153 r17 P1): Stripe permits
        // charge.dispute.created to arrive before the succeeded event, and
        // that handler finds nothing to mark — booking a paid fee invoice
        // for money already clawed back would overstate revenue. Refuse
        // UNLESS every dispute already closed in our favor (r18: disputed
        // stays true forever on the charge — a WON dispute means the money
        // is retained and the fee must settle). Status resolved through
        // the Disputes API (r19 — `dispute` is not an expandable charge
        // property); a list failure throws → rollback → Stripe retries.
        if (ch.disputed === true) {
          const disputes = await StripeService.listDisputesForCharge(ch.id);
          const activeDispute = disputes.find((d) => !['won', 'warning_closed'].includes(String(d?.status || ''))) || null;
          if (activeDispute || disputes.length === 0) {
            // Persist the SAME marker the created-event handler writes
            // (r19 P1) BEFORE refusing: a won closure delivered before the
            // created event must find something to resettle. Adopts an
            // existing refund marker instead of inserting a second row.
            const disputeMeta = {
              purpose: 'appointment_card_no_show_fee',
              pre_settlement_dispute: true,
              ...(activeDispute?.id ? { dispute_id: activeDispute.id } : {}),
            };
            if (adoptMarkerRowId) {
              await trx('payments').where({ id: adoptMarkerRowId }).update({
                status: 'disputed',
                metadata: JSON.stringify({ ...(markerMeta || {}), ...disputeMeta }),
              });
            } else {
              await trx('payments').insert({
                customer_id: customerId,
                processor: 'stripe',
                payment_date: etDateString(),
                amount,
                status: 'disputed',
                stripe_payment_intent_id: piId,
                stripe_charge_id: ch.id,
                metadata: JSON.stringify(disputeMeta),
              });
            }
            logger.warn(`[appt-card-request] no-show fee disputed before settlement — durable marker written, skipping (${piId})`);
            return { refundedPreSettlement: true };
          }
        }
        const chargedCents = Math.round(Number(ch.amount || 0));
        preRefundedCents = Math.max(0, Math.round(Number(ch.amount_refunded || 0)));
        // Only refunds whose money is counted in amount_refunded (Codex
        // #3153 r27 P1): a failed/canceled refund can sit in the same
        // collection — stamping its id would let its refund.failed event
        // subtract an amount that was never included, erasing a legitimate
        // successful refund from refund_amount.
        liveRefundIds = Array.isArray(ch.refunds?.data)
          ? ch.refunds.data
            .filter((r) => ['succeeded', 'pending'].includes(String(r?.status || '')))
            .map((r) => r?.id)
            .filter(Boolean)
          : [];
        if (ch.refunded === true || (chargedCents > 0 && preRefundedCents >= chargedCents)) {
          // Durable FULL-refund marker with canonical attribution (Codex
          // #3153 r21 P1): the delayed charge.refunded may BOUNCE via
          // refund.failed first — an unmarked return would leave retained
          // money with nothing for the bounce handler to unwind, and the
          // late charge.refunded would be skipped.
          const fullMeta = {
            purpose: 'appointment_card_no_show_fee',
            pre_settlement_refund: true,
            ...(liveRefundIds.length ? { stamped_refund_ids: liveRefundIds } : {}),
          };
          const fullFields = {
            refund_amount: preRefundedCents / 100,
            refund_status: 'full',
            status: 'refunded',
            stripe_refund_id: liveRefundIds[liveRefundIds.length - 1] || null,
          };
          if (adoptMarkerRowId) {
            await trx('payments').where({ id: adoptMarkerRowId }).update({
              ...fullFields,
              metadata: JSON.stringify({ ...(markerMeta || {}), ...fullMeta }),
            });
          } else {
            await trx('payments').insert({
              customer_id: customerId,
              processor: 'stripe',
              payment_date: etDateString(),
              amount,
              stripe_payment_intent_id: piId,
              stripe_charge_id: ch.id,
              ...fullFields,
              metadata: JSON.stringify(fullMeta),
            });
          }
          logger.warn(`[appt-card-request] no-show fee fully refunded before settlement — durable marker written, skipping (${piId})`);
          return { refundedPreSettlement: true };
        }
      }
    }
    preRefundedCents = Math.max(preRefundedCents, markerRefundedCents);

    // Face value, NO tax: the fee must equal the amount disclosed + charged.
    const inv = await InvoiceService.create({
      database: trx,
      customerId,
      title: description,
      lineItems: [{ description: `${feeLabel} — appointment`, quantity: 1, unit_price: amount, amount }],
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
    const settledPaymentFields = {
      customer_id: customerId,
      processor: 'stripe',
      stripe_payment_intent_id: piId,
      stripe_charge_id: paymentIntent.latest_charge || null,
      payment_date: etDateString(),
      amount,
      refund_amount: preRefundedCents > 0 ? preRefundedCents / 100 : 0,
      refund_status: preRefundedCents > 0 ? 'partial' : null,
      // Canonical attribution for refunds discovered by the live retrieve
      // (Codex #3153 r21 P1) — a later refund.failed bounce must find the
      // ids it unwinds by.
      ...(preRefundedCents > 0 && liveRefundIds.length
        ? { stripe_refund_id: liveRefundIds[liveRefundIds.length - 1] }
        : {}),
      status: 'paid',
      description,
      metadata: JSON.stringify({
        // Marker metadata (stamped_refund_ids) rides forward so a later
        // refund bounce can still unwind it (r17) — but the marker FLAGS
        // are cleared (r27 P1): a settled row must never look adoptable
        // again on a crash replay, and invoice_id (below) is the settled
        // fence the replay guard keys on.
        ...(markerMeta || {}),
        pre_settlement_refund: undefined,
        pre_settlement_dispute: undefined,
        ...(preRefundedCents > 0 && liveRefundIds.length ? { stamped_refund_ids: liveRefundIds } : {}),
        purpose: 'appointment_card_no_show_fee',
        invoice_id: inv.id,
        request_id: requestId,
        scheduled_service_id: scheduledServiceId,
        reason,
      }),
    };
    if (adoptMarkerRowId) {
      await trx('payments').where({ id: adoptMarkerRowId }).update(settledPaymentFields);
    } else {
      await trx('payments').insert(settledPaymentFields);
    }
    // Heal a stuck fee claim (Codex #3153 r21 P1): if the charging worker
    // died after Stripe accepted the PaymentIntent but before its row
    // update, the request sits 'charging' forever and every cancellation/
    // offboarding parks review despite the fee being durably settled here.
    // charge_review advances too (r25 P1): a post-Stripe park (ambiguous
    // submit outcome, commit failure after the PI went out) is resolved by
    // this settlement — the claim is one-shot (NULL→charging), so a PI
    // carrying this request_id can only belong to this row's single fee
    // event; leaving the park would strand a durably-paid fee in review
    // forever. Monotonic: terminal charged/released/waived never regress;
    // the trusted request_id comes from the PI metadata this settlement
    // already keys on.
    if (requestId) {
      await trx('appointment_card_requests')
        .where({ id: requestId })
        .whereIn('fee_status', ['charging', 'charge_review'])
        .update({
          fee_status: 'charged',
          no_show_payment_intent_id: piId,
          fee_charged_amount: amount,
          fee_charged_at: new Date(),
          updated_at: new Date(),
        });
    }
    return { invoice: inv };
  });
  const { sendNoShowFeeReceipt } = require('./estimate-card-holds');
  if (result.refundedPreSettlement) return { settled: false, reason: 'refunded_pre_settlement' };
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
  alertUnresolvedCancellationFee,
  appointmentCardCancelPreview,
  chargeAppointmentCardForRecapCompletion,
  settleAppointmentNoShowFee,
  resettleAppointmentFeeFromPi,
  isWithinApptCancelWindow,
  sendDeferredInvitationEmailLeg,
  resolveExemption,
  LIVE_VISIT_STATUSES,
  _test: {
    dateLineFor,
    resolveExemption,
    autoSecureFromSavedMethod,
    createSecureCardSetupIntent,
    verifySecureCardIntent,
    secureCardIntentMatchesRequest,
  },
};
