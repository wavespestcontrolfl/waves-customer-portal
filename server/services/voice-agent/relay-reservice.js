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
 * ⭐ THE UNVERIFIED-REQUESTER STAMP.
 *
 * The ANI match only earns tier 'full' when the calling number IS the account's
 * own `customers.phone`. A match on one of the `service_contact*_phone` slots —
 * a lead-dedup column set that holds spouses, tenants and PRIOR OCCUPANTS —
 * recognises the account and authenticates NOBODY (relay-context
 * .findUniqueCustomerByAni, relay-tools.matchedCallerTier; every READ path
 * already honours it). This write did not, so a redacted-tier caller filed a
 * `service_requests` row on someone else's account AND paged the owner with no
 * indication of who was actually on the line.
 *
 * The filing stays ALLOWED — a spouse calling because the ants are back is the
 * common, legitimate case — but every surface it lands on says so, leading with
 * the same words the booking lane stamps (relay-booking.js) so the office reads
 * one phrase, not two.
 */
function unverifiedRequesterStamp(from) {
  const { maskPhone } = require('./relay-protocol');
  return 'UNVERIFIED third-party requester — verify identity before confirming. The caller on '
    + `${maskPhone(from)} matched this account only on a secondary contact number `
    + '(spouse, tenant, or a previous occupant), NOT the account holder\'s own number.';
}

/** The one "already open, do not file another" script — used by both dedupes. */
function alreadyOpenText(lane, openRequest, speakDate) {
  return `A ${LANE_LABEL[lane]} re-service request is already open on this account (filed `
    + `${speakDate(openRequest && openRequest.created_at) || 'recently'}) — do NOT file another. Tell the caller it is `
    + 'already with the office and a Waves team member will reach out to get them on the schedule.';
}

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
  // Tier, not just identity: a contact-slot match hands back ctx.customerId
  // exactly like the account holder's own number does (see the stamp above).
  // Fail closed — an absent/unknown tier is 'redacted'.
  const { matchedCallerTier } = require('./relay-tools');
  const unverifiedRequester = matchedCallerTier(ctx) !== 'full';
  const unverifiedNote = unverifiedRequester ? unverifiedRequesterStamp(ctx.from) : null;

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
  // model retry inside one call and a caller who already reported it. This is
  // the FAST PATH only — the authoritative dedupe re-runs under an advisory
  // lock in the same transaction as the insert (see filedTicket below), because
  // a bare read-before-insert loses to a concurrent retry.
  const openRequest = await db('service_requests')
    .where({ customer_id: customerId, category })
    .whereIn('status', OPEN_REQUEST_STATUSES)
    .orderBy('created_at', 'desc')
    .first('id', 'created_at');
  if (openRequest) return alreadyOpenText(lane, openRequest, speakDate);

  // Already-booked free re-service in this lane → tell the caller when it is,
  // don't file anything. Reuses the picker's own lane dedupe read
  // (reservice-scheduler.openReserviceCallbacks) — no parallel query, and it
  // returns no token.
  // ⭐ THIS DEDUPE FAILS CLOSED. It used to be caught-and-continued, so a
  // lookup FAILURE read exactly like "no free re-service is booked" — and filed
  // a duplicate ticket for a customer who already had one on the calendar. An
  // unanswerable dedupe question is not a licence to write.
  let booked = null;
  try {
    const { openReserviceCallbacks } = require('../reservice-scheduler');
    const byLane = await openReserviceCallbacks(customerId);
    booked = (byLane && byLane[lane]) || null;
  } catch (err) {
    logger.error(`[voice-relay-reservice] open-callback dedupe FAILED for ${customerId} — refusing to file (fail closed): ${err.message}`);
    return 'I could not check whether a re-service is already on the schedule for this account, so nothing was '
      + 'filed — filing a second one would double-book them. Tell the caller a Waves team member will follow up '
      + 'about it shortly, and do NOT state a date, a time, a link, or a code.';
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

  // The stamp goes FIRST on both columns so it survives every truncation the
  // admin surfaces apply (CustomerRequestsPanel, the unworked-comms digest,
  // the notification feed) — an unmissable warning is the whole point.
  const subject = promptSafe(
    `${unverifiedRequester ? '⚠️ UNVERIFIED REQUESTER — ' : ''}Re-service request (phone assistant): ${issue}`,
    MAX_SUBJECT,
  );
  const description = unverifiedRequester
    ? `⚠️ ${unverifiedNote}\n\n${issue}`.slice(0, MAX_DESCRIPTION)
    : issue;
  // ⭐ THE COMMIT GATE. The dedupe above is a read, and the live-call path can
  // genuinely run this tool twice: a write that blows the relay's WRITE timeout
  // is DETACHED and still running, so a retry (or two callers on one account)
  // could pass the same "nothing open" read and file two tickets — two owner
  // pages for one problem. Serialize per (customer, lane) on an advisory lock
  // held for the transaction, re-read the dedupe INSIDE it, and insert there.
  // Same doctrine as the booking writer's rung-2 lock: the lock is what makes a
  // read-then-insert safe.
  const filedTicket = await db.transaction(async (trx) => {
    await trx.raw(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['voice-reservice-file', `${customerId}:${category}`],
    );
    const raced = await trx('service_requests')
      .where({ customer_id: customerId, category })
      .whereIn('status', OPEN_REQUEST_STATUSES)
      .orderBy('created_at', 'desc')
      .first('id', 'created_at');
    if (raced) return { status: 'already_open', row: raced };
    const [row] = await trx('service_requests')
      .insert({
        customer_id: customerId,
        category,
        subject,
        description,
        urgency,
        photos: JSON.stringify([]),
        status: 'new',
        source: VOICE_REQUEST_SOURCE,
      })
      .returning('*');
    return { status: 'created', row };
  });
  if (filedTicket.status === 'already_open') {
    logger.warn(
      `[voice-relay-reservice] concurrent ${category} request for customer ${customerId} — `
      + `no second ticket filed (callSid=${ctx.callSid || 'n/a'})`
    );
    return alreadyOpenText(lane, filedTicket.row, speakDate);
  }
  const created = filedTicket.row;

  logger.info(
    `[voice-relay-reservice] ${category} request ${created && created.id} filed for customer ${customerId} `
    + `[${urgency}]${unverifiedRequester ? ' [UNVERIFIED third-party requester]' : ''} `
    + `(callSid=${ctx.callSid || 'n/a'})`
  );

  // Suppress the hangup capture floor: this call produced a real service
  // request, not a new-business lead — writing a lead too would be exactly the
  // "generic lead noise" this lane exists to stop.
  if (typeof ctx.markCaptured === 'function') ctx.markCaptured();
  if (typeof ctx.markReserviceFiled === 'function') ctx.markReserviceFiled();

  // INTERNAL admin notification — the same feed + deep link the portal's own
  // POST /api/requests writes to. Internal only; fail-open.
  let notif = null;
  try {
    const NotificationService = require('../notification-service');
    notif = await NotificationService.notifyAdmin(
      'service',
      `${urgency === 'urgent' ? '🚨 URGENT ' : ''}${unverifiedRequester ? '⚠️ UNVERIFIED REQUESTER — ' : ''}`
      + 'Phone assistant re-service request',
      `${unverifiedRequester ? `⚠️ ${unverifiedNote}\n\n` : ''}`
      + `Category: ${category.replace(/_/g, ' ')}\nSubject: ${subject}\n\n"${issue}"`,
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
          unverified_requester: unverifiedRequester,
          ...(unverifiedNote ? { unverified_requester_note: unverifiedNote } : {}),
        },
      }
    );
  } catch (err) {
    logger.error(`[voice-relay-reservice] admin notification threw for request ${created && created.id}: ${err.message}`);
  }
  // notifyAdmin SWALLOWS DB errors and returns null instead of throwing, so the
  // catch above never sees a failed insert — routes/requests.js checks `if
  // (!notif)` for exactly this reason. The request row is durable either way;
  // an unsurfaced notification is not, so say so loudly enough to page.
  if (!notif) {
    logger.error(
      `[voice-relay-reservice] admin notification did NOT persist for request ${created && created.id} `
      + `(customer ${customerId}); the service_requests row is durable but may be unsurfaced in the admin feed.`
    );
  }

  // ⭐ OWNER-RULED ROUTING FIX. routes/requests.js 409s a covered pest/lawn
  // ticket precisely because the ticket queue is "a proven black hole — 14
  // requests, zero resolved"; the re-service streamline exists to bypass it.
  // The agent cannot use the streamline's booking half (it fires customer
  // comms, which the agent may NEVER do), so the ticket stays as the durable
  // record AND the existing INTERNAL owner alert fires for every voice-filed
  // re-service — reaching a human instead of the queue. No new notification
  // mechanism: this is relay-alert's own sender, the same one the hot-lead path
  // and createSelfBooking's confirm alert use, and it is internal-only by
  // construction (owner phone + messageType 'internal_alert').
  try {
    const { alertOwnerReservice } = require('./relay-alert');
    await alertOwnerReservice({
      lane, category, urgency, issue, subject, covered, requestId: created && created.id, customerId,
      unverifiedRequester, unverifiedNote,
    }, ctx);
  } catch (err) {
    // Fail-open: the ticket is already written and the caller is on the line.
    logger.error(`[voice-relay-reservice] owner alert FAILED for request ${created && created.id}: ${err.message}`);
  }

  return `Re-service request filed for this account (${LANE_LABEL[lane]}${urgency === 'urgent' ? ', flagged urgent' : ''}). `
    + (unverifiedRequester
      ? 'The number this call is coming from is only a secondary contact on this account, so the request is '
        + 'flagged for the office to verify who is asking. Do NOT read back or confirm any account details, '
        + 'and do not tell the caller anything is approved. '
      : '')
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
