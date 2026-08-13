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
  // …and the stamp does not authorize the write, exactly as it does not for
  // request_booking. Filing here mutates the account AND pages the owner, so a
  // prior occupant or a spoofed secondary number could do both. Same single
  // switch as the booking write, same default: OFF ⇒ full ANI match only.
  if (unverifiedRequester && !require('./relay-booking').allowsThirdPartyWrites()) {
    return 'Re-service requests are only filed for the account the caller\'s own phone number matches. '
      + 'Capture the lead with what they are seeing and where, and tell them a Waves team member will call '
      + 'them back about it. Do NOT tell the caller a re-service has been scheduled or filed.';
  }

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
    .first('id', 'created_at', 'source', 'owner_alerted_at', 'subject', 'description', 'urgency', 'category', 'customer_id');
  if (openRequest) {
    // ⭐ THE OPEN TICKET'S ALERTS ARE RETRIED ON TOUCH (same rule as the
    // in-transaction guard below): a voice-filed row with no alert receipt is
    // a ticket whose page died with a process — re-fire and stamp rather than
    // letting this correct refusal be where the retry dies too.
    if (openRequest.source === VOICE_REQUEST_SOURCE && !openRequest.owner_alerted_at) {
      await fireReserviceAlertsAndStamp({
        row: openRequest, lane, covered: false, unverifiedRequester, unverifiedNote, ctx,
      }).catch(() => {});
    }
    return alreadyOpenText(lane, openRequest, speakDate);
  }

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
      + 'about it as soon as possible, and do NOT state a date, a time, a link, or a code.';
  }
  if (booked) {
    // ⭐ THE DATE AND WINDOW ARE FULL-TIER ONLY. This branch answers with a
    // visit's schedule, and "somebody will be at this property on Thursday
    // morning" is the physical-security disclosure the redacted tier exists to
    // withhold — a service-contact slot holds spouses, tenants and PRIOR
    // OCCUPANTS, and matching one authenticates nobody. Every read path in the
    // lane already draws that line (get_today_eta gives existence only); this
    // WRITE path was speaking past it. Redacted callers still get the honest
    // answer — do not file another — with no date and no window.
    if (unverifiedRequester) {
      return 'A free re-service visit is ALREADY on the schedule for this account. Do NOT file another '
        + 'request, and do NOT state the date or the arrival window — this caller\'s number is not the '
        + 'account\'s own. Tell them it is already booked and that a Waves team member can go over the '
        + 'details with the account holder. Never read out a link or a code.';
    }
    const when = speakDate(booked.date);
    // Customer-facing arrival copy is the TWO-HOUR RANGE from the shared
    // arrivalWindowRange() (AGENTS.md) — never the raw scheduling start, which
    // reads as a promise to arrive exactly then.
    const { arrivalWindowRange } = require('../../utils/sms-time-format');
    const range = booked.windowStart ? arrivalWindowRange(booked.windowStart) : null;
    return `A free re-service visit is ALREADY on the schedule for this account${when ? ` on ${when}` : ''}`
      + `${range ? ` (arrival window ${range})` : ''}. Do NOT file another request. `
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
    // ⭐ THE SHARED LANE LOCK, NOT A PRIVATE ONE. A namespace only this module
    // takes serializes this module against ITSELF and nothing else — and the
    // thing worth serializing against is the OTHER writer in this lane: the
    // self-service callback commit (routes/booking.js) takes
    // `reservice-lane`/<customer>:<serviceKey> and then checks
    // openCallbackExistsForLane. Filing under a different key let both commit,
    // producing a booked callback AND a redundant ticket that pages the owner
    // about a visit already on the calendar. Same namespace, same key shape.
    const { RESERVICE_LANES, openCallbackExistsForLane } = require('../reservice-scheduler');
    const laneServiceKey = (RESERVICE_LANES[lane] && RESERVICE_LANES[lane].serviceKey) || lane;
    await trx.raw(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['reservice-lane', `${customerId}:${laneServiceKey}`],
    );
    // …and the booked-callback dedupe re-runs INSIDE the lock. The read at the
    // top of this function is outside any transaction, so a callback that
    // committed in between would otherwise be invisible right up to the insert.
    try {
      if (await openCallbackExistsForLane(trx, customerId, lane)) {
        return { status: 'already_booked' };
      }
    } catch (err) {
      // An unanswerable dedupe is not a licence to write — the same fail-closed
      // posture the read at the top takes.
      logger.error(`[voice-relay-reservice] in-lock callback dedupe FAILED for ${customerId} — refusing to file: ${err.message}`);
      return { status: 'dedupe_failed' };
    }
    const raced = await trx('service_requests')
      .where({ customer_id: customerId, category })
      .whereIn('status', OPEN_REQUEST_STATUSES)
      .orderBy('created_at', 'desc')
      .first('id', 'created_at', 'source', 'owner_alerted_at', 'subject', 'description', 'urgency', 'category', 'customer_id');
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
  if (filedTicket.status === 'already_booked') {
    // A callback committed between the opening read and this lock. Same answer
    // that read gives, and — as there — the schedule detail is full-tier only.
    logger.warn(
      `[voice-relay-reservice] a re-service callback committed mid-call for customer ${customerId} `
      + `— no ticket filed (callSid=${ctx.callSid || 'n/a'})`
    );
    return 'A free re-service visit is ALREADY on the schedule for this account. Do NOT file another request '
      + 'and do NOT state a date or arrival window. Tell the caller it is already booked and that a Waves team '
      + 'member can go over the details. Never read out a link or a code.';
  }
  if (filedTicket.status === 'dedupe_failed') {
    return 'I could not check whether a re-service is already on the schedule for this account, so nothing was '
      + 'filed — filing a second one would double-book them. Tell the caller a Waves team member will follow up '
      + 'about it as soon as possible, and do NOT state a date, a time, a link, or a code.';
  }
  if (filedTicket.status === 'already_open') {
    logger.warn(
      `[voice-relay-reservice] concurrent ${category} request for customer ${customerId} — `
      + `no second ticket filed (callSid=${ctx.callSid || 'n/a'})`
    );
    // ⭐ THE OPEN TICKET'S ALERTS ARE RETRIED ON TOUCH. A process exit between
    // the earlier commit and its owner page left a durable ticket in the
    // documented black-hole queue with nobody paged — and this dedupe guard
    // was where the retry died: it correctly refused a second ticket and then
    // never re-alerted either. A voice-filed open row with no alert receipt
    // gets its alerts fired NOW (and stamped), so the guard is the retry rail
    // rather than the place retries go to die.
    const open = filedTicket.row;
    if (open && open.source === VOICE_REQUEST_SOURCE && !open.owner_alerted_at) {
      await fireReserviceAlertsAndStamp({
        row: open, lane, covered, unverifiedRequester, unverifiedNote, ctx,
      }).catch(() => {});
    }
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
  // Floor suppressed, but this call's artifact is a TICKET — no lead was
  // created, so the transcript must not be stamped as a captured lead.
  if (typeof ctx.markCaptured === 'function') ctx.markCaptured({ leadCreated: false });
  if (typeof ctx.markReserviceFiled === 'function') ctx.markReserviceFiled();

  // Both alerts, plus the durable receipt — see fireReserviceAlertsAndStamp.
  // The locals are authoritative for the fresh row (returning('*') shapes vary
  // by driver/mocks); only the id must come from the insert.
  await fireReserviceAlertsAndStamp({
    row: {
      id: created && created.id, customer_id: customerId, category, urgency, subject, description,
    },
    lane, covered, unverifiedRequester, unverifiedNote, ctx,
  }).catch(() => {});

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

/**
 * ⭐ THE ALERTS ARE THE ESCAPE HATCH, SO THEY GET A RECEIPT. The ticket queue is
 * a documented black hole (owner ruling — 14 requests, zero resolved); the
 * INTERNAL owner page is what makes a voice-filed ticket reach a human. Running
 * it as a fire-and-forget side effect made it evaporable: a process exit after
 * the commit stranded a durable ticket nobody would ever see. This helper fires
 * both alerts and stamps `service_requests.owner_alerted_at` ONLY when the
 * owner page actually went out — the stamp is what the retry-on-touch (the
 * already-open dedupe guard) and the hourly sweep key on.
 *
 * ⭐ OWNER-RULED ROUTING FIX underneath: routes/requests.js 409s a covered
 * pest/lawn ticket precisely because of that black hole; the agent cannot use
 * the streamline's booking half (it fires customer comms, which the agent may
 * NEVER do), so the ticket stays the durable record AND relay-alert's own
 * sender pages a human — internal-only by construction (owner phone +
 * messageType 'internal_alert').
 */
async function fireReserviceAlertsAndStamp({ row, lane, covered, unverifiedRequester = false, unverifiedNote = null, ctx = {} }) {
  if (!row || !row.id) return false;
  // ⭐ ONE PAGE PER TICKET, TAKEN ATOMICALLY. Three rails can meet the same
  // unreceipted row at once — the creator, an already-open retry guard on a
  // concurrent call, and the hourly sweep — and a receipt checked BEFORE this
  // helper and stamped after the send is a read-then-act race: two of them
  // page the owner twice. The claim is an expirable lease (same doctrine as
  // the hot-alert claim): one conditional UPDATE wins, a failed send releases
  // it, and a claim whose process died is reclaimable once no live send can
  // still be running. Fail-OPEN on a claim error — a duplicate page beats a
  // stranded ticket.
  let claimed = true;
  // ⭐ THE CLAIM VALUE IS THE OWNERSHIP TOKEN. Release below is conditioned on
  // this exact stamp still being on the row — a stale claimant (its send ran
  // past the lease while a retry reclaimed) clearing the column unconditionally
  // deleted the NEW claimant's live lease and let yet another retry page in
  // parallel. Millisecond-precision Date + request id is unique enough per
  // claimant; the value round-trips through Postgres intact.
  let claimStamp = null;
  try {
    const db = require('../../models/db');
    const stamp = new Date();
    const rows = await db('service_requests')
      .where({ id: row.id })
      .whereNull('owner_alerted_at')
      .whereRaw("(owner_alert_claimed_at IS NULL OR owner_alert_claimed_at < now() - interval '2 minutes')")
      .update({ owner_alert_claimed_at: stamp })
      .returning('id');
    claimed = !!(rows && rows.length > 0);
    if (claimed) claimStamp = stamp;
  } catch (err) {
    logger.warn(`[voice-relay-reservice] alert claim failed for request ${row.id} — paging anyway (fail-open): ${err.message}`);
  }
  if (!claimed) {
    logger.info(`[voice-relay-reservice] alert for request ${row.id} already claimed/receipted elsewhere — not paging twice`);
    return false;
  }
  const category = row.category;
  const urgency = row.urgency || 'routine';
  const subject = row.subject || '';
  const issue = row.description || subject;
  const customerId = row.customer_id;
  // INTERNAL admin notification — the same feed + deep link the portal's own
  // POST /api/requests writes to. Internal only; fail-open.
  let notif = null;
  try {
    // ⭐ THE FEED ROW IS DEDUPED ACROSS RETRIES. A failing owner page releases
    // the claim and the sweep retries hourly — without this check every retry
    // minted ANOTHER bell card for the same ticket. One persisted feed row per
    // request id is the receipt; the page below keeps its own.
    const db = require('../../models/db');
    const existingFeedRow = await db('notifications')
      .whereRaw("metadata->>'requestId' = ?", [String(row.id)])
      .first('id')
      .catch(() => null);
    if (existingFeedRow) notif = { id: existingFeedRow.id, deduped: true };
    const NotificationService = require('../notification-service');
    if (!notif) notif = await NotificationService.notifyAdmin(
      'service',
      `${urgency === 'urgent' ? '🚨 URGENT ' : ''}${unverifiedRequester ? '⚠️ UNVERIFIED REQUESTER — ' : ''}`
      + 'Phone assistant re-service request',
      // (the stored description may already carry the ⚠️ note — don't double it)
      `${unverifiedRequester && unverifiedNote && !String(issue).includes(unverifiedNote) ? `⚠️ ${unverifiedNote}\n\n` : ''}`
      + `Category: ${String(category || '').replace(/_/g, ' ')}\nSubject: ${subject}\n\n"${issue}"`,
      {
        icon: urgency === 'urgent' ? '🚨' : '🏠',
        link: `/admin/customers?customerId=${encodeURIComponent(customerId)}`,
        // A consent-adjacent, action-required card — must ring through the
        // bell policy like the contact-instruction row does.
        bell: true,
        metadata: {
          requestId: row.id,
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
    logger.error(`[voice-relay-reservice] admin notification threw for request ${row.id}: ${err.message}`);
  }
  // notifyAdmin SWALLOWS DB errors and returns null instead of throwing —
  // routes/requests.js checks `if (!notif)` for exactly this reason. A
  // suppressed sentinel is not a persisted row either.
  if (!notif || notif.suppressed) {
    logger.error(
      `[voice-relay-reservice] admin notification did NOT persist for request ${row.id} `
      + `(customer ${customerId}); the service_requests row is durable but may be unsurfaced in the admin feed.`
    );
  }
  let pageResult = false;
  try {
    const { alertOwnerReservice } = require('./relay-alert');
    pageResult = await alertOwnerReservice({
      lane, category, urgency, issue, subject, covered, requestId: row.id, customerId,
      unverifiedRequester, unverifiedNote,
    }, ctx);
  } catch (err) {
    // Fail-open: the ticket is already written and the caller (if any) is on
    // the line. The MISSING stamp is what keeps this retryable.
    logger.error(`[voice-relay-reservice] owner alert FAILED for request ${row.id}: ${err.message}`);
  }
  const paged = pageResult === true;
  if (paged) {
    try {
      const db = require('../../models/db');
      // Deliberately NOT claim-guarded: a delivered page must stamp even if
      // this claimant's lease was lost mid-send — leaving a delivered ticket
      // unstamped is what makes the sweep page AGAIN (the exact bug this
      // receipt exists to prevent). The duplicate-page race is closed on the
      // other side: release is claim-guarded and delivery is bounded inside
      // the lease.
      await db('service_requests').where({ id: row.id }).update({ owner_alerted_at: new Date() });
    } catch (err) {
      // Unstamped-but-paged: the lease holds off retries for 2 minutes, then
      // the sweep may page once more. A duplicate page beats a stranded ticket.
      logger.warn(`[voice-relay-reservice] owner_alerted_at stamp failed for request ${row.id}: ${err.message}`);
    }
  } else if (pageResult === 'ambiguous') {
    // The send timed out inside the lease — it may still land. Keep the claim:
    // releasing it here invited an immediate retry to page in parallel with a
    // late-landing send. The lease expires on its own; the sweep retries then.
    logger.warn(`[voice-relay-reservice] owner alert delivery ambiguous for request ${row.id} — keeping the claim until the lease expires`);
  } else {
    // Release the claim so the retry rails (guards + sweep) stay open — same
    // rule as the hot-alert claim: a failed page must stay retryable. Guarded
    // by OUR claim stamp: if a later claimant already owns the lease, this
    // touches nothing.
    try {
      const db = require('../../models/db');
      const q = db('service_requests').where({ id: row.id });
      if (claimStamp) q.where('owner_alert_claimed_at', claimStamp);
      else q.whereNull('owner_alert_claimed_at'); // never held a claim — nothing to give back
      await q.update({ owner_alert_claimed_at: null });
    } catch (err) {
      logger.warn(`[voice-relay-reservice] alert claim release failed for request ${row.id} — the lease expires on its own: ${err.message}`);
    }
  }
  return paged;
}

/**
 * Hourly backstop for the crash window fireReserviceAlertsAndStamp cannot cover
 * itself: a process exit between the ticket commit and the page leaves an open
 * voice-filed row with no receipt — and if the customer never calls again, no
 * touch ever retries it. Small, bounded, self-terminating: rows stamp on
 * success and leave the population. Gate note: alertOwnerReservice stands down
 * while VOICE_RELAY_CONTEXT_ENABLED is off, so rows filed before a gate-off
 * simply wait, stamped only when a page actually goes out.
 */
async function sweepUnalertedVoiceReservices({ limit = 10 } = {}) {
  const db = require('../../models/db');
  let rows = [];
  try {
    rows = await db('service_requests')
      .where({ source: VOICE_REQUEST_SOURCE })
      .whereIn('status', OPEN_REQUEST_STATUSES)
      .whereNull('owner_alerted_at')
      // Old enough that the filing call's own alert attempt is definitely over.
      .where('created_at', '<', new Date(Date.now() - 5 * 60 * 1000))
      .orderBy('created_at', 'asc')
      .limit(limit)
      .select('id', 'customer_id', 'category', 'urgency', 'subject', 'description', 'source', 'owner_alerted_at');
  } catch (err) {
    logger.error(`[voice-relay-reservice] unalerted-ticket sweep query failed: ${err.message}`);
    return 0;
  }
  let paged = 0;
  for (const row of rows) {
    const lane = Object.keys(LANE_CATEGORY).find((l) => LANE_CATEGORY[l] === row.category) || row.category;
    const unverified = /UNVERIFIED REQUESTER/i.test(String(row.subject || ''));
    // covered=false on the sweep: coverage was a live-call disclosure decision;
    // the page copy without it is simply more conservative.
     
    const ok = await fireReserviceAlertsAndStamp({
      row, lane, covered: false, unverifiedRequester: unverified, ctx: { recovery: true },
    }).catch(() => false);
    if (ok) paged += 1;
  }
  if (rows.length) {
    logger.info(`[voice-relay-reservice] unalerted-ticket sweep: ${rows.length} candidate(s), ${paged} paged`);
  }
  return paged;
}

module.exports = {
  requestReserviceText,
  fireReserviceAlertsAndStamp,
  sweepUnalertedVoiceReservices,
  LANE_CATEGORY,
  LANE_LABEL,
  OPEN_REQUEST_STATUSES,
  VOICE_REQUEST_SOURCE,
};
