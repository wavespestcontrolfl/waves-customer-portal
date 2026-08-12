/**
 * Voice-relay Phase E — EXISTING-CUSTOMER RESERVICE ROUTING.
 *
 * An ANI-matched customer calling because the problem came back between
 * scheduled visits ("the ants are back") is not a lead. Routing them through
 * capture_lead buries a service problem in the new-business pipeline, so this
 * files the request in the SAME place the customer portal files it: a
 * `service_requests` row with the portal's own category vocabulary
 * (`pest_issue` / `lawn_concern`), `status: 'new'`, and the portal's
 * `urgency` enum.
 *
 * WHY A TICKET AND NOT A BOOKED FREE VISIT (owner ruling needed to change
 * this): the streamline lane's other half — `createSelfBooking({
 * callbackVisit })` via routes/reservice-public.js — books the visit AND
 * fires a customer confirmation SMS/email. The voice agent may never send a
 * customer-facing communication (house rule), and it cannot hand out the
 * /reservice/:token picker link either (see the token rule below). So the
 * agent files the request and a human books it — exactly the posture Phase B
 * booking already takes (pending office review, no comms).
 *
 * THE SURFACES THIS LANDS ON are the existing ones, unchanged:
 *   - Customer 360 → Services tab → CustomerRequestsPanel
 *     (GET /api/admin/requests, routes/admin-requests.js)
 *   - the end-of-day unworked-comms digest, Lane 4 `loadOpenServiceRequests`
 *     (services/unworked-comms-watcher.js) — note its age floor: `urgent`
 *     rows surface after 2h, `routine` after 24h
 *   - the admin notification feed, via the SAME NotificationService.notifyAdmin
 *     ('service', …) call the portal's POST /api/requests makes
 *
 * ⭐ HARD RULE — `reservice_token` NEVER LEAVES THIS BUILDING BY VOICE.
 * `customers.reservice_token` is a standing bearer credential (no expiry) that
 * turns into a free booked visit at /reservice/:token. Nothing in this module
 * selects, formats, or returns it — the lane/eligibility read below goes
 * through reserviceLanesForCustomer (ownership rows only) rather than
 * reserviceStreamlineAccess, precisely BECAUSE the latter returns the raw
 * token in its result. Same precedent as service-report/report-data.js, which
 * exposes `reserviceEligible` as a boolean and never the token.
 *
 * GATE: the existing context gate (VOICE_RELAY_CONTEXT_ENABLED === 'true',
 * fail-closed). Matched caller only: an unmatched caller has no account to
 * file against and keeps using capture_lead exactly as today.
 */

const logger = require('../logger');

// The portal's own vocabulary (routes/requests.js createSchema) — imported by
// value here, not re-invented: a category outside this map would never render
// in CustomerRequestsPanel.
const LANE_CATEGORY = { pest: 'pest_issue', lawn: 'lawn_concern' };
const LANE_LABEL = { pest: 'pest control', lawn: 'lawn care' };
// service_requests.status values that keep a ticket open (mirrors the digest's
// `status NOT IN ('resolved','closed','cancelled')` predicate).
const OPEN_REQUEST_STATUSES = ['new', 'acknowledged', 'scheduled'];
// service_requests.source is varchar(80); this is the voice agent's marker.
const VOICE_REQUEST_SOURCE = 'voice_agent';

const MAX_SUBJECT = 200;   // service_requests.subject
const MAX_DESCRIPTION = 500; // portal validation cap on description

const REFUSE_GATE_OFF =
  'Re-service requests are not available on this call. Capture the lead with what is going on '
  + 'and tell the caller a Waves team member will follow up — do NOT promise a visit.';

const REFUSE_NO_CUSTOMER =
  'This tool only works for the account the caller\'s own phone number matches. For anyone else, '
  + 'use capture_lead with what is going on and tell them a Waves team member will follow up. '
  + 'Do NOT promise a free re-service.';

/**
 * File a re-service request for the matched caller.
 *
 * ctx is the relay session tool context ({ customerId, callSid, markCaptured,
 * reserviceFiled, markReserviceFiled }).
 */
async function requestReserviceText(input = {}, ctx = {}) {
  const { isContextEnabled, promptSafe, speakDate } = require('./relay-context');
  if (!isContextEnabled()) return REFUSE_GATE_OFF;

  // Matched caller ONLY — a looked-up customer_ref is a voice the number did
  // not verify, and this writes to their account.
  if (String(input.customer_ref || '').trim()) return REFUSE_NO_CUSTOMER;
  const customerId = ctx.customerId || null;
  if (!customerId) return REFUSE_NO_CUSTOMER;

  const lane = String(input.lane || '').trim().toLowerCase();
  if (!LANE_CATEGORY[lane]) {
    return 'Which service is the problem with — pest control or lawn care? Ask the caller, then call '
      + 'request_reservice again with lane set to "pest" or "lawn".';
  }
  const issue = promptSafe(input.issue, MAX_DESCRIPTION);
  if (!issue) {
    return 'Ask the caller what exactly is happening (what they are seeing and where), then call '
      + 'request_reservice again with that in `issue`.';
  }
  const category = LANE_CATEGORY[lane];
  const urgency = input.urgent === true ? 'urgent' : 'routine';

  const db = require('../../models/db');

  // Already-open ticket in this lane → never file a second one. Covers both a
  // model retry inside one call and a caller who already reported it.
  const openRequest = await db('service_requests')
    .where({ customer_id: customerId, category })
    .whereIn('status', OPEN_REQUEST_STATUSES)
    .orderBy('created_at', 'desc')
    .first('id', 'created_at');
  if (openRequest) {
    return `A ${LANE_LABEL[lane]} re-service request is already open on this account (filed `
      + `${speakDate(openRequest.created_at) || 'recently'}) — do NOT file another. Tell the caller it is `
      + 'already with the office and a Waves team member will reach out to get them on the schedule.';
  }

  // Already-booked free re-service in this lane → tell the caller when it is,
  // don't file anything. Reuses the picker's own lane dedupe read
  // (reservice-scheduler.openReserviceCallbacks) — no parallel query, and it
  // returns no token.
  let booked = null;
  try {
    const { openReserviceCallbacks } = require('../reservice-scheduler');
    const byLane = await openReserviceCallbacks(customerId);
    booked = (byLane && byLane[lane]) || null;
  } catch (err) {
    logger.warn(`[voice-relay-reservice] open-callback check failed for ${customerId}: ${err.message}`);
  }
  if (booked) {
    const when = speakDate(booked.date);
    return `A free re-service visit is ALREADY on the schedule for this account${when ? ` on ${when}` : ''}`
      + `${booked.windowStart ? ` (window starts ${booked.windowStart})` : ''}. Do NOT file another request. `
      + 'Tell the caller it is already booked. If they need to move it, a Waves team member can do that — '
      + 'never read out a link or a code.';
  }

  // Plan coverage, for the SCRIPT only (never for permission). Ownership rows
  // only — this call cannot return a token.
  let coveredLanes = [];
  try {
    const { reserviceLanesForCustomer } = require('../reservice-scheduler');
    const customer = await db('customers')
      .where({ id: customerId })
      .whereNull('deleted_at')
      // NOTE: reservice_token is deliberately NOT selected here.
      .first('id', 'active', 'waveguard_tier', 'monthly_rate');
    if (customer) coveredLanes = await reserviceLanesForCustomer(customer);
  } catch (err) {
    logger.warn(`[voice-relay-reservice] lane lookup failed for ${customerId}: ${err.message}`);
  }
  const covered = coveredLanes.includes(lane);

  const subject = promptSafe(`Re-service request (phone assistant): ${issue}`, MAX_SUBJECT);
  const [created] = await db('service_requests')
    .insert({
      customer_id: customerId,
      category,
      subject,
      description: issue,
      urgency,
      photos: JSON.stringify([]),
      status: 'new',
      source: VOICE_REQUEST_SOURCE,
    })
    .returning('*');

  logger.info(
    `[voice-relay-reservice] ${category} request ${created && created.id} filed for customer ${customerId} `
    + `[${urgency}] (callSid=${ctx.callSid || 'n/a'})`
  );

  // Suppress the hangup capture floor: this call produced a real service
  // request, not a new-business lead — writing a lead too would be exactly the
  // "generic lead noise" this lane exists to stop.
  if (typeof ctx.markCaptured === 'function') ctx.markCaptured();
  if (typeof ctx.markReserviceFiled === 'function') ctx.markReserviceFiled();

  // INTERNAL admin notification — the same feed + deep link the portal's own
  // POST /api/requests writes to. Internal only; fail-open.
  try {
    const NotificationService = require('../notification-service');
    await NotificationService.notifyAdmin(
      'service',
      `${urgency === 'urgent' ? '🚨 URGENT ' : ''}Phone assistant re-service request`,
      `Category: ${category.replace(/_/g, ' ')}\nSubject: ${subject}\n\n"${issue}"`,
      {
        icon: urgency === 'urgent' ? '🚨' : '🏠',
        link: `/admin/customers?customerId=${encodeURIComponent(customerId)}`,
        metadata: {
          requestId: created && created.id,
          customerId,
          category,
          urgency,
          source: VOICE_REQUEST_SOURCE,
          callSid: ctx.callSid || null,
        },
      }
    );
  } catch (err) {
    logger.warn(`[voice-relay-reservice] admin notification failed for request ${created && created.id}: ${err.message}`);
  }

  return `Re-service request filed for this account (${LANE_LABEL[lane]}${urgency === 'urgent' ? ', flagged urgent' : ''}). `
    + (covered
      ? 'This lane is covered by their plan, so the re-service itself is free — you may say that. '
      : 'Do NOT tell the caller whether it is free or chargeable; a team member will confirm coverage. ')
    + 'NOTHING IS SCHEDULED YET: tell them a Waves team member will reach out to get them on the schedule, '
    + 'and never state a date, a time, a link, or a code. Do not also call capture_lead for this — the '
    + 'request is already on their account.';
}

module.exports = {
  requestReserviceText,
  LANE_CATEGORY,
  LANE_LABEL,
  OPEN_REQUEST_STATUSES,
  VOICE_REQUEST_SOURCE,
};
