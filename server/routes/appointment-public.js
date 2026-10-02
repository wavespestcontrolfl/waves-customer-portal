/**
 * Public appointment page routes — /api/public/appointment/:token.
 *
 * The single destination the 24-hour reminder and the booking-confirmation
 * texts link to (owner direction 2026-07-30: "less wordy text, more within
 * the link"). Those texts shrink to the essentials and this page carries
 * the rest: the 2-hour arrival window and what it means, a storm heads-up
 * when the forecast warrants one, who is coming, whether the visit is part
 * of a plan or a one-time treatment, an add-to-calendar file, and — for a
 * freshly booked visit — a one-tap Confirm.
 *
 * No auth. `scheduled_services.reschedule_token` (64-char hex) is the only
 * gate, exactly like /reschedule/:token — the same secret, deliberately
 * reused rather than minting a second one (see services/appointment-link.js).
 * Rate limits mirror the reschedule router; a bad/unknown token is a plain
 * 404 with no enumeration leak.
 *
 * GET  /:token               — appointment summary (see payload notes below).
 * GET  /:token/calendar.ics  — the same visit as a calendar file.
 * POST /:token/confirm       — marks a pending visit confirmed. A
 *   deliberately tiny write: status pending -> confirmed plus a
 *   job_status_history row. It never touches date/window/tech and never
 *   sends anything — customer comms stay owner-driven, and a confirmation
 *   that texted the customer back would be noise.
 * POST /:token/photos        — GATE_VISIT_PREP_PHOTOS (dark server
 *   foundation). Attaches up to 3 photos + a short note to THIS visit
 *   (services/visit-prep.js owns storage/caps/dedupe). Same tiny-write
 *   spirit as confirm: it never touches scheduled_services status, date,
 *   window or tech, and sends nothing to anyone. See the handler below for
 *   the full guard order.
 *
 * Dark until the owner flips GATE_APPOINTMENT_PAGE: every route 404s, so
 * the page is unreachable even by token until the templates that link it
 * are live. Kill switch = unset the var. The photos route additionally
 * needs GATE_VISIT_PREP_PHOTOS.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const db = require('../models/db');
const { isEnabled, visitPrepPhotosLive } = require('../config/feature-gates');
const logger = require('../services/logger');
const { noStore } = require('../middleware/no-store');
const { parseETDateTime, etDateString, addETDays, formatETDate } = require('../utils/datetime-et');
const NotificationService = require('../services/notification-service');
const { getDailyRainOutlookBounded } = require('../services/weather-forecast');
const { resolveTechPhotoUrl } = require('../services/tech-photo');
const { stampedDivergesSql } = require('../services/stamped-address');
const {
  arrivalWindowRange,
  formatSmsTimeRange,
  ARRIVAL_WINDOW_MINUTES,
} = require('../utils/sms-time-format');
const { calendarIcsAvailable, groupedStopEndsAt, groupedIcsVerdict } = require('../services/appointment-ics-eligibility');
const { visitInsideMoveNoticeWindow } = require('../services/scheduling/self-serve-notice');
const { visitTimeElapsed } = require('../services/reschedule-eligibility');
const visitPrep = require('../services/visit-prep');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');
const { recordPageView } = require('../services/customer-page-views');

// Token-keyed appointment data — never cacheable.
router.use(noStore);

const TOKEN_RE = /^[a-f0-9]{64}$/;

// The customer-quoted arrival window is ALWAYS window_start + 2 hours
// (owner rule; window_end is the internal job-duration block and never
// reaches a customer surface). The duration and the range derivation both
// come from sms-time-format so this page can never drift from the
// reminders, reports, and dispatch surfaces that quote the same window.
const ARRIVAL_PROMISE_MINUTES = ARRIVAL_WINDOW_MINUTES;

// '09:00' -> '9:00 AM - 11:00 AM', or null when the start is missing or
// malformed. Computed server-side so the page never carries a second
// implementation of the window rule.
function arrivalWindowLabel(start) {
  const range = arrivalWindowRange(start);
  if (!range) return null;
  const formatted = formatSmsTimeRange(range);
  return formatted === range ? null : formatted;
}

// Day-level NWS chance at or above which the page shows the storm
// heads-up. Matches the "heavy" tier the booking rain chips already use —
// a 40% afternoon in SWFL is an ordinary summer day and warning about it
// would train customers to ignore the note.
const STORM_NOTE_MIN_CHANCE = 50;

// Forecast is decoration: the page renders without it rather than waiting.
// Bounded lookup shares one in-flight NWS call per coordinate and carries a
// failure cooldown, so a burst of reminder-link opens during an outage
// can't herd outbound requests.
const FORECAST_DEADLINE_MS = 1500;

// Statuses this page will render as a live upcoming visit. 'rescheduled'
// is deliberately NOT here: the customer-portal request path uses it as a
// pending-rebook marker that keeps the OLD date/window on the row while
// staff pick the replacement — presenting that stale slot as a live booked
// visit (or letting it into the calendar file) would show the customer a
// time nobody intends to honor.
const UPCOMING_STATUSES = new Set(['pending', 'confirmed']);

// Dispatch-owned pending bookings (call-created follow-ups / outbound-review
// rows) stay office-owned until reviewed — the customer must not be able to
// self-confirm them from this token page any more than from the logged-in
// portal. Shared invariant with routes/schedule.js.
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS, isUnreviewedDispatchOwned } = require('../services/call-booking-source-actions');

// A call-created booking the office hasn't reviewed: still 'pending',
// dispatch-owned, and never customer-confirmed. Shared by the confirmable
// flag and the rescheduleToken suppression so the page can neither confirm
// nor reschedule a visit the authenticated routes hide (codex #3429 r3 P2).
function dispatchOwnedUnreviewed(svc) {
  return isUnreviewedDispatchOwned(svc);
}

function gateOpen() {
  return process.env.GATE_APPOINTMENT_PAGE === 'true';
}

router.use((req, res, next) => {
  if (!gateOpen()) return res.status(404).json({ error: 'Not found' });
  return next();
});

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
}));

const confirmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a minute.' },
});

// technicians stores a single `name`; customer surfaces show first name
// only (same helper shape track-public uses).
function firstNameOf(fullName) {
  if (!fullName) return null;
  const trimmed = String(fullName).trim();
  return trimmed ? trimmed.split(/\s+/)[0] : null;
}

function apptDateStr(scheduledDate) {
  if (!scheduledDate) return null;
  return scheduledDate instanceof Date
    ? scheduledDate.toISOString().slice(0, 10)
    : String(scheduledDate).slice(0, 10);
}

function hhmm(t) {
  return t ? String(t).slice(0, 5) : null;
}

// Customer-safe state for the page. `upcoming` renders the full card;
// everything else renders a short explanatory card with contact options.
function pageState(svc, now = new Date()) {
  const status = String(svc.status || '').toLowerCase();
  if (status === 'completed') return { state: 'completed' };
  if (status === 'cancelled' || status === 'canceled') return { state: 'cancelled' };
  // Same page state, but the phase matters to the copy: "on the way" is
  // stale — and reads as wrong to someone looking at the tech in their
  // driveway — once the status is on_site.
  if (status === 'en_route' || status === 'on_site') return { state: 'in_progress', phase: status };
  // Pending rebook: staff are choosing the replacement slot; the date and
  // window still on the row are the OLD ones and must not render as booked.
  if (status === 'rescheduled') return { state: 'pending_rebook' };
  if (!UPCOMING_STATUSES.has(status)) return { state: 'not_available' };

  // Past the quoted arrival window with no terminal status = the visit came
  // and went; don't show a "your visit is tomorrow" card for it.
  const date = apptDateStr(svc.scheduled_date);
  if (!date) return { state: 'upcoming' };
  if (!hhmm(svc.window_start)) {
    // Windowless: stays live through the end of its own calendar day — no
    // arrival-promise instant to compare against.
    const endsAt = parseETDateTime(`${date}T23:59`);
    return { state: endsAt && endsAt < now ? 'past' : 'upcoming' };
  }
  // A window_start is present: defer to the SAME "has this visit's time
  // passed" rule reschedule-eligibility.js applies (visitTimeElapsed —
  // codex + independent-reviewer finding on PR #5308). This used to
  // compute window_start+2h only, which could disagree with that rule for
  // a long job (e.g. 06:00-10:00 viewed at 09:00): this page would call the
  // visit "past" and offer a "Pick a new time" link, while
  // reschedule-eligibility.js still called it upcoming-and-not-missed —
  // reschedule-public.js then refuses the move (too soon, inside the
  // notice window) and the link dead-ends.
  return { state: visitTimeElapsed(svc, now) ? 'past' : 'upcoming' };
}


// Pure verdict for a confirm whose guarded UPDATE matched zero rows. A row
// that is confirmed AND customer_confirmed was confirmed by a customer
// action — this route, the logged-in route, and self-booking all write the
// pair — so the lost race was a duplicate confirm and the customer's
// intent already succeeded. A row confirmed WITHOUT customer_confirmed
// came from a staff/system write (SmartRebooker stamps a rescheduled
// visit's NEW slot 'confirmed' without it), where the date/window likely
// changed under the customer — that must surface as CHANGED so the client
// reloads instead of showing the stale slot as confirmed.
// Does the slot the client is looking at still match the row? The office
// bulk reschedule (admin-schedule.js) moves scheduled_date/window_start
// while deliberately LEAVING the row pending, so a status-only confirm
// guard would bless a replacement slot the customer was never shown
// (codex r9). Fails CLOSED on a missing date: this lane has never shipped
// (the router 404s while GATE_APPOINTMENT_PAGE is off), so there is no
// older client to stay compatible with, and a confirm that can't prove
// which slot it meant is exactly the one to reject. A windowless visit is
// legitimate, so null window must match null window.
function slotMatchesShown(svc, shown) {
  const seenDate = apptDateStr(shown?.date);
  if (!seenDate) return false;
  return seenDate === apptDateStr(svc?.scheduled_date)
    && hhmm(shown?.windowStart) === hhmm(svc?.window_start);
}

function confirmRaceVerdict(row) {
  const confirmed = String(row?.status || '').toLowerCase() === 'confirmed';
  return confirmed && !!row?.customer_confirmed ? 'idempotent_success' : 'changed';
}

// `conn` defaults to the global pool for every existing caller (the GET
// page, calendar.ics, confirm); visit-prep.js's late recheck passes its own
// transaction instead (Finding 1, pre-push audit) — a locked writer must
// never wait on the global pool for a connection while it already holds
// one plus the stop's advisory lock, or concurrent uploads can exhaust the
// pool with every lock holder stuck waiting on its own recheck.
async function loadByToken(token, conn = db) {
  return conn('scheduled_services as s')
    .where('s.reschedule_token', token)
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .leftJoin('technicians as t', 's.technician_id', 't.id')
    .first(
      's.id', 's.customer_id', 's.technician_id', 's.status', 's.scheduled_date',
      's.window_start', 's.window_end', 's.service_type', 's.is_recurring',
      's.recurring_parent_id', 's.recurring_pattern', 's.reschedule_token', 's.visit_id',
      's.source_action', 's.customer_confirmed', 's.property_id',
      // c.first_name is deliberately NOT selected — see the payload comment:
      // this token is shared with whoever the notification reached, so the
      // account holder's name must not travel with it.
      'c.deleted_at as customer_deleted_at',
      // Same rule as reschedule-public: only an EXPLICITLY active customer
      // may mutate through this shared token (C4 keeps a cancelled
      // customer's schedule read-only; anything but true is inactive).
      'c.active as customer_active',
      't.name as tech_name',
      't.photo_url as tech_photo_url',
      't.photo_s3_key as tech_photo_s3_key',
      conn.raw(`COALESCE(s.lat, CASE WHEN NOT ${stampedDivergesSql('s', 'c')} THEN c.latitude END) as latitude`),
      conn.raw(`COALESCE(s.lng, CASE WHEN NOT ${stampedDivergesSql('s', 'c')} THEN c.longitude END) as longitude`),
    );
}

// The customer-facing service label. registerAppointment persists a merged
// parent-plus-addons label ("Pest Control & Mosquito Control") into
// appointment_reminders.service_type, and the v2 texts use it — a page
// reached FROM those texts that names only the raw parent would silently
// drop scheduled work. Falls back to the raw column when no reminder row
// exists.
async function visitServicesFor(svc) {
  if (!svc || !svc.visit_id) return {};
  try {
    const members = await db('scheduled_services')
      .where({ visit_id: svc.visit_id })
      .whereNotIn('status', ['completed', 'cancelled', 'skipped', 'no_show'])
      .orderBy('window_start', 'asc')
      .select('id', 'service_type', 'status', 'source_action', 'customer_confirmed', 'scheduled_date', 'window_start', 'window_end', 'technician_id');
    if (members.length < 2) return {};
    // The members must still form ONE stop (local codex audit): the unit
    // mover commits members in separate transactions and a failed detach
    // can leave rows sharing a visit_id on different dates or disconnected
    // windows. The page shows one date and one window, so it must not
    // present — and the confirm must not fan out over — work on a date the
    // customer never saw. Fail closed.
    if (!membersOneStop(members)) {
      logger.warn(`[appointment-public] visit ${svc.visit_id} members no longer share one stop — page fails closed`);
      return { visitUnknown: true };
    }
    // The stop's canonical start drives the arrival promise: two links to
    // the same physical visit must quote the same window (codex r10). It is
    // the earliest start of THIS validated member snapshot (local codex
    // audit r23) — never a separate service_visits read: the unit mover
    // commits member rows before it retargets the parent, so a page or
    // calendar request in that window would pair the new member slots with
    // the old parent start and publish a wrong arrival window / ICS event.
    const windowStart = members.map((m) => hhmm(m.window_start)).filter(Boolean).sort()[0] || null;
    // Per-member PRISTINE labels (codex r15 P2): reminder registration
    // merges same-slot siblings into the owner row's service_type ("Pest
    // Control & Mosquito Control"), so resolving every member from its
    // reminder row duplicates work in the list. Each member's own
    // parent-plus-add-ons label (buildServiceLabel — the same customer-
    // facing resolution registration uses per row) is what the visit
    // list wants; the merged label stays the single notification heading.
    const services = await Promise.all(members.map((m) => memberServiceLabel(m)));
    const isConfirmed = (m) => String(m.status || '').toLowerCase() === 'confirmed';
    const isConfirmable = (m) => String(m.status || '').toLowerCase() === 'pending' && !dispatchOwnedUnreviewed(m);
    return {
      visit: {
        serviceCount: members.length,
        // Handed back by the confirm POST — see membersMatchShown.
        membershipKey: membershipKeyFor(members),
        services,
        windowStart,
        // Grouped state is the VISIT's, not the token row's (codex r11): the
        // appointment reads Confirmed only when every member is, and stays
        // confirmable while any member can still be customer-confirmed.
        allConfirmed: members.every(isConfirmed),
        anyConfirmable: members.some(isConfirmable),
        // A member awaiting its replacement slot (status 'rescheduled') makes
        // the whole stop pending-rebook: its stored slot is stale, so the
        // group must not render as booked (local codex audit).
        pendingRebook: members.some((m) => String(m.status || '').toLowerCase() === 'rescheduled'),
        // Visit-level state from ALL live members and the stop's own window
        // (local codex audit): underway if any member is, pending-rebook if
        // any awaits a slot, past once the STOP's window has elapsed — never
        // the token row's own two-hour window, which can expire while a later
        // chained sibling is still ahead.
        ...groupedState(members),
      },
      // INTERNAL — for the ICS route's shared verdict; stripped from the
      // page payload before the spread (never raw ids on a public page).
      members,
    };
  } catch (err) {
    // Unknown membership is NOT "ungrouped" (local codex audit): rendering
    // the token row alone while the confirm POST fans out to siblings the
    // page never showed lets a customer confirm work they did not see.
    // Fail closed — the page renders not_available, no confirm/reschedule.
    logger.warn(`[appointment-public] visit members lookup failed for ${svc.id}: ${err.message}`);
    return { visitUnknown: true };
  }
}

// Do these live members still form one stop — one date, one technician,
// windows forming a single connected chain (visit-groups' own connectivity
// rule)? Technician consistency too (codex r21): a per-row reassignment
// whose seam failed leaves rows under different technicians that must not
// be presented — or confirmed — as one appointment.
function membersOneStop(members) {
  const rows = members || [];
  if (new Set(rows.map((m) => apptDateStr(m.scheduled_date) || '')).size > 1) return false;
  if (new Set(rows.map((m) => String(m.technician_id || ''))).size > 1) return false;
  return require('../services/visit-groups').windowedMembersConnected(rows);
}

// The grouped stop's state from its live members: { state, phase } with the
// same vocabulary as pageState, derived from every member and the STOP's
// window (latest member end, else the arrival promise from the earliest
// start). Shared by the page, the confirm's pre-check and the locked
// membership proof so all three agree.
function groupedState(members, now = new Date()) {
  const rows = members || [];
  const status = (m) => String(m.status || '').toLowerCase();
  if (rows.some((m) => status(m) === 'on_site')) return { state: 'in_progress', phase: 'on_site' };
  if (rows.some((m) => status(m) === 'en_route')) return { state: 'in_progress', phase: 'en_route' };
  if (rows.some((m) => status(m) === 'rescheduled')) return { state: 'pending_rebook', phase: null };
  const date = apptDateStr(rows[0]?.scheduled_date);
  if (date) {
    // The stop stays live through the LATER of the quoted arrival promise
    // and the latest chained member's end (local codex audit r21) — the
    // shared groupedStopEndsAt math (appointment-ics-eligibility), so the
    // page's past-verdict and the calendar servability never drift. An
    // all-windowless stop keeps the page's own end-of-day fallback.
    const endsAt = groupedStopEndsAt(rows) || parseETDateTime(`${date}T23:59`);
    if (endsAt && endsAt < now) return { state: 'past', phase: null };
  }
  return { state: 'upcoming', phase: null };
}

// Row-level states that outrank the group's (the token row itself is
// terminal or unknown): keep pageState; otherwise the grouped state wins.
function pageStateForGroup(svc, visitInfo, now = new Date()) {
  const row = pageState(svc, now);
  if (!visitInfo?.visit) return row;
  if (!['upcoming', 'past', 'pending_rebook', 'in_progress'].includes(row.state)) return row;
  return { state: visitInfo.visit.state, phase: visitInfo.visit.phase };
}

// Opaque identity of a member SET (sorted ids, hashed): the page carries it
// and the confirm POST hands it back, so the server can prove the customer
// saw exactly the services it is about to confirm — a count cannot tell
// A+B from A+C (local codex audit). Never the raw ids on a public page.
function membershipKeyFor(members) {
  if (!members || members.length < 2) return null;
  // Bound to each member's PLACEMENT too (local audit): a sibling that moved
  // to another slot while keeping its visit_id is a different appointment
  // than the one the page showed.
  const parts = members.map((m) => `${m.id}@${apptDateStr(m.scheduled_date) || ''}T${hhmm(m.window_start) || ''}`).sort();
  return require('crypto').createHash('sha256').update(parts.join(',')).digest('hex').slice(0, 16);
}

// The confirm POST's shown-membership contract: the page showed the member
// set identified by `membershipKey` (null ⇒ the ungrouped/solo page). Under
// the stop lock the LIVE set must be exactly that one — anything else means
// the page and the stop disagree, and the tap must reload (CHANGED) rather
// than confirm services nobody saw. Returns the live members.
async function membersMatchShown(trx, svc, shown) {
  // FOR UPDATE on the whole live set (codex r18): a sibling terminalized
  // between this read and the fan-out's pending-only lock would otherwise be
  // re-evaluated away silently and the tap would succeed on a set the page
  // never showed.
  const { openMembers } = require('../services/visit-groups');
  const members = svc.visit_id ? await openMembers(trx, svc.visit_id, { forUpdate: true }) : [];
  const shownKey = typeof shown?.membershipKey === 'string' && /^[0-9a-f]{16}$/.test(shown.membershipKey) ? shown.membershipKey : null;
  if (membershipKeyFor(members) !== shownKey) {
    throw Object.assign(new Error('visit membership differs from the page'), { code: 'VISIT_STOP_MOVED' });
  }
  // Same stop invariant the page applied, repeated under the locks (local
  // codex audit): members that drifted onto different dates / disconnected
  // windows since the page loaded must reload, never be confirmed together.
  if (members.length >= 2 && !membersOneStop(members)) {
    throw Object.assign(new Error('visit members no longer share one stop'), { code: 'VISIT_STOP_MOVED' });
  }
  // The stop must still be confirmable as a whole under the locks — the
  // same grouped state the page rendered (underway / pending-rebook / past
  // ⇒ reload, never a fan-out).
  if (members.length >= 2 && groupedState(members).state !== 'upcoming') {
    throw Object.assign(new Error('visit is no longer confirmable as a stop'), { code: 'VISIT_STOP_MOVED' });
  }
  return members;
}

// Confirm every other pending, customer-confirmable member of the token
// row's visit — the page presented them as ONE appointment (codex #3609
// r6/r11). Caller holds the stop lock in `trx`; the token row's membership
// was proven by the caller's own CAS/re-read. Returns the confirmed ids.
async function confirmGroupedSiblings(trx, svc) {
  const siblings = await trx('scheduled_services')
    .where({ visit_id: svc.visit_id, status: 'pending' })
    .whereNot('id', svc.id)
    .forUpdate()
    // status is part of the projection: dispatchOwnedUnreviewed keys on
    // it, and a missing column made the guard a no-op (codex r10 P1).
    .select('id', 'status', 'source_action', 'customer_confirmed');
  const done = [];
  for (const sib of siblings) {
    if (dispatchOwnedUnreviewed(sib)) continue;
    const n = await trx('scheduled_services')
      .where({ id: sib.id, status: 'pending' })
      .update({ status: 'confirmed', customer_confirmed: true, confirmed_at: trx.fn.now(), updated_at: trx.fn.now() });
    if (n === 0) continue;
    await trx('job_status_history').insert({ job_id: sib.id, from_status: 'pending', to_status: 'confirmed', transitioned_by: null });
    done.push(sib.id);
  }
  return done;
}

// Calendar eligibility = the page's own verdict (codex r24 P2): grouped ⇒
// the STOP's state (an earlier chained member's two-hour window can have
// ended while the stop is still upcoming); ungrouped ⇒ the row's quoted
// window (calendarIcsAvailable).
function calendarEligible(svc, visitInfo, now = new Date()) {
  // Grouped: the SHARED verdict (appointment-ics-eligibility.
  // groupedIcsVerdict — the same one routes/schedule.js advertises links
  // from, so link and file can never drift; codex #3609 uncapped audit
  // P1). The token row's own terminal/unknown states still outrank the
  // stop, exactly as pageStateForGroup ranked them.
  if (!visitInfo?.visit) return calendarIcsAvailable(svc, now);
  if (!UPCOMING_STATUSES.has(String(svc?.status || '').toLowerCase())) return false;
  return !groupedIcsVerdict(visitInfo.members, now).blocked;
}

// The calendar file's DTSTART: the visit's shared start when grouped (the
// arrival promise the page shows), the row's own start otherwise.
function calendarWindowStart(svc, visitInfo) {
  return visitInfo?.visit?.windowStart || hhmm(svc?.window_start);
}

// Grouped stop ⇒ the calendar identity is the VISIT, not the member row
// (the ungrouped key is unchanged so existing customers' events still
// update in place).
function calendarUid(svc, visitInfo) {
  return visitInfo?.visit && svc?.visit_id ? `visit-group-${svc.visit_id}` : `visit-${svc?.id}`;
}

// One shared event must name every service at the stop, whichever member's
// link produced it (the last import wins the SUMMARY otherwise).
function calendarSummaryLabel(ownLabel, visitInfo) {
  const names = visitInfo?.visit?.services;
  if (Array.isArray(names) && names.length > 1) return [...new Set(names.filter(Boolean))].join(' + ') || ownLabel;
  return ownLabel;
}

// The already-confirmed grouped anchor is re-read FOR UPDATE (codex r13 P2):
// transitionJobStatus updates a row WITHOUT the stop advisory lock (its
// terminal seam runs post-commit), so only the row lock serializes a staff
// cancel/start against this fan-out verdict — a cancel that commits first
// is seen (status != confirmed → CHANGED); one that arrives later waits.
function readConfirmedAnchorLocked(trx, svc) {
  return trx('scheduled_services')
    .where({ id: svc.id })
    .forUpdate()
    .first('visit_id', 'status', 'customer_confirmed', 'scheduled_date', 'window_start');
}

// Already-confirmed anchor under the stop lock: prove it still sits at the
// shown slot, then — only when the visit really has two or more live
// members — confirm the pending siblings. A lone member is 'solo': the
// caller applies the single-row race verdict to the locked row.
async function confirmGroupedOrSolo(trx, svc, shown) {
  const cur = await readConfirmedAnchorLocked(trx, svc);
  if (!confirmedRowStillShown(cur, svc, shown)) {
    throw Object.assign(new Error('row changed under lock'), { code: 'VISIT_STOP_MOVED' });
  }
  const members = await membersMatchShown(trx, svc, shown);
  if (members.length < 2) return { outcome: 'solo', row: cur, confirmed: true };
  await confirmGroupedSiblings(trx, svc);
  // The customer confirmed the WHOLE visit from this row's link: a staff-
  // confirmed anchor (customer_confirmed=false) records that action too
  // (codex #3609 r22 P2) — tracking's confirmation step keys on the flag.
  // confirmed_at (the status transition) is left as written; updated_at
  // carries the customer's action time. CAS on the locked state.
  if (!cur.customer_confirmed) {
    await trx('scheduled_services').where({ id: svc.id, status: 'confirmed', customer_confirmed: false })
      .update({ customer_confirmed: true, updated_at: trx.fn.now() });
  }
  return { outcome: 'fanned', row: cur, confirmed: await visitAllConfirmed(trx, svc.visit_id) };
}

// Lost-race grouped confirm (local codex audit r25): the CAS missed because
// another confirmation path won the anchor between this request's read and
// its write — a winner that is NOT this route (the logged-in portal, self-
// booking) never fanned out to the siblings, so reporting the aggregate
// alone acknowledges a grouped confirm that left eligible pending siblings
// unconfirmed (and the page clears its Confirm CTA). Same contract as the
// already-confirmed grouped path, under the stop lock: the anchor re-read
// FOR UPDATE must still be a confirmed member at the shown slot, the shown
// member set must still be the live one, then the pending siblings are
// confirmed and the visit's aggregate reported. A lone member is 'solo':
// the caller applies the single-row race verdict to the locked row.
async function groupedAggregateUnderLock(svc, shown) {
  let locked = null;
  const ok = await underStopLock(svc, async (trx) => { locked = await confirmGroupedOrSolo(trx, svc, shown); });
  return { ok, confirmed: ok ? locked.confirmed : null, outcome: ok ? locked.outcome : null, row: ok ? locked.row : null };
}

// The visit's aggregate state after a fan-out (codex r17 P2): a
// dispatch-owned sibling stays pending, so the response must say what a
// reload would say (allConfirmed), never an unconditional true.
async function visitAllConfirmed(trx, visitId) {
  const { openMembers } = require('../services/visit-groups');
  const after = await openMembers(trx, visitId);
  return after.every((m) => String(m.status || '').toLowerCase() === 'confirmed');
}

// Locked re-read guard for the already-confirmed grouped fan-out (codex r12
// P1): the pre-lock loadByToken/slotMatchesShown pass proves nothing about
// the row AFTER a concurrent move, so under the stop lock the row must still
// (a) belong to the visit the page described, (b) still be confirmed, and
// (c) still sit at the slot the customer was shown. Anything else reloads
// as CHANGED rather than confirming siblings at a slot nobody saw.
function confirmedRowStillShown(cur, svc, shown) {
  return !!cur
    && String(cur.visit_id || '') === String(svc.visit_id || '')
    && String(cur.status || '').toLowerCase() === 'confirmed'
    && slotMatchesShown(cur, shown);
}

// Run `fn(trx)` under the token row's stop lock, retrying lockStopForRow's
// VISIT_STOP_MOVED like every other caller; returns false when the retry
// is exhausted (the route answers CHANGED, never a 500 — codex r10).
async function underStopLock(svc, fn) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await db.transaction(async (trx) => {
        const { lockStopForRow } = require('../services/visit-groups');
        await lockStopForRow(trx, svc.id);
        await fn(trx);
      });
      return true;
    } catch (err) {
      if (err && err.code === 'VISIT_STOP_MOVED') { if (attempt < 2) continue; return false; }
      throw err;
    }
  }
}

async function memberServiceLabel(m) {
  try {
    return await require('../services/appointment-reminders').buildServiceLabel(m.id, m.service_type);
  } catch {
    return m.service_type || 'service';
  }
}

async function resolveServiceLabel(svc) {
  try {
    const rem = await db('appointment_reminders')
      .where({ scheduled_service_id: svc.id })
      .orderBy('created_at', 'desc')
      .first('service_type');
    return rem?.service_type || svc.service_type || 'service';
  } catch {
    return svc.service_type || 'service';
  }
}

// "The same technician as your last visit" — a trust line, so it must be
// true: compare against the customer's most recent COMPLETED visit, and
// only claim it when both sides actually carry a tech. Recurring-only (a
// one-time customer has no "last visit" to be the same as).
async function sameTechAsLastVisit(svc) {
  if (!svc.technician_id || !svc.is_recurring) return false;
  try {
    // Deterministic recency: two completed visits can share a
    // scheduled_date (split jobs, add-on same-day work) with different
    // techs, and date-only ordering leaves Postgres free to return either
    // row. Tie-break on the completion timestamp, then the visit window,
    // so "the same technician as your last visit" names the tech who was
    // actually there last.
    const last = await db('scheduled_services')
      .where({ customer_id: svc.customer_id, status: 'completed' })
      .whereNot('id', svc.id)
      .orderBy([
        { column: 'scheduled_date', order: 'desc' },
        // The visit's own time beats updated_at: notes and other edits
        // touch updated_at after completion (admin-dispatch note endpoint),
        // so a later EDIT must not make an earlier visit look like the
        // most recent one.
        { column: 'window_start', order: 'desc' },
        { column: 'updated_at', order: 'desc' },
      ])
      .first('technician_id');
    return !!last?.technician_id && String(last.technician_id) === String(svc.technician_id);
  } catch (err) {
    logger.warn(`[appointment-public] last-visit tech lookup failed for ${svc.id}: ${err.message}`);
    return false;
  }
}

// Storm heads-up for the visit's own day. Fail-open in every direction:
// no coordinates, slow NWS, or no coverage all render the page without it.
async function stormOutlook(svc) {
  try {
    const date = apptDateStr(svc.scheduled_date);
    if (!date) return null;
    const outlook = await getDailyRainOutlookBounded(svc.latitude, svc.longitude, {
      deadlineMs: FORECAST_DEADLINE_MS,
    });
    const chance = outlook?.[date]?.rainChance;
    if (chance == null || !Number.isFinite(Number(chance))) return null;
    return {
      rainChance: Math.round(Number(chance)),
      stormy: Number(chance) >= STORM_NOTE_MIN_CHANCE,
    };
  } catch (err) {
    logger.warn(`[appointment-public] forecast failed for ${svc.id}: ${err.message}`);
    return null;
  }
}

// GATE_VISIT_PREP_PHOTOS additive summary for the GET payload. Gate off:
// `{}` — the key is absent and the payload is byte-identical to before this
// lane. Gate on: `{ prepPhotos }`, always present regardless of eligibility
// (a non-'upcoming' state simply reports eligible:false) so the client can
// show the right empty/full state instead of inferring it. Fails soft: a
// lookup error omits the key and logs a warning rather than 500ing the page.
async function prepPhotosField(svc, state, visitUnknown) {
  if (!visitPrepPhotosLive()) return {};
  try {
    const eligibility = visitPrep.visitPrepEligibility({
      svc, state, visitUnknown, dispatchOwnedUnreviewed: dispatchOwnedUnreviewed(svc),
    });
    const summary = await visitPrep.visitPrepSummary(svc);
    return {
      prepPhotos: {
        eligible: eligibility.eligible,
        photoCount: summary.photoCount,
        photosRemaining: summary.photosRemaining,
      },
    };
  } catch (err) {
    logger.warn(`[appointment-public] prepPhotos summary failed for ${svc.id}: ${err.message}`);
    return {};
  }
}

router.get('/:token', async (req, res, next) => {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const svc = await loadByToken(req.params.token);
    if (!svc || svc.customer_deleted_at) return res.status(404).json({ error: 'Not found' });
    // Customer-page-view log (bots/staff skipped, deduped, never blocks).
    void recordPageView({ req, page: 'appointment', customerId: svc.customer_id, subjectType: 'scheduled_service', subjectId: svc.id });

    const visitInfoRaw = await visitServicesFor(svc);
    // Unknown membership fails closed: the page can't be changed online
    // until the lookup works (never a solo page over a possibly grouped stop).
    // `members` is internal (ICS verdict input) — stripped with visitUnknown
    // so the payload spread below never carries raw member rows.
    const { visitUnknown, members: _visitMembers, ...visitInfo } = visitInfoRaw;
    // Grouped: the state is the STOP's (all members + the stop's window),
    // whichever member's link this is; ungrouped: the row's own.
    const { state, phase: livePhase } = visitUnknown ? { state: 'not_available', phase: null } : pageStateForGroup(svc, visitInfo);
    const base = {
      state,
      // in_progress only: 'en_route' | 'on_site', so the page can say "on
      // the way" vs "at your property" truthfully.
      phase: livePhase || null,
      // Deliberately NOT the customer's first name. The token is shared with
      // whoever the visit notification reached — a spouse, tenant or buyer —
      // so serving the account holder's name both mis-greets them and hands
      // a third party an identity they were never told. The page greets no
      // one; the SMS that carried the link already did (codex r9).
      // Visit group (visit-group-scope.md §4): the page lists every service
      // at this stop, so one reminder link covers the grouped visit.
      // (visitInfo is resolved above the payload so rescheduleToken can key
      // off it too.)
      service: { type: await resolveServiceLabel(svc), ...visitInfo },
      appointment: {
        date: apptDateStr(svc.scheduled_date),
        // windowStart stays the ROW's own start — it pins the slot the
        // confirm POST proves (slotMatchesShown). The arrival promise is
        // the VISIT's when grouped: the technician arrives for the stop.
        windowStart: hhmm(svc.window_start),
        arrivalWindow: arrivalWindowLabel(visitInfo.visit?.windowStart || hhmm(svc.window_start)),
      },
      // Whether the .ics route would actually serve this visit (codex r33
      // P2): the page must not render an Add-to-calendar action whose
      // request 404s — e.g. an all-windowless grouped stop is 'upcoming'
      // until end of day but has no DTSTART to file. Same verdict the ICS
      // route applies (calendarEligible over the raw visit snapshot).
      calendarEligible: visitUnknown ? false : calendarEligible(svc, visitInfoRaw),
      // "Look for this van" scene under the header card (GATE_VAN_SCENE).
      vanScene: isEnabled('vanScene'),
      // GATE_VISIT_PREP_PHOTOS (dark): additive only. Gate off = key absent,
      // payload byte-identical to before this lane. Fails soft on any
      // lookup error — never turns a summary read into a 500'd page.
      ...(await prepPhotosField(svc, state, visitUnknown)),
    };
    if (state !== 'upcoming') return res.json({ ...base, tech: null, plan: null, weather: null });

    // Decorations run together — neither blocks the other, and both are
    // individually fail-open.
    const [sameTech, weather, techPhotoUrl] = await Promise.all([
      sameTechAsLastVisit(svc),
      stormOutlook(svc),
      svc.technician_id
        ? resolveTechPhotoUrl(svc.tech_photo_s3_key, svc.tech_photo_url).catch(() => null)
        : Promise.resolve(null),
    ]);

    return res.json({
      ...base,
      // "Tomorrow" is an EASTERN calendar comparison — the visit date is an
      // ET wall-clock day, so deciding this on the client would mislabel it
      // for anyone whose device clock has already rolled over (late-evening
      // ET, or a customer travelling west).
      isTomorrow: base.appointment.date === etDateString(addETDays(new Date(), 1)),
      // status 'confirmed' is the existing schema value the dispatch board
      // already writes; the page just surfaces it.
      confirmed: visitInfo.visit
        ? visitInfo.visit.allConfirmed
        : String(svc.status).toLowerCase() === 'confirmed',
      // Drives the Confirm button. Mirrors the POST guard exactly: only a
      // plain 'pending' visit that is not dispatch-owned (call-created
      // follow-up / outbound-review awaiting office confirmation) may be
      // customer-confirmed, so the button never renders into a 409. For a
      // grouped visit the tap confirms every confirmable member, so the
      // button also shows from an already-confirmed member's link — whether
      // the customer or staff confirmed it (codex r12) — while a sibling
      // can still be confirmed (the POST fans out on any confirmed row at
      // the shown slot).
      // An inactive/cancelled account is read-only through this token too
      // (the POST refuses; the button must not render into that 409).
      confirmable: svc.customer_active === true && (visitInfo.visit
        ? (visitInfo.visit.anyConfirmable && ['pending', 'confirmed'].includes(String(svc.status).toLowerCase()) && !dispatchOwnedUnreviewed(svc))
        : (String(svc.status).toLowerCase() === 'pending' && !dispatchOwnedUnreviewed(svc))),
      tech: svc.technician_id
        ? { firstName: firstNameOf(svc.tech_name), photoUrl: techPhotoUrl || null, sameAsLastVisit: sameTech }
        : null,
      plan: {
        // Booster extras carry recurring_parent_id but is_recurring=false —
        // they are one-time work against a plan, and the plan note would
        // over-promise for them.
        isRecurring: !!svc.is_recurring,
        collectiveAnchor: !!svc.is_recurring && process.env.GATE_COLLECTIVE_SERIES_ANCHOR === 'true',
      },
      weather,
      // Mirror the reschedule-link/reschedule-public dispatch-owned guard
      // (codex #3429 r3 P2): an unreviewed dispatch-owned booking's reminder
      // now arms before office confirm, and the page must not render a
      // "See open times" CTA whose destination deterministically refuses.
      // A grouped visit is not customer self-reschedulable while the unit
      // move is staff-only (codex #3609 r4): no token → the page renders the
      // call/text guidance instead of a "See open times" CTA that would 409.
      // A FROZEN lone-live-member visit gets the same suppression (codex r26
      // P1 follow-up): visitServicesFor returns {} for it, but
      // reschedule-public's groupedVisit — the CTA's destination — refuses
      // it via the shared frozen verdict; the link would be dead on arrival.
      // An inactive/cancelled account also suppresses the token (codex GH
      // r8 P2): the CTA's destination refuses with account_inactive, so
      // the page must render call/text guidance instead of a dead link.
      rescheduleToken: (svc.customer_active !== true || dispatchOwnedUnreviewed(svc) || visitInfo.visit
        || (svc.visit_id && !visitInfo.visitUnknown
          && (await require('../services/visit-groups').frozenVisitVerdict(db, svc.visit_id)).frozen))
        ? null : svc.reschedule_token,
      // Dead-link guard (C3/C6): the "See open times" CTA's own destination
      // (/reschedule/:token) refuses to MOVE a visit that already starts
      // inside the self-serve move-notice window — the same verdict
      // buildRescheduleLink now applies before texting the link. We are
      // already inside `state === 'upcoming'` here (a missed/past visit
      // returned above with its own `state: 'past'`), so this is never the
      // missed-visit recovery case — only "too soon to move, not missed".
      canMoveOnline: !visitInsideMoveNoticeWindow(svc, new Date()),
    });
  } catch (err) {
    next(err);
  }
});

// ── calendar file ────────────────────────────────────────────────────────
// RFC 5545 text escaping: backslash, semicolon, comma, and newline.
function icsEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsStamp(date) {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

// Folds a content line to the 75-octet limit RFC 5545 requires; unfolded
// long lines are the classic reason an .ics silently fails to import.
function icsFold(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out = [];
  let current = '';
  for (const ch of line) {
    const candidate = current + ch;
    // Continuation lines start with a space, so they carry 74 octets.
    const limit = out.length === 0 ? 75 : 74;
    if (Buffer.byteLength(candidate, 'utf8') > limit) {
      out.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out.join('\r\n ');
}

router.get('/:token/calendar.ics', async (req, res, next) => {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const svc = await loadByToken(req.params.token);
    if (!svc || svc.customer_deleted_at) return res.status(404).json({ error: 'Not found' });
    // Grouped visit: the event starts at the STOP's canonical start, the
    // same window the page promised — a later member's link must not file a
    // calendar event that disagrees with its own page (codex r12).
    const visitInfo = await visitServicesFor(svc);
    // No calendar file for a stop with a member awaiting rebook, or one whose
    // membership cannot be read (fail closed) — the event would name a
    // service whose slot is stale.
    if (visitInfo.visitUnknown || visitInfo.visit?.pendingRebook) return res.status(404).json({ error: 'Not found' });
    // Eligibility is the SAME verdict the page shows (codex r24 P2): for a
    // grouped stop that is the stop's state (an earlier chained member's own
    // two-hour window can have ended while the stop is still upcoming);
    // ungrouped, the row's own quoted window.
    if (!calendarEligible(svc, visitInfo)) return res.status(404).json({ error: 'Not found' });

    const date = apptDateStr(svc.scheduled_date);
    const start = calendarWindowStart(svc, visitInfo);

    // ET wall-clock -> real instants, so the event lands correctly in any
    // device timezone. The event spans the customer-quoted 2-hour arrival
    // window, never the internal job block.
    const startAt = parseETDateTime(`${date}T${start}`);
    if (!startAt || Number.isNaN(startAt.getTime())) return res.status(404).json({ error: 'Not found' });
    const endAt = new Date(startAt.getTime() + ARRIVAL_PROMISE_MINUTES * 60000);

    const serviceLabel = calendarSummaryLabel(await resolveServiceLabel(svc), visitInfo);
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Waves Pest Control//Appointments//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      // Stable per visit: re-downloading updates the same event instead of
      // stacking duplicates in the customer's calendar. Grouped stop: ONE
      // identity for every member's link (codex r12/r13) — importing two
      // members' files updates one event instead of stacking two at the
      // same time.
      `UID:${calendarUid(svc, visitInfo)}@wavespestcontrol.com`,
      `DTSTAMP:${icsStamp(new Date())}`,
      `DTSTART:${icsStamp(startAt)}`,
      `DTEND:${icsStamp(endAt)}`,
      `SUMMARY:${icsEscape(`Waves Pest Control - ${serviceLabel}`)}`,
      `DESCRIPTION:${icsEscape(
        `Your technician arrives any time inside this 2-hour window. On service day we'll text you a live tracking link. Questions? (941) 297-5749`
      )}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].map(icsFold);

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="waves-appointment.ics"');
    return res.send(`${lines.join('\r\n')}\r\n`);
  } catch (err) {
    next(err);
  }
});

// ── confirm ──────────────────────────────────────────────────────────────
router.post('/:token/confirm', confirmLimiter, async (req, res, next) => {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const svc = await loadByToken(req.params.token);
    if (!svc || svc.customer_deleted_at) return res.status(404).json({ error: 'Not found' });
    // The token is shared with reschedule-public, and C4's widened schedule
    // read hands a cancelled customer their pending visit's rescheduleUrl —
    // this consumer must apply the same explicitly-active mutation guard the
    // reschedule routes do, or the read-only contract leaks a confirm write
    // (codex GH r6 P1).
    if (svc.customer_active !== true) {
      return res.status(409).json({
        error: "This visit can't be confirmed online anymore.",
        code: 'NOT_CONFIRMABLE',
      });
    }

    // Grouped: the STOP's state (all members + the stop's window), same
    // derivation as the page; an unreadable membership is not confirmable.
    const preInfo = svc.visit_id ? await visitServicesFor(svc) : {};
    const { state } = preInfo.visitUnknown ? { state: 'not_available' } : pageStateForGroup(svc, preInfo);
    if (state !== 'upcoming') {
      return res.status(409).json({
        error: "This visit can't be confirmed online anymore.",
        code: 'NOT_CONFIRMABLE',
      });
    }
    // The customer confirms the SLOT THEY WERE SHOWN, not merely "whatever
    // is confirmable on this row". The office bulk reschedule
    // (admin-schedule.js) moves scheduled_date/window_start while
    // deliberately LEAVING the row pending, so a status-only guard lets a
    // page opened before the move confirm a replacement slot the customer
    // never saw, and the card just flips to Confirmed (codex r9). The
    // earlier race work keyed on WHO wrote the status; this path never
    // writes it, so it slipped underneath all of it.
    //
    // This runs BEFORE the idempotency branch for the same reason r7 moved
    // the race verdict there: a second tap on a page showing the OLD slot
    // must reload the move, not be blessed as a duplicate success.
    //
    // Fails CLOSED on a missing field: this lane has never shipped (the
    // whole router 404s while GATE_APPOINTMENT_PAGE is off), so there is
    // no older client to stay compatible with, and a confirm that cannot
    // prove which slot it meant is exactly the one to reject.
    if (!slotMatchesShown(svc, req.body)) {
      return res.status(409).json({
        error: 'This appointment just changed — please refresh.',
        code: 'CHANGED',
      });
    }

    // Idempotent: a second tap (or a double-submit) is a success — but only
    // when the CUSTOMER's confirm won. Same verdict as the post-update race
    // path: SmartRebooker can commit a reschedule between the page GET and
    // this POST, stamping the NEW slot 'confirmed' without
    // customer_confirmed; returning success there would mark the client's
    // stale date/window as confirmed instead of reloading the move.
    if (String(svc.status).toLowerCase() === 'confirmed') {
      // Grouped visit (codex r11/r12): this member is already confirmed —
      // by the customer OR by staff — but the page offered the confirm for
      // the whole stop (the GET's confirmable flag keys on the VISIT), so
      // the tap fans out to the still-pending confirmable siblings. WHO
      // confirmed this row is irrelevant here: slotMatchesShown above
      // already proved the row sits at the slot the customer saw, which is
      // the only thing the customer-vs-rebooker verdict protects on an
      // ungrouped row. Under the stop lock the row is re-read and must
      // STILL be a confirmed member of this visit at the shown slot (P1) —
      // a move landing between the pre-lock read and the lock otherwise
      // confirms siblings at a slot nobody was shown.
      if (svc.visit_id) {
        let locked = null;
        const ok = await underStopLock(svc, async (trx) => { locked = await confirmGroupedOrSolo(trx, svc, req.body); });
        if (!ok) return res.status(409).json({ error: 'This appointment just changed — please refresh.', code: 'CHANGED' });
        // A visit_id with ONE live member is not grouped (local codex
        // audit): the page rendered single-row behavior, so the existing
        // race verdict applies — on the LOCKED row — instead of a fan-out
        // success for a staff confirm the customer never made.
        if (locked.outcome === 'solo' && confirmRaceVerdict(locked.row) !== 'idempotent_success') {
          return res.status(409).json({ error: 'This appointment just changed — please refresh.', code: 'CHANGED' });
        }
        return res.json({ success: true, confirmed: locked.confirmed !== false });
      }
      if (confirmRaceVerdict(svc) === 'idempotent_success') {
        return res.json({ success: true, confirmed: true });
      }
      return res.status(409).json({
        error: 'This appointment just changed — please refresh.',
        code: 'CHANGED',
      });
    }

    // A call-created follow-up / outbound-review booking is dispatch-owned
    // until the office confirms it — the logged-in confirm route refuses
    // these (routes/schedule.js) and this token route must too, or the link
    // holder can flip a visit the office hasn't reviewed. Same invariant as
    // call-booking-source-actions.js; 409 (not 404) because the token IS
    // valid and the page stays viewable.
    if (DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(svc.source_action) && !svc.customer_confirmed) {
      return res.status(409).json({
        error: "Our office is finalizing this appointment's details — no confirmation needed yet.",
        code: 'NOT_CONFIRMABLE',
      });
    }

    // This route's documented write contract is pending -> confirmed ONLY.
    // Every other upcoming status (e.g. 'rescheduled', the pending-rebook
    // marker staff resolve) is not customer-confirmable here.
    if (String(svc.status).toLowerCase() !== 'pending') {
      return res.status(409).json({
        error: "This visit can't be confirmed online anymore.",
        code: 'NOT_CONFIRMABLE',
      });
    }

    // Status-only write, guarded on the status AND the slot we read, so a
    // concurrent dispatch change (cancel, en_route) or a bulk move landing
    // between this read and the update is never overwritten. No date,
    // window, or tech is touched, and nothing is sent to the customer.
    // The status flip and its job_status_history row commit atomically —
    // the history table is the canonical transition audit, so a lost row
    // must fail the confirm rather than silently succeed without it.
    let updated = 0;
    let aggregateConfirmed = true; // grouped: the visit's state after the fan-out (codex r17 P2)
    // lockStopForRow's peek→lock→verify contract throws VISIT_STOP_MOVED
    // when the stop moved between the two reads; retry like every other
    // caller, and turn an exhausted retry into the page's CHANGED reload
    // instead of a 500 (codex r10).
    let stopMovedRetries = 0;
    const confirmOnce = async () => db.transaction(async (trx) => {
      // Visit writers (createOrJoinVisit, split, unit move) take the STOP
      // lock before any member row lock; this confirm follows the same
      // stop→row order so the two can never form a lock cycle (codex #3609
      // r7). Taken for grouped rows only — an ungrouped confirm never
      // touches visit state.
      if (svc.visit_id) {
        const { lockStopForRow } = require('../services/visit-groups');
        await lockStopForRow(trx, svc.id);
      }
      updated = await trx('scheduled_services')
        // scheduled_date/window_start come straight off the row we read, so
        // the predicate closes the read->update gap without re-parsing
        // client input. knex renders a null as `is null`, which is what a
        // windowless visit needs.
        .where({
          id: svc.id,
          status: 'pending',
          scheduled_date: svc.scheduled_date,
          window_start: svc.window_start,
          // The observed visit membership is part of the CAS: a row split
          // from its visit between the page read and this write misses,
          // so the sibling fan-out below can never confirm members of a
          // visit the row no longer belongs to (knex renders null as
          // IS NULL for ungrouped rows).
          visit_id: svc.visit_id || null,
        })
        // customer_confirmed + confirmed_at ride along for parity with the
        // logged-in confirm route (routes/schedule.js) and self-booking
        // (routes/booking.js), which write the trio together: the portal's
        // "Confirm Visit" button keys on the flag, and /api/schedule
        // exposes confirmedAt — a token-page confirm must not leave a
        // hole in that record.
        .update({
          status: 'confirmed',
          customer_confirmed: true,
          confirmed_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        });
      if (updated === 0) return;
      await trx('job_status_history').insert({
        job_id: svc.id,
        from_status: 'pending',
        to_status: 'confirmed',
        transitioned_by: null,
      });
      // The page presented every live service at this stop as ONE
      // appointment, so the tap confirms the grouped visit (codex #3609
      // r6): under the stop lock, every other pending member that is
      // customer-confirmable (not dispatch-owned/unreviewed) flips with the
      // same guarded write + history row. Members already confirmed or in
      // any other state are untouched.
      if (svc.visit_id) {
        // Stop lock already held (above) and the CAS just proved the row
        // still belongs to svc.visit_id. The live member set must be the
        // size the page showed (membersMatchShown) — a mismatch rolls this
        // confirm back and reloads the page (CHANGED).
        await membersMatchShown(trx, svc, req.body);
        await confirmGroupedSiblings(trx, svc);
        aggregateConfirmed = await visitAllConfirmed(trx, svc.visit_id);
      }
    });
    for (;;) {
      try {
        await confirmOnce();
        break;
      } catch (err) {
        if (err && err.code === 'VISIT_STOP_MOVED' && stopMovedRetries < 2) { stopMovedRetries += 1; updated = 0; continue; }
        if (err && err.code === 'VISIT_STOP_MOVED') {
          return res.status(409).json({ error: 'This appointment just changed — please refresh.', code: 'CHANGED' });
        }
        throw err;
      }
    }
    if (updated > 0) {
      // pending → confirmed is a grouping moment (the job-status.js
      // pendingConfirmed seam): this route bypasses transitionJobStatus for
      // its slot-guarded CAS + atomic history row, so it runs the seam
      // itself. Post-commit, fire-and-forget, best-effort — a grouping
      // failure can never fail the customer's confirm. The helper
      // self-refuses already-grouped rows, so a grouped confirm is a no-op.
      // NOT run on the updated === 0 idempotent path: the winning writer
      // already ran its own seam.
      void require('../services/visit-groups').maybeGroupRow(svc.id, { createdBy: 'dispatch' }).catch((e) => {
        logger.warn(`[appointment-public] visit-group confirm seam failed for ${svc.id}: ${e.message}`);
      });
    }
    if (updated === 0) {
      // Losing the guarded update is not automatically an error: two taps
      // racing both pass the early idempotency check, the first commits,
      // and the second matches zero rows. Re-read and distinguish WHO won
      // the race (confirmRaceVerdict): a duplicate customer confirm is the
      // documented double-submit success; anything else — including a
      // SmartRebooker reschedule that stamps 'confirmed' on a NEW slot —
      // must reload as CHANGED or the page shows the stale slot.
      //
      // The verdict is necessary but NOT sufficient: the office can move the
      // visit after this request's first read, and a different surface (the
      // logged-in portal, or this page in another tab) can then confirm the
      // NEW slot. That leaves status=confirmed AND customer_confirmed=true —
      // an "idempotent success" by identity — while the slot is no longer
      // the one this client is showing. So the reread carries the slot too
      // and it must STILL match what the customer saw, or the answer is
      // CHANGED and the page reloads (codex, r10 follow-up).
      const now = await db('scheduled_services')
        .where({ id: svc.id })
        .first('status', 'customer_confirmed', 'scheduled_date', 'window_start');
      if (confirmRaceVerdict(now) === 'idempotent_success' && slotMatchesShown(now, req.body)) {
        if (svc.visit_id) {
          // Grouped (local audit): the anchor alone proves nothing about the
          // visit — a dispatch-owned sibling may still be pending, or the
          // membership may have changed (which is what made the CAS miss).
          // Same contract as the other grouped paths, under the stop lock.
          const grouped = await groupedAggregateUnderLock(svc, req.body);
          if (!grouped.ok) return res.status(409).json({ error: 'This appointment just changed — please refresh.', code: 'CHANGED' });
          // ONE live member is not grouped: the single-row race verdict
          // applies, on the LOCKED row (same as the already-confirmed path).
          if (grouped.outcome === 'solo' && confirmRaceVerdict(grouped.row) !== 'idempotent_success') {
            return res.status(409).json({ error: 'This appointment just changed — please refresh.', code: 'CHANGED' });
          }
          return res.json({ success: true, confirmed: grouped.confirmed !== false });
        }
        return res.json({ success: true, confirmed: true });
      }
      return res.status(409).json({
        error: 'This appointment just changed — please refresh.',
        code: 'CHANGED',
      });
    }

    return res.json({ success: true, confirmed: aggregateConfirmed });
  } catch (err) {
    next(err);
  }
});

// ── visit prep photos (GATE_VISIT_PREP_PHOTOS) ──────────────────────────────
// Own limiter — 6/min, well under the router-wide 60/min, since a real
// customer submits at most a couple of times per visit. Keyed by the
// repository's /64-collapsing unauthenticated key, not express-rate-limit's
// raw-IP default (Codex r1 P1): an IPv6 caller holding one token could
// otherwise rotate addresses inside its subnet for a fresh bucket each time.
const VISIT_PREP_LIMITER_OPTIONS = {
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: unauthenticatedAuthLimitKey,
  message: { error: 'Too many attempts. Please try again in a minute.' },
};
const visitPrepLimiter = rateLimit(VISIT_PREP_LIMITER_OPTIONS);

// GATE_VISIT_PREP_PHOTOS + token-shape guard for the photos path. ONE
// definition mounted twice on purpose: by server/index.js on the
// /api/public/appointment prefix AHEAD of the shared body parsers (Codex r1
// P0: with the parsers first, an oversized or malformed application/json
// body to a dark or malformed photos path was answered 413/400 by the
// parser before this 404 could run), and again as the route's own first
// step so the router stays correct on its own. Both answer the SAME
// generic 404 the router-level gate gives, BEFORE the route's limiter
// (AGENTS.md: a dark GATE_* route skips its limiter so a probe never sees
// a revealing 429). `req.path` is mount-relative in both places. Express
// matches routes case-insensitively, so the path test is too — otherwise
// `/<token>/PHOTOS` would reach the route (and the shared parsers) while
// slipping past this guard (pre-push audit P0). The route takes multipart
// only, and the shared parsers read only JSON / urlencoded bodies, so any
// other body type 404s here too (Codex #5176 r4 P0): a well-formed but
// unknown or ineligible token would otherwise reach those parsers before
// loadByToken and get their 400/413 instead of the generic 404. A
// multipart body is left for multer, which runs only after eligibility.
const VISIT_PREP_PHOTOS_PATH_RE = /^\/([^/]+)\/photos\/?$/i;
function visitPrepPreParserGuard(req, res, next) {
  const match = VISIT_PREP_PHOTOS_PATH_RE.exec(req.path || '');
  if (!match) return next();
  if (!TOKEN_RE.test(match[1]) || !visitPrepPhotosLive() || !req.is('multipart/form-data')) {
    return res.status(404).json({ error: 'Not found' });
  }
  return next();
}

const visitPrepUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: visitPrep.VISIT_PREP_LIMITS.maxPhotoBytes,
    files: visitPrep.VISIT_PREP_LIMITS.photosPerSubmission,
    fields: 6,
    fieldSize: 2 * 1024,
    parts: 10,
  },
});

// The pre-multer guard's eligibility derivation, over the GLOBAL pool — the
// same page read the GET route uses (visitServicesFor, which also resolves
// each member's customer-facing service label through buildServiceLabel and
// other global-pool services). This is a cheap, advisory-only read; it does
// NOT share its query path with the locked recheck below (Finding 1,
// pre-push audit: a locked writer reading through the global pool while it
// already holds a connection + the stop's advisory lock can starve the pool
// under concurrent uploads). Both paths still end in the ONE eligibility
// RULE, `visitPrep.visitPrepEligibility({ svc, state, visitUnknown,
// dispatchOwnedUnreviewed })` — only how `state`/`visitUnknown` are READ
// differs: this one via the page's own visitServicesFor, the locked recheck
// via reloadEligibleVisitPrepRow below (openMembers on the write's own
// transaction).
async function deriveVisitPrepEligibility(svc) {
  const visitInfoRaw = svc.visit_id ? await visitServicesFor(svc) : {};
  const { state } = visitInfoRaw.visitUnknown ? { state: 'not_available' } : pageStateForGroup(svc, visitInfoRaw);
  return visitPrep.visitPrepEligibility({
    svc,
    state,
    visitUnknown: visitInfoRaw.visitUnknown,
    dispatchOwnedUnreviewed: dispatchOwnedUnreviewed(svc),
  });
}

// The locked recheck (Finding 1): every read here runs on `trx` — the
// SAME transaction/connection the write already holds along with the stop's
// advisory lock — never the global pool. Reloads the row via loadByToken(…,
// trx); for a grouped visit, reads the live member set with
// visit-groups.js's openMembers(trx, visit_id) (the confirm path's own
// locked-membership read, membersMatchShown, precedent) instead of
// visitServicesFor — that helper resolves per-member service LABELS through
// other global-pool services this recheck needs none of. The SAME pure
// rules the page applies then decide state: fewer than 2 live members is
// solo (exactly how visitServicesFor treats it), members no longer forming
// ONE stop (membersOneStop) is visitUnknown, and a real stop's state comes
// from groupedState(members) — fed through pageStateForGroup's own
// row-state-outranks-the-group precedence, so a terminal/unknown token row
// still wins exactly as it does on the page. Returns null when the row is
// missing, its customer row is gone, deleted, or no longer the customer the
// pre-check read, it is no longer the SAME row
// `expectedId` names (this route never re-mints the token, so a mismatch
// means something is badly wrong), or the resulting eligibility is false;
// otherwise the current row. Passed to visit-prep.js as its `recheck(trx)` —
// eligibility can change between the pre-multer read and the write (the
// visit can go en route, get cancelled, or a grouped sibling can push the
// stop's state), and this is the one place that re-proves it, on the
// connection that already owns the lock.
// The generic CORE of the locked recheck: given a svc row that the caller
// has ALREADY loaded fresh on `trx` (after its own row lock + identity
// checks — token match for the public route below, or customer-ownership
// match for the app route in schedule.js), locks any grouped members and
// re-derives eligibility on that fresh state. Returns the row when eligible,
// else null. Exported so schedule.js's app-authenticated POST /:id/prep-photos
// can share this exact member-lock + eligibility recheck rather than growing
// its own copy — schedule.js requires this module directly (never the
// reverse), so there is no cycle the way there would be pulling this logic
// into visit-prep.js (which this route already requires).
async function reloadEligibleVisitPrepRowCore(svc, trx) {
  if (!svc) return null;
  let visitUnknown = false;
  let visitInfo = {};
  if (svc.visit_id) {
    const { openMembers } = require('../services/visit-groups');
    const members = await openMembers(trx, svc.visit_id, { forUpdate: true });
    if (members.length >= 2) {
      if (!membersOneStop(members)) {
        visitUnknown = true;
      } else {
        const { state, phase } = groupedState(members);
        visitInfo = { visit: { state, phase } };
      }
    }
  }
  const { state } = visitUnknown ? { state: 'not_available' } : pageStateForGroup(svc, visitInfo);
  const eligibility = visitPrep.visitPrepEligibility({
    svc, state, visitUnknown, dispatchOwnedUnreviewed: dispatchOwnedUnreviewed(svc),
  });
  return eligibility.eligible ? svc : null;
}

async function reloadEligibleVisitPrepRow(token, expectedId, expectedCustomerId, trx) {
  // The customer row FIRST (Codex r3 P1): loadByToken re-reads
  // customers.active / deleted_at, but without a lock a deactivation or
  // soft-delete could commit after that read and before the insert. FOR
  // SHARE makes such an UPDATE wait for this transaction (and, unlike FOR
  // UPDATE, never blocks unrelated inserts that merely reference the
  // customer); taking it before the scheduled_services locks keeps the
  // customer-then-visits order a deactivation that cancels visits uses.
  const customer = await trx('customers').where({ id: expectedCustomerId }).forShare().first('id');
  if (!customer) return null;
  // ROW locks, not only the stop's advisory lock (Codex r1 P1): status
  // writers such as transitionJobStatus update scheduled_services WITHOUT
  // the advisory lock, so a plain read here could still race an en-route
  // tap or a cancellation landing before the insert commits. FOR UPDATE on
  // the token row (and, grouped, on every live member below) makes those
  // writers wait for this transaction instead of slipping underneath it.
  await trx('scheduled_services').where({ id: expectedId }).forUpdate().first('id');
  const svc = await loadByToken(token, trx);
  if (!svc || svc.customer_deleted_at) return null;
  if (expectedId && String(svc.id) !== String(expectedId)) return null;
  if (String(svc.customer_id) !== String(expectedCustomerId)) return null;

  return reloadEligibleVisitPrepRowCore(svc, trx);
}

// Office feed item — PR 3b (customer-visit-photos scope doc §5.4 item 3,
// §9 decision 2: "one quiet item in the notification feed that links to
// the customer... nothing to resolve, no text to the office number").
// Plain word for the chip topic the customer picked; visit-prep.js's TOPICS
// enum is the validation source, this is only display copy for the bell.
const VISIT_PREP_TOPIC_LABELS = {
  pest: 'pest',
  lawn: 'lawn',
  tree_shrub: 'trees & shrubs',
  other: 'something else',
};

// Called only after createVisitPrepSubmission's own transaction has already
// committed a NEW submission (never a duplicate-only resubmit — the caller
// only invokes this when result.created is true). Awaited by the route as a
// BOUNDED best-effort step (same shape as estimate-measurement-review.js's
// sendOfficeNotification and requests.js's own notifyAdmin call): every
// query here is a fast local DB round trip, never a network call to a
// push/SMS/email provider, so it can add latency but never hang the
// response. NotificationService.notifyAdmin/create for recipientType
// 'admin' does exactly one thing: insert a row into `notifications`. It
// never calls PushService (sendToAdmins/sendToAdminUser are separate,
// explicitly-called-elsewhere functions this file never touches) and never
// calls notification-dispatcher.js or sendCustomerMessage (both
// customer-only) — so this can never become a push, SMS, or email,
// whatever the admin bell policy gate is set to. Category
// 'visit_prep_photos' is on notification-bell-policy.js's
// DEFAULT_ON_CATEGORIES, so the item is admitted into the feed even while
// GATE_ADMIN_BELL_POLICY is on (with an owner override to silence the
// category later from Settings -> Notifications) — never a dead letterbox.
// Every error here is caught and logged, and the route never awaits this
// (it runs detached), so it can neither fail nor delay the customer's
// upload response.
async function notifyOfficeVisitPrepSubmission(svc, topic) {
  try {
    // Customer's display name is read fresh here, never hardcoded or
    // carried from loadByToken (which deliberately omits it — the token is
    // shared with whoever received the reminder text).
    const customer = await db('customers').where({ id: svc.customer_id }).first('first_name', 'last_name');
    const name = customer ? `${customer.first_name || ''} ${customer.last_name || ''}`.trim() : '';
    const dateStr = apptDateStr(svc.scheduled_date);
    // Noon-UTC construction (same shape as estimate-public.js's own
    // date-only -> formatETDate call) so a date-only column never reads a
    // day early/late across a DST boundary.
    const when = dateStr ? formatETDate(new Date(`${dateStr}T12:00:00Z`)) : 'an upcoming visit';
    const topicLabel = VISIT_PREP_TOPIC_LABELS[topic] || null;
    const notif = await NotificationService.notifyAdmin(
      'visit_prep_photos',
      'Customer sent photos for a visit',
      `${name || 'A customer'} sent photos${topicLabel ? ` about ${topicLabel}` : ''} ahead of the ${when} visit.`,
      {
        link: `/admin/customers?customerId=${encodeURIComponent(svc.customer_id)}`,
        metadata: { customerId: svc.customer_id, scheduledServiceId: svc.id },
      },
    );
    if (!notif) {
      logger.warn(`[visit-prep] office notification insert failed for scheduled_service ${svc.id}`);
    }
  } catch (err) {
    logger.warn(`[visit-prep] office notification failed for scheduled_service ${svc.id}: ${err.message}`);
  }
}

router.post(
  '/:token/photos',
  visitPrepPreParserGuard,
  visitPrepLimiter,
  // Load the token row and prove eligibility BEFORE multer ever buffers a
  // byte, so an ineligible request never costs the memory or the S3 round
  // trip. This is advisory only: the write re-proves it under the stop
  // lock. The photo CAP is deliberately NOT pre-checked here (pre-push
  // audit P1): the cap is decided only under the lock, after dedupe, so a
  // retry of an already-stored submission on a visit that is now full still
  // answers the idempotent 200 instead of a misleading "limit reached".
  async (req, res, next) => {
    try {
      const svc = await loadByToken(req.params.token);
      if (!svc || svc.customer_deleted_at) return res.status(404).json({ error: 'Not found' });

      // Ineligible answers the SAME generic 404 as an unknown or malformed
      // token (Codex r1 P0, AGENTS.md public-token baseline): a valid
      // bearer token for a past, inactive, one-time, or office-owned visit
      // must not be distinguishable from no token at all. The page (GET)
      // already tells a legitimate holder whether photos can be added.
      const eligibility = await deriveVisitPrepEligibility(svc);
      if (!eligibility.eligible) return res.status(404).json({ error: 'Not found' });

      req.visitPrepSvc = svc;
      return next();
    } catch (err) {
      return next(err);
    }
  },
  // Multer runs ONLY now — every prior guard has already refused a 404/409
  // request without touching the multipart body.
  (req, res, next) => {
    visitPrepUpload.array('photos', visitPrep.VISIT_PREP_LIMITS.photosPerSubmission)(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Each photo must be 5 MB or smaller.' });
      }
      return res.status(400).json({ error: 'Could not read the uploaded photos.' });
    });
  },
  async (req, res, next) => {
    const token = req.params.token;
    const expectedId = req.visitPrepSvc.id;
    const expectedCustomerId = req.visitPrepSvc.customer_id;
    try {
      const result = await visitPrep.createVisitPrepSubmission({
        svc: req.visitPrepSvc,
        files: req.files || [],
        note: req.body?.note,
        topic: req.body?.topic,
        locationOnProperty: req.body?.locationOnProperty,
        entry: 'appointment_page',
        // Re-proves eligibility on FRESH state under visit-prep.js's stop
        // lock — the write's actual authority, not this pre-check. Called
        // with the write's own transaction (Finding 1) — never the global
        // pool.
        recheck: (trx) => reloadEligibleVisitPrepRow(token, expectedId, expectedCustomerId, trx),
      });
      // Office feed item — ONE per NEW submission, never a duplicate-only
      // resubmit (result.created is false for those). The write already
      // committed inside createVisitPrepSubmission; the feed item is
      // DETACHED, never awaited (Codex #5242 r2 P2): its customer read and
      // insert carry no statement timeout, so a stalled connection or lock
      // must not hold the customer's already-committed upload response
      // open. The function catches and logs every failure itself (see it
      // for exactly how this stays in-app-feed-only), so nothing here can
      // reject unhandled.
      //
      // Built from result.svc — the RECHECKED row createVisitPrepSubmission
      // now returns (Codex r1 P2) — never req.visitPrepSvc, the stale
      // pre-lock read: a reschedule landing between the pre-lock read and
      // the locked write must not leave the feed item naming the OLD date.
      // Guaranteed present whenever result.created is true (persistLocked
      // never reaches created:true without a non-null recheck() row).
      if (result.created) {
        void notifyOfficeVisitPrepSubmission(result.svc, req.body?.topic);
      }
      // Never photo URLs/keys, the note, or any customer identity — the
      // token is shared with whoever received the visit text, and nothing
      // submitted through it is ever shown back.
      return res.status(result.created ? 201 : 200).json({
        ok: true,
        prepPhotos: {
          eligible: true,
          photoCount: result.summary.photoCount,
          photosRemaining: result.summary.photosRemaining,
          // NEW photos THIS request stored (the stop-wide counts above can
          // also include another holder's upload): the page's "N photos
          // sent" line reads this, never a before/after difference.
          photosAdded: result.stored,
        },
      });
    } catch (err) {
      // Only OUR OWN errors (visitPrep.js's prepError, marked `visitPrep`)
      // are echoed to an anonymous caller — a library error that happens to
      // carry a statusCode must never leak its message here.
      if (err && err.visitPrep) {
        // A locked-recheck refusal is the same generic 404 as the pre-check's.
        if (err.statusCode === 404) return res.status(404).json({ error: 'Not found' });
        return res.status(err.statusCode).json({ error: err.message, code: err.code });
      }
      return next(err);
    }
  },
);

router._test = {
  pageState,
  prepPhotosField,
  deriveVisitPrepEligibility,
  reloadEligibleVisitPrepRow,
  visitPrepPreParserGuard,
  VISIT_PREP_LIMITER_OPTIONS,
  confirmRaceVerdict,
  icsEscape,
  icsFold,
  icsStamp,
  STORM_NOTE_MIN_CHANCE,
  ARRIVAL_PROMISE_MINUTES,
  arrivalWindowLabel,
  slotMatchesShown,
  dispatchOwnedUnreviewed,
  visitServicesFor,
  confirmGroupedSiblings,
  calendarWindowStart,
  calendarEligible,
  calendarUid,
  calendarSummaryLabel,
  readConfirmedAnchorLocked,
  confirmGroupedOrSolo,
  visitAllConfirmed,
  groupedAggregateUnderLock,
  membersMatchShown,
  membershipKeyFor,
  membersOneStop,
  groupedState,
  pageStateForGroup,
  memberServiceLabel,
  confirmedRowStillShown,
  notifyOfficeVisitPrepSubmission,
  VISIT_PREP_TOPIC_LABELS,
};

module.exports = router;
// Mounted by server/index.js ahead of the shared body parsers (see the guard's comment).
module.exports.visitPrepPreParserGuard = visitPrepPreParserGuard;
// The page's own state predicate — the composer's visit picks skip what it
// renders as 'past' (GH Codex #3844 r10).
module.exports.pageState = pageState;
// …and the send seam refuses what the page would not render as upcoming,
// including the dispatch-owned unreviewed booking the builder never picks.
module.exports.dispatchOwnedUnreviewed = dispatchOwnedUnreviewed;
// The state the page would render for this row NOW — grouped (the stop's
// state from every live member, fail-closed on an unreadable membership)
// or the row's own. The composer's send seam re-runs it (GH Codex #3844 r13).
module.exports.pageStateForVisit = async function pageStateForVisit(svc, now = new Date()) {
  const info = svc?.visit_id ? await visitServicesFor(svc) : {};
  return info.visitUnknown ? { state: 'not_available', phase: null } : pageStateForGroup(svc, info, now);
};
// Visit-prep photos (customer-visit-photos-scope-20260928.md PR 4, "app
// entry"): schedule.js's customer-authenticated POST /:id/prep-photos
// requires this module directly (never the reverse) to reuse the SAME
// eligibility derivation, multer config, locked-recheck core, and office
// feed item as the public token route — never a second copy of any of them.
module.exports.deriveVisitPrepEligibility = deriveVisitPrepEligibility;
module.exports.reloadEligibleVisitPrepRowCore = reloadEligibleVisitPrepRowCore;
module.exports.visitPrepUpload = visitPrepUpload;
module.exports.notifyOfficeVisitPrepSubmission = notifyOfficeVisitPrepSubmission;
